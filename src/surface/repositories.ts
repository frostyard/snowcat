import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { RepositoryMaintenanceProgram } from "../control/registry.ts";
import { ControlPlaneStore, type RepositoryStatus } from "../control/store.ts";
import type { QueueStore } from "../queue/store.ts";
import { withoutLeaseToken, type ObservableWorkItem, type WorkStatus } from "../queue/types.ts";
import type { SidebarRepository } from "./inbox.ts";

/** `list()` caps at 100 rows per status; columns read that many and say so if they hit the cap. */
const LIST_LIMIT = 100;

/** What the surface knows about a repository from the control plane, when configured. */
export interface RepositoryEnrollment {
  /** `owner/name` as declared, for display; map keys are lowercased. */
  slug: string;
  effectiveState: string;
  enrolled: boolean;
  /** Control-plane repository id (`github.com:<id>`) once GitHub identity is matched. */
  repositoryId?: string;
  /** Active Core snapshot's source commit. */
  coreCommit?: string;
  /** The exact repository commit the surface reconciliation read. */
  surfaceCommit?: string;
  held: boolean;
  /** The Core declaration's `maintenance_programs`; the dogfood feeder seeds only these. */
  maintenancePrograms: RepositoryMaintenanceProgram[];
}

export interface RepositoryIndexRow {
  slug: string;
  counts: Record<WorkStatus, number>;
  enrollment?: RepositoryEnrollment;
}

export interface RepositoryIndexData {
  rows: RepositoryIndexRow[];
  controlPlaneConfigured: boolean;
}

export interface LeasedRow {
  item: ObservableWorkItem;
  /** Fraction of the current lease still ahead, 0..1, from `updatedAt` (last renewal) to `leaseExpiresAt`. */
  remainingFraction: number;
  remainingLabel: string;
}

export interface CompletedRow {
  item: ObservableWorkItem;
  /** Actor of the `work.completed` event, since completion clears the lease owner. */
  completedBy?: string;
}

export interface BoardData {
  repository: string;
  optedIn: boolean;
  enrollment?: RepositoryEnrollment;
  counts: Record<WorkStatus, number>;
  stats: {
    queued: number;
    queuedCaption: string;
    leased: number;
    leasedCaption: string;
    completedToday: number;
    completedTodayCaption: string;
    merged: number;
    attempts: number;
    mergedCaption: string;
  };
  queued: ObservableWorkItem[];
  leased: LeasedRow[];
  completed: CompletedRow[];
  truncated: string[];
}

/**
 * Sidebar and index share one control-plane read per request; the store is
 * opened fresh (like the claim-eligibility hook) so pages show current facts.
 * Returns `undefined` when `SNOWCAT_CONTROL_DB` is not configured.
 */
export function readEnrollments(controlPlanePath: string | undefined): Map<string, RepositoryEnrollment> | undefined {
  if (!controlPlanePath) return undefined;
  const path = resolve(controlPlanePath);
  if (!existsSync(path)) throw new Error(`control-plane database does not exist: ${path} (SNOWCAT_CONTROL_DB)`);
  const store = new ControlPlaneStore(path);
  try {
    const coreCommit = store.activeCoreSnapshot()?.sourceCommitId;
    const enrollments = new Map<string, RepositoryEnrollment>();
    for (const status of store.repositoryStatuses()) {
      const slug = `${status.owner}/${status.name}`;
      enrollments.set(slug.toLowerCase(), enrollmentOf(slug, status, coreCommit));
    }
    return enrollments;
  } finally {
    store.close();
  }
}

function enrollmentOf(slug: string, status: RepositoryStatus, coreCommit: string | undefined): RepositoryEnrollment {
  return {
    slug,
    effectiveState: status.effectiveState,
    enrolled: status.effectiveState === "enrolled",
    repositoryId: status.githubResult === "matched" ? status.repositoryId : undefined,
    coreCommit,
    surfaceCommit: status.repositoryCommitId ?? undefined,
    held: status.operatorHold?.choice === "impose",
    maintenancePrograms: [...status.maintenancePrograms],
  };
}

/** The sidebar list: control-plane repositories with states when configured, else queue opt-ins. */
export function sidebarFromEnrollments(queue: QueueStore, enrollments: Map<string, RepositoryEnrollment> | undefined): SidebarRepository[] {
  if (!enrollments) return queue.enabledRepositories().map((slug) => ({ slug, state: "opted-in", enrolled: false }));
  return [...enrollments.values()]
    .map((enrollment) => ({ slug: enrollment.slug, state: enrollment.effectiveState, enrolled: enrollment.enrolled }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
}

export function readRepositoryIndex(queue: QueueStore, enrollments: Map<string, RepositoryEnrollment> | undefined): RepositoryIndexData {
  const bySlug = new Map<string, string>();
  for (const slug of queue.enabledRepositories()) bySlug.set(slug.toLowerCase(), slug);
  for (const enrollment of enrollments?.values() ?? []) bySlug.set(enrollment.slug.toLowerCase(), enrollment.slug);
  const rows = [...bySlug.values()]
    .sort()
    .map((slug) => ({ slug, counts: queue.counts(slug), enrollment: enrollments?.get(slug.toLowerCase()) }));
  return { rows, controlPlaneConfigured: enrollments !== undefined };
}

export function readBoard(
  queue: QueueStore,
  repository: string,
  enrollments: Map<string, RepositoryEnrollment> | undefined,
  now: Date = new Date(),
): BoardData | undefined {
  const optedIn = queue.enabledRepositories().some((slug) => slug.toLowerCase() === repository.toLowerCase());
  const enrollment = enrollments?.get(repository.toLowerCase());
  if (!optedIn && !enrollment) return undefined;
  const counts = queue.counts(repository);
  const truncated: string[] = [];

  const queued = queue.list({ status: "queued", repository, limit: LIST_LIMIT }).map(withoutLeaseToken);
  if (queued.length === LIST_LIMIT) truncated.push("queued");
  const claimed = queue.list({ status: "claimed", repository, limit: LIST_LIMIT }).map(withoutLeaseToken);
  if (claimed.length === LIST_LIMIT) truncated.push("leased");
  const completed = queue
    .list({ status: "completed", repository, limit: LIST_LIMIT })
    .map(withoutLeaseToken)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  if (completed.length === LIST_LIMIT) truncated.push("completed");
  const completedRows: CompletedRow[] = completed.map((item) => ({
    item,
    completedBy: queue
      .events(item.id)
      .filter((event) => event.type === "work.completed")
      .at(-1)?.actor,
  }));

  const leased: LeasedRow[] = claimed.map((item) => {
    const renewedAt = Date.parse(item.updatedAt);
    const expiresAt = item.leaseExpiresAt ? Date.parse(item.leaseExpiresAt) : Number.NaN;
    const total = expiresAt - renewedAt;
    const remaining = expiresAt - now.getTime();
    const fraction = Number.isFinite(total) && total > 0 ? Math.min(1, Math.max(0, remaining / total)) : 0;
    return { item, remainingFraction: fraction, remainingLabel: remainingLabel(remaining) };
  });

  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const completedToday = completed.filter((item) => item.updatedAt >= startOfToday);
  const merged = completed.filter((item) => item.delivery === "merged").length;
  const open = completed.filter((item) => item.delivery === "open").length;
  const unverified = completed.filter((item) => item.delivery === "unverified").length;
  const mergedToday = completedToday.filter((item) => item.delivery === "merged").length;
  const openToday = completedToday.filter((item) => item.delivery === "open").length;
  const next = queued[0];

  return {
    repository,
    optedIn,
    enrollment,
    counts,
    stats: {
      queued: counts.queued,
      queuedCaption: next ? `next: ${shortLabel(next)} (p${next.priority})` : "nothing queued",
      leased: counts.claimed,
      leasedCaption:
        leased.length === 0
          ? "no active leases"
          : leased.length === 1
            ? `${workerFamily(leased[0]!.item.leaseOwner)} · ${leased[0]!.remainingLabel}`
            : `${new Set(leased.map((row) => row.item.leaseOwner)).size} workers`,
      completedToday: completedToday.length,
      completedTodayCaption: `${mergedToday} merged · ${openToday} open`,
      merged,
      attempts: completed.length,
      mergedCaption: `${open} open · ${unverified} unverified · ${counts.blocked} blocked now`,
    },
    queued,
    leased,
    completed: completedRows,
    truncated,
  };
}

/** `#304` for an imported issue, else the kind. */
export function shortLabel(item: ObservableWorkItem): string {
  const issue = item.sourceRef ? /\/issues\/(\d+)(?:[/?#]|$)/.exec(item.sourceRef) : null;
  return issue ? `#${issue[1]}` : item.kind;
}

/** `copilot-cli` from `copilot-cli:frostyard/updex:873058ce`. */
export function workerFamily(worker: string | undefined): string {
  if (!worker) return "unknown worker";
  const colon = worker.indexOf(":");
  return colon === -1 ? worker : worker.slice(0, colon);
}

function remainingLabel(remainingMs: number): string {
  if (!Number.isFinite(remainingMs)) return "no expiry";
  if (remainingMs <= 0) return "expired";
  const minutes = Math.round(remainingMs / 60_000);
  if (minutes < 1) return "under a minute left";
  if (minutes < 120) return `${minutes}m left`;
  return `${Math.round(minutes / 60)}h left`;
}
