import { REVIEW_FIX_KIND, REVIEW_KIND } from "../queue/pull-request-review.ts";
import { MAX_REVIEW_ROUNDS, type ObservableWorkItem, type ReviewDecision, type WorkStatus } from "../queue/types.ts";

/**
 * What the review gate (ADR-0065) says about one pull request, as the board
 * and inbox show it — projected from the `pr-review` and `pr-review-fix`
 * items the queue already stores, with no GitHub call. The sweep is the
 * authority on what happens next; this only names the state an operator can
 * see and, where the sweep cannot advance, what the operator has to do.
 */
export interface PullRequestReviewRow {
  itemId: string;
  kind: typeof REVIEW_KIND | typeof REVIEW_FIX_KIND;
  status: WorkStatus;
  round: number;
  headSha: string;
  /** The latest completed verdict for the current head, when one exists. */
  decision?: ReviewDecision;
  /** Review or fix work is queued or claimed right now. */
  active: boolean;
  /** The sweep cannot advance this pull request: a human decides (`gh pr ready`, a push, `note`, or `requeue`). */
  needsHuman: boolean;
  /** Passed review and still a draft: mark it ready (the sweep does so only with `SNOWCAT_REVIEW_GATE_WRITES=1`). */
  readyToMark: boolean;
  /** Why a human is needed, when `needsHuman`. */
  reason?: string;
}

/**
 * Derives the row from every review/fix item bound to one pull request
 * (oldest first), the pull request's current head, and whether it is still a
 * draft. Mirrors the sweep's branching in `reviewPullRequests`.
 */
export function deriveReviewState(items: ObservableWorkItem[], currentHeadSha: string | undefined, draft: boolean): PullRequestReviewRow | undefined {
  const bound = items.filter((item): item is ObservableWorkItem & { review: NonNullable<ObservableWorkItem["review"]> } => item.review !== undefined);
  if (bound.length === 0) return undefined;
  const inFlight = bound.find((item) => item.status === "queued" || item.status === "claimed");
  if (inFlight) {
    return {
      itemId: inFlight.id,
      kind: inFlight.kind as PullRequestReviewRow["kind"],
      status: inFlight.status,
      round: inFlight.review.round,
      headSha: inFlight.review.headSha,
      active: true,
      needsHuman: false,
      readyToMark: false,
    };
  }
  const completedReviews = bound
    .filter((item) => item.kind === REVIEW_KIND && item.status === "completed" && item.review.decision !== undefined)
    .sort((left, right) => left.review.round - right.review.round);
  const latest = completedReviews.at(-1);
  const head = currentHeadSha?.toLowerCase();
  if (latest && head && latest.review.headSha.toLowerCase() === head) {
    const base = { itemId: latest.id, kind: REVIEW_KIND as typeof REVIEW_KIND, status: latest.status, round: latest.review.round, headSha: latest.review.headSha, decision: latest.review.decision, active: false };
    if (latest.review.decision === "pass") {
      return { ...base, needsHuman: false, readyToMark: draft };
    }
    if (latest.review.decision === "unable-to-review") {
      return { ...base, needsHuman: true, readyToMark: false, reason: "the reviewer was unable to review" };
    }
    const fixDone = bound.some((item) => item.kind === REVIEW_FIX_KIND && item.status === "completed" && item.review.headSha.toLowerCase() === head);
    if (fixDone) return { ...base, needsHuman: true, readyToMark: false, reason: "a fix completed without a new head" };
    if (latest.review.round >= MAX_REVIEW_ROUNDS) {
      return { ...base, needsHuman: true, readyToMark: false, reason: `blocked at round ${latest.review.round} of ${MAX_REVIEW_ROUNDS}` };
    }
    const blockedFix = bound.find((item) => item.kind === REVIEW_FIX_KIND && item.status === "blocked" && item.review.headSha.toLowerCase() === head);
    if (blockedFix) {
      return { itemId: blockedFix.id, kind: REVIEW_FIX_KIND as typeof REVIEW_FIX_KIND, status: "blocked", round: blockedFix.review.round, headSha: blockedFix.review.headSha, decision: "block", active: false, needsHuman: true, readyToMark: false, reason: "the fix is blocked" };
    }
    return { ...base, needsHuman: false, readyToMark: false };
  }
  // No completed round has judged the current head.
  const round = completedReviews.length + 1;
  const newest = bound.at(-1)!;
  if (round > MAX_REVIEW_ROUNDS) {
    return { itemId: newest.id, kind: newest.kind as PullRequestReviewRow["kind"], status: newest.status, round: completedReviews.length, headSha: newest.review.headSha, decision: latest?.review.decision, active: false, needsHuman: true, readyToMark: false, reason: `review budget exhausted (${MAX_REVIEW_ROUNDS} rounds)` };
  }
  if (newest.status === "blocked") {
    return { itemId: newest.id, kind: newest.kind as PullRequestReviewRow["kind"], status: "blocked", round: newest.review.round, headSha: newest.review.headSha, decision: latest?.review.decision, active: false, needsHuman: true, readyToMark: false, reason: `${newest.kind} is blocked` };
  }
  return { itemId: newest.id, kind: newest.kind as PullRequestReviewRow["kind"], status: newest.status, round: newest.review.round, headSha: newest.review.headSha, decision: latest?.review.decision, active: false, needsHuman: false, readyToMark: false };
}
