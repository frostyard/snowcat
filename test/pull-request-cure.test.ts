import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { buildQueueMcpServer } from "../src/mcp/server.ts";
import { refreshArtifactVerifications } from "../src/queue/artifact-verification.ts";
import { assertCureCompletion, cureRootDefinition, curePullRequests, inspectPullRequestHealth } from "../src/queue/pull-request-cure.ts";
import { contractProblem, QueueStore } from "../src/queue/store.ts";

const REPOSITORY = "frostyard/updex";
const PR_URL = "https://github.com/frostyard/updex/pull/12";
const PR_PATH = "/repos/frostyard/updex/pulls/12";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const clock = () => new Date("2026-08-18T20:00:00.000Z");
process.env.SNOWCAT_GITHUB_TOKEN = "test-token";

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    html_url: PR_URL,
    title: "fix(catalog): require HTTPS",
    state: "open",
    draft: false,
    merged: false,
    mergeable_state: "clean",
    head: { sha: HEAD_A },
    base: { repo: { full_name: REPOSITORY } },
    body: "## Summary\n\nCure the pull request.\n\n## Verification\n\nChecks observed.\n\n## Risk tier\n\nTier 2",
    ...overrides,
  };
}

/** One changed text file: the same added/removed lines under two different hunk headers and context. */
const FILE_V1 = {
  filename: "catalog/repo.go",
  status: "modified",
  additions: 2,
  deletions: 1,
  patch: "@@ -10,4 +10,5 @@ func parse() {\n ctx1\n-old line\n+new line\n+another new line\n ctx2\n",
};
const FILE_V1_REBASED = {
  ...FILE_V1,
  patch: "@@ -42,4 +42,5 @@ func parse() {\n ctxA\n-old line\n+new line\n+another new line\n ctxB\n",
};
const FILE_V2 = {
  ...FILE_V1,
  patch: "@@ -10,4 +10,5 @@ func parse() {\n ctx1\n-old line\n+new line\n+a DIFFERENT new line\n ctx2\n",
};

/** The GraphQL route key: `POST /graphql` is dispatched on the query's operation name, not the path. */
const THREADS_ROUTE = "graphql:FluentReviewThreads";

function reviewThreads(threads: Array<{ resolved: boolean; outdated: boolean; author?: string }>): unknown {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: threads.map((thread) => ({
              isResolved: thread.resolved,
              isOutdated: thread.outdated,
              comments: { nodes: [{ author: { login: thread.author ?? "alice" } }] },
            })),
          },
        },
      },
    },
  };
}

function routesFor(options: {
  pull?: Record<string, unknown>;
  head?: string;
  checks?: Array<{ name: string; status: string; conclusion: string | null }>;
  reviews?: Array<{ user: string; state: string }>;
  threads?: Array<{ resolved: boolean; outdated: boolean; author?: string }>;
  files?: unknown[];
}): Record<string, unknown> {
  const head = options.head ?? HEAD_A;
  return {
    [PR_PATH]: options.pull ?? pullRequest({ head: { sha: head } }),
    [`/repos/frostyard/updex/commits/${head}/check-runs`]: { check_runs: options.checks ?? [{ name: "check", status: "completed", conclusion: "success" }] },
    [`${PR_PATH}/reviews`]: (options.reviews ?? []).map((review, index) => ({ id: index + 1, user: { login: review.user }, state: review.state })),
    [THREADS_ROUTE]: reviewThreads(options.threads ?? []),
    [`${PR_PATH}/files`]: options.files ?? [FILE_V1],
  };
}

/**
 * Answers REST reads by pathname and `POST /graphql` by the query's operation
 * name (`graphql:<OperationName>` route keys); `graphqlStatus` fails only the
 * GraphQL route so the REST signals can be tested against a GraphQL outage.
 */
function apiFetcher(routes: Record<string, unknown>, options: { status?: number; graphqlStatus?: number } = {}) {
  const requests: string[] = [];
  const graphqlQueries: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url.pathname);
    if (options.status !== undefined) return new Response("{}", { status: options.status, headers: { "content-type": "application/json" } });
    let key = url.pathname;
    if (url.pathname === "/graphql") {
      assert.equal(init?.method, "POST");
      const query = String(JSON.parse(String(init?.body)).query);
      graphqlQueries.push(query);
      if (options.graphqlStatus !== undefined) return new Response("", { status: options.graphqlStatus });
      key = `graphql:${/query\s+(\w+)/.exec(query)?.[1] ?? "unknown"}`;
    }
    const body = routes[key];
    if (body === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, requests, graphqlQueries };
}

async function completedWithOpenPr(queue: QueueStore, priority = 7): Promise<string> {
  queue.setRepositoryEnabled(REPOSITORY, true);
  queue.enqueueSeed({
    repository: REPOSITORY,
    kind: "issue-resolution",
    objective: "Resolve #7",
    instructions: "Open a PR.",
    acceptanceCriteria: ["PR open."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    requiredArtifact: "pull-request",
    executionTarget: "new-pull-request",
    priority,
    createdBy: "operator:test",
  });
  const claimed = queue.claim({ worker: "claude:cure-test" })!;
  const completion = queue.complete({
    id: claimed.id,
    leaseToken: claimed.leaseToken!,
    worker: "claude:cure-test",
    result: {
      summary: "Opened the PR.",
      evidence: ["make check"],
      artifacts: [
        {
          kind: "pull-request",
          url: PR_URL,
          verification: { status: "verified", verifiedAt: clock().toISOString(), number: 12, state: "open", headSha: HEAD_A },
        },
      ],
    },
    followUps: [],
  });
  return completion.completed.id;
}

test("patch identity ignores hunk headers and context but sees a changed line; decay comes from mergeability, checks, and reviews", async () => {
  const clean = await inspectPullRequestHealth(REPOSITORY, PR_URL, { fetcher: apiFetcher(routesFor({})).fetcher });
  assert.equal(clean.kind, "health");
  if (clean.kind !== "health") return;
  assert.deepEqual(clean.health.decay, []);
  assert.match(clean.health.patchDigest!, /^sha256:[0-9a-f]{64}$/);

  const rebased = await inspectPullRequestHealth(REPOSITORY, PR_URL, { fetcher: apiFetcher(routesFor({ files: [FILE_V1_REBASED] })).fetcher });
  assert.equal(rebased.kind, "health");
  if (rebased.kind !== "health") return;
  assert.equal(rebased.health.patchDigest, clean.health.patchDigest, "a rebase over unrelated changes keeps the identity");

  const edited = await inspectPullRequestHealth(REPOSITORY, PR_URL, { fetcher: apiFetcher(routesFor({ files: [FILE_V2] })).fetcher });
  assert.equal(edited.kind, "health");
  if (edited.kind !== "health") return;
  assert.notEqual(edited.health.patchDigest, clean.health.patchDigest, "an edited added line changes the identity");

  const decayed = await inspectPullRequestHealth(REPOSITORY, PR_URL, {
    fetcher: apiFetcher(
      routesFor({
        pull: pullRequest({ mergeable_state: "dirty" }),
        checks: [
          { name: "Lint", status: "completed", conclusion: "failure" },
          { name: "Unit Tests", status: "completed", conclusion: "success" },
          { name: "Slow", status: "in_progress", conclusion: null },
        ],
        reviews: [
          { user: "alice", state: "CHANGES_REQUESTED" },
          { user: "alice", state: "APPROVED" },
          { user: "bob", state: "COMMENTED" },
          { user: "carol", state: "CHANGES_REQUESTED" },
        ],
      }),
    ).fetcher,
  });
  assert.equal(decayed.kind, "health");
  if (decayed.kind !== "health") return;
  assert.deepEqual(decayed.health.failingChecks, ["Lint"]);
  assert.equal(decayed.health.changesRequested, true, "carol's latest review requests changes; alice's later approval supersedes hers");
  assert.deepEqual(decayed.health.decay, ["dirty", "failing-checks", "changes-requested"]);

  // A draft has no decay; a binary file is identified by blob SHA; a truncated text patch is uncomputable.
  const draft = await inspectPullRequestHealth(REPOSITORY, PR_URL, { fetcher: apiFetcher(routesFor({ pull: pullRequest({ draft: true, mergeable_state: "dirty" }) })).fetcher });
  assert.equal(draft.kind, "health");
  if (draft.kind === "health") assert.deepEqual(draft.health.decay, []);
  const binary = await inspectPullRequestHealth(REPOSITORY, PR_URL, {
    fetcher: apiFetcher(routesFor({ files: [FILE_V1, { filename: "logo.png", status: "added", additions: 0, deletions: 0, sha: "f".repeat(40) }] })).fetcher,
  });
  assert.equal(binary.kind, "health");
  if (binary.kind === "health") assert.match(binary.health.patchDigest!, /^sha256:/);
  const truncated = await inspectPullRequestHealth(REPOSITORY, PR_URL, {
    fetcher: apiFetcher(routesFor({ files: [{ filename: "huge.txt", status: "modified", additions: 5000, deletions: 0 }] })).fetcher,
  });
  assert.equal(truncated.kind, "health");
  if (truncated.kind === "health") {
    assert.equal(truncated.health.patchDigest, undefined);
    assert.match(truncated.health.patchUnavailableReason!, /not available/);
  }

  const wrongRepo = await inspectPullRequestHealth(REPOSITORY, PR_URL, { fetcher: apiFetcher(routesFor({ pull: pullRequest({ base: { repo: { full_name: "frostyard/lodge" } } }) })).fetcher });
  assert.equal(wrongRepo.kind, "rejected");
  const down = await inspectPullRequestHealth(REPOSITORY, PR_URL, { fetcher: apiFetcher({}, { status: 503 }).fetcher });
  assert.equal(down.kind, "unavailable");
});

test("a title that fails the Conventional Commits lint is bad-title decay; a conforming title is not, and a draft's bad title is not decay", async () => {
  const badTitle = await inspectPullRequestHealth(REPOSITORY, PR_URL, { fetcher: apiFetcher(routesFor({ pull: pullRequest({ title: "add title lint" }) })).fetcher });
  assert.equal(badTitle.kind, "health");
  if (badTitle.kind !== "health") return;
  assert.deepEqual(badTitle.health.decay, ["bad-title"]);
  const description = cureRootDefinition(REPOSITORY, badTitle.health, "operator:test");
  assert.match(description.instructions, /Conventional Commits title lint/);

  const conforming = await inspectPullRequestHealth(REPOSITORY, PR_URL, { fetcher: apiFetcher(routesFor({})).fetcher });
  assert.equal(conforming.kind, "health");
  if (conforming.kind === "health") assert.deepEqual(conforming.health.decay, []);

  const draftBadTitle = await inspectPullRequestHealth(REPOSITORY, PR_URL, {
    fetcher: apiFetcher(routesFor({ pull: pullRequest({ title: "add title lint", draft: true }) })).fetcher,
  });
  assert.equal(draftBadTitle.kind, "health");
  if (draftBadTitle.kind === "health") assert.deepEqual(draftBadTitle.health.decay, []);
});

test("unresolved, non-outdated review threads are decay read through GraphQL; the signal fails open when GraphQL cannot answer", async () => {
  // Two unresolved, non-outdated threads on an otherwise clean pull request: the one decay.
  const unanswered = apiFetcher(routesFor({ threads: [{ resolved: false, outdated: false }, { resolved: false, outdated: false, author: "bob" }] }));
  const decayed = await inspectPullRequestHealth(REPOSITORY, PR_URL, { fetcher: unanswered.fetcher });
  assert.equal(decayed.kind, "health");
  if (decayed.kind !== "health") return;
  assert.equal(decayed.health.unresolvedThreads, 2);
  assert.deepEqual(decayed.health.decay, ["unresolved-threads"]);
  assert.deepEqual(decayed.health.notes, []);
  assert.equal(unanswered.graphqlQueries.length, 1);
  assert.match(unanswered.graphqlQueries[0]!, /reviewThreads\(first: 100\)/);
  assert.match(unanswered.graphqlQueries[0]!, /isResolved isOutdated comments\(first: 1\)/);
  const description = cureRootDefinition(REPOSITORY, decayed.health, "operator:test");
  assert.match(description.instructions, /2 review threads have no reply and are not outdated/);
  assert.match(description.instructions, /resolving one whose request a later commit already addressed, is mechanical/);

  // One resolved and one outdated thread: nothing unanswered, no decay.
  const answered = await inspectPullRequestHealth(REPOSITORY, PR_URL, {
    fetcher: apiFetcher(routesFor({ threads: [{ resolved: true, outdated: false }, { resolved: false, outdated: true }] })).fetcher,
  });
  assert.equal(answered.kind, "health");
  if (answered.kind !== "health") return;
  assert.equal(answered.health.unresolvedThreads, 0);
  assert.deepEqual(answered.health.decay, []);

  // A draft's threads are read but are not decay.
  const draft = await inspectPullRequestHealth(REPOSITORY, PR_URL, {
    fetcher: apiFetcher(routesFor({ pull: pullRequest({ draft: true }), threads: [{ resolved: false, outdated: false }] })).fetcher,
  });
  assert.equal(draft.kind, "health");
  if (draft.kind === "health") {
    assert.equal(draft.health.unresolvedThreads, 1);
    assert.deepEqual(draft.health.decay, []);
  }

  // GraphQL 502: the thread signal is undefined with a note, the REST signals still decide, and the sweep still enqueues.
  const outage = await inspectPullRequestHealth(REPOSITORY, PR_URL, {
    fetcher: apiFetcher(routesFor({ pull: pullRequest({ mergeable_state: "behind" }), threads: [{ resolved: false, outdated: false }] }), { graphqlStatus: 502 }).fetcher,
  });
  assert.equal(outage.kind, "health");
  if (outage.kind !== "health") return;
  assert.equal(outage.health.unresolvedThreads, undefined);
  assert.deepEqual(outage.health.decay, ["behind"]);
  assert.deepEqual(outage.health.notes, ["review threads unavailable: GitHub GraphQL returned HTTP 502"]);
  const errored = await inspectPullRequestHealth(REPOSITORY, PR_URL, {
    fetcher: apiFetcher({ ...routesFor({}), [THREADS_ROUTE]: { data: null, errors: [{ message: "Resource not accessible by integration" }] } }).fetcher,
  });
  assert.equal(errored.kind, "health");
  if (errored.kind === "health") {
    assert.equal(errored.health.unresolvedThreads, undefined);
    assert.deepEqual(errored.health.decay, []);
    assert.deepEqual(errored.health.notes, ["review threads unavailable: GitHub GraphQL errors: Resource not accessible by integration"]);
  }

  const directory = await mkdtemp(join(tmpdir(), "snowcat-cure-threads-test-"));
  const queue = new QueueStore(join(directory, "queue.db"), clock);
  test.after(() => queue.close());
  await completedWithOpenPr(queue);
  const swept = await curePullRequests(queue, {
    fetcher: apiFetcher(routesFor({ pull: pullRequest({ mergeable_state: "behind" }), threads: [{ resolved: false, outdated: false }] }), { graphqlStatus: 502 }).fetcher,
    clock,
  });
  assert.equal(swept.enqueued.length, 1);
  assert.deepEqual(swept.enqueued[0]!.decay, ["behind"]);
  assert.deepEqual(swept.notes, [{ url: PR_URL, note: "review threads unavailable: GitHub GraphQL returned HTTP 502" }]);
  assert.deepEqual(queue.get(swept.enqueued[0]!.id)!.cure!.decay, ["behind"]);
  // Same head, GraphQL back: the head is already known, so nothing new; a new head with only unanswered threads is its own cure.
  const pushed = await curePullRequests(queue, {
    fetcher: apiFetcher(routesFor({ head: HEAD_B, pull: pullRequest({ head: { sha: HEAD_B } }), threads: [{ resolved: false, outdated: false }] })).fetcher,
    clock,
  });
  assert.equal(pushed.enqueued.length, 1);
  assert.deepEqual(pushed.enqueued[0]!.decay, ["unresolved-threads"]);
  assert.deepEqual(pushed.notes, []);
  assert.match(queue.get(pushed.enqueued[0]!.id)!.objective, /unresolved-threads$/);
});

test("the cure sweep enqueues one admitted pr-cure root per decayed head, never the same head twice, and a push is a new head", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cure-sweep-test-"));
  const queue = new QueueStore(join(directory, "queue.db"), clock);
  test.after(() => queue.close());
  const originId = await completedWithOpenPr(queue, 7);

  // Healthy: nothing enqueued.
  const healthy = await curePullRequests(queue, { fetcher: apiFetcher(routesFor({})).fetcher, clock });
  assert.deepEqual(healthy, { inspected: 1, foreign: { listed: 0, inspected: 0 }, enqueued: [], healthy: [PR_URL], skipped: [], unavailable: [], notes: [] });

  // Behind its base and failing a check: one admitted root, keyed by head, carrying the cure record.
  const decayedRoutes = routesFor({ pull: pullRequest({ mergeable_state: "behind" }), checks: [{ name: "Lint", status: "completed", conclusion: "failure" }] });
  const first = await curePullRequests(queue, { fetcher: apiFetcher(decayedRoutes).fetcher, clock });
  assert.equal(first.enqueued.length, 1);
  const cureId = first.enqueued[0]!.id;
  const item = queue.get(cureId)!;
  assert.equal(item.kind, "pr-cure");
  assert.equal(item.status, "queued");
  assert.equal(item.rootId, cureId, "a cure is a root, not a child of the originating item");
  assert.equal(item.sourceRef, `${PR_URL}@${HEAD_A}`);
  assert.equal(item.priority, 7, "priority inherited from the item that reported the pull request");
  assert.deepEqual(item.allowedActions, ["read", "write", "run-tests", "open-pr", "create-followup"]);
  assert.deepEqual(item.delegableActions, ["read", "write", "run-tests", "open-pr"]);
  assert.deepEqual(item.cure, {
    pullRequestUrl: PR_URL,
    headSha: HEAD_A,
    patchDigest: item.cure!.patchDigest,
    decay: ["behind", "failing-checks"],
    originItemId: originId,
  });
  assert.match(item.objective, /^Cure frostyard\/updex#12 \(head aaaaaaa\): behind, failing-checks$/);
  assert.match(item.instructions, /MECHANICAL cure/);
  const queued = queue.events(cureId).find((event) => event.type === "work.queued")!;
  assert.deepEqual(queued.payload, { root: true, cure: { pullRequestUrl: PR_URL, headSha: HEAD_A, decay: ["behind", "failing-checks"] } });

  // Same head again: skipped, whatever the earlier item's status.
  const again = await curePullRequests(queue, { fetcher: apiFetcher(decayedRoutes).fetcher, clock });
  assert.deepEqual(again.enqueued, []);
  assert.match(again.skipped[0]!.reason, /already has a cure item/);
  const lease = queue.claim({ worker: "claude:cure-worker", kinds: ["pr-cure"] })!;
  queue.block(lease.id, lease.leaseToken!, "claude:cure-worker", "Maintainer's call.");
  queue.cancel(cureId, "operator:test", "Not now.");
  assert.equal(queue.get(cureId)!.status, "cancelled");
  const afterCancel = await curePullRequests(queue, { fetcher: apiFetcher(decayedRoutes).fetcher, clock });
  assert.deepEqual(afterCancel.enqueued, []);

  // A push moves the head: a new source reference, a new item.
  const pushed = routesFor({ head: HEAD_B, pull: pullRequest({ head: { sha: HEAD_B }, mergeable_state: "dirty" }) });
  const second = await curePullRequests(queue, { fetcher: apiFetcher(pushed).fetcher, clock });
  assert.equal(second.enqueued.length, 1);
  assert.equal(queue.get(second.enqueued[0]!.id)!.sourceRef, `${PR_URL}@${HEAD_B}`);
  assert.deepEqual(second.enqueued[0]!.decay, ["dirty"]);

  // A merged pull request is not inspected further; the refresh records the merge and the sweep skips it.
  const merged = routesFor({ pull: pullRequest({ state: "closed", merged: true, merged_at: "2026-08-18T21:00:00Z" }) });
  await refreshArtifactVerifications(queue, { fetcher: apiFetcher(merged).fetcher, clock });
  const done = await curePullRequests(queue, { fetcher: apiFetcher(merged).fetcher, clock });
  assert.equal(done.inspected, 0);

  // Uncomputable patch identity: reported, not enqueued.
  const other = new QueueStore(join(directory, "other.db"), clock);
  test.after(() => other.close());
  await completedWithOpenPr(other);
  const uncomputable = routesFor({ pull: pullRequest({ mergeable_state: "dirty" }), files: [{ filename: "huge.txt", status: "modified", additions: 5000, deletions: 0 }] });
  const skipped = await curePullRequests(other, { fetcher: apiFetcher(uncomputable).fetcher, clock });
  assert.deepEqual(skipped.enqueued, []);
  assert.match(skipped.skipped[0]!.reason, /patch identity uncomputable/);
  const draftRoutes = routesFor({ pull: pullRequest({ draft: true, mergeable_state: "dirty" }) });
  assert.match((await curePullRequests(other, { fetcher: apiFetcher(draftRoutes).fetcher, clock })).skipped[0]!.reason, /draft/);
  const outage = await curePullRequests(other, { fetcher: apiFetcher({}, { status: 502 }).fetcher, clock });
  assert.equal(outage.unavailable.length, 1);
});

test("foreign pull requests are cured only for a repository with cureForeign on: one root per head, no originItemId, drafts skipped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cure-foreign-test-"));
  const queue = new QueueStore(join(directory, "queue.db"), clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);
  assert.deepEqual(queue.repositoryCureSettings(), [{ repository: REPOSITORY, cureForeign: false }]);

  // A Dependabot-style pull request no Snowcat item reported, open and conflicting.
  const FOREIGN_URL = "https://github.com/frostyard/updex/pull/30";
  const FOREIGN_PATH = "/repos/frostyard/updex/pulls/30";
  const foreignPull = (overrides: Record<string, unknown> = {}) =>
    pullRequest({ number: 30, html_url: FOREIGN_URL, title: "chore(deps): bump x", mergeable_state: "dirty", head: { sha: HEAD_B }, ...overrides });
  const foreignRoutes = (overrides: Record<string, unknown> = {}) => ({
    "/repos/frostyard/updex/pulls": [foreignPull(overrides)],
    [FOREIGN_PATH]: foreignPull(overrides),
    [`/repos/frostyard/updex/commits/${HEAD_B}/check-runs`]: { check_runs: [] },
    [`${FOREIGN_PATH}/reviews`]: [],
    [`${FOREIGN_PATH}/files`]: [FILE_V1],
  });

  // Off (the default): the listing is never read and the pull request is ignored.
  const off = apiFetcher(foreignRoutes());
  const ignored = await curePullRequests(queue, { fetcher: off.fetcher, clock });
  assert.deepEqual(ignored, { inspected: 0, foreign: { listed: 0, inspected: 0 }, enqueued: [], healthy: [], skipped: [], unavailable: [], notes: [] });
  assert.deepEqual(off.requests, []);

  // On: exactly one pr-cure root for that head, priority 0, no originating item, marked foreign for the worker.
  queue.setRepositoryCureForeign(REPOSITORY, true);
  assert.deepEqual(queue.repositoryCureSettings(), [{ repository: REPOSITORY, cureForeign: true }]);
  const on = apiFetcher(foreignRoutes());
  const first = await curePullRequests(queue, { fetcher: on.fetcher, clock });
  assert.ok(on.requests.includes("/repos/frostyard/updex/pulls"), "the open pull-request listing is read");
  assert.equal(first.inspected, 1);
  assert.deepEqual(first.foreign, { listed: 1, inspected: 1 });
  assert.equal(first.enqueued.length, 1);
  assert.deepEqual(first.enqueued[0]!.decay, ["dirty"]);
  const item = queue.get(first.enqueued[0]!.id)!;
  assert.equal(item.kind, "pr-cure");
  assert.equal(item.status, "queued");
  assert.equal(item.sourceRef, `${FOREIGN_URL}@${HEAD_B}`);
  assert.equal(item.priority, 0);
  assert.equal(item.cure!.originItemId, undefined, "a foreign head has no originating item");
  assert.deepEqual(item.cure, { pullRequestUrl: FOREIGN_URL, headSha: HEAD_B, patchDigest: item.cure!.patchDigest, decay: ["dirty"] });
  assert.match(item.instructions, /NOT opened by a Snowcat worker/);
  assert.match(item.instructions, /MECHANICAL cure/);

  // A second sweep enqueues nothing: the head is known.
  const second = await curePullRequests(queue, { fetcher: apiFetcher(foreignRoutes()).fetcher, clock });
  assert.deepEqual(second.enqueued, []);
  assert.deepEqual(second.foreign, { listed: 1, inspected: 1 });
  assert.match(second.skipped[0]!.reason, /already has a cure item/);
  assert.equal(queue.list({ kind: "pr-cure" }).length, 1);

  // A draft foreign pull request is skipped with a reason and never inspected.
  const draft = apiFetcher(foreignRoutes({ draft: true, head: { sha: HEAD_A } }));
  const drafts = await curePullRequests(queue, { fetcher: draft.fetcher, clock });
  assert.deepEqual(drafts.enqueued, []);
  assert.deepEqual(drafts.foreign, { listed: 1, inspected: 0 });
  assert.deepEqual(drafts.skipped, [{ url: FOREIGN_URL, reason: "draft pull requests are not cured" }]);
  assert.ok(!draft.requests.includes(FOREIGN_PATH), "a draft is dropped from the listing without a health read");

  // --repository restricts the foreign listing to that repository; another opted-in one is not listed.
  const scoped = apiFetcher(foreignRoutes());
  await curePullRequests(queue, { fetcher: scoped.fetcher, clock, repository: "frostyard/lodge" });
  assert.deepEqual(scoped.requests, []);

  // Off again: the listing stops; the existing item is untouched.
  queue.setRepositoryCureForeign(REPOSITORY, false);
  const after = apiFetcher(foreignRoutes());
  assert.deepEqual((await curePullRequests(queue, { fetcher: after.fetcher, clock })).foreign, { listed: 0, inspected: 0 });
  assert.deepEqual(after.requests, []);
  assert.equal(queue.get(item.id)!.status, "queued");

  // The setting is repository-level and requires opt-in.
  assert.throws(() => queue.setRepositoryCureForeign("frostyard/lodge", true), /not opted in/);
});

test("a pr-cure completion is refused when the patch changed, when the pull request is not reported, or when GitHub cannot answer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cure-complete-test-"));
  const path = join(directory, "queue.db");
  // Wall clock on purpose: the MCP server below opens its own store on real
  // time, so a frozen clock here would make the lease look expired to it.
  const queue = new QueueStore(path);
  await completedWithOpenPr(queue);
  const decayedRoutes = routesFor({ pull: pullRequest({ mergeable_state: "behind" }) });
  const swept = await curePullRequests(queue, { fetcher: apiFetcher(decayedRoutes).fetcher, clock });
  const cureId = swept.enqueued[0]!.id;
  const claimed = queue.claim({ worker: "claude:cure-worker", kinds: ["pr-cure"] })!;
  assert.equal(claimed.id, cureId);
  const complete = (fetcher: typeof fetch, artifacts: Array<{ kind: "pull-request" | "commit"; url: string }>) =>
    assertCureCompletion(queue.get(cureId)!, artifacts.map((artifact) => ({ ...artifact })), { fetcher, clock });

  // Not reporting the pull request, a changed patch, an unavailable GitHub, an uncomputable patch: all refused.
  await assert.rejects(complete(apiFetcher(routesFor({})).fetcher, [{ kind: "commit", url: "https://github.com/frostyard/updex/commit/abc" }]), /must report .*pull\/12/);
  await assert.rejects(complete(apiFetcher(routesFor({ files: [FILE_V2] })).fetcher, [{ kind: "pull-request", url: PR_URL }]), /patch changed/);
  await assert.rejects(complete(apiFetcher({}, { status: 500 }).fetcher, [{ kind: "pull-request", url: PR_URL }]), /cannot be verified/);
  await assert.rejects(
    complete(apiFetcher(routesFor({ files: [{ filename: "huge.txt", status: "modified", additions: 5000, deletions: 0 }] })).fetcher, [{ kind: "pull-request", url: PR_URL }]),
    /uncomputable/,
  );
  // A mechanical rebase (new head, same identity) is accepted; so is a pull request merged meanwhile.
  await complete(apiFetcher(routesFor({ head: HEAD_B, pull: pullRequest({ head: { sha: HEAD_B } }), files: [FILE_V1_REBASED] })).fetcher, [{ kind: "pull-request", url: PR_URL }]);
  await complete(apiFetcher(routesFor({ pull: pullRequest({ state: "closed", merged: true }) })).fetcher, [{ kind: "pull-request", url: PR_URL }]);
  // A non-cure item is never subject to the check.
  await assertCureCompletion({ ...queue.get(cureId)!, kind: "issue-resolution" }, [], { fetcher: apiFetcher({}, { status: 500 }).fetcher });

  // Through MCP: the refused completion leaves the item claimed; the accepted one completes with a verified artifact.
  const server = buildQueueMcpServer(path, { fetcher: apiFetcher(routesFor({ files: [FILE_V2] })).fetcher, clock });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "cure-test", version: "0.1.0" });
  await client.connect(clientTransport);
  test.after(async () => {
    await client.close();
    await server.close();
    queue.close();
  });
  const refused = await client.callTool({
    name: "complete_work",
    arguments: {
      id: cureId,
      leaseToken: claimed.leaseToken,
      worker: "claude:cure-worker",
      result: { summary: "Rebased.", evidence: ["gh pr checks"], artifacts: [{ kind: "pull-request", url: PR_URL }] },
      followUps: [],
    },
  });
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.content), /patch changed/);
  assert.equal(queue.get(cureId)!.status, "claimed");
  await client.close();
  await server.close();

  const goodServer = buildQueueMcpServer(path, { fetcher: apiFetcher(routesFor({ head: HEAD_B, pull: pullRequest({ head: { sha: HEAD_B } }), files: [FILE_V1_REBASED] })).fetcher, clock });
  const [clientTransport2, serverTransport2] = InMemoryTransport.createLinkedPair();
  await goodServer.connect(serverTransport2);
  const goodClient = new Client({ name: "cure-test", version: "0.1.0" });
  await goodClient.connect(clientTransport2);
  const accepted = await goodClient.callTool({
    name: "complete_work",
    arguments: {
      id: cureId,
      leaseToken: claimed.leaseToken,
      worker: "claude:cure-worker",
      result: { summary: "Rebased onto main; checks green.", evidence: ["gh pr checks 12: all pass"], artifacts: [{ kind: "pull-request", url: PR_URL }] },
      followUps: [],
    },
  });
  assert.equal(accepted.isError, undefined);
  const done = queue.get(cureId)!;
  assert.equal(done.status, "completed");
  assert.equal(done.result?.artifacts[0]?.verification?.status, "verified");
  await goodClient.close();
  await goodServer.close();
});

test("enqueueCureRoot validates its cure record and kind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cure-store-test-"));
  const queue = new QueueStore(join(directory, "queue.db"), clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);
  const base = {
    kind: "pr-cure",
    objective: "Cure #12",
    instructions: "Mechanical only.",
    acceptanceCriteria: ["Patch unchanged."],
    allowedActions: ["read", "write", "run-tests", "open-pr", "create-followup"] as const,
    delegableActions: ["read", "write", "run-tests", "open-pr"] as const,
    requiredArtifact: "pull-request" as const,
    executionTarget: "existing-pull-request" as const,
    createdBy: "operator:test",
    sourceRef: `${PR_URL}@${HEAD_A}`,
  };
  const cure = { pullRequestUrl: PR_URL, headSha: HEAD_A, patchDigest: `sha256:${"0".repeat(64)}`, decay: ["dirty" as const] };
  assert.throws(() => queue.enqueueCureRoot(REPOSITORY, { ...base, allowedActions: [...base.allowedActions], delegableActions: [...base.delegableActions], kind: "issue-resolution", cure }), /kind pr-cure/);
  assert.throws(() => queue.enqueueCureRoot(REPOSITORY, { ...base, allowedActions: [...base.allowedActions], delegableActions: [...base.delegableActions], cure: { ...cure, headSha: "abc" } }), /headSha/);
  assert.throws(() => queue.enqueueCureRoot(REPOSITORY, { ...base, allowedActions: [...base.allowedActions], delegableActions: [...base.delegableActions], cure: { ...cure, decay: [] } }), /decay/);
  assert.throws(() => queue.enqueueCureRoot(REPOSITORY, { ...base, allowedActions: [...base.allowedActions], delegableActions: [...base.delegableActions], cure: { ...cure, decay: ["stale" as never] } }), /decay/);
  const created = queue.enqueueCureRoot(REPOSITORY, { ...base, allowedActions: [...base.allowedActions], delegableActions: [...base.delegableActions], cure });
  assert.equal(created?.status, "queued");
  const threads = queue.enqueueCureRoot(REPOSITORY, {
    ...base,
    allowedActions: [...base.allowedActions],
    delegableActions: [...base.delegableActions],
    sourceRef: `${PR_URL}@${HEAD_B}`,
    cure: { ...cure, headSha: HEAD_B, decay: ["unresolved-threads"] },
  });
  assert.deepEqual(threads?.cure?.decay, ["unresolved-threads"]);
  assert.equal(queue.enqueueCureRoot(REPOSITORY, { ...base, allowedActions: [...base.allowedActions], delegableActions: [...base.delegableActions], cure }), undefined);
  assert.equal(queue.metadata().schemaVersion, 17, "rung 5 carries cure_json; rung 6 the repository cure_foreign setting; rung 7 the mcp_tokens table; rung 8 the review gate; rung 9 the token claim restriction; rung 10 the unreported pull-request observation; rung 11 the labeled-issue observation; rung 12 the predecessor references; rung 13 the required-artifact contract; rung 14 the token tool grant; rung 15 the work_events index; rung 16 the execution target; rung 17 the policy binding");
});

test("the cure sweep selects items with non-terminal artifacts, so more than 100 terminal completions cannot hide a newer decayed head", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cure-starvation-test-"));
  let now = Date.parse("2026-08-18T20:00:00.000Z");
  const ticking = () => new Date(now);
  const queue = new QueueStore(join(directory, "queue.db"), ticking);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);

  // 105 older completions whose pull requests are all merged (terminal).
  for (let index = 0; index < 105; index += 1) {
    now += 1000;
    queue.enqueueSeed({
      repository: REPOSITORY,
      kind: "issue-resolution",
      objective: `Resolve #${1000 + index}`,
      instructions: "Open a PR.",
      acceptanceCriteria: ["PR open."],
      allowedActions: ["read", "write", "run-tests", "open-pr"],
      delegableActions: [],
      requiredArtifact: "pull-request",
      executionTarget: "new-pull-request",
      priority: 7,
      createdBy: "operator:test",
    });
    const claimed = queue.claim({ worker: "claude:cure-test" })!;
    queue.complete({
      id: claimed.id,
      leaseToken: claimed.leaseToken!,
      worker: "claude:cure-test",
      result: {
        summary: "Merged.",
        evidence: [],
        artifacts: [{ kind: "pull-request", url: `https://github.com/frostyard/updex/pull/${1000 + index}`, verification: { status: "verified", verifiedAt: ticking().toISOString(), number: 1000 + index, state: "merged", mergedAt: ticking().toISOString() } }],
      },
      followUps: [],
    });
  }
  // One newer completion reporting an open pull request whose head has decayed.
  now += 1000;
  const originId = await completedWithOpenPr(queue, 7);
  assert.equal(queue.list({ status: "completed", repository: REPOSITORY, limit: 100 }).some((item) => item.id === originId), false, "list()'s 100-row page does not reach the newer item");

  const decayedRoutes = routesFor({ pull: pullRequest({ mergeable_state: "behind" }), checks: [{ name: "Lint", status: "completed", conclusion: "failure" }] });
  const swept = await curePullRequests(queue, { fetcher: apiFetcher(decayedRoutes).fetcher, clock: ticking, repository: REPOSITORY });
  assert.equal(swept.inspected, 1);
  assert.equal(swept.enqueued.length, 1, "exactly one pr-cure root for the newer decayed head");
  const cure = queue.get(swept.enqueued[0]!.id)!;
  assert.equal(cure.kind, "pr-cure");
  assert.equal(cure.sourceRef, `${PR_URL}@${HEAD_A}`);
  assert.equal(cure.cure?.originItemId, originId);
});

test("a pr-cure-change follow-up inherits its parent's binding, and can bind nothing else (issue #269)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cure-change-binding-test-"));
  const queue = new QueueStore(join(directory, "queue.db"), clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);
  const cure = { pullRequestUrl: PR_URL, headSha: HEAD_A, patchDigest: `sha256:${"0".repeat(64)}`, decay: ["dirty" as const] };
  const parent = queue.enqueueCureRoot(REPOSITORY, {
    kind: "pr-cure",
    objective: `Cure ${PR_URL}`,
    instructions: "Mechanical only.",
    acceptanceCriteria: ["Patch unchanged."],
    allowedActions: ["read", "write", "run-tests", "open-pr", "create-followup"],
    delegableActions: ["read", "write", "run-tests", "open-pr"],
    requiredArtifact: "pull-request",
    executionTarget: "existing-pull-request",
    createdBy: "operator:test",
    sourceRef: `${PR_URL}@${HEAD_A}`,
    cure,
  })!;
  const change = {
    kind: "pr-cure-change",
    objective: "Resolve the conflict the mechanical cure could not.",
    instructions: "Edit the two conflicted files on the pull request's own branch and push.",
    acceptanceCriteria: ["The pull request is mergeable and its checks are green."],
    allowedActions: ["read", "write", "run-tests", "open-pr"] as const,
    delegableActions: [] as const,
    requiredArtifact: "pull-request" as const,
    executionTarget: "existing-pull-request" as const,
  };
  const completion = {
    worker: "claude:updex:cure",
    result: { summary: "Mechanical cure done; the rest needs the patch to change.", evidence: [PR_URL], artifacts: [{ kind: "pull-request" as const, url: PR_URL }] },
  };

  // A worker may not name a binding: it could reach any pull request at any head.
  const claimed = queue.claim({ worker: completion.worker, kinds: ["pr-cure"] })!;
  assert.equal(claimed.id, parent.id);
  for (const smuggled of [
    { sourceRef: `pr-cure-change:https://github.com/${REPOSITORY}/pull/999@${HEAD_B}` },
    { cure: { ...cure, pullRequestUrl: `https://github.com/${REPOSITORY}/pull/999`, headSha: HEAD_B } },
    { review: { pullRequestUrl: PR_URL, headSha: HEAD_B, round: 1, priorBlockers: [] } },
  ]) {
    assert.throws(
      () =>
        queue.complete({
          id: parent.id,
          leaseToken: claimed.leaseToken!,
          ...completion,
          followUps: [{ ...change, allowedActions: [...change.allowedActions], delegableActions: [...change.delegableActions], ...smuggled } as never],
        }),
      /may not set (sourceRef|cure|review); a pull-request-bound child inherits its parent's binding/,
    );
  }
  assert.equal(queue.get(parent.id)?.status, "claimed", "a refused completion leaves the item claimed");

  // Nor may it escape the binding by declaring a different target: ADR-0061
  // forbids a second pull request for a head that already has one, and the
  // declaration is refused rather than silently rewritten.
  assert.throws(
    () =>
      queue.complete({
        id: parent.id,
        leaseToken: claimed.leaseToken!,
        ...completion,
        followUps: [{ ...change, allowedActions: [...change.allowedActions], delegableActions: [...change.delegableActions], executionTarget: "new-pull-request" } as never],
      }),
    /follow-up "pr-cure-change": a pr-cure-change item changes the patch of the pull request its parent is bound to: executionTarget must be existing-pull-request, never new-pull-request/,
  );
  // `read-only` needs no new rule: a change child declaring it is already
  // refused by read-only-with-mutation, before this one is reached.
  assert.throws(
    () =>
      queue.complete({
        id: parent.id,
        leaseToken: claimed.leaseToken!,
        ...completion,
        followUps: [{ ...change, allowedActions: [...change.allowedActions], delegableActions: [...change.delegableActions], executionTarget: "read-only" } as never],
      }),
    /follow-up "pr-cure-change": a read-only item mutates nothing/,
  );
  assert.equal(queue.get(parent.id)?.status, "claimed", "and that refusal rolls the whole completion back too");
  assert.equal(queue.list({ repository: REPOSITORY }).length, 1, "nothing was proposed");
  assert.equal(
    contractProblem({
      allowedActions: ["read", "write", "run-tests", "open-pr"],
      requiredArtifact: "pull-request",
      executionTarget: "new-pull-request",
      kind: "pr-cure-change",
      parentId: parent.id,
    })?.code,
    "cure-change-without-existing-target",
  );

  // The lawful proposal is accepted, and its binding is exactly the parent's.
  const accepted = queue.complete({
    id: parent.id,
    leaseToken: claimed.leaseToken!,
    ...completion,
    followUps: [
      {
        intent: "existing-pr-change",
        objective: change.objective,
        instructions: change.instructions,
        acceptanceCriteria: change.acceptanceCriteria,
      },
    ],
  });
  const child = queue.get(accepted.followUps[0]!.id)!;
  assert.equal(child.kind, "pr-cure-change");
  assert.equal(child.status, "proposed");
  assert.equal(child.executionTarget, "existing-pull-request");
  assert.equal(child.cure?.pullRequestUrl, cure.pullRequestUrl);
  assert.equal(child.cure?.headSha, cure.headSha);
  assert.deepEqual(child.cure, parent.cure);
  assert.equal(child.review, undefined, "a cure child inherits the cure record only");
  // The parent's sourceRef is not copied: (repository, source_ref) is unique.
  assert.equal(child.sourceRef, undefined);
  assert.equal(queue.get(parent.id)?.sourceRef, `${PR_URL}@${HEAD_A}`);
});

test("an existing-pull-request follow-up under an unbound parent is still refused (issue #269)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cure-change-unbound-test-"));
  const queue = new QueueStore(join(directory, "queue.db"), clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);
  const parent = queue.enqueueSeed({
    repository: REPOSITORY,
    kind: "issue-resolution",
    objective: "Resolve the issue.",
    instructions: "Open one pull request.",
    acceptanceCriteria: ["The issue is closed."],
    allowedActions: ["read", "write", "run-tests", "open-pr", "create-followup"],
    delegableActions: ["read", "write", "run-tests", "open-pr"],
    requiredArtifact: "pull-request",
    executionTarget: "new-pull-request",
    createdBy: "operator:test",
  });
  assert.equal(parent.cure, undefined);
  const claimed = queue.claim({ worker: "claude:updex:issue" })!;

  assert.throws(
    () =>
      queue.complete({
        id: parent.id,
        leaseToken: claimed.leaseToken!,
        worker: "claude:updex:issue",
        result: { summary: "Opened the pull request.", evidence: [PR_URL], artifacts: [{ kind: "pull-request", url: PR_URL }] },
        followUps: [
          {
            kind: "pr-cure-change",
            objective: "Change a pull request this lineage does not own.",
            instructions: "Push to someone else's branch.",
            acceptanceCriteria: ["Never admitted."],
            allowedActions: ["read", "write", "run-tests", "open-pr"],
            delegableActions: [],
            requiredArtifact: "pull-request",
            executionTarget: "existing-pull-request",
          },
        ],
      }),
    /follow-up "pr-cure-change": an existing-pull-request item must bind its pull request/,
  );
  assert.equal(queue.get(parent.id)?.status, "claimed");
  assert.equal(
    contractProblem({
      allowedActions: ["read", "write", "open-pr"],
      requiredArtifact: "pull-request",
      executionTarget: "existing-pull-request",
      kind: "pr-cure-change",
      parentId: parent.id,
    })?.code,
    "existing-pull-request-without-binding",
  );
});
