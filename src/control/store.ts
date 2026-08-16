import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { backup as sqliteBackup, DatabaseSync, type SQLInputValue } from "node:sqlite";

import { canonicalJson, isUuidV7, sha256, uuidV7, type JsonValue } from "./encoding.ts";
import { validateCoreCatalog, type CoreTreeEntry } from "../core/validator.ts";
import type { InspectedCoreCandidate } from "../core/git-source.ts";
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
  type CoreRollbackActivatedPayload,
  type CoreRollbackDecisionPayload,
  type CoreSourceCheckEligiblePayload,
  type ProjectionName,
  type RecordClass,
  type SubjectKind,
} from "./registry.ts";

type Row = Record<string, SQLInputValue>;

const BUSY_TIMEOUT_MS = 5_000;
const TARGET_TABLES = [
  "core_active_snapshot",
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
  overrideDecisionId: null;
  overrideExpiresAt: null;
  degraded: false;
}

export interface ActiveCoreSnapshot {
  snapshotId: string;
  sourceCommitId: string;
  sourceTreeId: string;
  catalogDigest: string;
  activatedAt: string;
  transactionSequence: number;
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

  coreAdmissionReadiness(evaluatedAt = this.now()): CoreAdmissionReadiness {
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
      assertUtcInstant(String(row.retained_until), `idempotency receipt ${String(row.idempotency_key)} retention time`);
      if (
        (commandKind === "control-plane.check-integrity" ||
          commandKind === "core.activate-snapshot" ||
          commandKind === "core.rollback-snapshot" ||
          commandKind === "core.record-candidate-rejection" ||
          commandKind === "core.record-source-check-eligible") &&
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
