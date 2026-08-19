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
      /** A pull request GitHub reports as a draft (ADR-0065); omitted when not a draft, so older records read as not-draft. */
      draft?: boolean;
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
export const deliveryStates = ["none", "unverified", "open", "closed", "merged"] as const;
export type DeliveryState = (typeof deliveryStates)[number];

export interface WorkResult {
  summary: string;
  evidence: string[];
  artifacts: WorkArtifact[];
  /**
   * The model the worker says it ran (for example `claude-opus-5`): descriptive
   * provenance under rule 13 — retained, never verified, grants nothing — so
   * a later review round can prefer a different model (ADR-0029, ADR-0065).
   */
  model?: string;
}

/** Shape of a worker-asserted model name: a short provider/model identifier, no whitespace. */
export const MODEL_NAME_PATTERN = /^[a-z0-9][a-z0-9._:/@-]{1,120}$/i;

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

/** The decision of one bounded pull-request review round (ADR-0029, ADR-0065). */
export const reviewDecisions = ["pass", "block", "unable-to-review"] as const;
export type ReviewDecision = (typeof reviewDecisions)[number];

/** At most this many blockers per review, per ADR-0029. */
export const MAX_REVIEW_BLOCKERS = 5;
/** At most this many advisories per review, per ADR-0029. */
export const MAX_REVIEW_ADVISORIES = 3;
/** Completed review rounds per pull request before human adjudication, per ADR-0029. */
export const MAX_REVIEW_ROUNDS = 3;

/** One material defect a reviewer found; the fingerprint is stable across rounds so a re-review can tell old from new. */
export interface ReviewBlocker {
  fingerprint: string;
  location: string;
  contract: string;
  impact: string;
  resolution: string;
  verification: string;
}

/** A non-blocking observation; never creates work and never prevents a pass. */
export interface ReviewAdvisory {
  fingerprint: string;
  text: string;
}

/** The structured verdict a `pr-review` worker supplies to `complete_work`. */
export interface ReviewResult {
  decision: ReviewDecision;
  blockers: ReviewBlocker[];
  advisories: ReviewAdvisory[];
}

/**
 * The review record a `pr-review` or `pr-review-fix` root is bound to
 * (ADR-0065). The sweep writes the binding fields at creation; a `pr-review`
 * completion merges its verdict in.
 */
export interface PullRequestReview {
  /** The pull request under review; the item's `sourceRef` is `pr-review:<url>@<headSha>` or `pr-review-fix:<url>@<headSha>`. */
  pullRequestUrl: string;
  /** Head commit the round is bound to; a push makes a new head and a new round. */
  headSha: string;
  /** Patch identity at creation, when computable; informational. */
  patchDigest?: string;
  /** 1-based review round for this pull request (rounds are counted per URL, not per head). */
  round: number;
  /** The completed item that reported the pull request, when known. */
  originItemId?: string;
  /** The model the origin item's worker reported, so the reviewer can prefer a different one. */
  authorModel?: string;
  /** The model the previous round's reviewer reported. */
  priorReviewerModel?: string;
  /** Blockers from the previous completed round on this pull request, carried verbatim. */
  priorBlockers: ReviewBlocker[];
  /** `pr-review-fix` only: the completed `pr-review` whose blockers it addresses, and that reviewer's model. */
  reviewItemId?: string;
  reviewerModel?: string;
  /** Merged in when a `pr-review` completes. */
  decision?: ReviewDecision;
  blockers?: ReviewBlocker[];
  advisories?: ReviewAdvisory[];
  reviewedAt?: string;
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
  /** Present on `pr-cure` roots: the head and patch identity the cure is bound to. */
  cure?: PullRequestCure;
  /** Present on `pr-review` and `pr-review-fix` roots: the pull-request head and round the item is bound to (ADR-0065). */
  review?: PullRequestReview;
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

/** An admitted `pr-review` or `pr-review-fix` root: one per pull-request head and kind, keyed by `sourceRef` (ADR-0065). */
export interface ReviewRootInput extends Omit<SeedWorkInput, "repository"> {
  sourceRef: string;
  review: PullRequestReview;
}

export interface ClaimInput {
  worker: string;
  repository?: string;
  kinds?: string[];
  leaseSeconds?: number;
  /** The client's self-declared name, recorded beside a transport-established `worker` as a label (ADR-0063). */
  label?: string;
}

export interface CompletionInput {
  id: string;
  leaseToken: string;
  worker: string;
  result: WorkResult;
  followUps: FollowUpInput[];
  /** Required on a `pr-review` item, refused on every other kind (ADR-0065). */
  review?: ReviewResult;
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
