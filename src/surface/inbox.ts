import type { QueueStore } from "../queue/store.ts";
import { withoutLeaseToken, type ObservableWorkItem, type ObservedWorkEvent, type WorkArtifact } from "../queue/types.ts";
import type { RepositoryEnrollment } from "./repositories.ts";

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
  artifact: WorkArtifact & { verification: { status: "unverified"; attemptedAt: string; reason: string } };
  completedBy?: string;
}

export interface InboxData {
  stats: {
    proposals: number;
    blocked: number;
    unverified: number;
    leased: number;
    leasedCaption: string;
  };
  proposals: ProposalRow[];
  blocked: BlockedRow[];
  unverified: UnverifiedRow[];
  events: ObservedWorkEvent[];
  eventsSince: number;
  /** Groups whose read hit the 100-row list cap, so the operator knows the page is not exhaustive. */
  truncated: string[];
}

/**
 * Everything the inbox renders, read through the same store methods the CLI
 * uses. Lease tokens are stripped at the boundary with `withoutLeaseToken`;
 * nothing here writes.
 */
export function readInbox(queue: QueueStore, enrollments: Map<string, RepositoryEnrollment> | undefined): InboxData {
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
  const completed = queue.completedItemsWithPendingArtifacts({ limit: LIST_LIMIT, unverifiedOnly: true });
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

  const unverified: UnverifiedRow[] = [];
  for (const raw of completed) {
    const item = withoutLeaseToken(raw);
    for (const artifact of item.result?.artifacts ?? []) {
      if ((artifact.kind !== "issue" && artifact.kind !== "pull-request") || artifact.verification?.status !== "unverified") continue;
      unverified.push({
        item,
        artifact: artifact as UnverifiedRow["artifact"],
        completedBy: lastActor(item.id, "work.completed")?.actor,
      });
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
      unverified: unverified.length,
      leased: counts.claimed,
      leasedCaption,
    },
    proposals,
    blocked,
    unverified,
    events,
    eventsSince,
    truncated,
  };
}
