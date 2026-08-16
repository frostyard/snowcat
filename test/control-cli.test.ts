import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("the local control CLI exposes kernel diagnostics and typed integrity execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-control-cli-test-"));
  const path = join(directory, "control-plane.db");
  const run = controlRunner(path);

  const metadataRun = run("metadata");
  assert.equal(metadataRun.status, 0);
  const metadata = JSON.parse(metadataRun.stdout) as Record<string, unknown>;
  assert.equal(metadata.lastTransactionSequence, 1);
  assert.match(String(metadata.authoritativeDigest), /^sha256:[0-9a-f]{64}$/);
  assert.equal(metadataRun.stdout.includes("leaseToken"), false);

  const health = JSON.parse(run("projection-health").stdout) as Array<Record<string, unknown>>;
  assert.deepEqual(health.map((row) => row.status), ["current", "current"]);

  const integrity = run("check-integrity", "1", "integrity:control-cli:1");
  assert.equal(integrity.status, 0);
  assert.equal(JSON.parse(integrity.stdout).transactionSequence, 2);
  const replay = run("check-integrity", "1", "integrity:control-cli:1");
  assert.equal(replay.status, 0);
  assert.deepEqual(JSON.parse(replay.stdout), JSON.parse(integrity.stdout));

  const invalid = run("check-integrity", "01", "integrity:control-cli:invalid");
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /positive canonical integer/);
  const usage = run("help");
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /stage-restore <manifest.json>/);
});

test("the local control CLI carries a backup manifest through verification and restore staging", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-control-cli-backup-test-"));
  const livePath = join(directory, "control-plane.db");
  const backupPath = join(directory, "backup", "control-plane.db");
  const manifestPath = join(directory, "backup-manifest.json");
  const restoredPath = join(directory, "restore", "control-plane.db");
  const run = controlRunner(livePath);

  const metadata = JSON.parse(run("metadata").stdout) as {
    databaseLineageId: string;
    lastTransactionSequence: number;
  };
  const backup = run("backup", backupPath);
  assert.equal(backup.status, 0);
  const manifest = JSON.parse(backup.stdout) as Record<string, unknown>;
  assert.equal(manifest.backupPath, backupPath);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  const verified = run(
    "verify-backup",
    manifestPath,
    metadata.databaseLineageId,
    String(metadata.lastTransactionSequence),
  );
  assert.equal(verified.status, 0);
  assert.equal(JSON.parse(verified.stdout).quickCheck, "ok");

  const staged = run(
    "stage-restore",
    manifestPath,
    restoredPath,
    metadata.databaseLineageId,
    String(metadata.lastTransactionSequence),
  );
  assert.equal(staged.status, 0);
  assert.equal(JSON.parse(staged.stdout).manifest.backupPath, restoredPath);

  const restoredMetadata = JSON.parse(controlRunner(restoredPath)("metadata").stdout) as Record<string, unknown>;
  assert.equal(restoredMetadata.databaseLineageId, metadata.databaseLineageId);
  assert.equal(restoredMetadata.lastTransactionSequence, metadata.lastTransactionSequence);

  const sentinelPath = join(directory, "sentinel.db");
  await writeFile(sentinelPath, "do-not-overwrite", "utf8");
  const refused = run(
    "stage-restore",
    manifestPath,
    sentinelPath,
    metadata.databaseLineageId,
    String(metadata.lastTransactionSequence),
  );
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /restore target already exists/);
  assert.equal(await readFile(sentinelPath, "utf8"), "do-not-overwrite");
});

test("the local control CLI repairs only disposable projection rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-control-cli-repair-test-"));
  const path = join(directory, "control-plane.db");
  const run = controlRunner(path);
  const metadata = JSON.parse(run("metadata").stdout) as Record<string, unknown>;

  const raw = new DatabaseSync(path);
  raw.exec(`
    PRAGMA foreign_keys = OFF;
    DELETE FROM projection_heads;
    DELETE FROM projection_subject_lookup;
    DELETE FROM projection_event_cursor;
    DELETE FROM projection_generations;
  `);
  raw.close();

  const repair = run("repair-projections");
  assert.equal(repair.status, 0);
  assert.equal((JSON.parse(repair.stdout) as unknown[]).length, 2);
  assert.deepEqual(
    (JSON.parse(run("projection-health").stdout) as Array<Record<string, unknown>>).map((row) => row.status),
    ["current", "current"],
  );
  const after = JSON.parse(run("metadata").stdout) as Record<string, unknown>;
  assert.equal(after.databaseLineageId, metadata.databaseLineageId);
  assert.equal(after.lastTransactionSequence, metadata.lastTransactionSequence);
  assert.equal(after.authoritativeDigest, metadata.authoritativeDigest);
});

function controlRunner(path: string) {
  const env = stringEnvironment({ ...process.env, FLUENT_CONTROL_DB: path });
  return (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/control/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });
}

function stringEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
