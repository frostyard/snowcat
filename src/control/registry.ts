import { isUuidV7, type JsonValue } from "./encoding.ts";

export const CONTROL_PLANE_APPLICATION_ID = 1_179_405_908; // ASCII "FLNT"
export const CONTROL_PLANE_SCHEMA_VERSION = 1;
export const CONTROL_PLANE_REGISTRY_VERSION = 1;

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
} as const satisfies Record<string, SubjectKindContract>;

export const revisionKindRegistry = {
  sha256: {
    validate: (value: string) => /^sha256:[0-9a-f]{64}$/.test(value),
  },
  "transaction-sequence": {
    validate: (value: string) => /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)),
  },
} as const;

export const sourceKindRegistry = {
  "fluent-system": {
    validateId: (value: string) => value === "kernel",
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
