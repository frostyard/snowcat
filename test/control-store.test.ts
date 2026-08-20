import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { canonicalJson, isUuidV7, type JsonValue } from "../src/control/encoding.ts";
import {
  CONTROL_PLANE_APPLICATION_ID,
  CONTROL_PLANE_REGISTRY_VERSION,
  CONTROL_PLANE_SCHEMA_VERSION,
} from "../src/control/registry.ts";
import { ControlPlaneStore } from "../src/control/store.ts";
import { QueueStore } from "../src/queue/store.ts";

test("a fresh control-plane database initializes ordered database, operator, and event occurrences", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-control-test-"));
  const path = join(directory, "control-plane.db");
  const recordedAt = "2026-08-16T12:00:00.000Z";
  const store = new ControlPlaneStore(path, () => new Date(recordedAt));
  context.after(() => store.close());

  const metadata = store.metadata();
  assert.equal(metadata.applicationId, CONTROL_PLANE_APPLICATION_ID);
  assert.equal(metadata.schemaVersion, CONTROL_PLANE_SCHEMA_VERSION);
  assert.equal(metadata.registryVersion, CONTROL_PLANE_REGISTRY_VERSION);
  assert.ok(isUuidV7(metadata.databaseLineageId));
  assert.ok(isUuidV7(metadata.operatorPrincipalId));
  assert.equal(metadata.createdAt, recordedAt);
  assert.equal(metadata.controlTimeWatermark, recordedAt);
  assert.equal(metadata.lastTransactionSequence, 1);

  const occurrences = store.occurrences();
  assert.equal(occurrences.length, 3);
  assert.deepEqual(
    occurrences.map((occurrence) => [
      occurrence.occurrenceType,
      occurrence.kind,
      occurrence.recordClass,
      occurrence.transactionSequence,
      occurrence.transactionPosition,
    ]),
    [
      ["record", "control-plane.database-definition", "definition", 1, 0],
      ["record", "principal.definition", "definition", 1, 1],
      ["event", "control-plane.initialized", undefined, 1, 2],
    ],
  );
  for (const occurrence of occurrences) {
    assert.ok(isUuidV7(occurrence.recordId));
    assert.equal(occurrence.recordedAt, recordedAt);
    assert.equal(occurrence.informationClass, "organization");
    assert.deepEqual(occurrence.informationScope, { deploymentId: metadata.databaseLineageId });
  }
  for (const occurrence of [occurrences[0]!, occurrences[2]!]) {
    assert.equal(occurrence.subjectKind, "control-plane-database");
    assert.equal(occurrence.subjectId, metadata.databaseLineageId);
    assert.deepEqual(occurrence.payload, {
      databaseLineageId: metadata.databaseLineageId,
      operatorPrincipalId: metadata.operatorPrincipalId,
      registryVersion: CONTROL_PLANE_REGISTRY_VERSION,
      schemaVersion: CONTROL_PLANE_SCHEMA_VERSION,
    });
  }
  assert.equal(occurrences[1]!.subjectKind, "operator-principal");
  assert.equal(occurrences[1]!.subjectId, metadata.operatorPrincipalId);
  assert.deepEqual(occurrences[1]!.payload, { binding: "local-stdio-implicit", principalKind: "operator" });
});

test("reopening a current target database performs no schema writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-control-reopen-test-"));
  const path = join(directory, "control-plane.db");
  const first = new ControlPlaneStore(path, () => new Date("2026-08-16T12:00:00.000Z"));
  const lineage = first.metadata().databaseLineageId;
  first.close();

  const raw = new DatabaseSync(path);
  const before = Number((raw.prepare("PRAGMA schema_version").get() as { schema_version: number }).schema_version);
  raw.close();

  const reopened = new ControlPlaneStore(path, () => new Date("2026-08-17T12:00:00.000Z"));
  assert.equal(reopened.metadata().databaseLineageId, lineage);
  assert.equal(reopened.metadata().lastTransactionSequence, 1);
  assert.equal(reopened.occurrences().length, 3);
  reopened.close();

  const verified = new DatabaseSync(path);
  const after = Number((verified.prepare("PRAGMA schema_version").get() as { schema_version: number }).schema_version);
  verified.close();
  assert.equal(after, before);
});

test("the target store refuses a queue-spike database without modifying it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-control-spike-refusal-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  queue.close();

  const before = inspectDatabase(path);
  assert.throws(() => new ControlPlaneStore(path), /queue-spike database/);
  const after = inspectDatabase(path);
  assert.deepEqual(after, before);
  assert.equal(after.applicationId, 0);
  assert.ok(!after.tables.includes("control_plane_metadata"));
});

test("unknown persisted kinds and sequence-watermark damage fail closed on open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-control-corruption-test-"));
  const unknownKindPath = join(directory, "unknown-kind.db");
  const unknownKind = new ControlPlaneStore(unknownKindPath);
  unknownKind.close();
  const tamperedKind = new DatabaseSync(unknownKindPath);
  tamperedKind.prepare("UPDATE durable_occurrences SET kind = 'model-invented.kind' WHERE occurrence_type = 'event'").run();
  tamperedKind.close();
  assert.throws(() => new ControlPlaneStore(unknownKindPath), /command output contract mismatch/);

  const watermarkPath = join(directory, "watermark.db");
  const watermark = new ControlPlaneStore(watermarkPath);
  watermark.close();
  const tamperedWatermark = new DatabaseSync(watermarkPath);
  tamperedWatermark.prepare("UPDATE control_plane_metadata SET last_transaction_sequence = 0").run();
  tamperedWatermark.close();
  assert.throws(() => new ControlPlaneStore(watermarkPath), /transaction watermark mismatch/);
});

test("the registered integrity command is atomic, ordered, optimistic, and idempotent", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-control-command-test-"));
  const path = join(directory, "control-plane.db");
  let now = new Date("2026-08-16T12:00:00.000Z");
  const store = new ControlPlaneStore(path, () => now);
  context.after(() => store.close());

  now = new Date("2026-08-16T12:01:00.000Z");
  const first = store.checkIntegrity({ expectedLastTransactionSequence: 1, idempotencyKey: "integrity:test:1" });
  assert.equal(first.result, "ok");
  assert.equal(first.checkedThroughSequence, 1);
  assert.equal(first.transactionSequence, 2);
  assert.deepEqual(first.transactionPositions, [0, 1]);
  assert.equal(first.evaluationTime, now.toISOString());
  assert.equal(first.recordedTime, now.toISOString());
  assert.ok(isUuidV7(first.observationRecordId));
  assert.ok(isUuidV7(first.eventRecordId));

  assert.deepEqual(
    store.occurrences().slice(-2).map((occurrence) => [
      occurrence.occurrenceType,
      occurrence.kind,
      occurrence.recordClass,
      occurrence.revisionKind,
      occurrence.revisionValue,
      occurrence.transactionSequence,
      occurrence.transactionPosition,
    ]),
    [
      ["record", "control-plane.integrity-observation", "observation", "transaction-sequence", "1", 2, 0],
      ["event", "control-plane.integrity-checked", undefined, "transaction-sequence", "1", 2, 1],
    ],
  );
  assert.equal(store.metadata().lastTransactionSequence, 2);
  assert.equal(store.metadata().controlTimeWatermark, now.toISOString());

  now = new Date("2027-01-01T00:00:00.000Z");
  const replay = store.checkIntegrity({ expectedLastTransactionSequence: 1, idempotencyKey: "integrity:test:1" });
  assert.deepEqual(replay, first);
  assert.equal(store.metadata().lastTransactionSequence, 2);
  assert.equal(store.metadata().controlTimeWatermark, "2026-08-16T12:01:00.000Z");
  assert.equal(store.occurrences().length, 5);

  assert.throws(
    () => store.checkIntegrity({ expectedLastTransactionSequence: 2, idempotencyKey: "integrity:test:1" }),
    /different command payload/,
  );
  assert.throws(
    () => store.checkIntegrity({ expectedLastTransactionSequence: 1, idempotencyKey: "integrity:test:stale" }),
    /stale control-plane sequence/,
  );

  now = new Date("2026-08-16T12:00:59.999Z");
  assert.throws(
    () => store.checkIntegrity({ expectedLastTransactionSequence: 2, idempotencyKey: "integrity:test:clock" }),
    /clock moved backwards/,
  );
  assert.equal(store.metadata().lastTransactionSequence, 2);
  assert.equal(store.occurrences().length, 5);
});

test("a failure after sequence allocation rolls back the transaction and its receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-control-rollback-test-"));
  const path = join(directory, "control-plane.db");
  let now = new Date("2026-08-16T12:00:00.000Z");
  const store = new ControlPlaneStore(path, () => now, (point) => {
    if (point === "after-integrity-observation") throw new Error("injected transaction failure");
  });
  now = new Date("2026-08-16T12:01:00.000Z");
  assert.throws(
    () => store.checkIntegrity({ expectedLastTransactionSequence: 1, idempotencyKey: "integrity:test:rollback" }),
    /injected transaction failure/,
  );
  assert.equal(store.metadata().lastTransactionSequence, 1);
  assert.equal(store.occurrences().length, 3);
  store.close();

  const raw = new DatabaseSync(path);
  const maximum = Number(
    (raw.prepare("SELECT MAX(sequence) AS maximum FROM control_transactions").get() as { maximum: number }).maximum,
  );
  const allocated = Number(
    (raw.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'control_transactions'").get() as { seq: number }).seq,
  );
  const receipts = Number((raw.prepare("SELECT COUNT(*) AS count FROM idempotency_receipts").get() as { count: number }).count);
  raw.close();
  assert.equal(maximum, 1);
  assert.equal(allocated, 1);
  assert.equal(receipts, 0);
});

test("concurrent processes replay one idempotent command and serialize conflicting commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-control-concurrency-test-"));
  const path = join(directory, "control-plane.db");
  const setup = new ControlPlaneStore(path);
  setup.close();

  const duplicate = await runConcurrentIntegrity(path, 1, ["integrity:concurrent:same", "integrity:concurrent:same"]);
  assert.equal(duplicate.every((result) => result.ok), true);
  assert.deepEqual(duplicate[0]?.value, duplicate[1]?.value);
  assert.equal(duplicate[0]?.value?.transactionSequence, 2);

  const restarted = new ControlPlaneStore(path);
  const replayed = restarted.checkIntegrity({
    expectedLastTransactionSequence: 1,
    idempotencyKey: "integrity:concurrent:same",
  });
  assert.deepEqual(replayed, duplicate[0]?.value);
  assert.equal(restarted.metadata().lastTransactionSequence, 2);
  restarted.close();

  const conflicting = await runConcurrentIntegrity(path, 2, ["integrity:concurrent:a", "integrity:concurrent:b"]);
  assert.equal(conflicting.filter((result) => result.ok).length, 1);
  assert.equal(conflicting.filter((result) => !result.ok && /stale control-plane sequence/.test(result.error ?? "")).length, 1);

  const verified = new ControlPlaneStore(path);
  assert.equal(verified.metadata().lastTransactionSequence, 3);
  assert.equal(verified.occurrences().length, 7);
  verified.close();
});

test("startup rejects a receipt whose valid-looking result no longer matches its outputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-control-receipt-tamper-test-"));
  const path = join(directory, "control-plane.db");
  const store = new ControlPlaneStore(path);
  store.checkIntegrity({ expectedLastTransactionSequence: 1, idempotencyKey: "integrity:tamper" });
  store.close();

  const raw = new DatabaseSync(path);
  const row = raw.prepare("SELECT result_json FROM idempotency_receipts WHERE idempotency_key = 'integrity:tamper'").get() as {
    result_json: string;
  };
  const result = JSON.parse(row.result_json) as Record<string, JsonValue>;
  result.eventRecordId = result.observationRecordId!;
  raw.prepare("UPDATE idempotency_receipts SET result_json = ? WHERE idempotency_key = 'integrity:tamper'").run(
    canonicalJson(result),
  );
  raw.close();

  assert.throws(() => new ControlPlaneStore(path), /integrity receipt result output mismatch/);
});

test("fresh projection generations filter by information class and deployment scope", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-control-projection-access-test-"));
  const path = join(directory, "control-plane.db");
  const store = new ControlPlaneStore(path, () => new Date("2026-08-16T12:00:00.000Z"));
  context.after(() => store.close());
  const metadata = store.metadata();

  assert.deepEqual(
    store.projectionHealth().map((health) => [health.projectionName, health.status, health.sourceSequence, health.lag]),
    [
      ["control-plane.subject-lookup", "current", 1, 0],
      ["control-plane.event-cursor", "current", 1, 0],
    ],
  );

  const access = { maximumInformationClass: "organization" as const, deploymentIds: [metadata.databaseLineageId] };
  const subjects = store.projectedSubjects(access);
  assert.equal(subjects.stale, false);
  assert.equal(subjects.rows.length, 2);
  assert.deepEqual(
    subjects.rows.map((row) => row.subjectKind).sort(),
    ["control-plane-database", "operator-principal"],
  );
  assert.equal(store.projectedEvents(access).rows.length, 1);
  assert.equal(store.projectedEvents(access).rows[0]?.kind, "control-plane.initialized");

  assert.equal(
    store.projectedSubjects({ maximumInformationClass: "public", deploymentIds: [metadata.databaseLineageId] }).rows.length,
    0,
  );
  assert.equal(
    store.projectedEvents({ maximumInformationClass: "restricted", deploymentIds: [metadata.operatorPrincipalId] }).rows.length,
    0,
  );

  const firstSubjectGeneration = subjects.generation;
  const firstEventGeneration = store.projectedEvents(access).generation;
  const repeated = store.rebuildProjections();
  assert.equal(repeated[0]!.generationId === firstSubjectGeneration.generationId, false);
  assert.equal(repeated[0]!.sourceDigest, firstSubjectGeneration.sourceDigest);
  assert.equal(repeated[0]!.outputDigest, firstSubjectGeneration.outputDigest);
  assert.equal(repeated[1]!.sourceDigest, firstEventGeneration.sourceDigest);
  assert.equal(repeated[1]!.outputDigest, firstEventGeneration.outputDigest);
  assert.deepEqual(store.metadata(), metadata);
});

test("full rebuild publishes immutable current generations while stale generations remain conservative", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-control-projection-rebuild-test-"));
  const path = join(directory, "control-plane.db");
  let now = new Date("2026-08-16T12:00:00.000Z");
  const store = new ControlPlaneStore(path, () => now);
  context.after(() => store.close());
  const metadata = store.metadata();
  const access = { maximumInformationClass: "organization" as const, deploymentIds: [metadata.databaseLineageId] };
  const initialGenerationIds = store.projectionHealth().map((health) => health.activeGenerationId);

  now = new Date("2026-08-16T12:01:00.000Z");
  store.checkIntegrity({ expectedLastTransactionSequence: 1, idempotencyKey: "integrity:projection:stale" });
  assert.deepEqual(
    store.projectionHealth().map((health) => [health.status, health.sourceSequence, health.currentSequence, health.lag]),
    [
      ["stale", 1, 2, 1],
      ["stale", 1, 2, 1],
    ],
  );
  const staleEvents = store.projectedEvents(access);
  assert.equal(staleEvents.stale, true);
  assert.equal(staleEvents.rows.length, 1);

  now = new Date("2026-08-16T12:02:00.000Z");
  const rebuilt = store.rebuildProjections();
  assert.deepEqual(rebuilt.map((generation) => generation.sourceSequence), [2, 2]);
  assert.equal(rebuilt.every((generation) => generation.invariantResult === "ok"), true);
  assert.equal(rebuilt.some((generation, index) => generation.generationId === initialGenerationIds[index]), false);
  assert.equal(store.projectionHealth().every((health) => health.status === "current" && health.lag === 0), true);

  const events = store.projectedEvents(access);
  assert.equal(events.stale, false);
  assert.deepEqual(events.rows.map((row) => row.kind), ["control-plane.initialized", "control-plane.integrity-checked"]);
  const secondPage = store.projectedEvents(
    access,
    {
      transactionSequence: events.rows[0]!.transactionSequence,
      transactionPosition: events.rows[0]!.transactionPosition,
    },
    1,
  );
  assert.deepEqual(secondPage.rows.map((row) => row.kind), ["control-plane.integrity-checked"]);
  assert.equal(store.metadata().lastTransactionSequence, 2);
});

test("a failed shadow rebuild leaves prior projection heads and rows active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-control-projection-rollback-test-"));
  const path = join(directory, "control-plane.db");
  let now = new Date("2026-08-16T12:00:00.000Z");
  const store = new ControlPlaneStore(path, () => now, (point) => {
    if (point === "after-projection-shadow-write") throw new Error("injected projection failure");
  });
  const initialHeads = store.projectionHealth().map((health) => health.activeGenerationId);
  now = new Date("2026-08-16T12:01:00.000Z");
  store.checkIntegrity({ expectedLastTransactionSequence: 1, idempotencyKey: "integrity:projection:rollback" });
  now = new Date("2026-08-16T12:02:00.000Z");
  assert.throws(() => store.rebuildProjections(), /injected projection failure/);
  assert.deepEqual(store.projectionHealth().map((health) => health.activeGenerationId), initialHeads);
  assert.equal(store.projectionHealth().every((health) => health.status === "stale"), true);
  store.close();

  const raw = new DatabaseSync(path);
  assert.equal(
    Number((raw.prepare("SELECT COUNT(*) AS count FROM projection_generations").get() as { count: number }).count),
    2,
  );
  raw.close();
});

test("projection repair rebuilds deleted disposable rows without changing authoritative history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-control-projection-repair-test-"));
  const path = join(directory, "control-plane.db");
  let now = new Date("2026-08-16T12:00:00.000Z");
  const store = new ControlPlaneStore(path, () => now);
  const beforeOccurrences = store.occurrences();
  const beforeMetadata = store.metadata();

  const raw = new DatabaseSync(path);
  raw.exec(`
    PRAGMA foreign_keys = OFF;
    DELETE FROM projection_heads;
    DELETE FROM projection_subject_lookup;
    DELETE FROM projection_event_cursor;
    DELETE FROM projection_generations;
  `);
  raw.close();
  assert.equal(store.projectionHealth().every((health) => health.status === "unavailable"), true);

  now = new Date("2026-08-16T12:03:00.000Z");
  const repaired = store.repairProjections();
  assert.equal(repaired.length, 2);
  assert.equal(store.projectionHealth().every((health) => health.status === "current"), true);
  assert.deepEqual(store.occurrences(), beforeOccurrences);
  assert.deepEqual(store.metadata(), beforeMetadata);
  store.close();

  const reopened = new ControlPlaneStore(path);
  assert.equal(reopened.projectionHealth().every((health) => health.status === "current"), true);
  reopened.close();
});

test("projection corruption fails its read closed without becoming command authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-control-projection-corruption-test-"));
  const path = join(directory, "control-plane.db");
  let now = new Date("2026-08-16T12:00:00.000Z");
  const store = new ControlPlaneStore(path, () => now);
  const metadata = store.metadata();
  const access = { maximumInformationClass: "organization" as const, deploymentIds: [metadata.databaseLineageId] };

  const raw = new DatabaseSync(path);
  raw.prepare(
    `UPDATE projection_event_cursor SET kind = 'corrupted.event'
     WHERE generation_id = (
       SELECT generation_id FROM projection_heads WHERE projection_name = 'control-plane.event-cursor'
     )`,
  ).run();
  raw.close();

  assert.deepEqual(store.projectionHealth().map((health) => health.status), ["current", "invalid"]);
  assert.throws(() => store.projectedEvents(access), /output digest mismatch/);
  now = new Date("2026-08-16T12:01:00.000Z");
  const integrity = store.checkIntegrity({
    expectedLastTransactionSequence: 1,
    idempotencyKey: "integrity:projection:corrupt",
  });
  assert.equal(integrity.transactionSequence, 2);

  now = new Date("2026-08-16T12:02:00.000Z");
  store.repairProjections();
  assert.equal(store.projectionHealth().every((health) => health.status === "current"), true);
  assert.deepEqual(store.projectedEvents(access).rows.map((row) => row.kind), [
    "control-plane.initialized",
    "control-plane.integrity-checked",
  ]);
  store.close();
});

test("online backup and staged restore preserve lineage, content, and next transaction sequence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-control-backup-restore-test-"));
  const path = join(directory, "control-plane.db");
  const backupPath = join(directory, "backup", "control-plane.db");
  const restorePath = join(directory, "restore", "control-plane.db");
  let now = new Date("2026-08-16T12:00:00.000Z");
  const store = new ControlPlaneStore(path, () => now);
  const metadata = store.metadata();
  now = new Date("2026-08-16T12:01:00.000Z");
  store.checkIntegrity({ expectedLastTransactionSequence: 1, idempotencyKey: "integrity:backup:source" });

  now = new Date("2026-08-16T12:02:00.000Z");
  const manifest = await store.createBackup(backupPath);
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.backupPath, backupPath);
  assert.equal(manifest.databaseLineageId, metadata.databaseLineageId);
  assert.equal(manifest.lastTransactionSequence, 2);
  assert.equal(manifest.nextTransactionSequence, 3);
  assert.equal(manifest.authoritativeDigest, store.authoritativeDigest());

  const verified = ControlPlaneStore.verifyBackup(manifest, {
    databaseLineageId: metadata.databaseLineageId,
    minimumLastTransactionSequence: 2,
  });
  assert.equal(verified.quickCheck, "ok");
  assert.equal(verified.projectionHealth.every((health) => health.status === "stale"), true);

  const staged = await ControlPlaneStore.stageRestore(manifest, restorePath, {
    databaseLineageId: metadata.databaseLineageId,
    minimumLastTransactionSequence: 2,
  });
  assert.equal(staged.manifest.backupPath, restorePath);
  assert.equal(staged.manifest.authoritativeDigest, manifest.authoritativeDigest);
  store.close();

  const restored = new ControlPlaneStore(restorePath, () => new Date("2026-08-16T12:03:00.000Z"));
  assert.equal(restored.metadata().databaseLineageId, metadata.databaseLineageId);
  assert.equal(restored.metadata().lastTransactionSequence, 2);
  const next = restored.checkIntegrity({
    expectedLastTransactionSequence: 2,
    idempotencyKey: "integrity:backup:restored",
  });
  assert.equal(next.transactionSequence, 3);
  restored.close();
});

test("restore verification refuses an older sequence or another lineage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-control-backup-fence-test-"));
  const path = join(directory, "control-plane.db");
  const backupPath = join(directory, "control-plane-backup.db");
  let now = new Date("2026-08-16T12:00:00.000Z");
  const store = new ControlPlaneStore(path, () => now);
  const metadata = store.metadata();
  now = new Date("2026-08-16T12:01:00.000Z");
  const manifest = await store.createBackup(backupPath);
  now = new Date("2026-08-16T12:02:00.000Z");
  store.checkIntegrity({ expectedLastTransactionSequence: 1, idempotencyKey: "integrity:backup:fence" });

  assert.throws(
    () =>
      ControlPlaneStore.verifyBackup(manifest, {
        databaseLineageId: metadata.databaseLineageId,
        minimumLastTransactionSequence: 2,
      }),
    /restore would permit transaction-sequence reuse/,
  );
  assert.throws(
    () =>
      ControlPlaneStore.verifyBackup(manifest, {
        databaseLineageId: metadata.operatorPrincipalId,
        minimumLastTransactionSequence: 1,
      }),
    /lineage does not match/,
  );
  store.close();
});

test("backup and restore paths are create-only and manifests bind exact content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-control-backup-safety-test-"));
  const path = join(directory, "control-plane.db");
  const existingBackupPath = join(directory, "existing-backup.db");
  const backupPath = join(directory, "control-plane-backup.db");
  const existingRestorePath = join(directory, "existing-restore.db");
  const store = new ControlPlaneStore(path, () => new Date("2026-08-16T12:00:00.000Z"));
  const metadata = store.metadata();

  await writeFile(existingBackupPath, "do-not-overwrite", "utf8");
  await assert.rejects(() => store.createBackup(existingBackupPath), /backup path already exists/);
  assert.equal(await readFile(existingBackupPath, "utf8"), "do-not-overwrite");

  const manifest = await store.createBackup(backupPath);
  const tamperedManifest = {
    ...manifest,
    authoritativeDigest: `sha256:${"0".repeat(64)}`,
  };
  assert.throws(
    () =>
      ControlPlaneStore.verifyBackup(tamperedManifest, {
        databaseLineageId: metadata.databaseLineageId,
        minimumLastTransactionSequence: 1,
      }),
    /manifest does not match database content/,
  );

  await writeFile(existingRestorePath, "do-not-overwrite", "utf8");
  await assert.rejects(
    () =>
      ControlPlaneStore.stageRestore(manifest, existingRestorePath, {
        databaseLineageId: metadata.databaseLineageId,
        minimumLastTransactionSequence: 1,
      }),
    /restore target already exists/,
  );
  assert.equal(await readFile(existingRestorePath, "utf8"), "do-not-overwrite");
  store.close();
});

function inspectDatabase(path: string): { applicationId: number; userVersion: number; schemaVersion: number; tables: string[] } {
  const db = new DatabaseSync(path);
  const applicationId = Number((db.prepare("PRAGMA application_id").get() as { application_id: number }).application_id);
  const userVersion = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  const schemaVersion = Number((db.prepare("PRAGMA schema_version").get() as { schema_version: number }).schema_version);
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
  db.close();
  return { applicationId, userVersion, schemaVersion, tables };
}

async function runConcurrentIntegrity(
  path: string,
  expectedLastTransactionSequence: number,
  keys: [string, string],
): Promise<Array<{ ok: boolean; value?: { transactionSequence: number; [key: string]: unknown }; error?: string }>> {
  const signal = new Int32Array(new SharedArrayBuffer(8));
  const workerSource = `
    (async () => {
      const { parentPort, workerData } = require("node:worker_threads");
      const { tsImport } = await import("tsx/esm/api");
      const { ControlPlaneStore } = await tsImport(workerData.storeUrl, workerData.parentUrl);
      const store = new ControlPlaneStore(workerData.path);
      parentPort.postMessage({ ready: true });
      Atomics.wait(workerData.signal, 1, 0);
      try {
        const value = store.checkIntegrity({
          expectedLastTransactionSequence: workerData.expectedLastTransactionSequence,
          idempotencyKey: workerData.key,
        });
        parentPort.postMessage({ ready: false, ok: true, value });
      } catch (error) {
        parentPort.postMessage({ ready: false, ok: false, error: error instanceof Error ? error.message : String(error) });
      } finally {
        store.close();
      }
    })().catch((error) => { throw error; });
  `;
  const workers = keys.map(
    (key) =>
      new Worker(workerSource, {
        eval: true,
        workerData: {
          expectedLastTransactionSequence,
          key,
          parentUrl: import.meta.url,
          path,
          signal,
          storeUrl: new URL("../src/control/store.ts", import.meta.url).href,
        },
      }),
  );
  const runs = workers.map((worker) => {
    let ready!: () => void;
    let settle!: (result: { ok: boolean; value?: { transactionSequence: number }; error?: string }) => void;
    let reject!: (error: unknown) => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const resultPromise = new Promise<{ ok: boolean; value?: { transactionSequence: number }; error?: string }>(
      (resolve, rejectPromise) => {
        settle = resolve;
        reject = rejectPromise;
      },
    );
    const timeout = setTimeout(() => reject(new Error("control-plane concurrency worker timed out")), 5_000);
    worker.on(
      "message",
      (message: { ready: boolean; ok?: boolean; value?: { transactionSequence: number }; error?: string }) => {
        if (message.ready) {
          ready();
        } else {
          clearTimeout(timeout);
          settle({ ok: message.ok!, value: message.value, error: message.error });
        }
      },
    );
    worker.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    return { readyPromise, resultPromise };
  });

  await Promise.all(runs.map((run) => run.readyPromise));
  Atomics.store(signal, 1, 1);
  Atomics.notify(signal, 1, workers.length);
  return Promise.all(runs.map((run) => run.resultPromise));
}
