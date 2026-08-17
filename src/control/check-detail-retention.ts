export const CORE_CHECK_DETAIL_RETENTION_DAYS = 30;
export const CORE_CHECK_DETAIL_MAXIMUM_ELIGIBLE_CHECKS = 10_000;

export interface CoreCheckDetailCandidate {
  sequence: number;
  recordedAt: string;
  checkId: string;
}

export function coreCheckDetailCutoff(evaluatedAt: string): string {
  return new Date(
    new Date(evaluatedAt).getTime() - CORE_CHECK_DETAIL_RETENTION_DAYS * 86_400_000,
  ).toISOString();
}

export function selectCoreCheckDetailForPrune<T extends CoreCheckDetailCandidate>(
  candidates: readonly T[],
  protectedCheckIds: ReadonlySet<string>,
  cutoffAt: string,
): T[] {
  const unprotectedNewestFirst = candidates
    .filter((candidate) => !protectedCheckIds.has(candidate.checkId))
    .slice()
    .sort((left, right) => right.sequence - left.sequence);
  const retainedInsideWindow = unprotectedNewestFirst.filter((candidate) => candidate.recordedAt >= cutoffAt);
  const countOverflow = new Set(
    retainedInsideWindow
      .slice(CORE_CHECK_DETAIL_MAXIMUM_ELIGIBLE_CHECKS)
      .map((candidate) => candidate.sequence),
  );
  return unprotectedNewestFirst
    .filter((candidate) => candidate.recordedAt < cutoffAt || countOverflow.has(candidate.sequence))
    .sort((left, right) => left.sequence - right.sequence);
}
