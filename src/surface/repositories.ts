import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { RepositoryMaintenanceProgram } from "../control/registry.ts";
import { ControlPlaneStore, type RepositoryStatus } from "../control/store.ts";
import { CURE_KIND } from "../queue/pull-request-cure.ts";
import type { QueueStore } from "../queue/store.ts";
import {
  withoutLeaseToken,
  workStatuses,
  type ObservableWorkItem,
  type PullRequestDecay,
  type WorkArtifact,
  type WorkStatus,
} from "../queue/types.ts";
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
  /** Open, decayed, and merged-today pull requests, linking to the board's section. */
  pullRequests: PullRequestSummary;
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
  /** The repository's pull requests as the queue knows them; no GitHub call. */
  pullRequests: PullRequestsData;
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

export function readRepositoryIndex(
  queue: QueueStore,
  enrollments: Map<string, RepositoryEnrollment> | undefined,
  now: Date = new Date(),
): RepositoryIndexData {
  const bySlug = new Map<string, string>();
  for (const slug of queue.enabledRepositories()) bySlug.set(slug.toLowerCase(), slug);
  for (const enrollment of enrollments?.values() ?? []) bySlug.set(enrollment.slug.toLowerCase(), enrollment.slug);
  const rows = [...bySlug.values()]
    .sort()
    .map((slug) => ({
      slug,
      counts: queue.counts(slug),
      enrollment: enrollments?.get(slug.toLowerCase()),
      pullRequests: readPullRequests(queue, slug, now).summary,
    }));
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
    pullRequests: readPullRequests(queue, repository, now),
    truncated,
  };
}

/** Pull requests merged within this window are still shown on the board. */
const MERGED_WINDOW_DAYS = 7;
/** A `pr-cure` root in one of these statuses is work that has not run out: the head is still decayed. */
const ACTIVE_CURE_STATUSES: readonly WorkStatus[] = ["proposed", "queued", "claimed", "blocked"];

/** The `pr-cure` root bound to a pull-request head (ADR-0061), as the board shows it. */
export interface PullRequestCureRow {
  itemId: string;
  status: WorkStatus;
  /** The cure is still work: proposed, queued, claimed, or blocked. */
  active: boolean;
  headSha: string;
  decay: PullRequestDecay[];
  createdAt: string;
}

/**
 * One pull request Snowcat knows about in a repository, projected from what
 * the queue already stores: a completed item's `pull-request` artifact with
 * its latest verification, and/or a `pr-cure` root's `cure.pullRequestUrl`.
 * Nothing here is fetched from GitHub.
 */
export interface PullRequestRow {
  url: string;
  /** From the verification, else parsed from the URL. */
  number?: number;
  /** The reporting item's objective, else the cure root's; there is no better source without GitHub. */
  title: string;
  /** Latest verification state; `unverified` when GitHub could not be asked. */
  state: "open" | "closed" | "merged" | "unverified";
  headSha?: string;
  verifiedAt?: string;
  mergedAt?: string;
  /** Completed items that reported this pull request, most recently updated first. */
  reportedBy: ObservableWorkItem[];
  /** The `pr-cure` root for this head, when one exists. */
  cure?: PullRequestCureRow;
}

/** Per-repository pull-request counts for the repositories index. */
export interface PullRequestSummary {
  open: number;
  /** Open pull requests whose current head has an unfinished `pr-cure` root. */
  decayed: number;
  mergedToday: number;
}

export interface PullRequestsData {
  repository: string;
  /** Open (and unverified) pull requests, highest number first. */
  open: PullRequestRow[];
  /** Merged within the last 7 days, newest merge first. */
  merged: PullRequestRow[];
  summary: PullRequestSummary;
  /** True when a source list hit the 100-row cap, so the projection may be partial. */
  truncated: boolean;
}

/**
 * The pull requests one repository's queue knows about — a read-only
 * projection over the same `QueueStore.list` reads the CLI uses, with no
 * GitHub call and no state of its own. Completed items supply the artifact
 * and its latest verification (`state`, `headSha`, `verifiedAt`, `mergedAt`);
 * `pr-cure` roots supply the decay of the current head and can contribute a
 * pull request no item reported (foreign cure). Closed pull requests, and
 * merges older than seven days, are left out.
 */
export function readPullRequests(queue: QueueStore, repository: string, now: Date = new Date()): PullRequestsData {
  const rows = new Map<string, PullRequestRow>();
  let truncated = false;

  const completed = queue.list({ status: "completed", repository, limit: LIST_LIMIT });
  if (completed.length === LIST_LIMIT) truncated = true;
  for (const raw of completed) {
    const item = withoutLeaseToken(raw);
    for (const artifact of item.result?.artifacts ?? []) {
      if (artifact.kind !== "pull-request") continue;
      absorbArtifact(rows, item, artifact);
    }
  }

  const cures = new Map<string, PullRequestCureRow[]>();
  for (const status of workStatuses) {
    const items = queue.list({ status, kind: CURE_KIND, repository, limit: LIST_LIMIT });
    if (items.length === LIST_LIMIT) truncated = true;
    for (const item of items) {
      if (!item.cure) continue;
      const key = item.cure.pullRequestUrl.toLowerCase();
      const cure: PullRequestCureRow = {
        itemId: item.id,
        status,
        active: ACTIVE_CURE_STATUSES.includes(status),
        headSha: item.cure.headSha,
        decay: [...item.cure.decay],
        createdAt: item.createdAt,
      };
      cures.set(key, [...(cures.get(key) ?? []), cure]);
      if (!rows.has(key)) {
        // A cure root for a pull request no completed item reported (a foreign
        // cure): the queue still knows the pull request is open and decayed.
        rows.set(key, {
          url: item.cure.pullRequestUrl,
          number: numberFromPullRequestUrl(item.cure.pullRequestUrl),
          title: item.objective,
          state: "open",
          headSha: item.cure.headSha,
          reportedBy: [],
        });
      }
    }
  }

  for (const [key, row] of rows) row.cure = pickCure(cures.get(key) ?? [], row.headSha);

  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const mergedSince = new Date(now.getTime() - MERGED_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const all = [...rows.values()];
  const open = all
    .filter((row) => row.state === "open" || row.state === "unverified")
    .sort((left, right) => (right.number ?? 0) - (left.number ?? 0));
  const merged = all
    .filter((row) => row.state === "merged" && (row.mergedAt ?? row.verifiedAt ?? "") >= mergedSince)
    .sort((left, right) => (right.mergedAt ?? "").localeCompare(left.mergedAt ?? ""));

  return {
    repository,
    open,
    merged,
    summary: {
      open: open.length,
      decayed: open.filter((row) => row.cure?.active === true).length,
      mergedToday: merged.filter((row) => (row.mergedAt ?? "") >= startOfToday).length,
    },
    truncated,
  };
}

/** Folds one completed item's pull-request artifact into the row for its URL, keeping the newest verification. */
function absorbArtifact(rows: Map<string, PullRequestRow>, item: ObservableWorkItem, artifact: WorkArtifact): void {
  const key = artifact.url.toLowerCase();
  const verification = artifact.verification;
  const observed =
    verification?.status === "verified"
      ? {
          number: verification.number,
          state: verification.state,
          headSha: verification.headSha,
          verifiedAt: verification.verifiedAt,
          mergedAt: verification.mergedAt,
        }
      : { state: "unverified" as const, verifiedAt: verification?.attemptedAt };
  const existing = rows.get(key);
  if (!existing) {
    rows.set(key, {
      url: artifact.url,
      number: observed.number ?? numberFromPullRequestUrl(artifact.url),
      title: item.objective,
      state: observed.state,
      headSha: observed.headSha,
      verifiedAt: observed.verifiedAt,
      mergedAt: observed.mergedAt,
      reportedBy: [item],
    });
    return;
  }
  existing.reportedBy = [...existing.reportedBy, item].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const newer = (observed.verifiedAt ?? "") > (existing.verifiedAt ?? "");
  if (newer) {
    existing.number = observed.number ?? existing.number;
    existing.state = observed.state;
    existing.headSha = observed.headSha ?? existing.headSha;
    existing.verifiedAt = observed.verifiedAt;
    existing.mergedAt = observed.mergedAt;
  }
  existing.title = existing.reportedBy[0]?.objective ?? existing.title;
}

/** The cure root bound to this head — an unfinished one wins, then the newest. */
function pickCure(cures: PullRequestCureRow[], headSha: string | undefined): PullRequestCureRow | undefined {
  const forHead = headSha ? cures.filter((cure) => cure.headSha.toLowerCase() === headSha.toLowerCase()) : cures;
  return [...forHead].sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    return right.createdAt.localeCompare(left.createdAt);
  })[0];
}

export function numberFromPullRequestUrl(url: string): number | undefined {
  const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
  return match ? Number(match[1]) : undefined;
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
