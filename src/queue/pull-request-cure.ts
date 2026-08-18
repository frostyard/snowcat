import { createHash } from "node:crypto";

import { githubApiJson, type GitHubFetch } from "../repository/github-api.ts";
import type { QueueStore } from "./store.ts";
import type { AllowedAction, PullRequestCure, PullRequestDecay, SeedWorkInput, WorkArtifact, WorkItem } from "./types.ts";

/**
 * Pull-request cure (ADR-0061): the verification pass that already re-checks
 * reported pull requests also reads each open one's health — mergeability,
 * check runs, reviews, and the identity of its patch — and enqueues one
 * admitted `pr-cure` root per decayed head. A `pr-cure` completion is refused
 * when the patch identity changed, so "mechanical" is a fact Fluent computes,
 * not a claim the worker makes. Merge, approval, and review dismissal stay
 * human; foreign pull requests (ones no Fluent item reported) are out of scope
 * until a repository opts in.
 */

const GITHUB_TIMEOUT_MS = 30_000;
/** `/pulls/N/files` pages read before the patch identity is called unavailable (100 files each). */
const MAX_FILE_PAGES = 3;
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

export const CURE_KIND = "pr-cure";
export const CURE_CHANGE_KIND = "pr-cure-change";
export const CURE_ACTIONS: AllowedAction[] = ["read", "write", "run-tests", "open-pr", "create-followup"];
export const CURE_CHILD_CEILING: AllowedAction[] = ["read", "write", "run-tests", "open-pr"];

export interface PullRequestHealth {
  number: number;
  url: string;
  headSha: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  title: string;
  /** GitHub's `mergeable_state` (clean, dirty, behind, blocked, unstable, unknown, has_hooks, draft), when given. */
  mergeableState: string | undefined;
  /** Names of check runs on the head whose conclusion is a failure. */
  failingChecks: string[];
  /** A reviewer's latest review requests changes. */
  changesRequested: boolean;
  /** Patch identity, or `undefined` with the reason it could not be computed. */
  patchDigest: string | undefined;
  patchUnavailableReason?: string;
  decay: PullRequestDecay[];
}

export type PullRequestHealthCheck =
  | { kind: "health"; health: PullRequestHealth }
  | { kind: "unavailable"; reason: string }
  | { kind: "rejected"; reason: string };

export interface CureOptions {
  fetcher?: GitHubFetch;
  clock?: () => Date;
}

/**
 * Reads one pull request's health from GitHub: the pull request itself, the
 * check runs on its head, its reviews, and its files (for the patch identity).
 * A pull request that is not open, or is a draft, has no decay by definition.
 */
export async function inspectPullRequestHealth(repository: string, url: string, options: CureOptions = {}): Promise<PullRequestHealthCheck> {
  const fetcher = options.fetcher ?? fetch;
  const locator = parsePullRequestUrl(repository, url);
  if (!locator) return { kind: "rejected", reason: `${url} is not a ${repository} pull-request URL` };
  const base = `/repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.name)}`;
  const pull = await githubApiJson(`${base}/pulls/${locator.number}`, AbortSignal.timeout(GITHUB_TIMEOUT_MS), fetcher);
  if (pull.kind === "unavailable") return { kind: "unavailable", reason: "GitHub API unavailable" };
  if (pull.status === 404 || pull.status === 410) {
    if (!process.env.FLUENT_GITHUB_TOKEN) return { kind: "unavailable", reason: `GitHub returned ${pull.status} without FLUENT_GITHUB_TOKEN` };
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
  const state: PullRequestHealth["state"] = record.merged === true ? "merged" : record.state === "closed" ? "closed" : record.state === "open" ? "open" : "closed";
  const draft = record.draft === true;
  const title = typeof record.title === "string" ? record.title : "";
  const mergeableState = typeof record.mergeable_state === "string" ? record.mergeable_state : undefined;

  const health: PullRequestHealth = {
    number: locator.number,
    url,
    headSha: headSha.toLowerCase(),
    state,
    draft,
    title,
    mergeableState,
    failingChecks: [],
    changesRequested: false,
    patchDigest: undefined,
    decay: [],
  };
  if (state !== "open") return { kind: "health", health };

  const checks = await githubApiJson(`${base}/commits/${headSha}/check-runs?per_page=100`, AbortSignal.timeout(GITHUB_TIMEOUT_MS), fetcher);
  if (checks.kind === "unavailable" || checks.status !== 200) return { kind: "unavailable", reason: "GitHub check runs unavailable" };
  const runs = asObject(checks.value)?.check_runs;
  if (Array.isArray(runs)) {
    for (const run of runs) {
      const entry = asObject(run);
      if (!entry) continue;
      if (entry.status === "completed" && typeof entry.conclusion === "string" && FAILING_CONCLUSIONS.has(entry.conclusion)) {
        health.failingChecks.push(typeof entry.name === "string" ? entry.name : "unnamed check");
      }
    }
    health.failingChecks.sort();
  }

  const reviews = await githubApiJson(`${base}/pulls/${locator.number}/reviews?per_page=100`, AbortSignal.timeout(GITHUB_TIMEOUT_MS), fetcher);
  if (reviews.kind === "unavailable" || reviews.status !== 200) return { kind: "unavailable", reason: "GitHub reviews unavailable" };
  if (Array.isArray(reviews.value)) {
    const latest = new Map<string, string>();
    for (const review of reviews.value) {
      const entry = asObject(review);
      const login = asObject(entry?.user)?.login;
      if (typeof login !== "string" || typeof entry?.state !== "string") continue;
      if (entry.state === "COMMENTED") continue;
      latest.set(login, entry.state);
    }
    health.changesRequested = [...latest.values()].includes("CHANGES_REQUESTED");
  }

  const patch = await readPatchDigest(base, locator.number, fetcher);
  if (patch.kind === "unavailable") return { kind: "unavailable", reason: patch.reason };
  if (patch.kind === "digest") health.patchDigest = patch.digest;
  else health.patchUnavailableReason = patch.reason;

  if (!draft) {
    if (mergeableState === "behind") health.decay.push("behind");
    if (mergeableState === "dirty") health.decay.push("dirty");
    if (health.failingChecks.length > 0) health.decay.push("failing-checks");
    if (health.changesRequested) health.decay.push("changes-requested");
  }
  return { kind: "health", health };
}

/**
 * The identity of a pull request's patch: SHA-256 over every changed file's
 * path, status, rename source, and its added and removed lines only — hunk
 * headers and context lines are excluded, so a rebase over unrelated base
 * changes keeps the digest while any edit to what the pull request adds or
 * removes changes it. Files GitHub serves without a text patch (binary) are
 * identified by their blob SHA. Too many files, or a text file whose patch
 * GitHub truncated, leave the identity uncomputable — reported, not guessed.
 */
async function readPatchDigest(
  base: string,
  number: number,
  fetcher: GitHubFetch,
): Promise<{ kind: "digest"; digest: string } | { kind: "uncomputable"; reason: string } | { kind: "unavailable"; reason: string }> {
  const files: Array<{ filename: string; status: string; previous?: string; changes: string[]; sha?: string }> = [];
  for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
    const response = await githubApiJson(`${base}/pulls/${number}/files?per_page=100&page=${page}`, AbortSignal.timeout(GITHUB_TIMEOUT_MS), fetcher);
    if (response.kind === "unavailable" || response.status !== 200) return { kind: "unavailable", reason: "GitHub pull-request files unavailable" };
    if (!Array.isArray(response.value)) return { kind: "unavailable", reason: "GitHub pull-request files response was not a list" };
    for (const raw of response.value) {
      const file = asObject(raw);
      if (!file || typeof file.filename !== "string" || typeof file.status !== "string") {
        return { kind: "unavailable", reason: "GitHub pull-request file entry was malformed" };
      }
      const additions = Number(file.additions ?? 0);
      const deletions = Number(file.deletions ?? 0);
      if (typeof file.patch === "string") {
        const changes = file.patch.split("\n").filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")));
        files.push({
          filename: file.filename,
          status: file.status,
          ...(typeof file.previous_filename === "string" ? { previous: file.previous_filename } : {}),
          changes,
        });
      } else if (additions === 0 && deletions === 0 && typeof file.sha === "string") {
        files.push({
          filename: file.filename,
          status: file.status,
          ...(typeof file.previous_filename === "string" ? { previous: file.previous_filename } : {}),
          changes: [],
          sha: file.sha,
        });
      } else {
        return { kind: "uncomputable", reason: `patch for ${file.filename} is not available from GitHub (too large)` };
      }
    }
    if (response.value.length < 100) {
      files.sort((left, right) => (left.filename < right.filename ? -1 : left.filename > right.filename ? 1 : 0));
      const material = JSON.stringify(files);
      return { kind: "digest", digest: `sha256:${createHash("sha256").update(material).digest("hex")}` };
    }
  }
  return { kind: "uncomputable", reason: `more than ${MAX_FILE_PAGES * 100} changed files` };
}

export interface CureSweepResult {
  /** Open pull requests inspected (deduplicated by URL). */
  inspected: number;
  enqueued: Array<{ id: string; url: string; headSha: string; decay: PullRequestDecay[] }>;
  healthy: string[];
  /** Decayed heads already known (any status), drafts, closed, or uncomputable patches: nothing enqueued. */
  skipped: Array<{ url: string; reason: string }>;
  unavailable: Array<{ url: string; reason: string }>;
}

/**
 * The cure sweep: for every open pull request that a completed item reported
 * (verified, state `open`), read its health and enqueue one admitted `pr-cure`
 * root per decayed head that Fluent has not seen. Runs after
 * `refreshArtifactVerifications` on the same timer.
 */
export async function curePullRequests(
  queue: QueueStore,
  options: CureOptions & { repository?: string; limit?: number; actor?: string } = {},
): Promise<CureSweepResult> {
  const actor = options.actor ?? "operator:cli";
  const items = queue.list({ status: "completed", repository: options.repository, limit: options.limit ?? 100 });
  const candidates = new Map<string, { repository: string; priority: number; originItemId: string }>();
  for (const item of items) {
    for (const artifact of item.result?.artifacts ?? []) {
      if (artifact.kind !== "pull-request" || artifact.verification?.status !== "verified" || artifact.verification.state !== "open") continue;
      const existing = candidates.get(artifact.url);
      if (!existing) candidates.set(artifact.url, { repository: item.repository, priority: item.priority, originItemId: item.id });
      else if (item.priority > existing.priority) candidates.set(artifact.url, { repository: item.repository, priority: item.priority, originItemId: item.id });
    }
  }
  const result: CureSweepResult = { inspected: 0, enqueued: [], healthy: [], skipped: [], unavailable: [] };
  for (const [url, origin] of candidates) {
    result.inspected += 1;
    const check = await inspectPullRequestHealth(origin.repository, url, options);
    if (check.kind === "unavailable") {
      result.unavailable.push({ url, reason: check.reason });
      continue;
    }
    if (check.kind === "rejected") {
      result.skipped.push({ url, reason: check.reason });
      continue;
    }
    const { health } = check;
    if (health.state !== "open") {
      result.skipped.push({ url, reason: `pull request is ${health.state}` });
      continue;
    }
    if (health.draft) {
      result.skipped.push({ url, reason: "draft pull requests are not cured" });
      continue;
    }
    if (health.decay.length === 0) {
      result.healthy.push(url);
      continue;
    }
    if (!health.patchDigest) {
      result.skipped.push({ url, reason: `patch identity uncomputable: ${health.patchUnavailableReason ?? "unknown"}` });
      continue;
    }
    const cure: PullRequestCure = {
      pullRequestUrl: url,
      headSha: health.headSha,
      patchDigest: health.patchDigest,
      decay: health.decay,
      originItemId: origin.originItemId,
    };
    const created = queue.enqueueCureRoot(origin.repository, {
      ...cureRootDefinition(origin.repository, health, actor),
      priority: origin.priority,
      sourceRef: `${url}@${health.headSha}`,
      cure,
    });
    if (!created) {
      result.skipped.push({ url, reason: `head ${health.headSha.slice(0, 7)} already has a cure item` });
      continue;
    }
    result.enqueued.push({ id: created.id, url, headSha: health.headSha, decay: health.decay });
  }
  return result;
}

/** The `pr-cure` root definition for one decayed head: mechanical cure only, substantive change proposed. */
export function cureRootDefinition(
  repository: string,
  health: Pick<PullRequestHealth, "url" | "number" | "headSha" | "decay" | "failingChecks" | "mergeableState" | "title">,
  createdBy: string,
): Omit<SeedWorkInput, "repository" | "priority"> {
  const short = health.headSha.slice(0, 7);
  const reasons = health.decay.map((reason) => describeDecay(reason, health)).join("; ");
  return {
    kind: CURE_KIND,
    objective: `Cure ${repository}#${health.number} (head ${short}): ${health.decay.join(", ")}`,
    instructions: [
      `Pull request ${health.url} at head ${health.headSha} has decayed: ${reasons}.`,
      "Perform only a MECHANICAL cure — one that leaves the pull request's patch identical: rebase or merge the base branch when that resolves cleanly, retitle to satisfy the repository's title lint, re-run or re-trigger checks, reply to review comments, fix labels or the body.",
      "Fluent recomputes the digest of the pull request's patch (its added and removed lines per file) when you complete this item and REFUSES the completion if it changed, so do not edit code, resolve conflicts by hand, change tests, or squash in fixes.",
      `If curing this head requires changing the patch (a conflict that needs edits, a failing check that needs a code or test change, a review that asks for a change), do NOT push: create exactly one follow-up of kind ${CURE_CHANGE_KIND} that names the exact change and how it will be verified, or block this item if the change is the maintainer's to make.`,
      "Never merge, approve, or dismiss a review. Read the pull request and its checks on GitHub before acting; if the head has moved on since this item was created, block with that reason.",
      "Complete with the pull request reported as a pull-request artifact and evidence: the checks you observed on the new head, the mergeable state, and what you changed (metadata only).",
    ].join(" "),
    acceptanceCriteria: [
      `The pull request ${health.url} is reported as a pull-request artifact and its patch identity is unchanged (Fluent enforces this on completion).`,
      "The pull request's mergeable state is clean, or the result names exactly what still blocks it and why that is not a mechanical cure.",
      "The checks on the pull request's new head are green, or the result names the failing check and the follow-up or block that carries the fix.",
      "No merge, approval, or review dismissal was performed.",
    ],
    allowedActions: CURE_ACTIONS,
    delegableActions: CURE_CHILD_CEILING,
    createdBy,
  };
}

function describeDecay(reason: PullRequestDecay, health: Pick<PullRequestHealth, "failingChecks" | "mergeableState">): string {
  switch (reason) {
    case "behind":
      return "the head is behind its base branch (mergeable_state behind)";
    case "dirty":
      return "the head conflicts with its base branch (mergeable_state dirty)";
    case "failing-checks":
      return `failing checks: ${health.failingChecks.join(", ")}`;
    case "changes-requested":
      return "a reviewer's latest review requests changes";
  }
}

/**
 * `complete_work` on a `pr-cure` item: the reported artifacts must name the
 * cured pull request, and its patch identity on GitHub must equal the one
 * recorded at creation. Throws with a reason (the completion is refused and
 * the item stays claimed) on any mismatch; an unavailable GitHub also
 * refuses, because "mechanical" cannot be recorded without evidence.
 */
export async function assertCureCompletion(item: WorkItem, artifacts: WorkArtifact[], options: CureOptions = {}): Promise<void> {
  if (item.kind !== CURE_KIND) return;
  const cure = item.cure;
  if (!cure) throw new Error("pr-cure item has no cure record");
  const reported = artifacts.filter((artifact) => artifact.kind === "pull-request");
  if (!reported.some((artifact) => artifact.url.toLowerCase() === cure.pullRequestUrl.toLowerCase())) {
    throw new Error(`pr-cure completion must report ${cure.pullRequestUrl} as a pull-request artifact`);
  }
  const check = await inspectPullRequestHealth(item.repository, cure.pullRequestUrl, options);
  if (check.kind === "unavailable") throw new Error(`pr-cure completion cannot be verified: ${check.reason}`);
  if (check.kind === "rejected") throw new Error(`pr-cure completion refused: ${check.reason}`);
  const { health } = check;
  if (health.state === "open" && !health.patchDigest) {
    throw new Error(`pr-cure completion refused: patch identity uncomputable (${health.patchUnavailableReason ?? "unknown"})`);
  }
  if (health.state === "open" && health.patchDigest !== cure.patchDigest) {
    throw new Error(
      `pr-cure completion refused: the pull request's patch changed (recorded ${cure.patchDigest.slice(0, 19)}, now ${health.patchDigest!.slice(0, 19)}); a substantive change must be a ${CURE_CHANGE_KIND} proposal`,
    );
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parsePullRequestUrl(repository: string, url: string): { owner: string; name: string; number: number } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const [owner, name] = repository.split("/") as [string, string];
  const segments = parsed.pathname.split("/");
  if (
    parsed.hostname.toLowerCase() !== "github.com" ||
    segments.length !== 5 ||
    (segments[1] ?? "").toLowerCase() !== owner.toLowerCase() ||
    (segments[2] ?? "").toLowerCase() !== name.toLowerCase() ||
    segments[3] !== "pull" ||
    !/^[1-9][0-9]*$/.test(segments[4] ?? "")
  ) {
    return undefined;
  }
  return { owner, name, number: Number(segments[4]) };
}
