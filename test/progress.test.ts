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

test("progress derivation marks closed, cancelled, and third-round review stops", () => {
  const closed = item({
    status: "completed",
    delivery: "closed",
    result: resultWithPullRequest("closed"),
  });
  const closedRow = deriveProgressRow(closed, [], false, NOW);
  assert.equal(closedRow.stage, "awaiting-merge");
  assert.deepEqual(closedRow.badge, { label: "closed", reason: "PR closed without merge", tone: "red" });

  const cancelledRow = deriveProgressRow(item({ status: "cancelled" }), [], false, NOW);
  assert.equal(cancelledRow.stage, "working");
  assert.deepEqual(cancelledRow.badge, { label: "cancelled", reason: "cancelled", tone: "red" });

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

test("the session-guarded progress page renders every stage, folds review satellites, pins attention, and ages out old terminals", async () => {
  let clock = LONG_AGO;
  const queue = new QueueStore(":memory:", () => clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);
  queue.setRepositoryEnabled("frostyard/plain", true);
  queue.setRepositoryReviewGate(REPOSITORY, true);

  completeWithPullRequest(queue, REPOSITORY, "Old merged item", "merged", undefined, LONG_AGO);
  clock = NOW;
  completeWithPullRequest(queue, REPOSITORY, "Fresh merged item", "merged");
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

  queue.enqueueSeed(definition("Queued implementation", "queued-implementation"));
  queue.enqueueProposedRoots(REPOSITORY, [
    {
      ...definition("Proposed implementation", "proposed-implementation"),
      sourceRef: "https://github.com/frostyard/example/issues/20",
    },
  ]);

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

  const data = readProgress(queue, NOW);
  assert.equal(data.total, 9);
  assert.equal(data.active, 2);
  assert.deepEqual(data.summary, {
    "awaiting-import": 1,
    proposed: 1,
    queued: 1,
    working: 2,
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

  const data = readProgress(queue, NOW);
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

function summaryCount(body: string, bucket: ProgressSummaryBucket | "attention"): number {
  const match = new RegExp(`data-progress-summary-bucket="${bucket}"><strong>(\\d+)</strong>`).exec(body);
  assert.ok(match, `summary bucket ${bucket} present`);
  return Number(match[1]);
}

function renderedBucketCount(body: string, bucket: ProgressSummaryBucket): number {
  const stages =
    bucket === "in-review"
      ? ["pr-open", "review"]
      : [bucket];
  return stages.reduce(
    (count, stage) => count + (body.match(new RegExp(`data-progress-stage="${stage}"`, "g"))?.length ?? 0),
    0,
  );
}
