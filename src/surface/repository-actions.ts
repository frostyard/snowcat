import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { ControlPlaneStore } from "../control/store.ts";
import type { GitHubFetch } from "../repository/github-api.ts";
import { importLabeledIssues } from "../queue/github-issues.ts";
import { enqueueDogfoodBatch } from "../queue/seeds.ts";
import type { QueueStore } from "../queue/store.ts";
import { MutationInputError, type MutationOutcome } from "./mutations.ts";

/** A repository action that needs the control plane but the host has none configured. */
export class ControlPlaneUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneUnavailableError";
  }
}

/** The control plane moved between the read and the write; the operator should look again and retry. */
export class ControlPlaneConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ControlPlaneConflictError";
  }
}

/** The GitHub listing failed; nothing was imported. */
export class GitHubListingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubListingError";
  }
}

/**
 * Board "Import issues": the same import the CLI runs for one repository,
 * with the label (default `fluent`) and optional priority from the form.
 * Imported items are proposals; the operator admits them from the inbox.
 */
export async function applyImportIssues(
  queue: QueueStore,
  repository: string,
  body: Record<string, unknown>,
  fetcher: GitHubFetch | undefined,
): Promise<MutationOutcome & { fetched: number; created: number; skipped: number }> {
  const rawLabel = typeof body.label === "string" && body.label.trim().length > 0 ? body.label.trim() : "fluent";
  const rawPriority = typeof body.priority === "string" ? body.priority.trim() : "";
  let priority: number | undefined;
  if (rawPriority.length > 0) {
    if (!/^-?\d+$/.test(rawPriority) || !Number.isSafeInteger(Number(rawPriority))) throw new MutationInputError("priority must be an integer");
    priority = Number(rawPriority);
  }
  let result;
  try {
    result = await importLabeledIssues(queue, repository, rawLabel, { priority, fetcher });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/^label must be|^repository must be/.test(text)) throw new MutationInputError(text);
    throw new GitHubListingError(text);
  }
  return {
    eventType: result.created.length > 0 ? "work.proposed" : "import.unchanged",
    fetched: result.fetched,
    created: result.created.length,
    skipped: result.skippedSourceRefs.length,
  };
}

/** Board "Seed dogfood": the standing discovery roots with the default 24-hour no-finding cooldown. */
export function applySeedDogfood(
  queue: QueueStore,
  repository: string,
): MutationOutcome & { created: string[]; skippedKinds: string[]; cooledKinds: string[] } {
  const result = enqueueDogfoodBatch(queue, repository);
  return {
    eventType: result.created.length > 0 ? "work.queued" : "seed.unchanged",
    created: result.created.map((item) => item.kind),
    skippedKinds: result.skippedKinds,
    cooledKinds: result.cooledKinds,
  };
}

/**
 * Board "Hold" / "Clear hold": the attributed local-operator repository
 * safety decision, exactly what `repository -- hold | clear-hold` records.
 * The control-plane store is opened fresh, its `lastTransactionSequence` and
 * the repository's current hold are read in this same call, and the decision
 * is written against that sequence; a concurrent write surfaces as
 * `ControlPlaneConflictError` for the operator to look again.
 */
export function applyRepositoryHold(
  controlPlanePath: string | undefined,
  repository: string,
  choice: "impose" | "clear",
  body: Record<string, unknown>,
): MutationOutcome & { repositoryId: string; effectiveState: string } {
  if (!controlPlanePath) throw new ControlPlaneUnavailableError("FLUENT_CONTROL_DB is not configured on this host, so repository holds are unavailable here.");
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length === 0) throw new MutationInputError(`Enter a reason to ${choice === "impose" ? "hold" : "clear the hold on"} ${repository}.`);
  const path = resolve(controlPlanePath);
  if (!existsSync(path)) throw new ControlPlaneUnavailableError(`control-plane database does not exist: ${path} (FLUENT_CONTROL_DB)`);
  const store = new ControlPlaneStore(path);
  try {
    const status = store.repositoryStatuses().find((candidate) => `${candidate.owner}/${candidate.name}`.toLowerCase() === repository.toLowerCase());
    if (!status) throw new MutationInputError(`${repository} is not declared in the active Core snapshot, so it cannot be held.`);
    if (status.githubResult !== "matched") throw new MutationInputError(`${repository} has no matched GitHub identity yet, so it cannot be held.`);
    const expectedLastTransactionSequence = store.metadata().lastTransactionSequence;
    try {
      if (choice === "impose") {
        store.imposeRepositoryOperatorHold({ expectedLastTransactionSequence, repositoryId: status.repositoryId, reason });
      } else {
        if (!status.operatorHold) throw new MutationInputError(`${repository} has no active operator hold to clear.`);
        store.clearRepositoryOperatorHold({
          expectedLastTransactionSequence,
          repositoryId: status.repositoryId,
          holdDecisionId: status.operatorHold.holdDecisionId,
          reason,
        });
      }
    } catch (error) {
      if (error instanceof MutationInputError) throw error;
      const text = error instanceof Error ? error.message : String(error);
      if (/stale control-plane sequence|clock moved backwards/.test(text)) throw new ControlPlaneConflictError(text);
      throw new MutationInputError(text);
    }
    const after = store.repositoryStatuses().find((candidate) => candidate.repositoryId === status.repositoryId);
    return {
      eventType: choice === "impose" ? "repository.hold-imposed" : "repository.hold-cleared",
      repositoryId: status.repositoryId,
      effectiveState: after?.effectiveState ?? "unknown",
    };
  } finally {
    store.close();
  }
}
