import { isUuidV7, type JsonValue } from "./encoding.ts";

export const CONTROL_PLANE_APPLICATION_ID = 1_179_405_908; // ASCII "FLNT"
export const CONTROL_PLANE_SCHEMA_VERSION = 7;
export const CONTROL_PLANE_REGISTRY_VERSION = 14;

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
  authoritySystem: "fluent" | "github";
  idScheme: "uuidv7" | "github-qualified-numeric-id";
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
  "github-repository": {
    authoritySystem: "github",
    idScheme: "github-qualified-numeric-id",
    revisionKinds: [
      "core-declaration-sha256",
      "github-metadata-sha256",
      "git-commit-sha1",
      "repository-surfaces-sha256",
      "github-rules-sha256",
      "github-branch-transition-sha256",
      "github-source-checkpoint-sha256",
      "github-source-gap-sha256",
    ],
    validateId: (value: string) => /^github\.com:[1-9][0-9]{0,19}$/.test(value),
  },
  "github-app-hook": {
    authoritySystem: "github",
    idScheme: "github-qualified-numeric-id",
    revisionKinds: ["github-webhook-body-sha256", "github-delivery-audit-sha256"],
    validateId: isGitHubAppHookId,
  },
  "github-pull-request": {
    authoritySystem: "github",
    idScheme: "github-qualified-numeric-id",
    revisionKinds: ["github-pull-request-sha256"],
    validateId: isGitHubPullRequestId,
  },
  "github-check-run": {
    authoritySystem: "github",
    idScheme: "github-qualified-numeric-id",
    revisionKinds: ["github-check-run-sha256"],
    validateId: isGitHubCheckRunId,
  },
  "github-commit-status": {
    authoritySystem: "github",
    idScheme: "github-qualified-numeric-id",
    revisionKinds: ["github-commit-status-sha256"],
    validateId: isGitHubCommitStatusId,
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
  "core-declaration-sha256": {
    validate: (value: string) => /^sha256:[0-9a-f]{64}$/.test(value),
  },
  "github-metadata-sha256": {
    validate: (value: string) => /^sha256:[0-9a-f]{64}$/.test(value),
  },
  "repository-surfaces-sha256": {
    validate: (value: string) => /^sha256:[0-9a-f]{64}$/.test(value),
  },
  "github-webhook-body-sha256": {
    validate: (value: string) => /^sha256:[0-9a-f]{64}$/.test(value),
  },
  "github-delivery-audit-sha256": {
    validate: (value: string) => /^sha256:[0-9a-f]{64}$/.test(value),
  },
  "github-rules-sha256": {
    validate: (value: string) => /^sha256:[0-9a-f]{64}$/.test(value),
  },
  "github-pull-request-sha256": {
    validate: (value: string) => /^sha256:[0-9a-f]{64}$/.test(value),
  },
  "github-branch-transition-sha256": {
    validate: (value: string) => /^sha256:[0-9a-f]{64}$/.test(value),
  },
  "github-check-run-sha256": {
    validate: (value: string) => /^sha256:[0-9a-f]{64}$/.test(value),
  },
  "github-commit-status-sha256": {
    validate: (value: string) => /^sha256:[0-9a-f]{64}$/.test(value),
  },
  "github-source-checkpoint-sha256": {
    validate: (value: string) => /^sha256:[0-9a-f]{64}$/.test(value),
  },
  "github-source-gap-sha256": {
    validate: (value: string) => /^sha256:[0-9a-f]{64}$/.test(value),
  },
} as const;

export const sourceKindRegistry = {
  "fluent-system": {
    validateId: (value: string) => value === "kernel" || value === "github-observer",
    revisionKinds: [] as const,
  },
  "github-repository": {
    validateId: (value: string) => /^github\.com:[1-9][0-9]{0,19}$/.test(value),
    revisionKinds: ["git-commit-sha1"],
  },
  "github-api": {
    validateId: (value: string) => value === "api.github.com",
    revisionKinds: [
      "github-metadata-sha256",
      "git-commit-sha1",
      "github-delivery-audit-sha256",
      "github-rules-sha256",
      "github-pull-request-sha256",
      "github-branch-transition-sha256",
      "github-check-run-sha256",
      "github-commit-status-sha256",
    ],
  },
  "github-app-webhook": {
    validateId: isGitHubAppHookId,
    revisionKinds: ["github-webhook-body-sha256"],
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
  "core.stale-source-override-decision": {
    schemaVersion: 1,
    recordClass: "decision",
    subjectKinds: ["control-plane-database"],
    minimumInformationClass: "organization",
    validatePayload: isCoreStaleSourceOverrideDecisionPayload,
  },
  "core.check-detail-prune-observation": {
    schemaVersion: 1,
    recordClass: "observation",
    subjectKinds: ["control-plane-database"],
    minimumInformationClass: "organization",
    validatePayload: isCoreCheckDetailPrunePayload,
  },
  "core.rollback-decision": {
    schemaVersion: 1,
    recordClass: "decision",
    subjectKinds: ["control-plane-database"],
    minimumInformationClass: "organization",
    validatePayload: isCoreRollbackDecisionPayload,
  },
  "repository.declaration-definition": {
    schemaVersion: 1,
    recordClass: "definition",
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isRepositoryCoreAuthorityPayload,
  },
  "repository.core-authorized": {
    schemaVersion: 1,
    recordClass: "fact",
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isRepositoryCoreAuthorityPayload,
  },
  "repository.github-identity-observation": {
    schemaVersion: 1,
    recordClass: "observation",
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isRepositoryGitHubReconciliationPayload,
  },
  "repository.github-identity-reconciled": {
    schemaVersion: 1,
    recordClass: "fact",
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isRepositoryGitHubReconciliationPayload,
  },
  "repository.canonical-surface-observation": {
    schemaVersion: 1,
    recordClass: "observation",
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isRepositorySurfaceReconciliationPayload,
  },
  "repository.enrollment-checkpoint-policy-decision": {
    schemaVersion: 1,
    recordClass: "decision",
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isRepositorySurfaceReconciliationPayload,
  },
  "repository.canonical-surfaces-reconciled": {
    schemaVersion: 1,
    recordClass: "fact",
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isRepositorySurfaceReconciliationPayload,
  },
  "repository.controller-definition": {
    schemaVersion: 1,
    recordClass: "definition",
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isRepositoryEnrollmentPayload,
  },
  "repository.enrolled": {
    schemaVersion: 1,
    recordClass: "fact",
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isRepositoryEnrollmentPayload,
  },
  "repository.operator-hold-decision": {
    schemaVersion: 1,
    recordClass: "decision",
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isRepositoryOperatorHoldDecisionPayload,
  },
  "github.delivery-receipt-observation": {
    schemaVersion: 1,
    recordClass: "observation",
    subjectKinds: ["github-app-hook"],
    minimumInformationClass: "organization",
    validatePayload: isGitHubDeliveryReceiptPayload,
  },
  "github.pull-request-observation": {
    schemaVersion: 1,
    recordClass: "observation",
    subjectKinds: ["github-pull-request"],
    minimumInformationClass: "organization",
    validatePayload: isGitHubPullRequestObservationPayload,
  },
  "github.source-checkpoint-observation": {
    schemaVersion: 1,
    recordClass: "observation",
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isGitHubSourceCheckpointPayload,
  },
  "github.source-gap-observation": {
    schemaVersion: 1,
    recordClass: "observation",
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isGitHubSourceGapPayload,
  },
  "github.source-gap-repair-observation": {
    schemaVersion: 1,
    recordClass: "observation",
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isGitHubSourceGapRepairPayload,
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
  "core.stale-source-override-issued": {
    schemaVersion: 1,
    subjectKinds: ["control-plane-database"],
    minimumInformationClass: "organization",
    validatePayload: isCoreStaleSourceOverrideDecisionPayload,
  },
  "core.check-detail-pruned": {
    schemaVersion: 1,
    subjectKinds: ["control-plane-database"],
    minimumInformationClass: "organization",
    validatePayload: isCoreCheckDetailPrunePayload,
  },
  "core.snapshot-rollback-activated": {
    schemaVersion: 1,
    subjectKinds: ["core-snapshot"],
    minimumInformationClass: "organization",
    validatePayload: isCoreRollbackActivatedPayload,
  },
  "repository.core-authority-reconciled": {
    schemaVersion: 1,
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isRepositoryCoreAuthorityPayload,
  },
  "repository.github-identity-reconciliation-recorded": {
    schemaVersion: 1,
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isRepositoryGitHubReconciliationPayload,
  },
  "repository.canonical-surfaces-reconciliation-recorded": {
    schemaVersion: 1,
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isRepositorySurfaceReconciliationPayload,
  },
  "repository.enrollment-established": {
    schemaVersion: 1,
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isRepositoryEnrollmentPayload,
  },
  "repository.operator-hold-imposed": {
    schemaVersion: 1,
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isRepositoryOperatorHoldDecisionPayload,
  },
  "repository.operator-hold-cleared": {
    schemaVersion: 1,
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isRepositoryOperatorHoldDecisionPayload,
  },
  "github.delivery-recorded": {
    schemaVersion: 1,
    subjectKinds: ["github-app-hook"],
    minimumInformationClass: "organization",
    validatePayload: isGitHubDeliveryRecordedPayload,
  },
  "github.source-checkpoint-recorded": {
    schemaVersion: 1,
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isGitHubSourceCheckpointPayload,
  },
  "github.source-gap-opened": {
    schemaVersion: 1,
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isGitHubSourceGapPayload,
  },
  "github.source-gap-repaired": {
    schemaVersion: 1,
    subjectKinds: ["github-repository"],
    minimumInformationClass: "organization",
    validatePayload: isGitHubSourceGapRepairPayload,
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
  "core.issue-stale-source-override": {
    schemaVersion: 1,
    outputKinds: ["core.stale-source-override-decision", "core.stale-source-override-issued"],
  },
  "core.prune-check-detail": {
    schemaVersion: 1,
    outputKinds: ["core.check-detail-prune-observation", "core.check-detail-pruned"],
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
  "repository.materialize-core-authority": {
    schemaVersion: 1,
    outputKinds: [
      "repository.declaration-definition",
      "repository.core-authorized",
      "repository.core-authority-reconciled",
    ],
  },
  "repository.record-github-identity": {
    schemaVersion: 1,
    outputKinds: [
      "repository.github-identity-observation",
      "repository.github-identity-reconciled",
      "repository.github-identity-reconciliation-recorded",
    ],
  },
  "repository.record-canonical-surfaces": {
    schemaVersion: 1,
    outputKinds: [
      "repository.canonical-surface-observation",
      "repository.enrollment-checkpoint-policy-decision",
      "repository.canonical-surfaces-reconciled",
      "repository.canonical-surfaces-reconciliation-recorded",
    ],
  },
  "repository.establish-enrollment": {
    schemaVersion: 1,
    outputKinds: [
      "repository.controller-definition",
      "repository.enrolled",
      "repository.enrollment-established",
    ],
  },
  "repository.impose-operator-hold": {
    schemaVersion: 1,
    outputKinds: ["repository.operator-hold-decision", "repository.operator-hold-imposed"],
  },
  "repository.clear-operator-hold": {
    schemaVersion: 1,
    outputKinds: ["repository.operator-hold-decision", "repository.operator-hold-cleared"],
  },
  "github.record-pull-request-delivery": {
    schemaVersion: 1,
    outputKinds: [
      "github.delivery-receipt-observation",
      "github.pull-request-observation",
      "github.delivery-recorded",
    ],
  },
  "github.record-source-checkpoint": {
    schemaVersion: 1,
    outputKinds: ["github.source-checkpoint-observation", "github.source-checkpoint-recorded"],
  },
  "github.open-source-gap": {
    schemaVersion: 1,
    outputKinds: ["github.source-gap-observation", "github.source-gap-opened"],
  },
  "github.repair-source-gap": {
    schemaVersion: 1,
    outputKinds: [
      "github.source-checkpoint-observation",
      "github.source-gap-repair-observation",
      "github.source-gap-repaired",
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
  "repository.core-authorized": {
    contractVersion: 1,
    recordClass: "fact",
    subjectKinds: ["github-repository"],
    establishedBy: ["repository.materialize-core-authority"],
    precedence: "active-core-snapshot",
    consumers: ["repository-reconciliation", "repository-eligibility"],
  },
  "repository.github-identity-reconciled": {
    contractVersion: 1,
    recordClass: "fact",
    subjectKinds: ["github-repository"],
    establishedBy: ["repository.record-github-identity"],
    precedence: "bound-core-authorization",
    consumers: ["repository-reconciliation", "repository-eligibility"],
  },
  "repository.canonical-surfaces-reconciled": {
    contractVersion: 1,
    recordClass: "fact",
    subjectKinds: ["github-repository"],
    establishedBy: ["repository.record-canonical-surfaces"],
    precedence: "bound-github-identity",
    consumers: ["repository-enrollment", "repository-eligibility"],
  },
  "repository.enrolled": {
    contractVersion: 1,
    recordClass: "fact",
    subjectKinds: ["github-repository"],
    establishedBy: ["repository.establish-enrollment"],
    precedence: "active-prerequisite-facts",
    consumers: ["repository-eligibility", "repository-controller"],
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
    contractVersion: 2,
    transformationVersion: 2,
    informationHandlingVersion: 1,
    sourceKinds: ["subjects", "creation-records"],
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

export interface CoreStaleSourceOverrideDecisionPayload extends Record<string, JsonValue> {
  decisionId: string;
  decisionType: "core-stale-source-override";
  state: "resolved";
  choice: "permit-stale-source-admission";
  databaseLineageId: string;
  operatorPrincipalId: string;
  activeSnapshotId: string;
  latestCheckId: string;
  lastValidatedAt: string;
  staleAt: string;
  maximumDurationSeconds: 86400;
  expectedLastTransactionSequence: number;
  reason: string;
  decidedAt: string;
  expiresAt: string;
}

export interface CoreCheckDetailPrunePayload extends Record<string, JsonValue> {
  databaseLineageId: string;
  cutoffAt: string;
  evaluatedAt: string;
  maximumEligibleChecks: 10000;
  deletedTransactionCount: number;
  deletedOccurrenceCount: number;
  deletedFirstSequence: number | null;
  deletedLastSequence: number | null;
  deletedDigest: string;
  remainingDetailedCheckCount: number;
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

export type RepositoryFleetState = "enabled" | "paused" | "disabled";
export type RepositoryMaintenanceProgram = "quality" | "ci" | "security" | "architecture";
export type RepositoryAction = "read" | "write" | "run-tests" | "open-issue" | "open-pr" | "create-followup";
export const repositoryHoldGates = ["discovery", "admission", "claim", "lease-renewal"] as const;
export type RepositoryHoldGate = (typeof repositoryHoldGates)[number];
export type RepositoryGitHubResult =
  | "matched"
  | "missing"
  | "locator-mismatch"
  | "identity-mismatch"
  | "archived"
  | "unavailable";
export type RepositoryState =
  | "awaiting-authority"
  | "disabled"
  | "paused"
  | "awaiting-github"
  | "github-held"
  | "awaiting-surfaces"
  | "surface-held"
  | "operator-held"
  | "awaiting-enrollment"
  | "enrolled";

export type RepositoryAccountableOwner =
  | ({ kind: "github-user"; login: string } & Record<string, JsonValue>)
  | ({ kind: "github-team"; slug: string } & Record<string, JsonValue>);

export interface RepositoryCoreAuthorityPayload extends Record<string, JsonValue> {
  repositoryId: string;
  coreSnapshotId: string;
  declarationRecordId: string;
  coreAuthorizationRecordId: string;
  eventRecordId: string;
  sourceCommitId: string;
  declarationPath: string;
  declarationDigest: string;
  owner: string;
  name: string;
  accountableOwners: RepositoryAccountableOwner[];
  fleetState: RepositoryFleetState;
  maintenancePrograms: RepositoryMaintenanceProgram[];
  actionCeiling: RepositoryAction[];
  surfaceContractVersion: 1;
  authorizedAt: string;
}

export interface RepositoryGitHubReconciliationPayload extends Record<string, JsonValue> {
  repositoryId: string;
  coreSnapshotId: string;
  coreAuthorizationRecordId: string;
  observationRecordId: string;
  reconciliationRecordId: string;
  eventRecordId: string;
  declaredOwner: string;
  declaredName: string;
  declaredRepositoryId: string;
  fleetState: RepositoryFleetState;
  observedOwner: string | null;
  observedName: string | null;
  observedRepositoryId: string | null;
  archived: boolean | null;
  observedDefaultBranch: string | null;
  result: RepositoryGitHubResult;
  effectiveState: RepositoryState;
  checkedAt: string;
  responseDigest: string;
}

export type RepositorySurfaceResult =
  | "valid"
  | "unavailable"
  | "missing"
  | "wrong-type"
  | "invalid"
  | "digest-incompatible";

export interface RepositorySurfaceSummary extends Record<string, JsonValue> {
  surfaceId: "agent-instructions" | "agent-governance" | "agent-skills" | "documentation-index";
  path: string;
  artifactType: "file" | "directory";
  objectId: string;
  contentDigest: string;
  size: number;
}

export interface RepositorySurfaceRequirementResult extends Record<string, JsonValue> {
  requirementId: string;
  surfaceId: RepositorySurfaceSummary["surfaceId"];
  result: "pass" | "fail" | "unknown";
  evidenceDigest: string | null;
}

export interface RepositorySurfaceReconciliationPayload extends Record<string, JsonValue> {
  repositoryId: string;
  coreSnapshotId: string;
  coreAuthorizationRecordId: string;
  githubReconciliationRecordId: string;
  observationRecordId: string;
  policyDecisionRecordId: string;
  reconciliationRecordId: string;
  eventRecordId: string;
  defaultBranch: string | null;
  repositoryCommitId: string | null;
  repositoryTreeId: string | null;
  surfaceContractVersion: 1;
  governanceSchemaVersion: 1;
  surfaceContractDigest: string;
  governanceSchemaDigest: string;
  surfaces: RepositorySurfaceSummary[];
  governancePolicy: JsonValue | null;
  checkpoint: "repository-enrollment";
  decision: "permit" | "deny";
  requirementResults: RepositorySurfaceRequirementResult[];
  exceptionRecordIds: [];
  result: RepositorySurfaceResult;
  failedSurfaceId: RepositorySurfaceSummary["surfaceId"] | null;
  checkedAt: string;
  probeDigest: string;
}

export interface RepositoryEnrollmentPayload extends Record<string, JsonValue> {
  repositoryId: string;
  coreSnapshotId: string;
  coreAuthorizationRecordId: string;
  githubReconciliationRecordId: string;
  surfaceReconciliationRecordId: string;
  surfacePolicyDecisionRecordId: string;
  controllerDefinitionRecordId: string;
  enrollmentRecordId: string;
  eventRecordId: string;
  repositoryCommitId: string;
  surfaceContractVersion: 1;
  maintenancePrograms: RepositoryMaintenanceProgram[];
  actionCeiling: RepositoryAction[];
  enrolledAt: string;
}

export interface RepositoryOperatorHoldDecisionPayload extends Record<string, JsonValue> {
  decisionRecordId: string;
  eventRecordId: string;
  decisionType: "repository-local-hold";
  state: "resolved";
  choice: "impose" | "clear";
  repositoryId: string;
  coreSnapshotId: string;
  coreAuthorizationRecordId: string;
  declarationDigest: string;
  operatorPrincipalId: string;
  holdDecisionId: string;
  previousDecisionRecordId: string | null;
  affectedGates: RepositoryHoldGate[];
  recoveryRule: "operator-clear";
  reason: string;
  expectedLastTransactionSequence: number;
  decidedAt: string;
}

export const githubPullRequestActions = [
  "opened",
  "reopened",
  "synchronize",
  "edited",
  "ready_for_review",
  "converted_to_draft",
  "closed",
] as const;
export type GitHubPullRequestAction = (typeof githubPullRequestActions)[number];

export const githubSourceScope = "github.pull-request-deliveries:v1" as const;
export const githubSourceGapCauses = [
  "delivery-audit-incomplete",
  "source-unavailable",
  "pagination-incomplete",
  "request-budget-exhausted",
  "unsupported-relevant-delivery",
  "normalization-failed",
  "recovery-horizon-expired",
] as const;
export type GitHubSourceGapCause = (typeof githubSourceGapCauses)[number];

export interface GitHubDeliveryReceiptPayload extends Record<string, JsonValue> {
  appId: string;
  hookSubjectId: string;
  deliveryGuid: string;
  event: "pull_request";
  action: GitHubPullRequestAction;
  installationId: string;
  repositoryId: string;
  bodyDigest: string;
  requestBytes: number;
  signatureVerification: "sha256-verified";
  disposition: "pull-request-observation-recorded";
  receiptRecordId: string;
  observationRecordId: string;
  eventRecordId: string;
  receivedAt: string;
}

export interface GitHubPullRequestObservationPayload extends Record<string, JsonValue> {
  repositoryId: string;
  pullRequestId: string;
  pullRequestNumber: number;
  action: GitHubPullRequestAction;
  installationId: string;
  actorId: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  baseRepositoryId: string;
  baseRef: string;
  baseCommitId: string;
  headRepositoryId: string;
  headRef: string;
  headCommitId: string;
  observedTestMergeCommitId: string | null;
  mergedAt: string | null;
  mergeCommitId: string | null;
  sourceUpdatedAt: string;
  deliveryGuid: string;
  receiptRecordId: string;
  observationRecordId: string;
  observationDigest: string;
  observedAt: string;
}

export interface GitHubDeliveryRecordedPayload extends Record<string, JsonValue> {
  deliveryGuid: string;
  receiptRecordId: string;
  observationRecordId: string;
  eventRecordId: string;
  disposition: "pull-request-observation-recorded";
  recordedAt: string;
}

export interface GitHubSourceCheckpointPayload extends Record<string, JsonValue> {
  repositoryId: string;
  scope: typeof githubSourceScope;
  appId: string;
  installationId: string;
  runId: string;
  previousCheckpointRecordId: string | null;
  coveredFrom: string;
  coveredThrough: string;
  pageCount: number;
  deliveryCount: number;
  pageProofDigest: string;
  selectedResponseDigest: string;
  checkpointDigest: string;
  checkpointRecordId: string;
  recordedAt: string;
}

export interface GitHubSourceGapPayload extends Record<string, JsonValue> {
  repositoryId: string;
  scope: typeof githubSourceScope;
  appId: string;
  installationId: string;
  runId: string;
  checkpointRecordId: string;
  gapId: string;
  gapRecordId: string;
  lowerBoundAt: string;
  upperBoundAt: null;
  cause: GitHubSourceGapCause;
  gapDigest: string;
  detectedAt: string;
}

export interface GitHubSourceGapRepairPayload extends Record<string, JsonValue> {
  repositoryId: string;
  scope: typeof githubSourceScope;
  appId: string;
  installationId: string;
  runId: string;
  gapId: string;
  gapRecordId: string;
  priorCheckpointRecordId: string;
  checkpointRecordId: string;
  repairRecordId: string;
  eventRecordId: string;
  lowerBoundAt: string;
  exclusiveEndAt: string;
  repairMethod: "complete-delivery-audit";
  repairDigest: string;
  repairedAt: string;
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
  const requiredKeys = [
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
  ];
  if (
    !isExactObject(value, requiredKeys) &&
    !isExactObject(value, [...requiredKeys, "verificationProfileCount"]) &&
    !isExactObject(value, [...requiredKeys, "verificationProfileCount", "goalCount"])
  ) {
    return false;
  }
  const schemaDigests = value.schemaDigests;
  if (
    !isExactObject(schemaDigests, ["repository", "surfaces", "governance"]) &&
    !isExactObject(schemaDigests, ["repository", "surfaces", "governance", "verificationProfile"]) &&
    !isExactObject(schemaDigests, [
      "repository",
      "surfaces",
      "governance",
      "verificationProfile",
      "envelope",
      "goal",
    ])
  ) {
    return false;
  }
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
    (value.verificationProfileCount === undefined ||
      isNonNegativeInteger(value.verificationProfileCount)) &&
    (value.goalCount === undefined || isNonNegativeInteger(value.goalCount)) &&
    (value.goalCount !== undefined) === (schemaDigests.goal !== undefined) &&
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

function isCoreStaleSourceOverrideDecisionPayload(
  value: unknown,
): value is CoreStaleSourceOverrideDecisionPayload {
  if (
    !isExactObject(value, [
      "decisionId",
      "decisionType",
      "state",
      "choice",
      "databaseLineageId",
      "operatorPrincipalId",
      "activeSnapshotId",
      "latestCheckId",
      "lastValidatedAt",
      "staleAt",
      "maximumDurationSeconds",
      "expectedLastTransactionSequence",
      "reason",
      "decidedAt",
      "expiresAt",
    ]) ||
    typeof value.decisionId !== "string" ||
    !isUuidV7(value.decisionId) ||
    value.decisionType !== "core-stale-source-override" ||
    value.state !== "resolved" ||
    value.choice !== "permit-stale-source-admission" ||
    typeof value.databaseLineageId !== "string" ||
    !isUuidV7(value.databaseLineageId) ||
    typeof value.operatorPrincipalId !== "string" ||
    !isUuidV7(value.operatorPrincipalId) ||
    typeof value.activeSnapshotId !== "string" ||
    !isUuidV7(value.activeSnapshotId) ||
    typeof value.latestCheckId !== "string" ||
    !isUuidV7(value.latestCheckId) ||
    !isUtcInstant(value.lastValidatedAt) ||
    !isUtcInstant(value.staleAt) ||
    value.maximumDurationSeconds !== 86400 ||
    !Number.isSafeInteger(value.expectedLastTransactionSequence) ||
    Number(value.expectedLastTransactionSequence) < 1 ||
    !isBoundedDiagnostic(value.reason) ||
    !isUtcInstant(value.decidedAt) ||
    !isUtcInstant(value.expiresAt)
  ) {
    return false;
  }
  const validatedAt = new Date(value.lastValidatedAt).getTime();
  const staleAt = new Date(value.staleAt).getTime();
  const decidedAt = new Date(value.decidedAt).getTime();
  const expiresAt = new Date(value.expiresAt).getTime();
  return (
    staleAt === validatedAt + 86_400_000 &&
    decidedAt >= staleAt &&
    expiresAt > decidedAt &&
    expiresAt <= decidedAt + 86_400_000
  );
}

function isCoreCheckDetailPrunePayload(value: unknown): value is CoreCheckDetailPrunePayload {
  if (
    !isExactObject(value, [
      "databaseLineageId",
      "cutoffAt",
      "evaluatedAt",
      "maximumEligibleChecks",
      "deletedTransactionCount",
      "deletedOccurrenceCount",
      "deletedFirstSequence",
      "deletedLastSequence",
      "deletedDigest",
      "remainingDetailedCheckCount",
    ]) ||
    typeof value.databaseLineageId !== "string" ||
    !isUuidV7(value.databaseLineageId) ||
    !isUtcInstant(value.cutoffAt) ||
    !isUtcInstant(value.evaluatedAt) ||
    value.maximumEligibleChecks !== 10000 ||
    !isNonNegativeInteger(value.deletedTransactionCount) ||
    value.deletedOccurrenceCount !== Number(value.deletedTransactionCount) * 2 ||
    !isSha256(value.deletedDigest) ||
    !isNonNegativeInteger(value.remainingDetailedCheckCount)
  ) {
    return false;
  }
  const count = Number(value.deletedTransactionCount);
  const first = value.deletedFirstSequence;
  const last = value.deletedLastSequence;
  if (count === 0) {
    if (first !== null || last !== null) return false;
  } else if (
    !isPositiveInteger(first) ||
    !isPositiveInteger(last) ||
    Number(first) > Number(last)
  ) {
    return false;
  }
  return (
    new Date(value.evaluatedAt).getTime() - new Date(value.cutoffAt).getTime() ===
    30 * 86_400_000
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

function isRepositoryCoreAuthorityPayload(value: unknown): value is RepositoryCoreAuthorityPayload {
  if (
    !isExactObject(value, [
      "repositoryId",
      "coreSnapshotId",
      "declarationRecordId",
      "coreAuthorizationRecordId",
      "eventRecordId",
      "sourceCommitId",
      "declarationPath",
      "declarationDigest",
      "owner",
      "name",
      "accountableOwners",
      "fleetState",
      "maintenancePrograms",
      "actionCeiling",
      "surfaceContractVersion",
      "authorizedAt",
    ]) ||
    typeof value.repositoryId !== "string" ||
    !/^github\.com:[1-9][0-9]{0,19}$/.test(value.repositoryId) ||
    typeof value.coreSnapshotId !== "string" ||
    !isUuidV7(value.coreSnapshotId) ||
    typeof value.declarationRecordId !== "string" ||
    !isUuidV7(value.declarationRecordId) ||
    typeof value.coreAuthorizationRecordId !== "string" ||
    !isUuidV7(value.coreAuthorizationRecordId) ||
    typeof value.eventRecordId !== "string" ||
    !isUuidV7(value.eventRecordId) ||
    typeof value.sourceCommitId !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.sourceCommitId) ||
    typeof value.owner !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value.owner) ||
    typeof value.name !== "string" ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(value.name) ||
    value.declarationPath !== `organization/repositories/${value.owner}/${value.name}.json` ||
    !isSha256(value.declarationDigest) ||
    (value.fleetState !== "enabled" && value.fleetState !== "paused" && value.fleetState !== "disabled") ||
    value.surfaceContractVersion !== 1 ||
    !isUtcInstant(value.authorizedAt) ||
    !isRepositoryOwners(value.accountableOwners) ||
    !isClosedUniqueArray(value.maintenancePrograms, ["quality", "ci", "security", "architecture"], 4) ||
    !isClosedUniqueArray(
      value.actionCeiling,
      ["read", "write", "run-tests", "open-issue", "open-pr", "create-followup"],
      6,
    )
  ) {
    return false;
  }
  const repositoryId = value.repositoryId.slice("github.com:".length);
  if (value.fleetState === "enabled") {
    if (value.maintenancePrograms.length === 0 || value.actionCeiling.length === 0) return false;
  }
  return repositoryId.length > 0;
}

function isRepositoryGitHubReconciliationPayload(
  value: unknown,
): value is RepositoryGitHubReconciliationPayload {
  if (
    !isExactObject(value, [
      "repositoryId",
      "coreSnapshotId",
      "coreAuthorizationRecordId",
      "observationRecordId",
      "reconciliationRecordId",
      "eventRecordId",
      "declaredOwner",
      "declaredName",
      "declaredRepositoryId",
      "fleetState",
      "observedOwner",
      "observedName",
      "observedRepositoryId",
      "archived",
      "observedDefaultBranch",
      "result",
      "effectiveState",
      "checkedAt",
      "responseDigest",
    ]) ||
    typeof value.repositoryId !== "string" ||
    !/^github\.com:[1-9][0-9]{0,19}$/.test(value.repositoryId) ||
    typeof value.coreSnapshotId !== "string" ||
    !isUuidV7(value.coreSnapshotId) ||
    typeof value.coreAuthorizationRecordId !== "string" ||
    !isUuidV7(value.coreAuthorizationRecordId) ||
    typeof value.observationRecordId !== "string" ||
    !isUuidV7(value.observationRecordId) ||
    typeof value.reconciliationRecordId !== "string" ||
    !isUuidV7(value.reconciliationRecordId) ||
    typeof value.eventRecordId !== "string" ||
    !isUuidV7(value.eventRecordId) ||
    typeof value.declaredOwner !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value.declaredOwner) ||
    typeof value.declaredName !== "string" ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(value.declaredName) ||
    typeof value.declaredRepositoryId !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(value.declaredRepositoryId) ||
    value.repositoryId !== `github.com:${value.declaredRepositoryId}` ||
    (value.fleetState !== "enabled" && value.fleetState !== "paused" && value.fleetState !== "disabled") ||
    !isUtcInstant(value.checkedAt) ||
    !isSha256(value.responseDigest) ||
    !(["matched", "missing", "locator-mismatch", "identity-mismatch", "archived", "unavailable"] as const).includes(
      value.result as RepositoryGitHubResult,
    )
  ) {
    return false;
  }
  const noObservation =
    value.observedOwner === null &&
    value.observedName === null &&
    value.observedRepositoryId === null &&
    value.archived === null &&
    value.observedDefaultBranch === null;
  if (value.result === "missing" || value.result === "unavailable") {
    if (!noObservation) return false;
  } else {
    if (
      typeof value.observedOwner !== "string" ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value.observedOwner) ||
      typeof value.observedName !== "string" ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(value.observedName) ||
      typeof value.observedRepositoryId !== "string" ||
      !/^[1-9][0-9]{0,19}$/.test(value.observedRepositoryId) ||
      typeof value.archived !== "boolean" ||
      !isRepositoryBranchName(value.observedDefaultBranch)
    ) {
      return false;
    }
    const identityMatches = value.observedRepositoryId === value.declaredRepositoryId;
    const locatorMatches =
      value.observedOwner.toLowerCase() === value.declaredOwner.toLowerCase() &&
      value.observedName.toLowerCase() === value.declaredName.toLowerCase();
    const expectedResult = !identityMatches
      ? "identity-mismatch"
      : !locatorMatches
        ? "locator-mismatch"
        : value.archived
          ? "archived"
          : "matched";
    if (value.result !== expectedResult) return false;
  }
  const expectedState: RepositoryState =
    value.fleetState === "disabled"
      ? "disabled"
      : value.fleetState === "paused"
        ? "paused"
        : value.result === "matched"
          ? "awaiting-surfaces"
          : "github-held";
  return value.effectiveState === expectedState;
}

function isRepositorySurfaceReconciliationPayload(
  value: unknown,
): value is RepositorySurfaceReconciliationPayload {
  const expectedSurfaceIds = [
    "agent-instructions",
    "agent-governance",
    "agent-skills",
    "documentation-index",
  ] as const;
  const expectedRequirementIds = expectedSurfaceIds.map((surfaceId) => `canonical-surface:${surfaceId}`);
  if (
    !isExactObject(value, [
      "repositoryId",
      "coreSnapshotId",
      "coreAuthorizationRecordId",
      "githubReconciliationRecordId",
      "observationRecordId",
      "policyDecisionRecordId",
      "reconciliationRecordId",
      "eventRecordId",
      "defaultBranch",
      "repositoryCommitId",
      "repositoryTreeId",
      "surfaceContractVersion",
      "governanceSchemaVersion",
      "surfaceContractDigest",
      "governanceSchemaDigest",
      "surfaces",
      "governancePolicy",
      "checkpoint",
      "decision",
      "requirementResults",
      "exceptionRecordIds",
      "result",
      "failedSurfaceId",
      "checkedAt",
      "probeDigest",
    ]) ||
    typeof value.repositoryId !== "string" ||
    !/^github\.com:[1-9][0-9]{0,19}$/.test(value.repositoryId) ||
    !isUuid(value.coreSnapshotId) ||
    !isUuid(value.coreAuthorizationRecordId) ||
    !isUuid(value.githubReconciliationRecordId) ||
    !isUuid(value.observationRecordId) ||
    !isUuid(value.policyDecisionRecordId) ||
    !isUuid(value.reconciliationRecordId) ||
    !isUuid(value.eventRecordId) ||
    value.surfaceContractVersion !== 1 ||
    value.governanceSchemaVersion !== 1 ||
    !isSha256(value.surfaceContractDigest) ||
    !isSha256(value.governanceSchemaDigest) ||
    !isSha256(value.probeDigest) ||
    !isUtcInstant(value.checkedAt) ||
    !(["valid", "unavailable", "missing", "wrong-type", "invalid", "digest-incompatible"] as const).includes(
      value.result as RepositorySurfaceResult,
    ) ||
    !Array.isArray(value.surfaces) ||
    value.surfaces.length > 4 ||
    !value.surfaces.every(isRepositorySurfaceSummary) ||
    value.checkpoint !== "repository-enrollment" ||
    (value.decision !== "permit" && value.decision !== "deny") ||
    !Array.isArray(value.requirementResults) ||
    value.requirementResults.length !== 4 ||
    !value.requirementResults.every(isRepositorySurfaceRequirementResult) ||
    !Array.isArray(value.exceptionRecordIds) ||
    value.exceptionRecordIds.length !== 0
  ) {
    return false;
  }
  if (
    value.requirementResults.some(
      (requirement, index) => requirement.requirementId !== expectedRequirementIds[index],
    )
  ) {
    return false;
  }
  if (value.result === "unavailable" || value.result === "digest-incompatible") {
    return (
      value.defaultBranch === null &&
      value.repositoryCommitId === null &&
      value.repositoryTreeId === null &&
      value.surfaces.length === 0 &&
      value.governancePolicy === null &&
      value.failedSurfaceId === null &&
      value.decision === "deny" &&
      value.requirementResults.every(
        (requirement) => requirement.result === "unknown" && requirement.evidenceDigest === null,
      )
    );
  }
  if (
    !isRepositoryBranchName(value.defaultBranch) ||
    typeof value.repositoryCommitId !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.repositoryCommitId) ||
    typeof value.repositoryTreeId !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.repositoryTreeId)
  ) {
    return false;
  }
  const surfaces = value.surfaces as RepositorySurfaceSummary[];
  const ids = surfaces.map((surface) => surface.surfaceId);
  if (new Set(ids).size !== ids.length) return false;
  if (ids.some((surfaceId, index) => surfaceId !== expectedSurfaceIds[index])) return false;
  if (value.result === "valid") {
    return (
      value.surfaces.length === 4 &&
      value.governancePolicy !== null &&
      typeof value.governancePolicy === "object" &&
      !Array.isArray(value.governancePolicy) &&
      value.failedSurfaceId === null &&
      value.decision === "permit" &&
      value.requirementResults.every(
        (requirement, index) =>
          requirement.result === "pass" &&
          requirement.evidenceDigest === surfaces[index]?.contentDigest,
      )
    );
  }
  const failedIndex = expectedSurfaceIds.indexOf(
    value.failedSurfaceId as (typeof expectedSurfaceIds)[number],
  );
  if (failedIndex < 0 || value.surfaces.length !== failedIndex + (value.result === "invalid" ? 1 : 0)) {
    return false;
  }
  return (
    value.governancePolicy === null &&
    value.decision === "deny" &&
    value.requirementResults.every((requirement, index) => {
      if (index < failedIndex) {
        return (
          requirement.result === "pass" &&
          requirement.evidenceDigest === surfaces[index]?.contentDigest
        );
      }
      if (index === failedIndex) {
        return (
          requirement.result === "fail" &&
          requirement.evidenceDigest ===
            (value.result === "invalid" ? surfaces[index]?.contentDigest : null)
        );
      }
      return requirement.result === "unknown" && requirement.evidenceDigest === null;
    })
  );
}

function isRepositoryOperatorHoldDecisionPayload(
  value: unknown,
): value is RepositoryOperatorHoldDecisionPayload {
  if (
    !isExactObject(value, [
      "decisionRecordId",
      "eventRecordId",
      "decisionType",
      "state",
      "choice",
      "repositoryId",
      "coreSnapshotId",
      "coreAuthorizationRecordId",
      "declarationDigest",
      "operatorPrincipalId",
      "holdDecisionId",
      "previousDecisionRecordId",
      "affectedGates",
      "recoveryRule",
      "reason",
      "expectedLastTransactionSequence",
      "decidedAt",
    ]) ||
    !isUuid(value.decisionRecordId) ||
    !isUuid(value.eventRecordId) ||
    value.decisionType !== "repository-local-hold" ||
    value.state !== "resolved" ||
    (value.choice !== "impose" && value.choice !== "clear") ||
    typeof value.repositoryId !== "string" ||
    !/^github\.com:[1-9][0-9]{0,19}$/.test(value.repositoryId) ||
    !isUuid(value.coreSnapshotId) ||
    !isUuid(value.coreAuthorizationRecordId) ||
    !isSha256(value.declarationDigest) ||
    !isUuid(value.operatorPrincipalId) ||
    !isUuid(value.holdDecisionId) ||
    !(value.previousDecisionRecordId === null || isUuid(value.previousDecisionRecordId)) ||
    !Array.isArray(value.affectedGates) ||
    value.affectedGates.length !== repositoryHoldGates.length ||
    value.affectedGates.some((gate, index) => gate !== repositoryHoldGates[index]) ||
    value.recoveryRule !== "operator-clear" ||
    !isBoundedDiagnostic(value.reason) ||
    value.reason !== value.reason.trim() ||
    /[\u0000-\u001f\u007f]/.test(value.reason) ||
    !Number.isSafeInteger(value.expectedLastTransactionSequence) ||
    Number(value.expectedLastTransactionSequence) < 1 ||
    !isUtcInstant(value.decidedAt)
  ) {
    return false;
  }
  return value.choice === "impose"
    ? value.decisionRecordId === value.holdDecisionId && value.previousDecisionRecordId === null
    : value.decisionRecordId !== value.holdDecisionId && value.previousDecisionRecordId === value.holdDecisionId;
}

function isGitHubDeliveryReceiptPayload(value: unknown): value is GitHubDeliveryReceiptPayload {
  if (
    !isExactObject(value, [
      "appId",
      "hookSubjectId",
      "deliveryGuid",
      "event",
      "action",
      "installationId",
      "repositoryId",
      "bodyDigest",
      "requestBytes",
      "signatureVerification",
      "disposition",
      "receiptRecordId",
      "observationRecordId",
      "eventRecordId",
      "receivedAt",
    ])
  ) {
    return false;
  }
  return (
    isGitHubNumericId(value.appId) &&
    value.hookSubjectId === `github.com:app:${String(value.appId)}:hook` &&
    isGitHubDeliveryGuid(value.deliveryGuid) &&
    value.event === "pull_request" &&
    githubPullRequestActions.includes(value.action as GitHubPullRequestAction) &&
    isGitHubInstallationId(value.installationId) &&
    isGitHubRepositoryId(value.repositoryId) &&
    isSha256(value.bodyDigest) &&
    isPositiveInteger(value.requestBytes) &&
    Number(value.requestBytes) <= 25 * 1024 * 1024 &&
    value.signatureVerification === "sha256-verified" &&
    value.disposition === "pull-request-observation-recorded" &&
    isUuid(value.receiptRecordId) &&
    isUuid(value.observationRecordId) &&
    isUuid(value.eventRecordId) &&
    new Set([value.receiptRecordId, value.observationRecordId, value.eventRecordId]).size === 3 &&
    isUtcInstant(value.receivedAt)
  );
}

function isGitHubPullRequestObservationPayload(
  value: unknown,
): value is GitHubPullRequestObservationPayload {
  if (
    !isExactObject(value, [
      "repositoryId",
      "pullRequestId",
      "pullRequestNumber",
      "action",
      "installationId",
      "actorId",
      "state",
      "draft",
      "merged",
      "baseRepositoryId",
      "baseRef",
      "baseCommitId",
      "headRepositoryId",
      "headRef",
      "headCommitId",
      "observedTestMergeCommitId",
      "mergedAt",
      "mergeCommitId",
      "sourceUpdatedAt",
      "deliveryGuid",
      "receiptRecordId",
      "observationRecordId",
      "observationDigest",
      "observedAt",
    ])
  ) {
    return false;
  }
  if (
    !isGitHubRepositoryId(value.repositoryId) ||
    !isPositiveInteger(value.pullRequestNumber) ||
    value.pullRequestId !== `${String(value.repositoryId)}:pull:${String(value.pullRequestNumber)}` ||
    !githubPullRequestActions.includes(value.action as GitHubPullRequestAction) ||
    !isGitHubInstallationId(value.installationId) ||
    !isGitHubUserId(value.actorId) ||
    (value.state !== "open" && value.state !== "closed") ||
    typeof value.draft !== "boolean" ||
    typeof value.merged !== "boolean" ||
    value.baseRepositoryId !== value.repositoryId ||
    value.headRepositoryId !== value.repositoryId ||
    !isRepositoryBranchName(value.baseRef) ||
    !isGitCommitId(value.baseCommitId) ||
    !isRepositoryBranchName(value.headRef) ||
    !isGitCommitId(value.headCommitId) ||
    !(value.observedTestMergeCommitId === null || isGitCommitId(value.observedTestMergeCommitId)) ||
    !(value.mergedAt === null || isUtcInstant(value.mergedAt)) ||
    !(value.mergeCommitId === null || isGitCommitId(value.mergeCommitId)) ||
    !isUtcInstant(value.sourceUpdatedAt) ||
    !isGitHubDeliveryGuid(value.deliveryGuid) ||
    !isUuid(value.receiptRecordId) ||
    !isUuid(value.observationRecordId) ||
    !isSha256(value.observationDigest) ||
    !isUtcInstant(value.observedAt)
  ) {
    return false;
  }
  if (value.action === "closed" && value.state !== "closed") return false;
  if (
    value.action !== "closed" &&
    value.action !== "edited" &&
    value.state !== "open"
  ) {
    return false;
  }
  if (value.state === "open") {
    return !value.merged && value.mergedAt === null && value.mergeCommitId === null;
  }
  if (value.observedTestMergeCommitId !== null) return false;
  return value.merged
    ? value.mergedAt !== null && value.mergeCommitId !== null
    : value.mergedAt === null && value.mergeCommitId === null;
}

function isGitHubDeliveryRecordedPayload(value: unknown): value is GitHubDeliveryRecordedPayload {
  return (
    isExactObject(value, [
      "deliveryGuid",
      "receiptRecordId",
      "observationRecordId",
      "eventRecordId",
      "disposition",
      "recordedAt",
    ]) &&
    isGitHubDeliveryGuid(value.deliveryGuid) &&
    isUuid(value.receiptRecordId) &&
    isUuid(value.observationRecordId) &&
    isUuid(value.eventRecordId) &&
    new Set([value.receiptRecordId, value.observationRecordId, value.eventRecordId]).size === 3 &&
    value.disposition === "pull-request-observation-recorded" &&
    isUtcInstant(value.recordedAt)
  );
}

function isGitHubSourceCheckpointPayload(value: unknown): value is GitHubSourceCheckpointPayload {
  if (
    !isExactObject(value, [
      "repositoryId",
      "scope",
      "appId",
      "installationId",
      "runId",
      "previousCheckpointRecordId",
      "coveredFrom",
      "coveredThrough",
      "pageCount",
      "deliveryCount",
      "pageProofDigest",
      "selectedResponseDigest",
      "checkpointDigest",
      "checkpointRecordId",
      "recordedAt",
    ]) ||
    !isGitHubRepositoryId(value.repositoryId) ||
    value.scope !== githubSourceScope ||
    !isGitHubNumericId(value.appId) ||
    !isGitHubInstallationId(value.installationId) ||
    !isUuid(value.runId) ||
    !(value.previousCheckpointRecordId === null || isUuid(value.previousCheckpointRecordId)) ||
    !isUtcInstant(value.coveredFrom) ||
    !isUtcInstant(value.coveredThrough) ||
    !isPositiveInteger(value.pageCount) ||
    !isNonNegativeInteger(value.deliveryCount) ||
    !isSha256(value.pageProofDigest) ||
    !isSha256(value.selectedResponseDigest) ||
    !isSha256(value.checkpointDigest) ||
    !isUuid(value.checkpointRecordId) ||
    !isUtcInstant(value.recordedAt)
  ) {
    return false;
  }
  return new Date(value.coveredFrom).getTime() <= new Date(value.coveredThrough).getTime();
}

function isGitHubSourceGapPayload(value: unknown): value is GitHubSourceGapPayload {
  return (
    isExactObject(value, [
      "repositoryId",
      "scope",
      "appId",
      "installationId",
      "runId",
      "checkpointRecordId",
      "gapId",
      "gapRecordId",
      "lowerBoundAt",
      "upperBoundAt",
      "cause",
      "gapDigest",
      "detectedAt",
    ]) &&
    isGitHubRepositoryId(value.repositoryId) &&
    value.scope === githubSourceScope &&
    isGitHubNumericId(value.appId) &&
    isGitHubInstallationId(value.installationId) &&
    isUuid(value.runId) &&
    isUuid(value.checkpointRecordId) &&
    isUuid(value.gapId) &&
    value.gapRecordId === value.gapId &&
    isUtcInstant(value.lowerBoundAt) &&
    value.upperBoundAt === null &&
    githubSourceGapCauses.includes(value.cause as GitHubSourceGapCause) &&
    isSha256(value.gapDigest) &&
    isUtcInstant(value.detectedAt) &&
    new Date(value.detectedAt).getTime() >= new Date(value.lowerBoundAt).getTime()
  );
}

function isGitHubSourceGapRepairPayload(value: unknown): value is GitHubSourceGapRepairPayload {
  if (
    !isExactObject(value, [
      "repositoryId",
      "scope",
      "appId",
      "installationId",
      "runId",
      "gapId",
      "gapRecordId",
      "priorCheckpointRecordId",
      "checkpointRecordId",
      "repairRecordId",
      "eventRecordId",
      "lowerBoundAt",
      "exclusiveEndAt",
      "repairMethod",
      "repairDigest",
      "repairedAt",
    ]) ||
    !isGitHubRepositoryId(value.repositoryId) ||
    value.scope !== githubSourceScope ||
    !isGitHubNumericId(value.appId) ||
    !isGitHubInstallationId(value.installationId) ||
    !isUuid(value.runId) ||
    !isUuid(value.gapId) ||
    value.gapRecordId !== value.gapId ||
    !isUuid(value.priorCheckpointRecordId) ||
    !isUuid(value.checkpointRecordId) ||
    !isUuid(value.repairRecordId) ||
    !isUuid(value.eventRecordId) ||
    new Set([value.checkpointRecordId, value.repairRecordId, value.eventRecordId]).size !== 3 ||
    !isUtcInstant(value.lowerBoundAt) ||
    !isUtcInstant(value.exclusiveEndAt) ||
    value.repairMethod !== "complete-delivery-audit" ||
    !isSha256(value.repairDigest) ||
    !isUtcInstant(value.repairedAt)
  ) {
    return false;
  }
  const lower = new Date(value.lowerBoundAt).getTime();
  const end = new Date(value.exclusiveEndAt).getTime();
  return end > lower && new Date(value.repairedAt).getTime() >= end;
}

function isRepositorySurfaceRequirementResult(value: unknown): value is RepositorySurfaceRequirementResult {
  if (
    !isExactObject(value, ["requirementId", "surfaceId", "result", "evidenceDigest"]) ||
    typeof value.surfaceId !== "string" ||
    !(value.result === "pass" || value.result === "fail" || value.result === "unknown") ||
    !(value.evidenceDigest === null || isSha256(value.evidenceDigest))
  ) {
    return false;
  }
  return (
    ["agent-instructions", "agent-governance", "agent-skills", "documentation-index"].includes(
      value.surfaceId,
    ) && value.requirementId === `canonical-surface:${value.surfaceId}`
  );
}

function isRepositorySurfaceSummary(value: unknown): value is RepositorySurfaceSummary {
  if (
    !isExactObject(value, ["surfaceId", "path", "artifactType", "objectId", "contentDigest", "size"]) ||
    typeof value.surfaceId !== "string" ||
    typeof value.path !== "string" ||
    (value.artifactType !== "file" && value.artifactType !== "directory") ||
    typeof value.objectId !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.objectId) ||
    !isSha256(value.contentDigest) ||
    !Number.isSafeInteger(value.size) ||
    Number(value.size) < 0
  ) {
    return false;
  }
  const expected = {
    "agent-instructions": ["AGENTS.md", "file"],
    "agent-governance": ["policies/agent-governance.json", "file"],
    "agent-skills": [".agents/skills", "directory"],
    "documentation-index": ["docs/README.md", "file"],
  } as const;
  const contract = expected[value.surfaceId as keyof typeof expected];
  return Boolean(contract && value.path === contract[0] && value.artifactType === contract[1]);
}

function isRepositoryEnrollmentPayload(value: unknown): value is RepositoryEnrollmentPayload {
  return (
    isExactObject(value, [
      "repositoryId",
      "coreSnapshotId",
      "coreAuthorizationRecordId",
      "githubReconciliationRecordId",
      "surfaceReconciliationRecordId",
      "surfacePolicyDecisionRecordId",
      "controllerDefinitionRecordId",
      "enrollmentRecordId",
      "eventRecordId",
      "repositoryCommitId",
      "surfaceContractVersion",
      "maintenancePrograms",
      "actionCeiling",
      "enrolledAt",
    ]) &&
    typeof value.repositoryId === "string" &&
    /^github\.com:[1-9][0-9]{0,19}$/.test(value.repositoryId) &&
    isUuid(value.coreSnapshotId) &&
    isUuid(value.coreAuthorizationRecordId) &&
    isUuid(value.githubReconciliationRecordId) &&
    isUuid(value.surfaceReconciliationRecordId) &&
    isUuid(value.surfacePolicyDecisionRecordId) &&
    isUuid(value.controllerDefinitionRecordId) &&
    isUuid(value.enrollmentRecordId) &&
    isUuid(value.eventRecordId) &&
    typeof value.repositoryCommitId === "string" &&
    /^[0-9a-f]{40}$/.test(value.repositoryCommitId) &&
    value.surfaceContractVersion === 1 &&
    isClosedUniqueArray(value.maintenancePrograms, ["quality", "ci", "security", "architecture"], 4) &&
    value.maintenancePrograms.length > 0 &&
    isClosedUniqueArray(
      value.actionCeiling,
      ["read", "write", "run-tests", "open-issue", "open-pr", "create-followup"],
      6,
    ) &&
    value.actionCeiling.length > 0 &&
    isUtcInstant(value.enrolledAt)
  );
}

function isRepositoryBranchName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock")
  );
}

function isGitHubAppHookId(value: string): boolean {
  return /^github\.com:app:[1-9][0-9]{0,19}:hook$/.test(value);
}

function isGitHubNumericId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
}

function isGitHubRepositoryId(value: unknown): value is string {
  return typeof value === "string" && /^github\.com:[1-9][0-9]{0,19}$/.test(value);
}

function isGitHubInstallationId(value: unknown): value is string {
  return typeof value === "string" && /^github\.com:installation:[1-9][0-9]{0,19}$/.test(value);
}

function isGitHubUserId(value: unknown): value is string {
  return typeof value === "string" && /^github\.com:user:[1-9][0-9]{0,19}$/.test(value);
}

function isGitHubDeliveryGuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function isGitCommitId(value: unknown): value is string {
  return typeof value === "string" && /^sha1:[0-9a-f]{40}$/.test(value);
}

function isGitHubPullRequestId(value: string): boolean {
  return /^github\.com:[1-9][0-9]{0,19}:pull:[1-9][0-9]{0,19}$/.test(value);
}

function isGitHubCheckRunId(value: string): boolean {
  return /^github\.com:[1-9][0-9]{0,19}:check-run:[1-9][0-9]{0,19}$/.test(value);
}

function isGitHubCommitStatusId(value: string): boolean {
  return /^github\.com:[1-9][0-9]{0,19}:commit-status:[1-9][0-9]{0,19}$/.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && isUuidV7(value);
}

function isRepositoryOwners(value: unknown): value is RepositoryAccountableOwner[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) return false;
  const identities = new Set<string>();
  for (const owner of value) {
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) return false;
    if (
      isExactObject(owner, ["kind", "login"]) &&
      owner.kind === "github-user" &&
      typeof owner.login === "string" &&
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner.login)
    ) {
      identities.add(`github-user:${owner.login.toLowerCase()}`);
      continue;
    }
    if (
      isExactObject(owner, ["kind", "slug"]) &&
      owner.kind === "github-team" &&
      typeof owner.slug === "string" &&
      /^[a-z0-9](?:[a-z0-9-]{0,99})$/.test(owner.slug)
    ) {
      identities.add(`github-team:${owner.slug}`);
      continue;
    }
    return false;
  }
  return identities.size === value.length;
}

function isClosedUniqueArray(value: unknown, allowed: readonly string[], maximum: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    value.every((entry) => typeof entry === "string" && allowed.includes(entry)) &&
    new Set(value).size === value.length
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
