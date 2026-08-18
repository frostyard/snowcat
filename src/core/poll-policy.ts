export const CORE_POLL_DEFAULT_INTERVAL_SECONDS = 900;
export const CORE_POLL_MINIMUM_INTERVAL_SECONDS = 60;
export const CORE_POLL_MAXIMUM_INTERVAL_SECONDS = 3600;
export const CORE_POLL_LEASE_SECONDS = 600;
export const CORE_POLL_GIT_TIMEOUT_MS = 300_000;
export const CORE_POLL_FIRST_SOURCE_BACKOFF_SECONDS = 1800;
export const CORE_POLL_MAXIMUM_SOURCE_BACKOFF_SECONDS = 3600;
export const CORE_POLL_PRUNE_INTERVAL_SECONDS = 86_400;

export function parseCorePollInterval(value: string | undefined): number {
  if (value === undefined) return CORE_POLL_DEFAULT_INTERVAL_SECONDS;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("SNOWCAT_CORE_POLL_INTERVAL_SECONDS must be one canonical positive integer");
  }
  const interval = Number(value);
  if (
    !Number.isSafeInteger(interval) ||
    interval < CORE_POLL_MINIMUM_INTERVAL_SECONDS ||
    interval > CORE_POLL_MAXIMUM_INTERVAL_SECONDS
  ) {
    throw new Error(
      `SNOWCAT_CORE_POLL_INTERVAL_SECONDS must be from ${CORE_POLL_MINIMUM_INTERVAL_SECONDS} through ${CORE_POLL_MAXIMUM_INTERVAL_SECONDS}`,
    );
  }
  return interval;
}

export function corePollDelaySeconds(
  healthyIntervalSeconds: number,
  sourceOutcome: string | null,
  sourceUnavailableStreak: number,
): number {
  if (sourceOutcome !== "source-unavailable") return healthyIntervalSeconds;
  return sourceUnavailableStreak <= 1
    ? Math.max(healthyIntervalSeconds, CORE_POLL_FIRST_SOURCE_BACKOFF_SECONDS)
    : Math.max(healthyIntervalSeconds, CORE_POLL_MAXIMUM_SOURCE_BACKOFF_SECONDS);
}

export function addSeconds(instant: string, seconds: number): string {
  return new Date(new Date(instant).getTime() + seconds * 1000).toISOString();
}
