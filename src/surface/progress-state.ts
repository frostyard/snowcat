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

export interface ProgressData {
  asOf: string;
  attention: ProgressRow[];
  repositories: ProgressRepositoryGroup[];
  summary: Record<ProgressSummaryBucket, number>;
  total: number;
  active: number;
  truncated: string[];
}

const SATELLITE_KINDS = new Set([REVIEW_KIND, REVIEW_FIX_KIND, CURE_KIND]);
const LIST_LIMIT = 100;
const PROGRESS_EVENT_LIMIT = 100;
const TERMINAL_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * The statuses `isAgedOut` can retire. Read newest first in the store rather
 * than filtered out of the first `LIST_LIMIT` rows of claim order: a queue
 * that has completed more than that many items (frostyard/snowcat passed it
 * long ago) would otherwise fill the whole budget with old merged work that
 * this view then ages out, leaving the page empty.
 */
const RECENT_FIRST_STATUSES = new Set<WorkStatus>(["completed", "cancelled"]);

/** The queue-only progress projection. Rendering never asks GitHub or changes queue state. */
export function readProgress(queue: QueueStore, now: Date = new Date()): ProgressData {
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

  const primaries = all.filter((item) => !SATELLITE_KINDS.has(item.kind) && !isAgedOut(item, now));
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
  const rows = primaries.map((item) => {
    const reviews = reviewsByOrigin.get(item.id) ?? [];
    return deriveProgressRow(item, reviews, queue.reviewGateEnabled(item.repository), now, {
      itemEvents: recentEvents(item.id),
      reviewEvents: reviews.flatMap((review) => recentEvents(review.id)),
    });
  });
  const sourceRefs = new Set(
    primaries.flatMap((item) => (item.sourceRef ? [`${item.repository.toLowerCase()}\0${item.sourceRef.toLowerCase()}`] : [])),
  );
  for (const repository of queue.enabledRepositories()) {
    for (const observation of queue.repositoryLabeledIssueObservations(repository)?.issues ?? []) {
      if (sourceRefs.has(`${repository.toLowerCase()}\0${observation.url.toLowerCase()}`)) continue;
      rows.push(observationRow(repository, observation));
    }
  }

  rows.sort(compareRows);
  const attention = rows.filter((row) => row.badge?.tone === "amber" || row.badge?.tone === "red");
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
    attention,
    repositories: [...byRepository.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([repository, group]) => ({ repository, rows: group })),
    summary: summarizeProgress(rows),
    total: rows.length,
    active: rows.filter((row) => row.active).length,
    truncated,
  };
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
    if (bucket !== undefined) summary[bucket] += 1;
  }
  return summary;
}

/** Derives one primary item's current stage and any off-path state. */
export function deriveProgressRow(
  item: ObservableWorkItem,
  reviewItems: ObservableWorkItem[],
  reviewGate: boolean,
  now: Date,
  history: { itemEvents?: readonly WorkEvent[]; reviewEvents?: readonly WorkEvent[] } = {},
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
    enteredAt: deriveStageEnteredAt(item, row.stage, reviewGate, history),
  });
  const stopped = item.status === "blocked" ? blockedBadge() : item.status === "cancelled" ? cancelledBadge() : undefined;

  if (item.status === "proposed") {
    return finish({ ...base, stage: "proposed", active: false, waiting: stopped?.reason ?? "awaiting your admission", badge: stopped });
  }
  if (item.status === "queued") {
    return finish({ ...base, stage: "queued", active: false, waiting: stopped?.reason ?? "in queue", badge: stopped });
  }
  if (item.status === "claimed") {
    const active = leaseIsActive(item, now);
    return finish({
      ...base,
      stage: "working",
      active,
      waiting: active ? "worker active" : "lease expired · awaiting reclaim",
      badge: stopped,
    });
  }

  const pullRequest = pullRequestArtifact(item);
  if (!pullRequest) {
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
        ? cancelledBadge()
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
    (item.status === "completed" && (item.delivery === "merged" || item.delivery === "published"));
  return terminal && now.getTime() - Date.parse(item.updatedAt) > TERMINAL_AGE_MS;
}

function blockedBadge(): ProgressBadge {
  return { label: "blocked", reason: "waiting on operator", tone: "amber" };
}

function cancelledBadge(): ProgressBadge {
  return { label: "cancelled", reason: "cancelled", tone: "red" };
}

function deriveStageEnteredAt(
  item: ObservableWorkItem,
  currentStage: ProgressStage,
  reviewGate: boolean,
  history: { itemEvents?: readonly WorkEvent[]; reviewEvents?: readonly WorkEvent[] },
): Partial<Record<ProgressStage, string>> {
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
