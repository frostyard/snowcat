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
 * Snowcat's own observation of a reported issue or pull request, taken through
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

export const operatorNoteActions = ["requeue", "defer", "prioritize", "note"] as const;
export type OperatorNoteAction = (typeof operatorNoteActions)[number];

/**
 * One operator- or policy-authored annotation carried on the item itself, so
 * the next lease sees what happened on earlier ones. Requeue and deferral
 * append their reason; `note` appends without a state change. Workers never
 * write these: the store rejects actors outside the operator and policy
 * namespaces and no MCP tool exposes them.
 */
export interface OperatorNote {
  at: string;
  actor: string;
  action: OperatorNoteAction;
  reason: string;
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

/** The pull-request cure a `pr-cure` root was created for (ADR-0061). */
export interface PullRequestCure {
  /** The pull request being cured; the item's `sourceRef` is `<url>@<headSha>`. */
  pullRequestUrl: string;
  /** Head commit at creation; a push makes a new head and a new item. */
  headSha: string;
  /** Digest of the patch's identity at creation; `complete_work` refuses a `pr-cure` whose patch changed. */
  patchDigest: string;
  /** Why the head was judged decayed. */
  decay: PullRequestDecay[];
  /** The completed item that reported the pull request, when known. */
  originItemId?: string;
}

export const pullRequestDecays = ["behind", "dirty", "failing-checks", "changes-requested", "unresolved-threads"] as const;
export type PullRequestDecay = (typeof pullRequestDecays)[number];

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
  /** Present on `pr-cure` roots: the head and patch identity the cure is bound to. */
  cure?: PullRequestCure;
  createdAt: string;
  updatedAt: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  result?: WorkResult;
  /** Present on completed items: the delivery state derived from pull-request artifact verifications. */
  delivery?: DeliveryState;
  /** Operator and policy annotations, oldest first; never written by workers. */
  operatorNotes: OperatorNote[];
  /** Results superseded by an operator requeue, oldest first: each is the block result the requeue cleared. */
  previousResults: WorkResult[];
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

/** An admitted `pr-cure` root: one per pull-request head, keyed by `sourceRef`. */
export interface CureRootInput extends Omit<SeedWorkInput, "repository"> {
  sourceRef: string;
  cure: PullRequestCure;
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
 * One ledger event joined with its item's identifying fields and current
 * logical status, as read across items by `QueueStore.eventsSince`. Event
 * payloads never carry a lease token, and neither does this projection.
 */
export interface ObservedWorkEvent extends WorkEvent {
  repository: string;
  kind: string;
  sourceRef?: string;
  status: WorkStatus;
}
