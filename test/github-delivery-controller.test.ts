import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ControlPlaneStore } from "../src/control/store.ts";
import {
  runGitHubDeliveryAuditOnce,
  type GitHubDeliveryAuditor,
} from "../src/github/delivery-controller.ts";
import {
  githubDeliveryAuditRetrySeconds,
  parseGitHubDeliveryAuditInterval,
} from "../src/github/audit-policy.ts";

const jwt = `${"a".repeat(16)}.${"b".repeat(16)}.${"c".repeat(16)}`;

test("GitHub delivery-audit policy validates cadence and applies fixed incomplete retry", () => {
  assert.equal(parseGitHubDeliveryAuditInterval(undefined), 300);
  assert.equal(parseGitHubDeliveryAuditInterval("60"), 60);
  assert.equal(parseGitHubDeliveryAuditInterval("900"), 900);
  assert.throws(() => parseGitHubDeliveryAuditInterval("060"), /canonical positive integer/);
  assert.throws(() => parseGitHubDeliveryAuditInterval("59"), /60 through 900/);
  assert.throws(() => parseGitHubDeliveryAuditInterval("901"), /60 through 900/);
  assert.equal(githubDeliveryAuditRetrySeconds(1), 60);
  assert.equal(githubDeliveryAuditRetrySeconds(2), 300);
  assert.equal(githubDeliveryAuditRetrySeconds(3), 900);
  assert.equal(githubDeliveryAuditRetrySeconds(30), 900);
});

test("App-wide delivery-audit leases exclude overlap and recover after expiry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-github-audit-lease-test-"));
  const path = join(directory, "control.db");
  let now = new Date("2026-08-17T10:00:00.000Z");
  const first = new ControlPlaneStore(path, () => now);
  const second = new ControlPlaneStore(path, () => now);
  assert.deepEqual(first.githubDeliveryAuditState(), {
    scheduleVersion: 1,
    appId: null,
    healthyIntervalSeconds: 300,
    nextAuditAt: "2026-08-17T10:00:00.000Z",
    incompleteStreak: 0,
    inFlightRunId: null,
    inFlightStartedAt: null,
    inFlightExpiresAt: null,
    lastRunId: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastRunStatus: null,
    lastOutcome: null,
    lastRetryAt: null,
    lastCompleteBoundaryAt: null,
    completedRunCount: 0,
  });

  const firstClaim = first.claimGitHubDeliveryAudit("4567", 300);
  assert.equal(firstClaim.status, "claimed");
  if (firstClaim.status !== "claimed") return;
  assert.equal(firstClaim.expiresAt, "2026-08-17T10:10:00.000Z");
  const blocked = second.claimGitHubDeliveryAudit("4567", 300);
  assert.equal(blocked.status, "in-flight");

  now = new Date("2026-08-17T10:10:00.001Z");
  const recovered = second.claimGitHubDeliveryAudit("4567", 600);
  assert.equal(recovered.status, "claimed");
  if (recovered.status !== "claimed") return;
  assert.notEqual(recovered.runId, firstClaim.runId);
  assert.throws(
    () => first.completeGitHubDeliveryAudit({
      runId: firstClaim.runId,
      runStatus: "completed",
      outcome: "complete",
      sourceBoundaryAt: "2026-08-17T10:00:00.000Z",
      retryAt: null,
    }),
    /does not own the active lease/,
  );
  now = new Date("2026-08-17T10:10:05.000Z");
  const completed = second.completeGitHubDeliveryAudit({
    runId: recovered.runId,
    runStatus: "completed",
    outcome: "complete",
    sourceBoundaryAt: "2026-08-17T10:10:00.000Z",
    retryAt: null,
  });
  assert.equal(completed.appId, "4567");
  assert.equal(completed.healthyIntervalSeconds, 600);
  assert.equal(completed.nextAuditAt, "2026-08-17T10:20:05.000Z");
  assert.equal(completed.lastCompleteBoundaryAt, "2026-08-17T10:10:00.000Z");
  assert.throws(() => second.claimGitHubDeliveryAudit("9999", 600), /already bound to App 4567/);
  first.close();
  second.close();
});

test("delivery-audit controller runs acquisition outside SQLite and retains bounded retry state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-github-audit-controller-test-"));
  const path = join(directory, "control.db");
  let now = new Date("2026-08-17T12:00:00.000Z");
  const store = new ControlPlaneStore(path, () => now);
  const concurrent = new ControlPlaneStore(path, () => now);
  const complete: GitHubDeliveryAuditor = async () => {
    const independentWrite = concurrent.claimCorePoll(900);
    assert.equal(independentWrite.status, "claimed");
    return {
      kind: "complete",
      appId: "4567",
      coveredThrough: "2026-08-17T12:00:00.000Z",
      pageCount: 1,
      deliveryCount: 0,
      pageProofDigest: `sha256:${"1".repeat(64)}`,
      deliveries: [],
    };
  };
  const first = await runGitHubDeliveryAuditOnce(
    store,
    { appId: "4567", getAppJwt: () => jwt, now: () => now },
    300,
    complete,
  );
  assert.equal(first.status, "claimed");
  if (first.status !== "claimed") return;
  assert.equal(first.outcome, "complete");
  assert.equal(first.state.nextAuditAt, "2026-08-17T12:05:00.000Z");

  now = new Date("2026-08-17T12:05:00.000Z");
  const incomplete: GitHubDeliveryAuditor = async () => ({
    kind: "incomplete",
    appId: "4567",
    attemptedAt: now.toISOString(),
    cause: "source-unavailable",
    pageCount: 0,
    deliveryCount: 0,
    retryAt: "2026-08-17T12:15:00.000Z",
    diagnostic: "rate-limited",
  });
  const limited = await runGitHubDeliveryAuditOnce(
    store,
    { appId: "4567", getAppJwt: () => jwt, now: () => now },
    300,
    incomplete,
  );
  assert.equal(limited.status, "claimed");
  if (limited.status !== "claimed") return;
  assert.equal(limited.outcome, "source-unavailable");
  assert.equal(limited.state.incompleteStreak, 1);
  assert.equal(limited.state.nextAuditAt, "2026-08-17T12:15:00.000Z");
  assert.equal(limited.state.lastCompleteBoundaryAt, "2026-08-17T12:00:00.000Z");

  now = new Date("2026-08-17T12:15:00.000Z");
  const unsafeControllerDiagnostic = [
    "delivery fetch failed",
    "token=top-secret-token",
    "authorization=unsafe-authorization",
    "x".repeat(600),
  ].join("\n");
  const failed = await runGitHubDeliveryAuditOnce(
    store,
    { appId: "4567", getAppJwt: () => jwt, now: () => now },
    300,
    async () => {
      throw new Error(unsafeControllerDiagnostic);
    },
  );
  assert.equal(failed.status, "claimed");
  if (failed.status !== "claimed") return;
  assert.equal(failed.runStatus, "controller-error");
  assert.equal(failed.outcome, null);
  assert.equal(failed.diagnostic, null);
  assert.match(failed.controllerError ?? "", /^delivery fetch failed token=\[redacted\] authorization=\[redacted\]/);
  assert.ok(!failed.controllerError?.includes("top-secret-token"));
  assert.ok(!failed.controllerError?.includes("unsafe-authorization"));
  assert.ok(Buffer.byteLength(failed.controllerError ?? "", "utf8") <= 512);
  assert.equal(failed.retryAt, null);
  assert.equal(failed.sourceBoundaryAt, null);
  assert.equal(failed.state.incompleteStreak, 2);
  assert.equal(failed.state.nextAuditAt, "2026-08-17T12:20:00.000Z");
  assert.equal(failed.state.lastRunStatus, "controller-error");
  assert.equal(failed.state.lastOutcome, null);
  assert.equal(failed.state.lastRetryAt, null);
  store.close();
  concurrent.close();

  const reopened = new ControlPlaneStore(path, () => now);
  const reopenedState = reopened.githubDeliveryAuditState();
  assert.equal(reopenedState.completedRunCount, 3);
  assert.equal(reopenedState.lastRunStatus, "controller-error");
  assert.equal(reopenedState.lastOutcome, null);
  assert.equal(reopenedState.lastRetryAt, null);
  reopened.close();

  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE github_delivery_audit_state SET next_audit_at = ? WHERE singleton = 1")
    .run("2026-08-17T12:99:00.000Z");
  raw.close();
  assert.throws(() => new ControlPlaneStore(path), /GitHub next delivery-audit time/);
});
