import type { QueueStore } from "../queue/store.ts";
import type { ObservedWorkEvent } from "../queue/types.ts";
import type { RepositoryEnrollment } from "./repositories.ts";

/** The default window: the last 100 events, matching the store's own `eventsSince` default. */
export const EVENTS_PAGE_SIZE = 100;
/** `QueueStore.eventsSince` refuses a larger limit; the decisions filter reads at most this many and says so when it fills. */
export const EVENTS_PAGE_MAX = 500;

/**
 * The operator-decision event types `?decisions=1` keeps. Every name is in
 * the store's recorded vocabulary (`work.approved`, `work.rejected`,
 * `work.deferred`, `work.requeued`, `work.cancelled`, `work.prioritized`,
 * `work.noted`, `artifact.attached`, `artifact.ready`): the decisions an
 * operator makes, as opposed to what a worker or a sweep records.
 */
export const DECISION_EVENT_TYPES = [
  "work.approved",
  "work.rejected",
  "work.deferred",
  "work.requeued",
  "work.cancelled",
  "work.prioritized",
  "work.noted",
  "artifact.attached",
  "artifact.ready",
] as const;

const DECISION_EVENT_SET = new Set<string>(DECISION_EVENT_TYPES);

/** Same shape the store validates, so an unknown slug is a 404 rather than a thrown read. */
const REPOSITORY_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface EventsQuery {
  /** `?repository=<owner/repo>`; matched case-insensitively against the known repositories. */
  repository?: string;
  /** `?since=<sequence>`; the default window is the last page of events. */
  since?: number;
  /** `?decisions=1`. */
  decisions: boolean;
}

export interface EventsData {
  /** Newest first. */
  events: ObservedWorkEvent[];
  /** The canonical slug when filtered, else undefined for every repository. */
  repository?: string;
  decisions: boolean;
  /** The exclusive lower bound actually read. */
  since: number;
  /** The store's cursor when the page was rendered. */
  lastEventSequence: number;
  /** How many events the read returned before the decisions filter. */
  read: number;
  /** The read filled the 500-event cap, so older events in the window are not shown. */
  capped: boolean;
  /** Repositories the filter offers, from the same sidebar read. */
  repositories: string[];
}

/**
 * The event ledger as a page: `QueueStore.eventsSince` with the store's own
 * repository filter, then the decision-type filter applied here. Read-only,
 * no new store method, and event payloads never carry a lease token.
 *
 * Returns `undefined` when `query.repository` is malformed or names a
 * repository that is neither opted in nor declared, so the route can render
 * the 404-in-shell page instead of a 503.
 */
export function readEvents(
  queue: QueueStore,
  enrollments: Map<string, RepositoryEnrollment> | undefined,
  query: EventsQuery,
): EventsData | undefined {
  const optedIn = queue.enabledRepositories();
  const repositories = [...new Set([...optedIn, ...[...(enrollments?.values() ?? [])].map((enrollment) => enrollment.slug)])].sort((left, right) =>
    left.localeCompare(right),
  );

  let repository: string | undefined;
  if (query.repository !== undefined) {
    if (!REPOSITORY_SLUG.test(query.repository)) return undefined;
    const wanted = query.repository.toLowerCase();
    // Use the canonical casing the queue stores, since the store's filter is an exact match.
    repository = optedIn.find((slug) => slug.toLowerCase() === wanted) ?? enrollments?.get(wanted)?.slug;
    if (!repository) return undefined;
  }

  const lastEventSequence = queue.metadata().lastEventSequence;
  // Decisions are sparse in the ledger, so that filter reads the whole cap;
  // the unfiltered page reads one default window.
  const window = query.decisions ? EVENTS_PAGE_MAX : EVENTS_PAGE_SIZE;
  const since = query.since ?? Math.max(0, lastEventSequence - window);
  const read = queue.eventsSince(since, { repository, limit: EVENTS_PAGE_MAX });
  const kept = query.decisions ? read.filter((event) => DECISION_EVENT_SET.has(event.type)) : read;

  return {
    events: [...kept].reverse(),
    repository,
    decisions: query.decisions,
    since,
    lastEventSequence,
    read: read.length,
    capped: read.length === EVENTS_PAGE_MAX,
    repositories,
  };
}

/** `/events` with the filters the page currently shows, for links and the filter form. */
export function eventsPath(query: { repository?: string; decisions?: boolean; since?: number } = {}): string {
  const search = new URLSearchParams();
  if (query.repository) search.set("repository", query.repository);
  if (query.decisions) search.set("decisions", "1");
  if (query.since !== undefined) search.set("since", String(query.since));
  const suffix = search.toString();
  return suffix ? `/events?${suffix}` : "/events";
}
