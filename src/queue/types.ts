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
 * The artifact kind a completion of this item must report (ADR-0069): the
 * item's explicit delivery contract. `pull-request` means the item is a
 * change that lands through one pull request and `complete_work` refuses a
 * completion that reports none; `none` means completion is judged on the
 * result alone. Declared by whoever defines the item — a feeder, an import,
 * a sweep, or the worker proposing a follow-up — and never inferred from the
 * item's kind or actions; nothing changes it afterwards.
 */
export const requiredArtifacts = ["none", "pull-request"] as const;
export type RequiredArtifact = (typeof requiredArtifacts)[number];

/**
 * Where a work item's execution happens (ADR-0073): a checkout to read and
 * run checks mutating nothing; a fresh branch from a fresh default-branch
 * base delivering a new pull request; or the bound pull request's branch at
 * exactly the recorded head. Declared by the definer, never inferred from
 * kind or actions; absent only on items defined before the rung that added
 * it (undeclared legacy, listed by `audit-contracts`).
 */
export const executionTargets = ["read-only", "new-pull-request", "existing-pull-request"] as const;
export type ExecutionTarget = (typeof executionTargets)[number];

/** A governance action decision as core's repository-agent-governance schema v1 states it. */
export type PolicyDecision = "allow" | "review-required" | "deny";

/** One protected boundary from the repository's governance policy: paths a change may touch only under the named decision and minimum risk tier. */
export interface PolicyBoundary {
  id: string;
  decision: PolicyDecision;
  minimumRiskTier: string;
  paths: string[];
}

/**
 * How an item's `review-required` acts were satisfied (ADR-0074): a human
 * admission decision, or a standing authorization — the closed in-code
 * registry entry naming the Accepted ADR that pre-authorizes one mechanical
 * admission path.
 */
export interface PolicyAuthorization {
  kind: "operator" | "standing";
  /** The admitting principal (`operator` kind). */
  actor?: string;
  /** The registry entry and its authorizing ADR (`standing` kind). */
  standingId?: string;
  adr?: string;
  /** The `review-required` actions this decision covered, sorted. */
  coveredActions: AllowedAction[];
  at: string;
}

/**
 * The policy a work item was defined and admitted under (ADR-0074): the Core
 * snapshot and the repository commit whose governance surface was judged,
 * the actions that policy marks review-required, and — once admitted — the
 * authorization that satisfied them. Absent on items defined without a
 * control-plane store or before the rung that added it (unbound legacy,
 * listed by `audit-contracts`).
 */
export interface PolicyRecord {
  coreSnapshotId: string;
  repositoryCommitId: string | null;
  reviewRequired: AllowedAction[];
  authorization?: PolicyAuthorization;
}

/**
 * Snowcat's own observation of a reported issue, pull request, or release,
 * taken through the GitHub API at completion time and refreshed by
 * `verify-artifacts`. Workers never supply it; the MCP boundary rejects it as
 * input.
 */
export type ArtifactVerification =
  | {
      status: "verified";
      verifiedAt: string;
      /** The issue or pull-request number, or — for a release — GitHub's own release id. */
      number: number;
      state: "open" | "closed" | "merged" | "published" | "draft";
      headSha?: string;
      mergedAt?: string;
      closedAt?: string;
      /** A pull request GitHub reports as a draft (ADR-0065); omitted when not a draft, so older records read as not-draft. */
      draft?: boolean;
      /** A release's observed `tag_name` (ADR-0066); the URL names a tag, not a number. */
      tag?: string;
      /** A release's observed `published_at`; absent while the release is still a draft. */
      publishedAt?: string;
    }
  | { status: "unverified"; attemptedAt: string; reason: string };

/**
 * A Git tag as a GitHub release URL may carry it (ADR-0066): printable, no
 * whitespace, bounded, and — since the decoded tag becomes one path segment of
 * the API read — never a leading `-` and never a `..` component.
 */
export const RELEASE_TAG_PATTERN = /^(?!-)(?!.*\.\.)[A-Za-z0-9._+/-]{1,128}$/;

/**
 * The one shape a predecessor source reference may take (ADR-0066): an
 * absolute GitHub issue URL over HTTPS. Deliberately case-sensitive — the
 * scheme, host, and `/issues/` segment are matched verbatim so a stored edge
 * is byte-identical to the `sourceRef` of the item it names. The store
 * validates against this pattern and the `depends-on:` parser accepts against
 * the same constant, so the writer can never produce a value the reader
 * refuses.
 */
export const PREDECESSOR_URL_PATTERN = /^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/[1-9][0-9]*$/;

export interface WorkArtifact {
  kind: "issue" | "pull-request" | "release" | "commit" | "report" | "other";
  url: string;
  description?: string;
  verification?: ArtifactVerification;
}

/**
 * Derived from a completed item's pull-request and release artifacts.
 * Delivery is the merge of the reported pull request or the publication of the
 * reported release, not the achievement of an outcome (ADR-0031, ADR-0066).
 */
export const deliveryStates = ["none", "unverified", "open", "closed", "merged", "published"] as const;
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

/**
 * The MCP tools the queue contract exposes (ADR-0063, ADR-0070). The server
 * registers exactly these; a minted token's tool grant (rule 65) names a
 * subset and the server registers only the granted ones for that client.
 */
export const mcpToolNames = [
  "list_work",
  "get_work",
  "claim_work",
  "heartbeat_work",
  "complete_work",
  "block_work",
  "release_work",
] as const;
export type McpToolName = (typeof mcpToolNames)[number];

/**
 * Named tool grants an operator can mint by profile instead of listing tools
 * (ADR-0070). `observer` is the observation-only profile: the two read tools
 * and nothing that takes, renews, or ends a lease.
 */
export const mcpTokenProfiles = {
  observer: ["get_work", "list_work"],
} as const satisfies Record<string, readonly McpToolName[]>;
export type McpTokenProfile = keyof typeof mcpTokenProfiles;

export const operatorNoteActions = ["requeue", "defer", "prioritize", "note", "release-lease"] as const;
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
  /**
   * The proposer's explicit delivery contract for the child (ADR-0069):
   * required, never defaulted, so a worker states whether the child is a
   * change that lands through a pull request. A child granting `write` must
   * declare `pull-request`, and `pull-request` needs `open-pr` in
   * `allowedActions`; the store refuses the whole completion otherwise.
   */
  requiredArtifact: RequiredArtifact;
  /** Where the child executes (ADR-0073); required on every follow-up, like `requiredArtifact`. */
  executionTarget: ExecutionTarget;
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

/**
 * ADR-0061: the follow-up kind a `pr-cure` worker proposes when curing the head
 * needs the patch to change. It works on the pull request its parent is already
 * bound to, so it inherits the parent's cure record rather than naming one of
 * its own — the proposer has no way to supply a binding, deliberately.
 */
export const CURE_CHANGE_KIND = "pr-cure-change";

export const pullRequestDecays = ["behind", "dirty", "failing-checks", "changes-requested", "unresolved-threads", "bad-title"] as const;
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

/**
 * One open pull request in a review-gated repository that no completed item
 * reported and no `pr-review`, `pr-review-fix`, or `pr-cure` item is bound to
 * (ADR-0065): invisible to the gate until a human closes it or attaches it to
 * the item that should have reported it. Never work by itself.
 */
export interface UnreportedPullRequest {
  url: string;
  number: number;
  draft: boolean;
  /** GitHub's `created_at` for the pull request, when the listing carried it. */
  createdAt?: string;
}

/** The whole finding of one review sweep for one repository; each pass overwrites it, an empty list included. */
export interface UnreportedPullRequestObservation {
  observedAt: string;
  pullRequests: UnreportedPullRequest[];
}

export type LabeledIssueObservationOutcome = "created" | "existing";

/** One labeled open issue seen by the latest successful import for a repository. */
export interface LabeledIssueObservation {
  url: string;
  title: string;
  seenAt: string;
  outcome: LabeledIssueObservationOutcome;
}

/** The bounded, whole-replacement finding from the latest successful issue import. */
export interface LabeledIssueObservations {
  issues: LabeledIssueObservation[];
  truncated: boolean;
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
  /** The item's delivery contract (ADR-0069): what a completion must report. */
  requiredArtifact: RequiredArtifact;
  /** Where execution happens (ADR-0073); absent on items defined before rung 16 (undeclared legacy). */
  executionTarget?: ExecutionTarget;
  /** The policy binding and admission evidence (ADR-0074); absent on unbound legacy rows. */
  policy?: PolicyRecord;
  priority: number;
  status: WorkStatus;
  createdBy: string;
  /** Stable external origin of an imported root (for example a GitHub issue URL); unique per repository. */
  sourceRef?: string;
  /**
   * Source references of the items this one waits for (ADR-0066), sorted and
   * deduplicated; absent when the item declares none. They grant nothing and
   * reorder nothing: they only withhold this item from claim selection until
   * every one of them names a completed item whose artifacts Snowcat has
   * observed delivered.
   */
  predecessors?: readonly string[];
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
  /** Present on completed items: the delivery state derived from pull-request and release artifact verifications. */
  delivery?: DeliveryState;
  /** Operator and policy annotations, oldest first; never written by workers. */
  operatorNotes: OperatorNote[];
  /** Results superseded by an operator requeue, oldest first: each is the block result the requeue cleared. */
  previousResults: WorkResult[];
}

export function deriveDelivery(result: WorkResult | undefined): DeliveryState {
  // A release slice's delivery boundary is the tag a human published
  // (ADR-0066), so where a release was reported it — not a pull request that
  // merely prepared it — decides. Items with no release artifact take exactly
  // the pull-request derivation they always did.
  const releases = (result?.artifacts ?? []).filter((artifact) => artifact.kind === "release");
  if (releases.length > 0) {
    const releaseStates = releases.map((artifact) =>
      artifact.verification?.status === "verified" ? artifact.verification.state : "unverified",
    );
    if (releaseStates.includes("published")) return "published";
    if (releaseStates.includes("unverified")) return "unverified";
    return "open";
  }
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

/** How an attempt ended; absent on the attempt that still holds the lease. */
export const attemptOutcomes = ["completed", "blocked", "released", "expired"] as const;
export type AttemptOutcome = (typeof attemptOutcomes)[number];

/**
 * One lease on an item as the ledger recorded it: who took it (the
 * transport-established principal), the exact client label supplied at claim
 * time, and — once the lease ended — how. Derived from the item's own
 * `work.claimed`, `work.completed`, `work.blocked`, `work.released`, and
 * `lease.expired` events, never stored separately, so it is exact after every
 * terminal transition and bounded by the newest `MAX_ITEM_ATTEMPTS` leases.
 * `sequence` is the claim event's ledger sequence: a stable, unique attempt
 * id that needs no ordering or timestamp to correlate. It carries no lease
 * token — the ledger never holds one — and no worker text beyond the label.
 */
export interface WorkAttempt {
  /** The `work.claimed` event's sequence: the attempt's identity. */
  sequence: number;
  claimedAt: string;
  /** The principal that holds or held the lease (`leaseOwner` while active). */
  worker: string;
  /** The client's self-declared name at claim time, verbatim (rule 48); absent when none was supplied. */
  label?: string;
  /** The credential's claim restriction that bounded this lease, when one applied. */
  kindsRestriction?: string[];
  /** Absent while this attempt holds the lease. */
  outcome?: AttemptOutcome;
  endedAt?: string;
  /** The actor that ended the attempt: the worker principal, or `system` for an expiry observed at reclaim. */
  endedBy?: string;
}

/** Attempts an observer can read per item: the newest leases, oldest first. */
export const MAX_ITEM_ATTEMPTS = 10;

/** The read-only MCP projection of an item: its bookkeeping plus its bounded attempt history. */
export interface ObservableWorkItemWithAttempts extends ObservableWorkItem {
  attempts: WorkAttempt[];
}

export interface SeedWorkInput {
  repository: string;
  kind: string;
  objective: string;
  instructions: string;
  acceptanceCriteria: string[];
  allowedActions: AllowedAction[];
  delegableActions: AllowedAction[];
  /** Delivery contract (ADR-0069); `none` when omitted. `pull-request` requires `open-pr` in `allowedActions`. */
  requiredArtifact?: RequiredArtifact;
  /** Where the item executes (ADR-0073); required on every new definition, never inferred. */
  executionTarget: ExecutionTarget;
  priority?: number;
  createdBy: string;
}

/**
 * A root imported from an external source. It starts as `proposed` and needs
 * operator admission; `sourceRef` makes repeated imports idempotent.
 */
export interface ProposedRootInput extends Omit<SeedWorkInput, "repository"> {
  sourceRef: string;
  /**
   * Source references this root waits for (ADR-0066). Only a proposed root may
   * declare them: seeds, cure roots, review roots, and follow-ups refuse the
   * field. Stored sorted and deduplicated, or as NULL when empty or absent.
   */
  predecessors?: readonly string[];
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
  /**
   * The kinds the caller's credential allows it to claim — a minted token's
   * `kinds` (ADR-0063) or the stdio server's `SNOWCAT_MCP_KINDS`. Set by the
   * transport, never by a request payload: the store intersects it with
   * `kinds`, and an empty intersection claims nothing.
   */
  allowedKinds?: string[];
  /**
   * The MCP tools the caller's credential may call — a minted token's
   * `tools` (ADR-0070). Set by the transport, never by a request payload, and
   * recorded in the `work.claimed` payload as `toolsGrant`; it changes
   * nothing about which item is claimed.
   */
  allowedTools?: string[];
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
