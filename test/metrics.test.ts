import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { computeQueueMetrics, queueMetrics, resolveMetricsWindow } from "../src/queue/metrics.ts";
import { QueueStore } from "../src/queue/store.ts";
import type { WorkItem } from "../src/queue/types.ts";
import { childEnvironment } from "./helpers/child-environment.ts";

const REPOSITORY = "frostyard/updex";
const DAY_START = "2026-08-19T00:00:00.000Z";
const NEXT_DAY = "2026-08-20T00:00:00.000Z";

/** A store whose clock the test moves by hand, so every timestamp is chosen. */
function frozenStore(start: string): { queue: QueueStore; at: (iso: string) => void } {
  let now = new Date(start);
  const queue = new QueueStore(":memory:", () => now);
  queue.setRepositoryEnabled(REPOSITORY, true);
  return { queue, at: (iso: string) => (now = new Date(iso)) };
}

function seed(queue: QueueStore, objective: string): WorkItem {
  return queue.enqueueSeed({
    repository: REPOSITORY,
    kind: "issue-resolution",
    objective,
    instructions: "Resolve the issue and open one pull request.",
    acceptanceCriteria: ["The pull request is open and reported."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    requiredArtifact: "pull-request",
    executionTarget: "new-pull-request",
    createdBy: "operator:test",
  });
}

/** Claims the next item, completes it reporting `pullRequestNumber`, and returns the completed item. */
function completeWithPullRequest(queue: QueueStore, pullRequestNumber: number): WorkItem {
  const claimed = queue.claim({ worker: `codex:updex:${pullRequestNumber}`, repository: REPOSITORY })!;
  const { completed } = queue.complete({
    id: claimed.id,
    leaseToken: claimed.leaseToken!,
    worker: claimed.leaseOwner!,
    result: {
      summary: "Resolved and opened a pull request.",
      evidence: ["npm run check passed"],
      artifacts: [
        {
          kind: "pull-request",
          url: `https://github.com/${REPOSITORY}/pull/${pullRequestNumber}`,
          description: "The change.",
        },
      ],
    },
    followUps: [],
  });
  return completed;
}

function recordMerge(queue: QueueStore, item: WorkItem, pullRequestNumber: number, mergedAt: string): void {
  queue.recordArtifactVerification(
    item.id,
    `https://github.com/${REPOSITORY}/pull/${pullRequestNumber}`,
    {
      status: "verified",
      verifiedAt: mergedAt,
      number: pullRequestNumber,
      state: "merged",
      mergedAt,
    },
    "operator:test",
  );
}

test("a claimed, completed, and merged item is one attempt, one acceptance, and one time to merge", () => {
  const { queue, at } = frozenStore("2026-08-19T09:00:00.000Z");
  test.after(() => queue.close());

  seed(queue, "Resolve issue #1.");
  at("2026-08-19T10:00:00.000Z");
  const completedAt = "2026-08-19T11:00:00.000Z";
  at(completedAt);
  const completed = completeWithPullRequest(queue, 7);
  recordMerge(queue, completed, 7, "2026-08-19T16:00:00.000Z");

  const metrics = queueMetrics(queue, { since: DAY_START, until: NEXT_DAY });

  assert.equal(metrics.since, DAY_START);
  assert.equal(metrics.until, NEXT_DAY);
  assert.equal(metrics.all.attempts, 1);
  assert.equal(metrics.all.completed, 1);
  assert.equal(metrics.all.accepted, 1);
  assert.equal(metrics.all.acceptedPerAttempt, 1);
  assert.equal(metrics.all.completedByDelivery.merged, 1);
  assert.equal(metrics.all.completedByDelivery.open, 0);
  assert.equal(metrics.all.created.completed, 1);
  assert.equal(metrics.all.created.queued, 0);
  assert.equal(metrics.all.blocked, 0);
  assert.equal(metrics.all.cancelled, 0);
  // Completed 11:00, merged 16:00: five hours, the only sample, so it is both
  // the median and the p90.
  assert.deepEqual(metrics.all.timeToMergeHours, { count: 1, median: 5, p90: 5 });
  assert.deepEqual(metrics.repositories[REPOSITORY], metrics.all);
});

test("time to merge reports the median and the nearest-rank p90 of its samples", () => {
  const { queue, at } = frozenStore("2026-08-19T06:00:00.000Z");
  test.after(() => queue.close());

  for (const [index, hours] of [5, 2, 9].entries()) {
    const number = index + 10;
    seed(queue, `Resolve issue #${number}.`);
    at("2026-08-19T08:00:00.000Z");
    const completed = completeWithPullRequest(queue, number);
    recordMerge(queue, completed, number, new Date(Date.parse("2026-08-19T08:00:00.000Z") + hours * 3_600_000).toISOString());
  }

  const metrics = queueMetrics(queue, { since: DAY_START, until: NEXT_DAY });

  assert.equal(metrics.all.attempts, 3);
  assert.equal(metrics.all.accepted, 3);
  assert.equal(metrics.all.acceptedPerAttempt, 1);
  // Samples 2, 5, 9: median 5, nearest-rank p90 (ceil(0.9 * 3) = 3) is 9.
  assert.deepEqual(metrics.all.timeToMergeHours, { count: 3, median: 5, p90: 9 });
});

test("a blocked item counts as blocked and never as accepted", () => {
  const { queue, at } = frozenStore("2026-08-19T09:00:00.000Z");
  test.after(() => queue.close());

  seed(queue, "Resolve issue #2.");
  at("2026-08-19T10:00:00.000Z");
  const claimed = queue.claim({ worker: "codex:updex:blocked", repository: REPOSITORY })!;
  queue.block(claimed.id, claimed.leaseToken!, "codex:updex:blocked", "The issue names no acceptance criterion.");

  const metrics = queueMetrics(queue, { since: DAY_START, until: NEXT_DAY });

  assert.equal(metrics.all.attempts, 1);
  assert.equal(metrics.all.blocked, 1);
  assert.equal(metrics.all.completed, 0);
  assert.equal(metrics.all.accepted, 0);
  assert.equal(metrics.all.acceptedPerAttempt, 0);
  assert.equal(metrics.all.created.blocked, 1);
  assert.deepEqual(metrics.all.timeToMergeHours, { count: 0, median: null, p90: null });
});

test("--since excludes an item created before it, and its attempt with it", () => {
  const { queue, at } = frozenStore("2026-08-19T08:00:00.000Z");
  test.after(() => queue.close());

  seed(queue, "Resolve issue #3 — before the window.");
  const early = queue.claim({ worker: "codex:updex:early", repository: REPOSITORY })!;
  assert.ok(early);
  at("2026-08-19T12:00:00.000Z");
  seed(queue, "Resolve issue #4 — inside the window.");

  const whole = queueMetrics(queue, { since: DAY_START, until: NEXT_DAY });
  assert.equal(whole.all.created.queued + whole.all.created.claimed, 2);
  assert.equal(whole.all.attempts, 1);

  const narrowed = queueMetrics(queue, { since: "2026-08-19T10:00:00.000Z", until: NEXT_DAY });
  assert.equal(narrowed.all.created.queued, 1);
  assert.equal(narrowed.all.created.claimed, 0);
  assert.equal(narrowed.all.attempts, 0);
  assert.equal(narrowed.all.acceptedPerAttempt, null);
});

test("acceptedPerAttempt is null when the window has no attempts", () => {
  const { queue } = frozenStore("2026-08-19T09:00:00.000Z");
  test.after(() => queue.close());

  seed(queue, "Resolve issue #5.");

  const metrics = queueMetrics(queue, { since: DAY_START, until: NEXT_DAY });

  assert.equal(metrics.all.attempts, 0);
  assert.equal(metrics.all.accepted, 0);
  assert.equal(metrics.all.acceptedPerAttempt, null);
  assert.equal(metrics.all.created.queued, 1);
});

test("the default window is the last 24 hours ending now", () => {
  const { queue, at } = frozenStore("2026-08-18T02:00:00.000Z");
  test.after(() => queue.close());

  seed(queue, "Resolve issue #6 — 31 hours ago.");
  at("2026-08-19T07:00:00.000Z");
  seed(queue, "Resolve issue #7 — two hours ago.");

  const window = resolveMetricsWindow({}, new Date("2026-08-19T09:00:00.000Z"));
  assert.deepEqual(window, { since: "2026-08-18T09:00:00.000Z", until: "2026-08-19T09:00:00.000Z" });

  const metrics = queueMetrics(queue, { now: new Date("2026-08-19T09:00:00.000Z") });
  assert.equal(metrics.all.created.queued, 1);
  assert.equal(metrics.repositories[REPOSITORY]?.created.queued, 1);
});

test("one bound alone pins the window rule 56 describes", () => {
  const now = new Date("2026-08-19T09:00:00.000Z");

  assert.deepEqual(resolveMetricsWindow({ since: DAY_START }, now), {
    since: DAY_START,
    until: "2026-08-19T09:00:00.000Z",
  });
  assert.deepEqual(resolveMetricsWindow({ until: NEXT_DAY }, now), {
    since: "2026-08-19T00:00:00.000Z",
    until: NEXT_DAY,
  });
});

test("a repository-narrowed reading counts only that repository", () => {
  const { queue, at } = frozenStore("2026-08-19T09:00:00.000Z");
  test.after(() => queue.close());

  queue.setRepositoryEnabled("frostyard/clix", true);
  seed(queue, "Resolve issue #8.");
  queue.enqueueSeed({
    repository: "frostyard/clix",
    kind: "issue-resolution",
    objective: "Resolve the other repository's issue.",
    instructions: "Resolve it.",
    acceptanceCriteria: ["It is resolved."],
    allowedActions: ["read"],
    delegableActions: [],
    executionTarget: "read-only",
    createdBy: "operator:test",
  });
  at("2026-08-19T10:00:00.000Z");

  const whole = queueMetrics(queue, { since: DAY_START, until: NEXT_DAY });
  assert.deepEqual(Object.keys(whole.repositories), ["frostyard/clix", REPOSITORY]);
  assert.equal(whole.all.created.queued, 2);

  const narrowed = queueMetrics(queue, { since: DAY_START, until: NEXT_DAY, repository: REPOSITORY });
  assert.equal(narrowed.repository, REPOSITORY);
  assert.deepEqual(Object.keys(narrowed.repositories), [REPOSITORY]);
  assert.equal(narrowed.all.created.queued, 1);
});

test("computing metrics is pure: the same window rows always give the same numbers", () => {
  const window = {
    since: DAY_START,
    until: NEXT_DAY,
    created: [{ repository: REPOSITORY, status: "completed" as const, count: 1 }],
    events: [
      { type: "work.claimed", repository: REPOSITORY, workItemId: "a", occurredAt: "2026-08-19T10:00:00.000Z" },
      {
        type: "work.completed",
        repository: REPOSITORY,
        workItemId: "a",
        occurredAt: "2026-08-19T11:00:00.000Z",
        result: {
          summary: "Done.",
          evidence: ["checked"],
          artifacts: [
            {
              kind: "pull-request" as const,
              url: `https://github.com/${REPOSITORY}/pull/9`,
              verification: {
                status: "verified" as const,
                verifiedAt: "2026-08-19T12:30:00.000Z",
                number: 9,
                state: "merged" as const,
                mergedAt: "2026-08-19T12:30:00.000Z",
              },
            },
          ],
        },
      },
    ],
  };

  const first = computeQueueMetrics(window);
  const second = computeQueueMetrics(window);

  assert.deepEqual(first, second);
  assert.equal(first.all.acceptedPerAttempt, 1);
  assert.deepEqual(first.all.timeToMergeHours, { count: 1, median: 1.5, p90: 1.5 });
});

test("a window bound that is not a timestamp is refused, and an inverted window with it", () => {
  const { queue } = frozenStore("2026-08-19T09:00:00.000Z");
  test.after(() => queue.close());

  assert.throws(() => queueMetrics(queue, { since: "not-a-date" }), /since must be an ISO timestamp/);
  assert.throws(() => queueMetrics(queue, { until: "not-a-date" }), /until must be an ISO timestamp/);
  assert.throws(() => queueMetrics(queue, { since: NEXT_DAY, until: DAY_START }), /since must be before until/);
});

test("the metrics command prints one JSON reading and refuses a bad --since", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-metrics-cli-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  queue.setRepositoryEnabled(REPOSITORY, true);
  seed(queue, "Resolve issue #9.");
  queue.close();

  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: childEnvironment({ SNOWCAT_QUEUE_DB: path }),
    });

  const invalid = run("metrics", "--since", "not-a-date");
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /--since must be an ISO timestamp/);

  const reading = run("metrics");
  assert.equal(reading.status, 0);
  const parsed = JSON.parse(reading.stdout) as {
    since: string;
    until: string;
    all: { created: Record<string, number>; acceptedPerAttempt: number | null };
    repositories: Record<string, { created: Record<string, number> }>;
  };
  assert.ok(Date.parse(parsed.since) < Date.parse(parsed.until));
  assert.equal(parsed.all.created.queued, 1);
  assert.equal(parsed.all.acceptedPerAttempt, null);
  assert.equal(parsed.repositories[REPOSITORY]?.created.queued, 1);

  const narrowed = run("metrics", "--repository", "frostyard/clix");
  assert.equal(narrowed.status, 0);
  assert.deepEqual(Object.keys((JSON.parse(narrowed.stdout) as { repositories: Record<string, unknown> }).repositories), []);
});
