import { githubApiJson, githubGraphql, type GitHubFetch } from "../repository/github-api.ts";
import { asObject, listOpenPullRequests, MAX_LISTING_PAGES, parsePullRequestUrl, readPatchDigest } from "./pull-request-cure.ts";
import type { QueueStore } from "./store.ts";
import {
  MAX_REVIEW_ADVISORIES,
  MAX_REVIEW_BLOCKERS,
  MAX_REVIEW_ROUNDS,
  type AllowedAction,
  type PullRequestReview,
  type ReviewBlocker,
  type ReviewResult,
  type SeedWorkInput,
  type UnreportedPullRequest,
  type WorkArtifact,
  type WorkItem,
} from "./types.ts";

/**
 * Review gate (ADR-0065, implementing ADR-0029's pull-request profile): in a
 * repository with `review_gate` on, workers open pull requests as drafts and
 * the verification pass creates one admitted, read-only `pr-review` round per
 * draft head. The reviewer completes with a structured verdict; Snowcat — not
 * the model — acts on it: a `pass` marks the pull request ready for review
 * (when `SNOWCAT_REVIEW_GATE_WRITES=1`), a `block` creates one bounded
 * `pr-review-fix` root while the per-pull-request round budget lasts, and a
 * third-round block or an `unable-to-review` leaves the pull request a draft
 * for a human. A draft is never cured (ADR-0061) and is skipped by Copilot's
 * automatic review and by the fleet's review-apply workflows, so review/fix
 * and cure never act on one pull request at the same time.
 */

const GITHUB_TIMEOUT_MS = 30_000;
const MARK_READY_MUTATION = `mutation SnowcatMarkReady($id: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $id }) {
    pullRequest { isDraft }
  }
}`;
const CONVERT_TO_DRAFT_MUTATION = `mutation SnowcatConvertToDraft($id: ID!) {
  convertPullRequestToDraft(input: { pullRequestId: $id }) {
    pullRequest { isDraft }
  }
}`;

export const REVIEW_KIND = "pr-review";
export const REVIEW_FIX_KIND = "pr-review-fix";
/** A review is read-only with respect to GitHub; running the repository's own checks locally is allowed. */
export const REVIEW_ACTIONS: AllowedAction[] = ["read", "run-tests"];
export const REVIEW_FIX_ACTIONS: AllowedAction[] = ["read", "write", "run-tests", "open-pr"];
export const REVIEW_ACTOR = "policy:review-gate";
/** Set to `1` on the host to let the sweep mark a passed draft ready for review; the token then needs pull-requests write. */
export const REVIEW_GATE_WRITES_VARIABLE = "SNOWCAT_REVIEW_GATE_WRITES";

export interface ReviewOptions {
  fetcher?: GitHubFetch;
  clock?: () => Date;
}

export interface PullRequestHead {
  number: number;
  url: string;
  /** GraphQL node id, needed to mark the pull request ready. */
  nodeId: string | undefined;
  headSha: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  title: string;
}

export type PullRequestHeadCheck =
  | { kind: "head"; head: PullRequestHead }
  | { kind: "unavailable"; reason: string }
  | { kind: "rejected"; reason: string };

/** One `GET /pulls/N`: the head, state, and draft flag Snowcat binds a review round to. */
export async function readPullRequestHead(repository: string, url: string, options: ReviewOptions = {}): Promise<PullRequestHeadCheck> {
  const fetcher = options.fetcher ?? fetch;
  const locator = parsePullRequestUrl(repository, url);
  if (!locator) return { kind: "rejected", reason: `${url} is not a ${repository} pull-request URL` };
  const base = `/repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.name)}`;
  const pull = await githubApiJson(`${base}/pulls/${locator.number}`, AbortSignal.timeout(GITHUB_TIMEOUT_MS), fetcher);
  if (pull.kind === "unavailable") return { kind: "unavailable", reason: "GitHub API unavailable" };
  if (pull.status === 404 || pull.status === 410) {
    if (!process.env.SNOWCAT_GITHUB_TOKEN) return { kind: "unavailable", reason: `GitHub returned ${pull.status} without SNOWCAT_GITHUB_TOKEN` };
    return { kind: "rejected", reason: `pull request ${url} does not exist on GitHub` };
  }
  if (pull.status !== 200) return { kind: "unavailable", reason: `GitHub API returned HTTP ${pull.status}` };
  const record = asObject(pull.value);
  if (!record) return { kind: "unavailable", reason: "GitHub response was not an object" };
  if (Number(record.number) !== locator.number) return { kind: "rejected", reason: `pull request number does not match ${url}` };
  const baseRepo = asObject(asObject(record.base)?.repo);
  if (typeof baseRepo?.full_name !== "string" || baseRepo.full_name.toLowerCase() !== repository.toLowerCase()) {
    return { kind: "rejected", reason: `pull request ${url} does not target ${repository}` };
  }
  const headSha = asObject(record.head)?.sha;
  if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/i.test(headSha)) return { kind: "unavailable", reason: "GitHub response has no head SHA" };
  const state: PullRequestHead["state"] = record.merged === true ? "merged" : record.state === "closed" ? "closed" : record.state === "open" ? "open" : "closed";
  return {
    kind: "head",
    head: {
      number: locator.number,
      url,
      nodeId: typeof record.node_id === "string" ? record.node_id : undefined,
      headSha: headSha.toLowerCase(),
      state,
      draft: record.draft === true,
      title: typeof record.title === "string" ? record.title : "",
    },
  };
}

/** Whether the host lets the sweep write ready-for-review (off by default; variant B shows the operator what to mark). */
export function reviewGateWritesFromEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment[REVIEW_GATE_WRITES_VARIABLE] === "1";
}

/**
 * Marks a draft pull request ready for review through GraphQL (REST cannot
 * flip the draft flag). Done by Snowcat as `policy:review-gate` on a recorded
 * `pass`, never by a model. The mutation binds to the pull request, not to a
 * head, so the sweep re-reads the head afterwards and converts back to draft
 * when it moved in between (`convertPullRequestToDraft`).
 */
export async function markPullRequestReady(nodeId: string, fetcher: GitHubFetch = fetch): Promise<{ kind: "marked" } | { kind: "unavailable"; reason: string }> {
  return draftMutation(MARK_READY_MUTATION, "markPullRequestReadyForReview", false, nodeId, fetcher).then((outcome) => (outcome.kind === "done" ? { kind: "marked" } : outcome));
}

/** Converts a pull request back to a draft: the compensating write when a head moved while it was being marked ready. */
export async function convertPullRequestToDraft(nodeId: string, fetcher: GitHubFetch = fetch): Promise<{ kind: "converted" } | { kind: "unavailable"; reason: string }> {
  return draftMutation(CONVERT_TO_DRAFT_MUTATION, "convertPullRequestToDraft", true, nodeId, fetcher).then((outcome) => (outcome.kind === "done" ? { kind: "converted" } : outcome));
}

async function draftMutation(
  mutation: string,
  field: string,
  expectedDraft: boolean,
  nodeId: string,
  fetcher: GitHubFetch,
): Promise<{ kind: "done" } | { kind: "unavailable"; reason: string }> {
  const response = await githubGraphql(mutation, { id: nodeId }, AbortSignal.timeout(GITHUB_TIMEOUT_MS), fetcher);
  if (response.kind === "unavailable") return { kind: "unavailable", reason: "GitHub GraphQL unavailable" };
  if (response.status !== 200) return { kind: "unavailable", reason: `GitHub GraphQL returned HTTP ${response.status}` };
  const envelope = asObject(response.value);
  const pull = asObject(asObject(asObject(envelope?.data)?.[field])?.pullRequest);
  if (pull?.isDraft === expectedDraft) return { kind: "done" };
  const errors = Array.isArray(envelope?.errors)
    ? envelope.errors.map((error) => asObject(error)?.message).filter((message): message is string => typeof message === "string")
    : [];
  return {
    kind: "unavailable",
    reason: errors.length > 0 ? `GitHub GraphQL errors: ${errors.join("; ")}` : `GitHub did not confirm the pull request ${expectedDraft ? "became a draft" : "left draft"}`,
  };
}

export interface ReviewSweepResult {
  /** Draft pull requests in review-gated repositories that were inspected (deduplicated by URL). */
  inspected: number;
  enqueued: Array<{ id: string; kind: string; url: string; headSha: string; round: number }>;
  /** Passed heads the sweep marked ready for review (writes on). */
  markedReady: Array<{ url: string; headSha: string; reviewItemId: string }>;
  /** Passed heads waiting for a human to mark ready (writes off). */
  readyToMark: Array<{ url: string; headSha: string; reviewItemId: string }>;
  /** Pull requests the gate cannot advance by itself: round budget spent, third-round block, unable-to-review, or a head that moved while being marked ready. */
  needsHuman: Array<{ url: string; headSha: string; round: number; reason: string }>;
  skipped: Array<{ url: string; reason: string }>;
  unavailable: Array<{ url: string; reason: string }>;
  /**
   * Open pull requests GitHub lists in a gated repository that no completed
   * item reported and no `pr-review`, `pr-review-fix`, or `pr-cure` item is
   * bound to: outside the gate until a human closes one or attaches it to the
   * item that should have reported it. The sweep creates no work for them.
   */
  unreported: UnreportedPullRequest[];
}

/**
 * The review sweep: for every open draft pull request that a completed item
 * reported in a review-gated repository, read its head and either create the
 * next bounded review round, act on the latest verdict for that head, or
 * report that a human is needed. Then, per gated repository, list the open
 * pull requests GitHub knows and report the ones the queue cannot account for
 * at all (`unreported`) — no work, a persisted finding for the operator.
 * Runs after `refreshArtifactVerifications` and `curePullRequests` on the
 * same timer; reads nothing when no repository has the gate on.
 */
export async function reviewPullRequests(
  queue: QueueStore,
  options: ReviewOptions & { repository?: string; limit?: number; actor?: string; writes?: boolean } = {},
): Promise<ReviewSweepResult> {
  const actor = options.actor ?? REVIEW_ACTOR;
  const result: ReviewSweepResult = { inspected: 0, enqueued: [], markedReady: [], readyToMark: [], needsHuman: [], skipped: [], unavailable: [], unreported: [] };
  const gatedRepositories = queue
    .repositoryReviewGateSettings()
    .filter((setting) => setting.reviewGate)
    .filter((setting) => options.repository === undefined || setting.repository.toLowerCase() === options.repository.toLowerCase())
    .map((setting) => setting.repository);
  const gated = new Set(gatedRepositories.map((repository) => repository.toLowerCase()));
  if (gated.size === 0) return result;

  const items = queue.completedItemsWithPendingArtifacts({ repository: options.repository, limit: options.limit ?? 100 });
  const candidates = new Map<string, { repository: string; priority: number; originItemId: string; authorModel?: string }>();
  for (const item of items) {
    if (item.kind === REVIEW_KIND || item.kind === REVIEW_FIX_KIND) continue;
    if (!gated.has(item.repository.toLowerCase())) continue;
    for (const artifact of item.result?.artifacts ?? []) {
      if (artifact.kind !== "pull-request" || artifact.verification?.status !== "verified") continue;
      if (artifact.verification.state !== "open" || artifact.verification.draft !== true) continue;
      const candidate = { repository: item.repository, priority: item.priority, originItemId: item.id, ...(item.result?.model ? { authorModel: item.result.model } : {}) };
      const existing = candidates.get(artifact.url);
      if (!existing || item.priority > existing.priority) candidates.set(artifact.url, candidate);
    }
  }

  for (const [url, origin] of candidates) {
    result.inspected += 1;
    const check = await readPullRequestHead(origin.repository, url, options);
    if (check.kind === "unavailable") {
      result.unavailable.push({ url, reason: check.reason });
      continue;
    }
    if (check.kind === "rejected") {
      result.skipped.push({ url, reason: check.reason });
      continue;
    }
    const { head } = check;
    if (head.state !== "open") {
      result.skipped.push({ url, reason: `pull request is ${head.state}` });
      continue;
    }
    if (!head.draft) {
      result.skipped.push({ url, reason: "pull request is not a draft" });
      continue;
    }
    const reviews = queue.pullRequestReviewItems(origin.repository, url);
    if (reviews.some((item) => item.status === "queued" || item.status === "claimed")) {
      result.skipped.push({ url, reason: "a review or fix is in flight" });
      continue;
    }
    const completedReviews = reviews
      .filter((item) => item.kind === REVIEW_KIND && item.status === "completed" && item.review?.decision !== undefined)
      .sort((left, right) => left.review!.round - right.review!.round);
    const latest = completedReviews.at(-1);

    if (latest?.review && latest.review.headSha === head.headSha) {
      const verdict = latest.review;
      if (verdict.decision === "pass") {
        if (options.writes) {
          if (!head.nodeId) {
            result.unavailable.push({ url, reason: "GitHub response has no node id; cannot mark ready" });
            continue;
          }
          const marked = await markPullRequestReady(head.nodeId, options.fetcher ?? fetch);
          if (marked.kind === "unavailable") {
            result.unavailable.push({ url, reason: `mark ready failed: ${marked.reason}` });
            continue;
          }
          // The mutation binds to the pull request, not the head: re-read, and
          // if a push landed between the read and the mark, convert back to a
          // draft so no ready pull request carries an unreviewed head. The new
          // head is then the next round's (or a human's) on a later pass.
          const after = await readPullRequestHead(origin.repository, url, options);
          const movedTo = after.kind === "head" && after.head.state === "open" && after.head.headSha !== head.headSha ? after.head.headSha : undefined;
          if (after.kind === "unavailable" || movedTo) {
            const reason = movedTo
              ? `head moved to ${movedTo.slice(0, 7)} while being marked ready`
              : `head could not be re-read after marking ready: ${after.kind === "unavailable" ? after.reason : "unknown"}`;
            const reverted = await convertPullRequestToDraft(head.nodeId, options.fetcher ?? fetch);
            if (reverted.kind === "converted") {
              result.needsHuman.push({ url, headSha: movedTo ?? head.headSha, round: verdict.round, reason: `${reason}; converted back to draft` });
            } else {
              result.unavailable.push({ url, reason: `${reason}; converting back to draft failed: ${reverted.reason} — the pull request is ready with an unreviewed head` });
            }
            continue;
          }
          queue.recordPullRequestReady(origin.originItemId, url, actor, { headSha: head.headSha, reviewItemId: latest.id });
          result.markedReady.push({ url, headSha: head.headSha, reviewItemId: latest.id });
        } else {
          result.readyToMark.push({ url, headSha: head.headSha, reviewItemId: latest.id });
        }
        continue;
      }
      if (verdict.decision === "unable-to-review") {
        result.needsHuman.push({ url, headSha: head.headSha, round: verdict.round, reason: "the reviewer was unable to review" });
        continue;
      }
      // block
      if (reviews.some((item) => item.kind === REVIEW_FIX_KIND && item.status === "completed" && item.review?.headSha === head.headSha)) {
        result.needsHuman.push({ url, headSha: head.headSha, round: verdict.round, reason: "a fix completed without a new head" });
        continue;
      }
      if (verdict.round >= MAX_REVIEW_ROUNDS) {
        result.needsHuman.push({ url, headSha: head.headSha, round: verdict.round, reason: `blocked at round ${verdict.round} of ${MAX_REVIEW_ROUNDS}` });
        continue;
      }
      const fixReview: PullRequestReview = {
        pullRequestUrl: url,
        headSha: head.headSha,
        ...(verdict.patchDigest ? { patchDigest: verdict.patchDigest } : {}),
        round: verdict.round,
        ...(verdict.originItemId ? { originItemId: verdict.originItemId } : {}),
        ...(verdict.authorModel ? { authorModel: verdict.authorModel } : {}),
        priorBlockers: [],
        reviewItemId: latest.id,
        ...(latest.result?.model ? { reviewerModel: latest.result.model } : {}),
        blockers: verdict.blockers ?? [],
        advisories: verdict.advisories ?? [],
      };
      const created = queue.enqueueReviewRoot(origin.repository, {
        ...reviewFixRootDefinition(origin.repository, head, fixReview, actor),
        priority: origin.priority,
        sourceRef: `${REVIEW_FIX_KIND}:${url}@${head.headSha}`,
        review: fixReview,
      });
      if (!created) {
        result.skipped.push({ url, reason: `head ${head.headSha.slice(0, 7)} already has a fix item` });
        continue;
      }
      result.enqueued.push({ id: created.id, kind: REVIEW_FIX_KIND, url, headSha: head.headSha, round: verdict.round });
      continue;
    }

    // A head no completed round has judged: the next round, while budget lasts.
    const round = completedReviews.length + 1;
    if (round > MAX_REVIEW_ROUNDS) {
      result.needsHuman.push({ url, headSha: head.headSha, round, reason: `review budget exhausted (${MAX_REVIEW_ROUNDS} rounds)` });
      continue;
    }
    const locator = parsePullRequestUrl(origin.repository, url)!;
    const digest = await readPatchDigest(`/repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.name)}`, locator.number, options.fetcher ?? fetch);
    const review: PullRequestReview = {
      pullRequestUrl: url,
      headSha: head.headSha,
      ...(digest.kind === "digest" ? { patchDigest: digest.digest } : {}),
      round,
      originItemId: origin.originItemId,
      ...(origin.authorModel ? { authorModel: origin.authorModel } : {}),
      ...(latest?.result?.model ? { priorReviewerModel: latest.result.model } : {}),
      priorBlockers: latest?.review?.blockers ?? [],
    };
    const created = queue.enqueueReviewRoot(origin.repository, {
      ...reviewRootDefinition(origin.repository, head, review, actor, latest?.review?.headSha),
      priority: origin.priority,
      sourceRef: `${REVIEW_KIND}:${url}@${head.headSha}`,
      review,
    });
    if (!created) {
      result.skipped.push({ url, reason: `head ${head.headSha.slice(0, 7)} already has a review item` });
      continue;
    }
    result.enqueued.push({ id: created.id, kind: REVIEW_KIND, url, headSha: head.headSha, round });
  }

  await observeUnreportedPullRequests(queue, result, gatedRepositories, actor, options);
  return result;
}

/**
 * The unreported pass: one bounded open pull-request listing per gated
 * repository (the same one foreign cure uses), minus every URL the queue can
 * already account for — a completed item's artifact, a `pr-review` or
 * `pr-review-fix` binding, a `pr-cure` binding. What remains is a pull request
 * the gate cannot see: it was never reviewed, never marked ready, and no item
 * carries it. Nothing is enqueued for one — an orphan is a human decision
 * (close it, or `queue -- attach-artifact <id> <url>` to bring it under the
 * gate, after which the next pass reviews it) — but the finding is persisted
 * per repository so the surface can show it without calling GitHub. A listing
 * GitHub could not serve leaves the previous observation standing.
 */
async function observeUnreportedPullRequests(
  queue: QueueStore,
  result: ReviewSweepResult,
  repositories: string[],
  actor: string,
  options: ReviewOptions,
): Promise<void> {
  const observedAt = (options.clock?.() ?? new Date()).toISOString();
  for (const repository of repositories) {
    const listing = await listOpenPullRequests(repository, options.fetcher ?? fetch);
    if (listing.kind === "unavailable") {
      result.unavailable.push({ url: `https://github.com/${repository}/pulls`, reason: listing.reason });
      continue;
    }
    if (listing.truncated) {
      result.skipped.push({ url: `https://github.com/${repository}/pulls`, reason: `more than ${MAX_LISTING_PAGES * 100} open pull requests; the rest were not listed` });
    }
    const seen = new Set(queue.knownPullRequestUrls(repository));
    const unreported: UnreportedPullRequest[] = [];
    for (const pull of listing.pulls) {
      if (seen.has(pull.url.toLowerCase())) continue;
      seen.add(pull.url.toLowerCase());
      unreported.push({ url: pull.url, number: pull.number, draft: pull.draft, ...(pull.createdAt ? { createdAt: pull.createdAt } : {}) });
    }
    queue.recordUnreportedPullRequests(repository, { observedAt, pullRequests: unreported }, actor);
    result.unreported.push(...unreported);
  }
}

function describeBlockers(blockers: ReviewBlocker[]): string {
  return blockers
    .map(
      (blocker) =>
        `[${blocker.fingerprint}] at ${blocker.location}: ${blocker.contract} — impact: ${blocker.impact}; resolution: ${blocker.resolution}; verify: ${blocker.verification}`,
    )
    .join(" | ");
}

/** The `pr-review` root definition for one draft head: read-only, bounded, structured verdict. */
export function reviewRootDefinition(
  repository: string,
  head: Pick<PullRequestHead, "url" | "number" | "headSha" | "title">,
  review: PullRequestReview,
  createdBy: string,
  previousHeadSha?: string,
): Omit<SeedWorkInput, "repository" | "priority"> {
  const short = head.headSha.slice(0, 7);
  const origin = review.originItemId ? `item ${review.originItemId}` : "a Snowcat worker";
  return {
    kind: REVIEW_KIND,
    objective: `Review ${repository}#${head.number} (head ${short}, round ${review.round} of ${MAX_REVIEW_ROUNDS})`,
    instructions: [
      `Pull request ${head.url} ("${head.title}") at head ${head.headSha} was opened as a DRAFT for ${origin} and waits for an independent review before a human sees it (ADR-0029, ADR-0065).`,
      ...(review.originItemId
        ? [`Read the origin item with get_work("${review.originItemId}"): its objective, acceptance criteria, instructions, and sourceRef issue are the contract this pull request claims to satisfy.`]
        : []),
      `Read the pull request's description and its diff at exactly head ${short} (for example \`gh pr diff ${head.number}\` or \`gh api repos/${repository}/pulls/${head.number}/files\`); check the head out and run the repository's own checks locally when you can.`,
      "Apply ADR-0029's pull-request profile. A blocker is ONLY a concrete correctness or security defect, an unmet acceptance criterion of the origin item, unauthorized or out-of-scope behaviour, false or materially insufficient evidence in the pull request, missing required validation, or a compatibility or contract break. Style preferences, optional improvements, alternative valid designs, speculative future concerns, and 'while you are here' work are advisories at most — never blockers.",
      ...(review.round > 1
        ? [
            `This is round ${review.round}: examine the prior round's blockers and the diff since head ${(previousHeadSha ?? "").slice(0, 7) || "the previous round"}, not a fresh unrestricted audit. Reuse a prior fingerprint for a blocker that is still open; name a new blocker only when this diff introduced it or made it newly assessable, and say why. Prior blockers: ${review.priorBlockers.length > 0 ? describeBlockers(review.priorBlockers) : "none"}.`,
          ]
        : []),
      ...(review.authorModel || review.priorReviewerModel
        ? [
            `Cognitive diversity: ${[review.authorModel ? `the author reported model ${review.authorModel}` : "", review.priorReviewerModel ? `the previous reviewer reported model ${review.priorReviewerModel}` : ""].filter(Boolean).join(" and ")}; review with a different model or provider when your client can choose. If you completed the origin item yourself in this session, release this item so another worker reviews it.`,
          ]
        : ["If you completed the origin item yourself in this session, release this item so another worker reviews it."]),
      "You are READ-ONLY on GitHub: do not comment, submit a review, approve, push, edit, or mark the pull request ready; do not create follow-ups. Snowcat acts on your verdict deterministically — a pass marks the pull request ready for a human, a block schedules one bounded fix — and never merges.",
      `Complete with \`review\` on complete_work: decision pass | block | unable-to-review; at most ${MAX_REVIEW_BLOCKERS} blockers, each with a stable fingerprint (for example \`defect:<path>:<short-slug>\`), exact location, the violated acceptance criterion, contract, or concrete counterexample, the material impact, the minimally sufficient resolution, and a verification method; at most ${MAX_REVIEW_ADVISORIES} advisories. A block needs at least one blocker; a pass carries none. Report the model you ran as result.model. Do not report the pull request as an artifact — it is not yours. If the head moved since this item was created, block_work with that reason.`,
    ].join(" "),
    acceptanceCriteria: [
      "The verdict is supplied as `review` on complete_work — decision, bounded blockers, bounded advisories — and Snowcat accepts it against the head this item names.",
      "Every blocker cites an exact location and the origin acceptance criterion, contract, or concrete counterexample it violates, with a minimal resolution and a verification method.",
      "No GitHub comment, review, approval, push, edit, or ready-for-review change was made.",
      `The evidence names the head SHA reviewed (${head.headSha}) and the checks run locally, or why none could be run.`,
    ],
    allowedActions: REVIEW_ACTIONS,
    delegableActions: [],
    createdBy,
  };
}

/** The `pr-review-fix` root definition for one blocked head: exactly the fingerprinted blockers, on the same draft. */
export function reviewFixRootDefinition(
  repository: string,
  head: Pick<PullRequestHead, "url" | "number" | "headSha" | "title">,
  review: PullRequestReview,
  createdBy: string,
): Omit<SeedWorkInput, "repository" | "priority"> {
  const short = head.headSha.slice(0, 7);
  const blockers = review.blockers ?? [];
  return {
    kind: REVIEW_FIX_KIND,
    objective: `Fix review blockers on ${repository}#${head.number} (head ${short}, round ${review.round}): ${blockers.map((blocker) => blocker.fingerprint).join(", ")}`,
    instructions: [
      `Pull request ${head.url} ("${head.title}") at head ${head.headSha} was blocked in review round ${review.round} of ${MAX_REVIEW_ROUNDS}${review.reviewItemId ? ` (review item ${review.reviewItemId})` : ""} for these blockers: ${describeBlockers(blockers)}.`,
      ...(review.originItemId ? [`The origin item is ${review.originItemId} (get_work shows its acceptance criteria).`] : []),
      "Address EXACTLY these blockers on the pull request's branch and push; keep the pull request a DRAFT, do not widen scope, do not mark it ready, and never merge, approve, or dismiss a review. If a blocker is wrong, say so in the evidence (and in the pull request description if useful) with the reason rather than silently skipping it, and still complete — the next review round judges.",
      "After your push the head changes and Snowcat schedules the next review round automatically. Run the repository's own checks locally on the new head before completing.",
      "Complete reporting the pull request as a pull-request artifact, with evidence naming each fingerprint as addressed (what changed) or disputed (why), the checks run, and the model you ran as result.model. Snowcat refuses a completion whose pull request is open and not a draft.",
    ].join(" "),
    acceptanceCriteria: [
      "Every blocker fingerprint is named in the evidence as addressed (with the change) or disputed (with the reason).",
      "The pull request remains a draft and its branch carries the new commits (Snowcat enforces the draft on completion).",
      "The repository's own checks pass locally on the new head, or the result names the failing check and why.",
      `The pull request ${head.url} is reported as a pull-request artifact.`,
    ],
    allowedActions: REVIEW_FIX_ACTIONS,
    delegableActions: [],
    createdBy,
  };
}

/** Kinds that act on pull requests after the gate released them (ADR-0061): never subject to the draft rule. */
const CURE_KINDS = new Set(["pr-cure", "pr-cure-change"]);

/**
 * The draft rule (ADR-0065): in a review-gated repository, a completion that
 * reports an open, non-draft pull request is refused so the item stays
 * claimed and the worker converts the pull request back (`gh pr ready --undo`).
 * Exempt: `pr-cure` and `pr-cure-change` items (cure acts only on ready pull
 * requests), a pull request the gate itself released — one with a completed
 * `pr-review` round that passed — and anything unverified (GitHub could not
 * answer; the refusal would be a guess). Merged and closed pull requests are
 * accepted.
 */
export function assertReviewGate(queue: QueueStore, item: WorkItem, artifacts: WorkArtifact[]): void {
  if (CURE_KINDS.has(item.kind)) return;
  if (!queue.reviewGateEnabled(item.repository)) return;
  for (const artifact of artifacts) {
    if (artifact.kind !== "pull-request" || artifact.verification?.status !== "verified") continue;
    if (artifact.verification.state !== "open" || artifact.verification.draft === true) continue;
    const released = queue
      .pullRequestReviewItems(item.repository, artifact.url)
      .some((round) => round.kind === REVIEW_KIND && round.status === "completed" && round.review?.decision === "pass");
    if (released) continue;
    throw new Error(
      `review gate: pull request ${artifact.url} is open and not a draft in ${item.repository}; convert it with \`gh pr ready --undo ${artifact.verification.number}\` and complete again, or block`,
    );
  }
}

/**
 * `complete_work` on a `pr-review` item: the verdict must be present and
 * consistent, and the pull request's head on GitHub must still be the one
 * the round was bound to (a moved head is a new round, so the worker blocks
 * instead). An unavailable GitHub refuses — the binding cannot be confirmed
 * without evidence. A `pr-review-fix` must report its pull request. Any other
 * kind supplying a verdict is refused. Throws with the reason; the item stays
 * claimed.
 */
export async function assertReviewCompletion(item: WorkItem, artifacts: WorkArtifact[], review: ReviewResult | undefined, options: ReviewOptions = {}): Promise<void> {
  if (item.kind === REVIEW_FIX_KIND) {
    const record = item.review;
    if (!record) throw new Error("pr-review-fix item has no review record");
    if (!artifacts.some((artifact) => artifact.kind === "pull-request" && artifact.url.toLowerCase() === record.pullRequestUrl.toLowerCase())) {
      throw new Error(`pr-review-fix completion must report ${record.pullRequestUrl} as a pull-request artifact`);
    }
    if (review !== undefined) throw new Error("review results are accepted only on pr-review items");
    return;
  }
  if (item.kind !== REVIEW_KIND) {
    if (review !== undefined) throw new Error("review results are accepted only on pr-review items");
    return;
  }
  const record = item.review;
  if (!record) throw new Error("pr-review item has no review record");
  if (!review) throw new Error("pr-review completion requires a review result (decision, blockers, advisories)");
  if (review.decision === "block" && review.blockers.length === 0) throw new Error("review decision block requires at least one blocker");
  if (review.decision === "pass" && review.blockers.length > 0) throw new Error("review decision pass must carry no blockers");
  const check = await readPullRequestHead(item.repository, record.pullRequestUrl, options);
  if (check.kind === "unavailable") throw new Error(`pr-review completion cannot be verified: ${check.reason}`);
  if (check.kind === "rejected") throw new Error(`pr-review completion refused: ${check.reason}`);
  const { head } = check;
  if (head.state === "open" && head.headSha !== record.headSha) {
    throw new Error(
      `pr-review completion refused: the pull request's head moved (reviewed ${record.headSha.slice(0, 7)}, now ${head.headSha.slice(0, 7)}); block this item instead`,
    );
  }
}
