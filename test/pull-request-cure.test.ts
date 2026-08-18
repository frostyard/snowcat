import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { buildQueueMcpServer } from "../src/mcp/server.ts";
import { refreshArtifactVerifications } from "../src/queue/artifact-verification.ts";
import { assertCureCompletion, curePullRequests, inspectPullRequestHealth } from "../src/queue/pull-request-cure.ts";
import { QueueStore } from "../src/queue/store.ts";

const REPOSITORY = "frostyard/updex";
const PR_URL = "https://github.com/frostyard/updex/pull/12";
const PR_PATH = "/repos/frostyard/updex/pulls/12";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const clock = () => new Date("2026-08-18T20:00:00.000Z");
process.env.FLUENT_GITHUB_TOKEN ??= "test-token";

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

function routesFor(options: {
  pull?: Record<string, unknown>;
  head?: string;
  checks?: Array<{ name: string; status: string; conclusion: string | null }>;
  reviews?: Array<{ user: string; state: string }>;
  files?: unknown[];
}): Record<string, unknown> {
  const head = options.head ?? HEAD_A;
  return {
    [PR_PATH]: options.pull ?? pullRequest({ head: { sha: head } }),
    [`/repos/frostyard/updex/commits/${head}/check-runs`]: { check_runs: options.checks ?? [{ name: "check", status: "completed", conclusion: "success" }] },
    [`${PR_PATH}/reviews`]: (options.reviews ?? []).map((review, index) => ({ id: index + 1, user: { login: review.user }, state: review.state })),
    [`${PR_PATH}/files`]: options.files ?? [FILE_V1],
  };
}

function apiFetcher(routes: Record<string, unknown>, options: { status?: number } = {}) {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url.pathname);
    if (options.status !== undefined) return new Response("{}", { status: options.status, headers: { "content-type": "application/json" } });
    const body = routes[url.pathname];
    if (body === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, requests };
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

test("the cure sweep enqueues one admitted pr-cure root per decayed head, never the same head twice, and a push is a new head", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-cure-sweep-test-"));
  const queue = new QueueStore(join(directory, "queue.db"), clock);
  test.after(() => queue.close());
  const originId = await completedWithOpenPr(queue, 7);

  // Healthy: nothing enqueued.
  const healthy = await curePullRequests(queue, { fetcher: apiFetcher(routesFor({})).fetcher, clock });
  assert.deepEqual(healthy, { inspected: 1, enqueued: [], healthy: [PR_URL], skipped: [], unavailable: [] });

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

test("a pr-cure completion is refused when the patch changed, when the pull request is not reported, or when GitHub cannot answer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-cure-complete-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path, clock);
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
  const directory = await mkdtemp(join(tmpdir(), "fluent-cure-store-test-"));
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
  assert.equal(queue.enqueueCureRoot(REPOSITORY, { ...base, allowedActions: [...base.allowedActions], delegableActions: [...base.delegableActions], cure }), undefined);
  assert.equal(queue.metadata().schemaVersion, 5);
});
