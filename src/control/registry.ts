import { isUuidV7, type JsonValue } from "./encoding.ts";

export const CONTROL_PLANE_APPLICATION_ID = 1_179_405_908; // ASCII "FLNT"
export const CONTROL_PLANE_SCHEMA_VERSION = 2;
export const CONTROL_PLANE_REGISTRY_VERSION = 6;

export const informationClasses = ["public", "organization", "restricted"] as const;
export type InformationClass = (typeof informationClasses)[number];

export const recordClasses = [
  "definition",
  "assertion",
  "observation",
  "evidence-reference",
  "fact",
  "decision",
] as const;
export type RecordClass = (typeof recordClasses)[number];

export interface SubjectKindContract {
  authoritySystem: "fluent";
  idScheme: "uuidv7";
  revisionKinds: readonly string[];
  validateId: (value: string) => boolean;
}

export const subjectKindRegistry = {
  "control-plane-database": {
    authoritySystem: "fluent",
    idScheme: "uuidv7",
    revisionKinds: ["sha256", "transaction-sequence"],
    validateId: isUuidV7,
  },
  "operator-principal": {
    authoritySystem: "fluent",
    idScheme: "uuidv7",
    revisionKinds: ["sha256"],
    validateId: isUuidV7,
  },
  "core-snapshot": {
    authoritySystem: "fluent",
    idScheme: "uuidv7",
    revisionKinds: ["core-catalog-sha256"],
    validateId: isUuidV7,
  },
} as const satisfies Record<string, SubjectKindContract>;

export const revisionKindRegistry = {
  sha256: {
    validate: (value: string) => /^sha256:[0-9a-f]{64}$/.test(value),
  },
  "transaction-sequence": {
    validate: (value: string) => /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)),
  },
  "core-catalog-sha256": {
    validate: (value: string) => /^sha256:[0-9a-f]{64}$/.test(value),
  },
  "git-commit-sha1": {
    validate: (value: string) => /^sha1:[0-9a-f]{40}$/.test(value),
  },
} as const;

export const sourceKindRegistry = {
  "fluent-system": {
    validateId: (value: string) => value === "kernel",
    revisionKinds: [] as const,
  },
  "github-repository": {
    validateId: (value: string) => /^github\.com:[1-9][0-9]{0,19}$/.test(value),
    revisionKinds: ["git-commit-sha1"],
  },
  "operator-principal": {
    validateId: isUuidV7,
    revisionKinds: [] as const,
  },
} as const;

export const recordKindRegistry = {
  "control-plane.database-definition": {
    schemaVersion: 1,
    recordClass: "definition",
    subjectKinds: ["control-plane-database"],
    minimumInformationClass: "organization",
    validatePayload: isDatabaseDefinitionPayload,
  },
  "principal.definition": {
    schemaVersion: 1,
    recordClass: "definition",
    subjectKinds: ["operator-principal"],
    minimumInformationClass: "organization",
    validatePayload: isPrincipalDefinitionPayload,
  },
  "control-plane.integrity-observation": {
    schemaVersion: 1,
    recordClass: "observation",
    subjectKinds: ["control-plane-database"],
    minimumInformationClass: "organization",
    validatePayload: isIntegrityPayload,
  },
  "core.snapshot-definition": {
    schemaVersion: 1,
    recordClass: "definition",
    subjectKinds: ["core-snapshot"],
    minimumInformationClass: "organization",
    validatePayload: isCoreSnapshotDefinitionPayload,
  },
  "core.snapshot-active": {
    schemaVersion: 1,
    recordClass: "fact",
    subjectKinds: ["control-plane-database"],
    minimumInformationClass: "organization",
    validatePayload: isCoreSnapshotActivePayload,
  },
  "core.candidate-rejection-observation": {
    schemaVersion: 1,
    recordClass: "observation",
    subjectKinds: ["control-plane-database"],
    minimumInformationClass: "organization",
    validatePayload: isCoreCandidateRejectionPayload,
  },
  "core.source-check-eligible-observation": {
    schemaVersion: 1,
    recordClass: "observation",
    subjectKinds: ["control-plane-database"],
    minimumInformationClass: "organization",
    validatePayload: isCoreSourceCheckEligiblePayload,
  },
  "core.rollback-decision": {
    schemaVersion: 1,
    recordClass: "decision",
    subjectKinds: ["control-plane-database"],
    minimumInformationClass: "organization",
    validatePayload: isCoreRollbackDecisionPayload,
  },
} as const;

export const eventKindRegistry = {
  "control-plane.initialized": {
    schemaVersion: 1,
    subjectKinds: ["control-plane-database"],
    minimumInformationClass: "organization",
    validatePayload: isDatabaseInitializedPayload,
  },
  "control-plane.integrity-checked": {
    schemaVersion: 1,
    subjectKinds: ["control-plane-database"],
    minimumInformationClass: "organization",
    validatePayload: isIntegrityPayload,
  },
  "core.snapshot-activated": {
    schemaVersion: 1,
    subjectKinds: ["core-snapshot"],
    minimumInformationClass: "organization",
    validatePayload: isCoreSnapshotActivePayload,
  },
  "core.candidate-rejected": {
    schemaVersion: 1,
    subjectKinds: ["control-plane-database"],
    minimumInformationClass: "organization",
    validatePayload: isCoreCandidateRejectionPayload,
  },
  "core.source-check-eligible": {
    schemaVersion: 1,
    subjectKinds: ["control-plane-database"],
    minimumInformationClass: "organization",
    validatePayload: isCoreSourceCheckEligiblePayload,
  },
  "core.snapshot-rollback-activated": {
    schemaVersion: 1,
    subjectKinds: ["core-snapshot"],
    minimumInformationClass: "organization",
    validatePayload: isCoreRollbackActivatedPayload,
  },
} as const;

export const commandKindRegistry = {
  "control-plane.initialize": {
    schemaVersion: 1,
    outputKinds: ["control-plane.database-definition", "principal.definition", "control-plane.initialized"],
  },
  "control-plane.check-integrity": {
    schemaVersion: 1,
    outputKinds: ["control-plane.integrity-observation", "control-plane.integrity-checked"],
  },
  "core.activate-snapshot": {
    schemaVersion: 1,
    outputKinds: ["core.snapshot-definition", "core.snapshot-active", "core.snapshot-activated"],
  },
  "core.record-candidate-rejection": {
    schemaVersion: 1,
    outputKinds: ["core.candidate-rejection-observation", "core.candidate-rejected"],
  },
  "core.record-source-check-eligible": {
    schemaVersion: 1,
    outputKinds: ["core.source-check-eligible-observation", "core.source-check-eligible"],
  },
  "core.rollback-snapshot": {
    schemaVersion: 1,
    outputKinds: [
      "core.rollback-decision",
      "core.snapshot-definition",
      "core.snapshot-active",
      "core.snapshot-rollback-activated",
    ],
  },
} as const;

export const predicateContractRegistry = {
  "core.snapshot-active": {
    contractVersion: 1,
    recordClass: "fact",
    subjectKinds: ["control-plane-database"],
    establishedBy: ["core.activate-snapshot", "core.rollback-snapshot"],
    precedence: "latest-transaction-sequence",
    consumers: ["core-authority"],
  },
} as const;

export interface ProjectionContract {
  contractVersion: number;
  transformationVersion: number;
  informationHandlingVersion: number;
  sourceKinds: readonly string[];
  consumers: readonly string[];
}

export const projectionContractRegistry = {
  "control-plane.subject-lookup": {
    contractVersion: 1,
    transformationVersion: 1,
    informationHandlingVersion: 1,
    sourceKinds: ["subjects", "definition-records"],
    consumers: ["internal-diagnostics"],
  },
  "control-plane.event-cursor": {
    contractVersion: 1,
    transformationVersion: 1,
    informationHandlingVersion: 1,
    sourceKinds: ["event-ledger"],
    consumers: ["internal-diagnostics", "process-observer"],
  },
} as const satisfies Record<string, ProjectionContract>;

export type SubjectKind = keyof typeof subjectKindRegistry;
export type RevisionKind = keyof typeof revisionKindRegistry;
export type SourceKind = keyof typeof sourceKindRegistry;
export type RecordKind = keyof typeof recordKindRegistry;
export type EventKind = keyof typeof eventKindRegistry;
export type CommandKind = keyof typeof commandKindRegistry;
export type ProjectionName = keyof typeof projectionContractRegistry;

export interface DatabaseDefinitionPayload extends Record<string, JsonValue> {
  databaseLineageId: string;
  operatorPrincipalId: string;
  registryVersion: number;
  schemaVersion: number;
}

export interface DatabaseInitializedPayload extends Record<string, JsonValue> {
  databaseLineageId: string;
  operatorPrincipalId: string;
  registryVersion: number;
  schemaVersion: number;
}

export interface PrincipalDefinitionPayload extends Record<string, JsonValue> {
  binding: "local-stdio-implicit";
  principalKind: "operator";
}

export interface IntegrityPayload extends Record<string, JsonValue> {
  checkedThroughSequence: number;
  databaseLineageId: string;
  registryVersion: number;
  result: "ok";
  schemaVersion: number;
}

export interface CoreSnapshotDefinitionPayload extends Record<string, JsonValue> {
  snapshotId: string;
  sourceRepositoryId: "github.com:1331309458";
  sourceUrl: string;
  sourceRef: string;
  sourceCommitId: string;
  sourceTreeId: string;
  catalogDigest: string;
  fileCount: number;
  totalBytes: number;
  repositoryCount: number;
  validFixtureCount: number;
  invalidFixtureCount: number;
  schemaDigests: Record<string, JsonValue>;
  importedAt: string;
}

export interface CoreSnapshotActivePayload extends Record<string, JsonValue> {
  databaseLineageId: string;
  snapshotId: string;
  catalogDigest: string;
  sourceCommitId: string;
  activatedAt: string;
}

export type CoreCandidateRejectionStage = "source" | "validation" | "continuity" | "persistence";
export type CoreCandidateRejectionCode =
  | "source-unavailable"
  | "candidate-invalid"
  | "candidate-not-descendant"
  | "continuity-unverifiable"
  | "persistence-failed";

export interface CoreCandidateRejectionPayload extends Record<string, JsonValue> {
  checkId: string;
  operation: "automatic-source-check" | "operator-rollback";
  stage: CoreCandidateRejectionStage;
  code: CoreCandidateRejectionCode;
  summary: string;
  details: string[];
  sourceUrl: string;
  sourceRef: string;
  commitId: string | null;
  treeId: string | null;
  catalogDigest: string | null;
  activeCommitId: string | null;
  observedAt: string;
}

export interface CoreSourceCheckEligiblePayload extends Record<string, JsonValue> {
  checkId: string;
  outcome: "eligible";
  sourceUrl: string;
  sourceRef: string;
  commitId: string;
  treeId: string;
  catalogDigest: string;
  activeSnapshotId: string;
  activeCommitId: string;
  checkedAt: string;
}

export interface CoreRollbackDecisionPayload extends Record<string, JsonValue> {
  decisionId: string;
  decisionType: "core-rollback";
  state: "resolved";
  choice: "activate-target-commit";
  databaseLineageId: string;
  operatorPrincipalId: string;
  activeSnapshotId: string;
  activeCommitId: string;
  targetCommitId: string;
  targetCatalogDigest: string;
  reason: string;
  expectedLastTransactionSequence: number;
  decidedAt: string;
}

export interface CoreRollbackActivatedPayload extends Record<string, JsonValue> {
  databaseLineageId: string;
  snapshotId: string;
  catalogDigest: string;
  sourceCommitId: string;
  previousSnapshotId: string;
  previousSourceCommitId: string;
  decisionRecordId: string;
  operatorPrincipalId: string;
  reason: string;
  activatedAt: string;
}

export function assertSubject(kind: string, id: string): asserts kind is SubjectKind {
  const contract = subjectKindRegistry[kind as SubjectKind];
  if (!contract) throw new Error(`unknown subject kind: ${kind}`);
  if (!contract.validateId(id)) throw new Error(`invalid ${kind} subject ID: ${id}`);
}

export function assertRevision(kind: string, value: string, subjectKind: SubjectKind): asserts kind is RevisionKind {
  const subjectContract = subjectKindRegistry[subjectKind];
  if (!subjectContract.revisionKinds.includes(kind as never)) {
    throw new Error(`revision kind ${kind} is not allowed for subject kind ${subjectKind}`);
  }
  const revision = revisionKindRegistry[kind as RevisionKind];
  if (!revision) throw new Error(`unknown revision kind: ${kind}`);
  if (!revision.validate(value)) throw new Error(`invalid ${kind} revision: ${value}`);
}

export function assertInformationClass(value: string): asserts value is InformationClass {
  if (!informationClasses.includes(value as InformationClass)) throw new Error(`unknown information class: ${value}`);
}

export function assertSource(kind: string, id: string, revisionKind?: string): asserts kind is SourceKind {
  const contract = sourceKindRegistry[kind as SourceKind];
  if (!contract || !contract.validateId(id)) throw new Error(`unknown or invalid source: ${kind}`);
  if (revisionKind !== undefined && !contract.revisionKinds.includes(revisionKind as never)) {
    throw new Error(`source revision kind ${revisionKind} is not allowed for source kind ${kind}`);
  }
}

export function assertSourceRevision(kind: string, value: string): asserts kind is RevisionKind {
  const revision = revisionKindRegistry[kind as RevisionKind];
  if (!revision) throw new Error(`unknown source revision kind: ${kind}`);
  if (!revision.validate(value)) throw new Error(`invalid ${kind} source revision: ${value}`);
}

export function informationClassAtLeast(actual: InformationClass, minimum: InformationClass): boolean {
  return informationClasses.indexOf(actual) >= informationClasses.indexOf(minimum);
}

function isDatabaseDefinitionPayload(value: unknown): value is DatabaseDefinitionPayload {
  return isDatabasePayload(value);
}

function isDatabaseInitializedPayload(value: unknown): value is DatabaseInitializedPayload {
  return isDatabasePayload(value);
}

function isPrincipalDefinitionPayload(value: unknown): value is PrincipalDefinitionPayload {
  return (
    isExactObject(value, ["binding", "principalKind"]) &&
    value.binding === "local-stdio-implicit" &&
    value.principalKind === "operator"
  );
}

function isIntegrityPayload(value: unknown): value is IntegrityPayload {
  if (
    !isExactObject(value, [
      "checkedThroughSequence",
      "databaseLineageId",
      "registryVersion",
      "result",
      "schemaVersion",
    ])
  ) {
    return false;
  }
  return (
    Number.isSafeInteger(value.checkedThroughSequence) &&
    Number(value.checkedThroughSequence) >= 1 &&
    typeof value.databaseLineageId === "string" &&
    isUuidV7(value.databaseLineageId) &&
    value.registryVersion === CONTROL_PLANE_REGISTRY_VERSION &&
    value.result === "ok" &&
    value.schemaVersion === CONTROL_PLANE_SCHEMA_VERSION
  );
}

function isCoreSnapshotDefinitionPayload(value: unknown): value is CoreSnapshotDefinitionPayload {
  if (
    !isExactObject(value, [
      "snapshotId",
      "sourceRepositoryId",
      "sourceUrl",
      "sourceRef",
      "sourceCommitId",
      "sourceTreeId",
      "catalogDigest",
      "fileCount",
      "totalBytes",
      "repositoryCount",
      "validFixtureCount",
      "invalidFixtureCount",
      "schemaDigests",
      "importedAt",
    ])
  ) {
    return false;
  }
  const schemaDigests = value.schemaDigests;
  if (!isExactObject(schemaDigests, ["repository", "surfaces", "governance"])) return false;
  return (
    typeof value.snapshotId === "string" &&
    isUuidV7(value.snapshotId) &&
    value.sourceRepositoryId === "github.com:1331309458" &&
    typeof value.sourceUrl === "string" &&
    /^(?:https:\/\/github\.com\/frostyard\/core\.git|git@github\.com:frostyard\/core\.git|ssh:\/\/git@github\.com:frostyard\/core\.git)$/.test(
      value.sourceUrl,
    ) &&
    typeof value.sourceRef === "string" &&
    isCanonicalCoreRef(value.sourceRef) &&
    typeof value.sourceCommitId === "string" &&
    /^[0-9a-f]{40}$/.test(value.sourceCommitId) &&
    typeof value.sourceTreeId === "string" &&
    /^[0-9a-f]{40}$/.test(value.sourceTreeId) &&
    isSha256(value.catalogDigest) &&
    isPositiveInteger(value.fileCount) &&
    isNonNegativeInteger(value.totalBytes) &&
    isNonNegativeInteger(value.repositoryCount) &&
    isPositiveInteger(value.validFixtureCount) &&
    isPositiveInteger(value.invalidFixtureCount) &&
    Object.values(schemaDigests).every(isSha256) &&
    isUtcInstant(value.importedAt)
  );
}

function isCoreSnapshotActivePayload(value: unknown): value is CoreSnapshotActivePayload {
  return (
    isExactObject(value, ["databaseLineageId", "snapshotId", "catalogDigest", "sourceCommitId", "activatedAt"]) &&
    typeof value.databaseLineageId === "string" &&
    isUuidV7(value.databaseLineageId) &&
    typeof value.snapshotId === "string" &&
    isUuidV7(value.snapshotId) &&
    isSha256(value.catalogDigest) &&
    typeof value.sourceCommitId === "string" &&
    /^[0-9a-f]{40}$/.test(value.sourceCommitId) &&
    isUtcInstant(value.activatedAt)
  );
}

function isCoreCandidateRejectionPayload(value: unknown): value is CoreCandidateRejectionPayload {
  if (
    !isExactObject(value, [
      "checkId",
      "operation",
      "stage",
      "code",
      "summary",
      "details",
      "sourceUrl",
      "sourceRef",
      "commitId",
      "treeId",
      "catalogDigest",
      "activeCommitId",
      "observedAt",
    ])
  ) {
    return false;
  }
  if (
    typeof value.checkId !== "string" ||
    !isUuidV7(value.checkId) ||
    (value.operation !== "automatic-source-check" && value.operation !== "operator-rollback") ||
    (value.stage !== "source" &&
      value.stage !== "validation" &&
      value.stage !== "continuity" &&
      value.stage !== "persistence") ||
    (value.code !== "source-unavailable" &&
      value.code !== "candidate-invalid" &&
      value.code !== "candidate-not-descendant" &&
      value.code !== "continuity-unverifiable" &&
      value.code !== "persistence-failed") ||
    !isBoundedDiagnostic(value.summary) ||
    !Array.isArray(value.details) ||
    value.details.length > 8 ||
    !value.details.every(isBoundedDiagnostic) ||
    typeof value.sourceUrl !== "string" ||
    !/^(?:https:\/\/github\.com\/frostyard\/core\.git|git@github\.com:frostyard\/core\.git|ssh:\/\/git@github\.com:frostyard\/core\.git)$/.test(
      value.sourceUrl,
    ) ||
    typeof value.sourceRef !== "string" ||
    !isCanonicalCoreRef(value.sourceRef) ||
    !isUtcInstant(value.observedAt)
  ) {
    return false;
  }
  const hasCommit = typeof value.commitId === "string" && /^[0-9a-f]{40}$/.test(value.commitId);
  const hasTree = typeof value.treeId === "string" && /^[0-9a-f]{40}$/.test(value.treeId);
  const hasCatalog = isSha256(value.catalogDigest);
  const hasActiveCommit = typeof value.activeCommitId === "string" && /^[0-9a-f]{40}$/.test(value.activeCommitId);
  if ((value.commitId !== null && !hasCommit) || (value.treeId !== null && !hasTree)) return false;
  if (value.catalogDigest !== null && !hasCatalog) return false;
  if (value.activeCommitId !== null && !hasActiveCommit) return false;
  if (value.stage === "source") return value.code === "source-unavailable" && !hasCatalog;
  if (!hasCommit) return false;
  if (value.stage === "validation") return value.code === "candidate-invalid" && !hasCatalog;
  if (!hasTree || !hasCatalog) return false;
  if (value.stage === "continuity") {
    return (
      hasActiveCommit &&
      (value.code === "candidate-not-descendant" || value.code === "continuity-unverifiable")
    );
  }
  return value.code === "persistence-failed";
}

function isCoreSourceCheckEligiblePayload(value: unknown): value is CoreSourceCheckEligiblePayload {
  return (
    isExactObject(value, [
      "checkId",
      "outcome",
      "sourceUrl",
      "sourceRef",
      "commitId",
      "treeId",
      "catalogDigest",
      "activeSnapshotId",
      "activeCommitId",
      "checkedAt",
    ]) &&
    typeof value.checkId === "string" &&
    isUuidV7(value.checkId) &&
    value.outcome === "eligible" &&
    typeof value.sourceUrl === "string" &&
    /^(?:https:\/\/github\.com\/frostyard\/core\.git|git@github\.com:frostyard\/core\.git|ssh:\/\/git@github\.com\/frostyard\/core\.git)$/.test(
      value.sourceUrl,
    ) &&
    typeof value.sourceRef === "string" &&
    isCanonicalCoreRef(value.sourceRef) &&
    typeof value.commitId === "string" &&
    /^[0-9a-f]{40}$/.test(value.commitId) &&
    typeof value.treeId === "string" &&
    /^[0-9a-f]{40}$/.test(value.treeId) &&
    isSha256(value.catalogDigest) &&
    typeof value.activeSnapshotId === "string" &&
    isUuidV7(value.activeSnapshotId) &&
    value.activeCommitId === value.commitId &&
    isUtcInstant(value.checkedAt)
  );
}

function isCoreRollbackDecisionPayload(value: unknown): value is CoreRollbackDecisionPayload {
  return (
    isExactObject(value, [
      "decisionId",
      "decisionType",
      "state",
      "choice",
      "databaseLineageId",
      "operatorPrincipalId",
      "activeSnapshotId",
      "activeCommitId",
      "targetCommitId",
      "targetCatalogDigest",
      "reason",
      "expectedLastTransactionSequence",
      "decidedAt",
    ]) &&
    typeof value.decisionId === "string" &&
    isUuidV7(value.decisionId) &&
    value.decisionType === "core-rollback" &&
    value.state === "resolved" &&
    value.choice === "activate-target-commit" &&
    typeof value.databaseLineageId === "string" &&
    isUuidV7(value.databaseLineageId) &&
    typeof value.operatorPrincipalId === "string" &&
    isUuidV7(value.operatorPrincipalId) &&
    typeof value.activeSnapshotId === "string" &&
    isUuidV7(value.activeSnapshotId) &&
    typeof value.activeCommitId === "string" &&
    /^[0-9a-f]{40}$/.test(value.activeCommitId) &&
    typeof value.targetCommitId === "string" &&
    /^[0-9a-f]{40}$/.test(value.targetCommitId) &&
    isSha256(value.targetCatalogDigest) &&
    isBoundedDiagnostic(value.reason) &&
    Number.isSafeInteger(value.expectedLastTransactionSequence) &&
    Number(value.expectedLastTransactionSequence) >= 1 &&
    isUtcInstant(value.decidedAt)
  );
}

function isCoreRollbackActivatedPayload(value: unknown): value is CoreRollbackActivatedPayload {
  return (
    isExactObject(value, [
      "databaseLineageId",
      "snapshotId",
      "catalogDigest",
      "sourceCommitId",
      "previousSnapshotId",
      "previousSourceCommitId",
      "decisionRecordId",
      "operatorPrincipalId",
      "reason",
      "activatedAt",
    ]) &&
    typeof value.databaseLineageId === "string" &&
    isUuidV7(value.databaseLineageId) &&
    typeof value.snapshotId === "string" &&
    isUuidV7(value.snapshotId) &&
    isSha256(value.catalogDigest) &&
    typeof value.sourceCommitId === "string" &&
    /^[0-9a-f]{40}$/.test(value.sourceCommitId) &&
    typeof value.previousSnapshotId === "string" &&
    isUuidV7(value.previousSnapshotId) &&
    typeof value.previousSourceCommitId === "string" &&
    /^[0-9a-f]{40}$/.test(value.previousSourceCommitId) &&
    typeof value.decisionRecordId === "string" &&
    isUuidV7(value.decisionRecordId) &&
    typeof value.operatorPrincipalId === "string" &&
    isUuidV7(value.operatorPrincipalId) &&
    isBoundedDiagnostic(value.reason) &&
    isUtcInstant(value.activatedAt)
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isUtcInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function isCanonicalCoreRef(value: string): boolean {
  return (
    /^refs\/heads\/[A-Za-z0-9._/-]+$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !value.endsWith("/") &&
    !value.endsWith(".")
  );
}

function isBoundedDiagnostic(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") >= 1 &&
    Buffer.byteLength(value, "utf8") <= 512 &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) &&
    !value.includes("\n") &&
    !value.includes("\r")
  );
}

function isDatabasePayload(value: unknown): value is DatabaseDefinitionPayload {
  if (!isExactObject(value, ["databaseLineageId", "operatorPrincipalId", "registryVersion", "schemaVersion"])) {
    return false;
  }
  return (
    typeof value.databaseLineageId === "string" &&
    isUuidV7(value.databaseLineageId) &&
    typeof value.operatorPrincipalId === "string" &&
    isUuidV7(value.operatorPrincipalId) &&
    value.registryVersion === CONTROL_PLANE_REGISTRY_VERSION &&
    value.schemaVersion === CONTROL_PLANE_SCHEMA_VERSION
  );
}

function isExactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
