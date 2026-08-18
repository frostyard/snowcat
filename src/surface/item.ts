import type { QueueStore } from "../queue/store.ts";
import { withoutLeaseToken, type ObservableWorkItem, type WorkEvent } from "../queue/types.ts";
import type { RepositoryEnrollment } from "./repositories.ts";

export interface ArtifactProvenance {
  /** Actor of the latest `artifact.verified` or `artifact.attached` event for this URL: who re-verified or attached it. */
  verifiedBy?: string;
}

export interface ItemData {
  item: ObservableWorkItem;
  parent?: ObservableWorkItem;
  root?: ObservableWorkItem;
  children: ObservableWorkItem[];
  enrollment?: RepositoryEnrollment;
  events: WorkEvent[];
  /** Actor and time of the event that produced the current result (`work.completed` or `work.blocked`). */
  resultEvent?: { actor: string; at: string; type: string };
  provenance: Map<string, ArtifactProvenance>;
}

/**
 * Exactly what `queue -- show` prints, plus lineage neighbours and the
 * enrollment badge: the item without its lease token, its parent and root,
 * its direct children, and its full event history.
 */
export function readItem(queue: QueueStore, id: string, enrollments: Map<string, RepositoryEnrollment> | undefined): ItemData | undefined {
  const raw = queue.get(id);
  if (!raw) return undefined;
  const item = withoutLeaseToken(raw);
  const events = queue.events(id);
  const parentRaw = item.parentId ? queue.get(item.parentId) : undefined;
  const rootRaw = item.rootId !== item.id ? queue.get(item.rootId) : undefined;
  const resultEvent = events
    .filter((event) => event.type === "work.completed" || event.type === "work.blocked")
    .at(-1);
  const provenance = new Map<string, ArtifactProvenance>();
  for (const event of events) {
    if (event.type !== "artifact.verified" && event.type !== "artifact.attached") continue;
    const url = event.payload.url;
    if (typeof url === "string") provenance.set(url, { verifiedBy: event.actor });
  }
  return {
    item,
    parent: parentRaw ? withoutLeaseToken(parentRaw) : undefined,
    root: rootRaw ? withoutLeaseToken(rootRaw) : undefined,
    children: queue.children(id).map(withoutLeaseToken),
    enrollment: enrollments?.get(item.repository.toLowerCase()),
    events,
    resultEvent: resultEvent ? { actor: resultEvent.actor, at: resultEvent.occurredAt, type: resultEvent.type } : undefined,
    provenance,
  };
}
