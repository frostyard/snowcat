export const GITHUB_DELIVERY_AUDIT_DEFAULT_INTERVAL_SECONDS = 300;
export const GITHUB_DELIVERY_AUDIT_MINIMUM_INTERVAL_SECONDS = 60;
export const GITHUB_DELIVERY_AUDIT_MAXIMUM_INTERVAL_SECONDS = 900;
export const GITHUB_DELIVERY_AUDIT_LEASE_SECONDS = 600;
export const GITHUB_DELIVERY_AUDIT_SAFETY_DEADLINE_SECONDS = 48 * 60 * 60;

const INCOMPLETE_RETRY_SECONDS = [60, 300, 900] as const;

export function parseGitHubDeliveryAuditInterval(value: string | undefined): number {
  if (value === undefined) return GITHUB_DELIVERY_AUDIT_DEFAULT_INTERVAL_SECONDS;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("FLUENT_GITHUB_DELIVERY_AUDIT_INTERVAL_SECONDS must be one canonical positive integer");
  }
  const interval = Number(value);
  assertGitHubDeliveryAuditInterval(interval);
  return interval;
}

export function assertGitHubDeliveryAuditInterval(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < GITHUB_DELIVERY_AUDIT_MINIMUM_INTERVAL_SECONDS ||
    value > GITHUB_DELIVERY_AUDIT_MAXIMUM_INTERVAL_SECONDS
  ) {
    throw new Error(
      `GitHub delivery-audit interval must be from ${GITHUB_DELIVERY_AUDIT_MINIMUM_INTERVAL_SECONDS} through ${GITHUB_DELIVERY_AUDIT_MAXIMUM_INTERVAL_SECONDS} seconds`,
    );
  }
}

export function githubDeliveryAuditRetrySeconds(incompleteStreak: number): number {
  if (!Number.isSafeInteger(incompleteStreak) || incompleteStreak < 1) {
    throw new Error("GitHub delivery-audit incomplete streak must be a positive safe integer");
  }
  return INCOMPLETE_RETRY_SECONDS[Math.min(incompleteStreak, INCOMPLETE_RETRY_SECONDS.length) - 1]!;
}

export function addGitHubAuditSeconds(instant: string, seconds: number): string {
  return new Date(new Date(instant).getTime() + seconds * 1000).toISOString();
}
