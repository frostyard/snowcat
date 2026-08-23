import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.ts";
import { QueueStore } from "../src/queue/store.ts";
import type { ObservableWorkItem, SeedWorkInput, WorkArtifact } from "../src/queue/types.ts";
import {
  deriveProgressRow,
  progressSummaryBuckets,
  readProgress,
  type ProgressSummaryBucket,
} from "../src/surface/progress-state.ts";
import { sessionDigest } from "../src/surface/session.ts";

const TOKEN = "progress-test-token";
const REPOSITORY = "frostyard/example";
/**
 * The `/progress` route reads the real clock, so a fixture pinned to a literal
 * instant would decide lease activity and the seven-day age-out against
 * whenever the suite happens to run. Anchoring the fixture to the run instant
 * keeps a one-hour lease in the future and an "old" item old, forever.
 */
const NOW = new Date();
const LONG_AGO = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);

test("progress derivation marks closed and third-round review stops, and no longer badges a cancelled primary", () => {
  const closed = item({
    status: "completed",
    delivery: "closed",
    result: resultWithPullRequest("closed"),
  });
  const closedRow = deriveProgressRow(closed, [], false, NOW);
  assert.equal(closedRow.stage, "awaiting-merge");
  assert.deepEqual(closedRow.badge, { label: "closed", reason: "PR closed without merge", tone: "red" });

  // A cancelled primary is a terminal operator decision: no badge pins it into
  // the attention group (and `readProgress` drops it from the page outright).
  const cancelledRow = deriveProgressRow(item({ status: "cancelled" }), [], false, NOW);
  assert.equal(cancelledRow.badge, undefined);

  const origin = item({
    status: "completed",
    delivery: "open",
    result: resultWithPullRequest("open"),
  });
  const review = item({
    id: "review-round-three",
    kind: "pr-review",
    status: "completed",
    review: {
      pullRequestUrl: "https://github.com/frostyard/example/pull/7",
      headSha: "a".repeat(40),
      round: 3,
      originItemId: origin.id,
      priorBlockers: [],
      decision: "block",
      blockers: [],
      advisories: [],
      reviewedAt: NOW.toISOString(),
    },
  });
  const reviewRow = deriveProgressRow(origin, [review], true, NOW);
  assert.equal(reviewRow.stage, "review");
  assert.equal(reviewRow.reviewRound, 3);
  assert.deepEqual(reviewRow.badge, {
    label: "human decision",
    reason: "needs human review decision",
    tone: "amber",
  });
});

test("progress renders ledger-derived stage entry times and the current-stage duration", async (t) => {
  const at = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);
  let clock = at(6.5);
  const queue = new QueueStore(":memory:", () => clock);
  t.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);
  queue.setRepositoryReviewGate(REPOSITORY, true);

  const [origin] = queue.enqueueProposedRoots(REPOSITORY, [
    {
      ...definition("Known event history", "timeline-implementation"),
      sourceRef: "https://github.com/frostyard/example/issues/139",
    },
  ]).created;
  assert.ok(origin);
  clock = at(5.5);
  queue.approve(origin.id, "operator:test");
  clock = at(4.5);
  const lease = queue.claim({
    worker: "worker:timeline",
    repository: REPOSITORY,
    kinds: [origin.kind],
    leaseSeconds: 3600,
  })!;
  clock = at(4);
  queue.heartbeat(origin.id, lease.leaseToken!, "worker:timeline", 3600);
  clock = at(3.5);
  queue.complete({
    id: origin.id,
    leaseToken: lease.leaseToken!,
    worker: "worker:timeline",
    result: {
      summary: "Done.",
      evidence: ["tests pass"],
      artifacts: [
        {
          kind: "pull-request",
          url: "https://github.com/frostyard/example/pull/139",
          verification: {
            status: "verified",
            verifiedAt: clock.toISOString(),
            number: 139,
            state: "open",
            headSha: "b".repeat(40),
            draft: true,
          },
        },
      ],
    },
    followUps: [],
  });
  clock = at(2.5);
  queue.enqueueReviewRoot(REPOSITORY, {
    kind: "pr-review",
    objective: "Review known event history",
    instructions: "Review.",
    acceptanceCriteria: ["Verdict."],
    allowedActions: ["read", "run-tests"],
    delegableActions: [],
    createdBy: "policy:review-gate",
    sourceRef: `pr-review:https://github.com/frostyard/example/pull/139@${"b".repeat(40)}`,
    review: {
      pullRequestUrl: "https://github.com/frostyard/example/pull/139",
      headSha: "b".repeat(40),
      round: 1,
      originItemId: origin.id,
      priorBlockers: [],
    },
  });

  const data = readProgress(queue, NOW)!;
  const row = data.repositories.flatMap((group) => group.rows).find((candidate) => candidate.item?.id === origin.id);
  assert.ok(row);
  assert.deepEqual(row.enteredAt, {
    "awaiting-import": at(6.5).toISOString(),
    proposed: at(6.5).toISOString(),
    queued: at(5.5).toISOString(),
    working: at(4.5).toISOString(),
    "pr-open": at(3.5).toISOString(),
    review: at(2.5).toISOString(),
  });

  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue }) });
  const response = await app.request("/progress", {
    headers: { Cookie: `snowcat_session=${sessionDigest(TOKEN)}` },
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  for (const enteredAt of Object.values(row.enteredAt)) {
    assert.match(body, new RegExp(`title="Entered at ${enteredAt}"`));
  }
  assert.match(body, /round 1\/3 · in this stage for 2 hours 30 minutes/);
});

test("the session-guarded progress page renders every stage, folds review satellites, pins attention, and ages out old terminals", async () => {
  let clock = LONG_AGO;
  const queue = new QueueStore(":memory:", () => clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);
  queue.setRepositoryEnabled("frostyard/plain", true);
  queue.setRepositoryReviewGate(REPOSITORY, true);

  completeWithPullRequest(queue, REPOSITORY, "Old merged item", "merged", undefined, LONG_AGO);
  clock = NOW;
  const freshMerged = completeWithPullRequest(queue, REPOSITORY, "Fresh merged item", "merged");
  completeWithPullRequest(queue, REPOSITORY, "Waiting for GitHub", "unverified");
  completeWithPullRequest(queue, "frostyard/plain", "Ready for a human merge", "open");

  const blocked = queue.enqueueSeed(definition("Blocked implementation", "quality-implementation"));
  const blockedLease = queue.claim({ worker: "worker:blocked", repository: REPOSITORY, kinds: ["quality-implementation"] })!;
  queue.block(blocked.id, blockedLease.leaseToken!, "worker:blocked", "Needs an operator decision.");

  const working = queue.enqueueSeed(definition("Active implementation", "active-implementation"));
  const workingLease = queue.claim({
    worker: "worker:active",
    repository: REPOSITORY,
    kinds: ["active-implementation"],
    leaseSeconds: 3600,
  })!;

  const queued = queue.enqueueSeed(definition("Queued implementation", "queued-implementation"));
  const proposalBatch = queue.enqueueProposedRoots(REPOSITORY, [
    {
      ...definition("Proposed implementation", "proposed-implementation"),
      sourceRef: "https://github.com/frostyard/example/issues/20",
    },
  ]);
  const proposed = proposalBatch.created[0]!;

  const origin = completeWithPullRequest(
    queue,
    REPOSITORY,
    "Origin with folded review",
    "open",
    "https://github.com/frostyard/example/issues/21",
  );
  const review = queue.enqueueReviewRoot(REPOSITORY, {
    kind: "pr-review",
    objective: "Review satellite should not render as a row",
    instructions: "Review.",
    acceptanceCriteria: ["Verdict."],
    allowedActions: ["read", "run-tests"],
    delegableActions: [],
    createdBy: "policy:review-gate",
    sourceRef: `pr-review:https://github.com/frostyard/example/pull/7@${"a".repeat(40)}`,
    review: {
      pullRequestUrl: "https://github.com/frostyard/example/pull/7",
      headSha: "a".repeat(40),
      round: 2,
      originItemId: origin.id,
      priorBlockers: [],
    },
  })!;
  const reviewLease = queue.claim({ worker: "worker:review", repository: REPOSITORY, kinds: ["pr-review"], leaseSeconds: 3600 })!;

  queue.recordLabeledIssueObservations(
    REPOSITORY,
    [
      {
        url: "https://github.com/frostyard/example/issues/21",
        title: "Already imported issue",
        outcome: "existing",
      },
      {
        url: "https://github.com/frostyard/example/issues/22",
        title: "Still awaiting import",
        outcome: "existing",
      },
    ],
    "operator:test",
  );

  const data = readProgress(queue, NOW)!;
  assert.equal(data.total, 9);
  assert.equal(data.active, 2);
  assert.deepEqual(data.summary, {
    "awaiting-import": 1,
    proposed: 1,
    queued: 1,
    working: 1,
    "in-review": 2,
    "awaiting-merge": 1,
  });
  assert.ok(data.attention.some((row) => row.item?.id === blocked.id));
  assert.equal(data.repositories.flatMap((group) => group.rows).some((row) => row.item?.id === review.id), false);
  assert.equal(data.repositories.flatMap((group) => group.rows).some((row) => row.title === "Old merged item"), false);

  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue }) });
  const anonymous = await app.request("/progress");
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get("Location"), "/login");

  const cookie = `snowcat_session=${sessionDigest(TOKEN)}`;
  const response = await app.request("/progress", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const body = await response.text();

  for (const label of ["Awaiting import", "Proposed", "Queued", "Working", "PR open", "Review", "Awaiting merge", "Merged"]) {
    assert.match(body, new RegExp(`>${label}<`));
  }
  for (const waiting of [
    "waiting for import",
    "awaiting your admission",
    "in queue",
    "worker active",
    "waiting for validation",
    "round 2/3",
    "waiting for merge",
  ]) {
    assert.match(body, new RegExp(waiting.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const attention = section(body, "attention");
  assert.match(attention, /Blocked implementation/);
  assert.match(attention, /class="fl-progress-badge amber"[^>]*>blocked<\/span>/);
  assert.match(body, /Origin with folded review/);
  assert.equal(body.includes("Review satellite should not render as a row"), false);
  assert.match(body, /Still awaiting import/);
  assert.equal(body.includes("Already imported issue"), false);
  assert.match(body, /Fresh merged item/);
  assert.equal(body.includes("Old merged item"), false);
  assert.equal(body.includes(workingLease.leaseToken!), false);
  assert.equal(body.includes(reviewLease.leaseToken!), false);

  const proposedStrip = article(body, proposed.id);
  assert.equal((proposedStrip.match(/<form\b/g) ?? []).length, 1);
  assert.match(proposedStrip, new RegExp(`<form[^>]+action="/items/${proposed.id}/approve"`));
  assert.match(proposedStrip, />Approve<\/button>/);
  assert.equal(proposedStrip.includes(`/items/${proposed.id}/reject`), false);

  const blockedRow = article(body, blocked.id);
  assert.equal((blockedRow.match(/<form\b/g) ?? []).length, 1);
  assert.match(blockedRow, new RegExp(`<form[^>]+action="/items/${blocked.id}/requeue"`));
  assert.match(blockedRow, new RegExp(`formaction="/items/${blocked.id}/cancel"`));
  assert.match(blockedRow, /<textarea[^>]+name="reason"/);

  for (const itemWithoutActions of [queued, working, freshMerged]) {
    assert.equal(article(body, itemWithoutActions.id).includes("<form"), false);
  }

  assert.match(body, /new EventSource\(url\)/);
  assert.match(body, /var url = "\/events\/stream"/);
  assert.match(body, /if \(cfg\.reload\) \{ location\.reload\(\); return; \}/);
  assert.match(body, /reloadDelay":2000/);
  assert.match(body, /queueEventPrefix":"work\."/);
  assert.match(body, /queueEventTypes":\["artifact\.verified","artifact\.attached"\]/);
  assert.match(body, /if \(affectsQueueView\(ev\.type\)\) scheduleRefetch\(\)/);
  // The assertions above hold for every live page, so they only prove the shared
  // script is present. /progress ships no partials, which makes `reload` its whole
  // refresh handler: pin this page's own config so flipping it to false fails here.
  assert.match(body, /"page":"\/progress","partials":\[\],"repository":null,"refresh":30,"reload":true/);

  for (const bucket of progressSummaryBuckets) {
    assert.equal(summaryCount(body, bucket), data.summary[bucket]);
    assert.equal(summaryCount(body, bucket), renderedBucketCount(body, bucket));
  }
  assert.equal(summaryCount(body, "attention"), data.attention.length);
  assert.ok(body.indexOf('aria-label="Progress summary"') < body.indexOf('id="attention"'));
});

test("the progress view selects terminal items newest first, so more than 100 aged-out completions cannot hide today's work", async () => {
  let clock = LONG_AGO;
  const queue = new QueueStore(":memory:", () => clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);

  // 105 completions, all merged and older than the seven-day age-out — more
  // than QueueStore.list's hard ceiling, and all of them ahead of the fresh
  // item in claim order (same priority, created first).
  for (let index = 0; index < 105; index += 1) {
    clock = new Date(LONG_AGO.getTime() + index * 1000);
    completeWithPullRequest(queue, REPOSITORY, `Aged out merged item ${index}`, "merged", undefined, clock);
  }
  clock = NOW;
  const fresh = completeWithPullRequest(queue, REPOSITORY, "Fresh item awaiting merge", "open");

  const data = readProgress(queue, NOW)!;
  assert.deepEqual(
    data.repositories.flatMap((group) => group.rows).map((row) => row.item?.id),
    [fresh.id],
    "every aged-out completion is retired and the fresh one survives the limit",
  );

  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue }) });
  const response = await app.request("/progress", { headers: { Cookie: `snowcat_session=${sessionDigest(TOKEN)}` } });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /Fresh item awaiting merge/);
  assert.match(body, /waiting for merge/);
  assert.equal(body.includes("Aged out merged item"), false);
  assert.equal(body.includes("No current progress to show."), false);
});

test("a cancelled primary item appears in neither attention nor any repository group", () => {
  const queue = new QueueStore(":memory:", () => NOW);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);

  const cancelled = cancelledItem(queue, "Cancelled implementation");
  const data = readProgress(queue, NOW)!;

  assert.equal(data.attention.some((row) => row.item?.id === cancelled.id), false);
  assert.equal(
    data.repositories.flatMap((group) => group.rows).some((row) => row.item?.id === cancelled.id),
    false,
  );
  assert.equal(data.total, 0);
});

test("a cancelled review satellite still stops its origin row with a red cancelled badge", () => {
  const origin = item({ status: "completed", delivery: "open", result: resultWithPullRequest("open") });
  const satellite = item({
    id: "cancelled-review",
    kind: "pr-review",
    status: "cancelled",
    review: {
      pullRequestUrl: "https://github.com/frostyard/example/pull/7",
      headSha: "a".repeat(40),
      round: 1,
      originItemId: origin.id,
      priorBlockers: [],
    },
  });

  const row = deriveProgressRow(origin, [satellite], true, NOW);
  assert.equal(row.stage, "review");
  assert.deepEqual(row.badge, { label: "cancelled", reason: "cancelled", tone: "red" });
  assert.equal(row.waiting, "cancelled");
});

test("a completed discovery root with no pull request is delivered, not stalled, and ages out after seven days", () => {
  const delivered = deriveProgressRow(item({ status: "completed", kind: "quality-gap-discovery" }), [], false, NOW);
  assert.equal(delivered.stage, "merged");
  assert.equal(delivered.active, false);
  assert.equal(delivered.badge, undefined);
  assert.equal(delivered.waiting, "delivered · proposals filed");

  let clock = NOW;
  const queue = new QueueStore(":memory:", () => clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);

  const fresh = completeDiscovery(queue, "Fresh discovery");
  const freshRow = readProgress(queue, NOW)!.repositories.flatMap((group) => group.rows).find((row) => row.item?.id === fresh.id);
  assert.ok(freshRow, "a completed discovery inside the seven days is still shown");
  assert.equal(freshRow.stage, "merged");

  clock = LONG_AGO;
  const old = completeDiscovery(queue, "Old discovery");
  const data = readProgress(queue, NOW)!;
  assert.equal(data.repositories.flatMap((group) => group.rows).some((row) => row.item?.id === old.id), false);
  assert.equal(data.attention.some((row) => row.item?.id === old.id), false);
});

test("a claimed item whose lease expired is an amber stop in the attention group", () => {
  let clock = new Date(NOW.getTime() - 4 * 60 * 60 * 1000);
  const queue = new QueueStore(":memory:", () => clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);

  const stale = queue.enqueueSeed(definition("Abandoned implementation", "stale-implementation"));
  queue.claim({ worker: "worker:stale", repository: REPOSITORY, kinds: [stale.kind], leaseSeconds: 3600 });
  clock = NOW;

  const data = readProgress(queue, NOW)!;
  const row = data.attention.find((candidate) => candidate.item?.id === stale.id);
  assert.ok(row, "the expired lease lands in the attention group");
  assert.equal(row.stage, "working");
  assert.equal(row.active, false);
  assert.equal(data.summary.working, 0, "an expired lease is attention, not live work");
  assert.deepEqual(row.badge, { label: "lease expired", reason: "awaiting reclaim", tone: "amber" });
  assert.equal(
    data.repositories.flatMap((group) => group.rows).some((candidate) => candidate.item?.id === stale.id),
    false,
    "an attention row is not repeated in its repository group",
  );
});

test("a completed item whose pull request GitHub could not verify is a grey stop in the attention group", async () => {
  const queue = new QueueStore(":memory:", () => NOW);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);

  const unverified = completeWithPullRequest(queue, REPOSITORY, "Waiting for GitHub", "unverified");

  const data = readProgress(queue, NOW)!;
  const row = data.attention.find((candidate) => candidate.item?.id === unverified.id);
  assert.ok(row, "the unverified artifact lands in the attention group the docs promise collects it");
  assert.equal(row.stage, "pr-open");
  assert.equal(row.waiting, "waiting for validation");
  assert.deepEqual(row.badge, { label: "unverified", reason: "GitHub unavailable", tone: "grey" });
  assert.equal(
    data.repositories.flatMap((group) => group.rows).some((candidate) => candidate.item?.id === unverified.id),
    false,
    "an attention row is not repeated in its repository group",
  );

  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue }) });
  const response = await app.request("/progress", { headers: { Cookie: `snowcat_session=${sessionDigest(TOKEN)}` } });
  assert.equal(response.status, 200);
  const body = await response.text();
  const attention = section(body, "attention");
  assert.match(attention, /Waiting for GitHub/);
  assert.match(attention, /class="fl-progress-badge grey"[^>]*>unverified<\/span>/);
  assert.match(attention, /amber, red, and grey stops/);
  assert.equal(summaryCount(body, "attention"), 1);
});

test("only a live-lease working row counts toward summary.working beside a completed discovery and a cancellation", () => {
  let clock = NOW;
  const queue = new QueueStore(":memory:", () => clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);

  const working = queue.enqueueSeed(definition("Active implementation", "active-implementation"));
  queue.claim({ worker: "worker:active", repository: REPOSITORY, kinds: [working.kind], leaseSeconds: 3600 });
  completeDiscovery(queue, "Delivered discovery");
  cancelledItem(queue, "Cancelled implementation");

  clock = new Date(NOW.getTime() - 4 * 60 * 60 * 1000);
  const expired = queue.enqueueSeed(definition("Expired implementation", "expired-implementation"));
  queue.claim({ worker: "worker:expired", repository: REPOSITORY, kinds: [expired.kind], leaseSeconds: 3600 });
  clock = NOW;

  const data = readProgress(queue, NOW)!;
  assert.equal(data.summary.working, 1);
  const workingRows = data.repositories.flatMap((group) => group.rows).filter((row) => row.stage === "working");
  assert.deepEqual(workingRows.map((row) => row.item?.id), [working.id]);
  assert.ok(data.attention.some((row) => row.item?.id === expired.id), "the expired row is retained in attention");
  assert.equal(data.total, 3, "active, delivered, and expired rows remain; cancellation does not");
});

/** A completed discovery root with no artifacts: delivered by its proposals. */
function completeDiscovery(queue: QueueStore, objective: string, repository = REPOSITORY): ObservableWorkItem {
  const seed = queue.enqueueSeed({
    ...definition(objective, "quality-gap-discovery", repository),
    allowedActions: ["read", "create-followup"],
  });
  const lease = queue.claim({ worker: `worker:${seed.id}`, repository, kinds: [seed.kind] })!;
  return queue.complete({
    id: seed.id,
    leaseToken: lease.leaseToken!,
    worker: `worker:${seed.id}`,
    result: { summary: "Nothing to propose.", evidence: ["read the repository"], artifacts: [] },
    followUps: [],
  }).completed;
}

/** Claim, block, then cancel: the only path a queue item reaches `cancelled` by. */
function cancelledItem(queue: QueueStore, objective: string, repository = REPOSITORY): ObservableWorkItem {
  const seed = queue.enqueueSeed(definition(objective, "cancelled-implementation", repository));
  const lease = queue.claim({ worker: `worker:${seed.id}`, repository, kinds: [seed.kind] })!;
  queue.block(seed.id, lease.leaseToken!, `worker:${seed.id}`, "Needs an operator decision.");
  return queue.cancel(seed.id, "operator:test", "No longer needed.");
}

function completeWithPullRequest(
  queue: QueueStore,
  repository: string,
  objective: string,
  state: "open" | "merged" | "unverified",
  sourceRef?: string,
  at: Date = NOW,
): ObservableWorkItem {
  const seed = queue.enqueueSeed({
    ...definition(objective, `implementation-${objective.toLowerCase().replaceAll(" ", "-")}`, repository),
    ...(sourceRef ? { sourceRef } : {}),
  });
  const lease = queue.claim({ worker: `worker:${seed.id}`, repository, kinds: [seed.kind] })!;
  const verification: WorkArtifact["verification"] =
    state === "unverified"
      ? { status: "unverified", attemptedAt: at.toISOString(), reason: "GitHub unavailable" }
      : {
          status: "verified",
          verifiedAt: at.toISOString(),
          number: 7,
          state,
          headSha: "a".repeat(40),
          ...(state === "merged" ? { mergedAt: at.toISOString() } : { draft: repository === REPOSITORY }),
        };
  return queue.complete({
    id: seed.id,
    leaseToken: lease.leaseToken!,
    worker: `worker:${seed.id}`,
    result: {
      summary: "Done.",
      evidence: ["tests pass"],
      artifacts: [{ kind: "pull-request", url: `https://github.com/${repository}/pull/7`, verification }],
    },
    followUps: [],
  }).completed;
}

function definition(objective: string, kind: string, repository = REPOSITORY): SeedWorkInput {
  return {
    repository,
    kind,
    objective,
    instructions: "Do it.",
    acceptanceCriteria: ["Done."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    createdBy: "operator:test",
  };
}

function resultWithPullRequest(state: "open" | "closed") {
  return {
    summary: "Done.",
    evidence: ["tests pass"],
    artifacts: [
      {
        kind: "pull-request" as const,
        url: "https://github.com/frostyard/example/pull/7",
        verification: {
          status: "verified" as const,
          verifiedAt: NOW.toISOString(),
          number: 7,
          state,
          headSha: "a".repeat(40),
          draft: true,
        },
      },
    ],
  };
}

function item(overrides: Partial<ObservableWorkItem> = {}): ObservableWorkItem {
  return {
    id: "origin",
    rootId: "origin",
    repository: REPOSITORY,
    kind: "issue-resolution",
    objective: "Origin",
    instructions: "Do it.",
    acceptanceCriteria: ["Done."],
    allowedActions: ["read", "open-pr"],
    delegableActions: [],
    requiredArtifact: "none",
    priority: 0,
    status: "queued",
    createdBy: "operator:test",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    operatorNotes: [],
    previousResults: [],
    ...overrides,
  };
}

function section(body: string, id: string): string {
  const match = new RegExp(`<section class="fl-group[^"]*" id="${id}">.*?</section>`, "s").exec(body);
  assert.ok(match, `section ${id} present`);
  return match[0];
}

// The row's opening tag carries more than data-progress-key (data-progress-stage
// since #153), so match the key wherever it sits among the tag's attributes.
function article(body: string, itemId: string): string {
  const match = new RegExp(`<article class="fl-progress-row"[^>]*data-progress-key="item:${itemId}"[^>]*>.*?</article>`, "s").exec(body);
  assert.ok(match, `progress row for item ${itemId} present`);
  return match[0];
}

function summaryCount(body: string, bucket: ProgressSummaryBucket | "attention"): number {
  const match = new RegExp(`data-progress-summary-bucket="${bucket}"[^>]*><strong>(\\d+)</strong>`).exec(body);
  assert.ok(match, `summary bucket ${bucket} present`);
  return Number(match[1]);
}

function renderedBucketCount(body: string, bucket: ProgressSummaryBucket): number {
  if (bucket === "working") {
    return body.match(/<li class="current active"[^>]*><span class="fl-stage-mark"[^>]*><\/span><b>Working<\/b>/g)?.length ?? 0;
  }
  const stages =
    bucket === "in-review"
      ? ["pr-open", "review"]
      : [bucket];
  return stages.reduce(
    (count, stage) => count + (body.match(new RegExp(`data-progress-stage="${stage}"`, "g"))?.length ?? 0),
    0,
  );
}

// --- Issue #180: repository filter, Working now, and Up next ----------------

/** One proposed root keyed by an issue URL; approve it to admit (queue) it. */
function proposeRoot(
  queue: QueueStore,
  options: { objective: string; kind: string; sourceRef: string; predecessors?: string[]; repository?: string },
) {
  const repository = options.repository ?? REPOSITORY;
  const { created } = queue.enqueueProposedRoots(repository, [
    {
      objective: options.objective,
      instructions: "Read the issue, then open one pull request.",
      acceptanceCriteria: ["A pull request is open."],
      allowedActions: ["read", "write", "run-tests", "open-pr"],
      delegableActions: [],
      createdBy: "operator:import-issues",
      sourceRef: options.sourceRef,
      kind: options.kind,
      ...(options.predecessors ? { predecessors: options.predecessors } : {}),
    },
  ]);
  return created[0]!;
}

test("readProgress filters primaries and observations by repository and 404s an unknown slug", () => {
  const clock = new Date(NOW);
  const queue = new QueueStore(":memory:", () => clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/updex", true);
  queue.setRepositoryEnabled("frostyard/other", true);
  queue.enqueueSeed(definition("Updex work", "quality-implementation", "frostyard/updex"));
  queue.enqueueSeed(definition("Other work", "quality-implementation", "frostyard/other"));
  queue.recordLabeledIssueObservations(
    "frostyard/updex",
    [{ url: "https://github.com/frostyard/updex/issues/1", title: "Updex issue", outcome: "existing" }],
    "operator:test",
  );
  queue.recordLabeledIssueObservations(
    "frostyard/other",
    [{ url: "https://github.com/frostyard/other/issues/1", title: "Other issue", outcome: "existing" }],
    "operator:test",
  );

  const data = readProgress(queue, NOW, { repository: "Frostyard/UpDex" });
  assert.ok(data, "a case-insensitive opted-in slug resolves");
  assert.equal(data.filter.repository, "frostyard/updex");
  assert.deepEqual(
    data.repositories.map((group) => group.repository),
    ["frostyard/updex"],
    "only the filtered repository has a lane",
  );
  const rows = data.repositories.flatMap((group) => group.rows);
  assert.ok(
    rows.every((row) => row.repository === "frostyard/updex"),
    "every row belongs to the filtered repository",
  );
  assert.ok(rows.some((row) => row.observation?.url === "https://github.com/frostyard/updex/issues/1"), "the updex observation is present");
  assert.ok(!rows.some((row) => row.observation?.url.includes("/other/")), "no other repository's observation leaks in");

  assert.equal(readProgress(queue, NOW, { repository: "nobody/nothing" }), undefined, "an unknown slug is a 404 (undefined)");
});

test("workingNow holds exactly the live-lease rows, each with its lease owner and no lease token", () => {
  let clock = new Date(NOW.getTime() - 4 * 60 * 60 * 1000);
  const queue = new QueueStore(":memory:", () => clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);

  // An active worker: claimed at NOW with a live one-hour lease.
  clock = NOW;
  const active = queue.enqueueSeed(definition("Active worker", "active-implementation"));
  queue.claim({ worker: "worker:live", repository: REPOSITORY, kinds: [active.kind], leaseSeconds: 3600 });

  // An expired lease: claimed four hours ago for one hour, read at NOW.
  clock = new Date(NOW.getTime() - 4 * 60 * 60 * 1000);
  const stale = queue.enqueueSeed(definition("Abandoned worker", "stale-implementation"));
  queue.claim({ worker: "worker:stale", repository: REPOSITORY, kinds: [stale.kind], leaseSeconds: 3600 });

  // A plain queued item and a completed discovery: neither is active.
  clock = NOW;
  queue.enqueueSeed(definition("Waiting in queue", "queued-implementation"));
  completeDiscovery(queue, "Delivered discovery");

  const data = readProgress(queue, NOW)!;
  assert.deepEqual(
    data.workingNow.map((row) => row.item?.id),
    [active.id],
    "only the live-lease worker is in Working now",
  );
  assert.equal(data.workingNow[0]!.leaseOwner, "worker:live");
  assert.equal(data.workingNow[0]!.active, true);
  assert.ok(!JSON.stringify(data).includes("leaseToken"), "no lease token reaches the projection");
});

test("upNext lists only claimable queued primaries, ordered by priority then createdAt", () => {
  let clock = new Date(NOW);
  const queue = new QueueStore(":memory:", () => clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);

  const advance = () => (clock = new Date(clock.getTime() + 60_000));

  // A high-priority item created latest still leads.
  const midEarly = queue.enqueueSeed({ ...definition("Mid priority, earliest", "queued-implementation"), priority: 1 });
  advance();
  const midLate = queue.enqueueSeed({ ...definition("Mid priority, later", "queued-implementation"), priority: 1 });
  advance();
  const top = queue.enqueueSeed({ ...definition("Top priority, latest", "queued-implementation"), priority: 5 });
  advance();

  // A queued item withheld by an unmet predecessor: not claimable.
  const gated = queue.approve(
    proposeRoot(queue, {
      objective: "Blocked on a predecessor",
      kind: "issue-resolution",
      sourceRef: "https://github.com/frostyard/example/issues/500",
      predecessors: ["https://github.com/frostyard/example/issues/499"],
    }).id,
    "operator:test",
  );
  advance();
  // A still-proposed root: admitted work only.
  const proposed = proposeRoot(queue, {
    objective: "Not yet admitted",
    kind: "issue-resolution",
    sourceRef: "https://github.com/frostyard/example/issues/501",
  });

  const data = readProgress(queue, NOW)!;
  assert.deepEqual(
    data.upNext.map((row) => row.item?.id),
    [top.id, midEarly.id, midLate.id],
    "priority descending, then createdAt ascending",
  );
  const ids = new Set(data.upNext.map((row) => row.item?.id));
  assert.ok(!ids.has(gated.id), "a queued item with an unmet predecessor is not up next");
  assert.ok(!ids.has(proposed.id), "a proposed item is not up next");
});

test("upNext caps at 20 claimable items and records the drop in truncated", () => {
  const clock = new Date(NOW);
  const queue = new QueueStore(":memory:", () => clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);

  for (let index = 0; index < 21; index += 1) {
    queue.enqueueSeed(definition(`Claimable ${index}`, "queued-implementation"));
  }

  const data = readProgress(queue, NOW)!;
  assert.equal(data.upNext.length, 20, "the 21st claimable item is dropped");
  assert.ok(data.truncated.includes("up-next"), "the cap is recorded in truncated");
});
