export const workStatuses = ["proposed", "queued", "claimed", "completed", "blocked", "cancelled"] as const;
export type WorkStatus = (typeof workStatuses)[number];

export const allowedActions = [
  "read",
  "write",
  "run-tests",
  "open-issue",
  "open-pr",
  "create-followup",
] as const;
export type AllowedAction = (typeof allowedActions)[number];

/**
 * Fluent's own observation of a reported issue or pull request, taken through
 * the GitHub API at completion time and refreshed by `verify-artifacts`.
 * Workers never supply it; the MCP boundary rejects it as input.
 */
export type ArtifactVerification =
  | {
      status: "verified";
      verifiedAt: string;
      number: number;
      state: "open" | "closed" | "merged";
      headSha?: string;
      mergedAt?: string;
      closedAt?: string;
    }
  | { status: "unverified"; attemptedAt: string; reason: string };

export interface WorkArtifact {
  kind: "issue" | "pull-request" | "commit" | "report" | "other";
  url: string;
  description?: string;
  verification?: ArtifactVerification;
}

/**
 * Derived from a completed item's pull-request artifacts. Delivery is the
 * merge of the reported pull request, not the achievement of an outcome.
 */
export type DeliveryState = "none" | "unverified" | "open" | "closed" | "merged";

export interface WorkResult {
  summary: string;
  evidence: string[];
  artifacts: WorkArtifact[];
}

/**
 * A worker-proposed child. It carries no priority: scheduling priority is
 * operator-owned and children inherit their parent's value.
 */
export interface FollowUpInput {
  kind: string;
  objective: string;
  instructions: string;
  acceptanceCriteria: string[];
  allowedActions: AllowedAction[];
  delegableActions: AllowedAction[];
}

export interface WorkItem {
  id: string;
  rootId: string;
  parentId?: string;
  repository: string;
  kind: string;
  objective: string;
  instructions: string;
  acceptanceCriteria: string[];
  allowedActions: AllowedAction[];
  delegableActions: AllowedAction[];
  priority: number;
  status: WorkStatus;
  createdBy: string;
  /** Stable external origin of an imported root (for example a GitHub issue URL); unique per repository. */
  sourceRef?: string;
  createdAt: string;
  updatedAt: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  result?: WorkResult;
  /** Present on completed items: the delivery state derived from pull-request artifact verifications. */
  delivery?: DeliveryState;
}

export function deriveDelivery(result: WorkResult | undefined): DeliveryState {
  const pullRequests = (result?.artifacts ?? []).filter((artifact) => artifact.kind === "pull-request");
  if (pullRequests.length === 0) return "none";
  const states = pullRequests.map((artifact) =>
    artifact.verification?.status === "verified" ? artifact.verification.state : "unverified",
  );
  if (states.includes("merged")) return "merged";
  if (states.includes("unverified")) return "unverified";
  if (states.includes("open")) return "open";
  return "closed";
}

export type ObservableWorkItem = Omit<WorkItem, "leaseToken">;

export function withoutLeaseToken(item: WorkItem): ObservableWorkItem {
  const { leaseToken: _leaseToken, ...observable } = item;
  return observable;
}

export interface SeedWorkInput {
  repository: string;
  kind: string;
  objective: string;
  instructions: string;
  acceptanceCriteria: string[];
  allowedActions: AllowedAction[];
  delegableActions: AllowedAction[];
  priority?: number;
  createdBy: string;
}

/**
 * A root imported from an external source. It starts as `proposed` and needs
 * operator admission; `sourceRef` makes repeated imports idempotent.
 */
export interface ProposedRootInput extends Omit<SeedWorkInput, "repository"> {
  sourceRef: string;
}

export interface ClaimInput {
  worker: string;
  repository?: string;
  kinds?: string[];
  leaseSeconds?: number;
}

export interface CompletionInput {
  id: string;
  leaseToken: string;
  worker: string;
  result: WorkResult;
  followUps: FollowUpInput[];
}

export interface WorkEvent {
  sequence: number;
  workItemId: string;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

/**
 * One ledger event joined with the observable identity of the item it
 * belongs to. Read across items by `QueueStore.eventsSince`; never carries a
 * lease token, and event payloads never do either.
 */
export interface ObservedWorkEvent extends WorkEvent {
  repository: string;
  kind: string;
  sourceRef?: string;
  /** The item's current logical status at read time, not at event time. */
  status: WorkStatus;
}

export interface EventsSinceOptions {
  repository?: string;
  /** 1–500 events per page; defaults to 100. */
  limit?: number;
}
