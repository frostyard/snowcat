import { discoveryKinds } from "../queue/programs.ts";
import { CURE_KIND } from "../queue/pull-request-cure.ts";
import { REVIEW_FIX_KIND, REVIEW_KIND } from "../queue/pull-request-review.ts";
import type { QueueStore } from "../queue/store.ts";
import {
  MAX_REVIEW_ROUNDS,
  withoutLeaseToken,
  workStatuses,
  type LabeledIssueObservation,
  type ObservableWorkItem,
  type WorkArtifact,
  type WorkEvent,
  type WorkStatus,
} from "../queue/types.ts";
import { predecessorWait, readPredecessors, type PredecessorCache, type PredecessorSummary } from "./predecessor-state.ts";
import type { RepositoryEnrollment } from "./repositories.ts";
import { deriveReviewState } from "./review-state.ts";

export const progressStages = [
  "awaiting-import",
  "proposed",
  "queued",
  "working",
  "pr-open",
  "review",
  "awaiting-merge",
  "merged",
] as const;

export type ProgressStage = (typeof progressStages)[number];
export const progressSummaryBuckets = [
  "awaiting-import",
  "proposed",
  "queued",
  "working",
  "in-review",
  "awaiting-merge",
] as const;
export type ProgressSummaryBucket = (typeof progressSummaryBuckets)[number];
export type ProgressBadgeTone = "amber" | "red" | "grey";

export interface ProgressBadge {
  label: string;
  reason: string;
  tone: ProgressBadgeTone;
}

export interface ProgressRow {
  key: string;
  repository: string;
  title: string;
  updatedAt: string;
  stage: ProgressStage;
  active: boolean;
  leaseOwner?: string;
  waiting?: string;
  badge?: ProgressBadge;
  item?: ObservableWorkItem;
  observation?: LabeledIssueObservation;
  reviewRound?: number;
  enteredAt: Partial<Record<ProgressStage, string>>;
}

export interface ProgressRepositoryGroup {
  repository: string;
  rows: ProgressRow[];
}

/** The view the operator asked for: the full lifecycle lanes, or only what is in motion and next. */
export type ProgressView = "all" | "active";

/** `readProgress` options: an optional case-insensitive repository filter and the view. */
export interface ProgressOptions {
  repository?: string;
  view?: ProgressView;
}

export interface ProgressData {
  asOf: string;
  filter: { repository?: string; view: ProgressView };
  attention: ProgressRow[];
  repositories: ProgressRepositoryGroup[];
  /** Every active row (a live-lease worker), oldest first — across all repositories unless a repository filter is set. */
  workingNow: ProgressRow[];
  /** The claimable queued primaries `claim_work` would offer next: priority desc, then createdAt asc; capped at 20. */
  upNext: ProgressRow[];
  summary: Record<ProgressSummaryBucket, number>;
  total: number;
  active: number;
  truncated: string[];
}

const SATELLITE_KINDS = new Set([REVIEW_KIND, REVIEW_FIX_KIND, CURE_KIND]);
const LIST_LIMIT = 100;
const PROGRESS_EVENT_LIMIT = 100;
/** `upNext` shows at most this many claimable primaries; a fuller queue records the cap in `truncated`. */
const UP_NEXT_LIMIT = 20;
/** The `truncated` marker for an `upNext` list the cap shortened, alongside the status markers. */
const UP_NEXT_TRUNCATION = "up-next";
/** Same shape the store validates, so an unknown slug is a 404 rather than a thrown read (mirrors readEvents). */
const REPOSITORY_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TERMINAL_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The statuses `isAgedOut` can retire. Read newest first in the store rather
 * than filtered out of the first `LIST_LIMIT` rows of claim order: a queue
 * that has completed more than that many items (frostyard/snowcat passed it
 * long ago) would otherwise fill the whole budget with old merged work that
 * this view then ages out, leaving the page empty.
 */
const RECENT_FIRST_STATUSES = new Set<WorkStatus>(["completed", "cancelled"]);

/**
 * The queue-only progress projection. Rendering never asks GitHub or changes queue state.
 *
 * `options.repository` filters `primaries` and labeled-issue observations by
 * case-insensitive slug before grouping; like `readEvents`, it returns
 * `undefined` for a slug that is neither opted in nor declared so the route can
 * render the 404-in-shell page. `enrollments` supplies the declared (control-
 * plane) repositories; without it only opted-in repositories resolve.
 */
export function readProgress(
  queue: QueueStore,
  now: Date = new Date(),
  options: ProgressOptions = {},
  enrollments?: Map<string, RepositoryEnrollment>,
): ProgressData | undefined {
  const view: ProgressView = options.view === "active" ? "active" : "all";

  let repository: string | undefined;
  if (options.repository !== undefined && options.repository !== "") {
    if (!REPOSITORY_SLUG.test(options.repository)) return undefined;
    const wanted = options.repository.toLowerCase();
    // Use the canonical casing the store keeps, since its filter is exact.
    repository = queue.enabledRepositories().find((slug) => slug.toLowerCase() === wanted) ?? enrollments?.get(wanted)?.slug;
    if (!repository) return undefined;
  }
  const inRepository = (slug: string): boolean => repository === undefined || slug.toLowerCase() === repository.toLowerCase();

  const all: ObservableWorkItem[] = [];
  const truncated: string[] = [];
  for (const status of workStatuses) {
    const rows = RECENT_FIRST_STATUSES.has(status)
      ? queue.recentlyUpdatedItems({ status, limit: LIST_LIMIT })
      : queue.list({ status, limit: LIST_LIMIT });
    const items = rows.map(withoutLeaseToken);
    all.push(...items);
    if (items.length === LIST_LIMIT) truncated.push(status);
  }

  // A cancelled item is a terminal operator decision nobody acts on again, so
  // it leaves the projection immediately rather than ranking as an attention
  // stop for seven days. It stays on `/events` and on its own item page.
  const primaries = all.filter(
    (item) => !SATELLITE_KINDS.has(item.kind) && item.status !== "cancelled" && !isAgedOut(item, now) && inRepository(item.repository),
  );
  const primaryIds = new Set(primaries.map((item) => item.id));
  const satellites = all.filter(
    (item) =>
      (item.kind === REVIEW_KIND || item.kind === REVIEW_FIX_KIND) &&
      item.review?.originItemId !== undefined &&
      primaryIds.has(item.review.originItemId),
  );
  const reviewsByOrigin = new Map<string, ObservableWorkItem[]>();
  for (const item of satellites) {
    const origin = item.review!.originItemId!;
    const rows = reviewsByOrigin.get(origin) ?? [];
    rows.push(item);
    reviewsByOrigin.set(origin, rows);
  }

  const eventsByItem = new Map<string, WorkEvent[]>();
  const recentEvents = (id: string): WorkEvent[] => {
    const cached = eventsByItem.get(id);
    if (cached) return cached;
    const events = queue.recentEvents(id, PROGRESS_EVENT_LIMIT);
    eventsByItem.set(id, events);
    return events;
  };
  // One cache for the whole pass: two members of the same cycle, and every
  // successor of one popular predecessor, share the reads the gate would make.
  const predecessorCache: PredecessorCache = new Map();
  // The claimable queued primaries `claim_work` would offer next, with their
  // scheduling keys, so `upNext` orders exactly the way the queue does without
  // re-deriving the gate's verdict.
  const claimable: Array<{ row: ProgressRow; priority: number; createdAt: string }> = [];
  const rows = primaries.map((item) => {
    const reviews = reviewsByOrigin.get(item.id) ?? [];
    // Only a queued item is waiting on its edges — a claimed or completed one
    // is past the gate — so nothing else pays for the read.
    const predecessors = item.status === "queued" ? readPredecessors(queue, item, predecessorCache) : undefined;
    const row = deriveProgressRow(item, reviews, queue.reviewGateEnabled(item.repository), now, {
      itemEvents: recentEvents(item.id),
      reviewEvents: reviews.flatMap((review) => recentEvents(review.id)),
      ...(predecessors ? { predecessors } : {}),
    });
    if (item.status === "queued" && (!predecessors || predecessors.unmet.length === 0)) {
      claimable.push({ row, priority: item.priority, createdAt: item.createdAt });
    }
    return row;
  });
  const sourceRefs = new Set(
    primaries.flatMap((item) => (item.sourceRef ? [`${item.repository.toLowerCase()}\0${item.sourceRef.toLowerCase()}`] : [])),
  );
  for (const observationRepository of queue.enabledRepositories()) {
    if (!inRepository(observationRepository)) continue;
    for (const observation of queue.repositoryLabeledIssueObservations(observationRepository)?.issues ?? []) {
      if (sourceRefs.has(`${observationRepository.toLowerCase()}\0${observation.url.toLowerCase()}`)) continue;
      rows.push(observationRow(observationRepository, observation));
    }
  }

  rows.sort(compareRows);

  // Working now: every active (live-lease) row, oldest first by the moment it
  // entered its working (or review) stage.
  const workingNow = rows
    .filter((row) => row.active)
    .sort((left, right) => activeSince(left).localeCompare(activeSince(right)));

  // Up next: `claim_work`'s own order — priority descending, then createdAt
  // ascending — capped, with the cap recorded in `truncated`.
  claimable.sort((left, right) => right.priority - left.priority || left.createdAt.localeCompare(right.createdAt));
  const upNext = claimable.slice(0, UP_NEXT_LIMIT).map((entry) => entry.row);
  if (claimable.length > UP_NEXT_LIMIT) truncated.push(UP_NEXT_TRUNCATION);

  // A badge is a stop, in every tone: amber and red need a decision, and the
  // grey `unverified` stop is the artifact GitHub could not confirm, which the
  // operator has to re-check. Selecting on the badge itself keeps this group
  // exactly what the docs promise it is.
  const attention = rows.filter((row) => row.badge !== undefined);
  const attentionKeys = new Set(attention.map((row) => row.key));
  const byRepository = new Map<string, ProgressRow[]>();
  for (const row of rows) {
    if (attentionKeys.has(row.key)) continue;
    const group = byRepository.get(row.repository) ?? [];
    group.push(row);
    byRepository.set(row.repository, group);
  }

  return {
    asOf: now.toISOString(),
    filter: { ...(repository ? { repository } : {}), view },
    attention,
    repositories: [...byRepository.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([groupRepository, group]) => ({ repository: groupRepository, rows: group })),
    workingNow,
    upNext,
    summary: summarizeProgress(rows),
    total: rows.length,
    active: rows.filter((row) => row.active).length,
    truncated,
  };
}

/** The instant an active row entered the stage that holds its live lease — its review round if it has one, else its working stage. */
function activeSince(row: ProgressRow): string {
  return row.enteredAt.review ?? row.enteredAt.working ?? row.updatedAt;
}

function summarizeProgress(rows: ProgressRow[]): Record<ProgressSummaryBucket, number> {
  const summary: Record<ProgressSummaryBucket, number> = {
    "awaiting-import": 0,
    proposed: 0,
    queued: 0,
    working: 0,
    "in-review": 0,
    "awaiting-merge": 0,
  };
  for (const row of rows) {
    const bucket =
      row.stage === "pr-open" || row.stage === "review"
        ? "in-review"
        : row.stage === "merged"
          ? undefined
          : row.stage;
    if (bucket !== undefined && (bucket !== "working" || row.active)) summary[bucket] += 1;
  }
  return summary;
}

/**
 * Derives one primary item's current stage and any off-path state.
 * `context.predecessors` is the claim gate's own verdict on the item's
 * declared edges (ADR-0066), read by the caller and never re-derived here.
 */
export function deriveProgressRow(
  item: ObservableWorkItem,
  reviewItems: ObservableWorkItem[],
  reviewGate: boolean,
  now: Date,
  context: { itemEvents?: readonly WorkEvent[]; reviewEvents?: readonly WorkEvent[]; predecessors?: PredecessorSummary } = {},
): ProgressRow {
  const base = {
    key: `item:${item.id}`,
    repository: item.repository,
    title: item.objective,
    updatedAt: item.updatedAt,
    item,
  };
  const finish = (row: Omit<ProgressRow, "enteredAt">): ProgressRow => ({
    ...row,
    enteredAt: deriveStageEnteredAt(item, row.stage, reviewGate, context),
  });
  const stopped = item.status === "blocked" ? blockedBadge() : undefined;

  if (item.status === "proposed") {
    return finish({ ...base, stage: "proposed", active: false, waiting: stopped?.reason ?? "awaiting your admission", badge: stopped });
  }
  if (item.status === "queued") {
    // A queued item with unmet predecessors is not "in queue": no worker can
    // claim it until the gate's edges deliver, and a cycle means never
    // (ADR-0066). The chip names the nearest unmet edge; a cycle is an amber
    // stop, so the attention group collects it.
    const gate = context.predecessors && context.predecessors.unmet.length > 0 ? predecessorWait(context.predecessors) : undefined;
    return finish({
      ...base,
      stage: "queued",
      active: false,
      waiting: stopped?.reason ?? gate?.waiting ?? "in queue",
      badge: stopped ?? gate?.badge,
    });
  }
  if (item.status === "claimed") {
    const active = leaseIsActive(item, now);
    // An expired lease is the one working-lane state that needs an operator:
    // nothing reclaims the item until someone requeues or a worker claims it.
    return finish({
      ...base,
      stage: "working",
      active,
      ...(item.leaseOwner ? { leaseOwner: item.leaseOwner } : {}),
      waiting: active ? "worker active" : "lease expired · awaiting reclaim",
      badge: active ? stopped : { label: "lease expired", reason: "awaiting reclaim", tone: "amber" },
    });
  }

  const pullRequest = pullRequestArtifact(item);
  if (!pullRequest) {
    // A discovery root delivers by proposing children, never by opening a pull
    // request; its proposals are their own rows. Completed is done, not stalled.
    if (isDeliveredDiscovery(item)) {
      return finish({ ...base, stage: "merged", active: false, waiting: "delivered · proposals filed" });
    }
    return finish({
      ...base,
      stage: "working",
      active: false,
      waiting: stopped?.reason ?? (item.status === "completed" ? "completed · no pull request reported" : "work stopped"),
      badge: stopped,
    });
  }
  const verification = pullRequest.verification;
  if (!verification || verification.status === "unverified") {
    return finish({
      ...base,
      stage: "pr-open",
      active: false,
      waiting: stopped?.reason ?? "waiting for validation",
      badge: stopped ?? { label: "unverified", reason: "GitHub unavailable", tone: "grey" },
    });
  }
  if (verification.state === "merged") {
    return finish({ ...base, stage: "merged", active: false, waiting: stopped?.reason, badge: stopped });
  }

  const reviewState = reviewGate
    ? deriveReviewState(reviewItems, verification.headSha, verification.draft === true)
    : undefined;
  const reviewRound = reviewState?.round;
  const satellite = reviewState ? reviewItems.find((candidate) => candidate.id === reviewState.itemId) : undefined;
  const satelliteStopped =
    satellite?.status === "blocked"
      ? blockedBadge()
      : satellite?.status === "cancelled"
        ? { label: "cancelled", reason: "cancelled", tone: "red" as const }
        : reviewState?.needsHuman && reviewState.round >= MAX_REVIEW_ROUNDS
          ? { label: "human decision", reason: "needs human review decision", tone: "amber" as const }
          : undefined;

  if (verification.state === "closed") {
    return finish({
      ...base,
      stage: reviewGate && reviewItems.length > 0 ? "review" : "awaiting-merge",
      active: false,
      waiting: "PR closed without merge",
      badge: { label: "closed", reason: "PR closed without merge", tone: "red" },
      ...(reviewRound ? { reviewRound } : {}),
    });
  }
  if (!reviewGate || reviewState?.decision === "pass") {
    return finish({
      ...base,
      stage: "awaiting-merge",
      active: false,
      waiting: stopped?.reason ?? "waiting for merge",
      badge: stopped,
      ...(reviewRound ? { reviewRound } : {}),
    });
  }

  const round = reviewRound ?? 1;
  const active = satellite?.status === "claimed" && leaseIsActive(satellite, now);
  return finish({
    ...base,
    stage: "review",
    active,
    ...(satellite?.leaseOwner ? { leaseOwner: satellite.leaseOwner } : {}),
    waiting: satelliteStopped?.reason ?? `round ${round}/${MAX_REVIEW_ROUNDS}`,
    badge: stopped ?? satelliteStopped,
    reviewRound: round,
  });
}

function observationRow(repository: string, observation: LabeledIssueObservation): ProgressRow {
  return {
    key: `observation:${repository}:${observation.url}`,
    repository,
    title: observation.title,
    updatedAt: observation.seenAt,
    stage: "awaiting-import",
    active: false,
    waiting: "waiting for import",
    observation,
    enteredAt: { "awaiting-import": observation.seenAt },
  };
}

function pullRequestArtifact(item: ObservableWorkItem): WorkArtifact | undefined {
  return item.result?.artifacts.find((artifact) => artifact.kind === "pull-request");
}

function leaseIsActive(item: ObservableWorkItem, now: Date): boolean {
  return item.leaseExpiresAt !== undefined && Date.parse(item.leaseExpiresAt) > now.getTime();
}

function isAgedOut(item: ObservableWorkItem, now: Date): boolean {
  const terminal =
    item.status === "cancelled" ||
    (item.status === "completed" && (item.delivery === "merged" || item.delivery === "published")) ||
    isDeliveredDiscovery(item);
  return terminal && now.getTime() - Date.parse(item.updatedAt) > TERMINAL_AGE_MS;
}

/** A completed discovery root with no pull request: delivered, and terminal. */
function isDeliveredDiscovery(item: ObservableWorkItem): boolean {
  return item.status === "completed" && discoveryKinds.has(item.kind) && pullRequestArtifact(item) === undefined;
}

function blockedBadge(): ProgressBadge {
  return { label: "blocked", reason: "waiting on operator", tone: "amber" };
}


function deriveStageEnteredAt(
  item: ObservableWorkItem,
  currentStage: ProgressStage,
  reviewGate: boolean,
  history: { itemEvents?: readonly WorkEvent[]; reviewEvents?: readonly WorkEvent[] },
): Partial<Record<ProgressStage, string>> {
  // Stage entry is a ledger question; predecessors do not move an item's stage.
  const itemEvents = history.itemEvents ?? [];
  const reviewEvents = history.reviewEvents ?? [];
  const pullRequest = pullRequestArtifact(item);
  const verification = pullRequest?.verification;
  const proposedAt = latestEventAt(itemEvents, ["work.proposed", "work.deferred"]);
  const queuedAt = latestEventAt(itemEvents, ["work.queued", "work.approved", "work.requeued", "work.released"]);
  const workingAt = latestEventAt(itemEvents, ["work.claimed"]);
  const pullRequestAt = latestEventAt(itemEvents, ["work.completed", "artifact.attached"]);
  const reviewAt = reviewGate ? latestEventAt(reviewEvents, ["work.proposed", "work.queued", "work.requeued"]) : undefined;
  const reviewPassedAt = reviewGate
    ? latestMatchingEventAt(reviewEvents, (event) => event.type === "work.reviewed" && event.payload.decision === "pass")
    : undefined;
  const awaitingMergeAt = latestIso(
    latestEventAt(itemEvents, ["artifact.ready"]),
    reviewPassedAt,
    reviewGate ? undefined : pullRequestAt,
  );
  const mergedAt = latestIso(
    latestMatchingEventAt(itemEvents, (event) => event.type === "artifact.verified" && event.payload.state === "merged"),
    verification?.status === "verified" ? verification.mergedAt : undefined,
  );
  const candidates: Partial<Record<ProgressStage, string>> = {
    "awaiting-import": item.createdAt,
    proposed: proposedAt,
    queued: queuedAt,
    working: workingAt,
    "pr-open": pullRequestAt,
    review: reviewAt,
    "awaiting-merge": awaitingMergeAt,
    merged: mergedAt,
  };

  const result: Partial<Record<ProgressStage, string>> = {};
  const currentIndex = progressStages.indexOf(currentStage);
  let cursor = item.createdAt;
  for (let index = 0; index <= currentIndex; index += 1) {
    const stage = progressStages[index]!;
    const candidate = candidates[stage];
    if (candidate && Date.parse(candidate) >= Date.parse(cursor)) cursor = candidate;
    result[stage] = cursor;
  }
  return result;
}

function latestEventAt(events: readonly WorkEvent[], types: readonly string[]): string | undefined {
  const wanted = new Set(types);
  return latestMatchingEventAt(events, (event) => wanted.has(event.type));
}

function latestMatchingEventAt(events: readonly WorkEvent[], matches: (event: WorkEvent) => boolean): string | undefined {
  let latest: string | undefined;
  for (const event of events) {
    if (matches(event)) latest = latestIso(latest, event.occurredAt);
  }
  return latest;
}

function latestIso(...values: Array<string | undefined>): string | undefined {
  return values.reduce<string | undefined>((latest, value) => {
    if (!value) return latest;
    if (!latest || Date.parse(value) >= Date.parse(latest)) return value;
    return latest;
  }, undefined);
}

function compareRows(left: ProgressRow, right: ProgressRow): number {
  return right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title);
}

/** `/progress` with the repository filter and view the page currently shows, for tabs, the view switch, and the rail. */
export function progressPath(query: { repository?: string; view?: ProgressView } = {}): string {
  const search = new URLSearchParams();
  if (query.repository) search.set("repository", query.repository);
  if (query.view === "active") search.set("view", "active");
  const suffix = search.toString();
  return suffix ? `/progress?${suffix}` : "/progress";
}
