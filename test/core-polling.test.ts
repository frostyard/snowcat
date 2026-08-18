import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { runCorePollOnce, type CoreSourceSynchronizer } from "../src/core/controller.ts";
import {
  CORE_POLL_DEFAULT_INTERVAL_SECONDS,
  corePollDelaySeconds,
  parseCorePollInterval,
} from "../src/core/poll-policy.ts";
import { ControlPlaneStore } from "../src/control/store.ts";
import { uuidV7 } from "../src/control/encoding.ts";

test("Core poll policy validates configuration and applies bounded source backoff", () => {
  assert.equal(parseCorePollInterval(undefined), 900);
  assert.equal(parseCorePollInterval("60"), 60);
  assert.equal(parseCorePollInterval("3600"), 3600);
  assert.throws(() => parseCorePollInterval("060"), /canonical positive integer/);
  assert.throws(() => parseCorePollInterval("59"), /60 through 3600/);
  assert.throws(() => parseCorePollInterval("3601"), /60 through 3600/);
  assert.equal(corePollDelaySeconds(900, "source-unavailable", 1), 1800);
  assert.equal(corePollDelaySeconds(900, "source-unavailable", 2), 3600);
  assert.equal(corePollDelaySeconds(900, "source-unavailable", 20), 3600);
  assert.equal(corePollDelaySeconds(900, "candidate-invalid", 0), 900);
});

test("Core poll leases exclude overlap, recover after expiry, and persist completion-relative schedules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-core-poll-state-test-"));
  const path = join(directory, "control-plane.db");
  let now = new Date("2026-08-16T10:00:00.000Z");
  const first = new ControlPlaneStore(path, () => now);
  const second = new ControlPlaneStore(path, () => now);
  assert.deepEqual(first.corePollState(), {
    scheduleVersion: 1,
    healthyIntervalSeconds: 900,
    nextPollAt: "2026-08-16T10:00:00.000Z",
    nextPruneAt: "2026-08-17T10:00:00.000Z",
    sourceUnavailableStreak: 0,
    inFlightRunId: null,
    inFlightStartedAt: null,
    inFlightExpiresAt: null,
    lastRunId: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastRunStatus: null,
    lastSourceOutcome: null,
    lastCheckDisposition: null,
    completedRunCount: 0,
    suppressedCheckCount: 0,
  });

  const claim = first.claimCorePoll(CORE_POLL_DEFAULT_INTERVAL_SECONDS);
  assert.equal(claim.status, "claimed");
  if (claim.status !== "claimed") return;
  assert.equal(claim.expiresAt, "2026-08-16T10:10:00.000Z");
  const blocked = second.claimCorePoll(CORE_POLL_DEFAULT_INTERVAL_SECONDS);
  assert.equal(blocked.status, "in-flight");
  if (blocked.status === "in-flight") assert.equal(blocked.runId, claim.runId);

  now = new Date("2026-08-16T10:10:00.001Z");
  const recovered = second.claimCorePoll(600);
  assert.equal(recovered.status, "claimed");
  if (recovered.status !== "claimed") return;
  assert.notEqual(recovered.runId, claim.runId);
  assert.throws(
    () => first.completeCorePoll({
      runId: claim.runId,
      runStatus: "completed",
      sourceOutcome: "eligible",
      checkDisposition: "recorded",
      pruneRan: false,
    }),
    /does not own the active lease/,
  );

  now = new Date("2026-08-16T10:10:05.000Z");
  const completed = second.completeCorePoll({
    runId: recovered.runId,
    runStatus: "completed",
    sourceOutcome: "source-unavailable",
    checkDisposition: "recorded",
    pruneRan: false,
  });
  assert.equal(completed.healthyIntervalSeconds, 600);
  assert.equal(completed.sourceUnavailableStreak, 1);
  assert.equal(completed.nextPollAt, "2026-08-16T10:40:05.000Z");
  assert.equal(completed.completedRunCount, 1);

  now = new Date(completed.nextPollAt);
  const outageClaim = second.claimCorePoll(600);
  assert.equal(outageClaim.status, "claimed");
  if (outageClaim.status !== "claimed") return;
  now = new Date("2026-08-16T10:40:10.000Z");
  const backedOff = second.completeCorePoll({
    runId: outageClaim.runId,
    runStatus: "completed",
    sourceOutcome: "source-unavailable",
    checkDisposition: "recorded",
    pruneRan: false,
  });
  assert.equal(backedOff.sourceUnavailableStreak, 2);
  assert.equal(backedOff.nextPollAt, "2026-08-16T11:40:10.000Z");

  now = new Date(backedOff.nextPollAt);
  const recoveryClaim = second.claimCorePoll(600);
  assert.equal(recoveryClaim.status, "claimed");
  if (recoveryClaim.status !== "claimed") return;
  now = new Date("2026-08-16T11:40:15.000Z");
  const healthy = second.completeCorePoll({
    runId: recoveryClaim.runId,
    runStatus: "completed",
    sourceOutcome: "candidate-invalid",
    checkDisposition: "suppressed",
    pruneRan: true,
  });
  assert.equal(healthy.sourceUnavailableStreak, 0);
  assert.equal(healthy.nextPollAt, "2026-08-16T11:50:15.000Z");
  assert.equal(healthy.nextPruneAt, "2026-08-17T11:40:15.000Z");
  assert.equal(healthy.suppressedCheckCount, 1);
  first.close();
  second.close();

  const reopened = new ControlPlaneStore(path, () => now);
  assert.deepEqual(reopened.corePollState(), healthy);
  reopened.close();

  const cliState = JSON.parse(
    execFileSync(process.execPath, ["--import", "tsx", "src/core/cli.ts", "poll-state"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, SNOWCAT_CONTROL_DB: path },
    }),
  ) as Record<string, unknown>;
  assert.equal(cliState.completedRunCount, 3);
  assert.equal(cliState.suppressedCheckCount, 1);

  const invalidInterval = spawnSync(process.execPath, ["--import", "tsx", "src/core/cli.ts", "poll-once"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, SNOWCAT_CONTROL_DB: path, SNOWCAT_CORE_POLL_INTERVAL_SECONDS: "0" },
  });
  assert.notEqual(invalidInterval.status, 0);
  assert.match(invalidInterval.stderr, /canonical positive integer/);
});

test("poll-once completes expected source failures and reserves controller errors for infrastructure failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-core-poll-once-test-"));
  let now = new Date("2026-08-16T12:00:00.000Z");
  const store = new ControlPlaneStore(join(directory, "control-plane.db"), () => now);
  const expectedFailure: CoreSourceSynchronizer = async () => ({
    status: "rejected",
    outcome: "source-unavailable",
    checkDisposition: "recorded",
    checkId: uuidV7(now),
    activation: null,
    activationResult: null,
    sourceCheck: null,
    rejectionResult: null,
    diagnosticError: null,
    failure: new Error("source unavailable"),
  });
  const first = await runCorePollOnce(
    store,
    { sourceUrl: "fixture", ref: "refs/heads/main", mirrorPath: "fixture", allowFileSource: true },
    900,
    expectedFailure,
  );
  assert.equal(first.status, "claimed");
  if (first.status !== "claimed") return;
  assert.equal(first.synchronizationStatus, "rejected");
  assert.equal(first.controllerError, null);
  assert.equal(first.state.nextPollAt, "2026-08-16T12:30:00.000Z");

  const notDue = await runCorePollOnce(
    store,
    { sourceUrl: "fixture", ref: "refs/heads/main", mirrorPath: "fixture", allowFileSource: true },
    900,
    expectedFailure,
  );
  assert.equal(notDue.status, "not-due");

  now = new Date("2026-08-16T12:30:00.000Z");
  const controllerFailure: CoreSourceSynchronizer = async () => {
    throw new Error("unexpected controller failure");
  };
  const failed = await runCorePollOnce(
    store,
    { sourceUrl: "fixture", ref: "refs/heads/main", mirrorPath: "fixture", allowFileSource: true },
    900,
    controllerFailure,
  );
  assert.equal(failed.status, "claimed");
  if (failed.status !== "claimed") return;
  assert.equal(failed.synchronizationStatus, "controller-error");
  assert.equal(failed.sourceOutcome, null);
  assert.equal(failed.state.sourceUnavailableStreak, 1);
  assert.equal(failed.state.nextPollAt, "2026-08-16T12:45:00.000Z");

  now = new Date("2026-08-17T12:45:00.000Z");
  const pruned = await runCorePollOnce(
    store,
    { sourceUrl: "fixture", ref: "refs/heads/main", mirrorPath: "fixture", allowFileSource: true },
    900,
    expectedFailure,
  );
  assert.equal(pruned.status, "claimed");
  if (pruned.status !== "claimed") return;
  assert.equal(pruned.pruneResult?.deletedTransactionCount, 0);
  assert.equal(pruned.controllerError, null);
  assert.equal(pruned.state.nextPruneAt, "2026-08-18T12:45:00.000Z");
  store.close();
});

test("only consecutive equivalent invalid or continuity outcomes suppress detail", () => {
  const store = new ControlPlaneStore(":memory:", () => new Date("2026-08-16T14:00:00.000Z"));
  const base = {
    checkId: uuidV7(new Date("2026-08-16T14:00:00.000Z")),
    operation: "automatic-source-check" as const,
    stage: "validation" as const,
    code: "candidate-invalid" as const,
    summary: "candidate invalid",
    details: [] as string[],
    sourceUrl: "https://github.com/frostyard/core.git",
    sourceRef: "refs/heads/main",
    commitId: "a".repeat(40),
    treeId: "b".repeat(40),
  };
  assert.equal(store.shouldSuppressCoreCandidateRejection(base), false);
  store.recordCoreCandidateRejection(base);
  assert.equal(store.shouldSuppressCoreCandidateRejection({ ...base, checkId: uuidV7() }), true);
  store.recordCoreCandidateRejection({
    ...base,
    checkId: uuidV7(),
    operation: "operator-rollback",
  });
  assert.equal(store.shouldSuppressCoreCandidateRejection({ ...base, checkId: uuidV7() }), true);
  assert.equal(
    store.shouldSuppressCoreCandidateRejection({ ...base, checkId: uuidV7(), commitId: "c".repeat(40) }),
    false,
  );
  store.recordCoreCandidateRejection({
    ...base,
    checkId: uuidV7(),
    stage: "source",
    code: "source-unavailable",
    commitId: undefined,
    treeId: undefined,
  });
  assert.equal(store.shouldSuppressCoreCandidateRejection({ ...base, checkId: uuidV7() }), false);
  store.close();
});

test("startup fails closed on malformed Core poll operational state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-core-poll-tamper-test-"));
  const path = join(directory, "control-plane.db");
  const store = new ControlPlaneStore(path, () => new Date("2026-08-16T15:00:00.000Z"));
  store.close();
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE core_poll_state SET next_poll_at = 'not-a-time' WHERE singleton = 1").run();
  raw.close();
  assert.throws(() => new ControlPlaneStore(path), /Core next poll time/);
});
