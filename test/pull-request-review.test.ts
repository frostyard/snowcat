import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { buildQueueMcpServer } from "../src/mcp/server.ts";
import { refreshArtifactVerifications, verifyGitHubArtifact } from "../src/queue/artifact-verification.ts";
import {
  assertReviewCompletion,
  assertReviewGate,
  convertPullRequestToDraft,
  DESCRIPTION_BLOCKER_PREFIX,
  markPullRequestReady,
  readPullRequestHead,
  reviewFixRootDefinition,
  reviewGateWritesFromEnvironment,
  reviewPullRequests,
  reviewRootDefinition,
  REVIEW_ACTIONS,
  REVIEW_FIX_ACTIONS,
  REVIEW_FIX_KIND,
  REVIEW_KIND,
} from "../src/queue/pull-request-review.ts";
import { type QueueStoreOptions, type PolicyAuthority, QueueStore } from "../src/queue/store.ts";
import type { ReviewBlocker, ReviewResult, WorkItem } from "../src/queue/types.ts";
import { deriveReviewState, settleReviewState } from "../src/surface/review-state.ts";
import { readPullRequests } from "../src/surface/repositories.ts";

const REPOSITORY = "frostyard/updex";
const PR_URL = "https://github.com/frostyard/updex/pull/12";
const PR_PATH = "/repos/frostyard/updex/pulls/12";
const NODE_ID = "PR_kwDOExample12";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);
const HEAD_D = "d".repeat(40);
const clock = () => new Date("2026-08-19T15:00:00.000Z");
process.env.SNOWCAT_GITHUB_TOKEN = "test-token";

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    node_id: NODE_ID,
    html_url: PR_URL,
    title: "fix(catalog): require HTTPS",
    state: "open",
    draft: true,
    merged: false,
    mergeable_state: "clean",
    head: { sha: HEAD_A },
    base: { repo: { full_name: REPOSITORY } },
    body: "## Summary\n\nFix the catalog.\n\n## Verification\n\nChecks observed.\n\n## Risk tier\n\nTier 2",
    ...overrides,
  };
}

const FILE_V1 = {
  filename: "catalog/repo.go",
  status: "modified",
  additions: 2,
  deletions: 1,
  patch: "@@ -10,4 +10,5 @@ func parse() {\n ctx1\n-old line\n+new line\n+another new line\n ctx2\n",
};

const MARK_READY_ROUTE = "graphql:SnowcatMarkReady";
/** `GET /pulls?state=open` — the listing the unreported pass shares with foreign cure; keyed by pathname alone, like every REST route here. */
const LISTING_PATH = "/repos/frostyard/updex/pulls";

/** One entry of the open pull-request listing, as GitHub serves it. */
function listed(number: number, draft: boolean, createdAt?: string): Record<string, unknown> {
  return { number, draft, ...(createdAt ? { created_at: createdAt } : {}) };
}

function routesFor(options: { head?: string; draft?: boolean; state?: string; merged?: boolean; markReady?: unknown; listing?: unknown[] } = {}): Record<string, unknown> {
  const head = options.head ?? HEAD_A;
  return {
    [PR_PATH]: pullRequest({ head: { sha: head }, draft: options.draft ?? true, state: options.state ?? "open", merged: options.merged ?? false }),
    [`${PR_PATH}/files`]: [FILE_V1],
    [MARK_READY_ROUTE]: options.markReady ?? { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } },
    // The pull request every fixture reports; the unreported pass must never
    // report it, so the default listing carries it and nothing else.
    [LISTING_PATH]: options.listing ?? [listed(12, true, "2026-08-18T00:00:00.000Z")],
  };
}

/** Answers REST reads by pathname and `POST /graphql` by the operation name (`graphql:<OperationName>`), queries and mutations alike. */
function apiFetcher(routes: Record<string, unknown>, options: { status?: number } = {}) {
  const requests: string[] = [];
  const graphqlOperations: Array<{ name: string; variables: unknown }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url.pathname);
    if (options.status !== undefined) return new Response("{}", { status: options.status, headers: { "content-type": "application/json" } });
    let key = url.pathname;
    if (url.pathname === "/graphql") {
      assert.equal(init?.method, "POST");
      const body = JSON.parse(String(init?.body)) as { query: string; variables: unknown };
      const name = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "unknown";
      graphqlOperations.push({ name, variables: body.variables });
      key = `graphql:${name}`;
    }
    const body = routes[key];
    if (body === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, requests, graphqlOperations };
}

/** A completed `issue-resolution` item that reported the draft pull request at `head` (verified, open, draft). */
function completedWithDraftPr(queue: QueueStore, options: { head?: string; draft?: boolean; priority?: number; model?: string } = {}): string {
  if (!queue.repositoryReviewGateSettings().some((setting) => setting.repository === REPOSITORY)) queue.setRepositoryEnabled(REPOSITORY, true);
  queue.enqueueSeed({
    repository: REPOSITORY,
    kind: "issue-resolution",
    objective: "Resolve #7: require HTTPS in the catalog",
    instructions: "Open a PR.",
    acceptanceCriteria: ["PR open.", "make check passes."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    requiredArtifact: "pull-request",
    executionTarget: "new-pull-request",
    priority: options.priority ?? 7,
    createdBy: "operator:test",
  });
  const claimed = queue.claim({ worker: "claude:author", kinds: ["issue-resolution"] })!;
  const completion = queue.complete({
    id: claimed.id,
    leaseToken: claimed.leaseToken!,
    worker: "claude:author",
    result: {
      summary: "Opened the PR as a draft.",
      evidence: ["make check"],
      artifacts: [
        {
          kind: "pull-request",
          url: PR_URL,
          verification: {
            status: "verified",
            verifiedAt: clock().toISOString(),
            number: 12,
            state: "open",
            headSha: options.head ?? HEAD_A,
            ...(options.draft === false ? {} : { draft: true }),
          },
        },
      ],
      ...(options.model ? { model: options.model } : {}),
    },
    followUps: [],
  });
  return completion.completed.id;
}

function blocker(fingerprint: string, overrides: Partial<ReviewBlocker> = {}): ReviewBlocker {
  return {
    fingerprint,
    location: "catalog/repo.go:12",
    contract: "acceptance criterion 2: make check passes",
    impact: "the build fails on the new head",
    resolution: "restore the removed import",
    verification: "make check is green",
    ...overrides,
  };
}

/** Claims the queued `pr-review` item and completes it with `review`, bypassing MCP (the store and the assertion are tested separately). */
async function completeReview(queue: QueueStore, review: ReviewResult, options: { fetcher?: typeof fetch; model?: string } = {}): Promise<WorkItem> {
  const claimed = queue.claim({ worker: "claude:reviewer", kinds: [REVIEW_KIND] });
  assert.ok(claimed, "a pr-review item is claimable");
  await assertReviewCompletion(claimed, [], review, { fetcher: options.fetcher ?? apiFetcher(routesFor({ head: claimed.review!.headSha })).fetcher, clock });
  const done = queue.complete({
    id: claimed.id,
    leaseToken: claimed.leaseToken!,
    worker: "claude:reviewer",
    result: { summary: `Reviewed round ${claimed.review!.round}.`, evidence: [`head ${claimed.review!.headSha}`, "make check locally"], artifacts: [], ...(options.model ? { model: options.model } : {}) },
    followUps: [],
    review,
  });
  return done.completed;
}

/** Claims the queued `pr-review-fix` item and completes it reporting the pull request. */
function completeFix(queue: QueueStore, model = "claude-opus-5"): WorkItem {
  const claimed = queue.claim({ worker: "claude:fixer", kinds: [REVIEW_FIX_KIND] });
  assert.ok(claimed, "a pr-review-fix item is claimable");
  return queue.complete({
    id: claimed.id,
    leaseToken: claimed.leaseToken!,
    worker: "claude:fixer",
    result: {
      summary: "Addressed the blockers and pushed.",
      evidence: ["defect:catalog/repo.go:import addressed"],
      artifacts: [{ kind: "pull-request", url: PR_URL, verification: { status: "verified", verifiedAt: clock().toISOString(), number: 12, state: "open", headSha: HEAD_B, draft: true } }],
      model,
    },
    followUps: [],
  }).completed;
}

async function newQueue(prefix: string, options: QueueStoreOptions = {}): Promise<QueueStore> {
  const directory = await mkdtemp(join(tmpdir(), `snowcat-${prefix}-`));
  const queue = new QueueStore(join(directory, "queue.db"), clock, options);
  test.after(() => queue.close());
  return queue;
}

test("artifact verification records draft only while GitHub says so, and the refresh notices the flip", async () => {
  const draft = await verifyGitHubArtifact(REPOSITORY, { kind: "pull-request", url: PR_URL }, { fetcher: apiFetcher(routesFor({ draft: true })).fetcher, clock });
  assert.equal(draft.kind, "verified");
  if (draft.kind !== "verified") return;
  assert.equal(draft.verification.draft, true);
  const ready = await verifyGitHubArtifact(REPOSITORY, { kind: "pull-request", url: PR_URL }, { fetcher: apiFetcher(routesFor({ draft: false })).fetcher, clock });
  assert.equal(ready.kind, "verified");
  if (ready.kind !== "verified") return;
  assert.equal("draft" in ready.verification, false, "a ready pull request carries no draft key");

  const queue = await newQueue("review-draft-refresh");
  const originId = completedWithDraftPr(queue);
  const refreshed = await refreshArtifactVerifications(queue, { fetcher: apiFetcher(routesFor({ draft: false })).fetcher, clock });
  assert.equal(refreshed.updated.length, 1, "draft → ready is a change worth recording");
  const artifact = queue.get(originId)!.result!.artifacts[0]!;
  assert.equal(artifact.verification?.status, "verified");
  assert.equal("draft" in (artifact.verification as Record<string, unknown>), false);
  const again = await refreshArtifactVerifications(queue, { fetcher: apiFetcher(routesFor({ draft: false })).fetcher, clock });
  assert.equal(again.updated.length, 0, "unchanged observations are not re-recorded");
});

test("readPullRequestHead and the head read distinguish draft, ready, merged, rejected, and unavailable", async () => {
  const draft = await readPullRequestHead(REPOSITORY, PR_URL, { fetcher: apiFetcher(routesFor({})).fetcher });
  assert.equal(draft.kind, "head");
  if (draft.kind !== "head") return;
  assert.deepEqual(draft.head, { number: 12, url: PR_URL, nodeId: NODE_ID, headSha: HEAD_A, state: "open", draft: true, title: "fix(catalog): require HTTPS" });
  const merged = await readPullRequestHead(REPOSITORY, PR_URL, { fetcher: apiFetcher(routesFor({ state: "closed", merged: true })).fetcher });
  assert.equal(merged.kind === "head" && merged.head.state, "merged");
  const other = await readPullRequestHead(REPOSITORY, "https://github.com/frostyard/lodge/pull/1", { fetcher: apiFetcher(routesFor({})).fetcher });
  assert.equal(other.kind, "rejected");
  const down = await readPullRequestHead(REPOSITORY, PR_URL, { fetcher: apiFetcher({}, { status: 500 }).fetcher });
  assert.equal(down.kind, "unavailable");
  const missing = await readPullRequestHead(REPOSITORY, PR_URL, { fetcher: apiFetcher({}).fetcher });
  assert.equal(missing.kind, "rejected");

  const marked = await markPullRequestReady(NODE_ID, apiFetcher(routesFor({})).fetcher);
  assert.deepEqual(marked, { kind: "marked" });
  const refused = await markPullRequestReady(NODE_ID, apiFetcher(routesFor({ markReady: { errors: [{ message: "Resource not accessible by integration" }] } })).fetcher);
  assert.equal(refused.kind, "unavailable");
  assert.match((refused as { reason: string }).reason, /Resource not accessible/);
  const converted = await convertPullRequestToDraft(NODE_ID, apiFetcher({ "graphql:SnowcatConvertToDraft": { data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } } }).fetcher);
  assert.deepEqual(converted, { kind: "converted" });
  const notConverted = await convertPullRequestToDraft(NODE_ID, apiFetcher({}).fetcher);
  assert.equal(notConverted.kind, "unavailable");

  assert.equal(reviewGateWritesFromEnvironment({}), false);
  assert.equal(reviewGateWritesFromEnvironment({ SNOWCAT_REVIEW_GATE_WRITES: "1" }), true);
  assert.equal(reviewGateWritesFromEnvironment({ SNOWCAT_REVIEW_GATE_WRITES: "true" }), false, "only the literal 1 turns writes on");
});

test("the review gate refuses an open non-draft pull request in a gated repository at complete_work and leaves the item claimed", async () => {
  const queue = await newQueue("review-gate-mcp");
  queue.setRepositoryEnabled(REPOSITORY, true);
  const seed = () =>
    queue.enqueueSeed({
      repository: REPOSITORY,
      kind: "issue-resolution",
      objective: "Resolve #8",
      instructions: "Open a PR.",
      acceptanceCriteria: ["PR open."],
      allowedActions: ["read", "write", "run-tests", "open-pr"],
      delegableActions: [],
      requiredArtifact: "pull-request",
      executionTarget: "new-pull-request",
      createdBy: "operator:test",
    });
  const connect = async (fetcher: typeof fetch) => {
    const server = buildQueueMcpServer(":memory:", { fetcher, clock }, {}, undefined, queue);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "review-gate-test", version: "0.1.0" });
    await client.connect(clientTransport);
    return { client, close: async () => { await client.close(); await server.close(); } };
  };
  const complete = (client: Client, item: WorkItem, extra: Record<string, unknown> = {}) =>
    client.callTool({
      name: "complete_work",
      arguments: {
        id: item.id,
        leaseToken: item.leaseToken,
        worker: "claude:author",
        result: { summary: "Opened the PR.", evidence: ["make check"], artifacts: [{ kind: "pull-request", url: PR_URL }], model: "claude-sonnet-5" },
        followUps: [],
        ...extra,
      },
    });

  // Gate off (the default): a ready pull request completes as before.
  seed();
  let claimed = queue.claim({ worker: "claude:author" })!;
  let session = await connect(apiFetcher(routesFor({ draft: false })).fetcher);
  let answer = await complete(session.client, claimed);
  assert.equal(answer.isError, undefined, JSON.stringify(answer.content));
  assert.equal(queue.get(claimed.id)!.status, "completed");
  assert.equal(queue.get(claimed.id)!.result?.model, "claude-sonnet-5", "the reported model is kept as provenance");
  await session.close();

  // Gate on: the same report is refused, the item stays claimed, the message says how to fix it.
  queue.setRepositoryReviewGate(REPOSITORY, true);
  seed();
  claimed = queue.claim({ worker: "claude:author" })!;
  session = await connect(apiFetcher(routesFor({ draft: false })).fetcher);
  answer = await complete(session.client, claimed);
  assert.equal(answer.isError, true);
  assert.match(JSON.stringify(answer.content), /review gate: pull request .*pull\/12 is open and not a draft in frostyard\/updex; convert it with `gh pr ready --undo 12`/);
  assert.equal(queue.get(claimed.id)!.status, "claimed");
  await session.close();

  // A draft completes; so does a merged pull request; an unverifiable one is accepted as unverified (never a guess).
  session = await connect(apiFetcher(routesFor({ draft: true })).fetcher);
  answer = await complete(session.client, claimed);
  assert.equal(answer.isError, undefined, JSON.stringify(answer.content));
  assert.equal(queue.get(claimed.id)!.result?.artifacts[0]?.verification?.status, "verified");
  assert.equal((queue.get(claimed.id)!.result?.artifacts[0]?.verification as { draft?: boolean }).draft, true);
  await session.close();
  seed();
  claimed = queue.claim({ worker: "claude:author" })!;
  session = await connect(apiFetcher(routesFor({ draft: false, state: "closed", merged: true })).fetcher);
  answer = await complete(session.client, claimed);
  assert.equal(answer.isError, undefined, JSON.stringify(answer.content));
  await session.close();
  seed();
  claimed = queue.claim({ worker: "claude:author" })!;
  session = await connect(apiFetcher({}, { status: 503 }).fetcher);
  answer = await complete(session.client, claimed);
  assert.equal(answer.isError, undefined, JSON.stringify(answer.content));
  assert.equal(queue.get(claimed.id)!.result?.artifacts[0]?.verification?.status, "unverified");
  await session.close();

  // A pr-cure item is exempt: cure acts only on ready pull requests.
  const cure: WorkItem = { ...queue.get(claimed.id)!, kind: "pr-cure" };
  assertReviewGate(queue, cure, [{ kind: "pull-request", url: PR_URL, verification: { status: "verified", verifiedAt: clock().toISOString(), number: 12, state: "open" } }]);
  // So is a pr-cure-change (a substantive cure on a ready pull request).
  assertReviewGate(queue, { ...cure, kind: "pr-cure-change" }, [{ kind: "pull-request", url: PR_URL, verification: { status: "verified", verifiedAt: clock().toISOString(), number: 12, state: "open" } }]);
  // A pr-review-fix is not: it must keep the pull request a draft.
  assert.throws(() => assertReviewGate(queue, { ...cure, kind: REVIEW_FIX_KIND }, [{ kind: "pull-request", url: PR_URL, verification: { status: "verified", verifiedAt: clock().toISOString(), number: 12, state: "open" } }]), /review gate/);
  assert.throws(
    () =>
      assertReviewGate(queue, { ...cure, kind: "issue-resolution" }, [
        {
          kind: "pull-request",
          url: PR_URL,
          verification: {
            status: "verified",
            verifiedAt: clock().toISOString(),
            number: 12,
            state: "open",
            handoff: { status: "unverified", attemptedAt: clock().toISOString(), reason: "template unavailable" },
          },
        },
      ]),
    /review gate/,
    "a template outage never hides the verified non-draft state",
  );
  // A ready pull request the gate itself released (a passed round exists for its URL) is accepted by any kind.
  const releasedQueue = await newQueue("review-gate-released");
  completedWithDraftPr(releasedQueue);
  releasedQueue.setRepositoryReviewGate(REPOSITORY, true);
  await reviewPullRequests(releasedQueue, { fetcher: apiFetcher(routesFor({})).fetcher, clock });
  const readyArtifact = [{ kind: "pull-request" as const, url: PR_URL, verification: { status: "verified" as const, verifiedAt: clock().toISOString(), number: 12, state: "open" as const } }];
  assert.throws(() => assertReviewGate(releasedQueue, { ...cure, kind: "issue-resolution" }, readyArtifact), /review gate/, "not yet passed: refused");
  await completeReview(releasedQueue, { decision: "pass", blockers: [], advisories: [] });
  assertReviewGate(releasedQueue, { ...cure, kind: "issue-resolution" }, readyArtifact);
  assertReviewGate(releasedQueue, { ...cure, kind: REVIEW_FIX_KIND }, readyArtifact);

  // A verdict on a non-review item is refused at the schema (strict) and at the store.
  seed();
  claimed = queue.claim({ worker: "claude:author" })!;
  session = await connect(apiFetcher(routesFor({ draft: true })).fetcher);
  answer = await complete(session.client, claimed, { review: { decision: "pass", blockers: [], advisories: [] } });
  assert.equal(answer.isError, true);
  assert.match(JSON.stringify(answer.content), /review results are accepted only on pr-review items/);
  answer = await complete(session.client, claimed, { result: { summary: "x", evidence: [], artifacts: [], model: "has spaces in it" } });
  assert.equal(answer.isError, true, "a model name with whitespace is rejected by the schema");
  assert.throws(
    () => queue.complete({ id: claimed.id, leaseToken: claimed.leaseToken!, worker: "claude:author", result: { summary: "x", evidence: [], artifacts: [{ kind: "pull-request", url: PR_URL }] }, followUps: [], review: { decision: "pass", blockers: [], advisories: [] } }),
    /review results are accepted only on pr-review items/,
  );
  assert.throws(
    () => queue.complete({ id: claimed.id, leaseToken: claimed.leaseToken!, worker: "claude:author", result: { summary: "x", evidence: [], artifacts: [], model: "bad model" }, followUps: [] }),
    /result model/,
  );
  await session.close();
});

test("the sweep reads nothing without a gated repository and creates one admitted read-only pr-review root per draft head", async () => {
  const queue = await newQueue("review-sweep");
  const originId = completedWithDraftPr(queue, { model: "claude-sonnet-5" });

  // Gate off: no GitHub read, nothing created.
  const quiet = apiFetcher(routesFor({}));
  const untouched = await reviewPullRequests(queue, { fetcher: quiet.fetcher, clock });
  assert.deepEqual(untouched, { inspected: 0, enqueued: [], markedReady: [], readyToMark: [], needsHuman: [], skipped: [], unavailable: [], unreported: [], unreportedPending: [] });
  assert.deepEqual(quiet.requests, []);

  queue.setRepositoryReviewGate(REPOSITORY, true);
  const api = apiFetcher(routesFor({}));
  const swept = await reviewPullRequests(queue, { fetcher: api.fetcher, clock });
  assert.equal(swept.inspected, 1);
  assert.equal(swept.enqueued.length, 1);
  assert.deepEqual(swept.enqueued[0], { id: swept.enqueued[0]!.id, kind: REVIEW_KIND, url: PR_URL, headSha: HEAD_A, round: 1 });
  const item = queue.get(swept.enqueued[0]!.id)!;
  assert.equal(item.status, "queued", "admitted on creation");
  assert.equal(item.kind, REVIEW_KIND);
  assert.equal(item.sourceRef, `pr-review:${PR_URL}@${HEAD_A}`);
  assert.equal(item.priority, 7, "inherits the origin item's priority");
  assert.equal(item.createdBy, "policy:review-gate");
  assert.deepEqual(item.allowedActions, REVIEW_ACTIONS);
  assert.deepEqual(item.delegableActions, []);
  assert.deepEqual(
    { ...item.review, patchDigest: item.review?.patchDigest?.slice(0, 7) },
    { pullRequestUrl: PR_URL, headSha: HEAD_A, patchDigest: "sha256:", round: 1, originItemId: originId, authorModel: "claude-sonnet-5", priorBlockers: [] },
  );
  assert.match(item.instructions, /get_work\("/);
  assert.match(item.instructions, /the author reported model claude-sonnet-5/);
  assert.match(item.instructions, /READ-ONLY on GitHub/);
  assert.match(item.instructions, /gh pr checks|check-runs/);
  assert.doesNotMatch(item.instructions, /when it exists|where it exists/);
  assert.match(item.objective, /round 1 of 3/);
  const queued = queue.events(item.id).find((event) => event.type === "work.queued")!;
  assert.deepEqual(queued.payload, { root: true, review: { kind: REVIEW_KIND, pullRequestUrl: PR_URL, headSha: HEAD_A, round: 1 } });

  // Same head again: skipped (in flight); a pull request that is no longer a draft: skipped; a closed one: skipped.
  const again = await reviewPullRequests(queue, { fetcher: apiFetcher(routesFor({})).fetcher, clock });
  assert.deepEqual(again.enqueued, []);
  assert.deepEqual(again.skipped, [{ url: PR_URL, reason: "a review or fix is in flight" }]);
  queue.setRepositoryEnabled("frostyard/other", true);
  const ready = await reviewPullRequests(queue, { fetcher: apiFetcher(routesFor({ draft: false })).fetcher, clock, repository: "frostyard/other" });
  assert.equal(ready.inspected, 0, "--repository narrows to one gated repository");
  const claimed = queue.claim({ worker: "claude:reviewer", kinds: [REVIEW_KIND] })!;
  queue.release(claimed.id, claimed.leaseToken!, "claude:reviewer", "wrong client");
  const down = await reviewPullRequests(queue, { fetcher: apiFetcher({}, { status: 500 }).fetcher, clock });
  assert.deepEqual(down.unavailable, [
    { url: PR_URL, reason: "GitHub API returned HTTP 500" },
    { url: `https://github.com/${REPOSITORY}/pulls`, reason: `GitHub open pull-request listing unavailable for ${REPOSITORY}` },
  ]);
  assert.deepEqual(down.unreported, [], "a listing GitHub could not serve leaves the previous observation standing");
});

test("the review sweep waits while a verified draft has an unresolved handoff check", async () => {
  const queue = await newQueue("review-handoff-wait");
  const originId = completedWithDraftPr(queue);
  queue.recordArtifactVerification(
    originId,
    PR_URL,
    {
      status: "verified",
      verifiedAt: clock().toISOString(),
      number: 12,
      state: "open",
      headSha: HEAD_A,
      draft: true,
      handoff: { status: "rejected", checkedAt: clock().toISOString(), reason: "body is missing a required section" },
    },
    "policy:artifact-verifier",
  );
  queue.setRepositoryReviewGate(REPOSITORY, true);
  const renamedRepository = "frostyard/updex-renamed";
  const renamedUrl = `https://github.com/${renamedRepository}/pull/12`;
  queue.renameRepository(REPOSITORY, renamedRepository, "operator:test");
  queue.enqueueSeed({
    repository: renamedRepository,
    kind: "issue-resolution",
    objective: "Observe the current pull request URL.",
    instructions: "Report the pull request.",
    acceptanceCriteria: ["The current URL is recorded."],
    allowedActions: ["read", "write", "open-pr"],
    delegableActions: [],
    requiredArtifact: "pull-request",
    executionTarget: "new-pull-request",
    createdBy: "operator:test",
  });
  const current = queue.claim({ worker: "claude:current-url" })!;
  queue.complete({
    id: current.id,
    leaseToken: current.leaseToken!,
    worker: current.leaseOwner!,
    result: {
      summary: "Recorded the current URL.",
      evidence: ["observed"],
      artifacts: [
        {
          kind: "pull-request",
          url: renamedUrl,
          verification: {
            status: "verified",
            verifiedAt: "2026-08-17T21:00:00.000Z",
            number: 12,
            state: "open",
            headSha: HEAD_A,
            draft: true,
          },
        },
      ],
    },
    followUps: [],
  });

  const swept = await reviewPullRequests(queue, {
    repository: renamedRepository,
    fetcher: apiFetcher(routesFor({})).fetcher,
    clock,
  });
  assert.equal(swept.inspected, 0);
  assert.equal(swept.enqueued.length, 0);
});

test("a pr-review completion needs a consistent verdict bound to the same head; the store merges it and records work.reviewed", async () => {
  const queue = await newQueue("review-complete");
  completedWithDraftPr(queue);
  queue.setRepositoryReviewGate(REPOSITORY, true);
  await reviewPullRequests(queue, { fetcher: apiFetcher(routesFor({})).fetcher, clock });
  const claimed = queue.claim({ worker: "claude:reviewer", kinds: [REVIEW_KIND] })!;
  const assertion = (review: ReviewResult | undefined, fetcher = apiFetcher(routesFor({})).fetcher) => assertReviewCompletion(claimed, [], review, { fetcher, clock });

  await assert.rejects(assertion(undefined), /pr-review completion requires a review result/);
  await assert.rejects(assertion({ decision: "block", blockers: [], advisories: [] }), /block requires at least one blocker/);
  await assert.rejects(assertion({ decision: "pass", blockers: [blocker("defect:x")], advisories: [] }), /pass must carry no blockers/);
  await assert.rejects(assertion({ decision: "pass", blockers: [], advisories: [] }, apiFetcher(routesFor({ head: HEAD_B })).fetcher), /head moved \(reviewed aaaaaaa, now bbbbbbb\); block this item instead/);
  await assert.rejects(assertion({ decision: "pass", blockers: [], advisories: [] }, apiFetcher({}, { status: 500 }).fetcher), /cannot be verified/);
  await assertion({ decision: "pass", blockers: [], advisories: [] });
  await assertion({ decision: "pass", blockers: [], advisories: [] }, apiFetcher(routesFor({ state: "closed", merged: true })).fetcher);
  // A pr-review-fix must report its pull request and carries no verdict.
  await assert.rejects(assertReviewCompletion({ ...claimed, kind: REVIEW_FIX_KIND }, [], undefined), /must report .*pull\/12 as a pull-request artifact/);
  await assert.rejects(assertReviewCompletion({ ...claimed, kind: REVIEW_FIX_KIND }, [{ kind: "pull-request", url: PR_URL }], { decision: "pass", blockers: [], advisories: [] }), /accepted only on pr-review/);
  await assertReviewCompletion({ ...claimed, kind: REVIEW_FIX_KIND }, [{ kind: "pull-request", url: PR_URL }], undefined);

  // The store repeats the checks and refuses a completion without a verdict.
  const base = { id: claimed.id, leaseToken: claimed.leaseToken!, worker: "claude:reviewer", result: { summary: "Reviewed.", evidence: [], artifacts: [] }, followUps: [] };
  assert.throws(() => queue.complete(base), /pr-review completion requires a review result/);
  assert.throws(() => queue.complete({ ...base, review: { decision: "block", blockers: [], advisories: [] } }), /block requires at least one blocker/);
  assert.throws(() => queue.complete({ ...base, review: { decision: "block", blockers: [blocker("a:b"), blocker("a:b")], advisories: [] } }), /fingerprints must be distinct/);
  assert.throws(() => queue.complete({ ...base, review: { decision: "block", blockers: [1, 2, 3, 4, 5, 6].map((n) => blocker(`defect:${n}`)), advisories: [] } }), /at most 5 blockers/);
  assert.throws(() => queue.complete({ ...base, review: { decision: "pass", blockers: [], advisories: [1, 2, 3, 4].map((n) => ({ fingerprint: `adv:${n}`, text: "x" })) } }), /at most 3 advisories/);
  assert.throws(() => queue.complete({ ...base, review: { decision: "block", blockers: [blocker("defect:x", { resolution: " " })], advisories: [] } }), /blocker resolution is required/);

  const verdict: ReviewResult = { decision: "block", blockers: [blocker("defect:catalog/repo.go:import")], advisories: [{ fingerprint: "adv:naming", text: "rename parse to parseCatalog" }] };
  const done = queue.complete({ ...base, result: { ...base.result, model: "claude-opus-5" }, review: verdict }).completed;
  assert.equal(done.status, "completed");
  assert.deepEqual(done.review, { pullRequestUrl: PR_URL, headSha: HEAD_A, patchDigest: done.review?.patchDigest, round: 1, originItemId: done.review?.originItemId, priorBlockers: [], ...verdict, reviewedAt: clock().toISOString() });
  assert.equal(done.result?.model, "claude-opus-5");
  const reviewed = queue.events(done.id).find((event) => event.type === "work.reviewed")!;
  assert.deepEqual(reviewed.payload, { decision: "block", round: 1, headSha: HEAD_A, pullRequestUrl: PR_URL, fingerprints: ["defect:catalog/repo.go:import"] });
  const completed = queue.events(done.id).find((event) => event.type === "work.completed")!;
  assert.equal(completed.payload.model, "claude-opus-5");
});

test("block → one admitted fix root; a new head → the next round with prior blockers and models; round 3 block → needs human", async () => {
  const queue = await newQueue("review-rounds");
  const originId = completedWithDraftPr(queue, { model: "claude-sonnet-5" });
  queue.setRepositoryReviewGate(REPOSITORY, true);
  const sweep = (head: string) => reviewPullRequests(queue, { fetcher: apiFetcher(routesFor({ head })).fetcher, clock });

  // Round 1 on head A blocks.
  await sweep(HEAD_A);
  const round1 = await completeReview(queue, { decision: "block", blockers: [blocker("defect:catalog/repo.go:import")], advisories: [] }, { model: "claude-opus-5" });
  const afterBlock = await sweep(HEAD_A);
  assert.equal(afterBlock.enqueued.length, 1);
  assert.equal(afterBlock.enqueued[0]!.kind, REVIEW_FIX_KIND);
  const fix = queue.get(afterBlock.enqueued[0]!.id)!;
  assert.equal(fix.status, "queued", "admitted on creation");
  assert.equal(fix.sourceRef, `pr-review-fix:${PR_URL}@${HEAD_A}`);
  assert.deepEqual(fix.allowedActions, REVIEW_FIX_ACTIONS);
  assert.deepEqual(fix.delegableActions, []);
  assert.equal(fix.priority, 7);
  assert.deepEqual(
    { ...fix.review, patchDigest: undefined },
    { pullRequestUrl: PR_URL, headSha: HEAD_A, patchDigest: undefined, round: 1, originItemId: originId, authorModel: "claude-sonnet-5", priorBlockers: [], reviewItemId: round1.id, reviewerModel: "claude-opus-5", blockers: round1.review!.blockers, advisories: [] },
  );
  assert.match(fix.instructions, /\[defect:catalog\/repo.go:import\] at catalog\/repo.go:12/);
  assert.match(fix.instructions, /keep the pull request a DRAFT/);
  assert.match(fix.instructions, /gh pr checks|check-runs/);
  assert.doesNotMatch(fix.instructions, /when it exists|where it exists/);
  const queued = queue.events(fix.id).find((event) => event.type === "work.queued")!;
  assert.deepEqual(queued.payload, { root: true, review: { kind: REVIEW_FIX_KIND, pullRequestUrl: PR_URL, headSha: HEAD_A, round: 1, reviewItemId: round1.id, fingerprints: ["defect:catalog/repo.go:import"] } });
  // Idempotent while the fix is in flight, and after it completes the fix itself is no candidate origin.
  const again = await sweep(HEAD_A);
  assert.deepEqual(again.enqueued, []);
  assert.deepEqual(again.skipped, [{ url: PR_URL, reason: "a review or fix is in flight" }]);
  const completedFix = completeFix(queue);
  queue.recordArtifactVerification(
    completedFix.id,
    PR_URL,
    {
      status: "verified",
      verifiedAt: clock().toISOString(),
      number: 12,
      state: "open",
      headSha: HEAD_B,
      draft: true,
      handoff: { status: "rejected", checkedAt: clock().toISOString(), reason: "body is missing a required section" },
    },
    "policy:artifact-verifier",
  );
  queue.recordArtifactVerification(
    originId,
    PR_URL,
    {
      status: "verified",
      verifiedAt: "2026-08-17T21:00:00.000Z",
      number: 12,
      state: "open",
      headSha: HEAD_B,
      draft: true,
    },
    "policy:artifact-verifier",
  );
  const waitingForRepair = await sweep(HEAD_B);
  assert.equal(waitingForRepair.inspected, 0, "a review-fix handoff defect pauses the next review round");
  assert.deepEqual(waitingForRepair.enqueued, []);
  queue.recordArtifactVerification(
    completedFix.id,
    PR_URL,
    {
      status: "verified",
      verifiedAt: clock().toISOString(),
      number: 12,
      state: "open",
      headSha: HEAD_B,
      draft: true,
    },
    "policy:artifact-verifier",
  );

  // The fix pushed head B: round 2 carries the prior blockers and both models.
  const roundTwo = await sweep(HEAD_B);
  assert.equal(roundTwo.enqueued.length, 1);
  assert.deepEqual(roundTwo.enqueued[0], { id: roundTwo.enqueued[0]!.id, kind: REVIEW_KIND, url: PR_URL, headSha: HEAD_B, round: 2 });
  const review2 = queue.get(roundTwo.enqueued[0]!.id)!;
  assert.equal(review2.review?.round, 2);
  assert.deepEqual(review2.review?.priorBlockers, round1.review!.blockers);
  assert.equal(review2.review?.authorModel, "claude-sonnet-5");
  assert.equal(review2.review?.priorReviewerModel, "claude-opus-5");
  assert.equal(review2.review?.originItemId, originId, "the origin is the item that reported the pull request, not the fix");
  assert.match(review2.instructions, /This is round 2: examine the prior round's blockers and the diff since head aaaaaaa/);
  assert.match(review2.instructions, /the previous reviewer reported model claude-opus-5/);
  await completeReview(queue, { decision: "block", blockers: [blocker("defect:catalog/repo.go:import"), blocker("defect:catalog/repo.go:nil-check")], advisories: [] }, { model: "claude-opus-5" });
  const fix2 = await sweep(HEAD_B);
  assert.equal(fix2.enqueued[0]?.kind, REVIEW_FIX_KIND, JSON.stringify(fix2));
  completeFix(queue);

  // Round 3 on head C blocks: no fix, a human is needed.
  const roundThree = await sweep(HEAD_C);
  assert.equal(roundThree.enqueued[0]?.round, 3);
  await completeReview(queue, { decision: "block", blockers: [blocker("defect:catalog/repo.go:nil-check")], advisories: [] });
  const exhausted = await sweep(HEAD_C);
  assert.deepEqual(exhausted.enqueued, []);
  assert.deepEqual(exhausted.needsHuman, [{ url: PR_URL, headSha: HEAD_C, round: 3, reason: "blocked at round 3 of 3" }]);
  // Another push after three completed rounds: the budget is spent, not reset.
  const pushed = await sweep(HEAD_D);
  assert.deepEqual(pushed.enqueued, []);
  assert.deepEqual(pushed.needsHuman, [{ url: PR_URL, headSha: HEAD_D, round: 4, reason: "review budget exhausted (3 rounds)" }]);
  assert.equal(queue.pullRequestReviewItems(REPOSITORY, PR_URL).length, 5, "three reviews and two fixes, oldest first");
  assert.equal(queue.pullRequestReviewItems(REPOSITORY, PR_URL.toUpperCase()).length, 5, "URL match is case-insensitive");
});

test("ADR-0067: a verdict of only description blockers mints no fix and goes to human adjudication instead", async () => {
  const queue = await newQueue("review-description-only");
  completedWithDraftPr(queue);
  queue.setRepositoryReviewGate(REPOSITORY, true);
  const sweep = (head: string) => reviewPullRequests(queue, { fetcher: apiFetcher(routesFor({ head })).fetcher, clock });

  await sweep(HEAD_A);
  const descriptionBlocker = blocker(`${DESCRIPTION_BLOCKER_PREFIX}credential-risk-tier`, {
    location: "pull request description",
    contract: "the risk-tier section names the tier the diff belongs to",
  });
  await completeReview(queue, { decision: "block", blockers: [descriptionBlocker], advisories: [] });

  const swept = await sweep(HEAD_A);
  assert.deepEqual(swept.enqueued, [], "no pr-review-fix is minted for an all-description verdict");
  assert.equal(swept.needsHuman.length, 1);
  assert.deepEqual(
    { url: swept.needsHuman[0]!.url, headSha: swept.needsHuman[0]!.headSha, round: swept.needsHuman[0]!.round },
    { url: PR_URL, headSha: HEAD_A, round: 1 },
  );
  assert.match(swept.needsHuman[0]!.reason, /round 1 blocked on 1 description blocker/);
  assert.match(swept.needsHuman[0]!.reason, new RegExp(`\\[${DESCRIPTION_BLOCKER_PREFIX}credential-risk-tier\\] at pull request description`));
  assert.equal(queue.pullRequestReviewItems(REPOSITORY, PR_URL).some((item) => item.kind === REVIEW_FIX_KIND), false, "no fix item exists at all, not just none enqueued this pass");

  // The pull request surfaces through the same adjudication read the board and inbox use (ADR-0065 decision point 5).
  const state = deriveReviewState(queue.pullRequestReviewItems(REPOSITORY, PR_URL), HEAD_A, true);
  assert.equal(state?.needsHuman, true);
  assert.equal(state?.readyToMark, false);
  assert.match(state?.reason ?? "", /description blocker/);

  // Idempotent: sweeping the same unmoved head again reports the same thing, still no fix.
  const again = await sweep(HEAD_A);
  assert.deepEqual(again.enqueued, []);
  assert.equal(again.needsHuman.length, 1);
});

test("ADR-0067: a mixed verdict mints a fix for the tree blockers only; the description blockers still reach adjudication", async () => {
  const queue = await newQueue("review-description-mixed");
  completedWithDraftPr(queue);
  queue.setRepositoryReviewGate(REPOSITORY, true);
  const sweep = (head: string) => reviewPullRequests(queue, { fetcher: apiFetcher(routesFor({ head })).fetcher, clock });

  await sweep(HEAD_A);
  const treeBlocker = blocker("defect:catalog/repo.go:import");
  const descriptionBlocker = blocker(`${DESCRIPTION_BLOCKER_PREFIX}evidence-missing`, { location: "pull request description" });
  await completeReview(queue, { decision: "block", blockers: [treeBlocker, descriptionBlocker], advisories: [] });

  const swept = await sweep(HEAD_A);
  assert.equal(swept.enqueued.length, 1);
  assert.equal(swept.enqueued[0]!.kind, REVIEW_FIX_KIND);
  const fix = queue.get(swept.enqueued[0]!.id)!;
  assert.deepEqual(fix.review?.blockers, [treeBlocker], "the fix carries only the tree blocker, never the description one");
  assert.doesNotMatch(fix.instructions, /evidence-missing/, "the description blocker's own fingerprint never appears in the fix instructions");

  assert.equal(swept.needsHuman.length, 1, "the description blocker still rides to adjudication");
  assert.deepEqual(
    { url: swept.needsHuman[0]!.url, headSha: swept.needsHuman[0]!.headSha, round: swept.needsHuman[0]!.round },
    { url: PR_URL, headSha: HEAD_A, round: 1 },
  );
  assert.match(swept.needsHuman[0]!.reason, /1 description blocker/);

  // Board: while the fix is queued for the tree portion, the description blocker still needs a human.
  const state = deriveReviewState(queue.pullRequestReviewItems(REPOSITORY, PR_URL), HEAD_A, true);
  assert.equal(state?.active, true, "the tree fix is in flight");
  assert.equal(state?.needsHuman, true, "but the description blocker still needs a human, right alongside it");
  assert.match(state?.reason ?? "", /description blocker/);
});

test("ADR-0067: a description blocker's adjudication reason notes when the description changed after the verdict", async () => {
  const queue = await newQueue("review-description-stale");
  completedWithDraftPr(queue);
  queue.setRepositoryReviewGate(REPOSITORY, true);
  await reviewPullRequests(queue, { fetcher: apiFetcher(routesFor({ head: HEAD_A })).fetcher, clock });
  await completeReview(queue, { decision: "block", blockers: [blocker(`${DESCRIPTION_BLOCKER_PREFIX}risk-tier`, { location: "pull request description" })], advisories: [] });

  const editedAfter = apiFetcher({
    ...routesFor({ head: HEAD_A }),
    "graphql:SnowcatPullRequestLastEdited": { data: { repository: { pullRequest: { lastEditedAt: "2026-08-19T15:30:00.000Z" } } } },
  });
  const stale = await reviewPullRequests(queue, { fetcher: editedAfter.fetcher, clock });
  assert.match(stale.needsHuman[0]!.reason, /description changed after review/);

  const queue2 = await newQueue("review-description-not-stale");
  completedWithDraftPr(queue2);
  queue2.setRepositoryReviewGate(REPOSITORY, true);
  await reviewPullRequests(queue2, { fetcher: apiFetcher(routesFor({ head: HEAD_A })).fetcher, clock });
  await completeReview(queue2, { decision: "block", blockers: [blocker(`${DESCRIPTION_BLOCKER_PREFIX}risk-tier`, { location: "pull request description" })], advisories: [] });
  const editedBefore = apiFetcher({
    ...routesFor({ head: HEAD_A }),
    "graphql:SnowcatPullRequestLastEdited": { data: { repository: { pullRequest: { lastEditedAt: "2026-08-19T14:00:00.000Z" } } } },
  });
  const notStale = await reviewPullRequests(queue2, { fetcher: editedBefore.fetcher, clock });
  assert.doesNotMatch(notStale.needsHuman[0]!.reason, /description changed after review/);
});

test("pass → ready to mark (writes off) or marked ready through GraphQL with artifact.ready (writes on); unable-to-review and a fix without a new head need a human", async () => {
  const queue = await newQueue("review-pass");
  const originId = completedWithDraftPr(queue);
  queue.setRepositoryReviewGate(REPOSITORY, true);
  await reviewPullRequests(queue, { fetcher: apiFetcher(routesFor({})).fetcher, clock });
  const passed = await completeReview(queue, { decision: "pass", blockers: [], advisories: [{ fingerprint: "adv:naming", text: "consider a clearer name" }] });

  const off = apiFetcher(routesFor({}));
  const waiting = await reviewPullRequests(queue, { fetcher: off.fetcher, clock });
  assert.deepEqual(waiting.readyToMark, [{ url: PR_URL, headSha: HEAD_A, reviewItemId: passed.id }]);
  assert.deepEqual(waiting.markedReady, []);
  assert.deepEqual(off.graphqlOperations, [], "writes off: no GraphQL call");

  const on = apiFetcher(routesFor({}));
  const marked = await reviewPullRequests(queue, { fetcher: on.fetcher, clock, writes: true });
  assert.deepEqual(marked.markedReady, [{ url: PR_URL, headSha: HEAD_A, reviewItemId: passed.id }]);
  assert.deepEqual(on.graphqlOperations, [{ name: "SnowcatMarkReady", variables: { id: NODE_ID } }]);
  const origin = queue.get(originId)!;
  assert.equal("draft" in (origin.result!.artifacts[0]!.verification as Record<string, unknown>), false, "the origin's verification no longer says draft");
  const ready = queue.events(originId).find((event) => event.type === "artifact.ready")!;
  assert.equal(ready.actor, "policy:review-gate");
  assert.deepEqual(ready.payload, { url: PR_URL, headSha: HEAD_A, reviewItemId: passed.id });
  // Nothing left to do: the pull request is no longer a draft candidate.
  const done = await reviewPullRequests(queue, { fetcher: apiFetcher(routesFor({ draft: false })).fetcher, clock, writes: true });
  assert.deepEqual(done, { inspected: 0, enqueued: [], markedReady: [], readyToMark: [], needsHuman: [], skipped: [], unavailable: [], unreported: [], unreportedPending: [] });
  // A refused mutation is reported, not hidden, and the origin is untouched.
  const queue2 = await newQueue("review-pass-refused");
  const origin2 = completedWithDraftPr(queue2);
  queue2.setRepositoryReviewGate(REPOSITORY, true);
  await reviewPullRequests(queue2, { fetcher: apiFetcher(routesFor({})).fetcher, clock });
  await completeReview(queue2, { decision: "pass", blockers: [], advisories: [] });
  const refused = await reviewPullRequests(queue2, { fetcher: apiFetcher(routesFor({ markReady: { errors: [{ message: "Resource not accessible by integration" }] } })).fetcher, clock, writes: true });
  assert.equal(refused.unavailable[0]?.url, PR_URL);
  assert.match(refused.unavailable[0]!.reason, /mark ready failed: GitHub GraphQL errors: Resource not accessible/);
  assert.equal(queue2.events(origin2).some((event) => event.type === "artifact.ready"), false);

  // A push between the read and the mark: the re-read sees a new head, the sweep converts back to draft and reports a human, recording nothing.
  const queue5 = await newQueue("review-pass-raced");
  const origin5 = completedWithDraftPr(queue5);
  queue5.setRepositoryReviewGate(REPOSITORY, true);
  await reviewPullRequests(queue5, { fetcher: apiFetcher(routesFor({})).fetcher, clock });
  const passed5 = await completeReview(queue5, { decision: "pass", blockers: [], advisories: [] });
  let reads = 0;
  const racing = apiFetcher(routesFor({}));
  const racingFetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === PR_PATH) {
      reads += 1;
      if (reads >= 2) return new Response(JSON.stringify(pullRequest({ head: { sha: HEAD_B }, draft: false })), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/graphql" && String(init?.body).includes("SnowcatConvertToDraft")) {
      racing.graphqlOperations.push({ name: "SnowcatConvertToDraft", variables: (JSON.parse(String(init?.body)) as { variables: unknown }).variables });
      return new Response(JSON.stringify({ data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return racing.fetcher(input, init);
  }) as typeof fetch;
  const raced = await reviewPullRequests(queue5, { fetcher: racingFetcher, clock, writes: true });
  assert.deepEqual(raced.markedReady, []);
  assert.deepEqual(raced.needsHuman, [{ url: PR_URL, headSha: HEAD_B, round: 1, reason: "head moved to bbbbbbb while being marked ready; converted back to draft" }]);
  assert.deepEqual(racing.graphqlOperations.map((operation) => operation.name), ["SnowcatMarkReady", "SnowcatConvertToDraft"]);
  assert.equal(queue5.events(origin5).some((event) => event.type === "artifact.ready"), false, "nothing recorded for a mark that was reverted");
  assert.equal(queue5.get(passed5.id)!.review!.decision, "pass");

  // unable-to-review → needs human; so does a fix that completed without moving the head.
  const queue3 = await newQueue("review-unable");
  completedWithDraftPr(queue3);
  queue3.setRepositoryReviewGate(REPOSITORY, true);
  await reviewPullRequests(queue3, { fetcher: apiFetcher(routesFor({})).fetcher, clock });
  await completeReview(queue3, { decision: "unable-to-review", blockers: [], advisories: [] });
  const unable = await reviewPullRequests(queue3, { fetcher: apiFetcher(routesFor({})).fetcher, clock });
  assert.deepEqual(unable.needsHuman, [{ url: PR_URL, headSha: HEAD_A, round: 1, reason: "the reviewer was unable to review" }]);

  const queue4 = await newQueue("review-fix-stuck");
  completedWithDraftPr(queue4);
  queue4.setRepositoryReviewGate(REPOSITORY, true);
  await reviewPullRequests(queue4, { fetcher: apiFetcher(routesFor({})).fetcher, clock });
  await completeReview(queue4, { decision: "block", blockers: [blocker("defect:x:y")], advisories: [] });
  await reviewPullRequests(queue4, { fetcher: apiFetcher(routesFor({})).fetcher, clock });
  completeFix(queue4);
  const stuck = await reviewPullRequests(queue4, { fetcher: apiFetcher(routesFor({})).fetcher, clock });
  assert.deepEqual(stuck.needsHuman, [{ url: PR_URL, headSha: HEAD_A, round: 1, reason: "a fix completed without a new head" }]);
});

test("enqueueReviewRoot validates kind, action ceilings, and the review record; recordPullRequestReady needs a policy actor", async () => {
  const queue = await newQueue("review-store");
  queue.setRepositoryEnabled(REPOSITORY, true);
  const head = { url: PR_URL, number: 12, headSha: HEAD_A, title: "fix(catalog): require HTTPS" };
  const review = { pullRequestUrl: PR_URL, headSha: HEAD_A, round: 1, priorBlockers: [] };
  const definition = reviewRootDefinition(REPOSITORY, head, review, "policy:review-gate");
  const make = (overrides: Record<string, unknown>) =>
    queue.enqueueReviewRoot(REPOSITORY, { ...definition, allowedActions: [...definition.allowedActions], delegableActions: [], sourceRef: `pr-review:${PR_URL}@${HEAD_A}`, review, ...overrides } as never);

  assert.throws(() => make({ kind: "issue-resolution" }), /kind pr-review or pr-review-fix/);
  assert.throws(() => make({ allowedActions: ["read", "write"] }), /pr-review allowedActions exceeds delegation ceiling: write/);
  assert.throws(() => make({ delegableActions: ["read"] }), /delegates nothing/);
  assert.throws(() => make({ review: { ...review, headSha: "abc" } }), /headSha/);
  assert.throws(() => make({ review: { ...review, round: 0 } }), /round/);
  assert.throws(() => make({ review: { ...review, pullRequestUrl: "https://example.com/x" } }), /pullRequestUrl/);
  assert.throws(() => make({ review: { ...review, patchDigest: "nope" } }), /patchDigest/);
  assert.throws(() => make({ review: { ...review, priorBlockers: [{ fingerprint: "a" }] } }), /priorBlockers blocker location is required/);
  const fixDefinition = reviewFixRootDefinition(REPOSITORY, head, { ...review, blockers: [blocker("defect:x:y")], reviewItemId: "r1" }, "policy:review-gate");
  assert.throws(
    () => queue.enqueueReviewRoot(REPOSITORY, { ...fixDefinition, allowedActions: ["read", "write"], delegableActions: [], sourceRef: `pr-review-fix:${PR_URL}@${HEAD_A}`, review: { ...review, blockers: [blocker("defect:x:y")], reviewItemId: "r1" } }),
    /exactly read, write, run-tests, open-pr/,
  );
  assert.throws(
    () => queue.enqueueReviewRoot(REPOSITORY, { ...fixDefinition, allowedActions: [...REVIEW_FIX_ACTIONS], delegableActions: [], sourceRef: `pr-review-fix:${PR_URL}@${HEAD_A}`, review: { ...review, blockers: [blocker("defect:x:y")] } }),
    /must name the review item/,
  );
  const created = make({});
  assert.ok(created);
  assert.equal(make({}), undefined, "the same sourceRef is never enqueued twice");
  assert.equal(queue.metadata().schemaVersion, 17);
  assert.throws(() => queue.enqueueReviewRoot("frostyard/lodge", { ...definition, allowedActions: [...definition.allowedActions], delegableActions: [], sourceRef: "pr-review:x@y", review }), /not opted in/);

  const originId = completedWithDraftPr(queue);
  assert.throws(() => queue.recordPullRequestReady(originId, PR_URL, "claude:worker", { headSha: HEAD_A, reviewItemId: created!.id }), /principal namespace/);
  assert.throws(() => queue.recordPullRequestReady(originId, "https://github.com/frostyard/updex/pull/99", "policy:review-gate", { headSha: HEAD_A, reviewItemId: created!.id }), /has no artifact/);
  assert.throws(() => queue.recordPullRequestReady(created!.id, PR_URL, "policy:review-gate", { headSha: HEAD_A, reviewItemId: created!.id }), /not completed/);
  const marked = queue.recordPullRequestReady(originId, PR_URL, "policy:review-gate", { headSha: HEAD_A, reviewItemId: created!.id });
  assert.equal("draft" in (marked.result!.artifacts[0]!.verification as Record<string, unknown>), false);
  assert.deepEqual(queue.events(originId).at(-1)?.type, "artifact.ready");

  // rename carries the gate setting.
  queue.setRepositoryReviewGate(REPOSITORY, true);
  queue.renameRepository(REPOSITORY, "frostyard/updex2", "operator:test");
  assert.equal(queue.reviewGateEnabled("frostyard/updex2"), true);
  const renamedUrl = "https://github.com/frostyard/updex2/pull/12";
  assert.equal(queue.pullRequestReviewItems("frostyard/updex2", renamedUrl).length, 1);
  assert.doesNotThrow(() =>
    queue.recordPullRequestReady(originId, renamedUrl, "policy:review-gate", {
      headSha: HEAD_A,
      reviewItemId: created!.id,
    }),
  );
});

test("deriveReviewState mirrors the sweep for the board and inbox", () => {
  const base = { repository: REPOSITORY, objective: "x", instructions: "x", acceptanceCriteria: ["x"], allowedActions: [], delegableActions: [], priority: 0, createdBy: "policy:review-gate", createdAt: "2026-08-19T00:00:00.000Z", updatedAt: "2026-08-19T00:00:00.000Z", operatorNotes: [], previousResults: [] };
  const item = (overrides: Record<string, unknown>) => ({ ...base, id: String(overrides.id ?? "i"), rootId: String(overrides.id ?? "i"), kind: REVIEW_KIND, status: "completed" as const, ...overrides }) as never;
  const record = (headSha: string, round: number, decision?: "pass" | "block" | "unable-to-review") => ({ pullRequestUrl: PR_URL, headSha, round, priorBlockers: [], ...(decision ? { decision, blockers: decision === "block" ? [blocker("d:x")] : [], advisories: [] } : {}) });

  assert.equal(deriveReviewState([], HEAD_A, true), undefined);
  assert.deepEqual(deriveReviewState([item({ id: "r1", status: "queued", review: record(HEAD_A, 1) })], HEAD_A, true), { itemId: "r1", kind: REVIEW_KIND, status: "queued", round: 1, headSha: HEAD_A, active: true, needsHuman: false, readyToMark: false });
  const passed = deriveReviewState([item({ id: "r1", review: record(HEAD_A, 1, "pass") })], HEAD_A, true);
  assert.equal(passed?.readyToMark, true);
  assert.equal(deriveReviewState([item({ id: "r1", review: record(HEAD_A, 1, "pass") })], HEAD_A, false)?.readyToMark, false, "already ready: nothing to mark");
  const blocked3 = deriveReviewState([item({ id: "r1", review: record(HEAD_A, 1, "block") }), item({ id: "r2", review: record(HEAD_B, 2, "block") }), item({ id: "r3", review: record(HEAD_C, 3, "block") })], HEAD_C, true);
  assert.equal(blocked3?.needsHuman, true);
  assert.match(blocked3?.reason ?? "", /blocked at round 3/);
  const exhausted = deriveReviewState([item({ id: "r1", review: record(HEAD_A, 1, "block") }), item({ id: "r2", review: record(HEAD_B, 2, "block") }), item({ id: "r3", review: record(HEAD_C, 3, "block") })], HEAD_D, true);
  assert.match(exhausted?.reason ?? "", /budget exhausted/);
  const fixing = deriveReviewState([item({ id: "r1", review: record(HEAD_A, 1, "block") }), item({ id: "f1", kind: REVIEW_FIX_KIND, status: "claimed", review: { ...record(HEAD_A, 1), reviewItemId: "r1" } })], HEAD_A, true);
  assert.deepEqual({ kind: fixing?.kind, active: fixing?.active }, { kind: REVIEW_FIX_KIND, active: true });
  const stuck = deriveReviewState([item({ id: "r1", review: record(HEAD_A, 1, "block") }), item({ id: "f1", kind: REVIEW_FIX_KIND, status: "completed", review: { ...record(HEAD_A, 1), reviewItemId: "r1" } })], HEAD_A, true);
  assert.match(stuck?.reason ?? "", /fix completed without a new head/);
  const unable = deriveReviewState([item({ id: "r1", review: record(HEAD_A, 1, "unable-to-review") })], HEAD_A, true);
  assert.equal(unable?.needsHuman, true);
  const movedBlocked = deriveReviewState([item({ id: "r1", status: "blocked", review: record(HEAD_A, 1) })], HEAD_B, true);
  assert.equal(movedBlocked?.needsHuman, true);

  // ADR-0067: a completed block verdict bound to the current head with only
  // description blockers needs a human even though no fix item exists at all.
  const descriptionOnly = deriveReviewState(
    [item({ id: "r1", review: { ...record(HEAD_A, 1, "block"), blockers: [blocker(`${DESCRIPTION_BLOCKER_PREFIX}risk-tier`)] } })],
    HEAD_A,
    true,
  );
  assert.equal(descriptionOnly?.needsHuman, true);
  assert.match(descriptionOnly?.reason ?? "", /description blocker/);
  // A mixed verdict's tree fix can be actively in flight while the
  // description blocker still needs a human alongside it.
  const mixedInFlight = deriveReviewState(
    [
      item({ id: "r1", review: { ...record(HEAD_A, 1, "block"), blockers: [blocker("defect:x"), blocker(`${DESCRIPTION_BLOCKER_PREFIX}risk-tier`)] } }),
      item({ id: "f1", kind: REVIEW_FIX_KIND, status: "queued", review: { ...record(HEAD_A, 1), reviewItemId: "r1" } }),
    ],
    HEAD_A,
    true,
  );
  assert.equal(mixedInFlight?.active, true, "the tree fix is in flight");
  assert.equal(mixedInFlight?.needsHuman, true, "the description blocker still needs a human");
  assert.match(mixedInFlight?.reason ?? "", /description blocker/);
});

test("the sweep reports, persists, and clears open pull requests no item reported in a gated repository (ADR-0065)", async () => {
  const queue = await newQueue("review-unreported");
  completedWithDraftPr(queue); // reports PR #12
  queue.setRepositoryReviewGate(REPOSITORY, true);
  queue.setRepositoryEnabled("frostyard/other", true); // opted in, gate off

  // #88 is bound to a pr-review round and to nothing else: the gate already
  // sees it, so it is not unreported either.
  const boundUrl = "https://github.com/frostyard/updex/pull/88";
  const bound = queue.enqueueReviewRoot(REPOSITORY, {
    kind: REVIEW_KIND,
    objective: "Review frostyard/updex#88 (head bbbbbbb, round 1 of 3)",
    instructions: "Read-only.",
    acceptanceCriteria: ["Verdict supplied."],
    allowedActions: [...REVIEW_ACTIONS],
    delegableActions: [],
    executionTarget: "read-only",
    createdBy: "policy:review-gate",
    sourceRef: `${REVIEW_KIND}:${boundUrl}@${HEAD_B}`,
    review: { pullRequestUrl: boundUrl, headSha: HEAD_B, round: 1, priorBlockers: [] },
  });
  assert.ok(bound);

  const pendingUrl = "https://github.com/frostyard/updex/pull/78";
  const listing = [
    listed(12, true, "2026-08-18T00:00:00.000Z"),
    listed(88, false),
    listed(77, true, "2026-08-19T09:00:00.000Z"),
    listed(78, true, "2026-08-19T14:30:00.000Z"),
  ];
  const api = apiFetcher(routesFor({ listing }));
  const swept = await reviewPullRequests(queue, { fetcher: api.fetcher, clock });

  const orphan = "https://github.com/frostyard/updex/pull/77";
  assert.deepEqual(swept.unreported, [{ url: orphan, number: 77, draft: true, createdAt: "2026-08-19T09:00:00.000Z" }]);
  assert.deepEqual(swept.unreportedPending, [
    { url: pendingUrl, number: 78, createdAt: "2026-08-19T14:30:00.000Z" },
  ]);
  assert.ok(api.requests.includes(LISTING_PATH), "the gated repository's open pull requests are listed");
  assert.equal(
    api.requests.some((path) => path.startsWith("/repos/frostyard/other")),
    false,
    "a repository without the gate is never listed",
  );

  // Nothing was created for it: no item anywhere is bound to the orphan.
  assert.deepEqual(
    swept.enqueued.filter((entry) => entry.url === orphan),
    [],
  );
  assert.deepEqual(queue.pullRequestReviewItems(REPOSITORY, orphan), []);
  assert.deepEqual(queue.knownPullRequestUrls(REPOSITORY).includes(orphan.toLowerCase()), false);

  // It is persisted, so the surface can show it without calling GitHub.
  assert.deepEqual(queue.repositoryUnreportedPullRequests(REPOSITORY), {
    observedAt: clock().toISOString(),
    pullRequests: [{ url: orphan, number: 77, draft: true, createdAt: "2026-08-19T09:00:00.000Z" }],
  });
  assert.equal(queue.repositoryUnreportedPullRequests("frostyard/other"), undefined, "a repository the sweep never observed has no observation");

  assert.equal(
    [...swept.unreported, ...swept.unreportedPending].some((pull) => pull.number === 12),
    false,
    "an item-reported pull request is in neither list",
  );

  // At 61 minutes the same pull request is no longer protected by the longest possible lease.
  const expired = await reviewPullRequests(queue, {
    fetcher: apiFetcher(routesFor({ listing: [listed(12, true), listed(88, false), listed(78, true, "2026-08-19T14:30:00.000Z")] })).fetcher,
    clock: () => new Date("2026-08-19T15:31:00.000Z"),
  });
  assert.deepEqual(expired.unreportedPending, []);
  assert.deepEqual(expired.unreported, [
    { url: pendingUrl, number: 78, draft: true, createdAt: "2026-08-19T14:30:00.000Z" },
  ]);
  assert.deepEqual(queue.repositoryUnreportedPullRequests(REPOSITORY)?.pullRequests, expired.unreported);

  // The orphan is closed (or attached): the next pass overwrites the finding with an empty list.
  const cleared = await reviewPullRequests(queue, { fetcher: apiFetcher(routesFor({ listing: [listed(12, true), listed(88, false)] })).fetcher, clock });
  assert.deepEqual(cleared.unreported, []);
  assert.deepEqual(cleared.unreportedPending, []);
  assert.deepEqual(queue.repositoryUnreportedPullRequests(REPOSITORY), { observedAt: clock().toISOString(), pullRequests: [] });

  assert.throws(
    () => queue.recordUnreportedPullRequests(REPOSITORY, { observedAt: clock().toISOString(), pullRequests: [] }, "claude:worker"),
    /principal namespace/,
    "only policy and operator actors record the observation",
  );
});

test("a still-claimed item's own draft pull request stays unreportedPending past the age grace period while its lease is heartbeat-renewed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-review-unreported-live-lease-"));
  let now = new Date("2026-08-19T15:00:00.000Z");
  const queue = new QueueStore(join(directory, "queue.db"), () => now);
  queue.setRepositoryEnabled(REPOSITORY, true);
  queue.setRepositoryReviewGate(REPOSITORY, true);

  // The item opened its own draft pull request but has not completed (and so
  // cannot yet report it as an artifact via knownPullRequestUrls); it is
  // still claimed, with its lease renewed well past the PR's creation time.
  queue.enqueueSeed({
    repository: REPOSITORY,
    kind: "issue-resolution",
    objective: "Resolve #9: a long-running fix",
    instructions: "Open a PR.",
    acceptanceCriteria: ["PR open.", "make check passes."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    requiredArtifact: "pull-request",
    executionTarget: "new-pull-request",
    priority: 5,
    createdBy: "operator:test",
  });
  const claimed = queue.claim({ worker: "claude:author", kinds: ["issue-resolution"], leaseSeconds: 3600 });
  assert.ok(claimed, "the issue-resolution item is claimable");

  now = new Date("2026-08-19T15:50:00.000Z");
  queue.heartbeat(claimed!.id, claimed!.leaseToken!, "claude:author", 3600);

  const ownUrl = "https://github.com/frostyard/updex/pull/91";
  const swept = await reviewPullRequests(queue, {
    fetcher: apiFetcher(routesFor({ listing: [listed(91, true, "2026-08-19T15:00:00.000Z")] })).fetcher,
    // 65 minutes after the pull request opened: past the 61-minute cutoff the
    // age-only grace period uses, but the lease above is renewed to 16:50.
    clock: () => new Date("2026-08-19T16:05:00.000Z"),
  });

  assert.deepEqual(swept.unreported, [], "the still-claimed item's own PR is not reported as an orphan");
  assert.deepEqual(swept.unreportedPending, [{ url: ownUrl, number: 91, createdAt: "2026-08-19T15:00:00.000Z" }]);

  // Once the item completes (and the lease is gone), the age cutoff alone governs again.
  queue.complete({
    id: claimed!.id,
    leaseToken: claimed!.leaseToken!,
    worker: "claude:author",
    result: { summary: "Opened the PR as a draft.", evidence: ["make check"], artifacts: [{ kind: "pull-request", url: ownUrl, verification: { status: "verified", verifiedAt: now.toISOString(), number: 91, state: "open", headSha: HEAD_A, draft: true } }] },
    followUps: [],
  });
  const afterCompletion = await reviewPullRequests(queue, {
    fetcher: apiFetcher(routesFor({ listing: [listed(91, true, "2026-08-19T15:00:00.000Z")] })).fetcher,
    clock: () => new Date("2026-08-19T16:05:00.000Z"),
  });
  assert.deepEqual(afterCompletion.unreported, [], "the completed item's artifact now accounts for the PR directly");
  assert.deepEqual(afterCompletion.unreportedPending, []);
});

test("the unreported listing is bounded: more than three pages is reported truncated, and duplicates collapse", async () => {
  const queue = await newQueue("review-unreported-truncated");
  completedWithDraftPr(queue);
  queue.setRepositoryReviewGate(REPOSITORY, true);
  // Every page is full, so the listing is truncated after MAX_LISTING_PAGES ×
  // 100; the same page answers each request, so the same URLs repeat.
  const page = Array.from({ length: 100 }, (_, index) => listed(1000 + index, index % 2 === 0));
  const swept = await reviewPullRequests(queue, { fetcher: apiFetcher(routesFor({ listing: page })).fetcher, clock });
  assert.deepEqual(swept.skipped, [{ url: `https://github.com/${REPOSITORY}/pulls`, reason: "more than 300 open pull requests; the rest were not listed" }]);
  assert.equal(swept.unreported.length, 100, "300 listed entries, 100 distinct pull requests");
  assert.deepEqual(swept.unreportedPending, []);
  assert.equal(new Set(swept.unreported.map((pull) => pull.url)).size, 100);
  assert.equal(queue.repositoryUnreportedPullRequests(REPOSITORY)?.pullRequests.length, 100);
});

test("ADR-0071: a block on only already-adjudicated description blockers takes the pass consequence, round three included", async () => {
  const queue = await newQueue("review-outstanding-description");
  completedWithDraftPr(queue);
  queue.setRepositoryReviewGate(REPOSITORY, true);
  const sweep = (head: string) => reviewPullRequests(queue, { fetcher: apiFetcher(routesFor({ head })).fetcher, clock });
  const description = blocker(`${DESCRIPTION_BLOCKER_PREFIX}missing-risk-classification`, { location: "pull request description" });

  await sweep(HEAD_A);
  await completeReview(queue, { decision: "block", blockers: [blocker("defect:catalog/repo.go:import"), description], advisories: [] });
  const fix1 = await sweep(HEAD_A);
  assert.equal(fix1.enqueued[0]?.kind, REVIEW_FIX_KIND);
  completeFix(queue);

  await sweep(HEAD_B);
  await completeReview(queue, { decision: "block", blockers: [blocker("defect:catalog/repo.go:nil-check"), description], advisories: [] });
  const fix2 = await sweep(HEAD_B);
  assert.equal(fix2.enqueued[0]?.kind, REVIEW_FIX_KIND);
  completeFix(queue);

  await sweep(HEAD_C);
  const round3 = await completeReview(queue, { decision: "block", blockers: [description], advisories: [] });
  const swept = await sweep(HEAD_C);
  // Tree clean and the one blocker already with a human since round 1:
  // the pass consequence, evaluated before the round budget — never
  // "blocked at round 3" over a clean tree.
  assert.deepEqual(swept.enqueued, []);
  assert.deepEqual(swept.readyToMark, [{ url: PR_URL, headSha: HEAD_C, reviewItemId: round3.id }]);
  assert.equal(swept.needsHuman.length, 1, "the description blocker still rides to adjudication");
  assert.match(swept.needsHuman[0]!.reason, /description blocker/);
  assert.doesNotMatch(swept.needsHuman[0]!.reason, /blocked at round 3/);

  // The board mirrors the sweep: ready to mark, the adjudication note alongside.
  const state = deriveReviewState(queue.pullRequestReviewItems(REPOSITORY, PR_URL), HEAD_C, true);
  assert.equal(state?.readyToMark, true);
  assert.equal(state?.needsHuman, true, "the outstanding description blocker stays visible");
  assert.match(state?.reason ?? "", /description blocker/);

  // Idempotent while the head stays a draft.
  const again = await sweep(HEAD_C);
  assert.deepEqual(again.enqueued, []);
  assert.equal(again.readyToMark.length, 1);
});

test("ADR-0071: a description blocker raised for the first time still blocks — only prior-round fingerprints pass", async () => {
  const queue = await newQueue("review-new-description");
  completedWithDraftPr(queue);
  queue.setRepositoryReviewGate(REPOSITORY, true);
  const sweep = (head: string) => reviewPullRequests(queue, { fetcher: apiFetcher(routesFor({ head })).fetcher, clock });

  await sweep(HEAD_A);
  await completeReview(queue, {
    decision: "block",
    blockers: [blocker("defect:catalog/repo.go:import"), blocker(`${DESCRIPTION_BLOCKER_PREFIX}risk-tier`, { location: "pull request description" })],
    advisories: [],
  });
  const fix1 = await sweep(HEAD_A);
  assert.equal(fix1.enqueued[0]?.kind, REVIEW_FIX_KIND);
  completeFix(queue);

  await sweep(HEAD_B);
  // Round 2 blocks on a DIFFERENT description defect: a new finding, not an
  // outstanding one — no pass, no fix, straight to adjudication.
  await completeReview(queue, {
    decision: "block",
    blockers: [blocker(`${DESCRIPTION_BLOCKER_PREFIX}evidence-missing`, { location: "pull request description" })],
    advisories: [],
  });
  const swept = await sweep(HEAD_B);
  assert.deepEqual(swept.readyToMark, []);
  assert.deepEqual(swept.markedReady, []);
  assert.deepEqual(swept.enqueued, [], "a description-only verdict still mints no fix");
  assert.equal(swept.needsHuman.length, 1);
  const state = deriveReviewState(queue.pullRequestReviewItems(REPOSITORY, PR_URL), HEAD_B, true);
  assert.equal(state?.readyToMark, false);
  assert.equal(state?.needsHuman, true);
});

test("ADR-0074: a pass whose delivered diff touches a protected boundary goes to a human; a clean diff still marks ready; unreadable files fail closed", async () => {
  const boundaryAuthority: PolicyAuthority = {
    coreSnapshotId: "sha256:" + "a".repeat(64),
    repositoryCommitId: "b".repeat(40),
    actionCeiling: ["read", "write", "run-tests", "open-issue", "open-pr", "create-followup"],
    defaultDecision: "deny",
    actionDecisions: { read: "allow", write: "allow", "run-tests": "allow", "open-issue": "review-required", "open-pr": "review-required", "create-followup": "review-required" },
    protectedBoundaries: [{ id: "workflow-and-permissions", decision: "review-required", minimumRiskTier: "high", paths: [".github/workflows/**"] }],
  };
  const queue = await newQueue("review-boundary", { policyAuthority: () => boundaryAuthority });
  completedWithDraftPr(queue);
  queue.setRepositoryReviewGate(REPOSITORY, true);

  // The minted round carries the boundary in its reviewer instructions.
  const routes = routesFor({ head: HEAD_A });
  const minted = await reviewPullRequests(queue, { fetcher: apiFetcher(routes).fetcher, clock });
  assert.equal(minted.enqueued.length, 1);
  const round = queue.get(minted.enqueued[0]!.id)!;
  assert.match(round.instructions, /Protected boundaries \(ADR-0074\)/);
  assert.match(round.instructions, /workflow-and-permissions: \.github\/workflows\/\*\* — review-required at minimum tier high/);

  // A pass over a diff that touches the boundary is a human's to mark ready.
  await completeReview(queue, { decision: "pass", blockers: [], advisories: [] });
  const touchedRoutes = routesFor({ head: HEAD_A });
  (touchedRoutes as Record<string, unknown>)[`${PR_PATH}/files`] = [FILE_V1, { filename: ".github/workflows/check.yml", status: "modified", additions: 1, deletions: 1, patch: "+x" }];
  const swept = await reviewPullRequests(queue, { fetcher: apiFetcher(touchedRoutes).fetcher, clock });
  assert.deepEqual(swept.readyToMark, []);
  assert.deepEqual(swept.markedReady, []);
  assert.equal(swept.needsHuman.length, 1);
  assert.match(swept.needsHuman[0]!.reason, /protected boundary workflow-and-permissions \(minimum tier high\)/);
  assert.match(swept.needsHuman[0]!.reason, /ADR-0074/);

  // A clean diff still takes the ordinary pass consequence.
  const clean = await reviewPullRequests(queue, { fetcher: apiFetcher(routesFor({ head: HEAD_A })).fetcher, clock });
  assert.equal(clean.readyToMark.length, 1);

  // Files unreadable: fail closed as unavailable, mark nothing.
  const broken = routesFor({ head: HEAD_A });
  delete (broken as Record<string, unknown>)[`${PR_PATH}/files`];
  const failed = await reviewPullRequests(queue, { fetcher: apiFetcher(broken).fetcher, clock });
  assert.deepEqual(failed.readyToMark, []);
  assert.equal(failed.unavailable.length, 1);
  assert.match(failed.unavailable[0]!.reason, /protected boundaries could not be checked/);
});

test("complete_work accepts a pr-review that omits result.artifacts and followUps, and its served schema does not require them (#242)", async () => {
  const queue = await newQueue("review-complete-omits-arrays");
  completedWithDraftPr(queue);
  queue.setRepositoryReviewGate(REPOSITORY, true);
  await reviewPullRequests(queue, { fetcher: apiFetcher(routesFor({})).fetcher, clock });
  const claimed = queue.claim({ worker: "claude:reviewer", kinds: [REVIEW_KIND] })!;
  assert.equal(claimed.kind, REVIEW_KIND);

  const server = buildQueueMcpServer(":memory:", { fetcher: apiFetcher(routesFor({})).fetcher, clock }, {}, undefined, queue);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "strict-reviewer-test", version: "0.1.0" });
  await client.connect(clientTransport);
  try {
    // A strict client validates against tools/list before calling: neither key may be required.
    const tool = (await client.listTools()).tools.find((t) => t.name === "complete_work")!;
    const schema = tool.inputSchema as unknown as { required?: string[]; properties: { result: { required?: string[] } } };
    assert.ok(!(schema.required ?? []).includes("followUps"), "followUps is optional at the top level");
    assert.ok(!(schema.properties.result.required ?? []).includes("artifacts"), "result.artifacts is optional");

    const answer = await client.callTool({
      name: "complete_work",
      arguments: {
        id: claimed.id,
        leaseToken: claimed.leaseToken,
        worker: "claude:reviewer",
        result: { summary: `Reviewed round ${claimed.review!.round}.`, evidence: [`head ${claimed.review!.headSha}`], model: "gpt-5.6-sol" },
        review: { decision: "pass", blockers: [], advisories: [] },
      },
    });
    assert.equal(answer.isError ?? false, false, JSON.stringify(answer.content));
  } finally {
    await client.close();
    await server.close();
  }
  const done = queue.get(claimed.id)!;
  assert.equal(done.status, "completed");
  assert.deepEqual(done.result?.artifacts, [], "an omitted artifacts list is stored as an empty array");
  assert.equal(done.review?.decision, "pass");
  assert.deepEqual(queue.children(claimed.id), [], "an omitted followUps list creates no children");
});

test("a merged pull request keeps its last verdict on the board but never needs a human (settleReviewState)", async () => {
  const queue = await newQueue("review-settled-on-merge");
  completedWithDraftPr(queue);
  queue.setRepositoryReviewGate(REPOSITORY, true);
  await reviewPullRequests(queue, { fetcher: apiFetcher(routesFor({})).fetcher, clock });
  const descriptionBlocker = blocker(`${DESCRIPTION_BLOCKER_PREFIX}risk-tier-missing`, { location: "pull request description" });
  await completeReview(queue, { decision: "block", blockers: [descriptionBlocker], advisories: [] });

  const open = deriveReviewState(queue.pullRequestReviewItems(REPOSITORY, PR_URL), HEAD_A, true);
  assert.equal(open?.needsHuman, true, "while open, the description blocker needs a human");
  const settled = settleReviewState(open);
  assert.deepEqual({ needsHuman: settled?.needsHuman, readyToMark: settled?.readyToMark, active: settled?.active, reason: settled?.reason }, { needsHuman: false, readyToMark: false, active: false, reason: undefined });
  assert.equal(settled?.decision, "block", "the historical verdict stays");
  assert.equal(settled?.round, open?.round);

  // Board: once the artifact verifies as merged, the row carries the verdict without any human flag.
  await refreshArtifactVerifications(queue, { fetcher: apiFetcher(routesFor({ state: "closed", merged: true })).fetcher, clock });
  const board = readPullRequests(queue, REPOSITORY, clock());
  const row = board.merged.find((candidate) => candidate.url === PR_URL);
  assert.ok(row, "the pull request moved to the merged list");
  assert.equal(row.review?.decision, "block");
  assert.equal(row.review?.needsHuman, false, "a merged pull request is never adjudication");
  assert.equal(row.review?.readyToMark, false);
  assert.equal(board.open.some((candidate) => candidate.url === PR_URL), false);
});
