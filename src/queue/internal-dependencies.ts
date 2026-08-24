import { githubApiJson, type GitHubFetch } from "../repository/github-api.ts";
import { enrolledRepositories } from "./eligibility.ts";
import type { QueueStore } from "./store.ts";
import type { AllowedAction, ProposedRootInput, WorkItem } from "./types.ts";

/**
 * The internal dependency chain (maintenance programs plan, Phase 6): a
 * mechanical sweep — no model — over the enrolled repositories' Go manifests.
 *
 * - An enrolled repository whose default branch is ahead of its latest
 *   release tag gets one `release-needed` proposal ("cut a release: N commits
 *   since vX.Y.Z"). Cutting the tag stays the operator's (`make bump`); an
 *   admitted child prepares whatever the release needs (changelog, version
 *   references) in one pull request.
 * - An enrolled repository whose `go.mod` requires a frostyard-owned module
 *   at a version behind that module's latest release tag gets one
 *   `dependency-bump` proposal per (module, target tag). The bump proposal
 *   never targets an unreleased commit, so the chain orders itself: the
 *   upstream release lands first, the downstream bump appears afterwards.
 *
 * Both are proposals (release and bump are outward-facing), deduplicated by
 * `sourceRef`, and bounded: at most one non-terminal `release-needed` per
 * repository, and a repository whose latest `release-needed` was declined
 * within the last week is not asked again for the same tag.
 */

const GITHUB_TIMEOUT_MS = 30_000;
const FROSTYARD_MODULE = /^github\.com\/frostyard\/([A-Za-z0-9._-]+)(?:\/v[0-9]+)?$/;
const SEMVER_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;
const DECLINE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export const RELEASE_NEEDED_KIND = "release-needed";
export const DEPENDENCY_BUMP_KIND = "dependency-bump";
const IMPLEMENTATION_ACTIONS: AllowedAction[] = ["read", "write", "run-tests", "open-pr"];

export interface SweepOptions {
  fetcher?: GitHubFetch;
  clock?: () => Date;
  /** Only this repository (owner/name) is swept; other enrolled repositories still contribute tags. */
  repository?: string;
}

export interface RepositoryRelease {
  repository: string;
  defaultBranch: string;
  headSha: string;
  /** Highest release-shaped tag (`vX.Y.Z`), or undefined when the repository has none. */
  latestTag?: string;
  latestTagSha?: string;
  aheadBy: number;
  /** Conventional-commit types seen since the tag, for the suggested bump. */
  commitTypes: string[];
}

export interface DependencySweepResult {
  swept: string[];
  releaseNeeded: Array<{ repository: string; id: string; latestTag: string; aheadBy: number; suggestedBump: string }>;
  dependencyBumps: Array<{ repository: string; id: string; module: string; from: string; to: string }>;
  /** Nothing to do, and why: up to date, already proposed, recently declined, no release yet, no go.mod. */
  skipped: Array<{ repository: string; reason: string }>;
  failed: Array<{ repository: string; reason: string }>;
  notOptedIn: string[];
}

/**
 * The exit-code decision for `sweep-dependencies --enrolled`, mirroring
 * `import-issues --enrolled`: partial failure is reported, not fatal (the
 * timer must not lose the repositories that did sweep), so this returns a
 * message only when at least one repository failed and none was swept. A
 * sweep with nothing but `notOptedIn` entries has no failure and returns
 * undefined.
 */
export function sweepFailureMessage(result: DependencySweepResult): string | undefined {
  if (result.failed.length === 0 || result.swept.length > 0) return undefined;
  return `sweep-dependencies --enrolled: every repository failed (${result.failed.map((entry) => entry.repository).join(", ")})`;
}

/**
 * Sweeps every repository that is opted in and enrolled (`--enrolled`) or the
 * one named repository, reading each `go.mod`, tags, and default-branch
 * comparison from GitHub, and creating the bounded proposals above.
 */
export async function sweepInternalDependencies(
  queue: QueueStore,
  controlPlanePath: string | undefined,
  options: SweepOptions = {},
): Promise<DependencySweepResult> {
  const fetcher = options.fetcher ?? fetch;
  const now = () => (options.clock ?? (() => new Date()))();
  const optedIn = new Map(queue.enabledRepositories().map((slug) => [slug.toLowerCase(), slug]));
  const result: DependencySweepResult = { swept: [], releaseNeeded: [], dependencyBumps: [], skipped: [], failed: [], notOptedIn: [] };

  let targets: string[];
  if (options.repository) {
    const repository = optedIn.get(options.repository.toLowerCase());
    if (!repository) throw new Error(`repository is not opted in: ${options.repository}`);
    targets = [repository];
  } else {
    if (!controlPlanePath) throw new Error("sweep-dependencies --enrolled requires SNOWCAT_CONTROL_DB to name the control-plane database");
    targets = [];
    for (const slug of [...enrolledRepositories(controlPlanePath)].sort()) {
      const repository = optedIn.get(slug.toLowerCase());
      if (repository === undefined) result.notOptedIn.push(slug);
      else targets.push(repository);
    }
  }

  const releases = new Map<string, RepositoryRelease>();
  const releaseAttempts = new Set<string>();
  const manifests = new Map<string, Map<string, string>>();
  for (const repository of targets) {
    releaseAttempts.add(repository);
    try {
      const release = await readRepositoryRelease(repository, fetcher);
      releases.set(repository, release);
      manifests.set(repository, await readGoModRequires(repository, release.headSha, fetcher));
      result.swept.push(repository);
    } catch (error) {
      result.failed.push({ repository, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  // Upstream tags for frostyard modules a swept repository requires but that were not swept themselves.
  for (const requires of manifests.values()) {
    for (const module of requires.keys()) {
      const upstream = frostyardRepositoryOf(module);
      if (!upstream || releaseAttempts.has(upstream)) continue;
      releaseAttempts.add(upstream);
      try {
        releases.set(upstream, await readRepositoryRelease(upstream, fetcher));
      } catch (error) {
        result.failed.push({ repository: upstream, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  for (const repository of result.swept) {
    const release = releases.get(repository)!;
    // Release needed?
    if (!release.latestTag) {
      result.skipped.push({ repository, reason: "no release tag yet" });
    } else if (release.aheadBy === 0) {
      result.skipped.push({ repository, reason: `up to date with ${release.latestTag}` });
    } else {
      const existing = queue.list({ repository, kind: RELEASE_NEEDED_KIND, limit: 100 });
      const open = existing.find((item) => !isTerminal(item));
      const declined = existing
        .filter((item) => item.status === "cancelled" && item.sourceRef?.includes(`@${release.latestTag}+`))
        .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1))[0];
      if (open) {
        result.skipped.push({ repository, reason: `release-needed already open (${open.id})` });
      } else if (declined && now().getTime() - new Date(declined.updatedAt).getTime() < DECLINE_COOLDOWN_MS) {
        result.skipped.push({ repository, reason: `release-needed for ${release.latestTag} declined ${declined.updatedAt}; asking again after 7 days` });
      } else {
        const suggestedBump = suggestBump(release.latestTag, release.commitTypes);
        const created = queue.enqueueProposedRoots(repository, [releaseNeededProposal(repository, release, suggestedBump)]);
        for (const item of created.created) {
          result.releaseNeeded.push({ repository, id: item.id, latestTag: release.latestTag, aheadBy: release.aheadBy, suggestedBump });
        }
        if (created.created.length === 0) result.skipped.push({ repository, reason: `release-needed for head ${release.headSha.slice(0, 7)} already known` });
      }
    }
    // Bumps needed?
    for (const [module, required] of manifests.get(repository) ?? []) {
      const upstream = frostyardRepositoryOf(module);
      if (!upstream) continue;
      const upstreamRelease = releases.get(upstream);
      if (!upstreamRelease?.latestTag) continue;
      const requiredVersion = parseSemver(required);
      const latest = parseSemver(upstreamRelease.latestTag)!;
      if (requiredVersion && compareSemver(requiredVersion, latest) >= 0) continue;
      const created = queue.enqueueProposedRoots(repository, [dependencyBumpProposal(repository, module, required, upstreamRelease.latestTag, upstream)]);
      for (const item of created.created) {
        result.dependencyBumps.push({ repository, id: item.id, module, from: required, to: upstreamRelease.latestTag });
      }
    }
  }
  return result;
}

async function readRepositoryRelease(repository: string, fetcher: GitHubFetch): Promise<RepositoryRelease> {
  const [owner, name] = repository.split("/") as [string, string];
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const repo = await githubApiJson(base, AbortSignal.timeout(GITHUB_TIMEOUT_MS), fetcher);
  if (repo.kind !== "response" || repo.status !== 200) throw new Error(`GitHub repository read failed for ${repository}`);
  const defaultBranch = String((repo.value as Record<string, unknown>).default_branch ?? "main");
  const head = await githubApiJson(`${base}/commits/${encodeURIComponent(defaultBranch)}`, AbortSignal.timeout(GITHUB_TIMEOUT_MS), fetcher);
  if (head.kind !== "response" || head.status !== 200) throw new Error(`GitHub head read failed for ${repository}`);
  const headSha = String((head.value as Record<string, unknown>).sha ?? "");
  if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error(`GitHub head SHA unreadable for ${repository}`);
  const tags = await githubApiJson(`${base}/tags?per_page=100`, AbortSignal.timeout(GITHUB_TIMEOUT_MS), fetcher);
  if (tags.kind !== "response" || tags.status !== 200 || !Array.isArray(tags.value)) throw new Error(`GitHub tags read failed for ${repository}`);
  let latest: { tag: string; sha: string; version: [number, number, number] } | undefined;
  for (const raw of tags.value) {
    const entry = raw as Record<string, unknown>;
    const tag = typeof entry.name === "string" ? entry.name : undefined;
    const sha = entry.commit && typeof entry.commit === "object" ? String((entry.commit as Record<string, unknown>).sha ?? "") : "";
    const version = tag ? parseSemver(tag) : undefined;
    if (!tag || !version) continue;
    if (!latest || compareSemver(version, latest.version) > 0) latest = { tag, sha, version };
  }
  const release: RepositoryRelease = { repository, defaultBranch, headSha: headSha.toLowerCase(), aheadBy: 0, commitTypes: [] };
  if (!latest) return release;
  release.latestTag = latest.tag;
  release.latestTagSha = latest.sha;
  const compare = await githubApiJson(
    `${base}/compare/${encodeURIComponent(latest.tag)}...${encodeURIComponent(defaultBranch)}`,
    AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    fetcher,
  );
  if (compare.kind !== "response" || compare.status !== 200) throw new Error(`GitHub compare failed for ${repository} (${latest.tag}...${defaultBranch})`);
  const body = compare.value as Record<string, unknown>;
  release.aheadBy = Number(body.ahead_by ?? 0);
  if (Array.isArray(body.commits)) {
    for (const raw of body.commits) {
      const message = (((raw as Record<string, unknown>).commit as Record<string, unknown> | undefined)?.message as string | undefined) ?? "";
      const match = /^([a-z]+)(\([^)]*\))?(!)?:/i.exec(message.split("\n")[0] ?? "");
      if (match) release.commitTypes.push(match[3] ? `${match[1]!.toLowerCase()}!` : match[1]!.toLowerCase());
      if (/^BREAKING CHANGE:/m.test(message)) release.commitTypes.push("breaking");
    }
  }
  return release;
}

/** `require` entries of the repository's root `go.mod` at `ref`: module path → version. */
async function readGoModRequires(repository: string, ref: string, fetcher: GitHubFetch): Promise<Map<string, string>> {
  const [owner, name] = repository.split("/") as [string, string];
  const response = await githubApiJson(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/go.mod?ref=${encodeURIComponent(ref)}`,
    AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    fetcher,
  );
  if (response.kind === "response" && response.status === 404) return new Map();
  if (response.kind !== "response" || response.status !== 200) throw new Error(`GitHub go.mod read failed for ${repository}`);
  const record = response.value as Record<string, unknown>;
  const content = typeof record.content === "string" ? Buffer.from(record.content.replace(/\n/g, ""), "base64").toString("utf8") : "";
  return parseGoModRequires(content);
}

export function parseGoModRequires(goMod: string): Map<string, string> {
  const requires = new Map<string, string>();
  let inBlock = false;
  for (const rawLine of goMod.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (line === "require (") {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ")") {
      inBlock = false;
      continue;
    }
    const single = /^require\s+(\S+)\s+(\S+)$/.exec(line);
    const inner = inBlock ? /^(\S+)\s+(\S+)$/.exec(line) : null;
    const match = single ?? inner;
    if (match) requires.set(match[1]!, match[2]!);
  }
  return requires;
}

export function frostyardRepositoryOf(module: string): string | undefined {
  const match = FROSTYARD_MODULE.exec(module);
  return match ? `frostyard/${match[1]}` : undefined;
}

export function parseSemver(value: string): [number, number, number] | undefined {
  // Pseudo-versions (v0.0.0-20260818120000-abcdef123456) parse by their base; a
  // pseudo-version is by construction behind or at the base release.
  const bare = value.replace(/^v/, "").split("-")[0]!;
  const match = SEMVER_TAG.exec(`v${bare}`);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function compareSemver(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! !== right[index]!) return left[index]! < right[index]! ? -1 : 1;
  }
  return 0;
}

/** svu-style suggestion from conventional-commit types since the tag: informational, the operator decides. */
export function suggestBump(latestTag: string, commitTypes: string[]): string {
  const version = parseSemver(latestTag);
  if (!version) return "unknown";
  const breaking = commitTypes.some((type) => type.endsWith("!") || type === "breaking");
  const feature = commitTypes.includes("feat");
  const [major, minor, patch] = version;
  if (breaking && major > 0) return `v${major + 1}.0.0 (major)`;
  if (breaking || feature) return `v${major}.${minor + 1}.0 (minor)`;
  return `v${major}.${minor}.${patch + 1} (patch)`;
}

function isTerminal(item: WorkItem): boolean {
  return item.status === "completed" || item.status === "cancelled";
}

function releaseNeededProposal(repository: string, release: RepositoryRelease, suggestedBump: string): ProposedRootInput {
  const tag = release.latestTag!;
  const types = summarize(release.commitTypes);
  return {
    sourceRef: `release-needed:${repository}@${tag}+${release.headSha}`,
    kind: RELEASE_NEEDED_KIND,
    objective: `Cut a release of ${repository}: ${release.aheadBy} commit${release.aheadBy === 1 ? "" : "s"} on ${release.defaultBranch} since ${tag} (suggested ${suggestedBump})`,
    instructions: [
      `${repository}'s ${release.defaultBranch} (${release.headSha}) is ${release.aheadBy} commit${release.aheadBy === 1 ? "" : "s"} ahead of its latest release tag ${tag}${types ? ` (${types})` : ""}. Snowcat computed this from GitHub tags and the branch comparison; it is a fact, not a judgment about whether a release is warranted.`,
      "Prepare the release without cutting it: confirm the repository's checks are green on the default branch, review the unreleased changes and the suggested next version (svu semantics: breaking → major unless v0, feat → minor, else patch), and land in ONE pull request whatever the repository's release convention requires before a tag — changelog or release-notes entries, version references in docs or manifests, a migration note for a breaking change. If nothing needs to change before tagging, complete this item with that evidence and no pull request.",
      "Do NOT create the tag, run `make bump`, publish a release, or push to the default branch: the tag is the operator's act, and the repository's release workflow publishes on the tag push. Say in the result exactly which version the operator should tag and why.",
    ].join(" "),
    acceptanceCriteria: [
      `The result names the unreleased commits since ${tag} (or the range) and the version the operator should tag, with the conventional-commit reasoning.`,
      "Any change the repository's release convention needs before a tag is in one pull request that passes the repository's own checks; if none is needed, the result says so with evidence.",
      "No tag, release, or default-branch push was made by this item.",
    ],
    allowedActions: IMPLEMENTATION_ACTIONS,
    delegableActions: [],
    // A release-needed item prepares the release through one pull request
    // (ADR-0069) from a fresh branch (ADR-0073). A worker that finds the
    // branch already release-ready blocks with that evidence — the
    // block-when-no-change doctrine imported issues already follow — and
    // the operator publishes and cancels.
    requiredArtifact: "pull-request",
    executionTarget: "new-pull-request",
    createdBy: "operator:dependency-sweep",
  };
}

function dependencyBumpProposal(repository: string, module: string, from: string, to: string, upstream: string): ProposedRootInput {
  return {
    sourceRef: `dependency-bump:${repository}:${module}@${to}`,
    kind: DEPENDENCY_BUMP_KIND,
    objective: `Bump ${module} from ${from} to ${to} in ${repository}`,
    instructions: [
      `${repository} requires ${module} ${from}; ${upstream} has released ${to}. Snowcat computed this from the repository's go.mod and the upstream's release tags.`,
      `Update the requirement to exactly ${to} (\`go get ${module}@${to} && go mod tidy\`), adapt to any API change the upstream's release notes describe, run the repository's own checks (\`make check\` or equivalent), and open ONE pull request titled like \`chore(deps): bump ${module} to ${to}\` that names the upstream release and what changed. Do not bump anything else in the same pull request; do not bump to an unreleased commit.`,
    ].join(" "),
    acceptanceCriteria: [
      `go.mod requires ${module} ${to} exactly and go.sum is tidy on the pull request head.`,
      "The repository's own checks pass on the pull request head, and the pull request cites the upstream release.",
      "No other dependency changed in the pull request.",
    ],
    allowedActions: IMPLEMENTATION_ACTIONS,
    delegableActions: [],
    // One bump is one pull request (ADR-0069) from a fresh branch (ADR-0073).
    requiredArtifact: "pull-request",
    executionTarget: "new-pull-request",
    createdBy: "operator:dependency-sweep",
  };
}

function summarize(commitTypes: string[]): string {
  const counts = new Map<string, number>();
  for (const type of commitTypes) counts.set(type, (counts.get(type) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");
}
