import { GITHUB_API_ORIGIN } from "../github/api-contract.ts";
import { githubApiJson, type GitHubFetch } from "../repository/github-api.ts";
import type { MutationPrecondition, QueueStore } from "./store.ts";
import { RELEASE_TAG_PATTERN, type ArtifactVerification, type WorkArtifact, type WorkItem } from "./types.ts";

const GITHUB_TIMEOUT_MS = 30_000;
const DEFAULT_REFRESH_LIMIT = 100;
const MAX_PULL_REQUEST_TEMPLATE_BYTES = 128 * 1024;
const PULL_REQUEST_TEMPLATE_PATH = "/contents/.github/pull_request_template.md";
/** One bounded page of releases is read only to observe a reported draft (ADR-0066). */
const RELEASE_PAGE_SIZE = 100;

/**
 * Outcome of checking one reported artifact against GitHub.
 *
 * - `verified`: the artifact exists in the item's repository; its observed
 *   state is recorded beside it.
 * - `unverified`: GitHub could not answer (outage, malformed body, or a
 *   response Snowcat cannot interpret without more authority). The completion
 *   is accepted with the reason recorded; `verify-artifacts` retries later.
 * - `rejected`: GitHub answered and the artifact is not what was reported —
 *   it does not exist, lives in another repository, or is the wrong kind.
 *   The completion is refused so the worker can correct the report.
 */
export type ArtifactCheck =
  | { kind: "verified"; verification: Extract<ArtifactVerification, { status: "verified" }> }
  | { kind: "unverified"; verification: Extract<ArtifactVerification, { status: "unverified" }> }
  | {
      kind: "handoff-rejected";
      verification: Extract<ArtifactVerification, { status: "verified" }>;
      reason: string;
    }
  | { kind: "rejected"; reason: string };

export interface ArtifactVerifierOptions {
  fetcher?: GitHubFetch;
  clock?: () => Date;
  /** Per-operation cache so several open pull requests in one repository share one template read. */
  templateCache?: Map<string, Promise<PullRequestTemplateRead>>;
  /**
   * Present only when validating an open pull request as a completion
   * handoff. The strings remain attempt-report provenance; Snowcat checks
   * that evidence exists but never treats its content as attested truth.
   */
  completionEvidence?: readonly string[];
  /**
   * Ask GitHub about an artifact URL whose slug is not the item's repository —
   * a URL recorded before `rename-repository` (spec rule 47) — and accept the
   * answer when GitHub itself says it is this repository. Set by the
   * `verify-artifacts` refresh only (spec rule 34): `complete_work` and
   * `attach-artifact` keep rule 15's scope requirement and reject a foreign
   * slug before GitHub is asked anything.
   */
  acceptFormerName?: boolean;
}

/** Only issues, pull requests, and releases are verifiable through the API today. */
export function isVerifiableArtifact(artifact: WorkArtifact): boolean {
  return artifact.kind === "issue" || artifact.kind === "pull-request" || artifact.kind === "release";
}

export async function verifyGitHubArtifact(
  repository: string,
  artifact: WorkArtifact,
  options: ArtifactVerifierOptions = {},
): Promise<ArtifactCheck> {
  const fetcher = options.fetcher ?? fetch;
  const now = () => (options.clock ?? (() => new Date()))().toISOString();
  const locator = parseArtifactUrl(artifact);
  if (!locator) return { kind: "rejected", reason: `artifact ${artifact.kind} URL is not a ${repository} ${artifact.kind} URL` };
  const [owner, name] = repository.split("/") as [string, string];
  if (locator.kind === "release") {
    const underFormerSlug =
      locator.owner.toLowerCase() !== owner.toLowerCase() || locator.name.toLowerCase() !== name.toLowerCase();
    if (underFormerSlug && options.acceptFormerName !== true) {
      return { kind: "rejected", reason: `artifact release URL is not a ${repository} release URL` };
    }
    return verifyRelease(repository, artifact, locator, fetcher, now);
  }
  // An artifact recorded before `rename-repository` (spec rule 47) keeps the
  // former slug, which no longer matches the item's repository. Where the
  // caller allows it — the `verify-artifacts` refresh, spec rule 34 — ask
  // GitHub with the URL's own slug, because the API follows repository
  // renames, and accept the answer below only when GitHub itself says the URL
  // is this repository at the same number. Everywhere else a foreign slug is
  // still rejected here, before any request, so completion-time scope
  // validation (rule 15) is unchanged.
  const underFormerName =
    locator.owner.toLowerCase() !== owner.toLowerCase() || locator.name.toLowerCase() !== name.toLowerCase();
  if (underFormerName && options.acceptFormerName !== true) {
    return { kind: "rejected", reason: `artifact ${artifact.kind} URL is not a ${repository} ${artifact.kind} URL` };
  }
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
    // for missing ones, so "not found" is only evidence of absence when Snowcat
    // asked with a credential.
    if (!process.env.SNOWCAT_GITHUB_TOKEN) {
      return unverified(
        now(),
        `GitHub returned ${response.status} without SNOWCAT_GITHUB_TOKEN; private repositories cannot be verified unauthenticated`,
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
  // Under a former name GitHub answers with the canonical URL — this
  // repository's current slug at the same number and kind — so that, and not
  // the recorded URL, is what the answer must match. A URL that resolves to
  // another number or another repository still fails here.
  const expectedUrl = underFormerName
    ? `https://github.com/${repository}/${artifact.kind === "issue" ? "issues" : "pull"}/${locator.number}`
    : artifact.url;
  if (typeof record.html_url !== "string" || record.html_url.toLowerCase() !== expectedUrl.toLowerCase()) {
    return { kind: "rejected", reason: `${artifact.kind} ${artifact.url} resolves to a different location` };
  }
  const state = record.state;
  if (state !== "open" && state !== "closed") return unverified(now(), "GitHub response has no recognizable state");

  if (artifact.kind === "pull-request") {
    const base = record.base;
    const baseRepo = base && typeof base === "object" ? (base as Record<string, unknown>).repo : undefined;
    const fullName = baseRepo && typeof baseRepo === "object" ? (baseRepo as Record<string, unknown>).full_name : undefined;
    const repositoryIsPublic =
      baseRepo !== null &&
      typeof baseRepo === "object" &&
      (baseRepo as Record<string, unknown>).private === false;
    if (typeof fullName !== "string") return unverified(now(), "GitHub response has no base repository");
    if (fullName.toLowerCase() !== repository.toLowerCase()) {
      return { kind: "rejected", reason: `pull request ${artifact.url} targets ${fullName}, not ${repository}` };
    }
    const head = record.head;
    const headSha = head && typeof head === "object" ? (head as Record<string, unknown>).sha : undefined;
    const merged = record.merged === true;
    const verifiedAt = now();
    let handoff: Extract<ArtifactVerification, { status: "verified" }>["handoff"];
    if (!merged && state === "open" && options.completionEvidence !== undefined) {
      const handoffCheck = await validatePullRequestHandoff(
        repository,
        artifact.url,
        record,
        options.completionEvidence,
        fetcher,
        repositoryIsPublic,
        options.templateCache,
      );
      if (handoffCheck.kind === "rejected") {
        return {
          kind: "handoff-rejected",
          reason: handoffCheck.reason,
          verification: pullRequestVerification(record, locator.number, state, merged, headSha, verifiedAt, {
            status: "rejected",
            checkedAt: verifiedAt,
            reason: handoffCheck.reason,
          }),
        };
      }
      if (handoffCheck.kind === "unverified") {
        handoff = { status: "unverified", attemptedAt: verifiedAt, reason: handoffCheck.reason };
      }
    }
    return {
      kind: "verified",
      verification: pullRequestVerification(record, locator.number, state, merged, headSha, verifiedAt, handoff),
    };
  }

  if (record.pull_request !== undefined) {
    return { kind: "rejected", reason: `${artifact.url} is a pull request; report it as a pull-request artifact` };
  }

  function pullRequestVerification(
    record: Record<string, unknown>,
    number: number,
    state: "open" | "closed",
    merged: boolean,
    headSha: unknown,
    verifiedAt: string,
    handoff?: Extract<ArtifactVerification, { status: "verified" }>["handoff"],
  ): Extract<ArtifactVerification, { status: "verified" }> {
    return {
      status: "verified",
      verifiedAt,
      number,
      state: merged ? "merged" : state,
      ...(typeof headSha === "string" && /^[0-9a-f]{7,64}$/i.test(headSha) ? { headSha } : {}),
      ...(typeof record.merged_at === "string" ? { mergedAt: record.merged_at } : {}),
      ...(typeof record.closed_at === "string" ? { closedAt: record.closed_at } : {}),
      ...(record.draft === true && !merged && state === "open" ? { draft: true } : {}),
      ...(handoff === undefined ? {} : { handoff }),
    };
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

type PullRequestHandoffCheck = { kind: "valid" } | { kind: "unverified"; reason: string } | { kind: "rejected"; reason: string };

/**
 * Validate only the structural completion handoff. Body and template bytes
 * are ephemeral acquisition data and are never copied into queue state.
 */
async function validatePullRequestHandoff(
  repository: string,
  url: string,
  record: Record<string, unknown>,
  evidence: readonly string[],
  fetcher: GitHubFetch,
  repositoryIsPublic: boolean,
  templateCache?: Map<string, Promise<PullRequestTemplateRead>>,
): Promise<PullRequestHandoffCheck> {
  if (evidence.length === 0) {
    return { kind: "rejected", reason: `pull request ${url} completion reports no evidence` };
  }
  if (typeof record.body !== "string" || record.body.trim().length === 0) {
    return { kind: "rejected", reason: `pull request ${url} has an empty body` };
  }
  const template = await readPullRequestTemplateCached(repository, fetcher, repositoryIsPublic, templateCache);
  if (template.kind === "unverified") return template;
  const expected = markdownSections(template.body);
  const required = template.exists ? expected : fallbackPullRequestSections();
  const actual = markdownSections(record.body);
  const missing = [...required.keys()].filter((heading) => !actual.has(heading));
  if (missing.length > 0) {
    return {
      kind: "rejected",
      reason: `pull request ${url} body is missing ${missing.length} required template section${missing.length === 1 ? "" : "s"}`,
    };
  }

  const summary = findSection(required, ["summary"]);
  const verification = findSection(required, ["checks", "verification"]);
  const risk = findSection(required, ["risk classification", "risk tier", "risk"], sectionHasCheckbox);
  for (const [label, heading] of [
    ["summary", summary],
    ["verification", verification],
  ] as const) {
    if (heading !== undefined && !hasVisibleSectionContent(actual.get(heading) ?? "")) {
      return { kind: "rejected", reason: `pull request ${url} ${label} section has no completion content` };
    }
  }
  if (risk !== undefined && sectionHasCheckbox(required.get(risk) ?? "")) {
    const checked = checkedTemplateCheckboxCount(required.get(risk) ?? "", actual.get(risk) ?? "");
    if (checked !== 1) {
      return { kind: "rejected", reason: `pull request ${url} risk section must select exactly one tier (found ${checked})` };
    }
  } else if (risk !== undefined && !hasVisibleSectionContent(actual.get(risk) ?? "")) {
    return { kind: "rejected", reason: `pull request ${url} risk section has no completion content` };
  }
  return { kind: "valid" };
}

type PullRequestTemplateRead =
  | { kind: "available"; body: string; exists: boolean }
  | { kind: "unverified"; reason: string };

async function readPullRequestTemplateCached(
  repository: string,
  fetcher: GitHubFetch,
  repositoryIsPublic: boolean,
  cache?: Map<string, Promise<PullRequestTemplateRead>>,
): Promise<PullRequestTemplateRead> {
  if (!cache) return readPullRequestTemplate(repository, fetcher, repositoryIsPublic);
  const cacheKey = `${repository.toLowerCase()}\0${repositoryIsPublic ? "public" : "not-public"}`;
  const existing = cache.get(cacheKey);
  if (existing) return existing;
  const read = readPullRequestTemplate(repository, fetcher, repositoryIsPublic);
  cache.set(cacheKey, read);
  return read;
}

async function readPullRequestTemplate(
  repository: string,
  fetcher: GitHubFetch,
  repositoryIsPublic: boolean,
): Promise<PullRequestTemplateRead> {
  const response = await githubApiJson(
    `/repos/${repository.split("/").map(encodeURIComponent).join("/")}${PULL_REQUEST_TEMPLATE_PATH}`,
    AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    fetcher,
  );
  if (response.kind === "unavailable") {
    return { kind: "unverified", reason: "GitHub pull-request template API unavailable" };
  }
  if (response.status === 404 || response.status === 410) {
    if (!process.env.SNOWCAT_GITHUB_TOKEN) {
      return {
        kind: "unverified",
        reason: `GitHub returned ${response.status} for the pull-request template without SNOWCAT_GITHUB_TOKEN`,
      };
    }
    if (!repositoryIsPublic) {
      return {
        kind: "unverified",
        reason: `GitHub returned ${response.status} for the pull-request template without proving the repository is public`,
      };
    }
    return { kind: "available", body: fallbackPullRequestTemplate(), exists: false };
  }
  if (response.status !== 200) {
    return { kind: "unverified", reason: `GitHub pull-request template API returned HTTP ${response.status}` };
  }
  if (!response.value || typeof response.value !== "object" || Array.isArray(response.value)) {
    return { kind: "unverified", reason: "GitHub pull-request template response was not an object" };
  }
  const record = response.value as Record<string, unknown>;
  if (record.encoding !== "base64" || typeof record.content !== "string") {
    return { kind: "unverified", reason: "GitHub pull-request template response has no base64 content" };
  }
  const encoded = record.content.replace(/\s/g, "");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    return { kind: "unverified", reason: "GitHub pull-request template content is not base64" };
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    return { kind: "unverified", reason: "GitHub pull-request template content is not base64" };
  }
  if (bytes.length > MAX_PULL_REQUEST_TEMPLATE_BYTES) {
    return { kind: "unverified", reason: `GitHub pull-request template exceeds ${MAX_PULL_REQUEST_TEMPLATE_BYTES} bytes` };
  }
  try {
    return { kind: "available", body: new TextDecoder("utf-8", { fatal: true }).decode(bytes), exists: true };
  } catch {
    return { kind: "unverified", reason: "GitHub pull-request template is not UTF-8" };
  }
}

function markdownSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  let heading: string | undefined;
  for (const line of stripFencedCode(markdown).replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/)) {
    const match = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      heading = normalizeHeading(match[1]!);
      if (!sections.has(heading)) sections.set(heading, "");
    } else if (heading !== undefined) {
      sections.set(heading, `${sections.get(heading) ?? ""}${line}\n`);
    }
  }
  return sections;
}

function stripFencedCode(markdown: string): string {
  let fence: { marker: "`" | "~"; length: number } | undefined;
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      if (fence) {
        const closing = new RegExp(`^ {0,3}\\${fence.marker}{${fence.length},}\\s*$`);
        if (closing.test(line)) fence = undefined;
        return "";
      }
      const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (!opening) return line;
      const run = opening[1]!;
      fence = { marker: run[0] as "`" | "~", length: run.length };
      return "";
    })
    .join("\n");
}

function normalizeHeading(heading: string): string {
  return heading
    .replace(/[`*_]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function fallbackPullRequestTemplate(): string {
  return "## Summary\n\n## Verification\n\n## Risk tier\n";
}

function fallbackPullRequestSections(): Map<string, string> {
  return markdownSections(fallbackPullRequestTemplate());
}

function findSection(
  sections: Map<string, string>,
  candidates: string[],
  prefer?: (content: string) => boolean,
): string | undefined {
  const headings = [...new Set([
    ...candidates.filter((candidate) => sections.has(candidate)),
    ...candidates.flatMap((candidate) => [...sections.keys()].filter((heading) => heading.includes(candidate))),
  ])];
  return headings.find((heading) => prefer?.(sections.get(heading) ?? "") === true) ?? headings[0];
}

function hasVisibleSectionContent(content: string): boolean {
  let unchecked = false;
  return content.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    if (/^[-*]\s+\[\s\]/.test(trimmed)) {
      unchecked = true;
      return false;
    }
    if (/^[-*]\s+\[[xX]\]/.test(trimmed)) return true;
    if (unchecked && /^\s{2,}\S/.test(line)) return false;
    unchecked = false;
    return trimmed.length > 0 && trimmed !== "-" && trimmed !== "*";
  });
}

function sectionHasCheckbox(content: string): boolean {
  return content.split(/\r?\n/).some((line) => /^\s*[-*]\s+\[[ xX]\]/.test(line));
}

function checkedTemplateCheckboxCount(template: string, actual: string): number {
  const options = new Set(
    template
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = /^\s*[-*]\s+\[[ xX]\]\s+(.+?)\s*$/.exec(line);
        return match ? [normalizeHeading(match[1]!)] : [];
      }),
  );
  return actual.split(/\r?\n/).filter((line) => {
    const match = /^\s*[-*]\s+\[[xX]\]\s+(.+?)\s*$/.exec(line);
    return match !== null && options.has(normalizeHeading(match[1]!));
  }).length;
}

/**
 * Reads one GitHub release by the tag its URL names (ADR-0066). A published
 * release answers the by-tag endpoint directly. A release the human has not
 * published yet has no tag for GitHub to answer by, so a credentialed
 * not-found falls back to one bounded page of the repository's releases and
 * accepts a *draft* whose `tag_name` is the reported one — the state the
 * operator flow starts in (worker prepares the release, a human publishes,
 * the sweep observes it become `published`). Both reads are GETs: Snowcat
 * never creates, tags, or publishes a release.
 *
 * The repository binding is the release's own API `url`, not the reported HTML
 * URL, because a draft's `html_url` names an `untagged-…` placeholder and
 * because the API follows repository renames — so `acceptFormerName` needs no
 * separate comparison here.
 */
async function verifyRelease(
  repository: string,
  artifact: WorkArtifact,
  locator: Extract<ArtifactLocator, { kind: "release" }>,
  fetcher: GitHubFetch,
  now: () => string,
): Promise<ArtifactCheck> {
  const base = `/repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.name)}/releases`;
  const response = await githubApiJson(`${base}/tags/${encodeURIComponent(locator.tag)}`, AbortSignal.timeout(GITHUB_TIMEOUT_MS), fetcher);
  if (response.kind === "unavailable") return unverified(now(), "GitHub API unavailable");
  if (response.status === 404 || response.status === 410) {
    if (!process.env.SNOWCAT_GITHUB_TOKEN) {
      return unverified(
        now(),
        `GitHub returned ${response.status} without SNOWCAT_GITHUB_TOKEN; private repositories cannot be verified unauthenticated`,
      );
    }
    return findDraftRelease(repository, artifact, locator, base, fetcher, now);
  }
  if (response.status !== 200) return unverified(now(), `GitHub API returned HTTP ${response.status}`);
  return readRelease(repository, artifact, locator, response.value, now);
}

async function findDraftRelease(
  repository: string,
  artifact: WorkArtifact,
  locator: Extract<ArtifactLocator, { kind: "release" }>,
  base: string,
  fetcher: GitHubFetch,
  now: () => string,
): Promise<ArtifactCheck> {
  const response = await githubApiJson(`${base}?per_page=${RELEASE_PAGE_SIZE}`, AbortSignal.timeout(GITHUB_TIMEOUT_MS), fetcher);
  if (response.kind === "unavailable") return unverified(now(), "GitHub API unavailable");
  // Credentialed and still not found: neither a published release at that tag
  // nor a release listing for that repository exists.
  if (response.status === 404 || response.status === 410) {
    return { kind: "rejected", reason: `release ${artifact.url} does not exist on GitHub` };
  }
  if (response.status !== 200) return unverified(now(), `GitHub API returned HTTP ${response.status}`);
  if (!Array.isArray(response.value)) return unverified(now(), "GitHub release listing was not an array");
  const match = response.value.find(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).tag_name === locator.tag &&
      (entry as Record<string, unknown>).draft === true,
  );
  if (match === undefined) return { kind: "rejected", reason: `release ${artifact.url} does not exist on GitHub` };
  return readRelease(repository, artifact, locator, match, now);
}

function readRelease(
  repository: string,
  artifact: WorkArtifact,
  locator: Extract<ArtifactLocator, { kind: "release" }>,
  value: unknown,
  now: () => string,
): ArtifactCheck {
  if (!value || typeof value !== "object" || Array.isArray(value)) return unverified(now(), "GitHub response was not an object");
  const record = value as Record<string, unknown>;
  if (typeof record.url !== "string") return unverified(now(), "GitHub response has no repository");
  if (!record.url.toLowerCase().startsWith(`${GITHUB_API_ORIGIN.toLowerCase()}/repos/${repository.toLowerCase()}/releases/`)) {
    return { kind: "rejected", reason: `release ${artifact.url} belongs to another repository` };
  }
  if (record.tag_name !== locator.tag) {
    return { kind: "rejected", reason: `release tag does not match ${artifact.url}` };
  }
  if (!Number.isSafeInteger(record.id) || Number(record.id) < 1) return unverified(now(), "GitHub response has no release id");
  if (record.draft !== true && record.draft !== false) return unverified(now(), "GitHub response has no recognizable state");
  return {
    kind: "verified",
    verification: {
      status: "verified",
      verifiedAt: now(),
      number: Number(record.id),
      state: record.draft === true ? "draft" : "published",
      tag: locator.tag,
      ...(typeof record.published_at === "string" ? { publishedAt: record.published_at } : {}),
    },
  };
}

/**
 * Verifies every issue, pull-request, and release artifact for a completion.
 * Throws on the first rejected artifact so the whole completion is refused;
 * other kinds pass through unchanged.
 */
export async function verifyCompletionArtifacts(
  repository: string,
  artifacts: WorkArtifact[],
  options: ArtifactVerifierOptions = {},
): Promise<WorkArtifact[]> {
  if (
    artifacts.some((artifact) => artifact.kind === "pull-request") &&
    !options.completionEvidence?.some((entry) => entry.trim().length > 0)
  ) {
    throw new Error("artifact rejected: pull-request completion reports no evidence");
  }
  const verified: WorkArtifact[] = [];
  const templateCache = options.templateCache ?? new Map<string, Promise<PullRequestTemplateRead>>();
  for (const artifact of artifacts) {
    if (!isVerifiableArtifact(artifact)) {
      verified.push(artifact);
      continue;
    }
    const check = await verifyGitHubArtifact(repository, artifact, { ...options, templateCache });
    if (check.kind === "rejected" || check.kind === "handoff-rejected") {
      throw new Error(`artifact rejected: ${check.reason}`);
    }
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
 * says now. `limit` bounds the items that have such artifacts (newest first),
 * not arbitrary completions. A rejected artifact is recorded as unverified with the reason,
 * never deleted: the worker's report stays provenance. Unavailable answers
 * leave the previous verification in place. This is the one path that accepts
 * a URL recorded under the repository's former name, and only when GitHub's
 * own answer names the item's repository (`acceptFormerName`).
 */
export async function refreshArtifactVerifications(
  queue: QueueStore,
  options: ArtifactVerifierOptions & { repository?: string; limit?: number; actor?: string } = {},
): Promise<RefreshArtifactsResult> {
  const actor = options.actor ?? "operator:cli";
  const limit = options.limit ?? DEFAULT_REFRESH_LIMIT;
  const templateCache = options.templateCache ?? new Map<string, Promise<PullRequestTemplateRead>>();
  // Select only completed items that still have something to check, newest
  // first: list()'s priority/created ordering and 100-row clamp would let a
  // repository with more than 100 terminal completions starve every newer one.
  const items = queue.completedItemsWithPendingArtifacts({ repository: options.repository, limit });
  const result: RefreshArtifactsResult = { checked: 0, updated: [], unavailable: [], rejected: [] };
  for (const item of items) {
    for (const artifact of pendingArtifacts(item)) {
      result.checked += 1;
      // Only this path learns renames: an artifact reported before the
      // repository was renamed still names GitHub's answer for this item.
      const previous = artifact.verification;
      const shouldCheckHandoff =
        artifact.kind === "pull-request" &&
        ((previous?.status === "unverified" && (item.result?.evidence.length ?? 0) > 0) ||
          (previous?.status === "verified" && previous.handoff !== undefined));
      const check = await verifyGitHubArtifact(item.repository, artifact, {
        ...options,
        templateCache,
        acceptFormerName: true,
        ...(shouldCheckHandoff ? { completionEvidence: item.result?.evidence } : {}),
      });
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
      if (check.kind === "handoff-rejected") {
        const unchanged =
          previous?.status === "verified" &&
          previous.handoff?.status === "rejected" &&
          previous.handoff.reason === check.reason &&
          previous.state === check.verification.state &&
          previous.headSha === check.verification.headSha &&
          previous.draft === check.verification.draft;
        if (!unchanged) queue.recordArtifactVerification(item.id, artifact.url, check.verification, actor);
        result.rejected.push({ id: item.id, url: artifact.url, reason: check.reason });
        continue;
      }
      const verification =
        check.verification.status === "verified" &&
        previous?.status === "verified" &&
        previous.handoff !== undefined &&
        check.verification.handoff === undefined &&
        !shouldCheckHandoff
          ? { ...check.verification, handoff: previous.handoff }
          : check.verification;
      const unchanged =
        previous?.status === "verified" &&
        verification.status === "verified" &&
        previous.state === verification.state &&
        previous.headSha === verification.headSha &&
        previous.draft === verification.draft &&
        previous.handoff?.status === verification.handoff?.status &&
        previous.handoff?.reason === verification.handoff?.reason;
      if (unchanged) continue;
      queue.recordArtifactVerification(item.id, artifact.url, verification, actor);
      result.updated.push({ id: item.id, url: artifact.url, status: "verified", state: verification.state });
    }
  }
  return result;
}

export type AttachableArtifactKind = "issue" | "pull-request" | "release";

export interface AttachArtifactInput {
  url: string;
  /** Defaults from the URL path: `/pull/<n>` → `pull-request`, `/issues/<n>` → `issue`, `/releases/tag/<tag>` → `release`. */
  kind?: AttachableArtifactKind;
  description?: string;
}

/**
 * The artifact kind a GitHub URL's path names, or `undefined` when the path is
 * none of `/pull/<n>`, `/issues/<n>`, or `/releases/tag/<tag>`. Used to
 * default `--kind`; the repository check happens in verification and in the
 * store.
 */
export function artifactKindFromUrl(url: string): AttachableArtifactKind | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const segments = parsed.pathname.split("/");
  if (segments.length === 6 && segments[3] === "releases" && segments[4] === "tag") {
    const tag = decodeTag(segments[5] ?? "");
    return tag !== undefined && RELEASE_TAG_PATTERN.test(tag) ? "release" : undefined;
  }
  if (segments.length !== 5 || !/^[1-9][0-9]*$/.test(segments[4] ?? "")) return undefined;
  if (segments[3] === "pull") return "pull-request";
  if (segments[3] === "issues") return "issue";
  return undefined;
}

/**
 * Operator attach: checks one issue, pull-request, or release URL against
 * GitHub exactly as `complete_work` does, then records it on the completed item
 * through `QueueStore.attachArtifact`. A rejected answer (not in the item's
 * repository, wrong number, absent) throws `artifact rejected: <reason>` and
 * writes nothing; an unavailable answer attaches the artifact `unverified`
 * with the reason so a later `verify-artifacts` pass refreshes it. The
 * verification stored is always GitHub's answer, never one supplied by the
 * caller. Used by `queue -- attach-artifact` and the surface's form only.
 */
export async function attachVerifiedArtifact(
  queue: QueueStore,
  id: string,
  actor: string,
  input: AttachArtifactInput,
  options: ArtifactVerifierOptions & { precondition?: MutationPrecondition } = {},
): Promise<{ item: WorkItem; check: Exclude<ArtifactCheck, { kind: "rejected" }> }> {
  const item = queue.get(id);
  if (!item) throw new Error(`work item not found: ${id}`);
  const kind = input.kind ?? artifactKindFromUrl(input.url);
  if (!kind) {
    throw new Error(
      `artifact URL must be a GitHub pull-request, issue, or release URL (…/pull/<n>, …/issues/<n>, or …/releases/tag/<tag>): ${input.url}`,
    );
  }
  const artifact: WorkArtifact = { kind, url: input.url, ...(input.description !== undefined ? { description: input.description } : {}) };
  const check = await verifyGitHubArtifact(item.repository, artifact, options);
  if (check.kind === "rejected") throw new Error(`artifact rejected: ${check.reason}`);
  const attached = queue.attachArtifact(
    id,
    actor,
    { kind, url: input.url, ...(input.description !== undefined ? { description: input.description } : {}), verification: check.verification },
    options.precondition,
  );
  return { item: attached, check };
}

function pendingArtifacts(item: WorkItem): WorkArtifact[] {
  return (item.result?.artifacts ?? []).filter((artifact) => {
    if (!isVerifiableArtifact(artifact)) return false;
    const verification = artifact.verification;
    if (!verification || verification.status === "unverified") return true;
    // `open` (issue, pull request) and `draft` (release) are the non-terminal
    // observed states; `closed`, `merged`, and `published` are terminal.
    return verification.state === "open" || verification.state === "draft";
  });
}

function unverified(attemptedAt: string, reason: string): ArtifactCheck {
  return { kind: "unverified", verification: { status: "unverified", attemptedAt, reason } };
}

type ArtifactLocator =
  | { kind: "issue" | "pull-request"; owner: string; name: string; number: number }
  | { kind: "release"; owner: string; name: string; tag: string };

/**
 * The owner, repository name, and number (or, for a release, tag) a
 * well-formed GitHub issue, pull-request, or release URL names, or `undefined`
 * when the URL is not one. The slug is the URL's own — it is not required to
 * match the item's repository, because a URL recorded under a former name is
 * asked about with the slug it carries; whether GitHub's answer belongs to the
 * item's repository is decided in `verifyGitHubArtifact` from the response
 * itself.
 */
function parseArtifactUrl(artifact: WorkArtifact): ArtifactLocator | undefined {
  let url: URL;
  try {
    url = new URL(artifact.url);
  } catch {
    return undefined;
  }
  const segments = url.pathname.split("/");
  const slug = /^[A-Za-z0-9._-]+$/;
  if (url.hostname.toLowerCase() !== "github.com" || !slug.test(segments[1] ?? "") || !slug.test(segments[2] ?? "")) {
    return undefined;
  }
  const owner = segments[1]!;
  const name = segments[2]!;
  if (artifact.kind === "release") {
    // `/<owner>/<name>/releases/tag/<tag>` — six segments, and the tag is the
    // identifier, decoded because a Git tag may contain `/`.
    if (segments.length !== 6 || segments[3] !== "releases" || segments[4] !== "tag") return undefined;
    const tag = decodeTag(segments[5] ?? "");
    if (tag === undefined || !RELEASE_TAG_PATTERN.test(tag)) return undefined;
    return { kind: "release", owner, name, tag };
  }
  const expectedPath = artifact.kind === "issue" ? "issues" : "pull";
  if (segments.length !== 5 || segments[3] !== expectedPath || !/^[1-9][0-9]*$/.test(segments[4] ?? "")) return undefined;
  return { kind: artifact.kind === "issue" ? "issue" : "pull-request", owner, name, number: Number(segments[4]) };
}

function decodeTag(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}
