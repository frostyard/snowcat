import { REVIEW_KIND } from "../queue/pull-request-review.ts";
import { pullRequestArtifactIdentity } from "../queue/artifact-identity.ts";
import type { QueueStore } from "../queue/store.ts";
import { withoutLeaseToken, type ObservableWorkItem, type ObservedWorkEvent, type UnreportedPullRequest, type WorkArtifact } from "../queue/types.ts";
import { readPullRequests, type PullRequestRow, type RepositoryEnrollment } from "./repositories.ts";

/** How many ledger events the inbox rail shows, newest first. */
export const EVENTS_RAIL_SIZE = 30;
/** `list()` caps at 100 rows per status; the inbox reads that many and says so if it hits the cap. */
const LIST_LIMIT = 100;

export interface SidebarRepository {
  slug: string;
  /** Control-plane effective state when known, else `opted-in`. */
  state: string;
  enrolled: boolean;
}

export interface ProposalRow {
  item: ObservableWorkItem;
  parent?: ObservableWorkItem;
  /** The parent's result summary, shown as the finding this child answers. */
  finding?: string;
  repositoryState?: string;
}

export interface BlockedRow {
  item: ObservableWorkItem;
  parent?: ObservableWorkItem;
  reason: string;
  blockedBy?: string;
  blockedAt?: string;
}

export interface UnverifiedRow {
  item: ObservableWorkItem;
  artifact:
    | (WorkArtifact & { verification: { status: "unverified"; attemptedAt: string; reason: string } })
    | (WorkArtifact & {
        verification: {
          status: "verified";
          verifiedAt: string;
          number: number;
          state: "open" | "closed" | "merged" | "published" | "draft";
          handoff:
            | { status: "unverified"; attemptedAt: string; reason: string }
            | { status: "rejected"; checkedAt: string; reason: string };
        };
      });
  completedBy?: string;
}

/**
 * A pull request in a review-gated repository that only a human can move on
 * (ADR-0065): a draft the gate cannot advance by itself or that passed and
 * waits to be marked ready (`review`), or one no item reported, so the gate
 * never saw it at all (`unreported`).
 */
export type AdjudicationRow =
  | { kind: "review"; repository: string; pullRequest: PullRequestRow }
  | { kind: "unreported"; repository: string; pullRequest: UnreportedPullRequest; observedAt: string };

/**
 * An open pull request the gate has finished with, across every repository
 * (issue #251): `mark-ready` passed review and is still a draft — a human
 * marks it ready — and `queue-for-merge` is already open (non-draft) with
 * either a passing verdict for its current head or no review gate to pass.
 * `verdictModel` is the reviewing worker's own `result.model`, shown as
 * worker-asserted provenance like everywhere else it appears.
 */
export type ReadyRow = { kind: "mark-ready" | "queue-for-merge"; repository: string; pullRequest: PullRequestRow; verdictModel?: string };

export interface InboxData {
  stats: {
    proposals: number;
    blocked: number;
    readyToMerge: number;
    unverified: number;
    adjudication: number;
    leased: number;
    leasedCaption: string;
  };
  proposals: ProposalRow[];
  blocked: BlockedRow[];
  readyToMerge: ReadyRow[];
  unverified: UnverifiedRow[];
  adjudication: AdjudicationRow[];
  events: ObservedWorkEvent[];
  eventsSince: number;
  /** Groups whose read hit the 100-row list cap, so the operator knows the page is not exhaustive. */
  truncated: string[];
}

/**
 * Whether an open pull request belongs on the *Ready to merge* rail, and
 * which action it waits on. No pull request with an active `pr-cure` root
 * qualifies — its head is still decayed. `readyToMark` alone (with
 * `needsHuman` false) covers a passed draft head whether the sweep never
 * tried to mark it ready (writes off) or tried and stopped at a protected
 * boundary (ADR-0074): either way the pull request stays a draft with a
 * passed round, and the queue stores nothing that tells the two apart
 * without a GitHub call, which rendering never makes. A `needsHuman` row is
 * always a problem (round budget, unable-to-review, a stuck fix, or a
 * description blocker, including the ADR-0071 pass-consequence variant that
 * still carries an outstanding one) and stays on *Review adjudication* only.
 */
function readyAction(pullRequest: PullRequestRow, reviewGateOn: boolean): ReadyRow["kind"] | undefined {
  if (
    pullRequest.state !== "open" ||
    pullRequest.verifiedAt === undefined ||
    pullRequest.cure?.active === true ||
    pullRequest.handoff !== undefined ||
    pullRequest.sourcePending !== undefined
  ) {
    return undefined;
  }
  const review = pullRequest.review;
  if (review?.readyToMark === true && review.needsHuman !== true) return "mark-ready";
  if (pullRequest.draft !== true) {
    const passed = review?.kind === REVIEW_KIND && review.status === "completed" && review.decision === "pass";
    if (passed || !reviewGateOn) return "queue-for-merge";
  }
  return undefined;
}

/**
 * Everything the inbox renders, read through the same store methods the CLI
 * uses. Lease tokens are stripped at the boundary with `withoutLeaseToken`;
 * nothing here writes.
 */
export function readInbox(queue: QueueStore, enrollments: Map<string, RepositoryEnrollment> | undefined, now: Date = new Date()): InboxData {
  const metadata = queue.metadata();
  const counts = queue.counts();
  const truncated: string[] = [];

  const proposed = queue.list({ status: "proposed", limit: LIST_LIMIT });
  if (proposed.length === LIST_LIMIT) truncated.push("proposals");
  const blockedItems = queue.list({ status: "blocked", limit: LIST_LIMIT });
  if (blockedItems.length === LIST_LIMIT) truncated.push("blocked");
  // Completed items that still carry an unverified issue or pull-request
  // artifact, newest first — selected in the store rather than filtered out
  // of list()'s first 100 completions, which starved the group once a queue
  // held more than 100 completed items.
  const completed = queue.completedItemsWithPendingArtifacts({ limit: LIST_LIMIT, handoffAttentionOnly: true });
  if (completed.length === LIST_LIMIT) truncated.push("unverified artifacts");
  const claimed = queue.list({ status: "claimed", limit: LIST_LIMIT });

  const stateBySlug = new Map([...(enrollments?.entries() ?? [])].map(([slug, enrollment]) => [slug, enrollment.effectiveState]));
  const parents = new Map<string, ObservableWorkItem | undefined>();
  const parentOf = (item: ObservableWorkItem): ObservableWorkItem | undefined => {
    if (!item.parentId) return undefined;
    if (!parents.has(item.parentId)) {
      const parent = queue.get(item.parentId);
      parents.set(item.parentId, parent ? withoutLeaseToken(parent) : undefined);
    }
    return parents.get(item.parentId);
  };
  const lastActor = (id: string, type: string): { actor: string; at: string } | undefined => {
    const event = queue
      .events(id)
      .filter((candidate) => candidate.type === type)
      .at(-1);
    return event ? { actor: event.actor, at: event.occurredAt } : undefined;
  };

  const proposals: ProposalRow[] = proposed.map((raw) => {
    const item = withoutLeaseToken(raw);
    const parent = parentOf(item);
    return {
      item,
      parent,
      finding: parent?.result?.summary,
      repositoryState: stateBySlug.get(item.repository.toLowerCase()),
    };
  });

  const blocked: BlockedRow[] = blockedItems.map((raw) => {
    const item = withoutLeaseToken(raw);
    const blockedEvent = lastActor(item.id, "work.blocked");
    return {
      item,
      parent: parentOf(item),
      reason: item.result?.summary ?? "(no block reason recorded)",
      blockedBy: blockedEvent?.actor,
      blockedAt: blockedEvent?.at,
    };
  });

  const artifactHandoffs = new Map<string, UnverifiedRow>();
  for (const raw of completed) {
    const item = withoutLeaseToken(raw);
    for (const artifact of item.result?.artifacts ?? []) {
      if (artifact.kind !== "issue" && artifact.kind !== "pull-request") continue;
      if (
        artifact.verification?.status !== "unverified" &&
        !(artifact.kind === "pull-request" && artifact.verification?.status === "verified" && artifact.verification.handoff !== undefined)
      ) {
        continue;
      }
      const identity =
        artifact.kind === "pull-request"
          ? pullRequestArtifactIdentity(item.repository, artifact)
          : `issue:${artifact.url.toLowerCase()}`;
      if (!artifactHandoffs.has(identity)) {
        artifactHandoffs.set(identity, {
          item,
          artifact: artifact as UnverifiedRow["artifact"],
          completedBy: lastActor(item.id, "work.completed")?.actor,
        });
      }
    }
  }
  const unverified = [...artifactHandoffs.values()];

  // Every opted-in repository (`repositoryReviewGateSettings` lists them all,
  // gated or not): the Ready to merge rail needs both, so one
  // `readPullRequests` read per repository serves it and, for gated
  // repositories only, the existing adjudication rail below.
  const adjudication: AdjudicationRow[] = [];
  const readyToMerge: ReadyRow[] = [];
  for (const setting of queue.repositoryReviewGateSettings()) {
    const pulls = readPullRequests(queue, setting.repository, now);
    if (pulls.truncated) truncated.push(`pull requests (${setting.repository})`);
    for (const pullRequest of pulls.open) {
      const action = readyAction(pullRequest, setting.reviewGate);
      if (action) {
        const verdictModel = pullRequest.review ? queue.get(pullRequest.review.itemId)?.result?.model : undefined;
        readyToMerge.push({ kind: action, repository: setting.repository, pullRequest, ...(verdictModel ? { verdictModel } : {}) });
      }
    }
    if (!setting.reviewGate) continue;
    for (const pullRequest of pulls.open) {
      if (
        pullRequest.handoff === undefined &&
        pullRequest.sourcePending === undefined &&
        (pullRequest.review?.needsHuman || pullRequest.review?.readyToMark)
      ) {
        adjudication.push({ kind: "review", repository: setting.repository, pullRequest });
      }
    }
    for (const pullRequest of pulls.unreported) {
      adjudication.push({ kind: "unreported", repository: setting.repository, pullRequest, observedAt: pulls.unreportedObservedAt ?? "" });
    }
  }

  const eventsSince = Math.max(0, metadata.lastEventSequence - EVENTS_RAIL_SIZE);
  const events = queue.eventsSince(eventsSince, { limit: EVENTS_RAIL_SIZE }).reverse();

  const leasedCaption =
    claimed.length === 0
      ? "no active leases"
      : claimed.length === 1
        ? `${claimed[0]!.leaseOwner ?? "unknown worker"} · ${claimed[0]!.kind}`
        : `${new Set(claimed.map((item) => item.leaseOwner)).size} workers`;

  return {
    stats: {
      proposals: counts.proposed,
      blocked: counts.blocked,
      readyToMerge: readyToMerge.length,
      unverified: unverified.length,
      adjudication: adjudication.length,
      leased: counts.claimed,
      leasedCaption,
    },
    proposals,
    blocked,
    readyToMerge,
    unverified,
    adjudication,
    events,
    eventsSince,
    truncated,
  };
}
