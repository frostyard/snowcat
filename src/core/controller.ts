import type { CoreGitSourceConfig } from "./git-source.ts";
import { sanitizeCoreDiagnostic, synchronizeCoreSource, type CoreSynchronizationResult } from "./synchronize.ts";
import {
  ControlPlaneStore,
  type CoreCheckDetailPruneResult,
  type CorePollClaimResult,
  type CorePollState,
} from "../control/store.ts";
import {
  reconcileRepositories,
  type RepositoryReconciliationPassResult,
} from "../repository/controller.ts";

export type CoreSourceSynchronizer = typeof synchronizeCoreSource;
export type RepositoryReconciler = typeof reconcileRepositories;

export type CorePollOnceResult =
  | Extract<CorePollClaimResult, { status: "not-due" | "in-flight" }>
  | {
      status: "claimed";
      runId: string;
      sourceOutcome: CoreSynchronizationResult["outcome"] | null;
      checkDisposition: CoreSynchronizationResult["checkDisposition"] | "none";
      synchronizationStatus: CoreSynchronizationResult["status"] | "controller-error";
      activation: "activated" | "unchanged" | null;
      pruneResult: CoreCheckDetailPruneResult | null;
      repositoryReconciliation: RepositoryReconciliationPassResult | null;
      sourceFailure: string | null;
      controllerError: string | null;
      state: CorePollState;
    };

export async function runCorePollOnce(
  store: ControlPlaneStore,
  config: CoreGitSourceConfig,
  healthyIntervalSeconds: number,
  synchronize: CoreSourceSynchronizer = synchronizeCoreSource,
  reconcile: RepositoryReconciler | undefined = undefined,
): Promise<CorePollOnceResult> {
  const claim = store.claimCorePoll(healthyIntervalSeconds);
  if (claim.status !== "claimed") return claim;

  let synchronization: CoreSynchronizationResult | null = null;
  let pruneResult: CoreCheckDetailPruneResult | null = null;
  let repositoryReconciliation: RepositoryReconciliationPassResult | null = null;
  let controllerError: Error | null = null;
  try {
    synchronization = await synchronize(config, store, claim.controlPlaneSequence);
    if (synchronization.diagnosticError) controllerError = synchronization.diagnosticError;
    if (synchronization.status === "accepted" && controllerError === null && reconcile) {
      repositoryReconciliation = await reconcile(store);
    }
    if (claim.pruneDue && controllerError === null) {
      try {
        pruneResult = store.pruneCoreCheckDetail({
          expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
        });
      } catch (error) {
        controllerError = error instanceof Error ? error : new Error(String(error));
      }
    }
  } catch (error) {
    controllerError = error instanceof Error ? error : new Error(String(error));
  }

  const state = store.completeCorePoll({
    runId: claim.runId,
    runStatus: controllerError === null ? "completed" : "controller-error",
    sourceOutcome: synchronization?.outcome ?? null,
    checkDisposition: synchronization?.checkDisposition ?? "none",
    pruneRan: pruneResult !== null,
  });
  return {
    status: "claimed",
    runId: claim.runId,
    sourceOutcome: synchronization?.outcome ?? null,
    checkDisposition: synchronization?.checkDisposition ?? "none",
    synchronizationStatus: controllerError === null ? (synchronization?.status ?? "controller-error") : "controller-error",
    activation: synchronization?.activation ?? null,
    pruneResult,
    repositoryReconciliation,
    sourceFailure: synchronization?.failure ? sanitizeCoreDiagnostic(synchronization.failure.message) : null,
    controllerError: controllerError ? sanitizeCoreDiagnostic(controllerError.message) : null,
    state,
  };
}

/**
 * Run the Core polling loop until `shouldStop()` reports a stop request.
 *
 * `stopSignal` is the same stop request the caller wires to SIGINT and
 * SIGTERM: aborting it wakes the loop out of its scheduled wait immediately
 * instead of leaving the process to sit out the remaining bounded delay. It
 * changes nothing about poll cadence or lease semantics — a woken wait always
 * re-tests `shouldStop()` and returns without claiming.
 */
export async function runCorePollingLoop(
  store: ControlPlaneStore,
  config: CoreGitSourceConfig,
  healthyIntervalSeconds: number,
  shouldStop: () => boolean,
  emit: (result: CorePollOnceResult) => void,
  reconcile: RepositoryReconciler | undefined = undefined,
  stopSignal: AbortSignal | undefined = undefined,
): Promise<void> {
  let lastWaitingKey: string | null = null;
  while (!shouldStop()) {
    const result = await runCorePollOnce(store, config, healthyIntervalSeconds, synchronizeCoreSource, reconcile);
    const waitingKey =
      result.status === "in-flight"
        ? `in-flight:${result.runId}:${result.expiresAt}`
        : result.status === "not-due"
          ? `not-due:${result.nextPollAt}`
          : null;
    if (waitingKey === null || waitingKey !== lastWaitingKey) emit(result);
    lastWaitingKey = waitingKey;
    if (shouldStop()) return;
    const wakeAt =
      result.status === "in-flight"
        ? result.expiresAt
        : result.status === "not-due"
          ? result.nextPollAt
          : result.state.nextPollAt;
    const remaining = Math.max(0, new Date(wakeAt).getTime() - Date.now());
    await waitForStopOrDelay(Math.min(remaining, 60_000), stopSignal);
  }
}

/**
 * Wait up to `milliseconds`, resolving as soon as `stopSignal` aborts. Without
 * a signal — or once the signal is already aborted — the behavior is exactly
 * the plain bounded delay the loop waited on before, so cadence is unchanged.
 * Whichever side settles first clears the timer and drops the abort listener.
 */
export function waitForStopOrDelay(
  milliseconds: number,
  stopSignal: AbortSignal | undefined = undefined,
): Promise<void> {
  if (stopSignal?.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopSignal?.removeEventListener("abort", settle);
      resolvePromise();
    };
    const timer = setTimeout(settle, milliseconds);
    stopSignal?.addEventListener("abort", settle, { once: true });
  });
}
