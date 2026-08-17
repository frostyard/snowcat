import { githubApiJson, type GitHubFetch } from "../repository/github-api.ts";
import type { QueueStore } from "./store.ts";
import type { ArtifactVerification, WorkArtifact, WorkItem } from "./types.ts";

const GITHUB_TIMEOUT_MS = 30_000;
const DEFAULT_REFRESH_LIMIT = 100;

/**
 * Outcome of checking one reported artifact against GitHub.
 *
 * - `verified`: the artifact exists in the item's repository; its observed
 *   state is recorded beside it.
 * - `unverified`: GitHub could not answer (outage, malformed body, or a
 *   response Fluent cannot interpret without more authority). The completion
 *   is accepted with the reason recorded; `verify-artifacts` retries later.
 * - `rejected`: GitHub answered and the artifact is not what was reported —
 *   it does not exist, lives in another repository, or is the wrong kind.
 *   The completion is refused so the worker can correct the report.
 */
export type ArtifactCheck =
  | { kind: "verified"; verification: Extract<ArtifactVerification, { status: "verified" }> }
  | { kind: "unverified"; verification: Extract<ArtifactVerification, { status: "unverified" }> }
  | { kind: "rejected"; reason: string };

export interface ArtifactVerifierOptions {
  fetcher?: GitHubFetch;
  clock?: () => Date;
}

/** Only issues and pull requests are verifiable through the API today. */
export function isVerifiableArtifact(artifact: WorkArtifact): boolean {
  return artifact.kind === "issue" || artifact.kind === "pull-request";
}

export async function verifyGitHubArtifact(
  repository: string,
  artifact: WorkArtifact,
  options: ArtifactVerifierOptions = {},
): Promise<ArtifactCheck> {
  const fetcher = options.fetcher ?? fetch;
  const now = () => (options.clock ?? (() => new Date()))().toISOString();
  const locator = parseArtifactUrl(repository, artifact);
  if (!locator) return { kind: "rejected", reason: `artifact ${artifact.kind} URL is not a ${repository} ${artifact.kind} URL` };
  const path =
    artifact.kind === "pull-request"
      ? `/repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.name)}/pulls/${locator.number}`
      : `/repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.name)}/issues/${locator.number}`;
  const response = await githubApiJson(path, AbortSignal.timeout(GITHUB_TIMEOUT_MS), fetcher);
  if (response.kind === "unavailable") {
    return unverified(now(), "GitHub API unavailable");
  }
  if (response.status === 404 || response.status === 410) {
    // Unauthenticated, GitHub answers 404 for private repositories exactly as
    // for missing ones, so "not found" is only evidence of absence when Fluent
    // asked with a credential.
    if (!process.env.FLUENT_GITHUB_TOKEN) {
      return unverified(
        now(),
        `GitHub returned ${response.status} without FLUENT_GITHUB_TOKEN; private repositories cannot be verified unauthenticated`,
      );
    }
    return { kind: "rejected", reason: `${artifact.kind} ${artifact.url} does not exist on GitHub` };
  }
  if (response.status !== 200) {
    return unverified(now(), `GitHub API returned HTTP ${response.status}`);
  }
  const value = response.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return unverified(now(), "GitHub response was not an object");
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.number) || Number(record.number) !== locator.number) {
    return { kind: "rejected", reason: `${artifact.kind} number does not match ${artifact.url}` };
  }
  if (typeof record.html_url !== "string" || record.html_url.toLowerCase() !== artifact.url.toLowerCase()) {
    return { kind: "rejected", reason: `${artifact.kind} ${artifact.url} resolves to a different location` };
  }
  const state = record.state;
  if (state !== "open" && state !== "closed") return unverified(now(), "GitHub response has no recognizable state");

  if (artifact.kind === "pull-request") {
    const base = record.base;
    const baseRepo = base && typeof base === "object" ? (base as Record<string, unknown>).repo : undefined;
    const fullName = baseRepo && typeof baseRepo === "object" ? (baseRepo as Record<string, unknown>).full_name : undefined;
    if (typeof fullName !== "string") return unverified(now(), "GitHub response has no base repository");
    if (fullName.toLowerCase() !== repository.toLowerCase()) {
      return { kind: "rejected", reason: `pull request ${artifact.url} targets ${fullName}, not ${repository}` };
    }
    const head = record.head;
    const headSha = head && typeof head === "object" ? (head as Record<string, unknown>).sha : undefined;
    const merged = record.merged === true;
    return {
      kind: "verified",
      verification: {
        status: "verified",
        verifiedAt: now(),
        number: locator.number,
        state: merged ? "merged" : state,
        ...(typeof headSha === "string" && /^[0-9a-f]{7,64}$/i.test(headSha) ? { headSha } : {}),
        ...(typeof record.merged_at === "string" ? { mergedAt: record.merged_at } : {}),
        ...(typeof record.closed_at === "string" ? { closedAt: record.closed_at } : {}),
      },
    };
  }

  if (record.pull_request !== undefined) {
    return { kind: "rejected", reason: `${artifact.url} is a pull request; report it as a pull-request artifact` };
  }
  const repositoryUrl = record.repository_url;
  if (typeof repositoryUrl !== "string") return unverified(now(), "GitHub response has no repository");
  if (!repositoryUrl.toLowerCase().endsWith(`/repos/${repository.toLowerCase()}`)) {
    return { kind: "rejected", reason: `issue ${artifact.url} belongs to another repository` };
  }
  return {
    kind: "verified",
    verification: {
      status: "verified",
      verifiedAt: now(),
      number: locator.number,
      state,
      ...(typeof record.closed_at === "string" ? { closedAt: record.closed_at } : {}),
    },
  };
}

/**
 * Verifies every issue and pull-request artifact for a completion. Throws on
 * the first rejected artifact so the whole completion is refused; other kinds
 * pass through unchanged.
 */
export async function verifyCompletionArtifacts(
  repository: string,
  artifacts: WorkArtifact[],
  options: ArtifactVerifierOptions = {},
): Promise<WorkArtifact[]> {
  const verified: WorkArtifact[] = [];
  for (const artifact of artifacts) {
    if (!isVerifiableArtifact(artifact)) {
      verified.push(artifact);
      continue;
    }
    const check = await verifyGitHubArtifact(repository, artifact, options);
    if (check.kind === "rejected") throw new Error(`artifact rejected: ${check.reason}`);
    verified.push({ ...artifact, verification: check.verification });
  }
  return verified;
}

export interface RefreshArtifactsResult {
  checked: number;
  updated: Array<{ id: string; url: string; status: ArtifactVerification["status"]; state?: string }>;
  unavailable: Array<{ id: string; url: string; reason: string }>;
  rejected: Array<{ id: string; url: string; reason: string }>;
}

/**
 * Re-checks completed items whose issue or pull-request artifacts are not yet
 * terminal (unverified, or verified but still open) and records what GitHub
 * says now. A rejected artifact is recorded as unverified with the reason,
 * never deleted: the worker's report stays provenance. Unavailable answers
 * leave the previous verification in place.
 */
export async function refreshArtifactVerifications(
  queue: QueueStore,
  options: ArtifactVerifierOptions & { repository?: string; limit?: number; actor?: string } = {},
): Promise<RefreshArtifactsResult> {
  const actor = options.actor ?? "operator:cli";
  const limit = options.limit ?? DEFAULT_REFRESH_LIMIT;
  const items = queue.list({ status: "completed", repository: options.repository, limit });
  const result: RefreshArtifactsResult = { checked: 0, updated: [], unavailable: [], rejected: [] };
  for (const item of items) {
    for (const artifact of pendingArtifacts(item)) {
      result.checked += 1;
      const check = await verifyGitHubArtifact(item.repository, artifact, options);
      if (check.kind === "unverified") {
        result.unavailable.push({ id: item.id, url: artifact.url, reason: check.verification.reason });
        continue;
      }
      if (check.kind === "rejected") {
        const attemptedAt = (options.clock ?? (() => new Date()))().toISOString();
        queue.recordArtifactVerification(
          item.id,
          artifact.url,
          { status: "unverified", attemptedAt, reason: `rejected: ${check.reason}` },
          actor,
        );
        result.rejected.push({ id: item.id, url: artifact.url, reason: check.reason });
        continue;
      }
      const previous = artifact.verification;
      const unchanged =
        previous?.status === "verified" &&
        previous.state === check.verification.state &&
        previous.headSha === check.verification.headSha;
      if (unchanged) continue;
      queue.recordArtifactVerification(item.id, artifact.url, check.verification, actor);
      result.updated.push({ id: item.id, url: artifact.url, status: "verified", state: check.verification.state });
    }
  }
  return result;
}

function pendingArtifacts(item: WorkItem): WorkArtifact[] {
  return (item.result?.artifacts ?? []).filter((artifact) => {
    if (!isVerifiableArtifact(artifact)) return false;
    const verification = artifact.verification;
    if (!verification || verification.status === "unverified") return true;
    return verification.state === "open";
  });
}

function unverified(attemptedAt: string, reason: string): ArtifactCheck {
  return { kind: "unverified", verification: { status: "unverified", attemptedAt, reason } };
}

function parseArtifactUrl(
  repository: string,
  artifact: WorkArtifact,
): { owner: string; name: string; number: number } | undefined {
  let url: URL;
  try {
    url = new URL(artifact.url);
  } catch {
    return undefined;
  }
  const [owner, name] = repository.split("/") as [string, string];
  const segments = url.pathname.split("/");
  const expectedPath = artifact.kind === "issue" ? "issues" : "pull";
  if (
    url.hostname.toLowerCase() !== "github.com" ||
    segments.length !== 5 ||
    (segments[1] ?? "").toLowerCase() !== owner.toLowerCase() ||
    (segments[2] ?? "").toLowerCase() !== name.toLowerCase() ||
    segments[3] !== expectedPath ||
    !/^[1-9][0-9]*$/.test(segments[4] ?? "")
  ) {
    return undefined;
  }
  return { owner, name, number: Number(segments[4]) };
}
