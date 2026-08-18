import { refreshArtifactVerifications, type ArtifactVerifierOptions } from "../queue/artifact-verification.ts";
import { PreconditionMismatchError, type MutationPrecondition, type QueueStore } from "../queue/store.ts";
import { workStatuses, type WorkStatus } from "../queue/types.ts";

/** Every browser decision is attributed to this actor, distinct from `operator:cli`. */
export const WEB_ACTOR = "operator:web";

/** The item mutations the surface offers: exactly the CLI's operator commands. */
export const itemMutations = ["approve", "reject", "defer", "requeue", "cancel", "prioritize", "note"] as const;
export type ItemMutation = (typeof itemMutations)[number];

/** A form field was missing or malformed; rendered as 400 with the message. */
export class MutationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MutationInputError";
  }
}

export interface MutationOutcome {
  /** The ledger event type the mutation recorded, shown in the result banner. */
  eventType: string;
}

/**
 * The precondition every mutation form carries from render (`status` and
 * `updatedAt` hidden fields). Both are required: a form without them is a
 * malformed request, not a request to skip the stale-intent check.
 */
export function parsePrecondition(body: Record<string, unknown>): MutationPrecondition {
  const status = field(body, "status");
  const updatedAt = field(body, "updatedAt");
  if (!(workStatuses as readonly string[]).includes(status)) throw new MutationInputError(`status must be one of ${workStatuses.join(", ")}`);
  if (Number.isNaN(Date.parse(updatedAt))) throw new MutationInputError("updatedAt must be an ISO 8601 timestamp");
  return { status: status as WorkStatus, updatedAt };
}

/**
 * Where to send the operator back after a mutation: the same-origin path the
 * form named, or the item page when it named nothing usable. Absolute URLs,
 * protocol-relative paths, and anything not starting with `/` are ignored so
 * a crafted form cannot redirect off-host.
 */
export function returnPath(body: Record<string, unknown>, fallback: string): string {
  const raw = body.return;
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /\s/.test(raw)) {
    return fallback;
  }
  return raw.split("?")[0]!.split("#")[0]!;
}

/**
 * Applies one item mutation through the store method the CLI uses, attributed
 * `operator:web` and guarded by the rendered precondition. Throws
 * `PreconditionMismatchError` untouched so the caller can render the item's
 * current state; other store errors surface as their message.
 */
export function applyItemMutation(queue: QueueStore, mutation: ItemMutation, id: string, body: Record<string, unknown>): MutationOutcome {
  const precondition = parsePrecondition(body);
  switch (mutation) {
    case "approve":
      queue.approve(id, WEB_ACTOR, precondition);
      return { eventType: "work.approved" };
    case "reject":
      queue.reject(id, WEB_ACTOR, reason(body, "a rejection reason"), precondition);
      return { eventType: "work.rejected" };
    case "defer":
      queue.defer(id, WEB_ACTOR, reason(body, "a deferral reason"), precondition);
      return { eventType: "work.deferred" };
    case "requeue":
      queue.requeue(id, WEB_ACTOR, reason(body, "a note for the next lease"), precondition);
      return { eventType: "work.requeued" };
    case "cancel":
      queue.cancel(id, WEB_ACTOR, reason(body, "a cancellation reason"), precondition);
      return { eventType: "work.cancelled" };
    case "prioritize": {
      const raw = field(body, "priority");
      if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new MutationInputError("priority must be an integer");
      queue.prioritize(id, WEB_ACTOR, Number(raw), reason(body, "a prioritize reason"), precondition);
      return { eventType: "work.prioritized" };
    }
    case "note":
      queue.note(id, WEB_ACTOR, reason(body, "note text"), precondition);
      return { eventType: "work.noted" };
  }
}

/**
 * Re-checks one repository's pending issue and pull-request artifacts against
 * GitHub, attributed `operator:web`. Not a queue-state mutation: it records
 * `artifact.verified` observations only, exactly like `queue -- verify-artifacts`.
 */
export async function applyVerifyArtifacts(
  queue: QueueStore,
  repository: string,
  verifier: ArtifactVerifierOptions,
): Promise<MutationOutcome & { checked: number; updated: number; unavailable: number; rejected: number }> {
  const result = await refreshArtifactVerifications(queue, { ...verifier, repository, actor: WEB_ACTOR });
  return {
    eventType: result.updated.length + result.rejected.length > 0 ? "artifact.verified" : "artifact.unchanged",
    checked: result.checked,
    updated: result.updated.length,
    unavailable: result.unavailable.length,
    rejected: result.rejected.length,
  };
}

export function isPreconditionMismatch(error: unknown): error is PreconditionMismatchError {
  return error instanceof PreconditionMismatchError;
}

function field(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (typeof value !== "string" || value.length === 0) throw new MutationInputError(`${name} is required`);
  return value;
}

function reason(body: Record<string, unknown>, what: string): string {
  const value = body.reason;
  if (typeof value !== "string" || value.trim().length === 0) throw new MutationInputError(`Enter ${what}.`);
  return value.trim();
}
