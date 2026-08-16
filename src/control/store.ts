import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { backup as sqliteBackup, DatabaseSync, type SQLInputValue } from "node:sqlite";

import { canonicalJson, isUuidV7, sha256, uuidV7, type JsonValue } from "./encoding.ts";
import {
  CONTROL_PLANE_APPLICATION_ID,
  CONTROL_PLANE_REGISTRY_VERSION,
  CONTROL_PLANE_SCHEMA_VERSION,
  assertInformationClass,
  assertRevision,
  assertSource,
  assertSubject,
  commandKindRegistry,
  eventKindRegistry,
  informationClassAtLeast,
  projectionContractRegistry,
  recordClasses,
  recordKindRegistry,
  type InformationClass,
  type ProjectionName,
  type RecordClass,
  type SubjectKind,
} from "./registry.ts";

type Row = Record<string, SQLInputValue>;

const BUSY_TIMEOUT_MS = 5_000;
const TARGET_TABLES = [
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

export type ControlPlaneFaultPoint = "after-integrity-observation" | "after-projection-shadow-write";

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
    informationClass: InformationClass;
    informationScopeJson: string;
    payloadJson: string;
    payloadDigest: string;
    correlationId: string;
    transactionSequence: number;
    transactionPosition: number;
    recordedAt: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO durable_occurrences (
           record_id, occurrence_type, kind, schema_version, subject_kind, subject_id,
           revision_kind, revision_value, source_kind, source_id,
           information_class, information_scope_json, payload_json, payload_digest,
           correlation_id, transaction_sequence, transaction_position, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        input.informationClass,
        input.informationScopeJson,
        input.payloadJson,
        input.payloadDigest,
        input.correlationId,
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
          `SELECT kind, transaction_position, recorded_at
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
      if (row.revision_kind === "sha256" && String(row.revision_value) !== String(row.payload_digest)) {
        throw new Error(`database occurrence revision does not match its payload: ${String(row.record_id)}`);
      }
    }

    const recordCount = Number((this.db.prepare("SELECT COUNT(*) AS count FROM durable_records").get() as Row).count);
    const eventCount = Number((this.db.prepare("SELECT COUNT(*) AS count FROM event_ledger").get() as Row).count);
    if (recordCount + eventCount !== rows.length) throw new Error("durable occurrence subtype coverage mismatch");
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
      assertUtcInstant(String(row.retained_until), `idempotency receipt ${String(row.idempotency_key)} retention time`);
      if (commandKind === "control-plane.check-integrity" && String(row.retained_until) !== IDEMPOTENCY_RETAINED_UNTIL) {
        throw new Error(`integrity receipt retention mismatch: ${String(row.idempotency_key)}`);
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
