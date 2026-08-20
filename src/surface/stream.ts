import type { ObservedWorkEvent } from "../queue/types.ts";

/** How often the stream polls `eventsSince` for new ledger events. */
export const DEFAULT_STREAM_POLL_MS = 2_000;
/** How often the stream writes a comment line so proxies and browsers keep the connection open. */
export const DEFAULT_STREAM_HEARTBEAT_MS = 25_000;
/** Ledger events read per poll; the same cap `events --limit` allows. */
export const STREAM_PAGE_SIZE = 500;

/** The shared client/server contract for events that can change a queue-derived view. */
export const QUEUE_VIEW_EVENT_PREFIX = "work.";
export const QUEUE_VIEW_EVENT_TYPES = ["artifact.verified", "artifact.attached"] as const;

export interface StreamOptions {
  pollMs?: number;
  heartbeatMs?: number;
}

/**
 * The wire shape of one streamed ledger event: identifying fields only. The
 * payload is deliberately not forwarded — nothing in it carries a lease token
 * today, but the stream never has to prove that, because it never sends it.
 */
export interface StreamedEvent {
  sequence: number;
  type: string;
  workItemId: string;
  repository: string;
  kind: string;
  sourceRef?: string;
  status: string;
  actor: string;
  occurredAt: string;
}

export function toStreamedEvent(event: ObservedWorkEvent): StreamedEvent {
  const streamed: StreamedEvent = {
    sequence: event.sequence,
    type: event.type,
    workItemId: event.workItemId,
    repository: event.repository,
    kind: event.kind,
    status: event.status,
    actor: event.actor,
    occurredAt: event.occurredAt,
  };
  if (event.sourceRef !== undefined) streamed.sourceRef = event.sourceRef;
  return streamed;
}

/** Event types after which a page's queue-derived groups can have changed. */
export function affectsQueueView(type: string): boolean {
  return type.startsWith(QUEUE_VIEW_EVENT_PREFIX) || QUEUE_VIEW_EVENT_TYPES.some((eventType) => eventType === type);
}
