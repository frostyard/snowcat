import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateCoreCatalog, type RepositorySettingsContract } from "../src/core/validator.ts";
import { driftDigest, readRepositorySettings, sweepRepositorySettings } from "../src/queue/repository-settings.ts";
import { QueueStore } from "../src/queue/store.ts";
import { enabledDeclaration, validCoreEntries } from "./helpers/core-fixtures.ts";

const clock = () => new Date("2026-08-18T22:00:00.000Z");
process.env.SNOWCAT_GITHUB_TOKEN = "test-token";
const REPO = "frostyard/updex";

const CONTRACT: RepositorySettingsContract = {
  schema_version: 1,
  contract: { id: "repository-settings", version: 1 },
  repository: {
    delete_branch_on_merge: true,
    allow_update_branch: true,
    allow_auto_merge: false,
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: true,
    merge_commit_title: "MERGE_MESSAGE",
    merge_commit_message: "PR_TITLE",
    squash_merge_commit_title: "PR_TITLE",
    squash_merge_commit_message: "COMMIT_MESSAGES",
    has_wiki: false,
    has_projects: false,
    has_issues: true,
    web_commit_signoff_required: false,
  },
  actions: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
  security: {
    vulnerability_alerts: true,
    dependabot_security_updates: true,
    secret_scanning: true,
    secret_scanning_push_protection: true,
    private_vulnerability_reporting: true,
  },
  default_branch_ruleset: {
    enforcement: "active",
    bypass_actors: "none",
    require_pull_request: true,
    required_approving_review_count: 0,
    require_conversation_resolution: true,
    require_status_checks: true,
    strict_required_status_checks: true,
    block_deletions: true,
    block_force_pushes: true,
    merge_queue: false,
    classic_branch_protection: "absent",
  },
  tag_ruleset: { pattern: "v*", enforcement: "active", block_deletions: true, block_force_pushes: true, restrict_creation: true },
  metadata: { license_required: true, description_required: true, topics_include: ["frostyard"] },
  labels: { required: ["snowcat"] },
};

/** A GitHub that matches the contract exactly; `overrides` patch individual routes (a function receives the default body). */
function conformantRoutes(overrides: Record<string, unknown | ((body: unknown) => unknown)> = {}): Record<string, { status: number; body?: unknown }> {
  const base = "/repos/frostyard/updex";
  const routes: Record<string, { status: number; body?: unknown }> = {
    [base]: {
      status: 200,
      body: {
        default_branch: "main",
        visibility: "public",
        has_discussions: false,
        description: "Install and update sysexts",
        license: { spdx_id: "MIT" },
        topics: ["frostyard", "sysext"],
        security_and_analysis: {
          secret_scanning: { status: "enabled" },
          secret_scanning_push_protection: { status: "enabled" },
          dependabot_security_updates: { status: "enabled" },
        },
        ...CONTRACT.repository,
      },
    },
    [`${base}/actions/permissions/workflow`]: { status: 200, body: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false } },
    [`${base}/vulnerability-alerts`]: { status: 204 },
    [`${base}/private-vulnerability-reporting`]: { status: 200, body: { enabled: true } },
    [`${base}/rulesets`]: { status: 200, body: [{ id: 1, enforcement: "active" }, { id: 2, enforcement: "active" }, { id: 3, enforcement: "disabled" }] },
    [`${base}/rulesets/1`]: {
      status: 200,
      body: {
        id: 1,
        target: "branch",
        enforcement: "active",
        bypass_actors: [],
        conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
        rules: [
          { type: "deletion" },
          { type: "non_fast_forward" },
          { type: "pull_request", parameters: { required_approving_review_count: 0, required_review_thread_resolution: true } },
          {
            type: "required_status_checks",
            parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "Unit Tests", integration_id: 15368 }] },
          },
        ],
      },
    },
    [`${base}/rulesets/2`]: {
      status: 200,
      body: {
        id: 2,
        target: "tag",
        enforcement: "active",
        bypass_actors: [],
        conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
        rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "creation" }],
      },
    },
    [`${base}/branches/main/protection`]: { status: 404 },
    [`${base}/labels`]: { status: 200, body: [{ name: "bug" }, { name: "snowcat" }] },
  };
  for (const [key, override] of Object.entries(overrides)) {
    const path = key.startsWith("/") ? key : `${base}${key === "" ? "" : `/${key}`}`;
    const current = routes[path];
    routes[path] = typeof override === "function" ? { status: 200, body: (override as (body: unknown) => unknown)(current?.body) } : (override as { status: number; body?: unknown });
  }
  return routes;
}

function apiFetcher(routes: Record<string, { status: number; body?: unknown }>) {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url.pathname);
    const answer = routes[url.pathname];
    if (!answer) return new Response("{}", { status: 404 });
    if (answer.body === undefined) return new Response(null, { status: answer.status });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, requests };
}

test("a conformant repository reads with zero drift; each contract section is diffed against the live setting", async () => {
  const clean = await readRepositorySettings(REPO, CONTRACT, apiFetcher(conformantRoutes()).fetcher);
  assert.deepEqual(clean.drifts, []);
  assert.deepEqual(clean.unreadable, []);
  assert.deepEqual(clean.observed, { visibility: "public", hasDiscussions: false, requiredChecks: ["Unit Tests"] });

  const drifted = await readRepositorySettings(
    REPO,
    CONTRACT,
    apiFetcher(
      conformantRoutes({
        "": (body: unknown) => ({ ...(body as object), delete_branch_on_merge: false, has_wiki: true, topics: [], license: null, security_and_analysis: { secret_scanning: { status: "disabled" } } }),
        "actions/permissions/workflow": { status: 200, body: { default_workflow_permissions: "write", can_approve_pull_request_reviews: true } },
        "vulnerability-alerts": { status: 404 },
        "private-vulnerability-reporting": { status: 200, body: { enabled: false } },
        rulesets: { status: 200, body: [] },
        "branches/main/protection": { status: 200, body: { required_status_checks: null } },
        labels: { status: 200, body: [{ name: "bug" }] },
      }),
    ).fetcher,
  );
  const settings = drifted.drifts.map((drift) => drift.setting).sort();
  assert.deepEqual(settings, [
    "actions.can_approve_pull_request_reviews",
    "actions.default_workflow_permissions",
    "default_branch_ruleset.classic_branch_protection",
    "default_branch_ruleset.enforcement",
    "labels.required.snowcat",
    "metadata.license_required",
    "metadata.topics_include.frostyard",
    "repository.delete_branch_on_merge",
    "repository.has_wiki",
    "security.dependabot_security_updates",
    "security.private_vulnerability_reporting",
    "security.secret_scanning",
    "security.secret_scanning_push_protection",
    "security.vulnerability_alerts",
    "tag_ruleset.enforcement",
  ]);
  assert.deepEqual(drifted.drifts.find((drift) => drift.setting === "default_branch_ruleset.classic_branch_protection"), { setting: "default_branch_ruleset.classic_branch_protection", expected: "absent", observed: "present" });

  // Ruleset present but weaker: individual rule drifts, and a bypass actor is a drift.
  const weak = await readRepositorySettings(
    REPO,
    CONTRACT,
    apiFetcher(
      conformantRoutes({
        "rulesets/1": (body: unknown) => ({
          ...(body as object),
          bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole" }],
          rules: [{ type: "pull_request", parameters: { required_approving_review_count: 1, required_review_thread_resolution: false } }],
        }),
      }),
    ).fetcher,
  );
  assert.deepEqual(weak.drifts.map((drift) => drift.setting).sort(), [
    "default_branch_ruleset.block_deletions",
    "default_branch_ruleset.block_force_pushes",
    "default_branch_ruleset.bypass_actors",
    "default_branch_ruleset.require_conversation_resolution",
    "default_branch_ruleset.require_status_checks",
    "default_branch_ruleset.required_approving_review_count",
  ]);

  // Admin-only fields missing from the read are unreadable, not drift; a private repository skips private vulnerability reporting.
  const limited = await readRepositorySettings(
    REPO,
    CONTRACT,
    apiFetcher(
      conformantRoutes({
        "": (body: unknown) => ({ ...(body as object), visibility: "private", security_and_analysis: undefined }),
        "actions/permissions/workflow": { status: 403 },
        "private-vulnerability-reporting": { status: 404 },
      }),
    ).fetcher,
  );
  assert.deepEqual(limited.drifts, []);
  assert.deepEqual(limited.unreadable.map((entry) => entry.setting), ["security.secret_scanning", "actions"]);
});

test("the sweep proposes one settings-drift per repository per drift set, dedupes it, and re-proposes when the drift changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-settings-sweep-test-"));
  const queue = new QueueStore(join(directory, "queue.db"), clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPO, true);

  const clean = await sweepRepositorySettings(queue, undefined, { fetcher: apiFetcher(conformantRoutes()).fetcher, clock, repository: REPO, contract: CONTRACT });
  assert.deepEqual(clean.conformant, [REPO]);
  assert.deepEqual(clean.proposed, []);

  const driftedRoutes = conformantRoutes({ "": (body: unknown) => ({ ...(body as object), delete_branch_on_merge: false }), labels: { status: 200, body: [] } });
  const first = await sweepRepositorySettings(queue, undefined, { fetcher: apiFetcher(driftedRoutes).fetcher, clock, repository: REPO, contract: CONTRACT });
  assert.equal(first.proposed.length, 1);
  assert.equal(first.proposed[0]!.driftCount, 2);
  const item = queue.get(first.proposed[0]!.id)!;
  assert.equal(item.status, "proposed");
  assert.equal(item.kind, "settings-drift");
  assert.deepEqual(item.allowedActions, ["read"]);
  assert.match(item.objective, /^Apply the repository settings contract to frostyard\/updex: 2 settings drifted$/);
  assert.match(item.instructions, /repository\.delete_branch_on_merge: expected true, observed false/);
  assert.match(item.instructions, /labels\.required\.snowcat: expected true, observed false/);
  assert.match(item.instructions, /apply-repo-settings\.sh/);
  assert.equal(item.sourceRef, `settings-drift:${REPO}@${driftDigest(first.reports[0]!.drifts)}`);

  const again = await sweepRepositorySettings(queue, undefined, { fetcher: apiFetcher(driftedRoutes).fetcher, clock, repository: REPO, contract: CONTRACT });
  assert.deepEqual(again.proposed, []);
  assert.match(again.skipped[0]!.reason, /already proposed/);

  // The operator fixed the label but not the branch setting: a different drift set, a new proposal; the old one is theirs to reject.
  const partly = conformantRoutes({ "": (body: unknown) => ({ ...(body as object), delete_branch_on_merge: false }) });
  const second = await sweepRepositorySettings(queue, undefined, { fetcher: apiFetcher(partly).fetcher, clock, repository: REPO, contract: CONTRACT });
  assert.equal(second.proposed.length, 1);
  assert.equal(second.proposed[0]!.driftCount, 1);
  assert.notEqual(second.proposed[0]!.id, first.proposed[0]!.id);

  // A GitHub failure is reported per repository; an unknown repository is refused; no control plane means no enrolled sweep.
  const down = await sweepRepositorySettings(queue, undefined, { fetcher: apiFetcher({}).fetcher, clock, repository: REPO, contract: CONTRACT });
  assert.equal(down.failed.length, 1);
  await assert.rejects(sweepRepositorySettings(queue, undefined, { fetcher: apiFetcher({}).fetcher, clock, repository: "frostyard/nope", contract: CONTRACT }), /not opted in/);
  await assert.rejects(sweepRepositorySettings(queue, undefined, { fetcher: apiFetcher({}).fetcher, clock, contract: CONTRACT }), /SNOWCAT_CONTROL_DB/);
});

test("the validator accepts a core tree with the settings schema and contract, exposes the contract, and refuses a contract without its schema", async () => {
  const entries = await validCoreEntries(enabledDeclaration(), true);
  const schemaBytes = readFileSync(new URL("../src/core/schemas/v1/repository-settings.schema.json", import.meta.url));
  const contractBytes = Buffer.from(JSON.stringify(CONTRACT, null, 2) + "\n");
  const invalid = Buffer.from(JSON.stringify({ ...CONTRACT, default_branch_ruleset: { ...CONTRACT.default_branch_ruleset, bypass_actors: "admins" } }, null, 2));
  const withSettings = [
    ...entries,
    entry("organization/schemas/v1/repository-settings.schema.json", schemaBytes),
    entry("organization/contracts/repository-settings/v1.json", contractBytes),
    entry("organization/fixtures/v1/valid/repository-settings.json", contractBytes),
    entry("organization/fixtures/v1/invalid/repository-settings-bypass-actors.json", invalid),
  ];
  const validated = validateCoreCatalog(withSettings);
  assert.deepEqual(JSON.parse(JSON.stringify(validated.repositorySettings?.labels)), { required: ["snowcat"] });
  assert.match(validated.schemaDigests.settings!, /^sha256:/);
  assert.equal(validateCoreCatalog(entries).repositorySettings, undefined, "a core tree without the contract is still accepted");
  assert.throws(() => validateCoreCatalog([...entries, entry("organization/contracts/repository-settings/v1.json", contractBytes)]), /requires organization\/schemas\/v1\/repository-settings\.schema\.json/);
  assert.throws(() => validateCoreCatalog([...entries, entry("organization/schemas/v1/repository-settings.schema.json", schemaBytes)]), /contract is missing/);
  const relaxed = Buffer.from(JSON.stringify({ ...CONTRACT, default_branch_ruleset: { ...CONTRACT.default_branch_ruleset, require_pull_request: false } }));
  assert.throws(() => validateCoreCatalog([...withSettings.slice(0, -2), entry("organization/contracts/repository-settings/v1.json", relaxed)].filter((candidate, index, all) => all.findIndex((other) => other.path === candidate.path) === index)), /need require_pull_request|fixtures/);
});

test("a snapshot definition may record the settings schema digest alongside any historical schema set", async () => {
  const { recordKindRegistry } = await import("../src/control/registry.ts");
  const validate = recordKindRegistry["core.snapshot-definition"].validatePayload;
  const digest = `sha256:${"a".repeat(64)}`;
  const base = {
    snapshotId: "01990000-0000-7000-8000-000000000000",
    sourceRepositoryId: "github.com:1331309458",
    sourceUrl: "https://github.com/frostyard/core.git",
    sourceRef: "refs/heads/main",
    sourceCommitId: "b".repeat(40),
    sourceTreeId: "c".repeat(40),
    catalogDigest: digest,
    fileCount: 40,
    totalBytes: 1,
    repositoryCount: 5,
    verificationProfileCount: 0,
    validFixtureCount: 7,
    invalidFixtureCount: 18,
    importedAt: "2026-08-18T22:00:00.000Z",
  };
  const shapes = [
    { repository: digest, surfaces: digest, governance: digest },
    { repository: digest, surfaces: digest, governance: digest, verificationProfile: digest },
  ];
  for (const schemaDigests of shapes) {
    assert.equal(validate({ ...base, schemaDigests }), true);
    assert.equal(validate({ ...base, schemaDigests: { ...schemaDigests, settings: digest } }), true);
  }
  assert.equal(validate({ ...base, schemaDigests: { repository: digest, surfaces: digest, governance: digest, settings: digest, verificationProfile: digest, envelope: digest, goal: digest }, goalCount: 0 }), true);
  assert.equal(validate({ ...base, schemaDigests: { repository: digest, surfaces: digest, governance: digest, other: digest } }), false);
});

function entry(path: string, bytes: Uint8Array) {
  return { path, mode: "100644" as const, objectId: "0".repeat(40), bytes };
}
