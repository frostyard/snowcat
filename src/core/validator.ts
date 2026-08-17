import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { getNodeValue, parseTree, printParseErrorCode, type Node as JsonNode } from "jsonc-parser";

import { canonicalJson, sha256, type JsonValue } from "../control/encoding.ts";

const SCHEMA_PATHS = {
  repository: "organization/schemas/v1/repository.schema.json",
  surfaces: "organization/schemas/v1/repository-surfaces.schema.json",
  governance: "organization/schemas/v1/repository-agent-governance.schema.json",
} as const;
const BUNDLED_SCHEMA_URLS = {
  repository: new URL("./schemas/v1/repository.schema.json", import.meta.url),
  surfaces: new URL("./schemas/v1/repository-surfaces.schema.json", import.meta.url),
  governance: new URL("./schemas/v1/repository-agent-governance.schema.json", import.meta.url),
} as const;
const EXPECTED_SCHEMA_DIGESTS = {
  repository: "sha256:2419d096faac298b8c4a75a3a83b617f4797e4e5f190ccd918ead73ba604bead",
  surfaces: "sha256:b6742c283148d9a75f56d7fc8482d9309955ca5bab669170ac0cade92829670d",
  governance: "sha256:254e131a94c5477e861b0ec792defa1fd05ddebe380fc4e062d03cefc3ab8ebe",
} as const;
const SURFACE_CONTRACT_PATH = "organization/contracts/repository-surfaces/v1.json";
const STATIC_PATHS = new Set([
  "organization/README.md",
  ...Object.values(SCHEMA_PATHS),
  SURFACE_CONTRACT_PATH,
]);
const REPOSITORY_PATH = /^organization\/repositories\/([^/]+)\/([^/]+)\.json$/;
const FIXTURE_PATH =
  /^organization\/fixtures\/v1\/(valid|invalid)\/(repository-agent-governance|repository-surfaces|repository)(?:-[a-z0-9-]+)?\.json$/;

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
  maintenance_programs: Array<"quality" | "ci" | "security" | "architecture">;
  action_ceiling: Array<"read" | "write" | "run-tests" | "open-issue" | "open-pr" | "create-followup">;
  surface_contract_version: 1;
}

export interface ValidatedRepositoryDeclaration {
  path: string;
  contentDigest: string;
  declaration: RepositoryDeclaration;
}

export interface ValidatedCoreCatalog {
  catalogDigest: string;
  fileCount: number;
  totalBytes: number;
  schemaDigests: Record<keyof typeof SCHEMA_PATHS, string>;
  repositoryCount: number;
  validFixtureCount: number;
  invalidFixtureCount: number;
  repositories: ValidatedRepositoryDeclaration[];
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

  let validFixtureCount = 0;
  let invalidFixtureCount = 0;
  for (const entry of entries.filter((item) => FIXTURE_PATH.test(item.path))) {
    const fixture = fixtureContract(entry.path);
    if (fixture.expectation === "valid") {
      validateFixture(entry, fixture.kind, validators, availablePaths);
      validFixtureCount += 1;
      continue;
    }
    try {
      validateFixture(entry, fixture.kind, validators, availablePaths);
    } catch (error) {
      if (!(error instanceof CoreValidationError)) throw error;
      invalidFixtureCount += 1;
      continue;
    }
    throw new CoreValidationError(`${entry.path}: invalid fixture was unexpectedly accepted`);
  }
  if (validFixtureCount === 0 || invalidFixtureCount === 0) {
    throw new CoreValidationError("organization fixture corpus must contain valid and invalid examples");
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
    validFixtureCount,
    invalidFixtureCount,
    repositories,
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

function loadBundledSchemas(entries: Map<string, CoreTreeEntry>): {
  parsed: Record<keyof typeof SCHEMA_PATHS, unknown>;
  digests: Record<keyof typeof SCHEMA_PATHS, string>;
} {
  const parsed = {} as Record<keyof typeof SCHEMA_PATHS, unknown>;
  const digests = {} as Record<keyof typeof SCHEMA_PATHS, string>;
  for (const kind of Object.keys(SCHEMA_PATHS) as Array<keyof typeof SCHEMA_PATHS>) {
    const bundledBytes = readFileSync(BUNDLED_SCHEMA_URLS[kind]);
    const fetched = entries.get(SCHEMA_PATHS[kind])!;
    const fetchedDigest = digestBytes(fetched.bytes);
    const expectedDigest = EXPECTED_SCHEMA_DIGESTS[kind];
    if (fetchedDigest !== expectedDigest) {
      throw new CoreValidationError(
        `${fetched.path}: schema bytes do not match Fluent's bundled v1 contract`,
        [`expected ${expectedDigest}`, `received ${fetchedDigest}`],
      );
    }
    const bundledSchema = readStrictJson(bundledBytes, `bundled:${fetched.path}`);
    const fetchedSchema = readStrictJson(fetched.bytes, fetched.path);
    if (canonicalJson(bundledSchema as JsonValue) !== canonicalJson(fetchedSchema as JsonValue)) {
      throw new CoreValidationError(`${fetched.path}: bundled validator schema does not match fetched schema semantics`);
    }
    parsed[kind] = bundledSchema;
    digests[kind] = expectedDigest;
  }
  return { parsed, digests };
}

function createValidators(schemas: Record<keyof typeof SCHEMA_PATHS, unknown>): Record<
  keyof typeof SCHEMA_PATHS,
  ValidateFunction
> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return {
    repository: ajv.compile(schemas.repository as object),
    surfaces: ajv.compile(schemas.surfaces as object),
    governance: ajv.compile(schemas.governance as object),
  };
}

function validateFixture(
  entry: CoreTreeEntry,
  kind: keyof typeof SCHEMA_PATHS,
  validators: Record<keyof typeof SCHEMA_PATHS, ValidateFunction>,
  availablePaths: Set<string>,
): void {
  const data = validateOne(entry, validators[kind]);
  if (kind === "repository") assertRepositoryInvariants(data as RepositoryDeclaration, entry.path);
  else if (kind === "surfaces") assertSurfaceInvariants(data, entry.path, availablePaths);
  else assertGovernanceInvariants(data, entry.path);
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

function fixtureContract(path: string): { expectation: "valid" | "invalid"; kind: keyof typeof SCHEMA_PATHS } {
  const match = FIXTURE_PATH.exec(path)!;
  const name = match[2]!;
  return {
    expectation: match[1] as "valid" | "invalid",
    kind: name === "repository" ? "repository" : name === "repository-surfaces" ? "surfaces" : "governance",
  };
}

function isRecognizedPath(path: string): boolean {
  return STATIC_PATHS.has(path) || REPOSITORY_PATH.test(path) || FIXTURE_PATH.test(path);
}

function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
