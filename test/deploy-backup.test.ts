import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlPlaneStore, type ControlPlaneBackupManifest } from "../src/control/store.ts";
import { QueueStore, type QueueBackupManifest } from "../src/queue/store.ts";
import { childEnvironment } from "./helpers/child-environment.ts";

const SCRIPT = join(process.cwd(), "deploy", "bin", "snowcat-backup");
const DAY_MS = 24 * 60 * 60 * 1000;

test("deploy/bin/snowcat-backup writes verified queue and control-plane backups with manifests and prunes only expired backups", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-deploy-backup-test-"));
  const queuePath = join(directory, "live", "queue.db");
  const controlPath = join(directory, "live", "control-plane.db");
  const backupDir = join(directory, "backups");
  await mkdir(join(directory, "live"), { recursive: true });
  await mkdir(backupDir, { recursive: true });
  const queue = new QueueStore(queuePath);
  queue.setRepositoryEnabled("frostyard/updex", true);
  const liveQueueId = queue.metadata().databaseId;
  queue.close();
  const control = new ControlPlaneStore(controlPath);
  const liveLineage = control.metadata().databaseLineageId;
  control.close();

  // One expired backup pair (20 days old) and one recent pair (1 day old) already in place.
  const expired = ["queue-20260101T000000Z.db", "queue-20260101T000000Z.manifest.json"];
  const recent = ["control-plane-20260816T000000Z.db", "control-plane-20260816T000000Z.manifest.json"];
  const now = Date.now();
  for (const name of expired) {
    await writeFile(join(backupDir, name), "old");
    await utimes(join(backupDir, name), new Date(now - 20 * DAY_MS), new Date(now - 20 * DAY_MS));
  }
  for (const name of recent) {
    await writeFile(join(backupDir, name), "recent");
    await utimes(join(backupDir, name), new Date(now - DAY_MS), new Date(now - DAY_MS));
  }
  // An unrelated file older than the window is not the script's to delete.
  await writeFile(join(backupDir, "notes.txt"), "keep");
  await utimes(join(backupDir, "notes.txt"), new Date(now - 30 * DAY_MS), new Date(now - 30 * DAY_MS));

  const run = spawnSync("bash", [SCRIPT], {
    cwd: directory,
    encoding: "utf8",
    env: childEnvironment({
      SNOWCAT_HOME: process.cwd(),
      SNOWCAT_QUEUE_DB: queuePath,
      SNOWCAT_CONTROL_DB: controlPath,
      SNOWCAT_BACKUP_DIR: backupDir,
      SNOWCAT_BACKUP_RETAIN_DAYS: "14",
    }),
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /pruned 2 file\(s\) older than 14 day\(s\)/);

  const remaining = (await readdir(backupDir)).sort();
  for (const name of expired) assert.equal(remaining.includes(name), false, `${name} should be pruned`);
  for (const name of recent) assert.equal(remaining.includes(name), true, `${name} should be kept`);
  assert.equal(remaining.includes("notes.txt"), true);
  assert.equal(remaining.some((name) => name.endsWith(".partial")), false);

  const stampPattern = /^\d{8}T\d{6}Z$/;
  const queueBackups = remaining.filter((name) => /^queue-\d{8}T\d{6}Z\.db$/.test(name));
  const controlBackups = remaining.filter((name) => /^control-plane-\d{8}T\d{6}Z\.db$/.test(name) && !recent.includes(name));
  assert.equal(queueBackups.length, 1, remaining.join(", "));
  assert.equal(controlBackups.length, 1, remaining.join(", "));
  const stamp = queueBackups[0]!.slice("queue-".length, -".db".length);
  assert.match(stamp, stampPattern);
  assert.equal(controlBackups[0], `control-plane-${stamp}.db`);

  // The queue copy verifies and matches the manifest written beside it.
  const queueBackupPath = join(backupDir, queueBackups[0]!);
  const queueManifest = JSON.parse(
    await readFile(join(backupDir, `queue-${stamp}.manifest.json`), "utf8"),
  ) as QueueBackupManifest;
  assert.equal(queueManifest.backupPath, queueBackupPath);
  assert.equal(queueManifest.databaseId, liveQueueId);
  const inspected = QueueStore.inspectBackup(queueBackupPath);
  assert.equal(inspected.sha256, queueManifest.sha256);
  assert.equal(inspected.schemaVersion, queueManifest.schemaVersion);

  // The control-plane copy verifies through the store's own manifest check.
  const controlManifest = JSON.parse(
    await readFile(join(backupDir, `control-plane-${stamp}.manifest.json`), "utf8"),
  ) as ControlPlaneBackupManifest;
  assert.equal(controlManifest.backupPath, join(backupDir, controlBackups[0]!));
  const verified = ControlPlaneStore.verifyBackup(controlManifest, {
    databaseLineageId: liveLineage,
    minimumLastTransactionSequence: 1,
  });
  assert.equal(verified.quickCheck, "ok");
  assert.equal(verified.manifest.databaseLineageId, liveLineage);

  // The live databases were never moved or removed.
  assert.equal(existsSync(queuePath), true);
  assert.equal(existsSync(controlPath), true);
  const reopened = new QueueStore(queuePath);
  assert.equal(reopened.metadata().databaseId, liveQueueId);
  reopened.close();
});

test("deploy/bin/snowcat-backup refuses to run without its required environment and leaves no partial manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-deploy-backup-env-test-"));
  const base = childEnvironment();
  for (const name of ["SNOWCAT_HOME", "SNOWCAT_QUEUE_DB", "SNOWCAT_CONTROL_DB", "SNOWCAT_BACKUP_DIR", "SNOWCAT_BACKUP_RETAIN_DAYS"]) {
    delete base[name];
  }
  const missingHome = spawnSync("bash", [SCRIPT], { cwd: directory, encoding: "utf8", env: base });
  assert.notEqual(missingHome.status, 0);
  assert.match(missingHome.stderr, /SNOWCAT_HOME/);
  const missingQueue = spawnSync("bash", [SCRIPT], { cwd: directory, encoding: "utf8", env: { ...base, SNOWCAT_HOME: process.cwd() } });
  assert.notEqual(missingQueue.status, 0);
  assert.match(missingQueue.stderr, /SNOWCAT_QUEUE_DB/);
  const badRetention = spawnSync("bash", [SCRIPT], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...base,
      SNOWCAT_HOME: process.cwd(),
      SNOWCAT_QUEUE_DB: join(directory, "queue.db"),
      SNOWCAT_CONTROL_DB: join(directory, "control-plane.db"),
      SNOWCAT_BACKUP_DIR: join(directory, "backups"),
      SNOWCAT_BACKUP_RETAIN_DAYS: "two weeks",
    },
  });
  assert.notEqual(badRetention.status, 0);
  assert.match(badRetention.stderr, /SNOWCAT_BACKUP_RETAIN_DAYS/);
  assert.equal(existsSync(join(directory, "backups")), false);

  // A failing backup command (queue and control-plane paths collide) leaves no partial manifest behind.
  const collide = join(directory, "same.db");
  new QueueStore(collide).close();
  const failed = spawnSync("bash", [SCRIPT], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...base,
      SNOWCAT_HOME: process.cwd(),
      SNOWCAT_QUEUE_DB: collide,
      SNOWCAT_CONTROL_DB: collide,
      SNOWCAT_BACKUP_DIR: join(directory, "backups"),
    },
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /control backup .* failed/);
  const written = (await readdir(join(directory, "backups"))).sort();
  assert.equal(written.some((name) => name.endsWith(".partial")), false);
  assert.equal(written.filter((name) => name.startsWith("queue-")).length, 2, written.join(", "));
  assert.equal(written.some((name) => name.startsWith("control-plane-")), false);
});

