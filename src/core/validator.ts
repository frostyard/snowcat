import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { getNodeValue, parseTree, printParseErrorCode, type Node as JsonNode } from "jsonc-parser";

import { canonicalJson, sha256, type JsonValue } from "../control/encoding.ts";
import type { RepositoryMaintenanceProgram } from "../control/registry.ts";
import {
  supportsVerificationAttestationPolicy,
  supportsVerificationEvaluator,
  supportsVerificationSourceAdapter,
} from "../verification/registry.ts";

const SCHEMA_PATHS = {
  envelope: "organization/schemas/v1/envelope.schema.json",
  repository: "organization/schemas/v1/repository.schema.json",
  surfaces: "organization/schemas/v1/repository-surfaces.schema.json",
  governance: "organization/schemas/v1/repository-agent-governance.schema.json",
  verificationProfile: "organization/schemas/v1/verification-profile.schema.json",
  goal: "organization/schemas/v1/goal.schema.json",
  settings: "organization/schemas/v1/repository-settings.schema.json",
} as const;
const BUNDLED_SCHEMA_URLS = {
  envelope: new URL("./schemas/v1/envelope.schema.json", import.meta.url),
  repository: new URL("./schemas/v1/repository.schema.json", import.meta.url),
  surfaces: new URL("./schemas/v1/repository-surfaces.schema.json", import.meta.url),
  governance: new URL("./schemas/v1/repository-agent-governance.schema.json", import.meta.url),
  verificationProfile: new URL("./schemas/v1/verification-profile.schema.json", import.meta.url),
  goal: new URL("./schemas/v1/goal.schema.json", import.meta.url),
  settings: new URL("./schemas/v1/repository-settings.schema.json", import.meta.url),
} as const;
const EXPECTED_SCHEMA_DIGESTS = {
  envelope: "sha256:07eb4ca0d97de3668e3d71227c675562f69c451647ab5e6fa33e6fe9de80eb5f",
  repository: "sha256:fb0c88c5e978f33576cb6c1f6c13b08805005d7925326924e28291ca0ddbf58f",
  surfaces: "sha256:b6742c283148d9a75f56d7fc8482d9309955ca5bab669170ac0cade92829670d",
  governance: "sha256:254e131a94c5477e861b0ec792defa1fd05ddebe380fc4e062d03cefc3ab8ebe",
  verificationProfile: "sha256:5562df1740d133ff32a7bcfc488907b3783a3eda9ba8e8e1d9559a07f44a4507",
  goal: "sha256:76341409e4dc33fbc50d1432d2488e1ecec767263733939f0abe9bf173aada0b",
  settings: "sha256:d1b7964d78607ee18fdb1de6c311f04a8dce704f46a5872110a7357ab05cbf2f",
} as const;
/**
 * Earlier revisions of a v1 schema that Snowcat reviewed and bundled before a
 * compatible widening (core ADR-0039). A candidate or retained snapshot whose
 * schema bytes match one of these is validated with exactly that revision, so
 * snapshots accepted under the old bytes stay valid, rollback to them works,
 * and a core revision that has not yet merged the widening is still accepted.
 * Bytes that match no bundled revision are still refused. Order: newest first.
 */
const SUPERSEDED_SCHEMA_REVISIONS: Partial<Record<SchemaKind, ReadonlyArray<{ digest: string; url: URL }>>> = {
  repository: [
    {
      digest: "sha256:2419d096faac298b8c4a75a3a83b617f4797e4e5f190ccd918ead73ba604bead",
      url: new URL("./schemas/v1/superseded/repository.schema.2419d096.json", import.meta.url),
    },
  ],
  // Core ADR-0042 widened `default_branch_ruleset.merge_queue` from `const false`
  // to a boolean; the revision before it is still accepted.
  settings: [
    {
      digest: "sha256:a0008dbdd77d11e604ddee20a12218d1c692748fe80d037d589d2acd051871e1",
      url: new URL("./schemas/v1/superseded/repository-settings.schema.a0008dbd.json", import.meta.url),
    },
  ],
};
const SURFACE_CONTRACT_PATH = "organization/contracts/repository-surfaces/v1.json";
/** Optional in a candidate (core ADR-0040): present iff its schema is; older core trees carry neither. */
const SETTINGS_CONTRACT_PATH = "organization/contracts/repository-settings/v1.json";
const STATIC_PATHS = new Set([
  "organization/README.md",
  SCHEMA_PATHS.repository,
  SCHEMA_PATHS.surfaces,
  SCHEMA_PATHS.governance,
  SURFACE_CONTRACT_PATH,
]);
const REPOSITORY_PATH = /^organization\/repositories\/([^/]+)\/([^/]+)\.json$/;
const VERIFICATION_PROFILE_PATH =
  /^organization\/contracts\/verification-profiles\/([a-z0-9]+(?:-[a-z0-9]+)*)\/v([1-9][0-9]*)\.json$/;
const GOAL_PATH = /^organization\/goals\/([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/;
const FIXTURE_PATH =
  /^organization\/fixtures\/v1\/(valid|invalid)\/(repository-agent-governance|repository-surfaces|repository-settings|repository|verification-profile|goal)(?:-[a-z0-9-]+)?\.json$/;
const MAX_VERIFICATION_PROFILE_BYTES = 65_536;
const MAX_GOAL_BYTES = 65_536;
type SchemaKind = keyof typeof SCHEMA_PATHS;
type FixtureKind = Exclude<SchemaKind, "envelope">;
type OptionalSchemaKind = "verificationProfile" | "envelope" | "goal" | "settings";
type RequiredSchemaKind = Exclude<SchemaKind, OptionalSchemaKind>;
type ParsedSchemas = Record<RequiredSchemaKind, unknown> & Partial<Record<OptionalSchemaKind, unknown>>;
type SchemaDigests = Record<RequiredSchemaKind, string> & Partial<Record<OptionalSchemaKind, string>>;
type Validators = Record<RequiredSchemaKind, ValidateFunction> &
  Partial<Record<OptionalSchemaKind, ValidateFunction>>;

export interface CoreTreeEntry {
  path: string;
  mode: "100644" | "100755";
  objectId: string;
  bytes: Uint8Array;
}

export interface AccountableOwner {
  kind: "github-user" | "github-team";
  login?: string;
  slug?: string;
}

export interface RepositoryDeclaration {
  schema_version: 1;
  repository: {
    owner: string;
    name: string;
    repository_id: string;
  };
  accountable_owners: AccountableOwner[];
  fleet_state: "enabled" | "paused" | "disabled";
  maintenance_programs: RepositoryMaintenanceProgram[];
  action_ceiling: Array<"read" | "write" | "run-tests" | "open-issue" | "open-pr" | "create-followup">;
  surface_contract_version: 1;
}

export interface ValidatedRepositoryDeclaration {
  path: string;
  contentDigest: string;
  declaration: RepositoryDeclaration;
}

export interface RepositorySurfaceDefinition {
  id: "agent-instructions" | "agent-governance" | "agent-skills" | "documentation-index";
  path: string;
  artifact_type: "file" | "directory";
  media_type?: "text/markdown" | "application/json";
  schema_path?: string;
}

export interface RepositorySurfaceContract {
  schema_version: 1;
  contract: { id: "repository-surfaces"; version: 1 };
  surfaces: RepositorySurfaceDefinition[];
}

export interface VerificationProfile {
  schema_version: 1;
  profile: { id: string; version: number };
  description: string;
  evidence_mode: "deterministic" | "observational" | "human-attested";
  mechanism:
    | { kind: "deterministic-evaluator"; evaluator: { id: string; version: number } }
    | {
        kind: "observational-evaluator";
        source_adapter: { id: string; version: number };
        evaluator: { id: string; version: number };
      }
    | { kind: "attestation-policy"; attestation_policy: { id: string; version: number } };
  parameter_schema: Record<string, JsonValue>;
}

export interface ValidatedVerificationProfile {
  path: string;
  contentDigest: string;
  profile: VerificationProfile;
}

export type GoalStatus = "planned" | "active" | "paused" | "completed" | "cancelled";

export interface OrganizationGoal {
  schema_version: 1;
  kind: "goal";
  metadata: {
    id: string;
    status: GoalStatus;
    owners: Array<
      | { kind: "github-user"; id: string; login: string }
      | { kind: "github-team"; id: string; slug: string }
    >;
    applies_to:
      | { repository_selection: "all-enrolled" }
      | { repository_selection: "selected"; repository_ids: string[] };
  };
  spec: {
    starts_on: string;
    ends_on: string;
    priority: "high" | "normal" | "low";
    outcome: string;
    success_measures: Array<{
      id: string;
      required: boolean;
      evidence_mode: "deterministic" | "observational" | "human-attested";
      subject: { kind: "github-repository"; id: string };
      observation_window: { starts_at: string; ends_at: string };
      verification_profile: { id: string; version: number };
      parameters: Record<string, JsonValue>;
    }>;
    encouraged_work: string[];
    excluded_work: string[];
  };
}

export interface ValidatedOrganizationGoal {
  path: string;
  contentDigest: string;
  goal: OrganizationGoal;
}

export interface ValidatedCoreCatalog {
  catalogDigest: string;
  fileCount: number;
  totalBytes: number;
  schemaDigests: SchemaDigests;
  repositoryCount: number;
  verificationProfileCount: number;
  goalCount: number;
  validFixtureCount: number;
  invalidFixtureCount: number;
  repositories: ValidatedRepositoryDeclaration[];
  verificationProfiles: ValidatedVerificationProfile[];
  goals: ValidatedOrganizationGoal[];
  /** The repository settings contract (core ADR-0040) when the candidate carries one. */
  repositorySettings?: RepositorySettingsContract;
}

/** `organization/contracts/repository-settings/v1.json`: the GitHub settings every enrolled repository must match. */
export interface RepositorySettingsContract {
  schema_version: 1;
  contract: { id: "repository-settings"; version: 1 };
  repository: {
    delete_branch_on_merge: boolean;
    allow_update_branch: boolean;
    allow_auto_merge: boolean;
    allow_merge_commit: boolean;
    allow_squash_merge: boolean;
    allow_rebase_merge: boolean;
    merge_commit_title: "PR_TITLE" | "MERGE_MESSAGE";
    merge_commit_message: "PR_TITLE" | "PR_BODY" | "BLANK";
    squash_merge_commit_title: "PR_TITLE" | "COMMIT_OR_PR_TITLE";
    squash_merge_commit_message: "PR_BODY" | "COMMIT_MESSAGES" | "BLANK";
    has_wiki: boolean;
    has_projects: boolean;
    has_issues: boolean;
    web_commit_signoff_required: boolean;
  };
  actions: { default_workflow_permissions: "read" | "write"; can_approve_pull_request_reviews: boolean };
  security: {
    vulnerability_alerts: boolean;
    dependabot_security_updates: boolean;
    secret_scanning: boolean;
    secret_scanning_push_protection: boolean;
    private_vulnerability_reporting: boolean;
  };
  default_branch_ruleset: {
    enforcement: "active";
    bypass_actors: "none";
    require_pull_request: boolean;
    required_approving_review_count: number;
    require_conversation_resolution: boolean;
    require_status_checks: boolean;
    strict_required_status_checks: boolean;
    block_deletions: boolean;
    block_force_pushes: boolean;
    /** Core ADR-0042: `true` requires the `merge_queue` rule on the default-branch ruleset; older contracts say `false`. */
    merge_queue: boolean;
    classic_branch_protection: "absent";
  };
  tag_ruleset: { pattern: string; enforcement: "active"; block_deletions: boolean; block_force_pushes: boolean; restrict_creation: boolean };
  metadata: { license_required: boolean; description_required: boolean; topics_include: string[] };
  labels: { required: string[] };
}

export class CoreValidationError extends Error {
  constructor(
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = "CoreValidationError";
  }
}

export function validateCoreCatalog(inputEntries: readonly CoreTreeEntry[]): ValidatedCoreCatalog {
  const entries = [...inputEntries].sort((left, right) => left.path.localeCompare(right.path));
  const byPath = new Map<string, CoreTreeEntry>();
  for (const entry of entries) {
    if (byPath.has(entry.path)) throw new CoreValidationError(`${entry.path}: duplicate Git tree path`);
    if (!isRecognizedPath(entry.path)) {
      throw new CoreValidationError(`${entry.path}: unrecognized organization authority path`);
    }
    byPath.set(entry.path, entry);
  }
  for (const requiredPath of STATIC_PATHS) {
    if (!byPath.has(requiredPath)) throw new CoreValidationError(`${requiredPath}: required authority file is missing`);
  }

  const schemas = loadBundledSchemas(byPath);
  const validators = createValidators(schemas.parsed);
  const availablePaths = new Set(byPath.keys());
  const repositories: ValidatedRepositoryDeclaration[] = [];
  const repositoryIds = new Map<string, string>();

  for (const entry of entries.filter((item) => REPOSITORY_PATH.test(item.path))) {
    const data = validateOne(entry, validators.repository) as RepositoryDeclaration;
    assertRepositoryInvariants(data, entry.path);
    const priorPath = repositoryIds.get(data.repository.repository_id);
    if (priorPath) {
      throw new CoreValidationError(
        `${entry.path}: repository ID ${data.repository.repository_id} is already declared by ${priorPath}`,
      );
    }
    repositoryIds.set(data.repository.repository_id, entry.path);
    repositories.push({ path: entry.path, contentDigest: digestBytes(entry.bytes), declaration: data });
  }

  const surfaceEntry = byPath.get(SURFACE_CONTRACT_PATH)!;
  const surfaces = validateOne(surfaceEntry, validators.surfaces);
  assertSurfaceInvariants(surfaces, surfaceEntry.path, availablePaths);

  let repositorySettings: RepositorySettingsContract | undefined;
  const settingsEntry = byPath.get(SETTINGS_CONTRACT_PATH);
  if (settingsEntry) repositorySettings = validateRepositorySettings(settingsEntry, validators.settings);
  else if (validators.settings) {
    throw new CoreValidationError(`${SETTINGS_CONTRACT_PATH}: repository settings schema is present but the contract is missing`);
  }

  const verificationProfiles: ValidatedVerificationProfile[] = [];
  const verificationProfileIds = new Map<string, VerificationProfile>();
  for (const entry of entries.filter((item) => VERIFICATION_PROFILE_PATH.test(item.path))) {
    const profile = validateVerificationProfile(entry, validators.verificationProfile);
    const key = `${profile.profile.id}:v${profile.profile.version}`;
    if (verificationProfileIds.has(key)) {
      throw new CoreValidationError(`${entry.path}: duplicate verification profile ${key}`);
    }
    verificationProfileIds.set(key, profile);
    verificationProfiles.push({
      path: entry.path,
      contentDigest: digestBytes(entry.bytes),
      profile,
    });
  }

  const canonicalRepositoryIds = new Set(
    [...repositoryIds.keys()].map((repositoryId) => `github.com:${repositoryId}`),
  );
  const goals: ValidatedOrganizationGoal[] = [];
  const goalIds = new Set<string>();
  for (const entry of entries.filter((item) => GOAL_PATH.test(item.path))) {
    const goal = validateGoal(
      entry,
      validators.goal,
      canonicalRepositoryIds,
      verificationProfileIds,
    );
    if (goalIds.has(goal.metadata.id)) {
      throw new CoreValidationError(`${entry.path}: duplicate Goal ${goal.metadata.id}`);
    }
    goalIds.add(goal.metadata.id);
    goals.push({ path: entry.path, contentDigest: digestBytes(entry.bytes), goal });
  }

  const validFixtureEntries = entries.filter(
    (entry) => FIXTURE_PATH.exec(entry.path)?.[1] === "valid",
  );
  const fixtureRepositoryIds = new Set<string>();
  for (const entry of validFixtureEntries) {
    if (fixtureContract(entry.path).kind !== "repository") continue;
    const repository = validateOne(entry, validators.repository) as RepositoryDeclaration;
    assertRepositoryInvariants(repository, entry.path);
    fixtureRepositoryIds.add(`github.com:${repository.repository.repository_id}`);
  }
  const fixtureVerificationProfiles = new Map<string, VerificationProfile>();
  for (const entry of validFixtureEntries) {
    if (fixtureContract(entry.path).kind !== "verificationProfile") continue;
    const profile = validateVerificationProfile(entry, validators.verificationProfile);
    fixtureVerificationProfiles.set(`${profile.profile.id}:v${profile.profile.version}`, profile);
  }

  let validFixtureCount = 0;
  let invalidFixtureCount = 0;
  let validVerificationProfileFixtureCount = 0;
  let invalidVerificationProfileFixtureCount = 0;
  let validSettingsFixtureCount = 0;
  let invalidSettingsFixtureCount = 0;
  let validGoalFixtureCount = 0;
  let invalidGoalFixtureCount = 0;
  for (const entry of entries.filter((item) => FIXTURE_PATH.test(item.path))) {
    const fixture = fixtureContract(entry.path);
    if (fixture.expectation === "valid") {
      validateFixture(
        entry,
        fixture.kind,
        validators,
        availablePaths,
        fixtureRepositoryIds,
        fixtureVerificationProfiles,
      );
      validFixtureCount += 1;
      if (fixture.kind === "verificationProfile") validVerificationProfileFixtureCount += 1;
      if (fixture.kind === "settings") validSettingsFixtureCount += 1;
      if (fixture.kind === "goal") validGoalFixtureCount += 1;
      continue;
    }
    try {
      validateFixture(
        entry,
        fixture.kind,
        validators,
        availablePaths,
        fixtureRepositoryIds,
        fixtureVerificationProfiles,
      );
    } catch (error) {
      if (!(error instanceof CoreValidationError)) throw error;
      invalidFixtureCount += 1;
      if (fixture.kind === "verificationProfile") invalidVerificationProfileFixtureCount += 1;
      if (fixture.kind === "settings") invalidSettingsFixtureCount += 1;
      if (fixture.kind === "goal") invalidGoalFixtureCount += 1;
      continue;
    }
    throw new CoreValidationError(`${entry.path}: invalid fixture was unexpectedly accepted`);
  }
  if (validFixtureCount === 0 || invalidFixtureCount === 0) {
    throw new CoreValidationError("organization fixture corpus must contain valid and invalid examples");
  }
  if (
    validators.verificationProfile &&
    (validVerificationProfileFixtureCount === 0 || invalidVerificationProfileFixtureCount === 0)
  ) {
    throw new CoreValidationError(
      "verification profile support requires valid and invalid conformance fixtures",
    );
  }
  if (validators.goal && (validGoalFixtureCount === 0 || invalidGoalFixtureCount === 0)) {
    throw new CoreValidationError("Goal support requires valid and invalid conformance fixtures");
  }
  if (validators.settings && (validSettingsFixtureCount === 0 || invalidSettingsFixtureCount === 0)) {
    throw new CoreValidationError("repository settings support requires valid and invalid conformance fixtures");
  }

  const catalogMaterial = entries.map((entry) => ({
    contentDigest: digestBytes(entry.bytes),
    mode: entry.mode,
    objectId: entry.objectId,
    path: entry.path,
    size: entry.bytes.byteLength,
  })) satisfies JsonValue;

  return {
    catalogDigest: sha256(canonicalJson(catalogMaterial)),
    fileCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.bytes.byteLength, 0),
    schemaDigests: schemas.digests,
    repositoryCount: repositories.length,
    verificationProfileCount: verificationProfiles.length,
    goalCount: goals.length,
    validFixtureCount,
    invalidFixtureCount,
    repositories,
    verificationProfiles,
    goals,
    ...(repositorySettings ? { repositorySettings } : {}),
  };
}

export function assertRepositoryDeclarationRetention(
  active: Pick<ValidatedCoreCatalog, "repositories">,
  candidate: Pick<ValidatedCoreCatalog, "repositories">,
): void {
  const candidateIds = new Set(
    candidate.repositories.map((repository) => repository.declaration.repository.repository_id),
  );
  const removed = active.repositories
    .filter((repository) => !candidateIds.has(repository.declaration.repository.repository_id))
    .map(
      (repository) =>
        `${repository.path} (${repository.declaration.repository.repository_id})`,
    )
    .sort();
  if (removed.length > 0) {
    throw new CoreValidationError(
      "repository declarations must be retained and changed to disabled rather than removed",
      removed.map((repository) => `removed ${repository}`),
    );
  }
}

export function assertVerificationProfileRetention(
  active: Pick<ValidatedCoreCatalog, "schemaDigests" | "verificationProfiles">,
  candidate: Pick<ValidatedCoreCatalog, "schemaDigests" | "verificationProfiles">,
): void {
  if (active.schemaDigests.verificationProfile && !candidate.schemaDigests.verificationProfile) {
    throw new CoreValidationError(
      "verification profile schema must be retained after automatic activation",
    );
  }
  const candidateProfiles = new Map(
    candidate.verificationProfiles.map((profile) => [
      `${profile.profile.profile.id}:v${profile.profile.profile.version}`,
      profile,
    ]),
  );
  const changed = active.verificationProfiles.flatMap((profile) => {
    const key = `${profile.profile.profile.id}:v${profile.profile.profile.version}`;
    const next = candidateProfiles.get(key);
    if (!next) return [`removed ${profile.path}`];
    if (next.contentDigest !== profile.contentDigest) return [`changed ${profile.path}`];
    return [];
  });
  if (changed.length > 0) {
    throw new CoreValidationError("verification profile versions are immutable and retained", changed);
  }
}

const GOAL_TRANSITIONS: Readonly<Record<GoalStatus, readonly GoalStatus[]>> = {
  planned: ["planned", "active", "paused", "cancelled"],
  active: ["active", "paused", "completed", "cancelled"],
  paused: ["paused", "active", "completed", "cancelled"],
  completed: ["completed"],
  cancelled: ["cancelled"],
};

export function assertGoalRetention(
  active: Pick<ValidatedCoreCatalog, "schemaDigests" | "goals">,
  candidate: Pick<ValidatedCoreCatalog, "schemaDigests" | "goals">,
): void {
  if (active.schemaDigests.goal && (!candidate.schemaDigests.envelope || !candidate.schemaDigests.goal)) {
    throw new CoreValidationError("Goal schemas must be retained after automatic activation");
  }
  const candidateGoals = new Map(candidate.goals.map((goal) => [goal.goal.metadata.id, goal]));
  const violations: string[] = [];
  for (const goal of active.goals) {
    const next = candidateGoals.get(goal.goal.metadata.id);
    if (!next) {
      violations.push(`removed ${goal.path}`);
      continue;
    }
    const previousStatus = goal.goal.metadata.status;
    const nextStatus = next.goal.metadata.status;
    if (!GOAL_TRANSITIONS[previousStatus].includes(nextStatus)) {
      violations.push(
        `${goal.goal.metadata.id}: ${previousStatus} cannot transition to ${nextStatus}`,
      );
    }
  }
  if (violations.length > 0) {
    throw new CoreValidationError("Goals must be retained with valid lifecycle transitions", violations);
  }
}

export function validatedRepositorySurfaceContract(
  inputEntries: readonly CoreTreeEntry[],
  version: number,
): { contract: RepositorySurfaceContract; governanceSchemaDigest: string } {
  if (version !== 1) throw new CoreValidationError(`unsupported repository surface contract version: ${version}`);
  const byPath = new Map(inputEntries.map((entry) => [entry.path, entry]));
  const entry = byPath.get(SURFACE_CONTRACT_PATH);
  if (!entry) throw new CoreValidationError(`${SURFACE_CONTRACT_PATH}: required authority file is missing`);
  const schemas = loadBundledSchemas(byPath);
  const validators = createValidators(schemas.parsed);
  const contract = validateOne(entry, validators.surfaces) as RepositorySurfaceContract;
  assertSurfaceInvariants(contract, entry.path, new Set(byPath.keys()));
  return {
    contract: structuredClone(contract),
    governanceSchemaDigest: schemas.digests.governance,
  };
}

export function validateRepositoryGovernanceBytes(bytes: Uint8Array): JsonValue {
  const schema = readStrictJson(
    readFileSync(BUNDLED_SCHEMA_URLS.governance),
    "bundled:repository-agent-governance.schema.json",
  );
  const validator = new Ajv2020({ allErrors: true, strict: true }).compile(schema as object);
  const entry: CoreTreeEntry = {
    path: "policies/agent-governance.json",
    mode: "100644",
    objectId: "0".repeat(40),
    bytes,
  };
  const governance = validateOne(entry, validator);
  assertGovernanceInvariants(governance, entry.path);
  return governance as JsonValue;
}

function loadBundledSchemas(entries: Map<string, CoreTreeEntry>): {
  parsed: ParsedSchemas;
  digests: SchemaDigests;
} {
  const parsed = {} as ParsedSchemas;
  const digests = {} as SchemaDigests;
  for (const kind of Object.keys(SCHEMA_PATHS) as SchemaKind[]) {
    const bundledBytes = readFileSync(BUNDLED_SCHEMA_URLS[kind]);
    const fetched = entries.get(SCHEMA_PATHS[kind]);
    if (!fetched && (["verificationProfile", "envelope", "goal", "settings"] satisfies OptionalSchemaKind[]).includes(kind as OptionalSchemaKind)) {
      continue;
    }
    if (!fetched) {
      throw new CoreValidationError(`${SCHEMA_PATHS[kind]}: required authority file is missing`);
    }
    const fetchedDigest = digestBytes(fetched.bytes);
    const expectedDigest = EXPECTED_SCHEMA_DIGESTS[kind];
    let matchedDigest: string = expectedDigest;
    let matchedBytes = bundledBytes;
    if (fetchedDigest !== expectedDigest) {
      const superseded = (SUPERSEDED_SCHEMA_REVISIONS[kind] ?? []).find((revision) => revision.digest === fetchedDigest);
      if (!superseded) {
        throw new CoreValidationError(
          `${fetched.path}: schema bytes do not match Snowcat's bundled v1 contract`,
          [`expected ${expectedDigest}`, `received ${fetchedDigest}`],
        );
      }
      matchedDigest = superseded.digest;
      matchedBytes = readFileSync(superseded.url);
    }
    const bundledSchema = readStrictJson(matchedBytes, `bundled:${fetched.path}`);
    const fetchedSchema = readStrictJson(fetched.bytes, fetched.path);
    if (canonicalJson(bundledSchema as JsonValue) !== canonicalJson(fetchedSchema as JsonValue)) {
      throw new CoreValidationError(`${fetched.path}: bundled validator schema does not match fetched schema semantics`);
    }
    parsed[kind] = bundledSchema;
    digests[kind] = matchedDigest;
  }
  const hasEnvelope = parsed.envelope !== undefined;
  const hasGoal = parsed.goal !== undefined;
  if (hasEnvelope !== hasGoal) {
    throw new CoreValidationError("organization Goal support requires both envelope and Goal schemas");
  }
  if (hasGoal && parsed.verificationProfile === undefined) {
    throw new CoreValidationError("organization Goal support requires the verification profile schema");
  }
  return { parsed, digests };
}

function createValidators(schemas: ParsedSchemas): Validators {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  if (schemas.envelope) ajv.addSchema(schemas.envelope as object);
  const validators: Validators = {
    repository: ajv.compile(schemas.repository as object),
    surfaces: ajv.compile(schemas.surfaces as object),
    governance: ajv.compile(schemas.governance as object),
  };
  if (schemas.verificationProfile) {
    validators.verificationProfile = ajv.compile(schemas.verificationProfile as object);
  }
  if (schemas.goal) validators.goal = ajv.compile(schemas.goal as object);
  if (schemas.settings) validators.settings = ajv.compile(schemas.settings as object);
  return validators;
}

function validateFixture(
  entry: CoreTreeEntry,
  kind: FixtureKind,
  validators: Validators,
  availablePaths: Set<string>,
  repositoryIds: Set<string>,
  verificationProfiles: Map<string, VerificationProfile>,
): void {
  if (kind === "verificationProfile") {
    validateVerificationProfile(entry, validators.verificationProfile);
    return;
  }
  if (kind === "goal") {
    validateGoal(entry, validators.goal, repositoryIds, verificationProfiles, false);
    return;
  }
  if (kind === "settings") {
    validateRepositorySettings(entry, validators.settings);
    return;
  }
  const data = validateOne(entry, validators[kind]);
  if (kind === "repository") assertRepositoryInvariants(data as RepositoryDeclaration, entry.path);
  else if (kind === "surfaces") assertSurfaceInvariants(data, entry.path, availablePaths);
  else assertGovernanceInvariants(data, entry.path);
}

function validateRepositorySettings(entry: CoreTreeEntry, validator: ValidateFunction | undefined): RepositorySettingsContract {
  if (!validator) {
    throw new CoreValidationError(`${entry.path}: repository settings contract requires ${SCHEMA_PATHS.settings}`);
  }
  const data = validateOne(entry, validator) as RepositorySettingsContract;
  // Same invariants as core: required checks imply a required pull request; a tag ruleset must protect something.
  if (data.default_branch_ruleset.require_status_checks && !data.default_branch_ruleset.require_pull_request) {
    throw new CoreValidationError(`${entry.path}: required status checks need require_pull_request`);
  }
  if (!data.tag_ruleset.block_deletions && !data.tag_ruleset.restrict_creation) {
    throw new CoreValidationError(`${entry.path}: tag ruleset must block deletion or restrict creation`);
  }
  return data;
}

function validateVerificationProfile(
  entry: CoreTreeEntry,
  validator: ValidateFunction | undefined,
): VerificationProfile {
  if (!validator) {
    throw new CoreValidationError(
      `${entry.path}: verification profile contract requires ${SCHEMA_PATHS.verificationProfile}`,
    );
  }
  if (entry.bytes.byteLength > MAX_VERIFICATION_PROFILE_BYTES) {
    throw new CoreValidationError(
      `${entry.path}: verification profile exceeds ${MAX_VERIFICATION_PROFILE_BYTES} bytes`,
    );
  }
  const data = validateOne(entry, validator) as VerificationProfile;
  assertVerificationProfileInvariants(data, entry.path);
  return data;
}

function validateGoal(
  entry: CoreTreeEntry,
  validator: ValidateFunction | undefined,
  repositoryIds: Set<string>,
  verificationProfiles: Map<string, VerificationProfile>,
  requireExecutable = true,
): OrganizationGoal {
  if (!validator) {
    throw new CoreValidationError(`${entry.path}: Goal contract requires ${SCHEMA_PATHS.goal}`);
  }
  if (entry.bytes.byteLength > MAX_GOAL_BYTES) {
    throw new CoreValidationError(`${entry.path}: Goal exceeds ${MAX_GOAL_BYTES} bytes`);
  }
  const goal = validateOne(entry, validator) as OrganizationGoal;
  assertGoalInvariants(goal, entry.path, repositoryIds, verificationProfiles, requireExecutable);
  return goal;
}

function assertGoalInvariants(
  goal: OrganizationGoal,
  path: string,
  repositoryIds: Set<string>,
  verificationProfiles: Map<string, VerificationProfile>,
  requireExecutable: boolean,
): void {
  const pathMatch = GOAL_PATH.exec(path);
  if (pathMatch && goal.metadata.id !== pathMatch[1]) {
    throw new CoreValidationError(`${path}: Goal identity does not match its path`);
  }
  const owners = new Set<string>();
  for (const owner of goal.metadata.owners) {
    if (owners.has(owner.id)) throw new CoreValidationError(`${path}: duplicate Goal owner ${owner.id}`);
    owners.add(owner.id);
  }
  if (goal.metadata.applies_to.repository_selection === "selected") {
    for (const repositoryId of goal.metadata.applies_to.repository_ids) {
      if (!repositoryIds.has(repositoryId)) {
        throw new CoreValidationError(`${path}: applicable repository is not declared: ${repositoryId}`);
      }
    }
  }
  assertRealUtcDate(goal.spec.starts_on, `${path}: spec.starts_on`);
  assertRealUtcDate(goal.spec.ends_on, `${path}: spec.ends_on`);
  if (goal.spec.starts_on > goal.spec.ends_on) {
    throw new CoreValidationError(`${path}: Goal start date is after its end date`);
  }
  const measureIds = new Set<string>();
  let requiredMeasureCount = 0;
  for (const measure of goal.spec.success_measures) {
    if (measureIds.has(measure.id)) {
      throw new CoreValidationError(`${path}: duplicate success measure ${measure.id}`);
    }
    measureIds.add(measure.id);
    if (measure.required) requiredMeasureCount += 1;
    if (!repositoryIds.has(measure.subject.id)) {
      throw new CoreValidationError(
        `${path}: success-measure subject is not declared: ${measure.subject.id}`,
      );
    }
    assertCanonicalUtcInstant(
      measure.observation_window.starts_at,
      `${path}: success measure ${measure.id} observation_window.starts_at`,
    );
    assertCanonicalUtcInstant(
      measure.observation_window.ends_at,
      `${path}: success measure ${measure.id} observation_window.ends_at`,
    );
    if (measure.observation_window.starts_at >= measure.observation_window.ends_at) {
      throw new CoreValidationError(
        `${path}: success measure ${measure.id} observation window is empty or reversed`,
      );
    }
    const profileKey = `${measure.verification_profile.id}:v${measure.verification_profile.version}`;
    const profile = verificationProfiles.get(profileKey);
    if (!profile) throw new CoreValidationError(`${path}: unknown verification profile ${profileKey}`);
    if (measure.evidence_mode !== profile.evidence_mode) {
      throw new CoreValidationError(
        `${path}: success measure ${measure.id} evidence mode does not match ${profileKey}`,
      );
    }
    const validateParameters = new Ajv2020({ allErrors: true, strict: true }).compile(
      profile.parameter_schema,
    );
    if (!validateParameters(measure.parameters)) {
      throw new CoreValidationError(
        `${path}: success measure ${measure.id} parameters do not satisfy ${profileKey}`,
        (validateParameters.errors ?? []).map(
          (error) =>
            `${path}/spec/success_measures/${measure.id}/parameters${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
        ),
      );
    }
    if (requireExecutable) assertVerificationProfileExecutable(profile, path, measure.id);
  }
  if (requiredMeasureCount === 0) {
    throw new CoreValidationError(`${path}: Goal must contain at least one required success measure`);
  }
}

function assertVerificationProfileExecutable(
  profile: VerificationProfile,
  path: string,
  measureId: string,
): void {
  const mechanismKey = (mechanism: { id: string; version: number }) =>
    `${mechanism.id}:v${mechanism.version}`;
  const unsupported: string[] = [];
  if (profile.mechanism.kind === "deterministic-evaluator") {
    const key = mechanismKey(profile.mechanism.evaluator);
    if (!supportsVerificationEvaluator(key)) unsupported.push(`evaluator ${key}`);
  } else if (profile.mechanism.kind === "observational-evaluator") {
    const adapterKey = mechanismKey(profile.mechanism.source_adapter);
    const evaluatorKey = mechanismKey(profile.mechanism.evaluator);
    if (!supportsVerificationSourceAdapter(adapterKey)) {
      unsupported.push(`source adapter ${adapterKey}`);
    }
    if (!supportsVerificationEvaluator(evaluatorKey)) {
      unsupported.push(`evaluator ${evaluatorKey}`);
    }
  } else {
    const key = mechanismKey(profile.mechanism.attestation_policy);
    if (!supportsVerificationAttestationPolicy(key)) {
      unsupported.push(`attestation policy ${key}`);
    }
  }
  if (unsupported.length > 0) {
    throw new CoreValidationError(
      `${path}: success measure ${measureId} references unsupported verification mechanisms`,
      unsupported,
    );
  }
}

function assertRealUtcDate(value: string, label: string): void {
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month! - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new CoreValidationError(`${label} is not a real UTC calendar date`);
  }
}

function assertCanonicalUtcInstant(value: string, label: string): void {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new CoreValidationError(`${label} is not a canonical UTC millisecond instant`);
  }
}

function validateOne(entry: CoreTreeEntry, validate: ValidateFunction): unknown {
  const data = readStrictJson(entry.bytes, entry.path);
  if (validate(data)) return data;
  const details = (validate.errors ?? []).map(
    (error) => `${entry.path}${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
  );
  throw new CoreValidationError(`${entry.path}: schema validation failed`, details);
}

function readStrictJson(bytes: Uint8Array, displayPath: string): unknown {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new CoreValidationError(`${displayPath}: invalid UTF-8`, [String(error)]);
  }
  const parseErrors: Array<{ error: number; offset: number; length: number }> = [];
  const tree = parseTree(source, parseErrors, {
    allowEmptyContent: false,
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (parseErrors.length > 0 || !tree) {
    throw new CoreValidationError(
      `${displayPath}: invalid JSON`,
      parseErrors.map(({ error, offset }) => `${displayPath}:${offset} ${printParseErrorCode(error)}`),
    );
  }
  const duplicates = duplicateKeyErrors(tree, displayPath);
  if (duplicates.length > 0) {
    throw new CoreValidationError(`${displayPath}: duplicate JSON object key`, duplicates);
  }
  return getNodeValue(tree);
}

function duplicateKeyErrors(node: JsonNode, path: string, trail: Array<string | number> = []): string[] {
  const errors: string[] = [];
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const [keyNode, valueNode] = property.children ?? [];
      const key = String(keyNode?.value);
      if (seen.has(key)) errors.push(`${path}:${keyNode?.offset ?? 0} duplicate key ${JSON.stringify([...trail, key].join("."))}`);
      seen.add(key);
      if (valueNode) errors.push(...duplicateKeyErrors(valueNode, path, [...trail, key]));
    }
  } else if (node.type === "array") {
    for (const [index, child] of (node.children ?? []).entries()) {
      errors.push(...duplicateKeyErrors(child, path, [...trail, index]));
    }
  }
  return errors;
}

function assertRepositoryInvariants(data: RepositoryDeclaration, path: string): void {
  const match = REPOSITORY_PATH.exec(path);
  if (match && (data.repository.owner !== match[1] || data.repository.name !== match[2])) {
    throw new CoreValidationError(
      `${path}: declared repository ${data.repository.owner}/${data.repository.name} does not match its path`,
    );
  }
  const owners = new Set<string>();
  for (const owner of data.accountable_owners) {
    const key = owner.kind === "github-user" ? `github-user:${owner.login!.toLowerCase()}` : `github-team:${owner.slug}`;
    if (owners.has(key)) throw new CoreValidationError(`${path}: duplicate accountable owner ${key}`);
    owners.add(key);
  }
}

function assertSurfaceInvariants(data: unknown, path: string, availablePaths: Set<string>): void {
  const surfaces = (data as { surfaces: Array<{ id: string; schema_path?: string }> }).surfaces;
  const expected = new Set(["agent-instructions", "agent-governance", "agent-skills", "documentation-index"]);
  for (const surface of surfaces) {
    if (!expected.delete(surface.id)) throw new CoreValidationError(`${path}: duplicate or unknown surface ${surface.id}`);
    if (surface.schema_path && !availablePaths.has(surface.schema_path)) {
      throw new CoreValidationError(`${path}: schema path does not exist: ${surface.schema_path}`);
    }
  }
  if (expected.size > 0) throw new CoreValidationError(`${path}: missing surfaces: ${[...expected].join(", ")}`);
}

function assertGovernanceInvariants(data: unknown, path: string): void {
  const boundaries = (data as { protected_boundaries: Array<{ id: string }> }).protected_boundaries;
  const ids = new Set<string>();
  for (const boundary of boundaries) {
    if (ids.has(boundary.id)) throw new CoreValidationError(`${path}: duplicate protected boundary ${boundary.id}`);
    ids.add(boundary.id);
  }
}

function schemaBoundaryErrors(value: unknown, trail: Array<string | number> = []): string[] {
  const errors: string[] = [];
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      errors.push(...schemaBoundaryErrors(item, [...trail, index]));
    }
    return errors;
  }
  if (value === null || typeof value !== "object") return errors;
  for (const [key, item] of Object.entries(value)) {
    const nextTrail = [...trail, key];
    if (
      ["$ref", "$dynamicRef", "$recursiveRef"].includes(key) &&
      (typeof item !== "string" || !item.startsWith("#"))
    ) {
      errors.push(`${nextTrail.join(".")}: only document-local ${key} values are allowed`);
    }
    if (trail.length > 0 && ["$id", "$schema"].includes(key)) {
      errors.push(`${nextTrail.join(".")}: nested schema identities and dialects are forbidden`);
    }
    errors.push(...schemaBoundaryErrors(item, nextTrail));
  }
  return errors;
}

function assertVerificationProfileInvariants(data: VerificationProfile, path: string): void {
  const pathMatch = VERIFICATION_PROFILE_PATH.exec(path);
  if (
    pathMatch &&
    (data.profile.id !== pathMatch[1] || data.profile.version !== Number(pathMatch[2]))
  ) {
    throw new CoreValidationError(`${path}: verification profile identity does not match its path`);
  }
  const expectedParameterSchemaId =
    `https://frostyard.org/schemas/organization/verification-profiles/` +
    `${data.profile.id}/v${data.profile.version}-parameters.schema.json`;
  if (
    data.parameter_schema.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
    data.parameter_schema.$id !== expectedParameterSchemaId ||
    data.parameter_schema.type !== "object" ||
    data.parameter_schema.additionalProperties !== false
  ) {
    throw new CoreValidationError(
      `${path}: parameter schema must be a closed Draft 2020-12 object with its canonical $id`,
    );
  }
  const boundaryErrors = schemaBoundaryErrors(data.parameter_schema);
  if (boundaryErrors.length > 0) {
    throw new CoreValidationError(`${path}: parameter schema crosses its document boundary`, boundaryErrors);
  }
  try {
    new Ajv2020({ allErrors: true, strict: true }).compile(data.parameter_schema);
  } catch (error) {
    throw new CoreValidationError(
      `${path}: parameter schema is not a valid strict Draft 2020-12 schema`,
      [error instanceof Error ? error.message : String(error)],
    );
  }
}

function fixtureContract(path: string): { expectation: "valid" | "invalid"; kind: FixtureKind } {
  const match = FIXTURE_PATH.exec(path)!;
  const name = match[2]!;
  return {
    expectation: match[1] as "valid" | "invalid",
    kind:
      name === "repository"
        ? "repository"
        : name === "repository-surfaces"
          ? "surfaces"
          : name === "repository-settings"
            ? "settings"
          : name === "verification-profile"
            ? "verificationProfile"
            : name === "goal"
              ? "goal"
            : "governance",
  };
}

function isRecognizedPath(path: string): boolean {
  return (
    STATIC_PATHS.has(path) ||
    path === SCHEMA_PATHS.verificationProfile ||
    path === SCHEMA_PATHS.envelope ||
    path === SCHEMA_PATHS.goal ||
    path === SCHEMA_PATHS.settings ||
    path === SETTINGS_CONTRACT_PATH ||
    REPOSITORY_PATH.test(path) ||
    VERIFICATION_PROFILE_PATH.test(path) ||
    GOAL_PATH.test(path) ||
    FIXTURE_PATH.test(path)
  );
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
