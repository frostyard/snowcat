import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { ControlPlaneStore } from "../control/store.ts";
import type { RepositorySettingsContract } from "../core/validator.ts";
import { githubApiJson, type GitHubFetch } from "../repository/github-api.ts";
import { enrolledRepositories } from "./eligibility.ts";
import type { QueueStore } from "./store.ts";
import type { AllowedAction, ProposedRootInput } from "./types.ts";

/**
 * Repository settings conformance (core ADR-0040): a mechanical sweep — no
 * model — that reads each enrolled repository's live GitHub settings and
 * compares them with the repository settings contract carried by the active
 * Core snapshot. Every drift set becomes one `settings-drift` proposal per
 * repository (deduplicated by the digest of what drifted), never an admin
 * write: Fluent holds no admin credential, and the operator applies the
 * contract with core's `scripts/apply-repo-settings.sh`.
 */

const GITHUB_TIMEOUT_MS = 30_000;
export const SETTINGS_DRIFT_KIND = "settings-drift";
const DRIFT_ACTIONS: AllowedAction[] = ["read"];

export interface SettingDrift {
  /** Dotted contract path, e.g. `repository.delete_branch_on_merge`, `default_branch_ruleset.require_pull_request`. */
  setting: string;
  expected: unknown;
  observed: unknown;
}

export interface RepositorySettingsReport {
  repository: string;
  defaultBranch: string;
  drifts: SettingDrift[];
  /** Settings the sweep could not read (insufficient scope, API failure); reported, never counted as drift. */
  unreadable: Array<{ setting: string; reason: string }>;
  /** Observed-only facts the contract does not require in v1. */
  observed: { visibility?: string; hasDiscussions?: boolean; requiredChecks?: string[] };
}

export interface SettingsSweepResult {
  contractCommit?: string;
  swept: string[];
  proposed: Array<{ repository: string; id: string; driftCount: number }>;
  conformant: string[];
  /** Drift already proposed (same drift set), or nothing new since. */
  skipped: Array<{ repository: string; reason: string }>;
  failed: Array<{ repository: string; reason: string }>;
  notOptedIn: string[];
  reports: RepositorySettingsReport[];
}

export interface SettingsSweepOptions {
  fetcher?: GitHubFetch;
  clock?: () => Date;
  repository?: string;
  /** Test seam: the contract to check against instead of the active snapshot's. */
  contract?: RepositorySettingsContract;
}

/**
 * Reads the repository settings contract from the active Core snapshot's
 * retained files. Returns undefined when the active snapshot predates the
 * contract (core ADR-0040), in which case the sweep reports and does nothing.
 */
export function activeRepositorySettingsContract(controlPlanePath: string): { contract: RepositorySettingsContract; commit: string } | undefined {
  const path = resolve(controlPlanePath);
  if (!existsSync(path)) throw new Error(`control-plane database does not exist: ${path} (FLUENT_CONTROL_DB)`);
  const store = new ControlPlaneStore(path);
  try {
    const active = store.activeCoreSnapshot();
    if (!active) return undefined;
    const candidate = store.retainedCoreCandidate(active.sourceCommitId);
    if (!candidate?.repositorySettings) return undefined;
    return { contract: candidate.repositorySettings, commit: active.sourceCommitId };
  } finally {
    store.close();
  }
}

export async function sweepRepositorySettings(
  queue: QueueStore,
  controlPlanePath: string | undefined,
  options: SettingsSweepOptions = {},
): Promise<SettingsSweepResult> {
  const fetcher = options.fetcher ?? fetch;
  const result: SettingsSweepResult = { swept: [], proposed: [], conformant: [], skipped: [], failed: [], notOptedIn: [], reports: [] };
  const optedIn = new Map(queue.enabledRepositories().map((slug) => [slug.toLowerCase(), slug]));

  let contract = options.contract;
  if (!contract) {
    if (!controlPlanePath) throw new Error("sweep-repository-settings requires FLUENT_CONTROL_DB to name the control-plane database");
    const active = activeRepositorySettingsContract(controlPlanePath);
    if (!active) {
      result.skipped.push({ repository: "*", reason: "the active Core snapshot carries no repository settings contract (core ADR-0040 not yet activated)" });
      return result;
    }
    contract = active.contract;
    result.contractCommit = active.commit;
  }

  let targets: string[];
  if (options.repository) {
    const repository = optedIn.get(options.repository.toLowerCase());
    if (!repository) throw new Error(`repository is not opted in: ${options.repository}`);
    targets = [repository];
  } else {
    if (!controlPlanePath) throw new Error("sweep-repository-settings --enrolled requires FLUENT_CONTROL_DB to name the control-plane database");
    targets = [];
    for (const slug of [...enrolledRepositories(controlPlanePath)].sort()) {
      const repository = optedIn.get(slug.toLowerCase());
      if (repository === undefined) result.notOptedIn.push(slug);
      else targets.push(repository);
    }
  }

  for (const repository of targets) {
    let report: RepositorySettingsReport;
    try {
      report = await readRepositorySettings(repository, contract, fetcher);
    } catch (error) {
      result.failed.push({ repository, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    result.swept.push(repository);
    result.reports.push(report);
    if (report.drifts.length === 0) {
      result.conformant.push(repository);
      continue;
    }
    const digest = driftDigest(report.drifts);
    const created = queue.enqueueProposedRoots(repository, [driftProposal(repository, report, digest, result.contractCommit)]);
    if (created.created.length === 0) {
      result.skipped.push({ repository, reason: `drift set ${digest.slice(0, 19)} already proposed` });
      continue;
    }
    result.proposed.push({ repository, id: created.created[0]!.id, driftCount: report.drifts.length });
  }
  return result;
}

/** Reads one repository's live settings and diffs them against the contract. Read-only. */
export async function readRepositorySettings(repository: string, contract: RepositorySettingsContract, fetcher: GitHubFetch): Promise<RepositorySettingsReport> {
  const [owner, name] = repository.split("/") as [string, string];
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const get = (path: string) => githubApiJson(`${base}${path}`, AbortSignal.timeout(GITHUB_TIMEOUT_MS), fetcher);
  const report: RepositorySettingsReport = { repository, defaultBranch: "main", drifts: [], unreadable: [], observed: {} };
  const drift = (setting: string, expected: unknown, observed: unknown) => {
    if (JSON.stringify(expected) !== JSON.stringify(observed)) report.drifts.push({ setting, expected, observed });
  };
  const unreadable = (setting: string, reason: string) => report.unreadable.push({ setting, reason });

  // 1. The repository object: merge hygiene, features, metadata, security_and_analysis (admin-only field).
  const repo = await get("");
  if (repo.kind !== "response" || repo.status !== 200) throw new Error(`GitHub repository read failed for ${repository}`);
  const record = repo.value as Record<string, unknown>;
  report.defaultBranch = String(record.default_branch ?? "main");
  report.observed.visibility = typeof record.visibility === "string" ? record.visibility : undefined;
  report.observed.hasDiscussions = record.has_discussions === true;
  for (const key of Object.keys(contract.repository) as Array<keyof RepositorySettingsContract["repository"]>) {
    drift(`repository.${key}`, contract.repository[key], record[key]);
  }
  if (contract.metadata.license_required) drift("metadata.license_required", true, Boolean(asObject(record.license)?.spdx_id));
  if (contract.metadata.description_required) drift("metadata.description_required", true, typeof record.description === "string" && record.description.trim().length > 0);
  const topics = Array.isArray(record.topics) ? (record.topics as string[]) : [];
  for (const topic of contract.metadata.topics_include) drift(`metadata.topics_include.${topic}`, true, topics.includes(topic));
  const security = asObject(record.security_and_analysis);
  if (!security) {
    unreadable("security.secret_scanning", "security_and_analysis absent from the repository read (needs admin scope)");
  } else {
    const status = (key: string) => asObject(security[key])?.status === "enabled";
    drift("security.secret_scanning", contract.security.secret_scanning, status("secret_scanning"));
    drift("security.secret_scanning_push_protection", contract.security.secret_scanning_push_protection, status("secret_scanning_push_protection"));
    drift("security.dependabot_security_updates", contract.security.dependabot_security_updates, status("dependabot_security_updates"));
  }

  // 2. Actions token permissions.
  const workflow = await get("/actions/permissions/workflow");
  if (workflow.kind === "response" && workflow.status === 200) {
    const value = workflow.value as Record<string, unknown>;
    drift("actions.default_workflow_permissions", contract.actions.default_workflow_permissions, value.default_workflow_permissions);
    drift("actions.can_approve_pull_request_reviews", contract.actions.can_approve_pull_request_reviews, value.can_approve_pull_request_reviews === true);
  } else unreadable("actions", workflow.kind === "response" ? `HTTP ${workflow.status}` : "unavailable");

  // 3. Vulnerability alerts (204 = on, 404 = off) and private vulnerability reporting.
  const alerts = await get("/vulnerability-alerts");
  if (alerts.kind === "response" && (alerts.status === 204 || alerts.status === 404)) {
    drift("security.vulnerability_alerts", contract.security.vulnerability_alerts, alerts.status === 204);
  } else unreadable("security.vulnerability_alerts", alerts.kind === "response" ? `HTTP ${alerts.status}` : "unavailable");
  const pvr = await get("/private-vulnerability-reporting");
  if (pvr.kind === "response" && pvr.status === 200) {
    drift("security.private_vulnerability_reporting", contract.security.private_vulnerability_reporting, (pvr.value as Record<string, unknown>).enabled === true);
  } else if (report.observed.visibility === "private") {
    // Not offered on private repositories; the contract value cannot apply.
  } else unreadable("security.private_vulnerability_reporting", pvr.kind === "response" ? `HTTP ${pvr.status}` : "unavailable");

  // 4. Rulesets: default branch and tags. Classic protection must be absent.
  const rulesets = await get("/rulesets?includes_parents=true&per_page=100");
  if (rulesets.kind !== "response" || rulesets.status !== 200 || !Array.isArray(rulesets.value)) {
    unreadable("default_branch_ruleset", rulesets.kind === "response" ? `HTTP ${rulesets.status}` : "unavailable");
  } else {
    const details: Array<Record<string, unknown>> = [];
    for (const raw of rulesets.value) {
      const summary = asObject(raw);
      if (!summary || summary.enforcement !== "active") continue;
      const detail = await get(`/rulesets/${summary.id}`);
      if (detail.kind === "response" && detail.status === 200 && asObject(detail.value)) details.push(detail.value as Record<string, unknown>);
    }
    const branchRules = details.filter((ruleset) => ruleset.target === "branch" && includesDefaultBranch(ruleset));
    const tagRules = details.filter((ruleset) => ruleset.target === "tag" && includesPattern(ruleset, contract.tag_ruleset.pattern));
    checkDefaultBranchRuleset(contract, branchRules, drift, report);
    checkTagRuleset(contract, tagRules, drift);
  }
  const classic = await get(`/branches/${encodeURIComponent(report.defaultBranch)}/protection`);
  if (classic.kind === "response" && (classic.status === 200 || classic.status === 404)) {
    drift("default_branch_ruleset.classic_branch_protection", "absent", classic.status === 200 ? "present" : "absent");
  } else if (classic.kind === "response" && classic.status === 403) {
    // Classic protection is unreadable without admin scope; treat as unknown.
    unreadable("default_branch_ruleset.classic_branch_protection", "HTTP 403");
  } else unreadable("default_branch_ruleset.classic_branch_protection", classic.kind === "response" ? `HTTP ${classic.status}` : "unavailable");

  // 5. Labels the fleet depends on.
  const labels = await get("/labels?per_page=100");
  if (labels.kind === "response" && labels.status === 200 && Array.isArray(labels.value)) {
    const names = new Set(labels.value.map((label) => String(asObject(label)?.name ?? "").toLowerCase()));
    for (const label of contract.labels.required) drift(`labels.required.${label}`, true, names.has(label.toLowerCase()));
  } else unreadable("labels", labels.kind === "response" ? `HTTP ${labels.status}` : "unavailable");

  return report;
}

function checkDefaultBranchRuleset(
  contract: RepositorySettingsContract,
  rulesets: Array<Record<string, unknown>>,
  drift: (setting: string, expected: unknown, observed: unknown) => void,
  report: RepositorySettingsReport,
): void {
  const want = contract.default_branch_ruleset;
  const rules = rulesets.flatMap((ruleset) => (Array.isArray(ruleset.rules) ? (ruleset.rules as Array<Record<string, unknown>>) : []));
  const bypass = rulesets.flatMap((ruleset) => (Array.isArray(ruleset.bypass_actors) ? ruleset.bypass_actors : []));
  const has = (type: string) => rules.find((rule) => rule.type === type);
  drift("default_branch_ruleset.enforcement", "active", rulesets.length > 0 ? "active" : "absent");
  if (rulesets.length === 0) return;
  drift("default_branch_ruleset.bypass_actors", "none", bypass.length === 0 ? "none" : `${bypass.length} actor(s)`);
  const pull = has("pull_request");
  drift("default_branch_ruleset.require_pull_request", want.require_pull_request, Boolean(pull));
  if (pull) {
    const parameters = asObject(pull.parameters) ?? {};
    drift("default_branch_ruleset.required_approving_review_count", want.required_approving_review_count, Number(parameters.required_approving_review_count ?? 0));
    drift("default_branch_ruleset.require_conversation_resolution", want.require_conversation_resolution, parameters.required_review_thread_resolution === true);
  }
  const checks = has("required_status_checks");
  drift("default_branch_ruleset.require_status_checks", want.require_status_checks, Boolean(checks));
  if (checks) {
    const parameters = asObject(checks.parameters) ?? {};
    drift("default_branch_ruleset.strict_required_status_checks", want.strict_required_status_checks, parameters.strict_required_status_checks_policy === true);
    const contexts = Array.isArray(parameters.required_status_checks) ? parameters.required_status_checks.map((check) => String(asObject(check)?.context ?? "")) : [];
    report.observed.requiredChecks = contexts;
  }
  drift("default_branch_ruleset.block_deletions", want.block_deletions, Boolean(has("deletion")));
  drift("default_branch_ruleset.block_force_pushes", want.block_force_pushes, Boolean(has("non_fast_forward")));
  drift("default_branch_ruleset.merge_queue", false, Boolean(has("merge_queue")));
}

function checkTagRuleset(
  contract: RepositorySettingsContract,
  rulesets: Array<Record<string, unknown>>,
  drift: (setting: string, expected: unknown, observed: unknown) => void,
): void {
  const want = contract.tag_ruleset;
  const rules = rulesets.flatMap((ruleset) => (Array.isArray(ruleset.rules) ? (ruleset.rules as Array<Record<string, unknown>>) : []));
  const has = (type: string) => rules.some((rule) => rule.type === type);
  drift("tag_ruleset.enforcement", "active", rulesets.length > 0 ? "active" : "absent");
  if (rulesets.length === 0) return;
  drift("tag_ruleset.block_deletions", want.block_deletions, has("deletion"));
  drift("tag_ruleset.block_force_pushes", want.block_force_pushes, has("non_fast_forward"));
  drift("tag_ruleset.restrict_creation", want.restrict_creation, has("creation"));
}

function includesDefaultBranch(ruleset: Record<string, unknown>): boolean {
  const include = asObject(asObject(ruleset.conditions)?.ref_name)?.include;
  return Array.isArray(include) && include.some((ref) => ref === "~DEFAULT_BRANCH" || ref === "~ALL" || ref === "refs/heads/main");
}

function includesPattern(ruleset: Record<string, unknown>, pattern: string): boolean {
  const include = asObject(asObject(ruleset.conditions)?.ref_name)?.include;
  return Array.isArray(include) && include.some((ref) => ref === "~ALL" || ref === `refs/tags/${pattern}`);
}

export function driftDigest(drifts: SettingDrift[]): string {
  const material = JSON.stringify([...drifts].sort((left, right) => (left.setting < right.setting ? -1 : 1)));
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

function driftProposal(repository: string, report: RepositorySettingsReport, digest: string, contractCommit: string | undefined): ProposedRootInput {
  const lines = report.drifts.map((drift) => `- ${drift.setting}: expected ${JSON.stringify(drift.expected)}, observed ${JSON.stringify(drift.observed)}`);
  const unreadable = report.unreadable.length > 0 ? ` Unreadable this run (not counted): ${report.unreadable.map((entry) => `${entry.setting} (${entry.reason})`).join(", ")}.` : "";
  return {
    sourceRef: `settings-drift:${repository}@${digest}`,
    kind: SETTINGS_DRIFT_KIND,
    objective: `Apply the repository settings contract to ${repository}: ${report.drifts.length} setting${report.drifts.length === 1 ? "" : "s"} drifted`,
    instructions: [
      `Fluent compared ${repository}'s live GitHub settings with the organization's repository settings contract (core ADR-0040${contractCommit ? `, snapshot ${contractCommit.slice(0, 7)}` : ""}) and found these differences:\n${lines.join("\n")}\n`,
      "This is a read-only finding. Fluent holds no admin credential and changes no setting; the operator applies the contract with core's `scripts/apply-repo-settings.sh <owner/repo>` (dry-run first), supplying the repository's required-check names.",
      "A worker completing this item verifies, read-only, that the settings now match — re-read the same GitHub endpoints and quote them — and completes with that evidence; if they still drift, block with what remains." + unreadable,
    ].join(" "),
    acceptanceCriteria: [
      "Every setting listed above reads back as its expected value on GitHub, quoted in the evidence.",
      "No setting was changed by a worker; the operator applied the contract.",
    ],
    allowedActions: DRIFT_ACTIONS,
    delegableActions: [],
    createdBy: "operator:settings-sweep",
  };
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
