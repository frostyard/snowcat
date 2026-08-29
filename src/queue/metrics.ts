import type { QueueMetricsWindow, QueueStore } from "./store.ts";
import { pullRequestArtifactIdentity } from "./artifact-identity.ts";
import { deliveryStates, deriveDelivery, workStatuses, type DeliveryState, type WorkStatus } from "./types.ts";

const HOUR_MS = 60 * 60 * 1000;

/** Length of the window `metrics` reports when neither `--since` nor `--until` is given. */
export const DEFAULT_METRICS_WINDOW_HOURS = 24;

/**
 * Hours from a completion to its pull request's merge, over the merged
 * pull-request artifacts of the items completed in the window. `median` and
 * `p90` are `null` exactly when `count` is 0.
 */
export interface TimeToMergeHours {
  count: number;
  median: number | null;
  p90: number | null;
}

/** The PRD baseline numbers for one repository (or, in `all`, for the whole window). */
export interface RepositoryMetrics {
  /** Items created in the window, counted by the logical status they hold now. */
  created: Record<WorkStatus, number>;
  /** `work.claimed` events in the window: how often a worker took the work. */
  attempts: number;
  /** `work.completed` events in the window. */
  completed: number;
  /** Those completions by the completed item's current `delivery`. */
  completedByDelivery: Record<DeliveryState, number>;
  /** Unique pull requests reported by completions in the window whose current state is merged. */
  accepted: number;
  /** Terminal pull-request delivery acceptance, with censored and excluded completions explicit. */
  acceptance: {
    numerator: number;
    denominator: number;
    rate: number | null;
    open: number;
    unavailable: number;
    excluded: number;
  };
  /** `work.blocked` events in the window. */
  blocked: number;
  /** `work.cancelled` events in the window. */
  cancelled: number;
  timeToMergeHours: TimeToMergeHours;
}

/** One `metrics` reading: the window it covers, the total, and each repository in it. */
export interface QueueMetrics {
  /** Start of the window, inclusive. */
  since: string;
  /** End of the window, exclusive. */
  until: string;
  /** Present when the reading was narrowed to one repository. */
  repository?: string;
  all: RepositoryMetrics;
  repositories: Record<string, RepositoryMetrics>;
}

interface MetricsAccumulator {
  created: Record<WorkStatus, number>;
  attempts: number;
  completed: number;
  completedByDelivery: Record<DeliveryState, number>;
  acceptanceExcluded: number;
  pullRequests: Map<string, PullRequestSample>;
  blocked: number;
  cancelled: number;
}

interface PullRequestSample {
  state: "unverified" | "open" | "closed" | "merged";
  observedAt: string;
  reportedAt: string;
  completedAt: string;
  mergedAt?: string;
}

/**
 * Validates one operator-supplied window bound and returns it in the
 * ISO-8601 UTC form the ledger stores. `name` is the caller's word for the
 * value, so a CLI can name the flag the operator typed.
 */
export function parseMetricsTimestamp(value: string, name: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be an ISO timestamp (for example 2026-08-19T00:00:00Z), got ${value}`);
  }
  return parsed.toISOString();
}

/**
 * The half-open window `[since, until)` a reading covers: the last
 * `DEFAULT_METRICS_WINDOW_HOURS` hours ending now, `since` alone running
 * from it to now, and `until` alone starting
 * `DEFAULT_METRICS_WINDOW_HOURS` hours before it.
 */
export function resolveMetricsWindow(
  options: { since?: string; until?: string } = {},
  now: Date = new Date(),
): { since: string; until: string } {
  const until = options.until === undefined ? now.toISOString() : parseMetricsTimestamp(options.until, "until");
  const since =
    options.since === undefined
      ? new Date(Date.parse(until) - DEFAULT_METRICS_WINDOW_HOURS * HOUR_MS).toISOString()
      : parseMetricsTimestamp(options.since, "since");
  if (since >= until) throw new Error(`since must be before until (got ${since} and ${until})`);
  return { since, until };
}

/**
 * The PRD baseline numbers of one bounded window read, per repository and in
 * total. Pure: it derives every field from the rows it is given — no clock,
 * no store, no GitHub — so the same window always yields the same numbers.
 */
export function computeQueueMetrics(window: QueueMetricsWindow): QueueMetrics {
  const all = emptyAccumulator();
  const repositories = new Map<string, MetricsAccumulator>();
  const accumulatorFor = (repository: string): MetricsAccumulator => {
    const existing = repositories.get(repository);
    if (existing) return existing;
    const created = emptyAccumulator();
    repositories.set(repository, created);
    return created;
  };

  for (const row of window.created) {
    for (const accumulator of [all, accumulatorFor(row.repository)]) {
      accumulator.created[row.status] += row.count;
    }
  }

  for (const event of window.events) {
    for (const accumulator of [all, accumulatorFor(event.repository)]) {
      if (event.type === "work.claimed") {
        accumulator.attempts += 1;
      } else if (event.type === "work.blocked") {
        accumulator.blocked += 1;
      } else if (event.type === "work.cancelled") {
        accumulator.cancelled += 1;
      } else if (event.type === "work.completed") {
        accumulator.completed += 1;
        const delivery = deriveDelivery(event.result);
        accumulator.completedByDelivery[delivery] += 1;
        const pullRequests = (event.result?.artifacts ?? []).filter((artifact) => artifact.kind === "pull-request");
        if (pullRequests.length === 0) {
          accumulator.acceptanceExcluded += 1;
        } else {
          for (const artifact of pullRequests) {
            const verification = artifact.verification;
            const state =
              verification?.status !== "verified"
                ? "unverified"
                : verification.state === "merged"
                  ? "merged"
                  : verification.state === "closed"
                    ? "closed"
                    : verification.state === "open"
                      ? "open"
                      : "unverified";
            const sample: PullRequestSample = {
              state,
              observedAt:
                verification?.status === "verified"
                  ? verification.verifiedAt
                  : verification?.attemptedAt ?? event.occurredAt,
              reportedAt: event.occurredAt,
              completedAt: event.occurredAt,
              ...(verification?.status === "verified" && verification.mergedAt
                ? { mergedAt: verification.mergedAt }
                : {}),
            };
            const identity = pullRequestArtifactIdentity(event.repository, artifact);
            accumulator.pullRequests.set(
              identity,
              mergePullRequestSample(accumulator.pullRequests.get(identity), sample),
            );
          }
        }
      }
    }
  }

  return {
    since: window.since,
    until: window.until,
    ...(window.repository === undefined ? {} : { repository: window.repository }),
    all: finalize(all),
    repositories: Object.fromEntries(
      [...repositories.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([repository, accumulator]) => [repository, finalize(accumulator)]),
    ),
  };
}

/**
 * Reads one window from the store and computes its metrics. Read-only: it
 * calls `QueueStore.metricsWindow` and nothing else, and is deliberately not
 * exposed through MCP.
 */
export function queueMetrics(
  store: QueueStore,
  options: { repository?: string; since?: string; until?: string; now?: Date } = {},
): QueueMetrics {
  const window = resolveMetricsWindow({ since: options.since, until: options.until }, options.now);
  return computeQueueMetrics(store.metricsWindow({ ...window, repository: options.repository }));
}

/**
 * Hours from a completion to the merge of each pull request the completed
 * item reported as merged. A pull request Snowcat has not verified, or one
 * GitHub reports as open or closed, contributes nothing.
 */
function mergePullRequestSample(existing: PullRequestSample | undefined, next: PullRequestSample): PullRequestSample {
  if (!existing) return next;
  const existingVerified = existing.state !== "unverified";
  const nextVerified = next.state !== "unverified";
  const observation =
    existingVerified !== nextVerified
      ? nextVerified
        ? next
        : existing
      : `${next.observedAt}\0${next.reportedAt}` > `${existing.observedAt}\0${existing.reportedAt}`
        ? next
        : existing;
  const completedAt = existing.completedAt <= next.completedAt ? existing.completedAt : next.completedAt;
  return { ...observation, completedAt };
}

function emptyAccumulator(): MetricsAccumulator {
  return {
    created: Object.fromEntries(workStatuses.map((status) => [status, 0])) as Record<WorkStatus, number>,
    attempts: 0,
    completed: 0,
    completedByDelivery: Object.fromEntries(deliveryStates.map((state) => [state, 0])) as Record<DeliveryState, number>,
    acceptanceExcluded: 0,
    pullRequests: new Map(),
    blocked: 0,
    cancelled: 0,
  };
}

function finalize(accumulator: MetricsAccumulator): RepositoryMetrics {
  const samples = [...accumulator.pullRequests.values()];
  const accepted = samples.filter((sample) => sample.state === "merged").length;
  const closed = samples.filter((sample) => sample.state === "closed").length;
  const open = samples.filter((sample) => sample.state === "open").length;
  const unavailable = samples.filter((sample) => sample.state === "unverified").length;
  const mergeHours = samples.flatMap((sample) => {
    if (sample.state !== "merged" || sample.mergedAt === undefined) return [];
    const completed = Date.parse(sample.completedAt);
    const mergedAt = Date.parse(sample.mergedAt);
    if (Number.isNaN(completed) || Number.isNaN(mergedAt)) return [];
    return [round3((mergedAt - completed) / HOUR_MS)];
  });
  // Field order follows the reported order, so a printed reading reads the
  // way the spec and the runbook describe it.
  return {
    created: accumulator.created,
    attempts: accumulator.attempts,
    completed: accumulator.completed,
    completedByDelivery: accumulator.completedByDelivery,
    accepted,
    acceptance: {
      numerator: accepted,
      denominator: accepted + closed,
      rate: accepted + closed === 0 ? null : round3(accepted / (accepted + closed)),
      open,
      unavailable,
      excluded: accumulator.acceptanceExcluded,
    },
    blocked: accumulator.blocked,
    cancelled: accumulator.cancelled,
    timeToMergeHours: summarize(mergeHours),
  };
}

/** Median and nearest-rank p90 of a sample, each rounded to 3 decimals. */
function summarize(samples: number[]): TimeToMergeHours {
  if (samples.length === 0) return { count: 0, median: null, p90: null };
  const sorted = samples.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[middle]! : round3((sorted[middle - 1]! + sorted[middle]!) / 2);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(0.9 * sorted.length)));
  return { count: sorted.length, median, p90: sorted[rank - 1]! };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
