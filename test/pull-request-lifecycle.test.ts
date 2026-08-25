import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cureRootDefinition } from "../src/queue/pull-request-cure.ts";
import {
  assertPullRequestBoundRequeueable,
  PULL_REQUEST_BOUND_KINDS,
  pullRequestBindingOf,
  retireMergedOrClosedPullRequestBoundWork,
} from "../src/queue/pull-request-lifecycle.ts";
import { reviewRootDefinition } from "../src/queue/pull-request-review.ts";
import { QueueStore } from "../src/queue/store.ts";
import type { PullRequestReview } from "../src/queue/types.ts";

const REPOSITORY = "frostyard/updex";
const CURE_PR_URL = "https://github.com/frostyard/updex/pull/12";
const CURE_PR_PATH = "/repos/frostyard/updex/pulls/12";
const REVIEW_PR_URL = "https://github.com/frostyard/updex/pull/34";
const REVIEW_PR_PATH = "/repos/frostyard/updex/pulls/34";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const clock = () => new Date("2026-08-25T00:00:00.000Z");
process.env.SNOWCAT_GITHUB_TOKEN = "test-token";

async function newQueue(prefix: string): Promise<QueueStore> {
  const directory = await mkdtemp(join(tmpdir(), `snowcat-${prefix}-`));
  const queue = new QueueStore(join(directory, "queue.db"), clock);
  test.after(() => queue.close());
  return queue;
}

/** Answers `GET /pulls/N` by pathname; each route's state, merge flag, and head are given explicitly. */
function apiFetcher(routes: Record<string, { state: "open" | "closed"; merged?: boolean; head?: string }>) {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url.pathname);
    const entry = routes[url.pathname];
    if (!entry) return new Response("{}", { status: 404 });
    const segments = url.pathname.split("/");
    const number = Number(segments.at(-1));
    const [, , owner, name] = segments;
    return new Response(
      JSON.stringify({
        number,
        state: entry.state,
        merged: entry.merged ?? false,
        head: { sha: entry.head ?? HEAD_A },
        base: { repo: { full_name: `${owner}/${name}` } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetcher, requests };
}

/** An admitted, queued `pr-cure` root bound to one pull request, built directly (no GitHub round-trip needed to create it). */
function seedCureItem(queue: QueueStore, options: { url?: string; headSha?: string } = {}): string {
  queue.setRepositoryEnabled(REPOSITORY, true);
  const url = options.url ?? CURE_PR_URL;
  const headSha = options.headSha ?? HEAD_A;
  const created = queue.enqueueCureRoot(REPOSITORY, {
    ...cureRootDefinition(
      REPOSITORY,
      { url, number: 12, headSha, decay: ["behind"], failingChecks: [], mergeableState: "behind", unresolvedThreads: 0, title: "fix: require HTTPS" },
      "policy:cure-gate",
    ),
    priority: 0,
    sourceRef: `${url}@${headSha}`,
    cure: { pullRequestUrl: url, headSha, patchDigest: `sha256:${"d".repeat(64)}`, decay: ["behind"] },
  });
  assert.ok(created, "the cure root admits");
  return created!.id;
}

/** An admitted, queued `pr-review` root bound to one pull request, built directly. */
function seedReviewItem(queue: QueueStore, options: { url?: string; headSha?: string } = {}): string {
  queue.setRepositoryEnabled(REPOSITORY, true);
  const url = options.url ?? REVIEW_PR_URL;
  const headSha = options.headSha ?? HEAD_B;
  const review: PullRequestReview = { pullRequestUrl: url, headSha, round: 1, priorBlockers: [] };
  const created = queue.enqueueReviewRoot(REPOSITORY, {
    ...reviewRootDefinition(REPOSITORY, { url, number: 34, headSha, title: "fix: paginate the catalog" }, review, "policy:review-gate"),
    priority: 0,
    sourceRef: `pr-review:${url}@${headSha}`,
    review,
  });
  assert.ok(created, "the review root admits");
  return created!.id;
}

test("PULL_REQUEST_BOUND_KINDS and pullRequestBindingOf name exactly the four PR-bound kinds and their binding records", async () => {
  assert.deepEqual([...PULL_REQUEST_BOUND_KINDS].sort(), ["pr-cure", "pr-cure-change", "pr-review", "pr-review-fix"]);

  const queue = await newQueue("lifecycle-binding");
  const cureId = seedCureItem(queue);
  const reviewId = seedReviewItem(queue);
  assert.deepEqual(pullRequestBindingOf(queue.get(cureId)!), { url: CURE_PR_URL, headSha: HEAD_A });
  assert.deepEqual(pullRequestBindingOf(queue.get(reviewId)!), { url: REVIEW_PR_URL, headSha: HEAD_B });

  const plain = queue.enqueueSeed({
    repository: REPOSITORY,
    kind: "testing-gap-discovery",
    objective: "Identify one testing gap.",
    instructions: "Read only.",
    acceptanceCriteria: ["One gap."],
    allowedActions: ["read"],
    delegableActions: [],
    executionTarget: "read-only",
    createdBy: "operator:test",
  });
  assert.equal(pullRequestBindingOf(queue.get(plain.id)!), undefined);
});

test("the sweep retires a queued pr-cure root and a queued pr-review root once their pull requests merge or close, and leaves an open one alone", async () => {
  const queue = await newQueue("lifecycle-sweep");
  const cureId = seedCureItem(queue);
  const reviewId = seedReviewItem(queue);
  const openId = seedCureItem(queue, { url: "https://github.com/frostyard/updex/pull/99", headSha: "c".repeat(40) });

  const first = await retireMergedOrClosedPullRequestBoundWork(queue, {
    fetcher: apiFetcher({
      [CURE_PR_PATH]: { state: "closed", merged: true, head: HEAD_A },
      [REVIEW_PR_PATH]: { state: "open", head: HEAD_B },
      "/repos/frostyard/updex/pulls/99": { state: "open", head: "c".repeat(40) },
    }).fetcher,
  });
  assert.equal(first.inspected, 3);
  assert.deepEqual(
    first.retired.map((entry) => [entry.id, entry.state]),
    [[cureId, "merged"]],
  );
  assert.equal(queue.get(cureId)!.status, "cancelled");
  assert.equal(queue.get(cureId)!.result!.summary, `pull request ${CURE_PR_URL} is merged; nothing can be delivered on it`);
  assert.equal(queue.events(cureId).at(-1)!.type, "work.cancelled");
  assert.equal(queue.events(cureId).at(-1)!.actor, "policy:pull-request-lifecycle");
  assert.equal(queue.get(reviewId)!.status, "queued");
  assert.equal(queue.get(openId)!.status, "queued");

  // Second pass: the review's pull request has since closed too; the already-cancelled cure item and the still-open one are untouched.
  const second = await retireMergedOrClosedPullRequestBoundWork(queue, {
    fetcher: apiFetcher({
      [REVIEW_PR_PATH]: { state: "closed", merged: false, head: HEAD_B },
      "/repos/frostyard/updex/pulls/99": { state: "open", head: "c".repeat(40) },
    }).fetcher,
  });
  assert.deepEqual(
    second.retired.map((entry) => [entry.id, entry.state]),
    [[reviewId, "closed"]],
  );
  assert.equal(queue.get(reviewId)!.status, "cancelled");
  assert.equal(queue.get(openId)!.status, "queued");

  // Third pass: nothing left to inspect (both retired items are no longer queued or blocked; the open one is still open).
  const third = await retireMergedOrClosedPullRequestBoundWork(queue, {
    fetcher: apiFetcher({ "/repos/frostyard/updex/pulls/99": { state: "open", head: "c".repeat(40) } }).fetcher,
  });
  assert.equal(third.inspected, 1);
  assert.deepEqual(third.retired, []);
});

test("the sweep does not retire on an unavailable GitHub answer, and reports it instead", async () => {
  const queue = await newQueue("lifecycle-unavailable");
  const cureId = seedCureItem(queue);
  const swept = await retireMergedOrClosedPullRequestBoundWork(queue, { fetcher: apiFetcher({}).fetcher });
  assert.equal(swept.inspected, 1);
  assert.deepEqual(swept.retired, []);
  assert.equal(swept.unavailable.length, 1);
  assert.equal(swept.unavailable[0]!.url, CURE_PR_URL);
  assert.equal(queue.get(cureId)!.status, "queued");
});

test("assertPullRequestBoundRequeueable refuses a merged or closed PR-bound item, passes a non-PR-bound item through untouched, and does not block on an unavailable GitHub answer", async () => {
  const queue = await newQueue("lifecycle-requeue-guard");
  const cureId = seedCureItem(queue);
  const cureItem = queue.get(cureId)!;

  await assert.rejects(
    assertPullRequestBoundRequeueable(cureItem, { fetcher: apiFetcher({ [CURE_PR_PATH]: { state: "closed", merged: true, head: HEAD_A } }).fetcher }),
    /pull request https:\/\/github\.com\/frostyard\/updex\/pull\/12 is merged; nothing can be delivered on it, so it cannot be requeued/,
  );
  await assert.rejects(
    assertPullRequestBoundRequeueable(cureItem, { fetcher: apiFetcher({ [CURE_PR_PATH]: { state: "closed", merged: false, head: HEAD_A } }).fetcher }),
    /is closed/,
  );
  // Open: passes through without throwing.
  await assertPullRequestBoundRequeueable(cureItem, { fetcher: apiFetcher({ [CURE_PR_PATH]: { state: "open", head: HEAD_A } }).fetcher });

  // GitHub outage: not evidence of merge or close, so an operator recovering from a flaky check is not stuck.
  await assertPullRequestBoundRequeueable(cureItem, { fetcher: apiFetcher({}).fetcher });

  // A non-PR-bound item makes no GitHub call at all.
  const plain = queue.enqueueSeed({
    repository: REPOSITORY,
    kind: "testing-gap-discovery",
    objective: "Identify one testing gap.",
    instructions: "Read only.",
    acceptanceCriteria: ["One gap."],
    allowedActions: ["read"],
    delegableActions: [],
    executionTarget: "read-only",
    createdBy: "operator:test",
  });
  const { fetcher, requests } = apiFetcher({});
  await assertPullRequestBoundRequeueable(queue.get(plain.id)!, { fetcher });
  assert.deepEqual(requests, []);
});
