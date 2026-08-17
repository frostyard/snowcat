import {
  ControlPlaneStore,
  type GitHubDeliveryAuditClaimResult,
  type GitHubDeliveryAuditOperationalOutcome,
  type GitHubDeliveryAuditState,
} from "../control/store.ts";
import {
  auditGitHubAppDeliveries,
  type GitHubDeliveryAuditInput,
  type GitHubDeliveryAuditResult,
} from "./delivery-api.ts";

export type GitHubDeliveryAuditor = typeof auditGitHubAppDeliveries;

export type GitHubDeliveryAuditOnceResult =
  | Extract<GitHubDeliveryAuditClaimResult, { status: "not-due" | "in-flight" }>
  | {
      status: "claimed";
      runId: string;
      runStatus: "completed" | "controller-error";
      outcome: GitHubDeliveryAuditOperationalOutcome | null;
      diagnostic: Extract<GitHubDeliveryAuditResult, { kind: "incomplete" }>["diagnostic"] | "controller-error" | null;
      pageCount: number;
      deliveryCount: number;
      sourceBoundaryAt: string | null;
      retryAt: string | null;
      state: GitHubDeliveryAuditState;
    };

export async function runGitHubDeliveryAuditOnce(
  store: ControlPlaneStore,
  config: GitHubDeliveryAuditInput,
  healthyIntervalSeconds: number,
  audit: GitHubDeliveryAuditor = auditGitHubAppDeliveries,
): Promise<GitHubDeliveryAuditOnceResult> {
  const claim = store.claimGitHubDeliveryAudit(config.appId, healthyIntervalSeconds);
  if (claim.status !== "claimed") return claim;

  let result: GitHubDeliveryAuditResult | null = null;
  let controllerError = false;
  try {
    result = await audit(config);
    if (result.appId !== config.appId) {
      result = null;
      controllerError = true;
    }
  } catch {
    controllerError = true;
  }

  const state = store.completeGitHubDeliveryAudit({
    runId: claim.runId,
    runStatus: controllerError ? "controller-error" : "completed",
    outcome: result === null ? null : result.kind === "complete" ? "complete" : result.cause,
    sourceBoundaryAt: result?.kind === "complete" ? result.coveredThrough : null,
    retryAt: result?.kind === "incomplete" ? result.retryAt : null,
  });
  return {
    status: "claimed",
    runId: claim.runId,
    runStatus: controllerError ? "controller-error" : "completed",
    outcome: result === null ? null : result.kind === "complete" ? "complete" : result.cause,
    diagnostic: controllerError
      ? "controller-error"
      : result?.kind === "incomplete"
        ? result.diagnostic
        : null,
    pageCount: result?.pageCount ?? 0,
    deliveryCount: result?.deliveryCount ?? 0,
    sourceBoundaryAt: result?.kind === "complete" ? result.coveredThrough : null,
    retryAt: result?.kind === "incomplete" ? result.retryAt : null,
    state,
  };
}

export async function runGitHubDeliveryAuditLoop(
  store: ControlPlaneStore,
  config: GitHubDeliveryAuditInput,
  healthyIntervalSeconds: number,
  shouldStop: () => boolean,
  emit: (result: GitHubDeliveryAuditOnceResult) => void,
): Promise<void> {
  let lastWaitingKey: string | null = null;
  while (!shouldStop()) {
    const result = await runGitHubDeliveryAuditOnce(store, config, healthyIntervalSeconds);
    const waitingKey = result.status === "in-flight"
      ? `in-flight:${result.runId}:${result.expiresAt}`
      : result.status === "not-due"
        ? `not-due:${result.nextAuditAt}`
        : null;
    if (waitingKey === null || waitingKey !== lastWaitingKey) emit(result);
    lastWaitingKey = waitingKey;
    if (shouldStop()) return;
    const wakeAt = result.status === "in-flight"
      ? result.expiresAt
      : result.status === "not-due"
        ? result.nextAuditAt
        : result.state.nextAuditAt;
    const remaining = Math.max(0, new Date(wakeAt).getTime() - Date.now());
    await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(remaining, 60_000)));
  }
}
