import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { backup as sqliteBackup, DatabaseSync, type SQLInputValue } from "node:sqlite";

import { canonicalJson, isUuidV7, sha256, uuidV7, type JsonValue } from "./encoding.ts";
import {
  CORE_CHECK_DETAIL_MAXIMUM_ELIGIBLE_CHECKS,
  coreCheckDetailCutoff,
  selectCoreCheckDetailForPrune,
} from "./check-detail-retention.ts";
import {
  assertRepositoryDeclarationRetention,
  validateCoreCatalog,
  validatedRepositorySurfaceContract,
  validateRepositoryGovernanceBytes,
  type CoreTreeEntry,
  type RepositoryDeclaration,
  type RepositorySurfaceContract,
  type ValidatedRepositoryDeclaration,
} from "../core/validator.ts";
import type { InspectedCoreCandidate } from "../core/git-source.ts";
import {
  CORE_POLL_DEFAULT_INTERVAL_SECONDS,
  CORE_POLL_LEASE_SECONDS,
  CORE_POLL_MAXIMUM_INTERVAL_SECONDS,
  CORE_POLL_MINIMUM_INTERVAL_SECONDS,
  CORE_POLL_PRUNE_INTERVAL_SECONDS,
  addSeconds,
  corePollDelaySeconds,
} from "../core/poll-policy.ts";
import {
  CONTROL_PLANE_APPLICATION_ID,
  CONTROL_PLANE_REGISTRY_VERSION,
  CONTROL_PLANE_SCHEMA_VERSION,
  assertInformationClass,
  assertRevision,
  assertSource,
  assertSourceRevision,
  assertSubject,
  commandKindRegistry,
  eventKindRegistry,
  informationClassAtLeast,
  projectionContractRegistry,
  recordClasses,
  recordKindRegistry,
  type InformationClass,
  type CoreCandidateRejectionCode,
  type CoreCandidateRejectionPayload,
  type CoreCandidateRejectionStage,
  type CoreCheckDetailPrunePayload,
  type CoreRollbackActivatedPayload,
  type CoreRollbackDecisionPayload,
  type CoreSourceCheckEligiblePayload,
  type CoreStaleSourceOverrideDecisionPayload,
  type RepositoryCoreAuthorityPayload,
  type RepositoryAccountableOwner,
  type RepositoryGitHubReconciliationPayload,
  type RepositoryGitHubResult,
  type RepositoryEnrollmentPayload,
  type RepositoryOperatorHoldDecisionPayload,
  type RepositoryState,
  type RepositorySurfaceReconciliationPayload,
  type RepositorySurfaceRequirementResult,
  type RepositorySurfaceResult,
  type RepositorySurfaceSummary,
  type ProjectionName,
  type RecordClass,
  type SubjectKind,
  repositoryHoldGates,
} from "./registry.ts";
import {
  repositoryGitBlobObjectId,
  repositoryGitTreeObjectId,
  surfaceTreeDigest,
  type RepositorySurfaceProbeInput,
  type RepositorySurfaceTreeEntry,
} from "../repository/surfaces.ts";
import { repositoryAuthorityContextDigest } from "../repository/authority-context.ts";

type Row = Record<string, SQLInputValue>;

const BUSY_TIMEOUT_MS = 5_000;
const TARGET_TABLES = [
  "core_active_snapshot",
  "core_poll_state",
  "core_snapshot_files",
  "core_snapshots",
  "control_plane_metadata",
  "control_transactions",
  "durable_occurrences",
  "durable_records",
  "event_ledger",
  "idempotency_receipts",
  "projection_event_cursor",
  "projection_generations",
  "projection_heads",
  "projection_subject_lookup",
  "subjects",
] as const;
const SPIKE_TABLES = new Set(["repositories", "work_items", "work_events"]);
const IDEMPOTENCY_RETAINED_UNTIL = "9999-12-31T23:59:59.999Z";

export type ControlPlaneFaultPoint =
  | "after-core-check-detail-delete"
  | "after-core-snapshot-files"
  | "after-integrity-observation"
  | "after-projection-shadow-write";

export interface ControlPlaneMetadata {
  applicationId: number;
  schemaVersion: number;
  registryVersion: number;
  databaseLineageId: string;
  operatorPrincipalId: string;
  createdAt: string;
  controlTimeWatermark: string;
  lastTransactionSequence: number;
}

export interface DurableOccurrence {
  recordId: string;
  occurrenceType: "record" | "event";
  kind: string;
  schemaVersion: number;
  recordClass?: RecordClass;
  subjectKind: string;
  subjectId: string;
  revisionKind?: string;
  revisionValue?: string;
  sourceKind: string;
  sourceId: string;
  sourceRevisionKind?: string;
  sourceRevisionValue?: string;
  informationClass: InformationClass;
  informationScope: JsonValue;
  payload: JsonValue;
  payloadDigest: string;
  correlationId: string;
  transactionSequence: number;
  transactionPosition: number;
  recordedAt: string;
}

export interface IntegrityCheckInput {
  expectedLastTransactionSequence: number;
  idempotencyKey: string;
}

export interface IntegrityCheckResult {
  checkedThroughSequence: number;
  eventRecordId: string;
  evaluationTime: string;
  observationRecordId: string;
  recordedTime: string;
  result: "ok";
  transactionPositions: readonly [0, 1];
  transactionSequence: number;
}

export interface CoreSnapshotActivationInput {
  candidate: InspectedCoreCandidate;
  expectedLastTransactionSequence: number;
  /** Set only after the source adapter verifies Git ancestry for a new activation. */
  continuityAncestorCommitId?: string;
}

export interface CoreSnapshotActivationResult {
  snapshotId: string;
  definitionRecordId: string;
  activeFactRecordId: string;
  eventRecordId: string;
  catalogDigest: string;
  sourceCommitId: string;
  importedAt: string;
  transactionPositions: readonly [0, 1, 2];
  transactionSequence: number;
}

export interface CoreSnapshotRollbackInput {
  candidate: InspectedCoreCandidate;
  expectedLastTransactionSequence: number;
  reason: string;
}

export interface CoreSnapshotRollbackResult {
  decisionRecordId: string;
  snapshotId: string;
  definitionRecordId: string;
  activeFactRecordId: string;
  eventRecordId: string;
  catalogDigest: string;
  sourceCommitId: string;
  previousSnapshotId: string;
  previousSourceCommitId: string;
  operatorPrincipalId: string;
  reason: string;
  importedAt: string;
  transactionPositions: readonly [0, 1, 2, 3];
  transactionSequence: number;
}

export class CoreSnapshotPersistenceError extends Error {
  constructor(readonly diagnostic: string) {
    super(`Core snapshot persistence failed: ${diagnostic}`);
    this.name = "CoreSnapshotPersistenceError";
  }
}

export interface CoreCandidateRejectionInput {
  checkId: string;
  operation: "automatic-source-check" | "operator-rollback";
  stage: CoreCandidateRejectionStage;
  code: CoreCandidateRejectionCode;
  summary: string;
  details: readonly string[];
  sourceUrl: string;
  sourceRef: string;
  commitId?: string;
  treeId?: string;
  catalogDigest?: string;
  activeCommitId?: string;
}

export interface CoreCandidateRejectionResult {
  checkId: string;
  observationRecordId: string;
  eventRecordId: string;
  observedAt: string;
  transactionPositions: readonly [0, 1];
  transactionSequence: number;
}

export interface CoreCandidateRejectionRecord extends CoreCandidateRejectionPayload {
  observationRecordId: string;
  transactionSequence: number;
  transactionPosition: 0;
}

export interface CoreSourceCheckEligibleInput {
  checkId: string;
  candidate: InspectedCoreCandidate;
  expectedLastTransactionSequence: number;
}

export interface CoreSourceCheckEligibleResult {
  checkId: string;
  observationRecordId: string;
  eventRecordId: string;
  checkedAt: string;
  transactionPositions: readonly [0, 1];
  transactionSequence: number;
}

export type CoreSourceCheckOutcome =
  | "eligible"
  | "source-unavailable"
  | "candidate-invalid"
  | "continuity-blocked"
  | "persistence-failed";

export type CorePollRunStatus = "completed" | "controller-error";
export type CorePollCheckDisposition = "recorded" | "suppressed" | "record-failed" | "none";

export interface CorePollState {
  scheduleVersion: 1;
  healthyIntervalSeconds: number;
  nextPollAt: string;
  nextPruneAt: string;
  sourceUnavailableStreak: number;
  inFlightRunId: string | null;
  inFlightStartedAt: string | null;
  inFlightExpiresAt: string | null;
  lastRunId: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastRunStatus: CorePollRunStatus | null;
  lastSourceOutcome: CoreSourceCheckOutcome | null;
  lastCheckDisposition: CorePollCheckDisposition | null;
  completedRunCount: number;
  suppressedCheckCount: number;
}

export type CorePollClaimResult =
  | {
      status: "claimed";
      runId: string;
      startedAt: string;
      expiresAt: string;
      controlPlaneSequence: number;
      pruneDue: boolean;
      state: CorePollState;
    }
  | { status: "not-due"; nextPollAt: string; state: CorePollState }
  | { status: "in-flight"; runId: string; expiresAt: string; state: CorePollState };

export interface CorePollCompletionInput {
  runId: string;
  runStatus: CorePollRunStatus;
  sourceOutcome: CoreSourceCheckOutcome | null;
  checkDisposition: CorePollCheckDisposition;
  pruneRan: boolean;
}

export type CoreAdmissionReadinessReason =
  | "ready"
  | "no-active-snapshot"
  | "source-stale"
  | "candidate-invalid"
  | "continuity-blocked"
  | "persistence-failed";

export interface CoreAdmissionReadiness {
  ready: boolean;
  reason: CoreAdmissionReadinessReason;
  evaluatedAt: string;
  controlPlaneSequence: number;
  activeSnapshotId: string | null;
  activeSourceCommitId: string | null;
  latestCheckId: string | null;
  latestCheckOutcome: CoreSourceCheckOutcome | null;
  latestCheckedAt: string | null;
  lastValidatedAt: string | null;
  maximumStalenessSeconds: 86400;
  staleAt: string | null;
  overrideDecisionId: string | null;
  overrideExpiresAt: string | null;
  degraded: boolean;
}

export interface CoreStaleSourceOverrideInput {
  expectedLastTransactionSequence: number;
  expiresAt: string;
  reason: string;
}

export interface CoreStaleSourceOverrideResult {
  decisionRecordId: string;
  eventRecordId: string;
  activeSnapshotId: string;
  operatorPrincipalId: string;
  reason: string;
  decidedAt: string;
  expiresAt: string;
  transactionPositions: readonly [0, 1];
  transactionSequence: number;
}

export interface CoreCheckDetailPruneInput {
  expectedLastTransactionSequence: number;
}

export interface CoreCheckDetailPruneResult {
  observationRecordId: string;
  eventRecordId: string;
  cutoffAt: string;
  evaluatedAt: string;
  maximumEligibleChecks: 10000;
  deletedTransactionCount: number;
  deletedOccurrenceCount: number;
  deletedFirstSequence: number | null;
  deletedLastSequence: number | null;
  deletedDigest: string;
  remainingDetailedCheckCount: number;
  transactionPositions: readonly [0, 1];
  transactionSequence: number;
}

export interface ActiveCoreSnapshot {
  snapshotId: string;
  sourceCommitId: string;
  sourceTreeId: string;
  catalogDigest: string;
  activatedAt: string;
  transactionSequence: number;
}

export interface ActiveCoreRepositoryCatalog {
  snapshot: ActiveCoreSnapshot;
  repositories: ValidatedRepositoryDeclaration[];
}

export interface ActiveCoreSurfaceContract {
  coreSnapshotId: string;
  coreSourceCommitId: string;
  contract: RepositorySurfaceContract;
  contractDigest: string;
  governanceSchemaDigest: string;
}

export interface RepositoryCoreAuthorityInput {
  expectedLastTransactionSequence: number;
  coreSnapshotId: string;
  repositoryId: string;
}

export interface RepositoryCoreAuthorityResult {
  repositoryId: string;
  coreSnapshotId: string;
  declarationRecordId: string;
  coreAuthorizationRecordId: string;
  eventRecordId: string;
  authorizedAt: string;
  transactionPositions: readonly [0, 1, 2];
  transactionSequence: number;
}

export type RepositoryGitHubInspectionInput =
  | { kind: "missing" }
  | { kind: "unavailable" }
  | {
      kind: "found";
      repositoryId: string;
      owner: string;
      name: string;
      archived: boolean;
      defaultBranch: string;
    };

export interface RepositoryGitHubReconciliationInput {
  expectedLastTransactionSequence: number;
  coreAuthorizationRecordId: string;
  inspection: RepositoryGitHubInspectionInput;
}

export interface RepositoryGitHubReconciliationResult {
  repositoryId: string;
  coreSnapshotId: string;
  coreAuthorizationRecordId: string;
  observationRecordId: string;
  reconciliationRecordId: string;
  eventRecordId: string;
  result: RepositoryGitHubResult;
  effectiveState: RepositoryState;
  checkedAt: string;
  responseDigest: string;
  transactionPositions: readonly [0, 1, 2];
  transactionSequence: number;
}

export interface RepositorySurfaceReconciliationInput {
  expectedLastTransactionSequence: number;
  githubReconciliationRecordId: string;
  probe: RepositorySurfaceProbeInput;
}

export interface RepositorySurfaceReconciliationResult {
  repositoryId: string;
  coreSnapshotId: string;
  coreAuthorizationRecordId: string;
  githubReconciliationRecordId: string;
  observationRecordId: string;
  policyDecisionRecordId: string;
  reconciliationRecordId: string;
  eventRecordId: string;
  result: RepositorySurfaceResult;
  repositoryCommitId: string | null;
  checkedAt: string;
  probeDigest: string;
  transactionPositions: readonly [0, 1, 2, 3];
  transactionSequence: number;
}

export interface RepositoryEnrollmentInput {
  expectedLastTransactionSequence: number;
  surfaceReconciliationRecordId: string;
}

export interface RepositoryEnrollmentResult {
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
  enrolledAt: string;
  transactionPositions: readonly [0, 1, 2];
  transactionSequence: number;
}

export interface RepositoryOperatorHoldInput {
  expectedLastTransactionSequence: number;
  repositoryId: string;
  reason: string;
}

export interface RepositoryOperatorHoldClearInput extends RepositoryOperatorHoldInput {
  holdDecisionId: string;
}

export interface RepositoryOperatorHoldResult {
  decisionRecordId: string;
  eventRecordId: string;
  repositoryId: string;
  coreSnapshotId: string;
  coreAuthorizationRecordId: string;
  operatorPrincipalId: string;
  holdDecisionId: string;
  choice: "impose" | "clear";
  reason: string;
  decidedAt: string;
  transactionPositions: readonly [0, 1];
  transactionSequence: number;
}

export interface RepositoryStatus {
  repositoryId: string;
  owner: string;
  name: string;
  coreSnapshotId: string;
  coreAuthorizationRecordId: string | null;
  fleetState: RepositoryDeclaration["fleet_state"];
  maintenancePrograms: RepositoryDeclaration["maintenance_programs"];
  actionCeiling: RepositoryDeclaration["action_ceiling"];
  accountableOwners: RepositoryDeclaration["accountable_owners"];
  surfaceContractVersion: 1;
  githubReconciliationRecordId: string | null;
  githubResult: RepositoryGitHubResult | null;
  githubDefaultBranch: string | null;
  surfaceReconciliationRecordId: string | null;
  surfacePolicyDecisionRecordId: string | null;
  surfaceResult: RepositorySurfaceResult | null;
  repositoryCommitId: string | null;
  enrollmentRecordId: string | null;
  authorityContextDigest: string | null;
  operatorHold: RepositoryOperatorHoldDecisionPayload | null;
  effectiveState: RepositoryState;
}

export interface ProjectionAccess {
  maximumInformationClass: InformationClass;
  deploymentIds: readonly string[];
}

export interface ProjectionGeneration {
  projectionName: ProjectionName;
  generationId: string;
  contractVersion: number;
  transformationVersion: number;
  informationHandlingVersion: number;
  sourceSequence: number;
  sourceDigest: string;
  outputDigest: string;
  evaluationTime: string;
  builtAt: string;
  rowCount: number;
  invariantResult: "ok";
}

export interface ProjectionHealth {
  projectionName: ProjectionName;
  activeGenerationId?: string;
  sourceSequence?: number;
  currentSequence: number;
  lag: number;
  status: "current" | "stale" | "unavailable" | "invalid";
  detail?: string;
}

export interface ProjectedSubject {
  subjectKind: string;
  subjectId: string;
  createdTransactionSequence: number;
  definitionRecordId: string;
  informationClass: InformationClass;
  informationScope: JsonValue;
}

export interface ProjectedEvent {
  recordId: string;
  kind: string;
  schemaVersion: number;
  subjectKind: string;
  subjectId: string;
  correlationId: string;
  informationClass: InformationClass;
  informationScope: JsonValue;
  transactionSequence: number;
  transactionPosition: number;
  recordedAt: string;
}

export interface ProjectionReadResult<T> {
  generation: ProjectionGeneration;
  stale: boolean;
  rows: T[];
}

export interface ControlPlaneBackupManifest {
  formatVersion: 1;
  backupPath: string;
  databaseLineageId: string;
  schemaVersion: number;
  registryVersion: number;
  lastTransactionSequence: number;
  nextTransactionSequence: number;
  controlTimeWatermark: string;
  authoritativeDigest: string;
  createdAt: string;
}

export interface ControlPlaneBackupVerification {
  manifest: ControlPlaneBackupManifest;
  quickCheck: "ok";
  projectionHealth: ProjectionHealth[];
}

export function controlPlaneDatabasePath(): string {
  const target = process.env.FLUENT_CONTROL_DB ?? resolve("./data/control-plane.db");
  if (target === ":memory:") return target;
  const resolvedTarget = resolve(target);
  const spike = resolve(process.env.FLUENT_QUEUE_DB ?? "./data/queue.db");
  if (resolvedTarget === spike) throw new Error("control-plane database path must differ from the queue-spike path");
  return resolvedTarget;
}

export class ControlPlaneStore {
  private readonly db: DatabaseSync;
  private readonly databasePath: string;

  constructor(
    path: string,
    private readonly clock: () => Date = () => new Date(),
    /** Test-only failure injection; production callers omit it. */
    private readonly faultInjector?: (point: ControlPlaneFaultPoint) => void,
    /** Internal projection-repair startup; use openForProjectionRepair(). */
    projectionRepairStartup = false,
  ) {
    this.databasePath = path === ":memory:" ? path : resolve(path);
    if (this.databasePath !== ":memory:") mkdirSync(dirname(this.databasePath), { recursive: true });
    this.db = new DatabaseSync(this.databasePath);

    try {
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      const applicationId = this.pragmaNumber("application_id");
      const tables = this.applicationTables();

      if (applicationId === 0 && tables.length === 0) {
        this.db.exec("PRAGMA journal_mode = WAL");
        this.initialize();
      } else {
        if (applicationId !== CONTROL_PLANE_APPLICATION_ID) {
          const detail = tables.some((table) => SPIKE_TABLES.has(table)) ? "queue-spike database" : "non-Fluent database";
          throw new Error(`refusing to open ${detail} as the control-plane database`);
        }
        this.db.exec("PRAGMA journal_mode = WAL");
        this.verifyExisting(tables, !projectionRepairStartup);
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  static openForProjectionRepair(path: string, clock: () => Date = () => new Date()): ControlPlaneStore {
    return new ControlPlaneStore(path, clock, undefined, true);
  }

  close(): void {
    this.db.close();
  }

  metadata(): ControlPlaneMetadata {
    const row = this.db.prepare("SELECT * FROM control_plane_metadata WHERE singleton = 1").get() as Row | undefined;
    if (!row) throw new Error("control-plane metadata is missing");
    return {
      applicationId: Number(row.application_id),
      schemaVersion: Number(row.schema_version),
      registryVersion: Number(row.registry_version),
      databaseLineageId: String(row.database_lineage_id),
      operatorPrincipalId: String(row.operator_principal_id),
      createdAt: String(row.created_at),
      controlTimeWatermark: String(row.control_time_watermark),
      lastTransactionSequence: Number(row.last_transaction_sequence),
    };
  }

  corePollState(): CorePollState {
    const row = this.db.prepare("SELECT * FROM core_poll_state WHERE singleton = 1").get() as Row | undefined;
    if (!row) throw new Error("Core poll state is missing");
    return decodeCorePollState(row);
  }

  claimCorePoll(healthyIntervalSeconds: number): CorePollClaimResult {
    assertCorePollInterval(healthyIntervalSeconds);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.verifyExisting(this.applicationTables());
      const now = this.now();
      const metadata = this.metadata();
      const state = this.corePollState();
      if (now < metadata.controlTimeWatermark || (state.lastCompletedAt !== null && now < state.lastCompletedAt)) {
        throw new Error("control-plane clock moved backwards behind durable Core poll state");
      }
      if (
        state.inFlightRunId !== null &&
        state.inFlightExpiresAt !== null &&
        now < state.inFlightExpiresAt
      ) {
        this.db.exec("COMMIT");
        return {
          status: "in-flight",
          runId: state.inFlightRunId,
          expiresAt: state.inFlightExpiresAt,
          state,
        };
      }
      if (now < state.nextPollAt) {
        this.db.exec("COMMIT");
        return { status: "not-due", nextPollAt: state.nextPollAt, state };
      }

      const runId = uuidV7(new Date(now));
      const expiresAt = addSeconds(now, CORE_POLL_LEASE_SECONDS);
      this.db
        .prepare(
          `UPDATE core_poll_state
           SET healthy_interval_seconds = ?, in_flight_run_id = ?,
               in_flight_started_at = ?, in_flight_expires_at = ?
           WHERE singleton = 1`,
        )
        .run(healthyIntervalSeconds, runId, now, expiresAt);
      const claimedState = this.corePollState();
      this.db.exec("COMMIT");
      return {
        status: "claimed",
        runId,
        startedAt: now,
        expiresAt,
        controlPlaneSequence: metadata.lastTransactionSequence,
        pruneDue: now >= state.nextPruneAt,
        state: claimedState,
      };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeCorePoll(input: CorePollCompletionInput): CorePollState {
    if (!isUuidV7(input.runId)) throw new Error("Core poll run ID must be UUIDv7");
    if (input.runStatus === "completed" && input.sourceOutcome === null) {
      throw new Error("a completed Core poll requires a source outcome");
    }
    if (input.sourceOutcome === null && input.checkDisposition !== "none") {
      throw new Error("a Core poll without a source outcome cannot have a check disposition");
    }
    if (input.sourceOutcome !== null && input.checkDisposition === "none") {
      throw new Error("a Core poll source outcome requires a check disposition");
    }
    if (!(["completed", "controller-error"] as const).includes(input.runStatus)) {
      throw new Error("unknown Core poll run status");
    }
    if (!(["recorded", "suppressed", "record-failed", "none"] as const).includes(input.checkDisposition)) {
      throw new Error("unknown Core poll check disposition");
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.verifyExisting(this.applicationTables());
      const completedAt = this.now();
      const metadata = this.metadata();
      const state = this.corePollState();
      if (state.inFlightRunId !== input.runId || state.inFlightStartedAt === null) {
        throw new Error("Core poll completion does not own the active lease");
      }
      if (completedAt < metadata.controlTimeWatermark || completedAt < state.inFlightStartedAt) {
        throw new Error("control-plane clock moved backwards during the Core poll run");
      }
      const sourceUnavailableStreak =
        input.sourceOutcome === "source-unavailable"
          ? state.sourceUnavailableStreak + 1
          : input.sourceOutcome === null
            ? state.sourceUnavailableStreak
            : 0;
      const delaySeconds = corePollDelaySeconds(
        state.healthyIntervalSeconds,
        input.sourceOutcome,
        sourceUnavailableStreak,
      );
      const nextPollAt = addSeconds(completedAt, delaySeconds);
      const nextPruneAt = input.pruneRan
        ? addSeconds(completedAt, CORE_POLL_PRUNE_INTERVAL_SECONDS)
        : state.nextPruneAt;
      this.db
        .prepare(
          `UPDATE core_poll_state
           SET next_poll_at = ?, next_prune_at = ?, source_unavailable_streak = ?,
               in_flight_run_id = NULL, in_flight_started_at = NULL, in_flight_expires_at = NULL,
               last_run_id = ?, last_started_at = ?, last_completed_at = ?,
               last_run_status = ?, last_source_outcome = ?, last_check_disposition = ?,
               completed_run_count = completed_run_count + 1,
               suppressed_check_count = suppressed_check_count + ?
           WHERE singleton = 1`,
        )
        .run(
          nextPollAt,
          nextPruneAt,
          sourceUnavailableStreak,
          input.runId,
          state.inFlightStartedAt,
          completedAt,
          input.runStatus,
          input.sourceOutcome,
          input.checkDisposition,
          input.checkDisposition === "suppressed" ? 1 : 0,
        );
      const completed = this.corePollState();
      this.db.exec("COMMIT");
      return completed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  shouldSuppressCoreCandidateRejection(input: CoreCandidateRejectionInput): boolean {
    if (
      input.operation !== "automatic-source-check" ||
      (input.stage !== "validation" && input.stage !== "continuity")
    ) {
      return false;
    }
    const rows = this.db
      .prepare(
        `SELECT kind, payload_json FROM durable_occurrences
         WHERE occurrence_type = 'record'
           AND kind IN ('core.source-check-eligible-observation', 'core.candidate-rejection-observation')
         ORDER BY transaction_sequence DESC, transaction_position DESC`,
      )
      .all() as Row[];
    for (const row of rows) {
      if (row.kind === "core.source-check-eligible-observation") return false;
      const payload = parseJson(String(row.payload_json));
      if (!recordKindRegistry["core.candidate-rejection-observation"].validatePayload(payload)) {
        throw new Error("latest Core candidate rejection is invalid");
      }
      if (payload.operation !== "automatic-source-check") continue;
      if (
        payload.stage !== input.stage ||
        payload.code !== input.code ||
        payload.commitId !== (input.commitId ?? null)
      ) {
        return false;
      }
      return input.stage !== "continuity" || payload.activeCommitId === (input.activeCommitId ?? null);
    }
    return false;
  }

  occurrences(): DurableOccurrence[] {
    const rows = this.db
      .prepare(
        `SELECT occurrence.*, record.record_class
         FROM durable_occurrences occurrence
         LEFT JOIN durable_records record ON record.record_id = occurrence.record_id
         ORDER BY occurrence.transaction_sequence, occurrence.transaction_position`,
      )
      .all() as Row[];
    return rows.map(decodeOccurrence);
  }

  coreCandidateRejections(limit = 20): CoreCandidateRejectionRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Core candidate rejection limit must be a safe integer from 1 through 100");
    }
    const rows = this.db
      .prepare(
        `SELECT occurrence.record_id, occurrence.payload_json,
                occurrence.transaction_sequence, occurrence.transaction_position
         FROM durable_occurrences occurrence
         JOIN durable_records record ON record.record_id = occurrence.record_id
         WHERE occurrence.kind = 'core.candidate-rejection-observation'
           AND record.record_class = 'observation'
         ORDER BY occurrence.transaction_sequence DESC
         LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((row) => {
      const payload = parseJson(String(row.payload_json));
      if (!recordKindRegistry["core.candidate-rejection-observation"].validatePayload(payload)) {
        throw new Error(`invalid Core candidate rejection payload: ${String(row.record_id)}`);
      }
      return {
        ...payload,
        observationRecordId: String(row.record_id),
        transactionSequence: Number(row.transaction_sequence),
        transactionPosition: 0,
      };
    });
  }

  activeCoreSnapshot(): ActiveCoreSnapshot | undefined {
    const row = this.db
      .prepare(
        `SELECT snapshot.snapshot_id, snapshot.source_commit_id, snapshot.source_tree_id,
                snapshot.catalog_digest, active.activated_at, active.activated_transaction_sequence
         FROM core_active_snapshot active
         JOIN core_snapshots snapshot ON snapshot.snapshot_id = active.snapshot_id
         WHERE active.singleton = 1`,
      )
      .get() as Row | undefined;
    if (!row) return undefined;
    return {
      snapshotId: String(row.snapshot_id),
      sourceCommitId: String(row.source_commit_id),
      sourceTreeId: String(row.source_tree_id),
      catalogDigest: String(row.catalog_digest),
      activatedAt: String(row.activated_at),
      transactionSequence: Number(row.activated_transaction_sequence),
    };
  }

  activeCoreRepositoryCatalog(): ActiveCoreRepositoryCatalog | undefined {
    const snapshot = this.activeCoreSnapshot();
    if (!snapshot) return undefined;
    const candidate = this.retainedCoreCandidate(snapshot.sourceCommitId);
    if (!candidate || candidate.catalogDigest !== snapshot.catalogDigest) {
      throw new Error("active Core repository catalog is not retained exactly");
    }
    return {
      snapshot,
      repositories: candidate.repositories.map((repository) => ({
        path: repository.path,
        contentDigest: repository.contentDigest,
        declaration: structuredClone(repository.declaration),
      })),
    };
  }

  activeCoreSurfaceContract(version = 1): ActiveCoreSurfaceContract | undefined {
    const snapshot = this.activeCoreSnapshot();
    if (!snapshot) return undefined;
    const candidate = this.retainedCoreCandidate(snapshot.sourceCommitId);
    if (!candidate || candidate.catalogDigest !== snapshot.catalogDigest) {
      throw new Error("active Core surface contract is not retained exactly");
    }
    const validated = validatedRepositorySurfaceContract(candidate.files, version);
    const path = `organization/contracts/repository-surfaces/v${version}.json`;
    const entry = candidate.files.find((file) => file.path === path);
    if (!entry) throw new Error(`active Core surface contract is missing: ${path}`);
    return {
      coreSnapshotId: snapshot.snapshotId,
      coreSourceCommitId: snapshot.sourceCommitId,
      contract: validated.contract,
      contractDigest: `sha256:${createHash("sha256").update(entry.bytes).digest("hex")}`,
      governanceSchemaDigest: validated.governanceSchemaDigest,
    };
  }

  private activeRepositoryOperatorHolds(): Map<string, RepositoryOperatorHoldDecisionPayload> {
    const rows = this.db
      .prepare(
        `SELECT occurrence.record_id, occurrence.payload_json
         FROM durable_occurrences occurrence
         JOIN durable_records record ON record.record_id = occurrence.record_id
         WHERE occurrence.kind = 'repository.operator-hold-decision'
           AND record.record_class = 'decision'
         ORDER BY occurrence.transaction_sequence DESC`,
      )
      .all() as Row[];
    const resolved = new Map<string, RepositoryOperatorHoldDecisionPayload>();
    const seen = new Set<string>();
    for (const row of rows) {
      const payload = parseJson(String(row.payload_json));
      if (!recordKindRegistry["repository.operator-hold-decision"].validatePayload(payload)) {
        throw new Error(`invalid repository operator hold decision: ${String(row.record_id)}`);
      }
      if (seen.has(payload.repositoryId)) continue;
      seen.add(payload.repositoryId);
      if (payload.choice === "impose") resolved.set(payload.repositoryId, payload);
    }
    return resolved;
  }

  repositoryStatuses(): RepositoryStatus[] {
    const catalog = this.activeCoreRepositoryCatalog();
    if (!catalog) return [];
    const rows = this.db
      .prepare(
        `SELECT occurrence.record_id, occurrence.payload_json, occurrence.transaction_sequence
         FROM durable_occurrences occurrence
         JOIN durable_records record ON record.record_id = occurrence.record_id
         WHERE occurrence.kind = 'repository.core-authorized'
           AND record.record_class = 'fact'
         ORDER BY occurrence.transaction_sequence DESC`,
      )
      .all() as Row[];
    const authorityByRepository = new Map<string, { recordId: string; payload: RepositoryCoreAuthorityPayload }>();
    for (const row of rows) {
      const payload = parseJson(String(row.payload_json));
      if (!recordKindRegistry["repository.core-authorized"].validatePayload(payload)) {
        throw new Error(`invalid repository Core authorization: ${String(row.record_id)}`);
      }
      if (payload.coreSnapshotId !== catalog.snapshot.snapshotId || authorityByRepository.has(payload.repositoryId)) {
        continue;
      }
      authorityByRepository.set(payload.repositoryId, {
        recordId: String(row.record_id),
        payload,
      });
    }
    const reconciliationRows = this.db
      .prepare(
        `SELECT occurrence.record_id, occurrence.payload_json, occurrence.transaction_sequence
         FROM durable_occurrences occurrence
         JOIN durable_records record ON record.record_id = occurrence.record_id
         WHERE occurrence.kind = 'repository.github-identity-reconciled'
           AND record.record_class = 'fact'
         ORDER BY occurrence.transaction_sequence DESC`,
      )
      .all() as Row[];
    const reconciliationByAuthority = new Map<
      string,
      { recordId: string; payload: RepositoryGitHubReconciliationPayload }
    >();
    for (const row of reconciliationRows) {
      const payload = parseJson(String(row.payload_json));
      if (!recordKindRegistry["repository.github-identity-reconciled"].validatePayload(payload)) {
        throw new Error(`invalid repository GitHub reconciliation: ${String(row.record_id)}`);
      }
      if (!reconciliationByAuthority.has(payload.coreAuthorizationRecordId)) {
        reconciliationByAuthority.set(payload.coreAuthorizationRecordId, {
          recordId: String(row.record_id),
          payload,
        });
      }
    }
    const surfaceRows = this.db
      .prepare(
        `SELECT occurrence.record_id, occurrence.payload_json, occurrence.transaction_sequence
         FROM durable_occurrences occurrence
         JOIN durable_records record ON record.record_id = occurrence.record_id
         WHERE occurrence.kind = 'repository.canonical-surfaces-reconciled'
           AND record.record_class = 'fact'
         ORDER BY occurrence.transaction_sequence DESC`,
      )
      .all() as Row[];
    const surfaceByIdentity = new Map<
      string,
      { recordId: string; payload: RepositorySurfaceReconciliationPayload }
    >();
    for (const row of surfaceRows) {
      const payload = parseJson(String(row.payload_json));
      if (!recordKindRegistry["repository.canonical-surfaces-reconciled"].validatePayload(payload)) {
        throw new Error(`invalid repository surface reconciliation: ${String(row.record_id)}`);
      }
      if (!surfaceByIdentity.has(payload.githubReconciliationRecordId)) {
        surfaceByIdentity.set(payload.githubReconciliationRecordId, {
          recordId: String(row.record_id),
          payload,
        });
      }
    }
    const enrollmentRows = this.db
      .prepare(
        `SELECT occurrence.record_id, occurrence.payload_json, occurrence.transaction_sequence
         FROM durable_occurrences occurrence
         JOIN durable_records record ON record.record_id = occurrence.record_id
         WHERE occurrence.kind = 'repository.enrolled'
           AND record.record_class = 'fact'
         ORDER BY occurrence.transaction_sequence DESC`,
      )
      .all() as Row[];
    const enrollmentBySurface = new Map<string, { recordId: string; payload: RepositoryEnrollmentPayload }>();
    for (const row of enrollmentRows) {
      const payload = parseJson(String(row.payload_json));
      if (!recordKindRegistry["repository.enrolled"].validatePayload(payload)) {
        throw new Error(`invalid repository enrollment: ${String(row.record_id)}`);
      }
      if (!enrollmentBySurface.has(payload.surfaceReconciliationRecordId)) {
        enrollmentBySurface.set(payload.surfaceReconciliationRecordId, {
          recordId: String(row.record_id),
          payload,
        });
      }
    }
    const operatorHoldByRepository = this.activeRepositoryOperatorHolds();
    const statuses: RepositoryStatus[] = [];
    for (const repository of catalog.repositories) {
      const repositoryId = `github.com:${repository.declaration.repository.repository_id}`;
      const authority = authorityByRepository.get(repositoryId);
      const operatorHold = operatorHoldByRepository.get(repositoryId) ?? null;
      if (!authority) {
        statuses.push({
          repositoryId,
          owner: repository.declaration.repository.owner,
          name: repository.declaration.repository.name,
          coreSnapshotId: catalog.snapshot.snapshotId,
          coreAuthorizationRecordId: null,
          fleetState: repository.declaration.fleet_state,
          maintenancePrograms: [...repository.declaration.maintenance_programs],
          actionCeiling: [...repository.declaration.action_ceiling],
          accountableOwners: structuredClone(repository.declaration.accountable_owners),
          surfaceContractVersion: 1,
          githubReconciliationRecordId: null,
          githubResult: null,
          githubDefaultBranch: null,
          surfaceReconciliationRecordId: null,
          surfacePolicyDecisionRecordId: null,
          surfaceResult: null,
          repositoryCommitId: null,
          enrollmentRecordId: null,
          authorityContextDigest: null,
          operatorHold,
          effectiveState: "awaiting-authority",
        });
        continue;
      }
      const github = reconciliationByAuthority.get(authority.recordId);
      const surface = github ? surfaceByIdentity.get(github.recordId) : undefined;
      const enrollment = surface ? enrollmentBySurface.get(surface.recordId) : undefined;
      const effectiveState: RepositoryState =
        authority.payload.fleetState === "disabled"
          ? "disabled"
          : authority.payload.fleetState === "paused"
            ? "paused"
            : operatorHold !== null
              ? "operator-held"
              : github === undefined
                ? "awaiting-github"
                : github.payload.result === "matched"
                  ? surface === undefined
                    ? "awaiting-surfaces"
                    : surface.payload.result !== "valid"
                      ? "surface-held"
                      : enrollment === undefined
                        ? "awaiting-enrollment"
                        : "enrolled"
                  : "github-held";
      statuses.push({
        repositoryId,
        owner: authority.payload.owner,
        name: authority.payload.name,
        coreSnapshotId: catalog.snapshot.snapshotId,
        coreAuthorizationRecordId: authority.recordId,
        fleetState: authority.payload.fleetState,
        maintenancePrograms: [...authority.payload.maintenancePrograms],
        actionCeiling: [...authority.payload.actionCeiling],
        accountableOwners: structuredClone(
          authority.payload.accountableOwners,
        ) as RepositoryDeclaration["accountable_owners"],
        surfaceContractVersion: 1,
        githubReconciliationRecordId: github?.recordId ?? null,
        githubResult: github?.payload.result ?? null,
        githubDefaultBranch: github?.payload.observedDefaultBranch ?? null,
        surfaceReconciliationRecordId: surface?.recordId ?? null,
        surfacePolicyDecisionRecordId: surface?.payload.policyDecisionRecordId ?? null,
        surfaceResult: surface?.payload.result ?? null,
        repositoryCommitId: surface?.payload.repositoryCommitId ?? null,
        enrollmentRecordId: enrollment?.recordId ?? null,
        authorityContextDigest:
          effectiveState === "enrolled" && github && surface && enrollment
            ? repositoryAuthorityContextDigest({
                authority: authority.payload,
                github: github.payload,
                surfaces: surface.payload,
                enrollment: enrollment.payload,
              })
            : null,
        operatorHold,
        effectiveState,
      });
    }
    return statuses.sort((left, right) => left.repositoryId.localeCompare(right.repositoryId));
  }

  materializeRepositoryCoreAuthority(input: RepositoryCoreAuthorityInput): RepositoryCoreAuthorityResult {
    assertExpectedSequence(input.expectedLastTransactionSequence);
    if (!isUuidV7(input.coreSnapshotId)) throw new Error("Core snapshot ID must be UUIDv7");
    assertSubject("github-repository", input.repositoryId);
    const idempotencyKey = `repo-core:${input.coreSnapshotId}:${input.repositoryId.slice("github.com:".length)}`;
    const commandPayloadJson = canonicalJson({
      coreSnapshotId: input.coreSnapshotId,
      repositoryId: input.repositoryId,
    });
    const commandPayloadDigest = sha256(commandPayloadJson);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.verifyExisting(this.applicationTables());
      const metadata = this.metadata();
      const commandScope = `database:${metadata.databaseLineageId}`;
      const prior = this.db
        .prepare(
          `SELECT payload_digest, result_json FROM idempotency_receipts
           WHERE command_scope = ? AND command_kind = 'repository.materialize-core-authority'
             AND command_schema_version = 1 AND idempotency_key = ?`,
        )
        .get(commandScope, idempotencyKey) as Row | undefined;
      if (prior) {
        if (String(prior.payload_digest) !== commandPayloadDigest) {
          throw new Error("repository Core authority idempotency payload changed");
        }
        const result = parseRepositoryCoreAuthorityResult(parseJson(String(prior.result_json)));
        this.db.exec("COMMIT");
        return result;
      }
      const evaluationTime = this.now();
      assertCommandTimeAndSequence(metadata, evaluationTime, input.expectedLastTransactionSequence);
      const readiness = this.coreAdmissionReadinessWithoutOverride(evaluationTime);
      const effectiveReadiness = this.coreAdmissionReadiness(evaluationTime);
      if (!effectiveReadiness.ready) {
        throw new Error(`Core admission readiness is ${readiness.reason}; repository authority cannot advance`);
      }
      const catalog = this.activeCoreRepositoryCatalog();
      if (!catalog || catalog.snapshot.snapshotId !== input.coreSnapshotId) {
        throw new Error("repository authority command does not bind the active Core snapshot");
      }
      const declared = catalog.repositories.find(
        (repository) =>
          `github.com:${repository.declaration.repository.repository_id}` === input.repositoryId,
      );
      if (!declared) throw new Error("repository is not declared by the active Core snapshot");

      const transactionId = uuidV7(new Date(evaluationTime));
      const declarationRecordId = uuidV7(new Date(evaluationTime));
      const coreAuthorizationRecordId = uuidV7(new Date(evaluationTime));
      const eventRecordId = uuidV7(new Date(evaluationTime));
      const correlationId = uuidV7(new Date(evaluationTime));
      const declaration = declared.declaration;
      const payload = {
        repositoryId: input.repositoryId,
        coreSnapshotId: catalog.snapshot.snapshotId,
        declarationRecordId,
        coreAuthorizationRecordId,
        eventRecordId,
        sourceCommitId: catalog.snapshot.sourceCommitId,
        declarationPath: declared.path,
        declarationDigest: declared.contentDigest,
        owner: declaration.repository.owner,
        name: declaration.repository.name,
        accountableOwners: declaration.accountable_owners.map(
          (owner): RepositoryAccountableOwner =>
            owner.kind === "github-user"
              ? ({ kind: "github-user", login: owner.login! } as RepositoryAccountableOwner)
              : ({ kind: "github-team", slug: owner.slug! } as RepositoryAccountableOwner),
        ),
        fleetState: declaration.fleet_state,
        maintenancePrograms: declaration.maintenance_programs,
        actionCeiling: declaration.action_ceiling,
        surfaceContractVersion: declaration.surface_contract_version,
        authorizedAt: evaluationTime,
      } satisfies RepositoryCoreAuthorityPayload;
      if (!recordKindRegistry["repository.core-authorized"].validatePayload(payload)) {
        throw new Error("retained repository declaration is outside the authority record contract");
      }
      const payloadJson = canonicalJson(payload);
      const payloadDigest = sha256(payloadJson);
      const transaction = this.db
        .prepare(
          `INSERT INTO control_transactions (
             transaction_id, command_kind, command_schema_version, principal_kind,
             principal_id, session_id, idempotency_key, payload_digest,
             evaluation_time, recorded_at
           ) VALUES (?, 'repository.materialize-core-authority', 1, 'fluent-system', 'kernel', NULL, ?, ?, ?, ?)`,
        )
        .run(transactionId, idempotencyKey, commandPayloadDigest, evaluationTime, evaluationTime);
      const sequence = Number(transaction.lastInsertRowid);
      const existingSubject = this.db
        .prepare("SELECT 1 AS present FROM subjects WHERE subject_kind = 'github-repository' AND subject_id = ?")
        .get(input.repositoryId) as Row | undefined;
      if (!existingSubject) {
        this.db
          .prepare(
            `INSERT INTO subjects (subject_kind, subject_id, created_transaction_sequence)
             VALUES ('github-repository', ?, ?)`,
          )
          .run(input.repositoryId, sequence);
      }
      const source = {
        sourceKind: "github-repository",
        sourceId: "github.com:1331309458",
        sourceRevisionKind: "git-commit-sha1",
        sourceRevisionValue: `sha1:${catalog.snapshot.sourceCommitId}`,
      };
      const scope = canonicalJson({ deploymentId: metadata.databaseLineageId });
      for (const occurrence of [
        { recordId: declarationRecordId, occurrenceType: "record" as const, kind: "repository.declaration-definition", recordClass: "definition" as const },
        { recordId: coreAuthorizationRecordId, occurrenceType: "record" as const, kind: "repository.core-authorized", recordClass: "fact" as const },
        { recordId: eventRecordId, occurrenceType: "event" as const, kind: "repository.core-authority-reconciled" },
      ].map((value, transactionPosition) => ({ ...value, transactionPosition }))) {
        this.insertOccurrence({
          ...occurrence,
          schemaVersion: 1,
          subjectKind: "github-repository",
          subjectId: input.repositoryId,
          revisionKind: "core-declaration-sha256",
          revisionValue: declared.contentDigest,
          ...source,
          informationClass: "organization",
          informationScopeJson: scope,
          payloadJson,
          payloadDigest,
          correlationId,
          transactionSequence: sequence,
          recordedAt: evaluationTime,
        });
      }
      const result: RepositoryCoreAuthorityResult = {
        repositoryId: input.repositoryId,
        coreSnapshotId: catalog.snapshot.snapshotId,
        declarationRecordId,
        coreAuthorizationRecordId,
        eventRecordId,
        authorizedAt: evaluationTime,
        transactionPositions: [0, 1, 2],
        transactionSequence: sequence,
      };
      this.insertReceipt(commandScope, "repository.materialize-core-authority", idempotencyKey, commandPayloadDigest, result, sequence);
      this.advanceControlMetadata(evaluationTime, sequence);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordRepositoryGitHubIdentity(
    input: RepositoryGitHubReconciliationInput,
  ): RepositoryGitHubReconciliationResult {
    assertExpectedSequence(input.expectedLastTransactionSequence);
    const inspection = normalizeRepositoryGitHubInspection(input.inspection);
    const responseDigest = sha256(canonicalJson(inspection as unknown as JsonValue));

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.verifyExisting(this.applicationTables());
      const metadata = this.metadata();
      const commandScope = `database:${metadata.databaseLineageId}`;
      const evaluationTime = this.now();
      assertCommandTimeAndSequence(metadata, evaluationTime, input.expectedLastTransactionSequence);
      const authorityRow = this.db
        .prepare(
          `SELECT occurrence.* FROM durable_occurrences occurrence
           JOIN durable_records record ON record.record_id = occurrence.record_id
           WHERE occurrence.record_id = ? AND occurrence.kind = 'repository.core-authorized'
             AND record.record_class = 'fact'`,
        )
        .get(input.coreAuthorizationRecordId) as Row | undefined;
      if (!authorityRow) throw new Error("repository GitHub reconciliation requires a Core authorization fact");
      const authorityPayload = parseJson(String(authorityRow.payload_json));
      if (!recordKindRegistry["repository.core-authorized"].validatePayload(authorityPayload)) {
        throw new Error("repository Core authorization fact is invalid");
      }
      const active = this.activeCoreSnapshot();
      if (!active || active.snapshotId !== authorityPayload.coreSnapshotId) {
        throw new Error("repository GitHub reconciliation authority is not from the active Core snapshot");
      }
      const predecessor = this.db
        .prepare(
          `SELECT occurrence.record_id, occurrence.payload_json, occurrence.transaction_sequence
           FROM durable_occurrences occurrence
           WHERE occurrence.kind = 'repository.github-identity-reconciled'
             AND json_extract(occurrence.payload_json, '$.coreAuthorizationRecordId') = ?
           ORDER BY occurrence.transaction_sequence DESC LIMIT 1`,
        )
        .get(input.coreAuthorizationRecordId) as Row | undefined;
      if (predecessor) {
        const predecessorPayload = parseJson(String(predecessor.payload_json));
        if (!recordKindRegistry["repository.github-identity-reconciled"].validatePayload(predecessorPayload)) {
          throw new Error("repository GitHub reconciliation predecessor is invalid");
        }
        if (predecessorPayload.responseDigest === responseDigest) {
          const result = repositoryGitHubResultFromPayload(
            predecessorPayload,
            Number(predecessor.transaction_sequence),
          );
          this.db.exec("COMMIT");
          return result;
        }
      }
      const predecessorRecordId = predecessor ? String(predecessor.record_id) : "initial";
      const idempotencyKey =
        `repo-gh:${input.coreAuthorizationRecordId}:${predecessorRecordId}:${responseDigest.slice("sha256:".length)}`;
      const commandPayloadJson = canonicalJson({
        coreAuthorizationRecordId: input.coreAuthorizationRecordId,
        predecessorReconciliationRecordId: predecessor ? predecessorRecordId : null,
        inspection: inspection as unknown as JsonValue,
      });
      const commandPayloadDigest = sha256(commandPayloadJson);
      const prior = this.db
        .prepare(
          `SELECT payload_digest, result_json FROM idempotency_receipts
           WHERE command_scope = ? AND command_kind = 'repository.record-github-identity'
             AND command_schema_version = 1 AND idempotency_key = ?`,
        )
        .get(commandScope, idempotencyKey) as Row | undefined;
      if (prior) {
        if (String(prior.payload_digest) !== commandPayloadDigest) {
          throw new Error("repository GitHub reconciliation idempotency payload changed");
        }
        const result = parseRepositoryGitHubReconciliationResult(parseJson(String(prior.result_json)));
        this.db.exec("COMMIT");
        return result;
      }
      const resultKind = classifyRepositoryGitHubInspection(authorityPayload, inspection);
      const effectiveState = repositoryIdentityState(authorityPayload.fleetState, resultKind);
      const transactionId = uuidV7(new Date(evaluationTime));
      const observationRecordId = uuidV7(new Date(evaluationTime));
      const reconciliationRecordId = uuidV7(new Date(evaluationTime));
      const eventRecordId = uuidV7(new Date(evaluationTime));
      const correlationId = uuidV7(new Date(evaluationTime));
      const payload = {
        repositoryId: authorityPayload.repositoryId,
        coreSnapshotId: authorityPayload.coreSnapshotId,
        coreAuthorizationRecordId: input.coreAuthorizationRecordId,
        observationRecordId,
        reconciliationRecordId,
        eventRecordId,
        declaredOwner: authorityPayload.owner,
        declaredName: authorityPayload.name,
        declaredRepositoryId: authorityPayload.repositoryId.slice("github.com:".length),
        fleetState: authorityPayload.fleetState,
        observedOwner: inspection.kind === "found" ? inspection.owner : null,
        observedName: inspection.kind === "found" ? inspection.name : null,
        observedRepositoryId: inspection.kind === "found" ? inspection.repositoryId : null,
        archived: inspection.kind === "found" ? inspection.archived : null,
        observedDefaultBranch: inspection.kind === "found" ? inspection.defaultBranch : null,
        result: resultKind,
        effectiveState,
        checkedAt: evaluationTime,
        responseDigest,
      } satisfies RepositoryGitHubReconciliationPayload;
      if (!recordKindRegistry["repository.github-identity-reconciled"].validatePayload(payload)) {
        throw new Error("repository GitHub result is outside the reconciliation record contract");
      }
      const payloadJson = canonicalJson(payload);
      const payloadDigest = sha256(payloadJson);
      const transaction = this.db
        .prepare(
          `INSERT INTO control_transactions (
             transaction_id, command_kind, command_schema_version, principal_kind,
             principal_id, session_id, idempotency_key, payload_digest,
             evaluation_time, recorded_at
           ) VALUES (?, 'repository.record-github-identity', 1, 'fluent-system', 'kernel', NULL, ?, ?, ?, ?)`,
        )
        .run(transactionId, idempotencyKey, commandPayloadDigest, evaluationTime, evaluationTime);
      const sequence = Number(transaction.lastInsertRowid);
      const scope = canonicalJson({ deploymentId: metadata.databaseLineageId });
      for (const occurrence of [
        { recordId: observationRecordId, occurrenceType: "record" as const, kind: "repository.github-identity-observation", recordClass: "observation" as const },
        { recordId: reconciliationRecordId, occurrenceType: "record" as const, kind: "repository.github-identity-reconciled", recordClass: "fact" as const },
        { recordId: eventRecordId, occurrenceType: "event" as const, kind: "repository.github-identity-reconciliation-recorded" },
      ].map((value, transactionPosition) => ({ ...value, transactionPosition }))) {
        this.insertOccurrence({
          ...occurrence,
          schemaVersion: 1,
          subjectKind: "github-repository",
          subjectId: authorityPayload.repositoryId,
          revisionKind: "github-metadata-sha256",
          revisionValue: responseDigest,
          sourceKind: "github-api",
          sourceId: "api.github.com",
          sourceRevisionKind: "github-metadata-sha256",
          sourceRevisionValue: responseDigest,
          informationClass: "organization",
          informationScopeJson: scope,
          payloadJson,
          payloadDigest,
          correlationId,
          causationRecordId: input.coreAuthorizationRecordId,
          transactionSequence: sequence,
          recordedAt: evaluationTime,
        });
      }
      const result: RepositoryGitHubReconciliationResult = {
        repositoryId: authorityPayload.repositoryId,
        coreSnapshotId: authorityPayload.coreSnapshotId,
        coreAuthorizationRecordId: input.coreAuthorizationRecordId,
        observationRecordId,
        reconciliationRecordId,
        eventRecordId,
        result: resultKind,
        effectiveState,
        checkedAt: evaluationTime,
        responseDigest,
        transactionPositions: [0, 1, 2],
        transactionSequence: sequence,
      };
      this.insertReceipt(commandScope, "repository.record-github-identity", idempotencyKey, commandPayloadDigest, result, sequence);
      this.advanceControlMetadata(evaluationTime, sequence);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordRepositoryCanonicalSurfaces(
    input: RepositorySurfaceReconciliationInput,
  ): RepositorySurfaceReconciliationResult {
    assertExpectedSequence(input.expectedLastTransactionSequence);
    if (!isUuidV7(input.githubReconciliationRecordId)) {
      throw new Error("repository surface reconciliation requires a UUIDv7 identity fact");
    }
    const probe = normalizeRepositorySurfaceProbe(input.probe);
    const probeJson = canonicalJson(probe as unknown as JsonValue);
    const probeDigest = sha256(probeJson);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.verifyExisting(this.applicationTables());
      const metadata = this.metadata();
      const commandScope = `database:${metadata.databaseLineageId}`;
      const evaluationTime = this.now();
      assertCommandTimeAndSequence(metadata, evaluationTime, input.expectedLastTransactionSequence);
      const githubRow = this.db
        .prepare(
          `SELECT occurrence.* FROM durable_occurrences occurrence
           JOIN durable_records record ON record.record_id = occurrence.record_id
           WHERE occurrence.record_id = ? AND occurrence.kind = 'repository.github-identity-reconciled'
             AND record.record_class = 'fact'`,
        )
        .get(input.githubReconciliationRecordId) as Row | undefined;
      if (!githubRow) throw new Error("repository surface reconciliation requires a GitHub identity fact");
      const githubPayload = parseJson(String(githubRow.payload_json));
      if (!recordKindRegistry["repository.github-identity-reconciled"].validatePayload(githubPayload)) {
        throw new Error("repository GitHub identity fact is invalid");
      }
      if (githubPayload.result !== "matched" || githubPayload.observedDefaultBranch === null) {
        throw new Error("repository surface reconciliation requires a matched GitHub identity");
      }
      const latestIdentity = this.db
        .prepare(
          `SELECT occurrence.record_id FROM durable_occurrences occurrence
           JOIN durable_records record ON record.record_id = occurrence.record_id
           WHERE occurrence.kind = 'repository.github-identity-reconciled'
             AND record.record_class = 'fact'
             AND json_extract(occurrence.payload_json, '$.coreAuthorizationRecordId') = ?
           ORDER BY occurrence.transaction_sequence DESC LIMIT 1`,
        )
        .get(githubPayload.coreAuthorizationRecordId) as Row | undefined;
      if (!latestIdentity || String(latestIdentity.record_id) !== input.githubReconciliationRecordId) {
        throw new Error("repository surface reconciliation identity fact is not current");
      }
      const active = this.activeCoreSnapshot();
      if (!active || active.snapshotId !== githubPayload.coreSnapshotId) {
        throw new Error("repository surface reconciliation authority is not from the active Core snapshot");
      }
      const authorityRow = this.db
        .prepare(
          `SELECT occurrence.payload_json FROM durable_occurrences occurrence
           JOIN durable_records record ON record.record_id = occurrence.record_id
           WHERE occurrence.record_id = ? AND occurrence.kind = 'repository.core-authorized'
             AND record.record_class = 'fact'`,
        )
        .get(githubPayload.coreAuthorizationRecordId) as Row | undefined;
      if (!authorityRow) throw new Error("repository surface reconciliation Core authority is missing");
      const authorityPayload = parseJson(String(authorityRow.payload_json));
      if (!recordKindRegistry["repository.core-authorized"].validatePayload(authorityPayload)) {
        throw new Error("repository surface reconciliation Core authority is invalid");
      }
      const activeContract = this.activeCoreSurfaceContract(authorityPayload.surfaceContractVersion);
      if (!activeContract || activeContract.coreSnapshotId !== authorityPayload.coreSnapshotId) {
        throw new Error("repository surface reconciliation contract is not from the active Core snapshot");
      }
      const predecessor = this.db
        .prepare(
          `SELECT occurrence.record_id, occurrence.payload_json, occurrence.transaction_sequence
           FROM durable_occurrences occurrence
           WHERE occurrence.kind = 'repository.canonical-surfaces-reconciled'
             AND json_extract(occurrence.payload_json, '$.githubReconciliationRecordId') = ?
           ORDER BY occurrence.transaction_sequence DESC LIMIT 1`,
        )
        .get(input.githubReconciliationRecordId) as Row | undefined;
      if (predecessor) {
        const predecessorPayload = parseJson(String(predecessor.payload_json));
        if (!recordKindRegistry["repository.canonical-surfaces-reconciled"].validatePayload(predecessorPayload)) {
          throw new Error("repository surface reconciliation predecessor is invalid");
        }
        if (predecessorPayload.probeDigest === probeDigest) {
          const result = repositorySurfaceResultFromPayload(
            predecessorPayload,
            Number(predecessor.transaction_sequence),
          );
          this.db.exec("COMMIT");
          return result;
        }
      }
      const predecessorRecordId = predecessor ? String(predecessor.record_id) : "initial";
      const idempotencyKey =
        `repo-surfaces:${input.githubReconciliationRecordId}:${predecessorRecordId}:${probeDigest.slice("sha256:".length)}`;
      const commandPayloadJson = canonicalJson({
        githubReconciliationRecordId: input.githubReconciliationRecordId,
        predecessorReconciliationRecordId: predecessor ? predecessorRecordId : null,
        probeDigest,
      });
      const commandPayloadDigest = sha256(commandPayloadJson);
      const prior = this.db
        .prepare(
          `SELECT payload_digest, result_json FROM idempotency_receipts
           WHERE command_scope = ? AND command_kind = 'repository.record-canonical-surfaces'
             AND command_schema_version = 1 AND idempotency_key = ?`,
        )
        .get(commandScope, idempotencyKey) as Row | undefined;
      if (prior) {
        if (String(prior.payload_digest) !== commandPayloadDigest) {
          throw new Error("repository surface reconciliation idempotency payload changed");
        }
        const result = parseRepositorySurfaceReconciliationResult(parseJson(String(prior.result_json)));
        this.db.exec("COMMIT");
        return result;
      }
      const evaluation = evaluateRepositorySurfaceProbe(
        probe,
        githubPayload.observedDefaultBranch,
        activeContract.contract,
      );
      const transactionId = uuidV7(new Date(evaluationTime));
      const observationRecordId = uuidV7(new Date(evaluationTime));
      const policyDecisionRecordId = uuidV7(new Date(evaluationTime));
      const reconciliationRecordId = uuidV7(new Date(evaluationTime));
      const eventRecordId = uuidV7(new Date(evaluationTime));
      const correlationId = uuidV7(new Date(evaluationTime));
      const payload = {
        repositoryId: authorityPayload.repositoryId,
        coreSnapshotId: authorityPayload.coreSnapshotId,
        coreAuthorizationRecordId: githubPayload.coreAuthorizationRecordId,
        githubReconciliationRecordId: input.githubReconciliationRecordId,
        observationRecordId,
        policyDecisionRecordId,
        reconciliationRecordId,
        eventRecordId,
        defaultBranch: evaluation.defaultBranch,
        repositoryCommitId: evaluation.repositoryCommitId,
        repositoryTreeId: evaluation.repositoryTreeId,
        surfaceContractVersion: 1,
        governanceSchemaVersion: 1,
        surfaceContractDigest: activeContract.contractDigest,
        governanceSchemaDigest: activeContract.governanceSchemaDigest,
        surfaces: evaluation.surfaces,
        governancePolicy: evaluation.governancePolicy,
        checkpoint: "repository-enrollment",
        decision: evaluation.result === "valid" ? "permit" : "deny",
        requirementResults: repositorySurfaceRequirementResults(activeContract.contract, evaluation),
        exceptionRecordIds: [],
        result: evaluation.result,
        failedSurfaceId: evaluation.failedSurfaceId,
        checkedAt: evaluationTime,
        probeDigest,
      } satisfies RepositorySurfaceReconciliationPayload;
      if (!recordKindRegistry["repository.canonical-surfaces-reconciled"].validatePayload(payload)) {
        throw new Error("repository surface result is outside the reconciliation record contract");
      }
      const payloadJson = canonicalJson(payload);
      const payloadDigest = sha256(payloadJson);
      const transaction = this.db
        .prepare(
          `INSERT INTO control_transactions (
             transaction_id, command_kind, command_schema_version, principal_kind,
             principal_id, session_id, idempotency_key, payload_digest,
             evaluation_time, recorded_at
           ) VALUES (?, 'repository.record-canonical-surfaces', 1, 'fluent-system', 'kernel', NULL, ?, ?, ?, ?)`,
        )
        .run(transactionId, idempotencyKey, commandPayloadDigest, evaluationTime, evaluationTime);
      const sequence = Number(transaction.lastInsertRowid);
      const scope = canonicalJson({ deploymentId: metadata.databaseLineageId });
      const sourceRevisionKind = evaluation.repositoryCommitId === null ? "github-metadata-sha256" : "git-commit-sha1";
      const sourceRevisionValue =
        evaluation.repositoryCommitId === null ? probeDigest : `sha1:${evaluation.repositoryCommitId}`;
      for (const occurrence of [
        { recordId: observationRecordId, occurrenceType: "record" as const, kind: "repository.canonical-surface-observation", recordClass: "observation" as const },
        { recordId: policyDecisionRecordId, occurrenceType: "record" as const, kind: "repository.enrollment-checkpoint-policy-decision", recordClass: "decision" as const },
        { recordId: reconciliationRecordId, occurrenceType: "record" as const, kind: "repository.canonical-surfaces-reconciled", recordClass: "fact" as const },
        { recordId: eventRecordId, occurrenceType: "event" as const, kind: "repository.canonical-surfaces-reconciliation-recorded" },
      ].map((value, transactionPosition) => ({ ...value, transactionPosition }))) {
        this.insertOccurrence({
          ...occurrence,
          schemaVersion: 1,
          subjectKind: "github-repository",
          subjectId: authorityPayload.repositoryId,
          revisionKind: "repository-surfaces-sha256",
          revisionValue: probeDigest,
          sourceKind: "github-api",
          sourceId: "api.github.com",
          sourceRevisionKind,
          sourceRevisionValue,
          informationClass: "organization",
          informationScopeJson: scope,
          payloadJson,
          payloadDigest,
          correlationId,
          causationRecordId: input.githubReconciliationRecordId,
          transactionSequence: sequence,
          recordedAt: evaluationTime,
        });
      }
      const result: RepositorySurfaceReconciliationResult = {
        repositoryId: authorityPayload.repositoryId,
        coreSnapshotId: authorityPayload.coreSnapshotId,
        coreAuthorizationRecordId: githubPayload.coreAuthorizationRecordId,
        githubReconciliationRecordId: input.githubReconciliationRecordId,
        observationRecordId,
        policyDecisionRecordId,
        reconciliationRecordId,
        eventRecordId,
        result: evaluation.result,
        repositoryCommitId: evaluation.repositoryCommitId,
        checkedAt: evaluationTime,
        probeDigest,
        transactionPositions: [0, 1, 2, 3],
        transactionSequence: sequence,
      };
      this.insertReceipt(commandScope, "repository.record-canonical-surfaces", idempotencyKey, commandPayloadDigest, result, sequence);
      this.advanceControlMetadata(evaluationTime, sequence);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  establishRepositoryEnrollment(input: RepositoryEnrollmentInput): RepositoryEnrollmentResult {
    assertExpectedSequence(input.expectedLastTransactionSequence);
    if (!isUuidV7(input.surfaceReconciliationRecordId)) {
      throw new Error("repository enrollment requires a UUIDv7 surface fact");
    }
    const idempotencyKey = `repo-enroll:${input.surfaceReconciliationRecordId}`;
    const commandPayloadJson = canonicalJson({
      surfaceReconciliationRecordId: input.surfaceReconciliationRecordId,
    });
    const commandPayloadDigest = sha256(commandPayloadJson);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.verifyExisting(this.applicationTables());
      const metadata = this.metadata();
      const commandScope = `database:${metadata.databaseLineageId}`;
      const prior = this.db
        .prepare(
          `SELECT payload_digest, result_json FROM idempotency_receipts
           WHERE command_scope = ? AND command_kind = 'repository.establish-enrollment'
             AND command_schema_version = 1 AND idempotency_key = ?`,
        )
        .get(commandScope, idempotencyKey) as Row | undefined;
      if (prior) {
        if (String(prior.payload_digest) !== commandPayloadDigest) {
          throw new Error("repository enrollment idempotency payload changed");
        }
        const result = parseRepositoryEnrollmentResult(parseJson(String(prior.result_json)));
        this.db.exec("COMMIT");
        return result;
      }
      const evaluationTime = this.now();
      assertCommandTimeAndSequence(metadata, evaluationTime, input.expectedLastTransactionSequence);
      if (!this.coreAdmissionReadiness(evaluationTime).ready) {
        throw new Error("repository enrollment requires Core admission readiness");
      }
      const surfaceRow = this.db
        .prepare(
          `SELECT occurrence.* FROM durable_occurrences occurrence
           JOIN durable_records record ON record.record_id = occurrence.record_id
           WHERE occurrence.record_id = ? AND occurrence.kind = 'repository.canonical-surfaces-reconciled'
             AND record.record_class = 'fact'`,
        )
        .get(input.surfaceReconciliationRecordId) as Row | undefined;
      if (!surfaceRow) throw new Error("repository enrollment requires a canonical-surface fact");
      const surfacePayload = parseJson(String(surfaceRow.payload_json));
      if (!recordKindRegistry["repository.canonical-surfaces-reconciled"].validatePayload(surfacePayload)) {
        throw new Error("repository enrollment surface fact is invalid");
      }
      if (surfacePayload.result !== "valid" || surfacePayload.repositoryCommitId === null) {
        throw new Error("repository enrollment requires valid canonical surfaces");
      }
      const statuses = this.repositoryStatuses();
      const current = statuses.find((status) => status.repositoryId === surfacePayload.repositoryId);
      if (
        !current ||
        current.coreSnapshotId !== surfacePayload.coreSnapshotId ||
        current.coreAuthorizationRecordId !== surfacePayload.coreAuthorizationRecordId ||
        current.githubReconciliationRecordId !== surfacePayload.githubReconciliationRecordId ||
        current.surfaceReconciliationRecordId !== input.surfaceReconciliationRecordId ||
        current.operatorHold !== null ||
        current.fleetState !== "enabled" ||
        current.githubResult !== "matched" ||
        current.surfaceResult !== "valid"
      ) {
        throw new Error("repository enrollment prerequisites are not current");
      }
      const authorityRow = this.db
        .prepare(
          `SELECT occurrence.payload_json FROM durable_occurrences occurrence
           WHERE occurrence.record_id = ? AND occurrence.kind = 'repository.core-authorized'`,
        )
        .get(surfacePayload.coreAuthorizationRecordId) as Row | undefined;
      const authorityPayload = authorityRow ? parseJson(String(authorityRow.payload_json)) : null;
      if (!recordKindRegistry["repository.core-authorized"].validatePayload(authorityPayload)) {
        throw new Error("repository enrollment Core authority is invalid");
      }
      const enrolledAt = evaluationTime;
      const transactionId = uuidV7(new Date(enrolledAt));
      const controllerDefinitionRecordId = uuidV7(new Date(enrolledAt));
      const enrollmentRecordId = uuidV7(new Date(enrolledAt));
      const eventRecordId = uuidV7(new Date(enrolledAt));
      const payload = {
        repositoryId: surfacePayload.repositoryId,
        coreSnapshotId: surfacePayload.coreSnapshotId,
        coreAuthorizationRecordId: surfacePayload.coreAuthorizationRecordId,
        githubReconciliationRecordId: surfacePayload.githubReconciliationRecordId,
        surfaceReconciliationRecordId: input.surfaceReconciliationRecordId,
        surfacePolicyDecisionRecordId: surfacePayload.policyDecisionRecordId,
        controllerDefinitionRecordId,
        enrollmentRecordId,
        eventRecordId,
        repositoryCommitId: surfacePayload.repositoryCommitId,
        surfaceContractVersion: surfacePayload.surfaceContractVersion,
        maintenancePrograms: authorityPayload.maintenancePrograms,
        actionCeiling: authorityPayload.actionCeiling,
        enrolledAt,
      } satisfies RepositoryEnrollmentPayload;
      if (!recordKindRegistry["repository.enrolled"].validatePayload(payload)) {
        throw new Error("repository enrollment is outside the registered contract");
      }
      const payloadJson = canonicalJson(payload);
      const payloadDigest = sha256(payloadJson);
      const transaction = this.db
        .prepare(
          `INSERT INTO control_transactions (
             transaction_id, command_kind, command_schema_version, principal_kind,
             principal_id, session_id, idempotency_key, payload_digest,
             evaluation_time, recorded_at
           ) VALUES (?, 'repository.establish-enrollment', 1, 'fluent-system', 'kernel', NULL, ?, ?, ?, ?)`,
        )
        .run(transactionId, idempotencyKey, commandPayloadDigest, enrolledAt, enrolledAt);
      const sequence = Number(transaction.lastInsertRowid);
      const scope = canonicalJson({ deploymentId: metadata.databaseLineageId });
      for (const occurrence of [
        { recordId: controllerDefinitionRecordId, occurrenceType: "record" as const, kind: "repository.controller-definition", recordClass: "definition" as const },
        { recordId: enrollmentRecordId, occurrenceType: "record" as const, kind: "repository.enrolled", recordClass: "fact" as const },
        { recordId: eventRecordId, occurrenceType: "event" as const, kind: "repository.enrollment-established" },
      ].map((value, transactionPosition) => ({ ...value, transactionPosition }))) {
        this.insertOccurrence({
          ...occurrence,
          schemaVersion: 1,
          subjectKind: "github-repository",
          subjectId: surfacePayload.repositoryId,
          revisionKind: "git-commit-sha1",
          revisionValue: `sha1:${surfacePayload.repositoryCommitId}`,
          sourceKind: "github-repository",
          sourceId: surfacePayload.repositoryId,
          sourceRevisionKind: "git-commit-sha1",
          sourceRevisionValue: `sha1:${surfacePayload.repositoryCommitId}`,
          informationClass: "organization",
          informationScopeJson: scope,
          payloadJson,
          payloadDigest,
          correlationId: enrollmentRecordId,
          causationRecordId: input.surfaceReconciliationRecordId,
          transactionSequence: sequence,
          recordedAt: enrolledAt,
        });
      }
      const result: RepositoryEnrollmentResult = {
        repositoryId: surfacePayload.repositoryId,
        coreSnapshotId: surfacePayload.coreSnapshotId,
        coreAuthorizationRecordId: surfacePayload.coreAuthorizationRecordId,
        githubReconciliationRecordId: surfacePayload.githubReconciliationRecordId,
        surfaceReconciliationRecordId: input.surfaceReconciliationRecordId,
        surfacePolicyDecisionRecordId: surfacePayload.policyDecisionRecordId,
        controllerDefinitionRecordId,
        enrollmentRecordId,
        eventRecordId,
        repositoryCommitId: surfacePayload.repositoryCommitId,
        enrolledAt,
        transactionPositions: [0, 1, 2],
        transactionSequence: sequence,
      };
      this.insertReceipt(commandScope, "repository.establish-enrollment", idempotencyKey, commandPayloadDigest, result, sequence);
      this.advanceControlMetadata(enrolledAt, sequence);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  imposeRepositoryOperatorHold(input: RepositoryOperatorHoldInput): RepositoryOperatorHoldResult {
    return this.recordRepositoryOperatorHoldDecision("impose", input);
  }

  clearRepositoryOperatorHold(input: RepositoryOperatorHoldClearInput): RepositoryOperatorHoldResult {
    if (!isUuidV7(input.holdDecisionId)) {
      throw new Error("repository operator hold clearance requires a UUIDv7 active hold decision");
    }
    return this.recordRepositoryOperatorHoldDecision("clear", input);
  }

  private recordRepositoryOperatorHoldDecision(
    choice: "impose" | "clear",
    input: RepositoryOperatorHoldInput | RepositoryOperatorHoldClearInput,
  ): RepositoryOperatorHoldResult {
    assertExpectedSequence(input.expectedLastTransactionSequence);
    assertSubject("github-repository", input.repositoryId);
    assertBoundedReason(input.reason, `repository operator hold ${choice} reason`);
    const requestedHoldDecisionId = choice === "clear"
      ? (input as RepositoryOperatorHoldClearInput).holdDecisionId
      : null;
    const idempotencyKey = choice === "impose"
      ? `repo-hold-impose:${input.expectedLastTransactionSequence}:${input.repositoryId.slice("github.com:".length)}`
      : `repo-hold-clear:${input.expectedLastTransactionSequence}:${requestedHoldDecisionId}`;
    const commandKind = choice === "impose"
      ? "repository.impose-operator-hold"
      : "repository.clear-operator-hold";
    const commandPayloadJson = canonicalJson({
      expectedLastTransactionSequence: input.expectedLastTransactionSequence,
      holdDecisionId: requestedHoldDecisionId,
      reason: input.reason,
      repositoryId: input.repositoryId,
    });
    const commandPayloadDigest = sha256(commandPayloadJson);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.verifyExisting(this.applicationTables());
      const metadata = this.metadata();
      const commandScope = `database:${metadata.databaseLineageId}`;
      const prior = this.db
        .prepare(
          `SELECT payload_digest, result_json FROM idempotency_receipts
           WHERE command_scope = ? AND command_kind = ?
             AND command_schema_version = 1 AND idempotency_key = ?`,
        )
        .get(commandScope, commandKind, idempotencyKey) as Row | undefined;
      if (prior) {
        if (String(prior.payload_digest) !== commandPayloadDigest) {
          throw new Error(`repository operator hold ${choice} idempotency payload changed`);
        }
        const result = parseRepositoryOperatorHoldResult(parseJson(String(prior.result_json)));
        this.db.exec("COMMIT");
        return result;
      }

      const decidedAt = this.now();
      assertCommandTimeAndSequence(metadata, decidedAt, input.expectedLastTransactionSequence);
      const current = this.repositoryStatuses().find((status) => status.repositoryId === input.repositoryId);
      if (!current || current.coreAuthorizationRecordId === null) {
        throw new Error("repository operator hold requires materialized authority from the active Core snapshot");
      }
      if (choice === "impose" && current.operatorHold !== null) {
        throw new Error(`repository already has active operator hold ${current.operatorHold.holdDecisionId}`);
      }
      if (
        choice === "clear" &&
        (current.operatorHold === null || current.operatorHold.holdDecisionId !== requestedHoldDecisionId)
      ) {
        throw new Error("repository operator hold clearance does not name the exact active hold");
      }
      const authorityRow = this.db
        .prepare(
          `SELECT payload_json FROM durable_occurrences
           WHERE record_id = ? AND kind = 'repository.core-authorized'`,
        )
        .get(current.coreAuthorizationRecordId) as Row | undefined;
      const authorityPayload = authorityRow ? parseJson(String(authorityRow.payload_json)) : null;
      if (!recordKindRegistry["repository.core-authorized"].validatePayload(authorityPayload)) {
        throw new Error("repository operator hold Core authority is invalid");
      }

      const decisionRecordId = uuidV7(new Date(decidedAt));
      const eventRecordId = uuidV7(new Date(decidedAt));
      const transactionId = uuidV7(new Date(decidedAt));
      const holdDecisionId = choice === "impose" ? decisionRecordId : requestedHoldDecisionId!;
      const payload = {
        decisionRecordId,
        eventRecordId,
        decisionType: "repository-local-hold",
        state: "resolved",
        choice,
        repositoryId: input.repositoryId,
        coreSnapshotId: current.coreSnapshotId,
        coreAuthorizationRecordId: current.coreAuthorizationRecordId,
        declarationDigest: authorityPayload.declarationDigest,
        operatorPrincipalId: metadata.operatorPrincipalId,
        holdDecisionId,
        previousDecisionRecordId: choice === "impose" ? null : holdDecisionId,
        affectedGates: [...repositoryHoldGates],
        recoveryRule: "operator-clear",
        reason: input.reason,
        expectedLastTransactionSequence: input.expectedLastTransactionSequence,
        decidedAt,
      } satisfies RepositoryOperatorHoldDecisionPayload;
      if (!recordKindRegistry["repository.operator-hold-decision"].validatePayload(payload)) {
        throw new Error("repository operator hold is outside the registered decision contract");
      }
      const payloadJson = canonicalJson(payload);
      const payloadDigest = sha256(payloadJson);
      const transaction = this.db
        .prepare(
          `INSERT INTO control_transactions (
             transaction_id, command_kind, command_schema_version, principal_kind,
             principal_id, session_id, idempotency_key, payload_digest,
             evaluation_time, recorded_at
           ) VALUES (?, ?, 1, 'operator-principal', ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          transactionId,
          commandKind,
          metadata.operatorPrincipalId,
          idempotencyKey,
          commandPayloadDigest,
          decidedAt,
          decidedAt,
        );
      const sequence = Number(transaction.lastInsertRowid);
      const common = {
        schemaVersion: 1,
        subjectKind: "github-repository" as const,
        subjectId: input.repositoryId,
        revisionKind: "core-declaration-sha256",
        revisionValue: authorityPayload.declarationDigest,
        sourceKind: "operator-principal",
        sourceId: metadata.operatorPrincipalId,
        informationClass: "organization" as const,
        informationScopeJson: canonicalJson({ deploymentId: metadata.databaseLineageId }),
        payloadJson,
        payloadDigest,
        correlationId: holdDecisionId,
        transactionSequence: sequence,
        recordedAt: decidedAt,
      };
      this.insertOccurrence({
        ...common,
        recordId: decisionRecordId,
        occurrenceType: "record",
        kind: "repository.operator-hold-decision",
        recordClass: "decision",
        causationRecordId: choice === "impose" ? current.coreAuthorizationRecordId : holdDecisionId,
        transactionPosition: 0,
      });
      this.insertOccurrence({
        ...common,
        recordId: eventRecordId,
        occurrenceType: "event",
        kind: choice === "impose" ? "repository.operator-hold-imposed" : "repository.operator-hold-cleared",
        causationRecordId: decisionRecordId,
        transactionPosition: 1,
      });
      const result: RepositoryOperatorHoldResult = {
        decisionRecordId,
        eventRecordId,
        repositoryId: input.repositoryId,
        coreSnapshotId: current.coreSnapshotId,
        coreAuthorizationRecordId: current.coreAuthorizationRecordId,
        operatorPrincipalId: metadata.operatorPrincipalId,
        holdDecisionId,
        choice,
        reason: input.reason,
        decidedAt,
        transactionPositions: [0, 1],
        transactionSequence: sequence,
      };
      this.insertReceipt(commandScope, commandKind, idempotencyKey, commandPayloadDigest, result, sequence);
      this.advanceControlMetadata(decidedAt, sequence);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  coreAdmissionReadiness(evaluatedAt = this.now()): CoreAdmissionReadiness {
    const readiness = this.coreAdmissionReadinessWithoutOverride(evaluatedAt);
    if (readiness.reason !== "source-stale" || readiness.activeSnapshotId === null) return readiness;
    const rows = this.db
      .prepare(
        `SELECT payload_json
         FROM durable_occurrences occurrence
         JOIN durable_records record ON record.record_id = occurrence.record_id
         WHERE occurrence.kind = 'core.stale-source-override-decision'
           AND record.record_class = 'decision'
         ORDER BY occurrence.transaction_sequence DESC`,
      )
      .all() as Row[];
    for (const row of rows) {
      const payload = parseJson(String(row.payload_json));
      if (!recordKindRegistry["core.stale-source-override-decision"].validatePayload(payload)) {
        throw new Error("invalid Core stale-source override decision");
      }
      if (
        payload.activeSnapshotId === readiness.activeSnapshotId &&
        payload.decidedAt <= evaluatedAt &&
        evaluatedAt < payload.expiresAt
      ) {
        return {
          ...readiness,
          ready: true,
          reason: "ready",
          overrideDecisionId: payload.decisionId,
          overrideExpiresAt: payload.expiresAt,
          degraded: true,
        };
      }
    }
    return readiness;
  }

  private coreAdmissionReadinessWithoutOverride(evaluatedAt: string): CoreAdmissionReadiness {
    assertUtcInstant(evaluatedAt, "Core admission readiness evaluation time");
    const metadata = this.metadata();
    if (evaluatedAt < metadata.controlTimeWatermark) {
      throw new Error(
        `Core admission readiness evaluation precedes control time ${metadata.controlTimeWatermark}`,
      );
    }
    const active = this.activeCoreSnapshot();
    const rows = this.db
      .prepare(
        `SELECT kind, payload_json, transaction_sequence
         FROM durable_occurrences
         WHERE occurrence_type = 'record'
           AND kind IN ('core.source-check-eligible-observation', 'core.candidate-rejection-observation')
         ORDER BY transaction_sequence DESC, transaction_position DESC`,
      )
      .all() as Row[];
    const checks: Array<{
      checkId: string;
      outcome: CoreSourceCheckOutcome;
      checkedAt: string;
      commitId: string | null;
      transactionSequence: number;
      validated: boolean;
    }> = [];
    for (const row of rows) {
      const payload = parseJson(String(row.payload_json));
      if (row.kind === "core.source-check-eligible-observation") {
        if (!recordKindRegistry["core.source-check-eligible-observation"].validatePayload(payload)) {
          throw new Error(`invalid eligible Core source check: ${String(row.transaction_sequence)}`);
        }
        checks.push({
          checkId: payload.checkId,
          outcome: "eligible",
          checkedAt: payload.checkedAt,
          commitId: payload.commitId,
          transactionSequence: Number(row.transaction_sequence),
          validated: true,
        });
      } else {
        if (!recordKindRegistry["core.candidate-rejection-observation"].validatePayload(payload)) {
          throw new Error(`invalid Core candidate rejection: ${String(row.transaction_sequence)}`);
        }
        if (payload.operation !== "automatic-source-check") continue;
        const outcome: CoreSourceCheckOutcome =
          payload.stage === "source"
            ? "source-unavailable"
            : payload.stage === "validation"
              ? "candidate-invalid"
              : payload.stage === "continuity"
                ? "continuity-blocked"
                : "persistence-failed";
        checks.push({
          checkId: payload.checkId,
          outcome,
          checkedAt: payload.observedAt,
          commitId: payload.commitId,
          transactionSequence: Number(row.transaction_sequence),
          validated: payload.stage === "continuity" || payload.stage === "persistence",
        });
      }
    }

    const latest = checks[0];
    const lastValidated = checks.find((check) => check.validated);
    const staleAt = lastValidated
      ? new Date(new Date(lastValidated.checkedAt).getTime() + 86_400_000).toISOString()
      : null;
    let reason: CoreAdmissionReadinessReason = "ready";
    if (!active) {
      reason = "no-active-snapshot";
    } else {
      const substantive = checks.find((check) => check.outcome !== "source-unavailable");
      if (substantive?.outcome === "eligible" && substantive.commitId !== active.sourceCommitId) {
        reason = "continuity-blocked";
      }
      if (substantive?.outcome === "candidate-invalid") reason = "candidate-invalid";
      if (substantive?.outcome === "persistence-failed") reason = "persistence-failed";
      if (substantive?.outcome === "continuity-blocked") {
        const resolvedByRollback =
          substantive.commitId === active.sourceCommitId &&
          active.transactionSequence > substantive.transactionSequence;
        if (!resolvedByRollback) reason = "continuity-blocked";
      }
      if (reason === "ready" && (staleAt === null || evaluatedAt >= staleAt)) reason = "source-stale";
    }
    return {
      ready: reason === "ready",
      reason,
      evaluatedAt,
      controlPlaneSequence: metadata.lastTransactionSequence,
      activeSnapshotId: active?.snapshotId ?? null,
      activeSourceCommitId: active?.sourceCommitId ?? null,
      latestCheckId: latest?.checkId ?? null,
      latestCheckOutcome: latest?.outcome ?? null,
      latestCheckedAt: latest?.checkedAt ?? null,
      lastValidatedAt: lastValidated?.checkedAt ?? null,
      maximumStalenessSeconds: 86400,
      staleAt,
      overrideDecisionId: null,
      overrideExpiresAt: null,
      degraded: false,
    };
  }

  retainedCoreCandidate(sourceCommitId: string): InspectedCoreCandidate | undefined {
    if (!/^[0-9a-f]{40}$/.test(sourceCommitId)) {
      throw new Error("retained Core candidate commit must be one canonical SHA-1 ID");
    }
    const snapshot = this.db
      .prepare(
        `SELECT * FROM core_snapshots
         WHERE source_commit_id = ?
         ORDER BY activated_transaction_sequence DESC
         LIMIT 1`,
      )
      .get(sourceCommitId) as Row | undefined;
    if (!snapshot) return undefined;
    const files = this.db
      .prepare("SELECT * FROM core_snapshot_files WHERE snapshot_id = ? ORDER BY path")
      .all(snapshot.snapshot_id!) as Row[];
    const entries: CoreTreeEntry[] = files.map((file) => {
      if (!(file.raw_bytes instanceof Uint8Array)) {
        throw new Error(`retained Core snapshot file is not bytes: ${String(file.path)}`);
      }
      return {
        path: String(file.path),
        mode: String(file.mode) as "100644" | "100755",
        objectId: String(file.object_id),
        bytes: file.raw_bytes,
      };
    });
    return {
      sourceUrl: String(snapshot.source_url),
      ref: String(snapshot.source_ref),
      commitId: String(snapshot.source_commit_id),
      treeId: String(snapshot.source_tree_id),
      files: entries,
      ...validateCoreCatalog(entries),
    };
  }

  authoritativeDigest(): string {
    const content = {
      metadata: this.queryJsonRows("SELECT * FROM control_plane_metadata ORDER BY singleton"),
      transactions: this.queryJsonRows("SELECT * FROM control_transactions ORDER BY sequence"),
      subjects: this.queryJsonRows("SELECT * FROM subjects ORDER BY subject_kind, subject_id"),
      occurrences: this.queryJsonRows(
        "SELECT * FROM durable_occurrences ORDER BY transaction_sequence, transaction_position",
      ),
      records: this.queryJsonRows("SELECT * FROM durable_records ORDER BY record_id"),
      events: this.queryJsonRows("SELECT * FROM event_ledger ORDER BY record_id"),
      receipts: this.queryJsonRows(
        `SELECT * FROM idempotency_receipts
         ORDER BY command_scope, command_kind, command_schema_version, idempotency_key`,
      ),
      coreSnapshots: this.queryJsonRows("SELECT * FROM core_snapshots ORDER BY activated_transaction_sequence"),
      coreSnapshotFiles: this.queryJsonRows(
        `SELECT snapshot_id, path, mode, object_id, byte_size, content_digest, parsed_json
         FROM core_snapshot_files ORDER BY snapshot_id, path`,
      ),
      coreActiveSnapshot: this.queryJsonRows("SELECT * FROM core_active_snapshot ORDER BY singleton"),
      corePollState: this.queryJsonRows("SELECT * FROM core_poll_state ORDER BY singleton"),
      transactionAllocation: this.sqliteTransactionAllocation(),
    } satisfies JsonValue;
    return sha256(canonicalJson(content));
  }

  async createBackup(path: string): Promise<ControlPlaneBackupManifest> {
    const backupPath = this.assertNewArtifactPath(path, "backup");
    const createdAt = this.now();
    const backupSource =
      this.databasePath === ":memory:" ? this.db : new DatabaseSync(this.databasePath, { readOnly: true });
    try {
      await sqliteBackup(backupSource, backupPath);
    } finally {
      if (backupSource !== this.db) backupSource.close();
    }
    const verification = ControlPlaneStore.inspectArtifact(backupPath, createdAt);
    const current = this.metadata();
    if (
      verification.manifest.databaseLineageId !== current.databaseLineageId ||
      verification.manifest.lastTransactionSequence !== current.lastTransactionSequence ||
      verification.manifest.authoritativeDigest !== this.authoritativeDigest()
    ) {
      throw new Error("completed backup does not match the current authoritative database state");
    }
    return verification.manifest;
  }

  static verifyBackup(
    manifest: ControlPlaneBackupManifest,
    expectation: { databaseLineageId: string; minimumLastTransactionSequence: number },
  ): ControlPlaneBackupVerification {
    assertBackupExpectation(expectation);
    assertBackupManifest(manifest);
    const backupPath = resolve(manifest.backupPath);
    if (!existsSync(backupPath)) throw new Error(`backup file does not exist: ${backupPath}`);
    const actual = ControlPlaneStore.inspectArtifact(backupPath, manifest.createdAt);
    assertBackupContentMatches(actual.manifest, manifest);
    if (actual.manifest.databaseLineageId !== expectation.databaseLineageId) {
      throw new Error("backup database lineage does not match the expected lineage");
    }
    if (actual.manifest.lastTransactionSequence < expectation.minimumLastTransactionSequence) {
      throw new Error(
        `backup sequence ${actual.manifest.lastTransactionSequence} is older than previously visible sequence ` +
          `${expectation.minimumLastTransactionSequence}; restore would permit transaction-sequence reuse`,
      );
    }
    return actual;
  }

  static async stageRestore(
    manifest: ControlPlaneBackupManifest,
    targetPathInput: string,
    expectation: { databaseLineageId: string; minimumLastTransactionSequence: number },
  ): Promise<ControlPlaneBackupVerification> {
    const verifiedBackup = ControlPlaneStore.verifyBackup(manifest, expectation);
    const sourcePath = resolve(manifest.backupPath);
    const targetPath = resolve(targetPathInput);
    if (targetPath === sourcePath) throw new Error("restore target must differ from the backup path");
    if (targetPath === resolve(process.env.FLUENT_QUEUE_DB ?? "./data/queue.db")) {
      throw new Error("restore target must differ from the queue-spike path");
    }
    if (existsSync(targetPath)) throw new Error(`restore target already exists: ${targetPath}`);
    mkdirSync(dirname(targetPath), { recursive: true });
    reserveArtifactPath(targetPath, "restore target");
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      await sqliteBackup(source, targetPath);
    } finally {
      source.close();
    }
    const restored = ControlPlaneStore.inspectArtifact(targetPath, verifiedBackup.manifest.createdAt);
    assertBackupContentMatches(restored.manifest, verifiedBackup.manifest, false);
    return restored;
  }

  projectionHealth(): ProjectionHealth[] {
    const currentSequence = this.metadata().lastTransactionSequence;
    return (Object.keys(projectionContractRegistry) as ProjectionName[]).map((projectionName) => {
      try {
        const generation = this.activeProjectionGeneration(projectionName);
        const lag = currentSequence - generation.sourceSequence;
        if (lag < 0) throw new Error("projection source watermark is ahead of authoritative state");
        this.verifyProjectionGeneration(generation);
        return {
          projectionName,
          activeGenerationId: generation.generationId,
          sourceSequence: generation.sourceSequence,
          currentSequence,
          lag,
          status: lag === 0 ? "current" : "stale",
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const unavailable = /has no active generation/.test(detail);
        return {
          projectionName,
          currentSequence,
          lag: currentSequence,
          status: unavailable ? "unavailable" : "invalid",
          detail,
        };
      }
    });
  }

  rebuildProjections(): ProjectionGeneration[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.verifyExisting(this.applicationTables());
      const metadata = this.metadata();
      const evaluationTime = this.now();
      const generations = (Object.keys(projectionContractRegistry) as ProjectionName[]).map((projectionName) =>
        this.buildProjectionShadow(projectionName, metadata.lastTransactionSequence, evaluationTime),
      );
      this.faultInjector?.("after-projection-shadow-write");
      this.publishProjectionGenerations(generations, evaluationTime);
      this.db.exec("COMMIT");
      return generations;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  repairProjections(): ProjectionGeneration[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.verifyExisting(this.applicationTables(), false);
      const metadata = this.metadata();
      const evaluationTime = this.now();
      this.db.exec(`
        DELETE FROM projection_heads;
        DELETE FROM projection_subject_lookup;
        DELETE FROM projection_event_cursor;
        DELETE FROM projection_generations;
      `);
      const generations = (Object.keys(projectionContractRegistry) as ProjectionName[]).map((projectionName) =>
        this.buildProjectionShadow(projectionName, metadata.lastTransactionSequence, evaluationTime),
      );
      this.faultInjector?.("after-projection-shadow-write");
      this.publishProjectionGenerations(generations, evaluationTime);
      this.db.exec("COMMIT");
      return generations;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  projectedSubjects(access: ProjectionAccess): ProjectionReadResult<ProjectedSubject> {
    this.assertProjectionAccess(access);
    const generation = this.activeProjectionGeneration("control-plane.subject-lookup");
    this.verifyProjectionGeneration(generation);
    const rows = this.db
      .prepare(
        `SELECT projected.*, source.information_class AS current_information_class,
                source.information_scope_json AS current_information_scope_json
         FROM projection_subject_lookup projected
         JOIN durable_occurrences source ON source.record_id = projected.definition_record_id
         JOIN durable_records record ON record.record_id = source.record_id AND record.record_class = 'definition'
         WHERE projected.generation_id = ?
         ORDER BY projected.subject_kind, projected.subject_id`,
      )
      .all(generation.generationId) as Row[];
    return {
      generation,
      stale: generation.sourceSequence !== this.metadata().lastTransactionSequence,
      rows: rows
        .filter((row) =>
          this.canAccessProjectionRow(
            access,
            String(row.current_information_class),
            String(row.current_information_scope_json),
          ),
        )
        .map((row) => decodeProjectedSubject(row)),
    };
  }

  projectedEvents(
    access: ProjectionAccess,
    after: { transactionSequence: number; transactionPosition: number } = {
      transactionSequence: 0,
      transactionPosition: -1,
    },
    limit = 100,
  ): ProjectionReadResult<ProjectedEvent> {
    this.assertProjectionAccess(access);
    if (!Number.isSafeInteger(after.transactionSequence) || after.transactionSequence < 0) {
      throw new Error("event cursor transactionSequence must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(after.transactionPosition) || after.transactionPosition < -1) {
      throw new Error("event cursor transactionPosition must be a safe integer of at least -1");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("event cursor limit must be a safe integer from 1 through 1000");
    }
    const generation = this.activeProjectionGeneration("control-plane.event-cursor");
    this.verifyProjectionGeneration(generation);
    const rows = this.db
      .prepare(
        `SELECT projected.*, source.information_class AS current_information_class,
                source.information_scope_json AS current_information_scope_json
         FROM projection_event_cursor projected
         JOIN durable_occurrences source ON source.record_id = projected.record_id
         JOIN event_ledger event ON event.record_id = source.record_id
         WHERE projected.generation_id = ?
           AND (projected.transaction_sequence > ? OR
                (projected.transaction_sequence = ? AND projected.transaction_position > ?))
         ORDER BY projected.transaction_sequence, projected.transaction_position`,
      )
      .all(
        generation.generationId,
        after.transactionSequence,
        after.transactionSequence,
        after.transactionPosition,
      ) as Row[];
    return {
      generation,
      stale: generation.sourceSequence !== this.metadata().lastTransactionSequence,
      rows: rows
        .filter((row) =>
          this.canAccessProjectionRow(
            access,
            String(row.current_information_class),
            String(row.current_information_scope_json),
          ),
        )
        .slice(0, limit)
        .map((row) => decodeProjectedEvent(row)),
    };
  }

  checkIntegrity(input: IntegrityCheckInput): IntegrityCheckResult {
    if (!Number.isSafeInteger(input.expectedLastTransactionSequence) || input.expectedLastTransactionSequence < 1) {
      throw new Error("expectedLastTransactionSequence must be a positive safe integer");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.idempotencyKey)) {
      throw new Error("idempotencyKey must be 1-128 portable characters");
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.verifyExisting(this.applicationTables());
      const metadata = this.metadata();
      const commandScope = `database:${metadata.databaseLineageId}`;
      const commandPayloadJson = canonicalJson({
        expectedLastTransactionSequence: input.expectedLastTransactionSequence,
      });
      const commandPayloadDigest = sha256(commandPayloadJson);
      const prior = this.db
        .prepare(
          `SELECT payload_digest, result_json
           FROM idempotency_receipts
           WHERE command_scope = ? AND command_kind = 'control-plane.check-integrity'
             AND command_schema_version = 1 AND idempotency_key = ?`,
        )
        .get(commandScope, input.idempotencyKey) as Row | undefined;
      if (prior) {
        if (String(prior.payload_digest) !== commandPayloadDigest) {
          throw new Error("idempotency key was already used with a different command payload");
        }
        const result = parseIntegrityCheckResult(parseJson(String(prior.result_json)));
        this.db.exec("COMMIT");
        return result;
      }

      const evaluationTime = this.now();
      if (evaluationTime < metadata.controlTimeWatermark) {
        throw new Error(
          `control-plane clock moved backwards behind ${metadata.controlTimeWatermark}; refusing a new write transaction`,
        );
      }
      if (metadata.lastTransactionSequence !== input.expectedLastTransactionSequence) {
        throw new Error(
          `stale control-plane sequence: expected ${input.expectedLastTransactionSequence}, current ${metadata.lastTransactionSequence}`,
        );
      }

      const integrity = this.db.prepare("PRAGMA quick_check").get() as Row | undefined;
      if (String(integrity?.quick_check) !== "ok") throw new Error("control-plane SQLite integrity check failed");

      const transactionId = uuidV7(new Date(evaluationTime));
      const observationRecordId = uuidV7(new Date(evaluationTime));
      const eventRecordId = uuidV7(new Date(evaluationTime));
      const correlationId = uuidV7(new Date(evaluationTime));
      const payload = {
        checkedThroughSequence: metadata.lastTransactionSequence,
        databaseLineageId: metadata.databaseLineageId,
        registryVersion: CONTROL_PLANE_REGISTRY_VERSION,
        result: "ok",
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      } satisfies JsonValue;
      const payloadJson = canonicalJson(payload);
      const payloadDigest = sha256(payloadJson);
      const informationScopeJson = canonicalJson({ deploymentId: metadata.databaseLineageId });

      const transaction = this.db
        .prepare(
          `INSERT INTO control_transactions (
             transaction_id, command_kind, command_schema_version, principal_kind,
             principal_id, session_id, idempotency_key, payload_digest,
             evaluation_time, recorded_at
           ) VALUES (?, 'control-plane.check-integrity', 1, 'fluent-system', 'kernel', NULL, ?, ?, ?, ?)`,
        )
        .run(transactionId, input.idempotencyKey, commandPayloadDigest, evaluationTime, evaluationTime);
      const sequence = Number(transaction.lastInsertRowid);
      const common = {
        schemaVersion: 1,
        subjectKind: "control-plane-database" as const,
        subjectId: metadata.databaseLineageId,
        revisionKind: "transaction-sequence",
        revisionValue: String(metadata.lastTransactionSequence),
        sourceKind: "fluent-system",
        sourceId: "kernel",
        informationClass: "organization" as const,
        informationScopeJson,
        payloadJson,
        payloadDigest,
        correlationId,
        transactionSequence: sequence,
        recordedAt: evaluationTime,
      };
      this.insertOccurrence({
        ...common,
        recordId: observationRecordId,
        occurrenceType: "record",
        kind: "control-plane.integrity-observation",
        recordClass: "observation",
        transactionPosition: 0,
      });
      this.faultInjector?.("after-integrity-observation");
      this.insertOccurrence({
        ...common,
        recordId: eventRecordId,
        occurrenceType: "event",
        kind: "control-plane.integrity-checked",
        transactionPosition: 1,
      });

      const result: IntegrityCheckResult = {
        checkedThroughSequence: metadata.lastTransactionSequence,
        eventRecordId,
        evaluationTime,
        observationRecordId,
        recordedTime: evaluationTime,
        result: "ok",
        transactionPositions: [0, 1],
        transactionSequence: sequence,
      };
      const resultJson = canonicalJson(result as unknown as JsonValue);
      this.db
        .prepare(
          `INSERT INTO idempotency_receipts (
             command_scope, command_kind, command_schema_version, idempotency_key,
             payload_digest, result_json, transaction_sequence, retained_until
           ) VALUES (?, 'control-plane.check-integrity', 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          commandScope,
          input.idempotencyKey,
          commandPayloadDigest,
          resultJson,
          sequence,
          IDEMPOTENCY_RETAINED_UNTIL,
        );
      this.db
        .prepare(
          `UPDATE control_plane_metadata
           SET control_time_watermark = ?, last_transaction_sequence = ?
           WHERE singleton = 1`,
        )
        .run(evaluationTime, sequence);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  activateCoreSnapshot(input: CoreSnapshotActivationInput): CoreSnapshotActivationResult {
    if (!Number.isSafeInteger(input.expectedLastTransactionSequence) || input.expectedLastTransactionSequence < 1) {
      throw new Error("expectedLastTransactionSequence must be a positive safe integer");
    }
    const candidate = input.candidate;
    assertMaterializedCoreCandidate(candidate);
    const validated = validateCoreCatalog(candidate.files);
    assertCandidateReport(candidate, validated);
    const idempotencyKey = `core-activate:${input.expectedLastTransactionSequence}:${candidate.commitId}`;
    const commandPayloadJson = canonicalJson({
      catalogDigest: validated.catalogDigest,
      expectedLastTransactionSequence: input.expectedLastTransactionSequence,
      sourceCommitId: candidate.commitId,
      sourceRef: candidate.ref,
      sourceTreeId: candidate.treeId,
      sourceUrl: candidate.sourceUrl,
    });
    const commandPayloadDigest = sha256(commandPayloadJson);
    let authorityWriteStarted = false;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.verifyExisting(this.applicationTables());
      const metadata = this.metadata();
      const commandScope = `database:${metadata.databaseLineageId}`;
      const prior = this.db
        .prepare(
          `SELECT payload_digest, result_json
           FROM idempotency_receipts
           WHERE command_scope = ? AND command_kind = 'core.activate-snapshot'
             AND command_schema_version = 1 AND idempotency_key = ?`,
        )
        .get(commandScope, idempotencyKey) as Row | undefined;
      if (prior) {
        if (String(prior.payload_digest) !== commandPayloadDigest) {
          throw new Error("Core commit was already activated with a different command payload");
        }
        const result = parseCoreSnapshotActivationResult(parseJson(String(prior.result_json)));
        this.db.exec("COMMIT");
        return result;
      }

      const evaluationTime = this.now();
      if (evaluationTime < metadata.controlTimeWatermark) {
        throw new Error(
          `control-plane clock moved backwards behind ${metadata.controlTimeWatermark}; refusing a new write transaction`,
        );
      }
      if (metadata.lastTransactionSequence !== input.expectedLastTransactionSequence) {
        throw new Error(
          `stale control-plane sequence: expected ${input.expectedLastTransactionSequence}, current ${metadata.lastTransactionSequence}`,
        );
      }
      const active = this.activeCoreSnapshot();
      if (active) {
        const activeCandidate = this.retainedCoreCandidate(active.sourceCommitId);
        if (!activeCandidate) throw new Error("active Core candidate is not retained");
        assertRepositoryDeclarationRetention(activeCandidate, validated);
        if (input.continuityAncestorCommitId !== active.sourceCommitId) {
          throw new Error(
            `automatic Core activation requires source continuity from active commit ${active.sourceCommitId}`,
          );
        }
      } else if (input.continuityAncestorCommitId !== undefined) {
        throw new Error("initial Core activation must not claim a continuity ancestor");
      }

      const snapshotId = uuidV7(new Date(evaluationTime));
      const transactionId = uuidV7(new Date(evaluationTime));
      const definitionRecordId = uuidV7(new Date(evaluationTime));
      const activeFactRecordId = uuidV7(new Date(evaluationTime));
      const eventRecordId = uuidV7(new Date(evaluationTime));
      const correlationId = uuidV7(new Date(evaluationTime));
      const definitionPayload = {
        snapshotId,
        sourceRepositoryId: "github.com:1331309458",
        sourceUrl: candidate.sourceUrl,
        sourceRef: candidate.ref,
        sourceCommitId: candidate.commitId,
        sourceTreeId: candidate.treeId,
        catalogDigest: validated.catalogDigest,
        fileCount: validated.fileCount,
        totalBytes: validated.totalBytes,
        repositoryCount: validated.repositoryCount,
        validFixtureCount: validated.validFixtureCount,
        invalidFixtureCount: validated.invalidFixtureCount,
        schemaDigests: validated.schemaDigests,
        importedAt: evaluationTime,
      } satisfies JsonValue;
      if (!recordKindRegistry["core.snapshot-definition"].validatePayload(definitionPayload)) {
        throw new Error("Core candidate source or validation report is outside the activation contract");
      }
      const activePayload = {
        databaseLineageId: metadata.databaseLineageId,
        snapshotId,
        catalogDigest: validated.catalogDigest,
        sourceCommitId: candidate.commitId,
        activatedAt: evaluationTime,
      } satisfies JsonValue;
      const definitionPayloadJson = canonicalJson(definitionPayload);
      const definitionPayloadDigest = sha256(definitionPayloadJson);
      const activePayloadJson = canonicalJson(activePayload);
      const activePayloadDigest = sha256(activePayloadJson);
      const informationScopeJson = canonicalJson({ deploymentId: metadata.databaseLineageId });

      authorityWriteStarted = true;
      const transaction = this.db
        .prepare(
          `INSERT INTO control_transactions (
             transaction_id, command_kind, command_schema_version, principal_kind,
             principal_id, session_id, idempotency_key, payload_digest,
             evaluation_time, recorded_at
           ) VALUES (?, 'core.activate-snapshot', 1, 'fluent-system', 'kernel', NULL, ?, ?, ?, ?)`,
        )
        .run(transactionId, idempotencyKey, commandPayloadDigest, evaluationTime, evaluationTime);
      const sequence = Number(transaction.lastInsertRowid);
      this.db
        .prepare(
          `INSERT INTO subjects (subject_kind, subject_id, created_transaction_sequence)
           VALUES ('core-snapshot', ?, ?)`,
        )
        .run(snapshotId, sequence);
      const source = {
        sourceKind: "github-repository",
        sourceId: "github.com:1331309458",
        sourceRevisionKind: "git-commit-sha1",
        sourceRevisionValue: `sha1:${candidate.commitId}`,
      };
      this.insertOccurrence({
        recordId: definitionRecordId,
        occurrenceType: "record",
        kind: "core.snapshot-definition",
        schemaVersion: 1,
        recordClass: "definition",
        subjectKind: "core-snapshot",
        subjectId: snapshotId,
        revisionKind: "core-catalog-sha256",
        revisionValue: validated.catalogDigest,
        ...source,
        informationClass: "organization",
        informationScopeJson,
        payloadJson: definitionPayloadJson,
        payloadDigest: definitionPayloadDigest,
        correlationId,
        transactionSequence: sequence,
        transactionPosition: 0,
        recordedAt: evaluationTime,
      });
      this.insertOccurrence({
        recordId: activeFactRecordId,
        occurrenceType: "record",
        kind: "core.snapshot-active",
        schemaVersion: 1,
        recordClass: "fact",
        subjectKind: "control-plane-database",
        subjectId: metadata.databaseLineageId,
        revisionKind: "transaction-sequence",
        revisionValue: String(sequence),
        ...source,
        informationClass: "organization",
        informationScopeJson,
        payloadJson: activePayloadJson,
        payloadDigest: activePayloadDigest,
        correlationId,
        transactionSequence: sequence,
        transactionPosition: 1,
        recordedAt: evaluationTime,
      });
      this.insertOccurrence({
        recordId: eventRecordId,
        occurrenceType: "event",
        kind: "core.snapshot-activated",
        schemaVersion: 1,
        subjectKind: "core-snapshot",
        subjectId: snapshotId,
        revisionKind: "core-catalog-sha256",
        revisionValue: validated.catalogDigest,
        ...source,
        informationClass: "organization",
        informationScopeJson,
        payloadJson: activePayloadJson,
        payloadDigest: activePayloadDigest,
        correlationId,
        transactionSequence: sequence,
        transactionPosition: 2,
        recordedAt: evaluationTime,
      });
      this.db
        .prepare(
          `INSERT INTO core_snapshots (
             snapshot_id, snapshot_kind, source_kind, source_id, source_url, source_ref,
             source_commit_id, source_tree_id, catalog_digest, imported_at,
             definition_record_id, active_fact_record_id, activation_event_record_id,
             activated_transaction_sequence
           ) VALUES (?, 'core-snapshot', 'github-repository', 'github.com:1331309458', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshotId,
          candidate.sourceUrl,
          candidate.ref,
          candidate.commitId,
          candidate.treeId,
          validated.catalogDigest,
          evaluationTime,
          definitionRecordId,
          activeFactRecordId,
          eventRecordId,
          sequence,
        );
      const insertFile = this.db.prepare(
        `INSERT INTO core_snapshot_files (
           snapshot_id, path, mode, object_id, byte_size, content_digest, parsed_json, raw_bytes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const parsedRepositories = new Map(
        validated.repositories.map((repository) => [
          repository.path,
          canonicalJson(repository.declaration as unknown as JsonValue),
        ]),
      );
      for (const file of [...candidate.files].sort((left, right) => left.path.localeCompare(right.path))) {
        insertFile.run(
          snapshotId,
          file.path,
          file.mode,
          file.objectId,
          file.bytes.byteLength,
          sha256Bytes(file.bytes),
          parsedRepositories.get(file.path) ?? null,
          file.bytes,
        );
      }
      this.faultInjector?.("after-core-snapshot-files");
      this.db
        .prepare(
          `INSERT INTO core_active_snapshot (
             singleton, snapshot_id, fact_record_id, activated_transaction_sequence, activated_at
           ) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(singleton) DO UPDATE SET
             snapshot_id = excluded.snapshot_id,
             fact_record_id = excluded.fact_record_id,
             activated_transaction_sequence = excluded.activated_transaction_sequence,
             activated_at = excluded.activated_at`,
        )
        .run(snapshotId, activeFactRecordId, sequence, evaluationTime);

      const result: CoreSnapshotActivationResult = {
        snapshotId,
        definitionRecordId,
        activeFactRecordId,
        eventRecordId,
        catalogDigest: validated.catalogDigest,
        sourceCommitId: candidate.commitId,
        importedAt: evaluationTime,
        transactionPositions: [0, 1, 2],
        transactionSequence: sequence,
      };
      this.db
        .prepare(
          `INSERT INTO idempotency_receipts (
             command_scope, command_kind, command_schema_version, idempotency_key,
             payload_digest, result_json, transaction_sequence, retained_until
           ) VALUES (?, 'core.activate-snapshot', 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          commandScope,
          idempotencyKey,
          commandPayloadDigest,
          canonicalJson(result as unknown as JsonValue),
          sequence,
          IDEMPOTENCY_RETAINED_UNTIL,
        );
      this.db
        .prepare(
          `UPDATE control_plane_metadata
           SET control_time_watermark = ?, last_transaction_sequence = ?
           WHERE singleton = 1`,
        )
        .run(evaluationTime, sequence);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (authorityWriteStarted) {
        throw new CoreSnapshotPersistenceError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  rollbackCoreSnapshot(input: CoreSnapshotRollbackInput): CoreSnapshotRollbackResult {
    if (!Number.isSafeInteger(input.expectedLastTransactionSequence) || input.expectedLastTransactionSequence < 1) {
      throw new Error("expectedLastTransactionSequence must be a positive safe integer");
    }
    assertBoundedReason(input.reason, "Core rollback reason");
    const candidate = input.candidate;
    assertMaterializedCoreCandidate(candidate);
    const validated = validateCoreCatalog(candidate.files);
    assertCandidateReport(candidate, validated);
    const idempotencyKey = `core-rollback:${input.expectedLastTransactionSequence}:${candidate.commitId}`;
    const commandPayloadJson = canonicalJson({
      catalogDigest: validated.catalogDigest,
      expectedLastTransactionSequence: input.expectedLastTransactionSequence,
      reason: input.reason,
      sourceCommitId: candidate.commitId,
      sourceRef: candidate.ref,
      sourceTreeId: candidate.treeId,
      sourceUrl: candidate.sourceUrl,
    });
    const commandPayloadDigest = sha256(commandPayloadJson);
    let authorityWriteStarted = false;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.verifyExisting(this.applicationTables());
      const metadata = this.metadata();
      const commandScope = `database:${metadata.databaseLineageId}`;
      const prior = this.db
        .prepare(
          `SELECT payload_digest, result_json
           FROM idempotency_receipts
           WHERE command_scope = ? AND command_kind = 'core.rollback-snapshot'
             AND command_schema_version = 1 AND idempotency_key = ?`,
        )
        .get(commandScope, idempotencyKey) as Row | undefined;
      if (prior) {
        if (String(prior.payload_digest) !== commandPayloadDigest) {
          throw new Error("Core rollback target was already used with a different command payload");
        }
        const result = parseCoreSnapshotRollbackResult(parseJson(String(prior.result_json)));
        this.db.exec("COMMIT");
        return result;
      }

      const evaluationTime = this.now();
      if (evaluationTime < metadata.controlTimeWatermark) {
        throw new Error(
          `control-plane clock moved backwards behind ${metadata.controlTimeWatermark}; refusing a new write transaction`,
        );
      }
      if (metadata.lastTransactionSequence !== input.expectedLastTransactionSequence) {
        throw new Error(
          `stale control-plane sequence: expected ${input.expectedLastTransactionSequence}, current ${metadata.lastTransactionSequence}`,
        );
      }
      const previous = this.activeCoreSnapshot();
      if (!previous) throw new Error("Core rollback requires an active snapshot");
      const previousCandidate = this.retainedCoreCandidate(previous.sourceCommitId);
      if (!previousCandidate) throw new Error("active Core candidate is not retained");
      assertRepositoryDeclarationRetention(previousCandidate, validated);
      if (previous.sourceCommitId === candidate.commitId) {
        throw new Error("Core rollback target is already the active source commit");
      }

      const decisionRecordId = uuidV7(new Date(evaluationTime));
      const snapshotId = uuidV7(new Date(evaluationTime));
      const transactionId = uuidV7(new Date(evaluationTime));
      const definitionRecordId = uuidV7(new Date(evaluationTime));
      const activeFactRecordId = uuidV7(new Date(evaluationTime));
      const eventRecordId = uuidV7(new Date(evaluationTime));
      const decisionPayload = {
        decisionId: decisionRecordId,
        decisionType: "core-rollback",
        state: "resolved",
        choice: "activate-target-commit",
        databaseLineageId: metadata.databaseLineageId,
        operatorPrincipalId: metadata.operatorPrincipalId,
        activeSnapshotId: previous.snapshotId,
        activeCommitId: previous.sourceCommitId,
        targetCommitId: candidate.commitId,
        targetCatalogDigest: validated.catalogDigest,
        reason: input.reason,
        expectedLastTransactionSequence: input.expectedLastTransactionSequence,
        decidedAt: evaluationTime,
      } satisfies CoreRollbackDecisionPayload;
      if (!recordKindRegistry["core.rollback-decision"].validatePayload(decisionPayload)) {
        throw new Error("Core rollback decision is outside the registered contract");
      }
      const definitionPayload = {
        snapshotId,
        sourceRepositoryId: "github.com:1331309458",
        sourceUrl: candidate.sourceUrl,
        sourceRef: candidate.ref,
        sourceCommitId: candidate.commitId,
        sourceTreeId: candidate.treeId,
        catalogDigest: validated.catalogDigest,
        fileCount: validated.fileCount,
        totalBytes: validated.totalBytes,
        repositoryCount: validated.repositoryCount,
        validFixtureCount: validated.validFixtureCount,
        invalidFixtureCount: validated.invalidFixtureCount,
        schemaDigests: validated.schemaDigests,
        importedAt: evaluationTime,
      } satisfies JsonValue;
      if (!recordKindRegistry["core.snapshot-definition"].validatePayload(definitionPayload)) {
        throw new Error("Core rollback candidate is outside the snapshot definition contract");
      }
      const activePayload = {
        databaseLineageId: metadata.databaseLineageId,
        snapshotId,
        catalogDigest: validated.catalogDigest,
        sourceCommitId: candidate.commitId,
        activatedAt: evaluationTime,
      } satisfies JsonValue;
      const rollbackEventPayload = {
        databaseLineageId: metadata.databaseLineageId,
        snapshotId,
        catalogDigest: validated.catalogDigest,
        sourceCommitId: candidate.commitId,
        previousSnapshotId: previous.snapshotId,
        previousSourceCommitId: previous.sourceCommitId,
        decisionRecordId,
        operatorPrincipalId: metadata.operatorPrincipalId,
        reason: input.reason,
        activatedAt: evaluationTime,
      } satisfies CoreRollbackActivatedPayload;
      if (!eventKindRegistry["core.snapshot-rollback-activated"].validatePayload(rollbackEventPayload)) {
        throw new Error("Core rollback activation event is outside the registered contract");
      }
      const decisionPayloadJson = canonicalJson(decisionPayload);
      const definitionPayloadJson = canonicalJson(definitionPayload);
      const activePayloadJson = canonicalJson(activePayload);
      const rollbackEventPayloadJson = canonicalJson(rollbackEventPayload);
      const informationScopeJson = canonicalJson({ deploymentId: metadata.databaseLineageId });

      authorityWriteStarted = true;
      const transaction = this.db
        .prepare(
          `INSERT INTO control_transactions (
             transaction_id, command_kind, command_schema_version, principal_kind,
             principal_id, session_id, idempotency_key, payload_digest,
             evaluation_time, recorded_at
           ) VALUES (?, 'core.rollback-snapshot', 1, 'operator-principal', ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          transactionId,
          metadata.operatorPrincipalId,
          idempotencyKey,
          commandPayloadDigest,
          evaluationTime,
          evaluationTime,
        );
      const sequence = Number(transaction.lastInsertRowid);
      this.insertOccurrence({
        recordId: decisionRecordId,
        occurrenceType: "record",
        kind: "core.rollback-decision",
        schemaVersion: 1,
        recordClass: "decision",
        subjectKind: "control-plane-database",
        subjectId: metadata.databaseLineageId,
        revisionKind: "transaction-sequence",
        revisionValue: String(input.expectedLastTransactionSequence),
        sourceKind: "operator-principal",
        sourceId: metadata.operatorPrincipalId,
        informationClass: "organization",
        informationScopeJson,
        payloadJson: decisionPayloadJson,
        payloadDigest: sha256(decisionPayloadJson),
        correlationId: decisionRecordId,
        transactionSequence: sequence,
        transactionPosition: 0,
        recordedAt: evaluationTime,
      });
      this.db
        .prepare(
          `INSERT INTO subjects (subject_kind, subject_id, created_transaction_sequence)
           VALUES ('core-snapshot', ?, ?)`,
        )
        .run(snapshotId, sequence);
      const source = {
        sourceKind: "github-repository",
        sourceId: "github.com:1331309458",
        sourceRevisionKind: "git-commit-sha1",
        sourceRevisionValue: `sha1:${candidate.commitId}`,
      };
      this.insertOccurrence({
        recordId: definitionRecordId,
        occurrenceType: "record",
        kind: "core.snapshot-definition",
        schemaVersion: 1,
        recordClass: "definition",
        subjectKind: "core-snapshot",
        subjectId: snapshotId,
        revisionKind: "core-catalog-sha256",
        revisionValue: validated.catalogDigest,
        ...source,
        informationClass: "organization",
        informationScopeJson,
        payloadJson: definitionPayloadJson,
        payloadDigest: sha256(definitionPayloadJson),
        correlationId: decisionRecordId,
        causationRecordId: decisionRecordId,
        transactionSequence: sequence,
        transactionPosition: 1,
        recordedAt: evaluationTime,
      });
      this.insertOccurrence({
        recordId: activeFactRecordId,
        occurrenceType: "record",
        kind: "core.snapshot-active",
        schemaVersion: 1,
        recordClass: "fact",
        subjectKind: "control-plane-database",
        subjectId: metadata.databaseLineageId,
        revisionKind: "transaction-sequence",
        revisionValue: String(sequence),
        ...source,
        informationClass: "organization",
        informationScopeJson,
        payloadJson: activePayloadJson,
        payloadDigest: sha256(activePayloadJson),
        correlationId: decisionRecordId,
        causationRecordId: decisionRecordId,
        transactionSequence: sequence,
        transactionPosition: 2,
        recordedAt: evaluationTime,
      });
      this.insertOccurrence({
        recordId: eventRecordId,
        occurrenceType: "event",
        kind: "core.snapshot-rollback-activated",
        schemaVersion: 1,
        subjectKind: "core-snapshot",
        subjectId: snapshotId,
        revisionKind: "core-catalog-sha256",
        revisionValue: validated.catalogDigest,
        ...source,
        informationClass: "organization",
        informationScopeJson,
        payloadJson: rollbackEventPayloadJson,
        payloadDigest: sha256(rollbackEventPayloadJson),
        correlationId: decisionRecordId,
        causationRecordId: decisionRecordId,
        transactionSequence: sequence,
        transactionPosition: 3,
        recordedAt: evaluationTime,
      });
      this.db
        .prepare(
          `INSERT INTO core_snapshots (
             snapshot_id, snapshot_kind, source_kind, source_id, source_url, source_ref,
             source_commit_id, source_tree_id, catalog_digest, imported_at,
             definition_record_id, active_fact_record_id, activation_event_record_id,
             activated_transaction_sequence
           ) VALUES (?, 'core-snapshot', 'github-repository', 'github.com:1331309458', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshotId,
          candidate.sourceUrl,
          candidate.ref,
          candidate.commitId,
          candidate.treeId,
          validated.catalogDigest,
          evaluationTime,
          definitionRecordId,
          activeFactRecordId,
          eventRecordId,
          sequence,
        );
      const insertFile = this.db.prepare(
        `INSERT INTO core_snapshot_files (
           snapshot_id, path, mode, object_id, byte_size, content_digest, parsed_json, raw_bytes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const parsedRepositories = new Map(
        validated.repositories.map((repository) => [
          repository.path,
          canonicalJson(repository.declaration as unknown as JsonValue),
        ]),
      );
      for (const file of [...candidate.files].sort((left, right) => left.path.localeCompare(right.path))) {
        insertFile.run(
          snapshotId,
          file.path,
          file.mode,
          file.objectId,
          file.bytes.byteLength,
          sha256Bytes(file.bytes),
          parsedRepositories.get(file.path) ?? null,
          file.bytes,
        );
      }
      this.faultInjector?.("after-core-snapshot-files");
      this.db
        .prepare(
          `INSERT INTO core_active_snapshot (
             singleton, snapshot_id, fact_record_id, activated_transaction_sequence, activated_at
           ) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(singleton) DO UPDATE SET
             snapshot_id = excluded.snapshot_id,
             fact_record_id = excluded.fact_record_id,
             activated_transaction_sequence = excluded.activated_transaction_sequence,
             activated_at = excluded.activated_at`,
        )
        .run(snapshotId, activeFactRecordId, sequence, evaluationTime);

      const result: CoreSnapshotRollbackResult = {
        decisionRecordId,
        snapshotId,
        definitionRecordId,
        activeFactRecordId,
        eventRecordId,
        catalogDigest: validated.catalogDigest,
        sourceCommitId: candidate.commitId,
        previousSnapshotId: previous.snapshotId,
        previousSourceCommitId: previous.sourceCommitId,
        operatorPrincipalId: metadata.operatorPrincipalId,
        reason: input.reason,
        importedAt: evaluationTime,
        transactionPositions: [0, 1, 2, 3],
        transactionSequence: sequence,
      };
      this.db
        .prepare(
          `INSERT INTO idempotency_receipts (
             command_scope, command_kind, command_schema_version, idempotency_key,
             payload_digest, result_json, transaction_sequence, retained_until
           ) VALUES (?, 'core.rollback-snapshot', 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          commandScope,
          idempotencyKey,
          commandPayloadDigest,
          canonicalJson(result as unknown as JsonValue),
          sequence,
          IDEMPOTENCY_RETAINED_UNTIL,
        );
      this.db
        .prepare(
          `UPDATE control_plane_metadata
           SET control_time_watermark = ?, last_transaction_sequence = ?
           WHERE singleton = 1`,
        )
        .run(evaluationTime, sequence);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (authorityWriteStarted) {
        throw new CoreSnapshotPersistenceError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  recordCoreSourceCheckEligible(input: CoreSourceCheckEligibleInput): CoreSourceCheckEligibleResult {
    if (!isUuidV7(input.checkId)) throw new Error("Core source check ID must be UUIDv7");
    if (!Number.isSafeInteger(input.expectedLastTransactionSequence) || input.expectedLastTransactionSequence < 1) {
      throw new Error("expectedLastTransactionSequence must be a positive safe integer");
    }
    assertMaterializedCoreCandidate(input.candidate);
    const validated = validateCoreCatalog(input.candidate.files);
    assertCandidateReport(input.candidate, validated);
    const commandInput = {
      checkId: input.checkId,
      sourceUrl: input.candidate.sourceUrl,
      sourceRef: input.candidate.ref,
      commitId: input.candidate.commitId,
      treeId: input.candidate.treeId,
      catalogDigest: input.candidate.catalogDigest,
      expectedLastTransactionSequence: input.expectedLastTransactionSequence,
    } satisfies JsonValue;
    const idempotencyKey = `core-source-check:${input.checkId}`;
    const commandPayloadJson = canonicalJson(commandInput);
    const commandPayloadDigest = sha256(commandPayloadJson);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.verifyExisting(this.applicationTables());
      const metadata = this.metadata();
      const commandScope = `database:${metadata.databaseLineageId}`;
      const prior = this.db
        .prepare(
          `SELECT payload_digest, result_json
           FROM idempotency_receipts
           WHERE command_scope = ? AND command_kind = 'core.record-source-check-eligible'
             AND command_schema_version = 1 AND idempotency_key = ?`,
        )
        .get(commandScope, idempotencyKey) as Row | undefined;
      if (prior) {
        if (String(prior.payload_digest) !== commandPayloadDigest) {
          throw new Error("Core source check ID was already used with a different candidate");
        }
        const result = parseCoreSourceCheckEligibleResult(parseJson(String(prior.result_json)));
        this.db.exec("COMMIT");
        return result;
      }
      const active = this.activeCoreSnapshot();
      if (metadata.lastTransactionSequence !== input.expectedLastTransactionSequence) {
        throw new Error(
          `stale control-plane sequence: expected ${input.expectedLastTransactionSequence}, current ${metadata.lastTransactionSequence}`,
        );
      }
      if (!active || active.sourceCommitId !== input.candidate.commitId || active.catalogDigest !== validated.catalogDigest) {
        throw new Error("eligible Core source check must match the active snapshot exactly");
      }
      const checkedAt = this.now();
      if (checkedAt < metadata.controlTimeWatermark) {
        throw new Error(
          `control-plane clock moved backwards behind ${metadata.controlTimeWatermark}; refusing a new write transaction`,
        );
      }
      const payload = {
        checkId: input.checkId,
        outcome: "eligible",
        sourceUrl: input.candidate.sourceUrl,
        sourceRef: input.candidate.ref,
        commitId: input.candidate.commitId,
        treeId: input.candidate.treeId,
        catalogDigest: validated.catalogDigest,
        activeSnapshotId: active.snapshotId,
        activeCommitId: active.sourceCommitId,
        checkedAt,
      } satisfies JsonValue;
      if (!recordKindRegistry["core.source-check-eligible-observation"].validatePayload(payload)) {
        throw new Error("eligible Core source check is outside the registered contract");
      }
      const payloadJson = canonicalJson(payload);
      const payloadDigest = sha256(payloadJson);
      const transactionId = uuidV7(new Date(checkedAt));
      const observationRecordId = uuidV7(new Date(checkedAt));
      const eventRecordId = uuidV7(new Date(checkedAt));
      const informationScopeJson = canonicalJson({ deploymentId: metadata.databaseLineageId });
      const transaction = this.db
        .prepare(
          `INSERT INTO control_transactions (
             transaction_id, command_kind, command_schema_version, principal_kind,
             principal_id, session_id, idempotency_key, payload_digest,
             evaluation_time, recorded_at
           ) VALUES (?, 'core.record-source-check-eligible', 1, 'fluent-system', 'kernel', NULL, ?, ?, ?, ?)`,
        )
        .run(transactionId, idempotencyKey, commandPayloadDigest, checkedAt, checkedAt);
      const sequence = Number(transaction.lastInsertRowid);
      const common = {
        schemaVersion: 1,
        subjectKind: "control-plane-database" as const,
        subjectId: metadata.databaseLineageId,
        revisionKind: "transaction-sequence",
        revisionValue: String(metadata.lastTransactionSequence),
        sourceKind: "github-repository",
        sourceId: "github.com:1331309458",
        sourceRevisionKind: "git-commit-sha1",
        sourceRevisionValue: `sha1:${input.candidate.commitId}`,
        informationClass: "organization" as const,
        informationScopeJson,
        payloadJson,
        payloadDigest,
        correlationId: input.checkId,
        transactionSequence: sequence,
        recordedAt: checkedAt,
      };
      this.insertOccurrence({
        ...common,
        recordId: observationRecordId,
        occurrenceType: "record",
        kind: "core.source-check-eligible-observation",
        recordClass: "observation",
        transactionPosition: 0,
      });
      this.insertOccurrence({
        ...common,
        recordId: eventRecordId,
        occurrenceType: "event",
        kind: "core.source-check-eligible",
        transactionPosition: 1,
      });
      const result: CoreSourceCheckEligibleResult = {
        checkId: input.checkId,
        observationRecordId,
        eventRecordId,
        checkedAt,
        transactionPositions: [0, 1],
        transactionSequence: sequence,
      };
      this.db
        .prepare(
          `INSERT INTO idempotency_receipts (
             command_scope, command_kind, command_schema_version, idempotency_key,
             payload_digest, result_json, transaction_sequence, retained_until
           ) VALUES (?, 'core.record-source-check-eligible', 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          commandScope,
          idempotencyKey,
          commandPayloadDigest,
          canonicalJson(result as unknown as JsonValue),
          sequence,
          IDEMPOTENCY_RETAINED_UNTIL,
        );
      this.db
        .prepare(
          `UPDATE control_plane_metadata
           SET control_time_watermark = ?, last_transaction_sequence = ?
           WHERE singleton = 1`,
        )
        .run(checkedAt, sequence);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  issueCoreStaleSourceOverride(input: CoreStaleSourceOverrideInput): CoreStaleSourceOverrideResult {
    if (!Number.isSafeInteger(input.expectedLastTransactionSequence) || input.expectedLastTransactionSequence < 1) {
      throw new Error("expectedLastTransactionSequence must be a positive safe integer");
    }
    assertUtcInstant(input.expiresAt, "Core stale-source override expiry");
    assertBoundedReason(input.reason, "Core stale-source override reason");
    const expiresAtMilliseconds = new Date(input.expiresAt).getTime();
    const idempotencyKey =
      `core-stale-source-override:${input.expectedLastTransactionSequence}:${expiresAtMilliseconds}`;
    const commandInput = {
      expectedLastTransactionSequence: input.expectedLastTransactionSequence,
      expiresAt: input.expiresAt,
      reason: input.reason,
    } satisfies JsonValue;
    const commandPayloadJson = canonicalJson(commandInput);
    const commandPayloadDigest = sha256(commandPayloadJson);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.verifyExisting(this.applicationTables());
      const metadata = this.metadata();
      const commandScope = `database:${metadata.databaseLineageId}`;
      const prior = this.db
        .prepare(
          `SELECT payload_digest, result_json
           FROM idempotency_receipts
           WHERE command_scope = ? AND command_kind = 'core.issue-stale-source-override'
             AND command_schema_version = 1 AND idempotency_key = ?`,
        )
        .get(commandScope, idempotencyKey) as Row | undefined;
      if (prior) {
        if (String(prior.payload_digest) !== commandPayloadDigest) {
          throw new Error("Core stale-source override was already issued with a different payload");
        }
        const result = parseCoreStaleSourceOverrideResult(parseJson(String(prior.result_json)));
        this.db.exec("COMMIT");
        return result;
      }

      const decidedAt = this.now();
      if (decidedAt < metadata.controlTimeWatermark) {
        throw new Error(
          `control-plane clock moved backwards behind ${metadata.controlTimeWatermark}; refusing a new write transaction`,
        );
      }
      if (metadata.lastTransactionSequence !== input.expectedLastTransactionSequence) {
        throw new Error(
          `stale control-plane sequence: expected ${input.expectedLastTransactionSequence}, current ${metadata.lastTransactionSequence}`,
        );
      }
      const decidedAtMilliseconds = new Date(decidedAt).getTime();
      if (expiresAtMilliseconds <= decidedAtMilliseconds) {
        throw new Error("Core stale-source override expiry must be after its decision time");
      }
      if (expiresAtMilliseconds > decidedAtMilliseconds + 86_400_000) {
        throw new Error("Core stale-source override cannot exceed 24 hours from issuance");
      }
      const readiness = this.coreAdmissionReadinessWithoutOverride(decidedAt);
      if (
        readiness.reason !== "source-stale" ||
        readiness.activeSnapshotId === null ||
        readiness.latestCheckId === null ||
        readiness.lastValidatedAt === null ||
        readiness.staleAt === null
      ) {
        throw new Error(`Core stale-source override requires source-stale readiness; found ${readiness.reason}`);
      }

      const decisionRecordId = uuidV7(new Date(decidedAt));
      const eventRecordId = uuidV7(new Date(decidedAt));
      const transactionId = uuidV7(new Date(decidedAt));
      const payload = {
        decisionId: decisionRecordId,
        decisionType: "core-stale-source-override",
        state: "resolved",
        choice: "permit-stale-source-admission",
        databaseLineageId: metadata.databaseLineageId,
        operatorPrincipalId: metadata.operatorPrincipalId,
        activeSnapshotId: readiness.activeSnapshotId,
        latestCheckId: readiness.latestCheckId,
        lastValidatedAt: readiness.lastValidatedAt,
        staleAt: readiness.staleAt,
        maximumDurationSeconds: 86400,
        expectedLastTransactionSequence: input.expectedLastTransactionSequence,
        reason: input.reason,
        decidedAt,
        expiresAt: input.expiresAt,
      } satisfies JsonValue;
      if (!recordKindRegistry["core.stale-source-override-decision"].validatePayload(payload)) {
        throw new Error("Core stale-source override is outside the registered decision contract");
      }
      const payloadJson = canonicalJson(payload);
      const payloadDigest = sha256(payloadJson);
      const informationScopeJson = canonicalJson({ deploymentId: metadata.databaseLineageId });
      const transaction = this.db
        .prepare(
          `INSERT INTO control_transactions (
             transaction_id, command_kind, command_schema_version, principal_kind,
             principal_id, session_id, idempotency_key, payload_digest,
             evaluation_time, recorded_at
           ) VALUES (?, 'core.issue-stale-source-override', 1, 'operator-principal', ?, NULL, ?, ?, ?, ?)`,
        )
        .run(
          transactionId,
          metadata.operatorPrincipalId,
          idempotencyKey,
          commandPayloadDigest,
          decidedAt,
          decidedAt,
        );
      const sequence = Number(transaction.lastInsertRowid);
      const common = {
        schemaVersion: 1,
        subjectKind: "control-plane-database" as const,
        subjectId: metadata.databaseLineageId,
        revisionKind: "transaction-sequence",
        revisionValue: String(input.expectedLastTransactionSequence),
        sourceKind: "operator-principal",
        sourceId: metadata.operatorPrincipalId,
        informationClass: "organization" as const,
        informationScopeJson,
        payloadJson,
        payloadDigest,
        correlationId: decisionRecordId,
        transactionSequence: sequence,
        recordedAt: decidedAt,
      };
      this.insertOccurrence({
        ...common,
        recordId: decisionRecordId,
        occurrenceType: "record",
        kind: "core.stale-source-override-decision",
        recordClass: "decision",
        transactionPosition: 0,
      });
      this.insertOccurrence({
        ...common,
        recordId: eventRecordId,
        occurrenceType: "event",
        kind: "core.stale-source-override-issued",
        causationRecordId: decisionRecordId,
        transactionPosition: 1,
      });
      const result: CoreStaleSourceOverrideResult = {
        decisionRecordId,
        eventRecordId,
        activeSnapshotId: readiness.activeSnapshotId,
        operatorPrincipalId: metadata.operatorPrincipalId,
        reason: input.reason,
        decidedAt,
        expiresAt: input.expiresAt,
        transactionPositions: [0, 1],
        transactionSequence: sequence,
      };
      this.db
        .prepare(
          `INSERT INTO idempotency_receipts (
             command_scope, command_kind, command_schema_version, idempotency_key,
             payload_digest, result_json, transaction_sequence, retained_until
           ) VALUES (?, 'core.issue-stale-source-override', 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          commandScope,
          idempotencyKey,
          commandPayloadDigest,
          canonicalJson(result as unknown as JsonValue),
          sequence,
          IDEMPOTENCY_RETAINED_UNTIL,
        );
      this.db
        .prepare(
          `UPDATE control_plane_metadata
           SET control_time_watermark = ?, last_transaction_sequence = ?
           WHERE singleton = 1`,
        )
        .run(decidedAt, sequence);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  pruneCoreCheckDetail(input: CoreCheckDetailPruneInput): CoreCheckDetailPruneResult {
    if (!Number.isSafeInteger(input.expectedLastTransactionSequence) || input.expectedLastTransactionSequence < 1) {
      throw new Error("expectedLastTransactionSequence must be a positive safe integer");
    }
    const idempotencyKey = `core-prune-check-detail:${input.expectedLastTransactionSequence}`;
    const commandPayloadJson = canonicalJson({
      expectedLastTransactionSequence: input.expectedLastTransactionSequence,
    });
    const commandPayloadDigest = sha256(commandPayloadJson);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.verifyExisting(this.applicationTables());
      const metadata = this.metadata();
      const commandScope = `database:${metadata.databaseLineageId}`;
      const prior = this.db
        .prepare(
          `SELECT payload_digest, result_json
           FROM idempotency_receipts
           WHERE command_scope = ? AND command_kind = 'core.prune-check-detail'
             AND command_schema_version = 1 AND idempotency_key = ?`,
        )
        .get(commandScope, idempotencyKey) as Row | undefined;
      if (prior) {
        if (String(prior.payload_digest) !== commandPayloadDigest) {
          throw new Error("Core check-detail prune was already run with a different payload");
        }
        const result = parseCoreCheckDetailPruneResult(parseJson(String(prior.result_json)));
        this.db.exec("COMMIT");
        return result;
      }

      const evaluatedAt = this.now();
      if (evaluatedAt < metadata.controlTimeWatermark) {
        throw new Error(
          `control-plane clock moved backwards behind ${metadata.controlTimeWatermark}; refusing a new write transaction`,
        );
      }
      if (metadata.lastTransactionSequence !== input.expectedLastTransactionSequence) {
        throw new Error(
          `stale control-plane sequence: expected ${input.expectedLastTransactionSequence}, current ${metadata.lastTransactionSequence}`,
        );
      }
      const cutoffAt = coreCheckDetailCutoff(evaluatedAt);
      const rows = this.db
        .prepare(
          `SELECT transaction_row.sequence, transaction_row.command_kind, transaction_row.recorded_at,
                  occurrence.record_id, occurrence.kind, occurrence.payload_json,
                  occurrence.payload_digest, occurrence.correlation_id,
                  occurrence.transaction_position
           FROM control_transactions transaction_row
           JOIN durable_occurrences occurrence
             ON occurrence.transaction_sequence = transaction_row.sequence
           WHERE transaction_row.command_kind IN (
             'core.record-source-check-eligible', 'core.record-candidate-rejection'
           )
           ORDER BY transaction_row.sequence DESC, occurrence.transaction_position`,
        )
        .all() as Row[];
      const histories = new Map<
        number,
        {
          sequence: number;
          commandKind: string;
          recordedAt: string;
          checkId: string;
          automatic: boolean;
          validated: boolean;
          substantive: boolean;
          occurrences: Array<{
            recordId: string;
            kind: string;
            payloadDigest: string;
            transactionPosition: number;
          }>;
        }
      >();
      for (const row of rows) {
        const sequence = Number(row.sequence);
        let history = histories.get(sequence);
        if (!history) {
          const payload = parseJson(String(row.payload_json));
          const eligible = row.command_kind === "core.record-source-check-eligible";
          if (eligible) {
            if (!recordKindRegistry["core.source-check-eligible-observation"].validatePayload(payload)) {
              throw new Error(`invalid retained eligible Core check at transaction ${sequence}`);
            }
            history = {
              sequence,
              commandKind: String(row.command_kind),
              recordedAt: String(row.recorded_at),
              checkId: payload.checkId,
              automatic: true,
              validated: true,
              substantive: true,
              occurrences: [],
            };
          } else {
            if (!recordKindRegistry["core.candidate-rejection-observation"].validatePayload(payload)) {
              throw new Error(`invalid retained Core rejection at transaction ${sequence}`);
            }
            history = {
              sequence,
              commandKind: String(row.command_kind),
              recordedAt: String(row.recorded_at),
              checkId: payload.checkId,
              automatic: payload.operation === "automatic-source-check",
              validated: payload.stage === "continuity" || payload.stage === "persistence",
              substantive: payload.stage !== "source",
              occurrences: [],
            };
          }
          histories.set(sequence, history);
        }
        history.occurrences.push({
          recordId: String(row.record_id),
          kind: String(row.kind),
          payloadDigest: String(row.payload_digest),
          transactionPosition: Number(row.transaction_position),
        });
      }
      const ordered = [...histories.values()].sort((left, right) => right.sequence - left.sequence);
      if (ordered.some((history) => history.occurrences.length !== 2)) {
        throw new Error("Core check-detail transaction does not contain exactly two occurrences");
      }
      const protectedCheckIds = new Set<string>();
      const automatic = ordered.filter((history) => history.automatic);
      if (automatic[0]) protectedCheckIds.add(automatic[0].checkId);
      const lastValidated = automatic.find((history) => history.validated);
      if (lastValidated) protectedCheckIds.add(lastValidated.checkId);
      const latestSubstantive = automatic.find((history) => history.substantive);
      if (latestSubstantive) protectedCheckIds.add(latestSubstantive.checkId);
      const decisionRows = this.db
        .prepare(
          `SELECT payload_json FROM durable_occurrences
           WHERE occurrence_type = 'record' AND kind = 'core.stale-source-override-decision'`,
        )
        .all() as Row[];
      for (const row of decisionRows) {
        const payload = parseJson(String(row.payload_json));
        if (!recordKindRegistry["core.stale-source-override-decision"].validatePayload(payload)) {
          throw new Error("invalid retained Core stale-source override decision");
        }
        protectedCheckIds.add(payload.latestCheckId);
      }

      const toDelete = selectCoreCheckDetailForPrune(ordered, protectedCheckIds, cutoffAt);
      const deletedMaterial = toDelete.map((history) => ({
        commandKind: history.commandKind,
        occurrences: history.occurrences
          .slice()
          .sort((left, right) => left.transactionPosition - right.transactionPosition)
          .map((occurrence) => ({
            kind: occurrence.kind,
            payloadDigest: occurrence.payloadDigest,
            recordId: occurrence.recordId,
            transactionPosition: occurrence.transactionPosition,
          })),
        transactionSequence: history.sequence,
      })) satisfies JsonValue[];
      const deletedDigest = sha256(canonicalJson(deletedMaterial));
      const deletedFirstSequence = toDelete[0]?.sequence ?? null;
      const deletedLastSequence = toDelete.at(-1)?.sequence ?? null;

      this.db.exec(`
        DELETE FROM projection_heads;
        DELETE FROM projection_subject_lookup;
        DELETE FROM projection_event_cursor;
        DELETE FROM projection_generations;
      `);
      const deleteReceipt = this.db.prepare("DELETE FROM idempotency_receipts WHERE transaction_sequence = ?");
      const deleteRecords = this.db.prepare(
        "DELETE FROM durable_records WHERE record_id IN (SELECT record_id FROM durable_occurrences WHERE transaction_sequence = ?)",
      );
      const deleteEvents = this.db.prepare(
        "DELETE FROM event_ledger WHERE record_id IN (SELECT record_id FROM durable_occurrences WHERE transaction_sequence = ?)",
      );
      const deleteOccurrences = this.db.prepare("DELETE FROM durable_occurrences WHERE transaction_sequence = ?");
      const deleteTransaction = this.db.prepare("DELETE FROM control_transactions WHERE sequence = ?");
      for (const history of toDelete) {
        deleteReceipt.run(history.sequence);
        deleteRecords.run(history.sequence);
        deleteEvents.run(history.sequence);
        deleteOccurrences.run(history.sequence);
        deleteTransaction.run(history.sequence);
      }
      this.faultInjector?.("after-core-check-detail-delete");

      const observationRecordId = uuidV7(new Date(evaluatedAt));
      const eventRecordId = uuidV7(new Date(evaluatedAt));
      const transactionId = uuidV7(new Date(evaluatedAt));
      const payload = {
        databaseLineageId: metadata.databaseLineageId,
        cutoffAt,
        evaluatedAt,
        maximumEligibleChecks: CORE_CHECK_DETAIL_MAXIMUM_ELIGIBLE_CHECKS,
        deletedTransactionCount: toDelete.length,
        deletedOccurrenceCount: toDelete.length * 2,
        deletedFirstSequence,
        deletedLastSequence,
        deletedDigest,
        remainingDetailedCheckCount: ordered.length - toDelete.length,
      } satisfies JsonValue;
      if (!recordKindRegistry["core.check-detail-prune-observation"].validatePayload(payload)) {
        throw new Error("Core check-detail prune result is outside the registered contract");
      }
      const payloadJson = canonicalJson(payload);
      const payloadDigest = sha256(payloadJson);
      const informationScopeJson = canonicalJson({ deploymentId: metadata.databaseLineageId });
      const transaction = this.db
        .prepare(
          `INSERT INTO control_transactions (
             transaction_id, command_kind, command_schema_version, principal_kind,
             principal_id, session_id, idempotency_key, payload_digest,
             evaluation_time, recorded_at
           ) VALUES (?, 'core.prune-check-detail', 1, 'fluent-system', 'kernel', NULL, ?, ?, ?, ?)`,
        )
        .run(transactionId, idempotencyKey, commandPayloadDigest, evaluatedAt, evaluatedAt);
      const sequence = Number(transaction.lastInsertRowid);
      const common = {
        schemaVersion: 1,
        subjectKind: "control-plane-database" as const,
        subjectId: metadata.databaseLineageId,
        revisionKind: "transaction-sequence",
        revisionValue: String(input.expectedLastTransactionSequence),
        sourceKind: "fluent-system",
        sourceId: "kernel",
        informationClass: "organization" as const,
        informationScopeJson,
        payloadJson,
        payloadDigest,
        correlationId: observationRecordId,
        transactionSequence: sequence,
        recordedAt: evaluatedAt,
      };
      this.insertOccurrence({
        ...common,
        recordId: observationRecordId,
        occurrenceType: "record",
        kind: "core.check-detail-prune-observation",
        recordClass: "observation",
        transactionPosition: 0,
      });
      this.insertOccurrence({
        ...common,
        recordId: eventRecordId,
        occurrenceType: "event",
        kind: "core.check-detail-pruned",
        causationRecordId: observationRecordId,
        transactionPosition: 1,
      });
      const result: CoreCheckDetailPruneResult = {
        observationRecordId,
        eventRecordId,
        cutoffAt,
        evaluatedAt,
        maximumEligibleChecks: CORE_CHECK_DETAIL_MAXIMUM_ELIGIBLE_CHECKS,
        deletedTransactionCount: toDelete.length,
        deletedOccurrenceCount: toDelete.length * 2,
        deletedFirstSequence,
        deletedLastSequence,
        deletedDigest,
        remainingDetailedCheckCount: ordered.length - toDelete.length,
        transactionPositions: [0, 1],
        transactionSequence: sequence,
      };
      this.db
        .prepare(
          `INSERT INTO idempotency_receipts (
             command_scope, command_kind, command_schema_version, idempotency_key,
             payload_digest, result_json, transaction_sequence, retained_until
           ) VALUES (?, 'core.prune-check-detail', 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          commandScope,
          idempotencyKey,
          commandPayloadDigest,
          canonicalJson(result as unknown as JsonValue),
          sequence,
          IDEMPOTENCY_RETAINED_UNTIL,
        );
      this.db
        .prepare(
          `UPDATE control_plane_metadata
           SET control_time_watermark = ?, last_transaction_sequence = ?
           WHERE singleton = 1`,
        )
        .run(evaluatedAt, sequence);
      const generations = (Object.keys(projectionContractRegistry) as ProjectionName[]).map((projectionName) =>
        this.buildProjectionShadow(projectionName, sequence, evaluatedAt),
      );
      this.faultInjector?.("after-projection-shadow-write");
      this.publishProjectionGenerations(generations, evaluatedAt);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordCoreCandidateRejection(input: CoreCandidateRejectionInput): CoreCandidateRejectionResult {
    const commandInput = {
      checkId: input.checkId,
      operation: input.operation,
      stage: input.stage,
      code: input.code,
      summary: input.summary,
      details: [...input.details],
      sourceUrl: input.sourceUrl,
      sourceRef: input.sourceRef,
      commitId: input.commitId ?? null,
      treeId: input.treeId ?? null,
      catalogDigest: input.catalogDigest ?? null,
      activeCommitId: input.activeCommitId ?? null,
    } satisfies JsonValue;
    const validationPayload = {
      ...commandInput,
      observedAt: "1970-01-01T00:00:00.000Z",
    } satisfies JsonValue;
    if (!recordKindRegistry["core.candidate-rejection-observation"].validatePayload(validationPayload)) {
      throw new Error("Core candidate rejection input is outside the registered diagnostic contract");
    }
    const idempotencyKey = `core-rejection:${input.checkId}`;
    const commandPayloadJson = canonicalJson(commandInput);
    const commandPayloadDigest = sha256(commandPayloadJson);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.verifyExisting(this.applicationTables());
      const metadata = this.metadata();
      const commandScope = `database:${metadata.databaseLineageId}`;
      const prior = this.db
        .prepare(
          `SELECT payload_digest, result_json
           FROM idempotency_receipts
           WHERE command_scope = ? AND command_kind = 'core.record-candidate-rejection'
             AND command_schema_version = 1 AND idempotency_key = ?`,
        )
        .get(commandScope, idempotencyKey) as Row | undefined;
      if (prior) {
        if (String(prior.payload_digest) !== commandPayloadDigest) {
          throw new Error("Core rejection check ID was already used with a different diagnostic payload");
        }
        const result = parseCoreCandidateRejectionResult(parseJson(String(prior.result_json)));
        this.db.exec("COMMIT");
        return result;
      }

      const observedAt = this.now();
      if (observedAt < metadata.controlTimeWatermark) {
        throw new Error(
          `control-plane clock moved backwards behind ${metadata.controlTimeWatermark}; refusing a new write transaction`,
        );
      }
      const payload = { ...commandInput, observedAt } satisfies JsonValue;
      if (!recordKindRegistry["core.candidate-rejection-observation"].validatePayload(payload)) {
        throw new Error("Core candidate rejection payload is outside the registered diagnostic contract");
      }
      const payloadJson = canonicalJson(payload);
      const payloadDigest = sha256(payloadJson);
      const transactionId = uuidV7(new Date(observedAt));
      const observationRecordId = uuidV7(new Date(observedAt));
      const eventRecordId = uuidV7(new Date(observedAt));
      const informationScopeJson = canonicalJson({ deploymentId: metadata.databaseLineageId });
      const transaction = this.db
        .prepare(
          `INSERT INTO control_transactions (
             transaction_id, command_kind, command_schema_version, principal_kind,
             principal_id, session_id, idempotency_key, payload_digest,
             evaluation_time, recorded_at
           ) VALUES (?, 'core.record-candidate-rejection', 1, 'fluent-system', 'kernel', NULL, ?, ?, ?, ?)`,
        )
        .run(transactionId, idempotencyKey, commandPayloadDigest, observedAt, observedAt);
      const sequence = Number(transaction.lastInsertRowid);
      const sourceRevision =
        input.commitId === undefined
          ? {}
          : { sourceRevisionKind: "git-commit-sha1", sourceRevisionValue: `sha1:${input.commitId}` };
      const common = {
        schemaVersion: 1,
        subjectKind: "control-plane-database" as const,
        subjectId: metadata.databaseLineageId,
        revisionKind: "transaction-sequence",
        revisionValue: String(metadata.lastTransactionSequence),
        sourceKind: "github-repository",
        sourceId: "github.com:1331309458",
        ...sourceRevision,
        informationClass: "organization" as const,
        informationScopeJson,
        payloadJson,
        payloadDigest,
        correlationId: input.checkId,
        transactionSequence: sequence,
        recordedAt: observedAt,
      };
      this.insertOccurrence({
        ...common,
        recordId: observationRecordId,
        occurrenceType: "record",
        kind: "core.candidate-rejection-observation",
        recordClass: "observation",
        transactionPosition: 0,
      });
      this.insertOccurrence({
        ...common,
        recordId: eventRecordId,
        occurrenceType: "event",
        kind: "core.candidate-rejected",
        transactionPosition: 1,
      });
      const result: CoreCandidateRejectionResult = {
        checkId: input.checkId,
        observationRecordId,
        eventRecordId,
        observedAt,
        transactionPositions: [0, 1],
        transactionSequence: sequence,
      };
      this.db
        .prepare(
          `INSERT INTO idempotency_receipts (
             command_scope, command_kind, command_schema_version, idempotency_key,
             payload_digest, result_json, transaction_sequence, retained_until
           ) VALUES (?, 'core.record-candidate-rejection', 1, ?, ?, ?, ?, ?)`,
        )
        .run(
          commandScope,
          idempotencyKey,
          commandPayloadDigest,
          canonicalJson(result as unknown as JsonValue),
          sequence,
          IDEMPOTENCY_RETAINED_UNTIL,
        );
      this.db
        .prepare(
          `UPDATE control_plane_metadata
           SET control_time_watermark = ?, last_transaction_sequence = ?
           WHERE singleton = 1`,
        )
        .run(observedAt, sequence);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private initialize(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.pragmaNumber("application_id") !== 0 || this.applicationTables().length !== 0) {
        throw new Error("control-plane database changed while initialization was waiting for the writer lock");
      }

      const evaluationTime = this.now();
      const lineageId = uuidV7(new Date(evaluationTime));
      const operatorPrincipalId = uuidV7(new Date(evaluationTime));
      const transactionId = uuidV7(new Date(evaluationTime));
      const definitionRecordId = uuidV7(new Date(evaluationTime));
      const principalRecordId = uuidV7(new Date(evaluationTime));
      const eventRecordId = uuidV7(new Date(evaluationTime));
      const correlationId = uuidV7(new Date(evaluationTime));
      const payload = {
        databaseLineageId: lineageId,
        operatorPrincipalId,
        registryVersion: CONTROL_PLANE_REGISTRY_VERSION,
        schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
      } satisfies JsonValue;
      const payloadJson = canonicalJson(payload);
      const payloadDigest = sha256(payloadJson);
      const informationScopeJson = canonicalJson({ deploymentId: lineageId });

      this.createSchema();
      this.db
        .prepare(
          `INSERT INTO control_plane_metadata (
             singleton, application_id, schema_version, registry_version,
             database_lineage_id, operator_principal_id, created_at,
             control_time_watermark, last_transaction_sequence
           ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(
          CONTROL_PLANE_APPLICATION_ID,
          CONTROL_PLANE_SCHEMA_VERSION,
          CONTROL_PLANE_REGISTRY_VERSION,
          lineageId,
          operatorPrincipalId,
          evaluationTime,
          evaluationTime,
        );
      this.db
        .prepare(
          `INSERT INTO core_poll_state (
             singleton, schedule_version, healthy_interval_seconds,
             next_poll_at, next_prune_at, source_unavailable_streak,
             in_flight_run_id, in_flight_started_at, in_flight_expires_at,
             last_run_id, last_started_at, last_completed_at, last_run_status,
             last_source_outcome, last_check_disposition,
             completed_run_count, suppressed_check_count
           ) VALUES (1, 1, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0)`,
        )
        .run(
          CORE_POLL_DEFAULT_INTERVAL_SECONDS,
          evaluationTime,
          addSeconds(evaluationTime, CORE_POLL_PRUNE_INTERVAL_SECONDS),
        );

      const transaction = this.db
        .prepare(
          `INSERT INTO control_transactions (
             transaction_id, command_kind, command_schema_version, principal_kind,
             principal_id, session_id, idempotency_key, payload_digest,
             evaluation_time, recorded_at
           ) VALUES (?, 'control-plane.initialize', 1, 'fluent-system', 'kernel', NULL, NULL, ?, ?, ?)`,
        )
        .run(transactionId, payloadDigest, evaluationTime, evaluationTime);
      const sequence = Number(transaction.lastInsertRowid);

      this.db
        .prepare(
          `INSERT INTO subjects (subject_kind, subject_id, created_transaction_sequence)
           VALUES ('control-plane-database', ?, ?)`,
        )
        .run(lineageId, sequence);
      this.db
        .prepare(
          `INSERT INTO subjects (subject_kind, subject_id, created_transaction_sequence)
           VALUES ('operator-principal', ?, ?)`,
        )
        .run(operatorPrincipalId, sequence);
      this.insertOccurrence({
        recordId: definitionRecordId,
        occurrenceType: "record",
        kind: "control-plane.database-definition",
        schemaVersion: 1,
        recordClass: "definition",
        subjectKind: "control-plane-database",
        subjectId: lineageId,
        revisionKind: "sha256",
        revisionValue: payloadDigest,
        sourceKind: "fluent-system",
        sourceId: "kernel",
        informationClass: "organization",
        informationScopeJson,
        payloadJson,
        payloadDigest,
        correlationId,
        transactionSequence: sequence,
        transactionPosition: 0,
        recordedAt: evaluationTime,
      });
      const principalPayloadJson = canonicalJson({ binding: "local-stdio-implicit", principalKind: "operator" });
      const principalPayloadDigest = sha256(principalPayloadJson);
      this.insertOccurrence({
        recordId: principalRecordId,
        occurrenceType: "record",
        kind: "principal.definition",
        schemaVersion: 1,
        recordClass: "definition",
        subjectKind: "operator-principal",
        subjectId: operatorPrincipalId,
        revisionKind: "sha256",
        revisionValue: principalPayloadDigest,
        sourceKind: "fluent-system",
        sourceId: "kernel",
        informationClass: "organization",
        informationScopeJson,
        payloadJson: principalPayloadJson,
        payloadDigest: principalPayloadDigest,
        correlationId,
        transactionSequence: sequence,
        transactionPosition: 1,
        recordedAt: evaluationTime,
      });
      this.insertOccurrence({
        recordId: eventRecordId,
        occurrenceType: "event",
        kind: "control-plane.initialized",
        schemaVersion: 1,
        subjectKind: "control-plane-database",
        subjectId: lineageId,
        revisionKind: "sha256",
        revisionValue: payloadDigest,
        sourceKind: "fluent-system",
        sourceId: "kernel",
        informationClass: "organization",
        informationScopeJson,
        payloadJson,
        payloadDigest,
        correlationId,
        transactionSequence: sequence,
        transactionPosition: 2,
        recordedAt: evaluationTime,
      });

      this.db
        .prepare(
          `UPDATE control_plane_metadata
           SET control_time_watermark = ?, last_transaction_sequence = ?
           WHERE singleton = 1`,
        )
        .run(evaluationTime, sequence);
      const projections = (Object.keys(projectionContractRegistry) as ProjectionName[]).map((projectionName) =>
        this.buildProjectionShadow(projectionName, sequence, evaluationTime),
      );
      this.publishProjectionGenerations(projections, evaluationTime);
      this.db.exec(`PRAGMA application_id = ${CONTROL_PLANE_APPLICATION_ID}`);
      this.db.exec(`PRAGMA user_version = ${CONTROL_PLANE_SCHEMA_VERSION}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE control_plane_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        application_id INTEGER NOT NULL,
        schema_version INTEGER NOT NULL,
        registry_version INTEGER NOT NULL,
        database_lineage_id TEXT NOT NULL UNIQUE,
        operator_principal_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        control_time_watermark TEXT NOT NULL,
        last_transaction_sequence INTEGER NOT NULL CHECK (last_transaction_sequence >= 0)
      );

      CREATE TABLE control_transactions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        transaction_id TEXT NOT NULL UNIQUE,
        command_kind TEXT NOT NULL,
        command_schema_version INTEGER NOT NULL,
        principal_kind TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        session_id TEXT,
        idempotency_key TEXT,
        payload_digest TEXT NOT NULL,
        evaluation_time TEXT NOT NULL,
        recorded_at TEXT NOT NULL
      );

      CREATE TABLE subjects (
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        created_transaction_sequence INTEGER NOT NULL REFERENCES control_transactions(sequence),
        PRIMARY KEY (subject_kind, subject_id)
      );

      CREATE TABLE durable_occurrences (
        record_id TEXT PRIMARY KEY,
        occurrence_type TEXT NOT NULL CHECK (occurrence_type IN ('record', 'event')),
        kind TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        revision_kind TEXT,
        revision_value TEXT,
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_revision_kind TEXT,
        source_revision_value TEXT,
        information_class TEXT NOT NULL CHECK (information_class IN ('public', 'organization', 'restricted')),
        information_scope_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        effective_from TEXT,
        effective_until TEXT,
        correlation_id TEXT NOT NULL,
        causation_record_id TEXT REFERENCES durable_occurrences(record_id),
        idempotency_key TEXT,
        transaction_sequence INTEGER NOT NULL REFERENCES control_transactions(sequence),
        transaction_position INTEGER NOT NULL CHECK (transaction_position >= 0),
        recorded_at TEXT NOT NULL,
        FOREIGN KEY (subject_kind, subject_id) REFERENCES subjects(subject_kind, subject_id),
        CHECK ((revision_kind IS NULL) = (revision_value IS NULL)),
        CHECK ((source_revision_kind IS NULL) = (source_revision_value IS NULL)),
        CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_from < effective_until),
        UNIQUE (transaction_sequence, transaction_position)
      );

      CREATE TABLE durable_records (
        record_id TEXT PRIMARY KEY REFERENCES durable_occurrences(record_id),
        record_class TEXT NOT NULL CHECK (
          record_class IN ('definition', 'assertion', 'observation', 'evidence-reference', 'fact', 'decision')
        )
      );

      CREATE TABLE event_ledger (
        record_id TEXT PRIMARY KEY REFERENCES durable_occurrences(record_id)
      );

      CREATE TABLE idempotency_receipts (
        command_scope TEXT NOT NULL,
        command_kind TEXT NOT NULL,
        command_schema_version INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        result_json TEXT NOT NULL,
        transaction_sequence INTEGER NOT NULL REFERENCES control_transactions(sequence),
        retained_until TEXT NOT NULL,
        PRIMARY KEY (command_scope, command_kind, command_schema_version, idempotency_key)
      );

      CREATE TABLE core_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        snapshot_kind TEXT NOT NULL CHECK (snapshot_kind = 'core-snapshot'),
        source_kind TEXT NOT NULL,
        source_id TEXT NOT NULL,
        source_url TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        source_commit_id TEXT NOT NULL,
        source_tree_id TEXT NOT NULL,
        catalog_digest TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        definition_record_id TEXT NOT NULL UNIQUE REFERENCES durable_records(record_id),
        active_fact_record_id TEXT NOT NULL UNIQUE REFERENCES durable_records(record_id),
        activation_event_record_id TEXT NOT NULL UNIQUE REFERENCES event_ledger(record_id),
        activated_transaction_sequence INTEGER NOT NULL UNIQUE REFERENCES control_transactions(sequence),
        FOREIGN KEY (snapshot_kind, snapshot_id) REFERENCES subjects(subject_kind, subject_id)
      );

      CREATE TABLE core_snapshot_files (
        snapshot_id TEXT NOT NULL REFERENCES core_snapshots(snapshot_id),
        path TEXT NOT NULL,
        mode TEXT NOT NULL,
        object_id TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
        content_digest TEXT NOT NULL,
        parsed_json TEXT,
        raw_bytes BLOB NOT NULL,
        PRIMARY KEY (snapshot_id, path)
      );

      CREATE TABLE core_active_snapshot (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        snapshot_id TEXT NOT NULL UNIQUE REFERENCES core_snapshots(snapshot_id),
        fact_record_id TEXT NOT NULL UNIQUE REFERENCES durable_records(record_id),
        activated_transaction_sequence INTEGER NOT NULL UNIQUE REFERENCES control_transactions(sequence),
        activated_at TEXT NOT NULL
      );

      CREATE TABLE core_poll_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schedule_version INTEGER NOT NULL CHECK (schedule_version = 1),
        healthy_interval_seconds INTEGER NOT NULL CHECK (healthy_interval_seconds BETWEEN 60 AND 3600),
        next_poll_at TEXT NOT NULL,
        next_prune_at TEXT NOT NULL,
        source_unavailable_streak INTEGER NOT NULL CHECK (source_unavailable_streak >= 0),
        in_flight_run_id TEXT,
        in_flight_started_at TEXT,
        in_flight_expires_at TEXT,
        last_run_id TEXT,
        last_started_at TEXT,
        last_completed_at TEXT,
        last_run_status TEXT CHECK (last_run_status IN ('completed', 'controller-error')),
        last_source_outcome TEXT CHECK (
          last_source_outcome IN (
            'eligible', 'source-unavailable', 'candidate-invalid', 'continuity-blocked', 'persistence-failed'
          )
        ),
        last_check_disposition TEXT CHECK (
          last_check_disposition IN ('recorded', 'suppressed', 'record-failed', 'none')
        ),
        completed_run_count INTEGER NOT NULL CHECK (completed_run_count >= 0),
        suppressed_check_count INTEGER NOT NULL CHECK (
          suppressed_check_count >= 0 AND suppressed_check_count <= completed_run_count
        ),
        CHECK (
          (in_flight_run_id IS NULL AND in_flight_started_at IS NULL AND in_flight_expires_at IS NULL) OR
          (in_flight_run_id IS NOT NULL AND in_flight_started_at IS NOT NULL AND in_flight_expires_at IS NOT NULL)
        ),
        CHECK (
          (last_run_id IS NULL AND last_started_at IS NULL AND last_completed_at IS NULL AND
           last_run_status IS NULL AND last_source_outcome IS NULL AND last_check_disposition IS NULL AND
           completed_run_count = 0) OR
          (last_run_id IS NOT NULL AND last_started_at IS NOT NULL AND last_completed_at IS NOT NULL AND
           last_run_status IS NOT NULL AND last_check_disposition IS NOT NULL AND completed_run_count > 0)
        )
      );

      CREATE TABLE projection_generations (
        generation_id TEXT PRIMARY KEY,
        projection_name TEXT NOT NULL,
        contract_version INTEGER NOT NULL,
        transformation_version INTEGER NOT NULL,
        information_handling_version INTEGER NOT NULL,
        source_sequence INTEGER NOT NULL REFERENCES control_transactions(sequence),
        source_digest TEXT NOT NULL,
        output_digest TEXT NOT NULL,
        evaluation_time TEXT NOT NULL,
        built_at TEXT NOT NULL,
        row_count INTEGER NOT NULL CHECK (row_count >= 0),
        invariant_result TEXT NOT NULL CHECK (invariant_result = 'ok')
      );

      CREATE TABLE projection_heads (
        projection_name TEXT PRIMARY KEY,
        contract_version INTEGER NOT NULL,
        generation_id TEXT NOT NULL UNIQUE REFERENCES projection_generations(generation_id),
        source_sequence INTEGER NOT NULL REFERENCES control_transactions(sequence),
        published_at TEXT NOT NULL
      );

      CREATE TABLE projection_subject_lookup (
        generation_id TEXT NOT NULL REFERENCES projection_generations(generation_id),
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        created_transaction_sequence INTEGER NOT NULL REFERENCES control_transactions(sequence),
        definition_record_id TEXT NOT NULL REFERENCES durable_occurrences(record_id),
        information_class TEXT NOT NULL CHECK (information_class IN ('public', 'organization', 'restricted')),
        information_scope_json TEXT NOT NULL,
        PRIMARY KEY (generation_id, subject_kind, subject_id)
      );

      CREATE TABLE projection_event_cursor (
        generation_id TEXT NOT NULL REFERENCES projection_generations(generation_id),
        record_id TEXT NOT NULL REFERENCES event_ledger(record_id),
        kind TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        subject_kind TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        information_class TEXT NOT NULL CHECK (information_class IN ('public', 'organization', 'restricted')),
        information_scope_json TEXT NOT NULL,
        transaction_sequence INTEGER NOT NULL REFERENCES control_transactions(sequence),
        transaction_position INTEGER NOT NULL CHECK (transaction_position >= 0),
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (generation_id, record_id),
        UNIQUE (generation_id, transaction_sequence, transaction_position)
      );
    `);
  }

  private insertOccurrence(input: {
    recordId: string;
    occurrenceType: "record" | "event";
    kind: string;
    schemaVersion: number;
    recordClass?: RecordClass;
    subjectKind: SubjectKind;
    subjectId: string;
    revisionKind?: string;
    revisionValue?: string;
    sourceKind: string;
    sourceId: string;
    sourceRevisionKind?: string;
    sourceRevisionValue?: string;
    informationClass: InformationClass;
    informationScopeJson: string;
    payloadJson: string;
    payloadDigest: string;
    correlationId: string;
    causationRecordId?: string;
    transactionSequence: number;
    transactionPosition: number;
    recordedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO durable_occurrences (
           record_id, occurrence_type, kind, schema_version, subject_kind, subject_id,
           revision_kind, revision_value, source_kind, source_id,
           source_revision_kind, source_revision_value,
           information_class, information_scope_json, payload_json, payload_digest,
           correlation_id, causation_record_id, transaction_sequence, transaction_position, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.recordId,
        input.occurrenceType,
        input.kind,
        input.schemaVersion,
        input.subjectKind,
        input.subjectId,
        input.revisionKind ?? null,
        input.revisionValue ?? null,
        input.sourceKind,
        input.sourceId,
        input.sourceRevisionKind ?? null,
        input.sourceRevisionValue ?? null,
        input.informationClass,
        input.informationScopeJson,
        input.payloadJson,
        input.payloadDigest,
        input.correlationId,
        input.causationRecordId ?? null,
        input.transactionSequence,
        input.transactionPosition,
        input.recordedAt,
      );
    if (input.occurrenceType === "record") {
      if (!input.recordClass) throw new Error("durable record requires a record class");
      this.db.prepare("INSERT INTO durable_records (record_id, record_class) VALUES (?, ?)").run(input.recordId, input.recordClass);
    } else {
      this.db.prepare("INSERT INTO event_ledger (record_id) VALUES (?)").run(input.recordId);
    }
  }

  private insertReceipt(
    commandScope: string,
    commandKind:
      | "repository.materialize-core-authority"
      | "repository.record-github-identity"
      | "repository.record-canonical-surfaces"
      | "repository.establish-enrollment"
      | "repository.impose-operator-hold"
      | "repository.clear-operator-hold",
    idempotencyKey: string,
    payloadDigest: string,
    result:
      | RepositoryCoreAuthorityResult
      | RepositoryGitHubReconciliationResult
      | RepositorySurfaceReconciliationResult
      | RepositoryEnrollmentResult
      | RepositoryOperatorHoldResult,
    transactionSequence: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO idempotency_receipts (
           command_scope, command_kind, command_schema_version, idempotency_key,
           payload_digest, result_json, transaction_sequence, retained_until
         ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        commandScope,
        commandKind,
        idempotencyKey,
        payloadDigest,
        canonicalJson(result as unknown as JsonValue),
        transactionSequence,
        IDEMPOTENCY_RETAINED_UNTIL,
      );
  }

  private advanceControlMetadata(evaluationTime: string, transactionSequence: number): void {
    this.db
      .prepare(
        `UPDATE control_plane_metadata
         SET control_time_watermark = ?, last_transaction_sequence = ?
         WHERE singleton = 1`,
      )
      .run(evaluationTime, transactionSequence);
  }

  private buildProjectionShadow(
    projectionName: ProjectionName,
    sourceSequence: number,
    evaluationTime: string,
  ): ProjectionGeneration {
    const contract = projectionContractRegistry[projectionName];
    const generationId = uuidV7(new Date(evaluationTime));
    let sourceMaterial: JsonValue;
    let outputMaterial: JsonValue;

    if (projectionName === "control-plane.subject-lookup") {
      const sources = this.subjectProjectionSources(sourceSequence);
      const subjectCount = Number(
        (
          this.db
            .prepare("SELECT COUNT(*) AS count FROM subjects WHERE created_transaction_sequence <= ?")
            .get(sourceSequence) as Row
        ).count,
      );
      const identities = new Set(sources.map((row) => `${String(row.subject_kind)}\u0000${String(row.subject_id)}`));
      if (sources.length !== subjectCount || identities.size !== subjectCount) {
        throw new Error("subject-lookup projection requires exactly one creation definition per subject");
      }
      sourceMaterial = sources.map(subjectProjectionSourceJson);
      const outputs = sources.map(subjectProjectionOutputJson);
      outputMaterial = outputs;
      this.insertProjectionGeneration({
        projectionName,
        generationId,
        contractVersion: contract.contractVersion,
        transformationVersion: contract.transformationVersion,
        informationHandlingVersion: contract.informationHandlingVersion,
        sourceSequence,
        sourceDigest: sha256(canonicalJson(sourceMaterial)),
        outputDigest: sha256(canonicalJson(outputMaterial)),
        evaluationTime,
        builtAt: evaluationTime,
        rowCount: outputs.length,
        invariantResult: "ok",
      });
      const insert = this.db.prepare(
        `INSERT INTO projection_subject_lookup (
           generation_id, subject_kind, subject_id, created_transaction_sequence,
           definition_record_id, information_class, information_scope_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const output of outputs) {
        const row = output as Record<string, JsonValue>;
        insert.run(
          generationId,
          String(row.subjectKind),
          String(row.subjectId),
          Number(row.createdTransactionSequence),
          String(row.definitionRecordId),
          String(row.informationClass),
          canonicalJson(row.informationScope!),
        );
      }
    } else {
      const sources = this.eventProjectionSources(sourceSequence);
      sourceMaterial = sources.map(eventProjectionSourceJson);
      const outputs = sources.map(eventProjectionOutputJson);
      outputMaterial = outputs;
      this.insertProjectionGeneration({
        projectionName,
        generationId,
        contractVersion: contract.contractVersion,
        transformationVersion: contract.transformationVersion,
        informationHandlingVersion: contract.informationHandlingVersion,
        sourceSequence,
        sourceDigest: sha256(canonicalJson(sourceMaterial)),
        outputDigest: sha256(canonicalJson(outputMaterial)),
        evaluationTime,
        builtAt: evaluationTime,
        rowCount: outputs.length,
        invariantResult: "ok",
      });
      const insert = this.db.prepare(
        `INSERT INTO projection_event_cursor (
           generation_id, record_id, kind, schema_version, subject_kind, subject_id,
           correlation_id, information_class, information_scope_json,
           transaction_sequence, transaction_position, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const output of outputs) {
        const row = output as Record<string, JsonValue>;
        insert.run(
          generationId,
          String(row.recordId),
          String(row.kind),
          Number(row.schemaVersion),
          String(row.subjectKind),
          String(row.subjectId),
          String(row.correlationId),
          String(row.informationClass),
          canonicalJson(row.informationScope!),
          Number(row.transactionSequence),
          Number(row.transactionPosition),
          String(row.recordedAt),
        );
      }
    }

    return {
      projectionName,
      generationId,
      contractVersion: contract.contractVersion,
      transformationVersion: contract.transformationVersion,
      informationHandlingVersion: contract.informationHandlingVersion,
      sourceSequence,
      sourceDigest: sha256(canonicalJson(sourceMaterial)),
      outputDigest: sha256(canonicalJson(outputMaterial)),
      evaluationTime,
      builtAt: evaluationTime,
      rowCount: Array.isArray(outputMaterial) ? outputMaterial.length : 0,
      invariantResult: "ok",
    };
  }

  private insertProjectionGeneration(generation: ProjectionGeneration): void {
    this.db
      .prepare(
        `INSERT INTO projection_generations (
           generation_id, projection_name, contract_version, transformation_version,
           information_handling_version, source_sequence, source_digest, output_digest,
           evaluation_time, built_at, row_count, invariant_result
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        generation.generationId,
        generation.projectionName,
        generation.contractVersion,
        generation.transformationVersion,
        generation.informationHandlingVersion,
        generation.sourceSequence,
        generation.sourceDigest,
        generation.outputDigest,
        generation.evaluationTime,
        generation.builtAt,
        generation.rowCount,
        generation.invariantResult,
      );
  }

  private publishProjectionGenerations(generations: ProjectionGeneration[], publishedAt: string): void {
    const publish = this.db.prepare(
      `INSERT INTO projection_heads (
         projection_name, contract_version, generation_id, source_sequence, published_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(projection_name) DO UPDATE SET
         contract_version = excluded.contract_version,
         generation_id = excluded.generation_id,
         source_sequence = excluded.source_sequence,
         published_at = excluded.published_at`,
    );
    for (const generation of generations) {
      publish.run(
        generation.projectionName,
        generation.contractVersion,
        generation.generationId,
        generation.sourceSequence,
        publishedAt,
      );
    }
  }

  private activeProjectionGeneration(projectionName: ProjectionName): ProjectionGeneration {
    const row = this.db
      .prepare(
        `SELECT generation.*, head.contract_version AS head_contract_version,
                head.source_sequence AS head_source_sequence, head.published_at AS head_published_at
         FROM projection_heads head
         JOIN projection_generations generation ON generation.generation_id = head.generation_id
         WHERE head.projection_name = ?`,
      )
      .get(projectionName) as Row | undefined;
    if (!row) throw new Error(`projection ${projectionName} has no active generation`);
    const generation = decodeProjectionGeneration(row);
    if (generation.projectionName !== projectionName) {
      throw new Error(`projection ${projectionName} head points to another contract`);
    }
    if (
      Number(row.head_contract_version) !== generation.contractVersion ||
      Number(row.head_source_sequence) !== generation.sourceSequence
    ) {
      throw new Error(`projection ${projectionName} head lineage does not match its generation`);
    }
    assertUtcInstant(String(row.head_published_at), `projection ${projectionName} publication time`);
    return generation;
  }

  private verifyProjectionGeneration(generation: ProjectionGeneration): void {
    const contract = projectionContractRegistry[generation.projectionName];
    if (
      generation.contractVersion !== contract.contractVersion ||
      generation.transformationVersion !== contract.transformationVersion ||
      generation.informationHandlingVersion !== contract.informationHandlingVersion
    ) {
      throw new Error(`projection ${generation.projectionName} has an unknown contract version`);
    }
    if (generation.invariantResult !== "ok") {
      throw new Error(`projection ${generation.projectionName} did not pass its invariants`);
    }
    let sourceMaterial: JsonValue;
    let outputMaterial: JsonValue;
    let wrongTableCount: number;
    if (generation.projectionName === "control-plane.subject-lookup") {
      sourceMaterial = this.subjectProjectionSources(generation.sourceSequence).map(subjectProjectionSourceJson);
      outputMaterial = (
        this.db
          .prepare(
            `SELECT subject_kind, subject_id, created_transaction_sequence, definition_record_id,
                    information_class, information_scope_json
             FROM projection_subject_lookup WHERE generation_id = ?
             ORDER BY subject_kind, subject_id`,
          )
          .all(generation.generationId) as Row[]
      ).map(subjectProjectionStoredOutputJson);
      wrongTableCount = Number(
        (
          this.db
            .prepare("SELECT COUNT(*) AS count FROM projection_event_cursor WHERE generation_id = ?")
            .get(generation.generationId) as Row
        ).count,
      );
    } else {
      sourceMaterial = this.eventProjectionSources(generation.sourceSequence).map(eventProjectionSourceJson);
      outputMaterial = (
        this.db
          .prepare(
            `SELECT record_id, kind, schema_version, subject_kind, subject_id, correlation_id,
                    information_class, information_scope_json, transaction_sequence,
                    transaction_position, recorded_at
             FROM projection_event_cursor WHERE generation_id = ?
             ORDER BY transaction_sequence, transaction_position`,
          )
          .all(generation.generationId) as Row[]
      ).map(eventProjectionStoredOutputJson);
      wrongTableCount = Number(
        (
          this.db
            .prepare("SELECT COUNT(*) AS count FROM projection_subject_lookup WHERE generation_id = ?")
            .get(generation.generationId) as Row
        ).count,
      );
    }
    if (wrongTableCount !== 0) throw new Error(`projection ${generation.projectionName} contains rows for another contract`);
    if (!Array.isArray(outputMaterial) || outputMaterial.length !== generation.rowCount) {
      throw new Error(`projection ${generation.projectionName} row-count mismatch`);
    }
    if (sha256(canonicalJson(sourceMaterial)) !== generation.sourceDigest) {
      throw new Error(`projection ${generation.projectionName} source digest mismatch`);
    }
    if (sha256(canonicalJson(outputMaterial)) !== generation.outputDigest) {
      throw new Error(`projection ${generation.projectionName} output digest mismatch`);
    }
  }

  private subjectProjectionSources(sourceSequence: number): Row[] {
    return this.db
      .prepare(
        `SELECT subject.subject_kind, subject.subject_id, subject.created_transaction_sequence,
                occurrence.record_id AS definition_record_id, occurrence.kind AS definition_kind,
                occurrence.schema_version AS definition_schema_version,
                occurrence.payload_digest AS definition_payload_digest,
                occurrence.information_class, occurrence.information_scope_json
         FROM subjects subject
         JOIN durable_occurrences occurrence
           ON occurrence.subject_kind = subject.subject_kind
          AND occurrence.subject_id = subject.subject_id
          AND occurrence.transaction_sequence = subject.created_transaction_sequence
         JOIN durable_records record
           ON record.record_id = occurrence.record_id AND record.record_class = 'definition'
         WHERE subject.created_transaction_sequence <= ?
         ORDER BY subject.subject_kind, subject.subject_id, occurrence.transaction_position`,
      )
      .all(sourceSequence) as Row[];
  }

  private eventProjectionSources(sourceSequence: number): Row[] {
    return this.db
      .prepare(
        `SELECT occurrence.record_id, occurrence.kind, occurrence.schema_version,
                occurrence.subject_kind, occurrence.subject_id, occurrence.correlation_id,
                occurrence.information_class, occurrence.information_scope_json,
                occurrence.payload_digest, occurrence.transaction_sequence,
                occurrence.transaction_position, occurrence.recorded_at
         FROM event_ledger event
         JOIN durable_occurrences occurrence ON occurrence.record_id = event.record_id
         WHERE occurrence.transaction_sequence <= ?
         ORDER BY occurrence.transaction_sequence, occurrence.transaction_position`,
      )
      .all(sourceSequence) as Row[];
  }

  private assertProjectionAccess(access: ProjectionAccess): void {
    assertInformationClass(access.maximumInformationClass);
    if (!Array.isArray(access.deploymentIds) || access.deploymentIds.some((id) => !isUuidV7(id))) {
      throw new Error("projection access deploymentIds must contain only UUIDv7 identities");
    }
  }

  private canAccessProjectionRow(
    access: ProjectionAccess,
    informationClassValue: string,
    informationScopeJson: string,
  ): boolean {
    assertInformationClass(informationClassValue);
    if (!informationClassAtLeast(access.maximumInformationClass, informationClassValue)) return false;
    const scope = parseJson(informationScopeJson);
    if (!isExactDeploymentScope(scope)) return false;
    return access.deploymentIds.includes(scope.deploymentId);
  }

  private verifyExisting(tables: string[], verifyProjectionCatalog = true): void {
    const schemaVersion = this.pragmaNumber("user_version");
    if (schemaVersion > CONTROL_PLANE_SCHEMA_VERSION) {
      throw new Error(
        `control-plane schema version ${schemaVersion} is newer than supported version ${CONTROL_PLANE_SCHEMA_VERSION}`,
      );
    }
    if (schemaVersion < CONTROL_PLANE_SCHEMA_VERSION) {
      throw new Error(
        `control-plane schema version ${schemaVersion} is older than supported version ${CONTROL_PLANE_SCHEMA_VERSION}; ` +
          "this kernel slice does not define an upgrade",
      );
    }
    const unexpected = tables.filter((table) => !TARGET_TABLES.includes(table as (typeof TARGET_TABLES)[number]));
    const missing = TARGET_TABLES.filter((table) => !tables.includes(table));
    if (unexpected.length > 0 || missing.length > 0) {
      throw new Error(`control-plane schema table mismatch (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`);
    }
    const unexpectedObjects = this.db
      .prepare(
        `SELECT type, name FROM sqlite_master
         WHERE type IN ('index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all() as Row[];
    if (unexpectedObjects.length > 0) {
      throw new Error(
        `control-plane schema has unexpected objects: ${unexpectedObjects
          .map((row) => `${String(row.type)}:${String(row.name)}`)
          .join(", ")}`,
      );
    }

    const metadata = this.metadata();
    if (metadata.applicationId !== CONTROL_PLANE_APPLICATION_ID) throw new Error("control-plane metadata application ID mismatch");
    if (metadata.schemaVersion !== CONTROL_PLANE_SCHEMA_VERSION) throw new Error("control-plane metadata schema version mismatch");
    if (metadata.registryVersion !== CONTROL_PLANE_REGISTRY_VERSION) throw new Error("control-plane registry version mismatch");
    if (!isUuidV7(metadata.databaseLineageId)) throw new Error("control-plane database lineage ID is not UUIDv7");
    if (!isUuidV7(metadata.operatorPrincipalId)) throw new Error("control-plane operator principal ID is not UUIDv7");
    assertUtcInstant(metadata.createdAt, "database creation time");
    assertUtcInstant(metadata.controlTimeWatermark, "control-time watermark");
    this.corePollState();

    const transactionRow = this.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS maximum FROM control_transactions").get() as Row;
    const maximum = Number(transactionRow.maximum);
    const sqliteSequenceRow = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'control_transactions'").get() as
      | Row
      | undefined;
    const allocated = Number(sqliteSequenceRow?.seq ?? 0);
    if (metadata.lastTransactionSequence !== maximum || allocated !== maximum) {
      throw new Error(
        `control-plane transaction watermark mismatch (metadata ${metadata.lastTransactionSequence}, maximum ${maximum}, allocated ${allocated})`,
      );
    }
    if (metadata.controlTimeWatermark < metadata.createdAt) throw new Error("control-time watermark predates database creation");
    this.verifyTransactions();
    this.verifyRegistryReferences();
    this.verifyCoreSnapshots();
    this.verifyIdempotencyReceipts();
    if (verifyProjectionCatalog) this.verifyProjectionCatalog();
  }

  private verifyTransactions(): void {
    const rows = this.db.prepare("SELECT * FROM control_transactions ORDER BY sequence").all() as Row[];
    for (const row of rows) {
      if (!isUuidV7(String(row.transaction_id))) throw new Error(`transaction ID is not UUIDv7: ${String(row.sequence)}`);
      const contract = commandKindRegistry[String(row.command_kind) as keyof typeof commandKindRegistry];
      if (!contract) throw new Error(`unknown command kind: ${String(row.command_kind)}`);
      if (Number(row.command_schema_version) !== contract.schemaVersion) {
        throw new Error(`unknown command schema version: ${String(row.command_kind)}`);
      }
      assertSource(String(row.principal_kind), String(row.principal_id));
      if (!/^sha256:[0-9a-f]{64}$/.test(String(row.payload_digest))) {
        throw new Error(`invalid transaction payload digest: ${String(row.sequence)}`);
      }
      assertUtcInstant(String(row.evaluation_time), `transaction ${String(row.sequence)} evaluation time`);
      assertUtcInstant(String(row.recorded_at), `transaction ${String(row.sequence)} recorded time`);
      if (String(row.evaluation_time) !== String(row.recorded_at)) {
        throw new Error(`transaction evaluation and recorded times differ: ${String(row.sequence)}`);
      }

      const outputs = this.db
        .prepare(
          `SELECT kind, transaction_position, recorded_at, payload_digest
           FROM durable_occurrences
           WHERE transaction_sequence = ?
           ORDER BY transaction_position`,
        )
        .all(row.sequence!) as Row[];
      const actualKinds = outputs.map((output) => String(output.kind));
      if (
        actualKinds.length !== contract.outputKinds.length ||
        actualKinds.some((kind, index) => kind !== contract.outputKinds[index])
      ) {
        throw new Error(
          `command output contract mismatch for transaction ${String(row.sequence)} ` +
            `(expected ${contract.outputKinds.join(", ")}; found ${actualKinds.join(", ")})`,
        );
      }
      for (const [index, output] of outputs.entries()) {
        if (Number(output.transaction_position) !== index) {
          throw new Error(`command output position mismatch for transaction ${String(row.sequence)}`);
        }
        if (String(output.recorded_at) !== String(row.recorded_at)) {
          throw new Error(`command output recorded time mismatch for transaction ${String(row.sequence)}`);
        }
      }

      const receiptCount = Number(
        (
          this.db
            .prepare("SELECT COUNT(*) AS count FROM idempotency_receipts WHERE transaction_sequence = ?")
            .get(row.sequence!) as Row
        ).count,
      );
      if (row.command_kind === "control-plane.initialize") {
        if (Number(row.sequence) !== 1 || row.idempotency_key != null || receiptCount !== 0) {
          throw new Error("control-plane initialization transaction shape is invalid");
        }
        if (outputs.length === 0) throw new Error("control-plane initialization outputs are missing");
        const firstOutput = this.db
          .prepare("SELECT payload_digest FROM durable_occurrences WHERE transaction_sequence = ? AND transaction_position = 0")
          .get(row.sequence!) as Row;
        if (String(row.payload_digest) !== String(firstOutput.payload_digest)) {
          throw new Error("control-plane initialization command digest does not match its definition");
        }
      } else if (row.command_kind === "control-plane.check-integrity") {
        if (
          typeof row.idempotency_key !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.idempotency_key) ||
          receiptCount !== 1
        ) {
          throw new Error(`integrity transaction receipt shape is invalid: ${String(row.sequence)}`);
        }
      } else if (row.command_kind === "core.activate-snapshot") {
        if (
          typeof row.idempotency_key !== "string" ||
          !/^core-activate:[1-9][0-9]*:[0-9a-f]{40}$/.test(row.idempotency_key) ||
          row.principal_kind !== "fluent-system" ||
          row.principal_id !== "kernel" ||
          receiptCount !== 1
        ) {
          throw new Error(`Core snapshot activation receipt shape is invalid: ${String(row.sequence)}`);
        }
      } else if (row.command_kind === "core.rollback-snapshot") {
        if (
          typeof row.idempotency_key !== "string" ||
          !/^core-rollback:[1-9][0-9]*:[0-9a-f]{40}$/.test(row.idempotency_key) ||
          row.principal_kind !== "operator-principal" ||
          row.principal_id !== this.metadata().operatorPrincipalId ||
          receiptCount !== 1
        ) {
          throw new Error(`Core snapshot rollback receipt shape is invalid: ${String(row.sequence)}`);
        }
      } else if (row.command_kind === "core.record-candidate-rejection") {
        if (
          typeof row.idempotency_key !== "string" ||
          !/^core-rejection:[0-9a-f-]{36}$/.test(row.idempotency_key) ||
          receiptCount !== 1
        ) {
          throw new Error(`Core candidate rejection receipt shape is invalid: ${String(row.sequence)}`);
        }
        if (outputs[0]!.payload_digest !== outputs[1]!.payload_digest) {
          throw new Error(`Core candidate rejection outputs disagree: ${String(row.sequence)}`);
        }
      } else if (row.command_kind === "core.record-source-check-eligible") {
        if (
          typeof row.idempotency_key !== "string" ||
          !/^core-source-check:[0-9a-f-]{36}$/.test(row.idempotency_key) ||
          row.principal_kind !== "fluent-system" ||
          row.principal_id !== "kernel" ||
          receiptCount !== 1
        ) {
          throw new Error(`eligible Core source check receipt shape is invalid: ${String(row.sequence)}`);
        }
        if (outputs[0]!.payload_digest !== outputs[1]!.payload_digest) {
          throw new Error(`eligible Core source check outputs disagree: ${String(row.sequence)}`);
        }
      } else if (row.command_kind === "core.issue-stale-source-override") {
        if (
          typeof row.idempotency_key !== "string" ||
          !/^core-stale-source-override:[1-9][0-9]*:[1-9][0-9]*$/.test(row.idempotency_key) ||
          row.principal_kind !== "operator-principal" ||
          row.principal_id !== this.metadata().operatorPrincipalId ||
          receiptCount !== 1
        ) {
          throw new Error(`Core stale-source override receipt shape is invalid: ${String(row.sequence)}`);
        }
        if (outputs[0]!.payload_digest !== outputs[1]!.payload_digest) {
          throw new Error(`Core stale-source override outputs disagree: ${String(row.sequence)}`);
        }
      } else if (row.command_kind === "core.prune-check-detail") {
        if (
          typeof row.idempotency_key !== "string" ||
          !/^core-prune-check-detail:[1-9][0-9]*$/.test(row.idempotency_key) ||
          row.principal_kind !== "fluent-system" ||
          row.principal_id !== "kernel" ||
          receiptCount !== 1
        ) {
          throw new Error(`Core check-detail prune receipt shape is invalid: ${String(row.sequence)}`);
        }
        if (outputs[0]!.payload_digest !== outputs[1]!.payload_digest) {
          throw new Error(`Core check-detail prune outputs disagree: ${String(row.sequence)}`);
        }
      } else if (row.command_kind === "repository.materialize-core-authority") {
        if (
          typeof row.idempotency_key !== "string" ||
          !/^repo-core:[0-9a-f-]{36}:[1-9][0-9]{0,19}$/.test(row.idempotency_key) ||
          row.principal_kind !== "fluent-system" ||
          row.principal_id !== "kernel" ||
          receiptCount !== 1 ||
          !outputs.every((output) => output.payload_digest === outputs[0]!.payload_digest)
        ) {
          throw new Error(`repository Core authority transaction shape is invalid: ${String(row.sequence)}`);
        }
      } else if (row.command_kind === "repository.record-github-identity") {
        if (
          typeof row.idempotency_key !== "string" ||
          !/^repo-gh:[0-9a-f-]{36}:(?:initial|[0-9a-f-]{36}):[0-9a-f]{64}$/.test(row.idempotency_key) ||
          row.principal_kind !== "fluent-system" ||
          row.principal_id !== "kernel" ||
          receiptCount !== 1 ||
          !outputs.every((output) => output.payload_digest === outputs[0]!.payload_digest)
        ) {
          throw new Error(`repository GitHub reconciliation transaction shape is invalid: ${String(row.sequence)}`);
        }
      } else if (row.command_kind === "repository.record-canonical-surfaces") {
        if (
          typeof row.idempotency_key !== "string" ||
          !/^repo-surfaces:[0-9a-f-]{36}:(?:initial|[0-9a-f-]{36}):[0-9a-f]{64}$/.test(row.idempotency_key) ||
          row.principal_kind !== "fluent-system" ||
          row.principal_id !== "kernel" ||
          receiptCount !== 1 ||
          !outputs.every((output) => output.payload_digest === outputs[0]!.payload_digest)
        ) {
          throw new Error(`repository surface reconciliation transaction shape is invalid: ${String(row.sequence)}`);
        }
      } else if (row.command_kind === "repository.establish-enrollment") {
        if (
          typeof row.idempotency_key !== "string" ||
          !/^repo-enroll:[0-9a-f-]{36}$/.test(row.idempotency_key) ||
          row.principal_kind !== "fluent-system" ||
          row.principal_id !== "kernel" ||
          receiptCount !== 1 ||
          !outputs.every((output) => output.payload_digest === outputs[0]!.payload_digest)
        ) {
          throw new Error(`repository enrollment transaction shape is invalid: ${String(row.sequence)}`);
        }
      } else if (
        row.command_kind === "repository.impose-operator-hold" ||
        row.command_kind === "repository.clear-operator-hold"
      ) {
        const validKey = row.command_kind === "repository.impose-operator-hold"
          ? /^repo-hold-impose:[1-9][0-9]*:[1-9][0-9]{0,19}$/.test(String(row.idempotency_key))
          : /^repo-hold-clear:[1-9][0-9]*:[0-9a-f-]{36}$/.test(String(row.idempotency_key));
        if (
          !validKey ||
          row.principal_kind !== "operator-principal" ||
          row.principal_id !== this.metadata().operatorPrincipalId ||
          receiptCount !== 1 ||
          !outputs.every((output) => output.payload_digest === outputs[0]!.payload_digest)
        ) {
          throw new Error(`repository operator hold transaction shape is invalid: ${String(row.sequence)}`);
        }
      }
    }

    const metadata = this.metadata();
    const last = rows.at(-1);
    if (!last || Number(last.sequence) !== metadata.lastTransactionSequence) {
      throw new Error("last transaction does not match the metadata watermark");
    }
    if (String(last.recorded_at) !== metadata.controlTimeWatermark) {
      throw new Error("last transaction time does not match the control-time watermark");
    }
  }

  private verifyRegistryReferences(): void {
    const subjects = this.db.prepare("SELECT subject_kind, subject_id FROM subjects").all() as Row[];
    for (const subject of subjects) assertSubject(String(subject.subject_kind), String(subject.subject_id));

    const rows = this.db
      .prepare(
        `SELECT occurrence.*, record.record_class
         FROM durable_occurrences occurrence
         LEFT JOIN durable_records record ON record.record_id = occurrence.record_id
         ORDER BY occurrence.transaction_sequence, occurrence.transaction_position`,
      )
      .all() as Row[];
    for (const row of rows) {
      if (!isUuidV7(String(row.record_id))) throw new Error(`record ID is not UUIDv7: ${String(row.record_id)}`);
      if (!isUuidV7(String(row.correlation_id))) throw new Error(`correlation ID is not UUIDv7: ${String(row.record_id)}`);
      const subjectKind = String(row.subject_kind);
      assertSubject(subjectKind, String(row.subject_id));
      if (row.revision_kind != null && row.revision_value != null) {
        assertRevision(String(row.revision_kind), String(row.revision_value), subjectKind);
      }
      assertSource(
        String(row.source_kind),
        String(row.source_id),
        row.source_revision_kind == null ? undefined : String(row.source_revision_kind),
      );
      if (row.source_revision_kind != null && row.source_revision_value != null) {
        assertSourceRevision(String(row.source_revision_kind), String(row.source_revision_value));
      }
      const informationClass = String(row.information_class);
      assertInformationClass(informationClass);
      const informationScopeJson = String(row.information_scope_json);
      const informationScope = parseJson(informationScopeJson);
      if (canonicalJson(informationScope) !== informationScopeJson) {
        throw new Error(`information scope is not canonical JSON: ${String(row.record_id)}`);
      }
      const payloadJson = String(row.payload_json);
      const payload = parseJson(payloadJson);
      if (canonicalJson(payload) !== payloadJson) throw new Error(`payload is not canonical JSON: ${String(row.record_id)}`);
      if (sha256(payloadJson) !== String(row.payload_digest)) throw new Error(`payload digest mismatch: ${String(row.record_id)}`);
      assertUtcInstant(String(row.recorded_at), `record ${String(row.record_id)} recorded time`);

      if (row.occurrence_type === "record") {
        const contract = recordKindRegistry[String(row.kind) as keyof typeof recordKindRegistry];
        if (!contract) throw new Error(`unknown record kind: ${String(row.kind)}`);
        if (Number(row.schema_version) !== contract.schemaVersion) throw new Error(`unknown record schema version: ${String(row.kind)}`);
        if (String(row.record_class) !== contract.recordClass) throw new Error(`record class mismatch: ${String(row.kind)}`);
        if (!contract.subjectKinds.includes(subjectKind as never)) throw new Error(`record subject kind mismatch: ${String(row.kind)}`);
        if (!informationClassAtLeast(informationClass, contract.minimumInformationClass)) {
          throw new Error(`record information class is below its contract minimum: ${String(row.kind)}`);
        }
        if (!contract.validatePayload(payload)) throw new Error(`invalid record payload: ${String(row.kind)}`);
      } else if (row.occurrence_type === "event") {
        if (row.record_class != null) throw new Error(`event is incorrectly classified as a durable record: ${String(row.record_id)}`);
        const contract = eventKindRegistry[String(row.kind) as keyof typeof eventKindRegistry];
        if (!contract) throw new Error(`unknown event kind: ${String(row.kind)}`);
        if (Number(row.schema_version) !== contract.schemaVersion) throw new Error(`unknown event schema version: ${String(row.kind)}`);
        if (!contract.subjectKinds.includes(subjectKind as never)) throw new Error(`event subject kind mismatch: ${String(row.kind)}`);
        if (!informationClassAtLeast(informationClass, contract.minimumInformationClass)) {
          throw new Error(`event information class is below its contract minimum: ${String(row.kind)}`);
        }
        if (!contract.validatePayload(payload)) throw new Error(`invalid event payload: ${String(row.kind)}`);
      } else {
        throw new Error(`unknown occurrence type: ${String(row.occurrence_type)}`);
      }
      if (
        (String(row.kind) === "control-plane.database-definition" || String(row.kind) === "control-plane.initialized") &&
        ((payload as { databaseLineageId: string; operatorPrincipalId: string }).databaseLineageId !==
          String(row.subject_id) ||
          (payload as { operatorPrincipalId: string }).operatorPrincipalId !== this.metadata().operatorPrincipalId)
      ) {
        throw new Error(`database payload lineage does not match its subject: ${String(row.record_id)}`);
      }
      if (
        String(row.kind) === "principal.definition" &&
        (String(row.subject_id) !== this.metadata().operatorPrincipalId || subjectKind !== "operator-principal")
      ) {
        throw new Error(`principal definition does not match the deployment operator: ${String(row.record_id)}`);
      }
      if (
        (String(row.kind) === "core.candidate-rejection-observation" ||
          String(row.kind) === "core.candidate-rejected") &&
        (String(row.subject_id) !== this.metadata().databaseLineageId ||
          String(row.source_kind) !== "github-repository" ||
          String(row.source_id) !== "github.com:1331309458" ||
          String((payload as CoreCandidateRejectionPayload).checkId) !== String(row.correlation_id) ||
          String((payload as CoreCandidateRejectionPayload).observedAt) !== String(row.recorded_at) ||
          ((payload as CoreCandidateRejectionPayload).commitId === null) !== (row.source_revision_value == null) ||
          ((payload as CoreCandidateRejectionPayload).commitId !== null &&
            (String(row.source_revision_kind) !== "git-commit-sha1" ||
              String(row.source_revision_value) !==
                `sha1:${String((payload as CoreCandidateRejectionPayload).commitId)}`)))
      ) {
        throw new Error(`Core candidate rejection lineage mismatch: ${String(row.record_id)}`);
      }
      if (
        (String(row.kind) === "core.source-check-eligible-observation" ||
          String(row.kind) === "core.source-check-eligible")
      ) {
        const check = payload as CoreSourceCheckEligiblePayload;
        if (
          String(row.subject_id) !== this.metadata().databaseLineageId ||
          String(row.source_kind) !== "github-repository" ||
          String(row.source_id) !== "github.com:1331309458" ||
          String(row.source_revision_kind) !== "git-commit-sha1" ||
          String(row.source_revision_value) !== `sha1:${check.commitId}` ||
          String(row.correlation_id) !== check.checkId ||
          String(row.recorded_at) !== check.checkedAt
        ) {
          throw new Error(`eligible Core source check lineage mismatch: ${String(row.record_id)}`);
        }
      }
      if (
        String(row.kind) === "core.stale-source-override-decision" ||
        String(row.kind) === "core.stale-source-override-issued"
      ) {
        const decision = payload as CoreStaleSourceOverrideDecisionPayload;
        const expectedEvent = String(row.kind) === "core.stale-source-override-issued";
        const snapshot = this.db
          .prepare(
            `SELECT snapshot_id, source_commit_id, activated_transaction_sequence
             FROM core_snapshots WHERE activated_transaction_sequence <= ?
             ORDER BY activated_transaction_sequence DESC LIMIT 1`,
          )
          .get(decision.expectedLastTransactionSequence) as Row | undefined;
        const sourceRows = this.db
          .prepare(
            `SELECT kind, correlation_id, payload_json, transaction_sequence
             FROM durable_occurrences
             WHERE occurrence_type = 'record'
               AND kind IN ('core.source-check-eligible-observation', 'core.candidate-rejection-observation')
               AND transaction_sequence <= ?
             ORDER BY transaction_sequence DESC`,
          )
          .all(decision.expectedLastTransactionSequence) as Row[];
        let latestAutomaticCheckId: string | undefined;
        let lastValidatedAt: string | undefined;
        let substantiveHardFailure = false;
        let foundSubstantive = false;
        for (const sourceRow of sourceRows) {
          const sourcePayload = parseJson(String(sourceRow.payload_json));
          if (sourceRow.kind === "core.source-check-eligible-observation") {
            if (!recordKindRegistry["core.source-check-eligible-observation"].validatePayload(sourcePayload)) {
              throw new Error("Core stale-source override references an invalid eligible check");
            }
            latestAutomaticCheckId ??= sourcePayload.checkId;
            lastValidatedAt ??= sourcePayload.checkedAt;
            if (!foundSubstantive) {
              substantiveHardFailure = sourcePayload.commitId !== String(snapshot?.source_commit_id);
              foundSubstantive = true;
            }
          } else {
            if (!recordKindRegistry["core.candidate-rejection-observation"].validatePayload(sourcePayload)) {
              throw new Error("Core stale-source override references an invalid rejection");
            }
            if (sourcePayload.operation !== "automatic-source-check") continue;
            latestAutomaticCheckId ??= sourcePayload.checkId;
            if (sourcePayload.stage === "continuity" || sourcePayload.stage === "persistence") {
              lastValidatedAt ??= sourcePayload.observedAt;
            }
            if (!foundSubstantive && sourcePayload.stage !== "source") {
              substantiveHardFailure =
                sourcePayload.stage === "validation" ||
                sourcePayload.stage === "persistence" ||
                (sourcePayload.stage === "continuity" &&
                  !(
                    sourcePayload.commitId === String(snapshot?.source_commit_id) &&
                    Number(snapshot?.activated_transaction_sequence) > Number(sourceRow.transaction_sequence)
                  ));
              foundSubstantive = true;
            }
          }
        }
        if (
          String(row.subject_id) !== this.metadata().databaseLineageId ||
          String(row.source_kind) !== "operator-principal" ||
          String(row.source_id) !== this.metadata().operatorPrincipalId ||
          row.source_revision_kind != null ||
          row.source_revision_value != null ||
          String(row.correlation_id) !== decision.decisionId ||
          String(row.recorded_at) !== decision.decidedAt ||
          String(row.revision_kind) !== "transaction-sequence" ||
          Number(row.revision_value) !== decision.expectedLastTransactionSequence ||
          decision.databaseLineageId !== this.metadata().databaseLineageId ||
          decision.operatorPrincipalId !== this.metadata().operatorPrincipalId ||
          Number(row.transaction_sequence) !== decision.expectedLastTransactionSequence + 1 ||
          (expectedEvent
            ? String(row.causation_record_id) !== decision.decisionId
            : row.causation_record_id != null || String(row.record_id) !== decision.decisionId) ||
          !snapshot ||
          String(snapshot.snapshot_id) !== decision.activeSnapshotId ||
          latestAutomaticCheckId !== decision.latestCheckId ||
          lastValidatedAt !== decision.lastValidatedAt ||
          substantiveHardFailure
        ) {
          throw new Error(`Core stale-source override lineage mismatch: ${String(row.record_id)}`);
        }
      }
      if (String(row.kind) === "core.rollback-decision") {
        const decision = payload as CoreRollbackDecisionPayload;
        if (
          String(row.subject_id) !== this.metadata().databaseLineageId ||
          String(row.source_kind) !== "operator-principal" ||
          String(row.source_id) !== this.metadata().operatorPrincipalId ||
          row.source_revision_kind != null ||
          row.source_revision_value != null ||
          String(row.record_id) !== decision.decisionId ||
          String(row.correlation_id) !== decision.decisionId ||
          row.causation_record_id != null ||
          decision.databaseLineageId !== this.metadata().databaseLineageId ||
          decision.operatorPrincipalId !== this.metadata().operatorPrincipalId ||
          String(row.recorded_at) !== decision.decidedAt ||
          String(row.revision_kind) !== "transaction-sequence" ||
          Number(row.revision_value) !== decision.expectedLastTransactionSequence
        ) {
          throw new Error(`Core rollback decision lineage mismatch: ${String(row.record_id)}`);
        }
      }
      if (String(row.kind) === "core.snapshot-rollback-activated") {
        const rollback = payload as CoreRollbackActivatedPayload;
        if (
          String(row.subject_id) !== rollback.snapshotId ||
          String(row.correlation_id) !== rollback.decisionRecordId ||
          String(row.causation_record_id) !== rollback.decisionRecordId ||
          rollback.databaseLineageId !== this.metadata().databaseLineageId ||
          rollback.operatorPrincipalId !== this.metadata().operatorPrincipalId ||
          String(row.recorded_at) !== rollback.activatedAt
        ) {
          throw new Error(`Core rollback activation lineage mismatch: ${String(row.record_id)}`);
        }
      }
      if (
        String(row.kind) === "repository.declaration-definition" ||
        String(row.kind) === "repository.core-authorized" ||
        String(row.kind) === "repository.core-authority-reconciled"
      ) {
        const authority = payload as RepositoryCoreAuthorityPayload;
        const snapshot = this.db
          .prepare("SELECT source_commit_id FROM core_snapshots WHERE snapshot_id = ?")
          .get(authority.coreSnapshotId) as Row | undefined;
        const declaration = this.db
          .prepare(
            `SELECT content_digest, parsed_json FROM core_snapshot_files
             WHERE snapshot_id = ? AND path = ?`,
          )
          .get(authority.coreSnapshotId, authority.declarationPath) as Row | undefined;
        const expectedRecordId =
          String(row.kind) === "repository.declaration-definition"
            ? authority.declarationRecordId
            : String(row.kind) === "repository.core-authorized"
              ? authority.coreAuthorizationRecordId
              : authority.eventRecordId;
        const parsedDeclaration = declaration?.parsed_json
          ? (parseJson(String(declaration.parsed_json)) as unknown as RepositoryDeclaration)
          : undefined;
        if (
          String(row.subject_kind) !== "github-repository" ||
          String(row.subject_id) !== authority.repositoryId ||
          (expectedRecordId !== null && String(row.record_id) !== expectedRecordId) ||
          String(row.revision_kind) !== "core-declaration-sha256" ||
          String(row.revision_value) !== authority.declarationDigest ||
          String(row.source_kind) !== "github-repository" ||
          String(row.source_id) !== "github.com:1331309458" ||
          String(row.source_revision_kind) !== "git-commit-sha1" ||
          String(row.source_revision_value) !== `sha1:${authority.sourceCommitId}` ||
          row.causation_record_id != null ||
          String(row.recorded_at) !== authority.authorizedAt ||
          !snapshot ||
          String(snapshot.source_commit_id) !== authority.sourceCommitId ||
          !declaration ||
          String(declaration.content_digest) !== authority.declarationDigest ||
          !parsedDeclaration ||
          `github.com:${parsedDeclaration.repository.repository_id}` !== authority.repositoryId ||
          parsedDeclaration.repository.owner !== authority.owner ||
          parsedDeclaration.repository.name !== authority.name ||
          parsedDeclaration.fleet_state !== authority.fleetState ||
          canonicalJson(parsedDeclaration.maintenance_programs) !== canonicalJson(authority.maintenancePrograms) ||
          canonicalJson(parsedDeclaration.action_ceiling) !== canonicalJson(authority.actionCeiling) ||
          canonicalJson(parsedDeclaration.accountable_owners as unknown as JsonValue) !==
            canonicalJson(authority.accountableOwners) ||
          parsedDeclaration.surface_contract_version !== authority.surfaceContractVersion
        ) {
          throw new Error(`repository Core authority lineage mismatch: ${String(row.record_id)}`);
        }
      }
      if (
        String(row.kind) === "repository.github-identity-observation" ||
        String(row.kind) === "repository.github-identity-reconciled" ||
        String(row.kind) === "repository.github-identity-reconciliation-recorded"
      ) {
        const reconciliation = payload as RepositoryGitHubReconciliationPayload;
        const authority = this.db
          .prepare(
            `SELECT payload_json FROM durable_occurrences
             WHERE record_id = ? AND kind = 'repository.core-authorized'`,
          )
          .get(reconciliation.coreAuthorizationRecordId) as Row | undefined;
        const authorityPayload = authority
          ? parseJson(String(authority.payload_json))
          : undefined;
        const expectedRecordId =
          String(row.kind) === "repository.github-identity-observation"
            ? reconciliation.observationRecordId
            : String(row.kind) === "repository.github-identity-reconciled"
              ? reconciliation.reconciliationRecordId
              : reconciliation.eventRecordId;
        if (
          !authority ||
          !authorityPayload ||
          !recordKindRegistry["repository.core-authorized"].validatePayload(authorityPayload) ||
          String(row.subject_kind) !== "github-repository" ||
          String(row.subject_id) !== reconciliation.repositoryId ||
          (expectedRecordId !== null && String(row.record_id) !== expectedRecordId) ||
          String(row.revision_kind) !== "github-metadata-sha256" ||
          String(row.revision_value) !== reconciliation.responseDigest ||
          String(row.source_kind) !== "github-api" ||
          String(row.source_id) !== "api.github.com" ||
          String(row.source_revision_kind) !== "github-metadata-sha256" ||
          String(row.source_revision_value) !== reconciliation.responseDigest ||
          String(row.causation_record_id) !== reconciliation.coreAuthorizationRecordId ||
          String(row.recorded_at) !== reconciliation.checkedAt ||
          authorityPayload.repositoryId !== reconciliation.repositoryId ||
          authorityPayload.coreSnapshotId !== reconciliation.coreSnapshotId ||
          authorityPayload.owner !== reconciliation.declaredOwner ||
          authorityPayload.name !== reconciliation.declaredName ||
          authorityPayload.fleetState !== reconciliation.fleetState
        ) {
          throw new Error(`repository GitHub reconciliation lineage mismatch: ${String(row.record_id)}`);
        }
      }
      if (
        String(row.kind) === "repository.canonical-surface-observation" ||
        String(row.kind) === "repository.enrollment-checkpoint-policy-decision" ||
        String(row.kind) === "repository.canonical-surfaces-reconciled" ||
        String(row.kind) === "repository.canonical-surfaces-reconciliation-recorded"
      ) {
        const surface = payload as RepositorySurfaceReconciliationPayload;
        const identity = this.db
          .prepare(
            `SELECT payload_json FROM durable_occurrences
             WHERE record_id = ? AND kind = 'repository.github-identity-reconciled'`,
          )
          .get(surface.githubReconciliationRecordId) as Row | undefined;
        const identityPayload = identity ? parseJson(String(identity.payload_json)) : undefined;
        const expectedRecordId =
          String(row.kind) === "repository.canonical-surface-observation"
            ? surface.observationRecordId
            : String(row.kind) === "repository.enrollment-checkpoint-policy-decision"
              ? surface.policyDecisionRecordId
              : String(row.kind) === "repository.canonical-surfaces-reconciled"
                ? surface.reconciliationRecordId
                : surface.eventRecordId;
        const expectedSourceRevisionKind =
          surface.repositoryCommitId === null ? "github-metadata-sha256" : "git-commit-sha1";
        const expectedSourceRevisionValue =
          surface.repositoryCommitId === null ? surface.probeDigest : `sha1:${surface.repositoryCommitId}`;
        if (
          !identityPayload ||
          !recordKindRegistry["repository.github-identity-reconciled"].validatePayload(identityPayload) ||
          identityPayload.result !== "matched" ||
          String(row.subject_kind) !== "github-repository" ||
          String(row.subject_id) !== surface.repositoryId ||
          String(row.record_id) !== expectedRecordId ||
          String(row.revision_kind) !== "repository-surfaces-sha256" ||
          String(row.revision_value) !== surface.probeDigest ||
          String(row.source_kind) !== "github-api" ||
          String(row.source_id) !== "api.github.com" ||
          String(row.source_revision_kind) !== expectedSourceRevisionKind ||
          String(row.source_revision_value) !== expectedSourceRevisionValue ||
          String(row.causation_record_id) !== surface.githubReconciliationRecordId ||
          String(row.recorded_at) !== surface.checkedAt ||
          identityPayload.repositoryId !== surface.repositoryId ||
          identityPayload.coreSnapshotId !== surface.coreSnapshotId ||
          identityPayload.coreAuthorizationRecordId !== surface.coreAuthorizationRecordId ||
          (surface.defaultBranch !== null && identityPayload.observedDefaultBranch !== surface.defaultBranch)
        ) {
          throw new Error(`repository surface reconciliation lineage mismatch: ${String(row.record_id)}`);
        }
        if (surface.result === "valid") {
          try {
            validateRepositoryGovernanceBytes(Buffer.from(canonicalJson(surface.governancePolicy!), "utf8"));
          } catch {
            throw new Error(`repository surface governance lineage mismatch: ${String(row.record_id)}`);
          }
        }
      }
      if (
        String(row.kind) === "repository.controller-definition" ||
        String(row.kind) === "repository.enrolled" ||
        String(row.kind) === "repository.enrollment-established"
      ) {
        const enrollment = payload as RepositoryEnrollmentPayload;
        const surface = this.db
          .prepare(
            `SELECT payload_json FROM durable_occurrences
             WHERE record_id = ? AND kind = 'repository.canonical-surfaces-reconciled'`,
          )
          .get(enrollment.surfaceReconciliationRecordId) as Row | undefined;
        const surfacePayload = surface ? parseJson(String(surface.payload_json)) : undefined;
        const expectedRecordId =
          String(row.kind) === "repository.controller-definition"
            ? enrollment.controllerDefinitionRecordId
            : String(row.kind) === "repository.enrolled"
              ? enrollment.enrollmentRecordId
              : enrollment.eventRecordId;
        if (
          !surfacePayload ||
          !recordKindRegistry["repository.canonical-surfaces-reconciled"].validatePayload(surfacePayload) ||
          surfacePayload.result !== "valid" ||
          String(row.subject_kind) !== "github-repository" ||
          String(row.subject_id) !== enrollment.repositoryId ||
          String(row.record_id) !== expectedRecordId ||
          String(row.revision_kind) !== "git-commit-sha1" ||
          String(row.revision_value) !== `sha1:${enrollment.repositoryCommitId}` ||
          String(row.source_kind) !== "github-repository" ||
          String(row.source_id) !== enrollment.repositoryId ||
          String(row.source_revision_kind) !== "git-commit-sha1" ||
          String(row.source_revision_value) !== `sha1:${enrollment.repositoryCommitId}` ||
          String(row.causation_record_id) !== enrollment.surfaceReconciliationRecordId ||
          String(row.recorded_at) !== enrollment.enrolledAt ||
          surfacePayload.repositoryId !== enrollment.repositoryId ||
          surfacePayload.coreSnapshotId !== enrollment.coreSnapshotId ||
          surfacePayload.coreAuthorizationRecordId !== enrollment.coreAuthorizationRecordId ||
          surfacePayload.githubReconciliationRecordId !== enrollment.githubReconciliationRecordId ||
          surfacePayload.policyDecisionRecordId !== enrollment.surfacePolicyDecisionRecordId ||
          surfacePayload.repositoryCommitId !== enrollment.repositoryCommitId
        ) {
          throw new Error(`repository enrollment lineage mismatch: ${String(row.record_id)}`);
        }
      }
      if (
        String(row.kind) === "repository.operator-hold-decision" ||
        String(row.kind) === "repository.operator-hold-imposed" ||
        String(row.kind) === "repository.operator-hold-cleared"
      ) {
        const hold = payload as RepositoryOperatorHoldDecisionPayload;
        const authority = this.db
          .prepare(
            `SELECT payload_json, transaction_sequence FROM durable_occurrences
             WHERE record_id = ? AND kind = 'repository.core-authorized'`,
          )
          .get(hold.coreAuthorizationRecordId) as Row | undefined;
        const authorityPayload = authority ? parseJson(String(authority.payload_json)) : undefined;
        const activeSnapshotAtDecision = this.db
          .prepare(
            `SELECT snapshot_id FROM core_snapshots
             WHERE activated_transaction_sequence <= ?
             ORDER BY activated_transaction_sequence DESC LIMIT 1`,
          )
          .get(hold.expectedLastTransactionSequence) as Row | undefined;
        const prior = this.db
          .prepare(
            `SELECT occurrence.record_id, occurrence.payload_json
             FROM durable_occurrences occurrence
             JOIN durable_records record ON record.record_id = occurrence.record_id
             WHERE occurrence.kind = 'repository.operator-hold-decision'
               AND record.record_class = 'decision'
               AND occurrence.subject_id = ?
               AND occurrence.transaction_sequence < ?
             ORDER BY occurrence.transaction_sequence DESC LIMIT 1`,
          )
          .get(hold.repositoryId, row.transaction_sequence!) as Row | undefined;
        const priorPayload = prior ? parseJson(String(prior.payload_json)) : undefined;
        const decisionOccurrence = String(row.kind) === "repository.operator-hold-decision";
        const expectedEventKind = hold.choice === "impose"
          ? "repository.operator-hold-imposed"
          : "repository.operator-hold-cleared";
        const expectedCausation = decisionOccurrence
          ? hold.choice === "impose"
            ? hold.coreAuthorizationRecordId
            : hold.holdDecisionId
          : hold.decisionRecordId;
        const priorChainValid = hold.choice === "impose"
          ? prior === undefined ||
            (recordKindRegistry["repository.operator-hold-decision"].validatePayload(priorPayload) &&
              priorPayload.choice === "clear")
          : prior !== undefined &&
            String(prior.record_id) === hold.holdDecisionId &&
            recordKindRegistry["repository.operator-hold-decision"].validatePayload(priorPayload) &&
            priorPayload.choice === "impose";
        if (
          !authorityPayload ||
          !recordKindRegistry["repository.core-authorized"].validatePayload(authorityPayload) ||
          String(row.subject_kind) !== "github-repository" ||
          String(row.subject_id) !== hold.repositoryId ||
          String(row.record_id) !== (decisionOccurrence ? hold.decisionRecordId : hold.eventRecordId) ||
          (!decisionOccurrence && String(row.kind) !== expectedEventKind) ||
          String(row.revision_kind) !== "core-declaration-sha256" ||
          String(row.revision_value) !== hold.declarationDigest ||
          String(row.source_kind) !== "operator-principal" ||
          String(row.source_id) !== this.metadata().operatorPrincipalId ||
          row.source_revision_kind != null ||
          row.source_revision_value != null ||
          String(row.correlation_id) !== hold.holdDecisionId ||
          String(row.causation_record_id) !== expectedCausation ||
          String(row.recorded_at) !== hold.decidedAt ||
          hold.operatorPrincipalId !== this.metadata().operatorPrincipalId ||
          Number(row.transaction_sequence) !== hold.expectedLastTransactionSequence + 1 ||
          authorityPayload.repositoryId !== hold.repositoryId ||
          authorityPayload.coreSnapshotId !== hold.coreSnapshotId ||
          authorityPayload.declarationDigest !== hold.declarationDigest ||
          Number(authority?.transaction_sequence) > hold.expectedLastTransactionSequence ||
          String(activeSnapshotAtDecision?.snapshot_id) !== hold.coreSnapshotId ||
          !priorChainValid
        ) {
          throw new Error(`repository operator hold lineage mismatch: ${String(row.record_id)}`);
        }
      }
      if (row.revision_kind === "sha256" && String(row.revision_value) !== String(row.payload_digest)) {
        throw new Error(`database occurrence revision does not match its payload: ${String(row.record_id)}`);
      }
    }

    const recordCount = Number((this.db.prepare("SELECT COUNT(*) AS count FROM durable_records").get() as Row).count);
    const eventCount = Number((this.db.prepare("SELECT COUNT(*) AS count FROM event_ledger").get() as Row).count);
    if (recordCount + eventCount !== rows.length) throw new Error("durable occurrence subtype coverage mismatch");
  }

  private verifyCoreSnapshots(): void {
    const snapshots = this.db
      .prepare("SELECT * FROM core_snapshots ORDER BY activated_transaction_sequence")
      .all() as Row[];
    const subjectCount = Number(
      (this.db.prepare("SELECT COUNT(*) AS count FROM subjects WHERE subject_kind = 'core-snapshot'").get() as Row)
        .count,
    );
    if (subjectCount !== snapshots.length) throw new Error("Core snapshot subject coverage mismatch");

    for (const snapshot of snapshots) {
      const snapshotId = String(snapshot.snapshot_id);
      const files = this.db
        .prepare("SELECT * FROM core_snapshot_files WHERE snapshot_id = ? ORDER BY path")
        .all(snapshotId) as Row[];
      files.sort((left, right) => String(left.path).localeCompare(String(right.path)));
      const catalogMaterial: JsonValue[] = [];
      const retainedEntries: CoreTreeEntry[] = [];
      for (const file of files) {
        const bytes = file.raw_bytes;
        if (!(bytes instanceof Uint8Array)) throw new Error(`Core snapshot file is not retained as bytes: ${String(file.path)}`);
        if (bytes.byteLength !== Number(file.byte_size)) {
          throw new Error(`Core snapshot file size mismatch: ${String(file.path)}`);
        }
        const contentDigest = sha256Bytes(bytes);
        if (contentDigest !== String(file.content_digest)) {
          throw new Error(`Core snapshot file digest mismatch: ${String(file.path)}`);
        }
        if (
          (file.mode !== "100644" && file.mode !== "100755") ||
          !/^[0-9a-f]{40}$/.test(String(file.object_id))
        ) {
          throw new Error(`Core snapshot file identity mismatch: ${String(file.path)}`);
        }
        const isRepositoryDeclaration = /^organization\/repositories\/[^/]+\/[^/]+\.json$/.test(String(file.path));
        if (isRepositoryDeclaration !== (file.parsed_json != null)) {
          throw new Error(`Core snapshot parsed-record coverage mismatch: ${String(file.path)}`);
        }
        if (file.parsed_json != null) {
          const parsedJson = String(file.parsed_json);
          const parsed = parseJson(parsedJson);
          if (canonicalJson(parsed) !== parsedJson) {
            throw new Error(`Core snapshot parsed record is not canonical: ${String(file.path)}`);
          }
          const rawParsed = parseJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          if (canonicalJson(rawParsed) !== parsedJson) {
            throw new Error(`Core snapshot parsed record does not match retained bytes: ${String(file.path)}`);
          }
        }
        catalogMaterial.push({
          contentDigest,
          mode: String(file.mode),
          objectId: String(file.object_id),
          path: String(file.path),
          size: Number(file.byte_size),
        });
        retainedEntries.push({
          path: String(file.path),
          mode: String(file.mode) as "100644" | "100755",
          objectId: String(file.object_id),
          bytes,
        });
      }
      const catalogDigest = sha256(canonicalJson(catalogMaterial));
      if (catalogDigest !== String(snapshot.catalog_digest)) {
        throw new Error(`Core snapshot catalog digest mismatch: ${snapshotId}`);
      }
      const validated = validateCoreCatalog(retainedEntries);
      if (validated.catalogDigest !== catalogDigest) {
        throw new Error(`Core snapshot retained validation digest mismatch: ${snapshotId}`);
      }

      const definition = this.db
        .prepare("SELECT * FROM durable_occurrences WHERE record_id = ?")
        .get(snapshot.definition_record_id!) as Row | undefined;
      const fact = this.db
        .prepare("SELECT * FROM durable_occurrences WHERE record_id = ?")
        .get(snapshot.active_fact_record_id!) as Row | undefined;
      const event = this.db
        .prepare("SELECT * FROM durable_occurrences WHERE record_id = ?")
        .get(snapshot.activation_event_record_id!) as Row | undefined;
      if (
        !definition ||
        definition.kind !== "core.snapshot-definition" ||
        definition.subject_id !== snapshotId ||
        definition.revision_value !== catalogDigest
      ) {
        throw new Error(`Core snapshot definition linkage mismatch: ${snapshotId}`);
      }
      if (
        !fact ||
        fact.kind !== "core.snapshot-active" ||
        Number(fact.transaction_sequence) !== Number(snapshot.activated_transaction_sequence)
      ) {
        throw new Error(`Core snapshot active-fact linkage mismatch: ${snapshotId}`);
      }
      if (
        !event ||
        (event.kind !== "core.snapshot-activated" && event.kind !== "core.snapshot-rollback-activated") ||
        event.subject_id !== snapshotId ||
        Number(event.transaction_sequence) !== Number(snapshot.activated_transaction_sequence)
      ) {
        throw new Error(`Core snapshot activation-event linkage mismatch: ${snapshotId}`);
      }
      for (const occurrence of [definition, fact, event]) {
        if (
          occurrence.source_kind !== "github-repository" ||
          occurrence.source_id !== "github.com:1331309458" ||
          occurrence.source_revision_kind !== "git-commit-sha1" ||
          occurrence.source_revision_value !== `sha1:${String(snapshot.source_commit_id)}`
        ) {
          throw new Error(`Core snapshot source linkage mismatch: ${snapshotId}`);
        }
      }
      const definitionPayload = parseJson(String(definition.payload_json)) as Record<string, JsonValue>;
      const activePayload = parseJson(String(fact.payload_json)) as Record<string, JsonValue>;
      if (
        definitionPayload.snapshotId !== snapshotId ||
        definitionPayload.catalogDigest !== catalogDigest ||
        definitionPayload.sourceCommitId !== String(snapshot.source_commit_id) ||
        definitionPayload.sourceTreeId !== String(snapshot.source_tree_id) ||
        definitionPayload.sourceUrl !== String(snapshot.source_url) ||
        definitionPayload.sourceRef !== String(snapshot.source_ref) ||
        definitionPayload.importedAt !== String(snapshot.imported_at) ||
        Number(definitionPayload.fileCount) !== validated.fileCount ||
        Number(definitionPayload.totalBytes) !== validated.totalBytes ||
        Number(definitionPayload.repositoryCount) !== validated.repositoryCount ||
        Number(definitionPayload.validFixtureCount) !== validated.validFixtureCount ||
        Number(definitionPayload.invalidFixtureCount) !== validated.invalidFixtureCount ||
        canonicalJson(definitionPayload.schemaDigests!) !==
          canonicalJson(validated.schemaDigests as unknown as JsonValue) ||
        snapshot.source_kind !== "github-repository" ||
        snapshot.source_id !== "github.com:1331309458"
      ) {
        throw new Error(`Core snapshot definition payload mismatch: ${snapshotId}`);
      }
      if (
        activePayload.snapshotId !== snapshotId ||
        activePayload.catalogDigest !== catalogDigest ||
        activePayload.sourceCommitId !== String(snapshot.source_commit_id) ||
        activePayload.activatedAt !== String(snapshot.imported_at) ||
        activePayload.databaseLineageId !== this.metadata().databaseLineageId ||
        fact.subject_id !== this.metadata().databaseLineageId
      ) {
        throw new Error(`Core snapshot activation payload mismatch: ${snapshotId}`);
      }
      if (event.kind === "core.snapshot-activated") {
        if (
          String(fact.payload_json) !== String(event.payload_json) ||
          definition.causation_record_id != null ||
          fact.causation_record_id != null ||
          event.causation_record_id != null
        ) {
          throw new Error(`automatic Core snapshot activation lineage mismatch: ${snapshotId}`);
        }
      } else {
        const rollbackPayload = parseJson(String(event.payload_json));
        if (!eventKindRegistry["core.snapshot-rollback-activated"].validatePayload(rollbackPayload)) {
          throw new Error(`Core rollback activation payload mismatch: ${snapshotId}`);
        }
        const rollback = rollbackPayload as CoreRollbackActivatedPayload;
        const decision = this.db
          .prepare(
            `SELECT occurrence.*, record.record_class
             FROM durable_occurrences occurrence
             JOIN durable_records record ON record.record_id = occurrence.record_id
             WHERE occurrence.record_id = ?`,
          )
          .get(rollback.decisionRecordId) as Row | undefined;
        const decisionPayload = decision ? parseJson(String(decision.payload_json)) : undefined;
        const transaction = this.db
          .prepare("SELECT principal_kind, principal_id FROM control_transactions WHERE sequence = ?")
          .get(snapshot.activated_transaction_sequence!) as Row | undefined;
        if (
          !decision ||
          !decisionPayload ||
          !recordKindRegistry["core.rollback-decision"].validatePayload(decisionPayload) ||
          decision.record_class !== "decision" ||
          Number(decision.transaction_sequence) !== Number(snapshot.activated_transaction_sequence) ||
          Number(decision.transaction_position) !== 0 ||
          rollback.snapshotId !== snapshotId ||
          rollback.catalogDigest !== catalogDigest ||
          rollback.sourceCommitId !== String(snapshot.source_commit_id) ||
          rollback.activatedAt !== String(snapshot.imported_at) ||
          rollback.operatorPrincipalId !== this.metadata().operatorPrincipalId ||
          definition.causation_record_id !== rollback.decisionRecordId ||
          fact.causation_record_id !== rollback.decisionRecordId ||
          event.causation_record_id !== rollback.decisionRecordId ||
          definition.correlation_id !== rollback.decisionRecordId ||
          fact.correlation_id !== rollback.decisionRecordId ||
          event.correlation_id !== rollback.decisionRecordId ||
          (decisionPayload as CoreRollbackDecisionPayload).activeSnapshotId !== rollback.previousSnapshotId ||
          (decisionPayload as CoreRollbackDecisionPayload).activeCommitId !== rollback.previousSourceCommitId ||
          (decisionPayload as CoreRollbackDecisionPayload).targetCommitId !== rollback.sourceCommitId ||
          (decisionPayload as CoreRollbackDecisionPayload).targetCatalogDigest !== rollback.catalogDigest ||
          (decisionPayload as CoreRollbackDecisionPayload).reason !== rollback.reason ||
          (decisionPayload as CoreRollbackDecisionPayload).expectedLastTransactionSequence !==
            Number(snapshot.activated_transaction_sequence) - 1 ||
          transaction?.principal_kind !== "operator-principal" ||
          transaction.principal_id !== this.metadata().operatorPrincipalId
        ) {
          throw new Error(`Core rollback decision/activation linkage mismatch: ${snapshotId}`);
        }
        const previousSnapshot = this.db
          .prepare("SELECT source_commit_id FROM core_snapshots WHERE snapshot_id = ?")
          .get(rollback.previousSnapshotId) as Row | undefined;
        const immediatelyPrevious = this.db
          .prepare(
            `SELECT snapshot_id FROM core_snapshots
             WHERE activated_transaction_sequence < ?
             ORDER BY activated_transaction_sequence DESC LIMIT 1`,
          )
          .get(snapshot.activated_transaction_sequence!) as Row | undefined;
        if (
          !previousSnapshot ||
          previousSnapshot.source_commit_id !== rollback.previousSourceCommitId ||
          immediatelyPrevious?.snapshot_id !== rollback.previousSnapshotId
        ) {
          throw new Error(`Core rollback previous-snapshot linkage mismatch: ${snapshotId}`);
        }
      }
    }

    const active = this.db.prepare("SELECT * FROM core_active_snapshot WHERE singleton = 1").get() as Row | undefined;
    const latest = snapshots.at(-1);
    if (!latest && active) throw new Error("Core active snapshot exists without a retained snapshot");
    if (
      latest &&
      (!active ||
        active.snapshot_id !== latest.snapshot_id ||
        active.fact_record_id !== latest.active_fact_record_id ||
        Number(active.activated_transaction_sequence) !== Number(latest.activated_transaction_sequence) ||
        active.activated_at !== latest.imported_at)
    ) {
      throw new Error("Core active snapshot does not match the latest activation fact");
    }
  }

  private verifyIdempotencyReceipts(): void {
    const rows = this.db.prepare("SELECT * FROM idempotency_receipts").all() as Row[];
    const metadata = this.metadata();
    for (const row of rows) {
      const commandKind = String(row.command_kind);
      const command = commandKindRegistry[commandKind as keyof typeof commandKindRegistry];
      if (!command) throw new Error(`idempotency receipt has unknown command kind: ${commandKind}`);
      if (Number(row.command_schema_version) !== command.schemaVersion) {
        throw new Error(`idempotency receipt has unknown command version: ${commandKind}`);
      }
      if (!/^sha256:[0-9a-f]{64}$/.test(String(row.payload_digest))) {
        throw new Error(`idempotency receipt has invalid payload digest: ${String(row.idempotency_key)}`);
      }
      const resultJson = String(row.result_json);
      const result = parseJson(resultJson);
      if (canonicalJson(result) !== resultJson) {
        throw new Error(`idempotency receipt result is not canonical JSON: ${String(row.idempotency_key)}`);
      }
      if (commandKind === "control-plane.check-integrity") parseIntegrityCheckResult(result);
      if (commandKind === "core.activate-snapshot") parseCoreSnapshotActivationResult(result);
      if (commandKind === "core.rollback-snapshot") parseCoreSnapshotRollbackResult(result);
      if (commandKind === "core.record-candidate-rejection") parseCoreCandidateRejectionResult(result);
      if (commandKind === "core.record-source-check-eligible") parseCoreSourceCheckEligibleResult(result);
      if (commandKind === "core.issue-stale-source-override") parseCoreStaleSourceOverrideResult(result);
      if (commandKind === "core.prune-check-detail") parseCoreCheckDetailPruneResult(result);
      if (commandKind === "repository.materialize-core-authority") parseRepositoryCoreAuthorityResult(result);
      if (commandKind === "repository.record-github-identity") parseRepositoryGitHubReconciliationResult(result);
      if (commandKind === "repository.record-canonical-surfaces") parseRepositorySurfaceReconciliationResult(result);
      if (commandKind === "repository.establish-enrollment") parseRepositoryEnrollmentResult(result);
      if (
        commandKind === "repository.impose-operator-hold" ||
        commandKind === "repository.clear-operator-hold"
      ) {
        parseRepositoryOperatorHoldResult(result);
      }
      assertUtcInstant(String(row.retained_until), `idempotency receipt ${String(row.idempotency_key)} retention time`);
      if (
        (commandKind === "control-plane.check-integrity" ||
          commandKind === "core.activate-snapshot" ||
          commandKind === "core.rollback-snapshot" ||
          commandKind === "core.record-candidate-rejection" ||
          commandKind === "core.record-source-check-eligible" ||
          commandKind === "core.issue-stale-source-override" ||
          commandKind === "core.prune-check-detail" ||
          commandKind === "repository.materialize-core-authority" ||
          commandKind === "repository.record-github-identity" ||
          commandKind === "repository.record-canonical-surfaces" ||
          commandKind === "repository.establish-enrollment" ||
          commandKind === "repository.impose-operator-hold" ||
          commandKind === "repository.clear-operator-hold") &&
        String(row.retained_until) !== IDEMPOTENCY_RETAINED_UNTIL
      ) {
        throw new Error(`idempotency receipt retention mismatch: ${String(row.idempotency_key)}`);
      }
      if (String(row.command_scope) !== `database:${metadata.databaseLineageId}`) {
        throw new Error(`idempotency receipt command scope mismatch: ${String(row.idempotency_key)}`);
      }

      const transaction = this.db
        .prepare(
          `SELECT command_kind, command_schema_version, idempotency_key, payload_digest,
                  evaluation_time, recorded_at
           FROM control_transactions WHERE sequence = ?`,
        )
        .get(row.transaction_sequence!) as Row | undefined;
      if (
        !transaction ||
        String(transaction.command_kind) !== commandKind ||
        Number(transaction.command_schema_version) !== Number(row.command_schema_version) ||
        String(transaction.idempotency_key) !== String(row.idempotency_key) ||
        String(transaction.payload_digest) !== String(row.payload_digest)
      ) {
        throw new Error(`idempotency receipt transaction mismatch: ${String(row.idempotency_key)}`);
      }

      if (commandKind === "control-plane.check-integrity") {
        const integrityResult = parseIntegrityCheckResult(result);
        if (
          integrityResult.transactionSequence !== Number(row.transaction_sequence) ||
          integrityResult.evaluationTime !== String(transaction.evaluation_time) ||
          integrityResult.recordedTime !== String(transaction.recorded_at)
        ) {
          throw new Error(`integrity receipt result transaction mismatch: ${String(row.idempotency_key)}`);
        }
        const outputs = this.db
          .prepare(
            `SELECT record_id, revision_kind, revision_value
             FROM durable_occurrences
             WHERE transaction_sequence = ?
             ORDER BY transaction_position`,
          )
          .all(row.transaction_sequence!) as Row[];
        if (
          outputs.length !== 2 ||
          String(outputs[0]!.record_id) !== integrityResult.observationRecordId ||
          String(outputs[1]!.record_id) !== integrityResult.eventRecordId ||
          outputs.some(
            (output) =>
              output.revision_kind !== "transaction-sequence" ||
              Number(output.revision_value) !== integrityResult.checkedThroughSequence,
          )
        ) {
          throw new Error(`integrity receipt result output mismatch: ${String(row.idempotency_key)}`);
        }
      }
      if (commandKind === "core.activate-snapshot") {
        const activation = parseCoreSnapshotActivationResult(result);
        if (
          String(row.idempotency_key) !==
            `core-activate:${activation.transactionSequence - 1}:${activation.sourceCommitId}` ||
          activation.transactionSequence !== Number(row.transaction_sequence) ||
          activation.importedAt !== String(transaction.evaluation_time) ||
          activation.importedAt !== String(transaction.recorded_at)
        ) {
          throw new Error(`Core activation receipt result transaction mismatch: ${String(row.idempotency_key)}`);
        }
        const outputs = this.db
          .prepare(
            `SELECT record_id FROM durable_occurrences
             WHERE transaction_sequence = ? ORDER BY transaction_position`,
          )
          .all(row.transaction_sequence!) as Row[];
        if (
          outputs.length !== 3 ||
          String(outputs[0]!.record_id) !== activation.definitionRecordId ||
          String(outputs[1]!.record_id) !== activation.activeFactRecordId ||
          String(outputs[2]!.record_id) !== activation.eventRecordId
        ) {
          throw new Error(`Core activation receipt result output mismatch: ${String(row.idempotency_key)}`);
        }
      }
      if (commandKind === "core.rollback-snapshot") {
        const rollback = parseCoreSnapshotRollbackResult(result);
        if (
          String(row.idempotency_key) !==
            `core-rollback:${rollback.transactionSequence - 1}:${rollback.sourceCommitId}` ||
          rollback.transactionSequence !== Number(row.transaction_sequence) ||
          rollback.importedAt !== String(transaction.evaluation_time) ||
          rollback.importedAt !== String(transaction.recorded_at)
        ) {
          throw new Error(`Core rollback receipt result transaction mismatch: ${String(row.idempotency_key)}`);
        }
        const outputs = this.db
          .prepare(
            `SELECT record_id FROM durable_occurrences
             WHERE transaction_sequence = ? ORDER BY transaction_position`,
          )
          .all(row.transaction_sequence!) as Row[];
        if (
          outputs.length !== 4 ||
          String(outputs[0]!.record_id) !== rollback.decisionRecordId ||
          String(outputs[1]!.record_id) !== rollback.definitionRecordId ||
          String(outputs[2]!.record_id) !== rollback.activeFactRecordId ||
          String(outputs[3]!.record_id) !== rollback.eventRecordId
        ) {
          throw new Error(`Core rollback receipt result output mismatch: ${String(row.idempotency_key)}`);
        }
        const decisionRow = this.db
          .prepare("SELECT payload_json FROM durable_occurrences WHERE record_id = ?")
          .get(rollback.decisionRecordId) as Row | undefined;
        const decisionPayload = decisionRow ? parseJson(String(decisionRow.payload_json)) : undefined;
        if (
          !decisionPayload ||
          !recordKindRegistry["core.rollback-decision"].validatePayload(decisionPayload) ||
          decisionPayload.operatorPrincipalId !== rollback.operatorPrincipalId ||
          decisionPayload.activeSnapshotId !== rollback.previousSnapshotId ||
          decisionPayload.activeCommitId !== rollback.previousSourceCommitId ||
          decisionPayload.targetCommitId !== rollback.sourceCommitId ||
          decisionPayload.targetCatalogDigest !== rollback.catalogDigest ||
          decisionPayload.reason !== rollback.reason
        ) {
          throw new Error(`Core rollback receipt result decision mismatch: ${String(row.idempotency_key)}`);
        }
      }
      if (commandKind === "core.record-candidate-rejection") {
        const rejection = parseCoreCandidateRejectionResult(result);
        if (
          String(row.idempotency_key) !== `core-rejection:${rejection.checkId}` ||
          rejection.transactionSequence !== Number(row.transaction_sequence) ||
          rejection.observedAt !== String(transaction.evaluation_time) ||
          rejection.observedAt !== String(transaction.recorded_at)
        ) {
          throw new Error(`Core rejection receipt result transaction mismatch: ${String(row.idempotency_key)}`);
        }
        const outputs = this.db
          .prepare(
            `SELECT record_id FROM durable_occurrences
             WHERE transaction_sequence = ? ORDER BY transaction_position`,
          )
          .all(row.transaction_sequence!) as Row[];
        if (
          outputs.length !== 2 ||
          String(outputs[0]!.record_id) !== rejection.observationRecordId ||
          String(outputs[1]!.record_id) !== rejection.eventRecordId
        ) {
          throw new Error(`Core rejection receipt result output mismatch: ${String(row.idempotency_key)}`);
        }
      }
      if (commandKind === "core.record-source-check-eligible") {
        const check = parseCoreSourceCheckEligibleResult(result);
        if (
          String(row.idempotency_key) !== `core-source-check:${check.checkId}` ||
          check.transactionSequence !== Number(row.transaction_sequence) ||
          check.checkedAt !== String(transaction.evaluation_time) ||
          check.checkedAt !== String(transaction.recorded_at)
        ) {
          throw new Error(`eligible Core source check receipt result mismatch: ${String(row.idempotency_key)}`);
        }
        const outputs = this.db
          .prepare(
            `SELECT record_id FROM durable_occurrences
             WHERE transaction_sequence = ? ORDER BY transaction_position`,
          )
          .all(row.transaction_sequence!) as Row[];
        if (
          outputs.length !== 2 ||
          String(outputs[0]!.record_id) !== check.observationRecordId ||
          String(outputs[1]!.record_id) !== check.eventRecordId
        ) {
          throw new Error(`eligible Core source check receipt output mismatch: ${String(row.idempotency_key)}`);
        }
      }
      if (commandKind === "core.issue-stale-source-override") {
        const override = parseCoreStaleSourceOverrideResult(result);
        if (
          String(row.idempotency_key) !==
            `core-stale-source-override:${override.transactionSequence - 1}:${new Date(override.expiresAt).getTime()}` ||
          override.transactionSequence !== Number(row.transaction_sequence) ||
          override.decidedAt !== String(transaction.evaluation_time) ||
          override.decidedAt !== String(transaction.recorded_at)
        ) {
          throw new Error(`Core stale-source override receipt result mismatch: ${String(row.idempotency_key)}`);
        }
        const outputs = this.db
          .prepare(
            `SELECT record_id FROM durable_occurrences
             WHERE transaction_sequence = ? ORDER BY transaction_position`,
          )
          .all(row.transaction_sequence!) as Row[];
        if (
          outputs.length !== 2 ||
          String(outputs[0]!.record_id) !== override.decisionRecordId ||
          String(outputs[1]!.record_id) !== override.eventRecordId
        ) {
          throw new Error(`Core stale-source override receipt output mismatch: ${String(row.idempotency_key)}`);
        }
        const decisionRow = this.db
          .prepare("SELECT payload_json FROM durable_occurrences WHERE record_id = ?")
          .get(override.decisionRecordId) as Row | undefined;
        const decisionPayload = decisionRow ? parseJson(String(decisionRow.payload_json)) : undefined;
        if (
          !decisionPayload ||
          !recordKindRegistry["core.stale-source-override-decision"].validatePayload(decisionPayload) ||
          decisionPayload.activeSnapshotId !== override.activeSnapshotId ||
          decisionPayload.operatorPrincipalId !== override.operatorPrincipalId ||
          decisionPayload.reason !== override.reason ||
          decisionPayload.decidedAt !== override.decidedAt ||
          decisionPayload.expiresAt !== override.expiresAt
        ) {
          throw new Error(`Core stale-source override receipt decision mismatch: ${String(row.idempotency_key)}`);
        }
      }
      if (commandKind === "core.prune-check-detail") {
        const prune = parseCoreCheckDetailPruneResult(result);
        if (
          String(row.idempotency_key) !== `core-prune-check-detail:${prune.transactionSequence - 1}` ||
          prune.transactionSequence !== Number(row.transaction_sequence) ||
          prune.evaluatedAt !== String(transaction.evaluation_time) ||
          prune.evaluatedAt !== String(transaction.recorded_at)
        ) {
          throw new Error(`Core check-detail prune receipt result mismatch: ${String(row.idempotency_key)}`);
        }
        const outputs = this.db
          .prepare(
            `SELECT record_id, payload_json FROM durable_occurrences
             WHERE transaction_sequence = ? ORDER BY transaction_position`,
          )
          .all(row.transaction_sequence!) as Row[];
        const payload = outputs[0] ? parseJson(String(outputs[0].payload_json)) : undefined;
        if (
          outputs.length !== 2 ||
          String(outputs[0]!.record_id) !== prune.observationRecordId ||
          String(outputs[1]!.record_id) !== prune.eventRecordId ||
          !payload ||
          !recordKindRegistry["core.check-detail-prune-observation"].validatePayload(payload) ||
          payload.cutoffAt !== prune.cutoffAt ||
          payload.evaluatedAt !== prune.evaluatedAt ||
          payload.maximumEligibleChecks !== prune.maximumEligibleChecks ||
          payload.deletedTransactionCount !== prune.deletedTransactionCount ||
          payload.deletedOccurrenceCount !== prune.deletedOccurrenceCount ||
          payload.deletedFirstSequence !== prune.deletedFirstSequence ||
          payload.deletedLastSequence !== prune.deletedLastSequence ||
          payload.deletedDigest !== prune.deletedDigest ||
          payload.remainingDetailedCheckCount !== prune.remainingDetailedCheckCount
        ) {
          throw new Error(`Core check-detail prune receipt output mismatch: ${String(row.idempotency_key)}`);
        }
      }
      if (commandKind === "repository.materialize-core-authority") {
        const authority = parseRepositoryCoreAuthorityResult(result);
        const outputs = this.db
          .prepare(
            `SELECT record_id FROM durable_occurrences
             WHERE transaction_sequence = ? ORDER BY transaction_position`,
          )
          .all(row.transaction_sequence!) as Row[];
        if (
          authority.transactionSequence !== Number(row.transaction_sequence) ||
          authority.authorizedAt !== String(transaction.evaluation_time) ||
          authority.authorizedAt !== String(transaction.recorded_at) ||
          String(row.idempotency_key) !==
            `repo-core:${authority.coreSnapshotId}:${authority.repositoryId.slice("github.com:".length)}` ||
          outputs.length !== 3 ||
          String(outputs[0]!.record_id) !== authority.declarationRecordId ||
          String(outputs[1]!.record_id) !== authority.coreAuthorizationRecordId ||
          String(outputs[2]!.record_id) !== authority.eventRecordId
        ) {
          throw new Error(`repository Core authority receipt output mismatch: ${String(row.idempotency_key)}`);
        }
      }
      if (commandKind === "repository.record-github-identity") {
        const reconciliation = parseRepositoryGitHubReconciliationResult(result);
        const predecessor = this.db
          .prepare(
            `SELECT record_id FROM durable_occurrences
             WHERE kind = 'repository.github-identity-reconciled'
               AND json_extract(payload_json, '$.coreAuthorizationRecordId') = ?
               AND transaction_sequence < ?
             ORDER BY transaction_sequence DESC LIMIT 1`,
          )
          .get(reconciliation.coreAuthorizationRecordId, reconciliation.transactionSequence) as Row | undefined;
        const predecessorRecordId = predecessor ? String(predecessor.record_id) : "initial";
        const outputs = this.db
          .prepare(
            `SELECT record_id FROM durable_occurrences
             WHERE transaction_sequence = ? ORDER BY transaction_position`,
          )
          .all(row.transaction_sequence!) as Row[];
        const factRow = this.db
          .prepare("SELECT payload_json FROM durable_occurrences WHERE record_id = ?")
          .get(reconciliation.reconciliationRecordId) as Row | undefined;
        const factPayload = factRow ? parseJson(String(factRow.payload_json)) : undefined;
        if (
          reconciliation.transactionSequence !== Number(row.transaction_sequence) ||
          reconciliation.checkedAt !== String(transaction.evaluation_time) ||
          reconciliation.checkedAt !== String(transaction.recorded_at) ||
          String(row.idempotency_key) !==
            `repo-gh:${reconciliation.coreAuthorizationRecordId}:${predecessorRecordId}:${reconciliation.responseDigest.slice("sha256:".length)}` ||
          outputs.length !== 3 ||
          String(outputs[0]!.record_id) !== reconciliation.observationRecordId ||
          String(outputs[1]!.record_id) !== reconciliation.reconciliationRecordId ||
          String(outputs[2]!.record_id) !== reconciliation.eventRecordId ||
          !factPayload ||
          !recordKindRegistry["repository.github-identity-reconciled"].validatePayload(factPayload) ||
          factPayload.repositoryId !== reconciliation.repositoryId ||
          factPayload.coreSnapshotId !== reconciliation.coreSnapshotId ||
          factPayload.coreAuthorizationRecordId !== reconciliation.coreAuthorizationRecordId ||
          factPayload.result !== reconciliation.result ||
          factPayload.effectiveState !== reconciliation.effectiveState ||
          factPayload.checkedAt !== reconciliation.checkedAt ||
          factPayload.responseDigest !== reconciliation.responseDigest
        ) {
          throw new Error(`repository GitHub reconciliation receipt output mismatch: ${String(row.idempotency_key)}`);
        }
      }
      if (commandKind === "repository.record-canonical-surfaces") {
        const reconciliation = parseRepositorySurfaceReconciliationResult(result);
        const predecessor = this.db
          .prepare(
            `SELECT record_id FROM durable_occurrences
             WHERE kind = 'repository.canonical-surfaces-reconciled'
               AND json_extract(payload_json, '$.githubReconciliationRecordId') = ?
               AND transaction_sequence < ?
             ORDER BY transaction_sequence DESC LIMIT 1`,
          )
          .get(reconciliation.githubReconciliationRecordId, reconciliation.transactionSequence) as Row | undefined;
        const predecessorRecordId = predecessor ? String(predecessor.record_id) : "initial";
        const outputs = this.db
          .prepare(
            `SELECT record_id FROM durable_occurrences
             WHERE transaction_sequence = ? ORDER BY transaction_position`,
          )
          .all(row.transaction_sequence!) as Row[];
        const factRow = this.db
          .prepare("SELECT payload_json FROM durable_occurrences WHERE record_id = ?")
          .get(reconciliation.reconciliationRecordId) as Row | undefined;
        const factPayload = factRow ? parseJson(String(factRow.payload_json)) : undefined;
        if (
          reconciliation.transactionSequence !== Number(row.transaction_sequence) ||
          reconciliation.checkedAt !== String(transaction.evaluation_time) ||
          reconciliation.checkedAt !== String(transaction.recorded_at) ||
          String(row.idempotency_key) !==
            `repo-surfaces:${reconciliation.githubReconciliationRecordId}:${predecessorRecordId}:${reconciliation.probeDigest.slice("sha256:".length)}` ||
          outputs.length !== 4 ||
          String(outputs[0]!.record_id) !== reconciliation.observationRecordId ||
          String(outputs[1]!.record_id) !== reconciliation.policyDecisionRecordId ||
          String(outputs[2]!.record_id) !== reconciliation.reconciliationRecordId ||
          String(outputs[3]!.record_id) !== reconciliation.eventRecordId ||
          !factPayload ||
          !recordKindRegistry["repository.canonical-surfaces-reconciled"].validatePayload(factPayload) ||
          factPayload.repositoryId !== reconciliation.repositoryId ||
          factPayload.coreSnapshotId !== reconciliation.coreSnapshotId ||
          factPayload.coreAuthorizationRecordId !== reconciliation.coreAuthorizationRecordId ||
          factPayload.githubReconciliationRecordId !== reconciliation.githubReconciliationRecordId ||
          factPayload.result !== reconciliation.result ||
          factPayload.repositoryCommitId !== reconciliation.repositoryCommitId ||
          factPayload.checkedAt !== reconciliation.checkedAt ||
          factPayload.probeDigest !== reconciliation.probeDigest
        ) {
          throw new Error(`repository surface reconciliation receipt output mismatch: ${String(row.idempotency_key)}`);
        }
      }
      if (commandKind === "repository.establish-enrollment") {
        const enrollment = parseRepositoryEnrollmentResult(result);
        const outputs = this.db
          .prepare(
            `SELECT record_id FROM durable_occurrences
             WHERE transaction_sequence = ? ORDER BY transaction_position`,
          )
          .all(row.transaction_sequence!) as Row[];
        const factRow = this.db
          .prepare("SELECT payload_json FROM durable_occurrences WHERE record_id = ?")
          .get(enrollment.enrollmentRecordId) as Row | undefined;
        const factPayload = factRow ? parseJson(String(factRow.payload_json)) : undefined;
        if (
          enrollment.transactionSequence !== Number(row.transaction_sequence) ||
          enrollment.enrolledAt !== String(transaction.evaluation_time) ||
          enrollment.enrolledAt !== String(transaction.recorded_at) ||
          String(row.idempotency_key) !== `repo-enroll:${enrollment.surfaceReconciliationRecordId}` ||
          outputs.length !== 3 ||
          String(outputs[0]!.record_id) !== enrollment.controllerDefinitionRecordId ||
          String(outputs[1]!.record_id) !== enrollment.enrollmentRecordId ||
          String(outputs[2]!.record_id) !== enrollment.eventRecordId ||
          !factPayload ||
          !recordKindRegistry["repository.enrolled"].validatePayload(factPayload) ||
          factPayload.repositoryId !== enrollment.repositoryId ||
          factPayload.coreSnapshotId !== enrollment.coreSnapshotId ||
          factPayload.coreAuthorizationRecordId !== enrollment.coreAuthorizationRecordId ||
          factPayload.githubReconciliationRecordId !== enrollment.githubReconciliationRecordId ||
          factPayload.surfaceReconciliationRecordId !== enrollment.surfaceReconciliationRecordId ||
          factPayload.surfacePolicyDecisionRecordId !== enrollment.surfacePolicyDecisionRecordId ||
          factPayload.repositoryCommitId !== enrollment.repositoryCommitId ||
          factPayload.enrolledAt !== enrollment.enrolledAt
        ) {
          throw new Error(`repository enrollment receipt output mismatch: ${String(row.idempotency_key)}`);
        }
      }
      if (
        commandKind === "repository.impose-operator-hold" ||
        commandKind === "repository.clear-operator-hold"
      ) {
        const hold = parseRepositoryOperatorHoldResult(result);
        const outputs = this.db
          .prepare(
            `SELECT record_id, payload_json FROM durable_occurrences
             WHERE transaction_sequence = ? ORDER BY transaction_position`,
          )
          .all(row.transaction_sequence!) as Row[];
        const decisionPayload = outputs[0] ? parseJson(String(outputs[0].payload_json)) : undefined;
        const expectedKey = hold.choice === "impose"
          ? `repo-hold-impose:${hold.transactionSequence - 1}:${hold.repositoryId.slice("github.com:".length)}`
          : `repo-hold-clear:${hold.transactionSequence - 1}:${hold.holdDecisionId}`;
        if (
          hold.transactionSequence !== Number(row.transaction_sequence) ||
          hold.decidedAt !== String(transaction.evaluation_time) ||
          hold.decidedAt !== String(transaction.recorded_at) ||
          String(row.idempotency_key) !== expectedKey ||
          (commandKind === "repository.impose-operator-hold") !== (hold.choice === "impose") ||
          outputs.length !== 2 ||
          String(outputs[0]!.record_id) !== hold.decisionRecordId ||
          String(outputs[1]!.record_id) !== hold.eventRecordId ||
          !decisionPayload ||
          !recordKindRegistry["repository.operator-hold-decision"].validatePayload(decisionPayload) ||
          decisionPayload.repositoryId !== hold.repositoryId ||
          decisionPayload.coreSnapshotId !== hold.coreSnapshotId ||
          decisionPayload.coreAuthorizationRecordId !== hold.coreAuthorizationRecordId ||
          decisionPayload.operatorPrincipalId !== hold.operatorPrincipalId ||
          decisionPayload.holdDecisionId !== hold.holdDecisionId ||
          decisionPayload.choice !== hold.choice ||
          decisionPayload.reason !== hold.reason ||
          decisionPayload.decidedAt !== hold.decidedAt
        ) {
          throw new Error(`repository operator hold receipt output mismatch: ${String(row.idempotency_key)}`);
        }
      }
    }
  }

  private verifyProjectionCatalog(): void {
    const generations = this.db.prepare("SELECT * FROM projection_generations").all() as Row[];
    const generationById = new Map<string, ProjectionGeneration>();
    for (const row of generations) {
      const generation = decodeProjectionGeneration(row);
      const contract = projectionContractRegistry[generation.projectionName];
      if (!contract) throw new Error(`unknown projection name: ${String(row.projection_name)}`);
      if (
        generation.contractVersion !== contract.contractVersion ||
        generation.transformationVersion !== contract.transformationVersion ||
        generation.informationHandlingVersion !== contract.informationHandlingVersion
      ) {
        throw new Error(`unknown projection contract version: ${generation.projectionName}`);
      }
      if (generation.sourceSequence > this.metadata().lastTransactionSequence) {
        throw new Error(`projection source watermark is ahead of authoritative state: ${generation.projectionName}`);
      }
      generationById.set(generation.generationId, generation);
    }

    const heads = this.db.prepare("SELECT * FROM projection_heads ORDER BY projection_name").all() as Row[];
    const expected = Object.keys(projectionContractRegistry).sort();
    const actual = heads.map((row) => String(row.projection_name)).sort();
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
      throw new Error(`projection head registry mismatch (expected ${expected.join(", ")}; found ${actual.join(", ")})`);
    }
    for (const row of heads) {
      const projectionName = String(row.projection_name) as ProjectionName;
      const generation = generationById.get(String(row.generation_id));
      if (
        !generation ||
        generation.projectionName !== projectionName ||
        Number(row.contract_version) !== generation.contractVersion ||
        Number(row.source_sequence) !== generation.sourceSequence
      ) {
        throw new Error(`projection head lineage mismatch: ${projectionName}`);
      }
      assertUtcInstant(String(row.published_at), `projection ${projectionName} publication time`);
    }
  }

  private queryJsonRows(sql: string): JsonValue[] {
    return (this.db.prepare(sql).all() as Row[]).map(sqlRowJson);
  }

  private sqliteTransactionAllocation(): number {
    const row = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'control_transactions'").get() as
      | Row
      | undefined;
    const value = Number(row?.seq ?? 0);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid SQLite transaction allocation watermark");
    return value;
  }

  private quickCheck(): "ok" {
    const row = this.db.prepare("PRAGMA quick_check").get() as Row | undefined;
    if (String(row?.quick_check) !== "ok") throw new Error("control-plane SQLite integrity check failed");
    return "ok";
  }

  private assertNewArtifactPath(path: string, label: string): string {
    if (path === ":memory:") throw new Error(`${label} path must be a filesystem path`);
    const artifactPath = resolve(path);
    if (artifactPath === this.databasePath) throw new Error(`${label} path must differ from the live database path`);
    if (artifactPath === resolve(process.env.FLUENT_QUEUE_DB ?? "./data/queue.db")) {
      throw new Error(`${label} path must differ from the queue-spike path`);
    }
    if (existsSync(artifactPath)) throw new Error(`${label} path already exists: ${artifactPath}`);
    mkdirSync(dirname(artifactPath), { recursive: true });
    reserveArtifactPath(artifactPath, `${label} path`);
    return artifactPath;
  }

  private static inspectArtifact(path: string, createdAt: string): ControlPlaneBackupVerification {
    assertUtcInstant(createdAt, "backup creation time");
    const artifactPath = resolve(path);
    const store = new ControlPlaneStore(artifactPath);
    try {
      const quickCheck = store.quickCheck();
      const metadata = store.metadata();
      if (metadata.lastTransactionSequence >= Number.MAX_SAFE_INTEGER) {
        throw new Error("backup transaction sequence cannot allocate a safe next value");
      }
      const projectionHealth = store.projectionHealth();
      const unhealthy = projectionHealth.filter((health) => health.status === "invalid" || health.status === "unavailable");
      if (unhealthy.length > 0) {
        throw new Error(
          `backup contains unusable projections: ${unhealthy.map((health) => health.projectionName).join(", ")}`,
        );
      }
      return {
        manifest: {
          formatVersion: 1,
          backupPath: artifactPath,
          databaseLineageId: metadata.databaseLineageId,
          schemaVersion: metadata.schemaVersion,
          registryVersion: metadata.registryVersion,
          lastTransactionSequence: metadata.lastTransactionSequence,
          nextTransactionSequence: metadata.lastTransactionSequence + 1,
          controlTimeWatermark: metadata.controlTimeWatermark,
          authoritativeDigest: store.authoritativeDigest(),
          createdAt,
        },
        quickCheck,
        projectionHealth,
      };
    } finally {
      store.close();
    }
  }

  private applicationTables(): string[] {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Row[];
    return rows.map((row) => String(row.name));
  }

  private pragmaNumber(name: "application_id" | "user_version"): number {
    const row = this.db.prepare(`PRAGMA ${name}`).get() as Row | undefined;
    return Number(row?.[name] ?? 0);
  }

  private now(): string {
    const value = this.clock();
    if (Number.isNaN(value.getTime())) throw new Error("control-plane clock returned an invalid instant");
    return value.toISOString();
  }
}

function assertExpectedSequence(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("expectedLastTransactionSequence must be a positive safe integer");
  }
}

function assertCommandTimeAndSequence(
  metadata: ControlPlaneMetadata,
  evaluationTime: string,
  expectedLastTransactionSequence: number,
): void {
  if (evaluationTime < metadata.controlTimeWatermark) {
    throw new Error(
      `control-plane clock moved backwards behind ${metadata.controlTimeWatermark}; refusing a new write transaction`,
    );
  }
  if (metadata.lastTransactionSequence !== expectedLastTransactionSequence) {
    throw new Error(
      `stale control-plane sequence: expected ${expectedLastTransactionSequence}, current ${metadata.lastTransactionSequence}`,
    );
  }
}

type NormalizedRepositorySurfaceProbe =
  | { kind: "unavailable" }
  | {
      kind: "resolved";
      defaultBranch: string;
      repositoryCommitId: string;
      repositoryTreeId: string;
      surfaces: Array<
        | { surfaceId: string; path: string; kind: "missing" }
        | {
            surfaceId: string;
            path: string;
            kind: "found";
            mode: string;
            objectType: "blob" | "tree" | "commit";
            objectId: string;
            bytesBase64: string | null;
            treeEntries: RepositorySurfaceTreeEntry[] | null;
          }
      >;
    };

interface EvaluatedRepositorySurfaceProbe {
  defaultBranch: string | null;
  repositoryCommitId: string | null;
  repositoryTreeId: string | null;
  surfaces: RepositorySurfaceSummary[];
  governancePolicy: JsonValue | null;
  result: RepositorySurfaceResult;
  failedSurfaceId: RepositorySurfaceSummary["surfaceId"] | null;
}

function repositorySurfaceRequirementResults(
  contract: RepositorySurfaceContract,
  evaluation: EvaluatedRepositorySurfaceProbe,
): RepositorySurfaceRequirementResult[] {
  const failedIndex = evaluation.failedSurfaceId === null
    ? -1
    : contract.surfaces.findIndex((surface) => surface.id === evaluation.failedSurfaceId);
  return contract.surfaces.map((surface, index) => {
    const summary = evaluation.surfaces.find((candidate) => candidate.surfaceId === surface.id);
    const result: RepositorySurfaceRequirementResult["result"] =
      evaluation.result === "valid"
        ? "pass"
        : failedIndex < 0
          ? "unknown"
          : index < failedIndex
            ? "pass"
            : index === failedIndex
              ? "fail"
              : "unknown";
    return {
      requirementId: `canonical-surface:${surface.id}`,
      surfaceId: surface.id,
      result,
      evidenceDigest: result === "pass" || (result === "fail" && evaluation.result === "invalid")
        ? summary?.contentDigest ?? null
        : null,
    };
  });
}

function normalizeRepositorySurfaceProbe(input: RepositorySurfaceProbeInput): NormalizedRepositorySurfaceProbe {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("repository surface probe must be one typed object");
  }
  if (input.kind === "unavailable") {
    if (Object.keys(input).length !== 1) throw new Error("repository surface unavailable probe has extra fields");
    return { kind: "unavailable" };
  }
  if (
    input.kind !== "resolved" ||
    Object.keys(input).sort().join(",") !==
      "defaultBranch,kind,repositoryCommitId,repositoryTreeId,surfaces" ||
    !isRepositoryBranchName(input.defaultBranch) ||
    !/^[0-9a-f]{40}$/.test(input.repositoryCommitId) ||
    !/^[0-9a-f]{40}$/.test(input.repositoryTreeId) ||
    !Array.isArray(input.surfaces) ||
    input.surfaces.length > 4
  ) {
    throw new Error("repository surface resolved probe is invalid");
  }
  const identities = new Set<string>();
  const surfaces = input.surfaces.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("repository surface probe entry is invalid");
    }
    if (
      typeof entry.surfaceId !== "string" ||
      typeof entry.path !== "string" ||
      entry.path.length < 1 ||
      entry.path.length > 512 ||
      identities.has(entry.surfaceId)
    ) {
      throw new Error("repository surface probe entry identity is invalid");
    }
    identities.add(entry.surfaceId);
    if (entry.kind === "missing") {
      if (Object.keys(entry).sort().join(",") !== "kind,path,surfaceId") {
        throw new Error("repository surface missing probe has extra fields");
      }
      return { surfaceId: entry.surfaceId, path: entry.path, kind: "missing" as const };
    }
    if (
      entry.kind !== "found" ||
      Object.keys(entry).sort().join(",") !==
        "bytes,kind,mode,objectId,objectType,path,surfaceId,treeEntries" ||
      !["100644", "100755", "120000", "040000", "160000"].includes(entry.mode) ||
      (entry.objectType !== "blob" && entry.objectType !== "tree" && entry.objectType !== "commit") ||
      !/^[0-9a-f]{40}$/.test(entry.objectId) ||
      !(entry.bytes === null || entry.bytes instanceof Uint8Array) ||
      (entry.bytes instanceof Uint8Array && entry.bytes.byteLength > 1_048_576) ||
      !(entry.treeEntries === null || Array.isArray(entry.treeEntries))
    ) {
      throw new Error("repository surface found probe is invalid");
    }
    const treeEntries = entry.treeEntries === null ? null : normalizeRepositorySurfaceTreeEntries(entry.treeEntries);
    return {
      surfaceId: entry.surfaceId,
      path: entry.path,
      kind: "found" as const,
      mode: entry.mode,
      objectType: entry.objectType,
      objectId: entry.objectId,
      bytesBase64: entry.bytes === null ? null : Buffer.from(entry.bytes).toString("base64"),
      treeEntries,
    };
  });
  return {
    kind: "resolved",
    defaultBranch: input.defaultBranch,
    repositoryCommitId: input.repositoryCommitId,
    repositoryTreeId: input.repositoryTreeId,
    surfaces,
  };
}

function normalizeRepositorySurfaceTreeEntries(
  input: readonly RepositorySurfaceTreeEntry[],
): RepositorySurfaceTreeEntry[] {
  if (input.length > 2_000) throw new Error("repository surface tree listing exceeds the entry bound");
  const paths = new Set<string>();
  return input
    .map((entry) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        Object.keys(entry).sort().join(",") !== "mode,objectId,path,size,type" ||
        typeof entry.path !== "string" ||
        !/^[^/\u0000]{1,255}$/.test(entry.path) ||
        paths.has(entry.path) ||
        !["100644", "100755", "120000", "040000", "160000"].includes(entry.mode) ||
        (entry.type !== "blob" && entry.type !== "tree" && entry.type !== "commit") ||
        !/^[0-9a-f]{40}$/.test(entry.objectId) ||
        !(entry.size === null || (Number.isSafeInteger(entry.size) && entry.size >= 0))
      ) {
        throw new Error("repository surface tree entry is invalid");
      }
      paths.add(entry.path);
      return { ...entry };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function evaluateRepositorySurfaceProbe(
  probe: NormalizedRepositorySurfaceProbe,
  expectedDefaultBranch: string,
  contract: RepositorySurfaceContract,
): EvaluatedRepositorySurfaceProbe {
  if (probe.kind === "unavailable") {
    return {
      defaultBranch: null,
      repositoryCommitId: null,
      repositoryTreeId: null,
      surfaces: [],
      governancePolicy: null,
      result: "unavailable",
      failedSurfaceId: null,
    };
  }
  if (probe.defaultBranch !== expectedDefaultBranch) {
    throw new Error("repository surface probe default branch differs from the matched identity fact");
  }
  const summaries: RepositorySurfaceSummary[] = [];
  let governancePolicy: JsonValue | null = null;
  for (const expected of contract.surfaces) {
    const entry = probe.surfaces.find((candidate) => candidate.surfaceId === expected.id);
    if (!entry || entry.path !== expected.path || entry.kind === "missing") {
      return surfaceFailure(probe, summaries, "missing", expected.id);
    }
    const file = expected.artifact_type === "file";
    if (
      (file && (entry.objectType !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755") || entry.bytesBase64 === null || entry.treeEntries !== null)) ||
      (!file && (entry.objectType !== "tree" || entry.mode !== "040000" || entry.bytesBase64 !== null || entry.treeEntries === null))
    ) {
      return surfaceFailure(probe, summaries, "wrong-type", expected.id);
    }
    if (file) {
      const bytes = Buffer.from(entry.bytesBase64!, "base64");
      if (repositoryGitBlobObjectId(bytes) !== entry.objectId) {
        throw new Error(`repository surface blob identity mismatch: ${expected.id}`);
      }
      const summary = {
        surfaceId: expected.id,
        path: expected.path,
        artifactType: "file" as const,
        objectId: entry.objectId,
        contentDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        size: bytes.byteLength,
      } satisfies RepositorySurfaceSummary;
      summaries.push(summary);
      if (expected.id === "agent-governance") {
        try {
          governancePolicy = validateRepositoryGovernanceBytes(bytes);
        } catch {
          return surfaceFailure(probe, summaries, "invalid", expected.id);
        }
      }
      continue;
    }
    if (repositoryGitTreeObjectId(entry.treeEntries!) !== entry.objectId) {
      throw new Error(`repository surface tree identity mismatch: ${expected.id}`);
    }
    summaries.push({
      surfaceId: expected.id,
      path: expected.path,
      artifactType: "directory",
      objectId: entry.objectId,
      contentDigest: surfaceTreeDigest(entry.treeEntries!),
      size: entry.treeEntries!.length,
    });
  }
  if (probe.surfaces.length !== contract.surfaces.length || governancePolicy === null) {
    throw new Error("repository surface probe contains unknown or incomplete entries");
  }
  return {
    defaultBranch: probe.defaultBranch,
    repositoryCommitId: probe.repositoryCommitId,
    repositoryTreeId: probe.repositoryTreeId,
    surfaces: summaries,
    governancePolicy,
    result: "valid",
    failedSurfaceId: null,
  };
}

function surfaceFailure(
  probe: Extract<NormalizedRepositorySurfaceProbe, { kind: "resolved" }>,
  surfaces: RepositorySurfaceSummary[],
  result: "missing" | "wrong-type" | "invalid",
  failedSurfaceId: RepositorySurfaceSummary["surfaceId"],
): EvaluatedRepositorySurfaceProbe {
  return {
    defaultBranch: probe.defaultBranch,
    repositoryCommitId: probe.repositoryCommitId,
    repositoryTreeId: probe.repositoryTreeId,
    surfaces,
    governancePolicy: null,
    result,
    failedSurfaceId,
  };
}

function normalizeRepositoryGitHubInspection(
  input: RepositoryGitHubInspectionInput,
): RepositoryGitHubInspectionInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("repository GitHub inspection must be one typed object");
  }
  if (input.kind === "missing" || input.kind === "unavailable") {
    if (Object.keys(input).length !== 1) throw new Error("repository GitHub absence result has extra fields");
    return { kind: input.kind };
  }
  if (
    input.kind !== "found" ||
    Object.keys(input).sort().join(",") !== "archived,defaultBranch,kind,name,owner,repositoryId" ||
    typeof input.repositoryId !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(input.repositoryId) ||
    typeof input.owner !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(input.owner) ||
    typeof input.name !== "string" ||
    !/^[A-Za-z0-9._-]{1,100}$/.test(input.name) ||
    typeof input.archived !== "boolean" ||
    !isRepositoryBranchName(input.defaultBranch)
  ) {
    throw new Error("repository GitHub found result is invalid");
  }
  return {
    kind: "found",
    repositoryId: input.repositoryId,
    owner: input.owner,
    name: input.name,
    archived: input.archived,
    defaultBranch: input.defaultBranch,
  };
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

function classifyRepositoryGitHubInspection(
  authority: RepositoryCoreAuthorityPayload,
  inspection: RepositoryGitHubInspectionInput,
): RepositoryGitHubResult {
  if (inspection.kind === "missing" || inspection.kind === "unavailable") return inspection.kind;
  if (inspection.repositoryId !== authority.repositoryId.slice("github.com:".length)) return "identity-mismatch";
  if (
    inspection.owner.toLowerCase() !== authority.owner.toLowerCase() ||
    inspection.name.toLowerCase() !== authority.name.toLowerCase()
  ) {
    return "locator-mismatch";
  }
  if (inspection.archived) return "archived";
  return "matched";
}

function repositoryIdentityState(
  fleetState: RepositoryCoreAuthorityPayload["fleetState"],
  result: RepositoryGitHubResult,
): RepositoryState {
  if (fleetState === "disabled") return "disabled";
  if (fleetState === "paused") return "paused";
  return result === "matched" ? "awaiting-surfaces" : "github-held";
}

function isExactJsonObject(value: JsonValue, keys: readonly string[]): value is { [key: string]: JsonValue } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseRepositoryCoreAuthorityResult(value: JsonValue): RepositoryCoreAuthorityResult {
  if (
    !isExactJsonObject(value, [
      "repositoryId",
      "coreSnapshotId",
      "declarationRecordId",
      "coreAuthorizationRecordId",
      "eventRecordId",
      "authorizedAt",
      "transactionPositions",
      "transactionSequence",
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
    typeof value.authorizedAt !== "string" ||
    !Array.isArray(value.transactionPositions) ||
    canonicalJson(value.transactionPositions) !== "[0,1,2]" ||
    !Number.isSafeInteger(value.transactionSequence) ||
    Number(value.transactionSequence) < 1
  ) {
    throw new Error("invalid repository Core authority receipt result");
  }
  assertUtcInstant(value.authorizedAt, "repository Core authority time");
  return value as unknown as RepositoryCoreAuthorityResult;
}

function parseRepositoryGitHubReconciliationResult(value: JsonValue): RepositoryGitHubReconciliationResult {
  if (
    !isExactJsonObject(value, [
      "repositoryId",
      "coreSnapshotId",
      "coreAuthorizationRecordId",
      "observationRecordId",
      "reconciliationRecordId",
      "eventRecordId",
      "result",
      "effectiveState",
      "checkedAt",
      "responseDigest",
      "transactionPositions",
      "transactionSequence",
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
    !(["matched", "missing", "locator-mismatch", "identity-mismatch", "archived", "unavailable"] as const).includes(
      value.result as RepositoryGitHubResult,
    ) ||
    (value.effectiveState !== "disabled" &&
      value.effectiveState !== "paused" &&
      value.effectiveState !== "github-held" &&
      value.effectiveState !== "awaiting-surfaces") ||
    typeof value.checkedAt !== "string" ||
    typeof value.responseDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.responseDigest) ||
    !Array.isArray(value.transactionPositions) ||
    canonicalJson(value.transactionPositions) !== "[0,1,2]" ||
    !Number.isSafeInteger(value.transactionSequence) ||
    Number(value.transactionSequence) < 1
  ) {
    throw new Error("invalid repository GitHub reconciliation receipt result");
  }
  assertUtcInstant(value.checkedAt, "repository GitHub reconciliation time");
  return value as unknown as RepositoryGitHubReconciliationResult;
}

function repositoryGitHubResultFromPayload(
  payload: RepositoryGitHubReconciliationPayload,
  transactionSequence: number,
): RepositoryGitHubReconciliationResult {
  return {
    repositoryId: payload.repositoryId,
    coreSnapshotId: payload.coreSnapshotId,
    coreAuthorizationRecordId: payload.coreAuthorizationRecordId,
    observationRecordId: payload.observationRecordId,
    reconciliationRecordId: payload.reconciliationRecordId,
    eventRecordId: payload.eventRecordId,
    result: payload.result,
    effectiveState: payload.effectiveState,
    checkedAt: payload.checkedAt,
    responseDigest: payload.responseDigest,
    transactionPositions: [0, 1, 2],
    transactionSequence,
  };
}

function parseRepositorySurfaceReconciliationResult(value: JsonValue): RepositorySurfaceReconciliationResult {
  if (
    !isExactJsonObject(value, [
      "repositoryId",
      "coreSnapshotId",
      "coreAuthorizationRecordId",
      "githubReconciliationRecordId",
      "observationRecordId",
      "policyDecisionRecordId",
      "reconciliationRecordId",
      "eventRecordId",
      "result",
      "repositoryCommitId",
      "checkedAt",
      "probeDigest",
      "transactionPositions",
      "transactionSequence",
    ]) ||
    typeof value.repositoryId !== "string" ||
    !/^github\.com:[1-9][0-9]{0,19}$/.test(value.repositoryId) ||
    typeof value.coreSnapshotId !== "string" ||
    !isUuidV7(value.coreSnapshotId) ||
    typeof value.coreAuthorizationRecordId !== "string" ||
    !isUuidV7(value.coreAuthorizationRecordId) ||
    typeof value.githubReconciliationRecordId !== "string" ||
    !isUuidV7(value.githubReconciliationRecordId) ||
    typeof value.observationRecordId !== "string" ||
    !isUuidV7(value.observationRecordId) ||
    typeof value.policyDecisionRecordId !== "string" ||
    !isUuidV7(value.policyDecisionRecordId) ||
    typeof value.reconciliationRecordId !== "string" ||
    !isUuidV7(value.reconciliationRecordId) ||
    typeof value.eventRecordId !== "string" ||
    !isUuidV7(value.eventRecordId) ||
    !(value.repositoryCommitId === null || (typeof value.repositoryCommitId === "string" && /^[0-9a-f]{40}$/.test(value.repositoryCommitId))) ||
    !(value.result === "valid" || value.result === "unavailable" || value.result === "missing" || value.result === "wrong-type" || value.result === "invalid" || value.result === "digest-incompatible") ||
    typeof value.checkedAt !== "string" ||
    typeof value.probeDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.probeDigest) ||
    !Array.isArray(value.transactionPositions) ||
    canonicalJson(value.transactionPositions) !== "[0,1,2,3]" ||
    !Number.isSafeInteger(value.transactionSequence) ||
    Number(value.transactionSequence) < 1
  ) {
    throw new Error("invalid repository surface reconciliation receipt result");
  }
  assertUtcInstant(value.checkedAt, "repository surface reconciliation time");
  return value as unknown as RepositorySurfaceReconciliationResult;
}

function repositorySurfaceResultFromPayload(
  payload: RepositorySurfaceReconciliationPayload,
  transactionSequence: number,
): RepositorySurfaceReconciliationResult {
  return {
    repositoryId: payload.repositoryId,
    coreSnapshotId: payload.coreSnapshotId,
    coreAuthorizationRecordId: payload.coreAuthorizationRecordId,
    githubReconciliationRecordId: payload.githubReconciliationRecordId,
    observationRecordId: payload.observationRecordId,
    policyDecisionRecordId: payload.policyDecisionRecordId,
    reconciliationRecordId: payload.reconciliationRecordId,
    eventRecordId: payload.eventRecordId,
    result: payload.result,
    repositoryCommitId: payload.repositoryCommitId,
    checkedAt: payload.checkedAt,
    probeDigest: payload.probeDigest,
    transactionPositions: [0, 1, 2, 3],
    transactionSequence,
  };
}

function parseRepositoryEnrollmentResult(value: JsonValue): RepositoryEnrollmentResult {
  if (
    !isExactJsonObject(value, [
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
      "enrolledAt",
      "transactionPositions",
      "transactionSequence",
    ]) ||
    typeof value.repositoryId !== "string" ||
    !/^github\.com:[1-9][0-9]{0,19}$/.test(value.repositoryId) ||
    typeof value.coreSnapshotId !== "string" ||
    !isUuidV7(value.coreSnapshotId) ||
    typeof value.coreAuthorizationRecordId !== "string" ||
    !isUuidV7(value.coreAuthorizationRecordId) ||
    typeof value.githubReconciliationRecordId !== "string" ||
    !isUuidV7(value.githubReconciliationRecordId) ||
    typeof value.surfaceReconciliationRecordId !== "string" ||
    !isUuidV7(value.surfaceReconciliationRecordId) ||
    typeof value.surfacePolicyDecisionRecordId !== "string" ||
    !isUuidV7(value.surfacePolicyDecisionRecordId) ||
    typeof value.controllerDefinitionRecordId !== "string" ||
    !isUuidV7(value.controllerDefinitionRecordId) ||
    typeof value.enrollmentRecordId !== "string" ||
    !isUuidV7(value.enrollmentRecordId) ||
    typeof value.eventRecordId !== "string" ||
    !isUuidV7(value.eventRecordId) ||
    typeof value.repositoryCommitId !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.repositoryCommitId) ||
    typeof value.enrolledAt !== "string" ||
    !Array.isArray(value.transactionPositions) ||
    canonicalJson(value.transactionPositions) !== "[0,1,2]" ||
    !Number.isSafeInteger(value.transactionSequence) ||
    Number(value.transactionSequence) < 1
  ) {
    throw new Error("invalid repository enrollment receipt result");
  }
  assertUtcInstant(value.enrolledAt, "repository enrollment time");
  return value as unknown as RepositoryEnrollmentResult;
}

function parseRepositoryOperatorHoldResult(value: JsonValue): RepositoryOperatorHoldResult {
  if (
    !isExactJsonObject(value, [
      "decisionRecordId",
      "eventRecordId",
      "repositoryId",
      "coreSnapshotId",
      "coreAuthorizationRecordId",
      "operatorPrincipalId",
      "holdDecisionId",
      "choice",
      "reason",
      "decidedAt",
      "transactionPositions",
      "transactionSequence",
    ]) ||
    typeof value.decisionRecordId !== "string" ||
    !isUuidV7(value.decisionRecordId) ||
    typeof value.eventRecordId !== "string" ||
    !isUuidV7(value.eventRecordId) ||
    typeof value.repositoryId !== "string" ||
    !/^github\.com:[1-9][0-9]{0,19}$/.test(value.repositoryId) ||
    typeof value.coreSnapshotId !== "string" ||
    !isUuidV7(value.coreSnapshotId) ||
    typeof value.coreAuthorizationRecordId !== "string" ||
    !isUuidV7(value.coreAuthorizationRecordId) ||
    typeof value.operatorPrincipalId !== "string" ||
    !isUuidV7(value.operatorPrincipalId) ||
    typeof value.holdDecisionId !== "string" ||
    !isUuidV7(value.holdDecisionId) ||
    (value.choice !== "impose" && value.choice !== "clear") ||
    typeof value.reason !== "string" ||
    typeof value.decidedAt !== "string" ||
    !Array.isArray(value.transactionPositions) ||
    canonicalJson(value.transactionPositions) !== "[0,1]" ||
    !Number.isSafeInteger(value.transactionSequence) ||
    Number(value.transactionSequence) < 1
  ) {
    throw new Error("invalid repository operator hold receipt result");
  }
  assertBoundedReason(value.reason, "repository operator hold result reason");
  assertUtcInstant(value.decidedAt, "repository operator hold decision time");
  return value as unknown as RepositoryOperatorHoldResult;
}

function assertCorePollInterval(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < CORE_POLL_MINIMUM_INTERVAL_SECONDS ||
    value > CORE_POLL_MAXIMUM_INTERVAL_SECONDS
  ) {
    throw new Error(
      `Core poll interval must be from ${CORE_POLL_MINIMUM_INTERVAL_SECONDS} through ${CORE_POLL_MAXIMUM_INTERVAL_SECONDS} seconds`,
    );
  }
}

function decodeCorePollState(row: Row): CorePollState {
  const healthyIntervalSeconds = Number(row.healthy_interval_seconds);
  const sourceUnavailableStreak = Number(row.source_unavailable_streak);
  const completedRunCount = Number(row.completed_run_count);
  const suppressedCheckCount = Number(row.suppressed_check_count);
  assertCorePollInterval(healthyIntervalSeconds);
  if (Number(row.schedule_version) !== 1) throw new Error("unknown Core poll schedule version");
  if (!Number.isSafeInteger(sourceUnavailableStreak) || sourceUnavailableStreak < 0) {
    throw new Error("invalid Core poll source-unavailable streak");
  }
  if (
    !Number.isSafeInteger(completedRunCount) ||
    completedRunCount < 0 ||
    !Number.isSafeInteger(suppressedCheckCount) ||
    suppressedCheckCount < 0 ||
    suppressedCheckCount > completedRunCount
  ) {
    throw new Error("invalid Core poll operational counters");
  }
  const nextPollAt = String(row.next_poll_at);
  const nextPruneAt = String(row.next_prune_at);
  assertUtcInstant(nextPollAt, "Core next poll time");
  assertUtcInstant(nextPruneAt, "Core next prune time");

  const inFlightRunId = row.in_flight_run_id === null ? null : String(row.in_flight_run_id);
  const inFlightStartedAt = row.in_flight_started_at === null ? null : String(row.in_flight_started_at);
  const inFlightExpiresAt = row.in_flight_expires_at === null ? null : String(row.in_flight_expires_at);
  const inFlightValues = [inFlightRunId, inFlightStartedAt, inFlightExpiresAt];
  if (inFlightValues.some((value) => value === null) !== inFlightValues.every((value) => value === null)) {
    throw new Error("Core poll lease fields must be null or present together");
  }
  if (inFlightRunId !== null && inFlightStartedAt !== null && inFlightExpiresAt !== null) {
    if (!isUuidV7(inFlightRunId)) throw new Error("Core poll lease run ID is not UUIDv7");
    assertUtcInstant(inFlightStartedAt, "Core poll lease start");
    assertUtcInstant(inFlightExpiresAt, "Core poll lease expiry");
    if (addSeconds(inFlightStartedAt, CORE_POLL_LEASE_SECONDS) !== inFlightExpiresAt) {
      throw new Error("Core poll lease duration is not ten minutes");
    }
  }

  const lastRunId = row.last_run_id === null ? null : String(row.last_run_id);
  const lastStartedAt = row.last_started_at === null ? null : String(row.last_started_at);
  const lastCompletedAt = row.last_completed_at === null ? null : String(row.last_completed_at);
  const lastRunStatus = row.last_run_status === null ? null : String(row.last_run_status);
  const lastSourceOutcome = row.last_source_outcome === null ? null : String(row.last_source_outcome);
  const lastCheckDisposition = row.last_check_disposition === null ? null : String(row.last_check_disposition);
  const lastValues = [lastRunId, lastStartedAt, lastCompletedAt, lastRunStatus, lastCheckDisposition];
  if (completedRunCount === 0) {
    if (lastValues.some((value) => value !== null) || lastSourceOutcome !== null) {
      throw new Error("Core poll state has last-run fields before a completion");
    }
  } else {
    if (lastValues.some((value) => value === null) || lastRunId === null || lastStartedAt === null || lastCompletedAt === null) {
      throw new Error("Core poll state is missing completed-run fields");
    }
    if (!isUuidV7(lastRunId)) throw new Error("Core last poll run ID is not UUIDv7");
    assertUtcInstant(lastStartedAt, "Core last poll start");
    assertUtcInstant(lastCompletedAt, "Core last poll completion");
    if (lastCompletedAt < lastStartedAt) throw new Error("Core poll completion predates its start");
    if (lastRunStatus !== "completed" && lastRunStatus !== "controller-error") {
      throw new Error("unknown Core poll completion status");
    }
    if (
      lastSourceOutcome !== null &&
      !(["eligible", "source-unavailable", "candidate-invalid", "continuity-blocked", "persistence-failed"] as const)
        .includes(lastSourceOutcome as CoreSourceCheckOutcome)
    ) {
      throw new Error("unknown Core poll source outcome");
    }
    if (
      lastCheckDisposition !== "recorded" &&
      lastCheckDisposition !== "suppressed" &&
      lastCheckDisposition !== "record-failed" &&
      lastCheckDisposition !== "none"
    ) {
      throw new Error("unknown Core poll check disposition");
    }
    if (
      (lastSourceOutcome === null && lastCheckDisposition !== "none") ||
      (lastSourceOutcome !== null && lastCheckDisposition === "none") ||
      (lastRunStatus === "completed" && lastSourceOutcome === null)
    ) {
      throw new Error("Core poll completion source/disposition linkage is invalid");
    }
  }

  return {
    scheduleVersion: 1,
    healthyIntervalSeconds,
    nextPollAt,
    nextPruneAt,
    sourceUnavailableStreak,
    inFlightRunId,
    inFlightStartedAt,
    inFlightExpiresAt,
    lastRunId,
    lastStartedAt,
    lastCompletedAt,
    lastRunStatus: lastRunStatus as CorePollRunStatus | null,
    lastSourceOutcome: lastSourceOutcome as CoreSourceCheckOutcome | null,
    lastCheckDisposition: lastCheckDisposition as CorePollCheckDisposition | null,
    completedRunCount,
    suppressedCheckCount,
  };
}

function sqlRowJson(row: Row): JsonValue {
  const result: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || typeof value === "string") {
      result[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = value;
    } else if (typeof value === "bigint" && value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER) {
      result[key] = Number(value);
    } else {
      throw new Error(`authoritative digest cannot encode SQL value in column ${key}`);
    }
  }
  return result;
}

function reserveArtifactPath(path: string, label: string): void {
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} could not be reserved without overwrite: ${detail}`);
  }
}

function assertBackupExpectation(expectation: {
  databaseLineageId: string;
  minimumLastTransactionSequence: number;
}): void {
  if (!isUuidV7(expectation.databaseLineageId)) throw new Error("expected backup lineage must be a UUIDv7 identity");
  if (
    !Number.isSafeInteger(expectation.minimumLastTransactionSequence) ||
    expectation.minimumLastTransactionSequence < 1
  ) {
    throw new Error("minimumLastTransactionSequence must be a positive safe integer");
  }
}

function assertBackupManifest(manifest: ControlPlaneBackupManifest): void {
  const keys = Object.keys(manifest).sort();
  const expected = [
    "authoritativeDigest",
    "backupPath",
    "controlTimeWatermark",
    "createdAt",
    "databaseLineageId",
    "formatVersion",
    "lastTransactionSequence",
    "nextTransactionSequence",
    "registryVersion",
    "schemaVersion",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("backup manifest fields are invalid");
  }
  if (
    manifest.formatVersion !== 1 ||
    manifest.schemaVersion !== CONTROL_PLANE_SCHEMA_VERSION ||
    manifest.registryVersion !== CONTROL_PLANE_REGISTRY_VERSION ||
    !isUuidV7(manifest.databaseLineageId) ||
    !Number.isSafeInteger(manifest.lastTransactionSequence) ||
    manifest.lastTransactionSequence < 1 ||
    manifest.nextTransactionSequence !== manifest.lastTransactionSequence + 1 ||
    !/^sha256:[0-9a-f]{64}$/.test(manifest.authoritativeDigest) ||
    manifest.backupPath === ":memory:" ||
    resolve(manifest.backupPath) !== manifest.backupPath
  ) {
    throw new Error("backup manifest values are invalid");
  }
  assertUtcInstant(manifest.controlTimeWatermark, "backup control-time watermark");
  assertUtcInstant(manifest.createdAt, "backup creation time");
}

function assertBackupContentMatches(
  actual: ControlPlaneBackupManifest,
  expected: ControlPlaneBackupManifest,
  comparePath = true,
): void {
  const fields: Array<keyof ControlPlaneBackupManifest> = [
    "formatVersion",
    "databaseLineageId",
    "schemaVersion",
    "registryVersion",
    "lastTransactionSequence",
    "nextTransactionSequence",
    "controlTimeWatermark",
    "authoritativeDigest",
    "createdAt",
  ];
  if (comparePath) fields.push("backupPath");
  const mismatch = fields.find((field) => actual[field] !== expected[field]);
  if (mismatch) throw new Error(`backup manifest does not match database content: ${mismatch}`);
}

function decodeProjectionGeneration(row: Row): ProjectionGeneration {
  const projectionName = String(row.projection_name);
  if (!(projectionName in projectionContractRegistry)) throw new Error(`unknown projection name: ${projectionName}`);
  const generationId = String(row.generation_id);
  if (!isUuidV7(generationId)) throw new Error(`projection generation ID is not UUIDv7: ${projectionName}`);
  const contractVersion = Number(row.contract_version);
  const transformationVersion = Number(row.transformation_version);
  const informationHandlingVersion = Number(row.information_handling_version);
  const sourceSequence = Number(row.source_sequence);
  const rowCount = Number(row.row_count);
  if (
    !Number.isSafeInteger(contractVersion) ||
    contractVersion < 1 ||
    !Number.isSafeInteger(transformationVersion) ||
    transformationVersion < 1 ||
    !Number.isSafeInteger(informationHandlingVersion) ||
    informationHandlingVersion < 1 ||
    !Number.isSafeInteger(sourceSequence) ||
    sourceSequence < 1 ||
    !Number.isSafeInteger(rowCount) ||
    rowCount < 0
  ) {
    throw new Error(`projection generation has invalid numeric metadata: ${projectionName}`);
  }
  const sourceDigest = String(row.source_digest);
  const outputDigest = String(row.output_digest);
  if (!/^sha256:[0-9a-f]{64}$/.test(sourceDigest) || !/^sha256:[0-9a-f]{64}$/.test(outputDigest)) {
    throw new Error(`projection generation has invalid digest metadata: ${projectionName}`);
  }
  const evaluationTime = String(row.evaluation_time);
  const builtAt = String(row.built_at);
  assertUtcInstant(evaluationTime, `projection ${projectionName} evaluation time`);
  assertUtcInstant(builtAt, `projection ${projectionName} build time`);
  if (evaluationTime !== builtAt) throw new Error(`projection ${projectionName} evaluation and build times differ`);
  if (row.invariant_result !== "ok") throw new Error(`projection ${projectionName} has an invalid invariant result`);
  return {
    projectionName: projectionName as ProjectionName,
    generationId,
    contractVersion,
    transformationVersion,
    informationHandlingVersion,
    sourceSequence,
    sourceDigest,
    outputDigest,
    evaluationTime,
    builtAt,
    rowCount,
    invariantResult: "ok",
  };
}

function subjectProjectionSourceJson(row: Row): JsonValue {
  return {
    createdTransactionSequence: Number(row.created_transaction_sequence),
    definitionKind: String(row.definition_kind),
    definitionPayloadDigest: String(row.definition_payload_digest),
    definitionRecordId: String(row.definition_record_id),
    definitionSchemaVersion: Number(row.definition_schema_version),
    informationClass: String(row.information_class),
    informationScope: parseJson(String(row.information_scope_json)),
    subjectId: String(row.subject_id),
    subjectKind: String(row.subject_kind),
  };
}

function subjectProjectionOutputJson(row: Row): JsonValue {
  return {
    createdTransactionSequence: Number(row.created_transaction_sequence),
    definitionRecordId: String(row.definition_record_id),
    informationClass: String(row.information_class),
    informationScope: parseJson(String(row.information_scope_json)),
    subjectId: String(row.subject_id),
    subjectKind: String(row.subject_kind),
  };
}

function subjectProjectionStoredOutputJson(row: Row): JsonValue {
  return {
    createdTransactionSequence: Number(row.created_transaction_sequence),
    definitionRecordId: String(row.definition_record_id),
    informationClass: String(row.information_class),
    informationScope: parseJson(String(row.information_scope_json)),
    subjectId: String(row.subject_id),
    subjectKind: String(row.subject_kind),
  };
}

function eventProjectionSourceJson(row: Row): JsonValue {
  return {
    correlationId: String(row.correlation_id),
    informationClass: String(row.information_class),
    informationScope: parseJson(String(row.information_scope_json)),
    kind: String(row.kind),
    payloadDigest: String(row.payload_digest),
    recordId: String(row.record_id),
    recordedAt: String(row.recorded_at),
    schemaVersion: Number(row.schema_version),
    subjectId: String(row.subject_id),
    subjectKind: String(row.subject_kind),
    transactionPosition: Number(row.transaction_position),
    transactionSequence: Number(row.transaction_sequence),
  };
}

function eventProjectionOutputJson(row: Row): JsonValue {
  const source = eventProjectionSourceJson(row) as Record<string, JsonValue>;
  const { payloadDigest: _payloadDigest, ...output } = source;
  return output;
}

function eventProjectionStoredOutputJson(row: Row): JsonValue {
  return {
    correlationId: String(row.correlation_id),
    informationClass: String(row.information_class),
    informationScope: parseJson(String(row.information_scope_json)),
    kind: String(row.kind),
    recordId: String(row.record_id),
    recordedAt: String(row.recorded_at),
    schemaVersion: Number(row.schema_version),
    subjectId: String(row.subject_id),
    subjectKind: String(row.subject_kind),
    transactionPosition: Number(row.transaction_position),
    transactionSequence: Number(row.transaction_sequence),
  };
}

function decodeProjectedSubject(row: Row): ProjectedSubject {
  const informationClass = String(row.current_information_class);
  assertInformationClass(informationClass);
  return {
    subjectKind: String(row.subject_kind),
    subjectId: String(row.subject_id),
    createdTransactionSequence: Number(row.created_transaction_sequence),
    definitionRecordId: String(row.definition_record_id),
    informationClass,
    informationScope: parseJson(String(row.current_information_scope_json)),
  };
}

function decodeProjectedEvent(row: Row): ProjectedEvent {
  const informationClass = String(row.current_information_class);
  assertInformationClass(informationClass);
  return {
    recordId: String(row.record_id),
    kind: String(row.kind),
    schemaVersion: Number(row.schema_version),
    subjectKind: String(row.subject_kind),
    subjectId: String(row.subject_id),
    correlationId: String(row.correlation_id),
    informationClass,
    informationScope: parseJson(String(row.current_information_scope_json)),
    transactionSequence: Number(row.transaction_sequence),
    transactionPosition: Number(row.transaction_position),
    recordedAt: String(row.recorded_at),
  };
}

function isExactDeploymentScope(value: JsonValue): value is { deploymentId: string } {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof value.deploymentId === "string" &&
    isUuidV7(value.deploymentId)
  );
}

function parseJson(value: string): JsonValue {
  const parsed: unknown = JSON.parse(value);
  if (!isJsonValue(parsed)) throw new Error("stored payload is not JSON");
  return parsed;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function decodeOccurrence(row: Row): DurableOccurrence {
  const informationClass = String(row.information_class);
  assertInformationClass(informationClass);
  const recordClass = row.record_class == null ? undefined : String(row.record_class);
  if (recordClass !== undefined && !recordClasses.includes(recordClass as RecordClass)) {
    throw new Error(`unknown record class: ${recordClass}`);
  }
  return {
    recordId: String(row.record_id),
    occurrenceType: String(row.occurrence_type) as "record" | "event",
    kind: String(row.kind),
    schemaVersion: Number(row.schema_version),
    recordClass: recordClass as RecordClass | undefined,
    subjectKind: String(row.subject_kind),
    subjectId: String(row.subject_id),
    revisionKind: row.revision_kind == null ? undefined : String(row.revision_kind),
    revisionValue: row.revision_value == null ? undefined : String(row.revision_value),
    sourceKind: String(row.source_kind),
    sourceId: String(row.source_id),
    sourceRevisionKind: row.source_revision_kind == null ? undefined : String(row.source_revision_kind),
    sourceRevisionValue: row.source_revision_value == null ? undefined : String(row.source_revision_value),
    informationClass,
    informationScope: parseJson(String(row.information_scope_json)),
    payload: parseJson(String(row.payload_json)),
    payloadDigest: String(row.payload_digest),
    correlationId: String(row.correlation_id),
    transactionSequence: Number(row.transaction_sequence),
    transactionPosition: Number(row.transaction_position),
    recordedAt: String(row.recorded_at),
  };
}

function assertUtcInstant(value: string, label: string): void {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`${label} is not canonical UTC`);
}

function parseIntegrityCheckResult(value: JsonValue): IntegrityCheckResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid integrity-check receipt result");
  const result = value as Record<string, JsonValue>;
  const keys = Object.keys(result).sort();
  const expected = [
    "checkedThroughSequence",
    "evaluationTime",
    "eventRecordId",
    "observationRecordId",
    "recordedTime",
    "result",
    "transactionPositions",
    "transactionSequence",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("invalid integrity-check receipt result fields");
  }
  if (
    !Number.isSafeInteger(result.checkedThroughSequence) ||
    Number(result.checkedThroughSequence) < 1 ||
    !isUuidV7(String(result.eventRecordId)) ||
    !isUuidV7(String(result.observationRecordId)) ||
    result.result !== "ok" ||
    !Array.isArray(result.transactionPositions) ||
    result.transactionPositions.length !== 2 ||
    result.transactionPositions[0] !== 0 ||
    result.transactionPositions[1] !== 1 ||
    !Number.isSafeInteger(result.transactionSequence) ||
    Number(result.transactionSequence) < 2
  ) {
    throw new Error("invalid integrity-check receipt result values");
  }
  assertUtcInstant(String(result.evaluationTime), "integrity-check evaluation time");
  assertUtcInstant(String(result.recordedTime), "integrity-check recorded time");
  return {
    checkedThroughSequence: Number(result.checkedThroughSequence),
    eventRecordId: String(result.eventRecordId),
    evaluationTime: String(result.evaluationTime),
    observationRecordId: String(result.observationRecordId),
    recordedTime: String(result.recordedTime),
    result: "ok",
    transactionPositions: [0, 1],
    transactionSequence: Number(result.transactionSequence),
  };
}

function parseCoreSnapshotActivationResult(value: JsonValue): CoreSnapshotActivationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Core snapshot activation receipt result");
  }
  const result = value as Record<string, JsonValue>;
  const expected = [
    "snapshotId",
    "definitionRecordId",
    "activeFactRecordId",
    "eventRecordId",
    "catalogDigest",
    "sourceCommitId",
    "importedAt",
    "transactionPositions",
    "transactionSequence",
  ].sort();
  const keys = Object.keys(result).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("invalid Core snapshot activation receipt result fields");
  }
  if (
    !isUuidV7(String(result.snapshotId)) ||
    !isUuidV7(String(result.definitionRecordId)) ||
    !isUuidV7(String(result.activeFactRecordId)) ||
    !isUuidV7(String(result.eventRecordId)) ||
    !/^sha256:[0-9a-f]{64}$/.test(String(result.catalogDigest)) ||
    !/^[0-9a-f]{40}$/.test(String(result.sourceCommitId)) ||
    !Array.isArray(result.transactionPositions) ||
    result.transactionPositions.length !== 3 ||
    result.transactionPositions[0] !== 0 ||
    result.transactionPositions[1] !== 1 ||
    result.transactionPositions[2] !== 2 ||
    !Number.isSafeInteger(result.transactionSequence) ||
    Number(result.transactionSequence) < 2
  ) {
    throw new Error("invalid Core snapshot activation receipt result values");
  }
  assertUtcInstant(String(result.importedAt), "Core snapshot import time");
  return {
    snapshotId: String(result.snapshotId),
    definitionRecordId: String(result.definitionRecordId),
    activeFactRecordId: String(result.activeFactRecordId),
    eventRecordId: String(result.eventRecordId),
    catalogDigest: String(result.catalogDigest),
    sourceCommitId: String(result.sourceCommitId),
    importedAt: String(result.importedAt),
    transactionPositions: [0, 1, 2],
    transactionSequence: Number(result.transactionSequence),
  };
}

function parseCoreSnapshotRollbackResult(value: JsonValue): CoreSnapshotRollbackResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Core snapshot rollback receipt result");
  }
  const result = value as Record<string, JsonValue>;
  const expected = [
    "decisionRecordId",
    "snapshotId",
    "definitionRecordId",
    "activeFactRecordId",
    "eventRecordId",
    "catalogDigest",
    "sourceCommitId",
    "previousSnapshotId",
    "previousSourceCommitId",
    "operatorPrincipalId",
    "reason",
    "importedAt",
    "transactionPositions",
    "transactionSequence",
  ].sort();
  const keys = Object.keys(result).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("invalid Core snapshot rollback receipt result fields");
  }
  if (
    !isUuidV7(String(result.decisionRecordId)) ||
    !isUuidV7(String(result.snapshotId)) ||
    !isUuidV7(String(result.definitionRecordId)) ||
    !isUuidV7(String(result.activeFactRecordId)) ||
    !isUuidV7(String(result.eventRecordId)) ||
    !isUuidV7(String(result.previousSnapshotId)) ||
    !isUuidV7(String(result.operatorPrincipalId)) ||
    !/^sha256:[0-9a-f]{64}$/.test(String(result.catalogDigest)) ||
    !/^[0-9a-f]{40}$/.test(String(result.sourceCommitId)) ||
    !/^[0-9a-f]{40}$/.test(String(result.previousSourceCommitId)) ||
    typeof result.reason !== "string" ||
    !Array.isArray(result.transactionPositions) ||
    result.transactionPositions.length !== 4 ||
    result.transactionPositions[0] !== 0 ||
    result.transactionPositions[1] !== 1 ||
    result.transactionPositions[2] !== 2 ||
    result.transactionPositions[3] !== 3 ||
    !Number.isSafeInteger(result.transactionSequence) ||
    Number(result.transactionSequence) < 2
  ) {
    throw new Error("invalid Core snapshot rollback receipt result values");
  }
  assertBoundedReason(String(result.reason), "Core rollback result reason");
  assertUtcInstant(String(result.importedAt), "Core snapshot rollback import time");
  return {
    decisionRecordId: String(result.decisionRecordId),
    snapshotId: String(result.snapshotId),
    definitionRecordId: String(result.definitionRecordId),
    activeFactRecordId: String(result.activeFactRecordId),
    eventRecordId: String(result.eventRecordId),
    catalogDigest: String(result.catalogDigest),
    sourceCommitId: String(result.sourceCommitId),
    previousSnapshotId: String(result.previousSnapshotId),
    previousSourceCommitId: String(result.previousSourceCommitId),
    operatorPrincipalId: String(result.operatorPrincipalId),
    reason: String(result.reason),
    importedAt: String(result.importedAt),
    transactionPositions: [0, 1, 2, 3],
    transactionSequence: Number(result.transactionSequence),
  };
}

function parseCoreCandidateRejectionResult(value: JsonValue): CoreCandidateRejectionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Core candidate rejection receipt result");
  }
  const result = value as Record<string, JsonValue>;
  const expected = [
    "checkId",
    "observationRecordId",
    "eventRecordId",
    "observedAt",
    "transactionPositions",
    "transactionSequence",
  ].sort();
  const keys = Object.keys(result).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("invalid Core candidate rejection receipt result fields");
  }
  if (
    !isUuidV7(String(result.checkId)) ||
    !isUuidV7(String(result.observationRecordId)) ||
    !isUuidV7(String(result.eventRecordId)) ||
    !Array.isArray(result.transactionPositions) ||
    result.transactionPositions.length !== 2 ||
    result.transactionPositions[0] !== 0 ||
    result.transactionPositions[1] !== 1 ||
    !Number.isSafeInteger(result.transactionSequence) ||
    Number(result.transactionSequence) < 2
  ) {
    throw new Error("invalid Core candidate rejection receipt result values");
  }
  assertUtcInstant(String(result.observedAt), "Core candidate rejection observation time");
  return {
    checkId: String(result.checkId),
    observationRecordId: String(result.observationRecordId),
    eventRecordId: String(result.eventRecordId),
    observedAt: String(result.observedAt),
    transactionPositions: [0, 1],
    transactionSequence: Number(result.transactionSequence),
  };
}

function parseCoreSourceCheckEligibleResult(value: JsonValue): CoreSourceCheckEligibleResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid eligible Core source check receipt result");
  }
  const result = value as Record<string, JsonValue>;
  const expected = [
    "checkId",
    "observationRecordId",
    "eventRecordId",
    "checkedAt",
    "transactionPositions",
    "transactionSequence",
  ].sort();
  const keys = Object.keys(result).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("invalid eligible Core source check receipt result fields");
  }
  if (
    !isUuidV7(String(result.checkId)) ||
    !isUuidV7(String(result.observationRecordId)) ||
    !isUuidV7(String(result.eventRecordId)) ||
    !Array.isArray(result.transactionPositions) ||
    result.transactionPositions.length !== 2 ||
    result.transactionPositions[0] !== 0 ||
    result.transactionPositions[1] !== 1 ||
    !Number.isSafeInteger(result.transactionSequence) ||
    Number(result.transactionSequence) < 2
  ) {
    throw new Error("invalid eligible Core source check receipt result values");
  }
  assertUtcInstant(String(result.checkedAt), "eligible Core source check time");
  return {
    checkId: String(result.checkId),
    observationRecordId: String(result.observationRecordId),
    eventRecordId: String(result.eventRecordId),
    checkedAt: String(result.checkedAt),
    transactionPositions: [0, 1],
    transactionSequence: Number(result.transactionSequence),
  };
}

function parseCoreStaleSourceOverrideResult(value: JsonValue): CoreStaleSourceOverrideResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Core stale-source override receipt result");
  }
  const result = value as Record<string, JsonValue>;
  const expected = [
    "decisionRecordId",
    "eventRecordId",
    "activeSnapshotId",
    "operatorPrincipalId",
    "reason",
    "decidedAt",
    "expiresAt",
    "transactionPositions",
    "transactionSequence",
  ].sort();
  const keys = Object.keys(result).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("invalid Core stale-source override receipt result fields");
  }
  if (
    !isUuidV7(String(result.decisionRecordId)) ||
    !isUuidV7(String(result.eventRecordId)) ||
    !isUuidV7(String(result.activeSnapshotId)) ||
    !isUuidV7(String(result.operatorPrincipalId)) ||
    !Array.isArray(result.transactionPositions) ||
    result.transactionPositions.length !== 2 ||
    result.transactionPositions[0] !== 0 ||
    result.transactionPositions[1] !== 1 ||
    !Number.isSafeInteger(result.transactionSequence) ||
    Number(result.transactionSequence) < 2
  ) {
    throw new Error("invalid Core stale-source override receipt result values");
  }
  assertBoundedReason(String(result.reason), "Core stale-source override result reason");
  assertUtcInstant(String(result.decidedAt), "Core stale-source override decision time");
  assertUtcInstant(String(result.expiresAt), "Core stale-source override expiry");
  const decidedAt = new Date(String(result.decidedAt)).getTime();
  const expiresAt = new Date(String(result.expiresAt)).getTime();
  if (expiresAt <= decidedAt || expiresAt > decidedAt + 86_400_000) {
    throw new Error("invalid Core stale-source override result duration");
  }
  return {
    decisionRecordId: String(result.decisionRecordId),
    eventRecordId: String(result.eventRecordId),
    activeSnapshotId: String(result.activeSnapshotId),
    operatorPrincipalId: String(result.operatorPrincipalId),
    reason: String(result.reason),
    decidedAt: String(result.decidedAt),
    expiresAt: String(result.expiresAt),
    transactionPositions: [0, 1],
    transactionSequence: Number(result.transactionSequence),
  };
}

function parseCoreCheckDetailPruneResult(value: JsonValue): CoreCheckDetailPruneResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid Core check-detail prune receipt result");
  }
  const result = value as Record<string, JsonValue>;
  const expected = [
    "observationRecordId",
    "eventRecordId",
    "cutoffAt",
    "evaluatedAt",
    "maximumEligibleChecks",
    "deletedTransactionCount",
    "deletedOccurrenceCount",
    "deletedFirstSequence",
    "deletedLastSequence",
    "deletedDigest",
    "remainingDetailedCheckCount",
    "transactionPositions",
    "transactionSequence",
  ].sort();
  const keys = Object.keys(result).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("invalid Core check-detail prune receipt result fields");
  }
  if (
    !isUuidV7(String(result.observationRecordId)) ||
    !isUuidV7(String(result.eventRecordId)) ||
    result.maximumEligibleChecks !== 10000 ||
    !Number.isSafeInteger(result.deletedTransactionCount) ||
    Number(result.deletedTransactionCount) < 0 ||
    result.deletedOccurrenceCount !== Number(result.deletedTransactionCount) * 2 ||
    !/^sha256:[0-9a-f]{64}$/.test(String(result.deletedDigest)) ||
    !Number.isSafeInteger(result.remainingDetailedCheckCount) ||
    Number(result.remainingDetailedCheckCount) < 0 ||
    !Array.isArray(result.transactionPositions) ||
    result.transactionPositions.length !== 2 ||
    result.transactionPositions[0] !== 0 ||
    result.transactionPositions[1] !== 1 ||
    !Number.isSafeInteger(result.transactionSequence) ||
    Number(result.transactionSequence) < 2
  ) {
    throw new Error("invalid Core check-detail prune receipt result values");
  }
  const deletedCount = Number(result.deletedTransactionCount);
  if (
    (deletedCount === 0 && (result.deletedFirstSequence !== null || result.deletedLastSequence !== null)) ||
    (deletedCount > 0 &&
      (!Number.isSafeInteger(result.deletedFirstSequence) ||
        Number(result.deletedFirstSequence) < 1 ||
        !Number.isSafeInteger(result.deletedLastSequence) ||
        Number(result.deletedLastSequence) < Number(result.deletedFirstSequence)))
  ) {
    throw new Error("invalid Core check-detail prune deleted sequence bounds");
  }
  assertUtcInstant(String(result.cutoffAt), "Core check-detail prune cutoff");
  assertUtcInstant(String(result.evaluatedAt), "Core check-detail prune evaluation time");
  if (new Date(String(result.evaluatedAt)).getTime() - new Date(String(result.cutoffAt)).getTime() !== 30 * 86_400_000) {
    throw new Error("invalid Core check-detail prune retention interval");
  }
  return {
    observationRecordId: String(result.observationRecordId),
    eventRecordId: String(result.eventRecordId),
    cutoffAt: String(result.cutoffAt),
    evaluatedAt: String(result.evaluatedAt),
    maximumEligibleChecks: 10000,
    deletedTransactionCount: deletedCount,
    deletedOccurrenceCount: Number(result.deletedOccurrenceCount),
    deletedFirstSequence: result.deletedFirstSequence === null ? null : Number(result.deletedFirstSequence),
    deletedLastSequence: result.deletedLastSequence === null ? null : Number(result.deletedLastSequence),
    deletedDigest: String(result.deletedDigest),
    remainingDetailedCheckCount: Number(result.remainingDetailedCheckCount),
    transactionPositions: [0, 1],
    transactionSequence: Number(result.transactionSequence),
  };
}

function assertCandidateReport(
  candidate: InspectedCoreCandidate,
  validated: ReturnType<typeof validateCoreCatalog>,
): void {
  const candidateReport = {
    catalogDigest: candidate.catalogDigest,
    fileCount: candidate.fileCount,
    invalidFixtureCount: candidate.invalidFixtureCount,
    repositories: candidate.repositories,
    repositoryCount: candidate.repositoryCount,
    schemaDigests: candidate.schemaDigests,
    totalBytes: candidate.totalBytes,
    validFixtureCount: candidate.validFixtureCount,
  } as unknown as JsonValue;
  const validatedReport = {
    catalogDigest: validated.catalogDigest,
    fileCount: validated.fileCount,
    invalidFixtureCount: validated.invalidFixtureCount,
    repositories: validated.repositories,
    repositoryCount: validated.repositoryCount,
    schemaDigests: validated.schemaDigests,
    totalBytes: validated.totalBytes,
    validFixtureCount: validated.validFixtureCount,
  } as unknown as JsonValue;
  if (canonicalJson(candidateReport) !== canonicalJson(validatedReport)) {
    throw new Error("Core candidate validation report does not match its retained files");
  }
}

function assertMaterializedCoreCandidate(candidate: InspectedCoreCandidate): void {
  const allowedSourceUrls = new Set([
    "https://github.com/frostyard/core.git",
    "git@github.com:frostyard/core.git",
    "ssh://git@github.com:frostyard/core.git",
  ]);
  if (!allowedSourceUrls.has(candidate.sourceUrl)) {
    throw new Error("Core snapshot activation source must be the configured frostyard/core GitHub repository");
  }
  if (
    !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(candidate.ref) ||
    candidate.ref.includes("..") ||
    candidate.ref.includes("//") ||
    candidate.ref.includes("@{") ||
    candidate.ref.endsWith("/") ||
    candidate.ref.endsWith(".")
  ) {
    throw new Error("Core snapshot activation source ref is not canonical");
  }
  if (!/^[0-9a-f]{40}$/.test(candidate.commitId) || !/^[0-9a-f]{40}$/.test(candidate.treeId)) {
    throw new Error("Core snapshot activation requires canonical SHA-1 Git object identities");
  }
  if (!Array.isArray(candidate.files) || candidate.files.length < 1 || candidate.files.length > 256) {
    throw new Error("Core snapshot activation file count is outside the bounded source contract");
  }
  let totalBytes = 0;
  for (const file of candidate.files) {
    if (
      (file.mode !== "100644" && file.mode !== "100755") ||
      !/^[0-9a-f]{40}$/.test(file.objectId) ||
      file.bytes.byteLength > 1_048_576 ||
      Buffer.byteLength(file.path, "utf8") > 512 ||
      file.path.split("/").length > 12 ||
      file.path.split("/").some((component) => !component || component === "." || component === "..")
    ) {
      throw new Error(`Core snapshot activation file is outside the bounded source contract: ${file.path}`);
    }
    totalBytes += file.bytes.byteLength;
  }
  if (totalBytes > 8_388_608) throw new Error("Core snapshot activation bytes exceed the bounded source contract");
}

function assertBoundedReason(value: string, label: string): void {
  if (
    Buffer.byteLength(value, "utf8") < 1 ||
    Buffer.byteLength(value, "utf8") > 512 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value !== value.trim()
  ) {
    throw new Error(`${label} must be a trimmed single line from 1 through 512 UTF-8 bytes`);
  }
}

function sha256Bytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
