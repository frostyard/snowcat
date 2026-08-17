import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { QueueStore, SCHEMA_VERSION } from "../src/queue/store.ts";

test("administrative queue listings do not expose a live lease token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-cli-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  queue.setRepositoryEnabled("frostyard/updex", true);
  queue.enqueueSeed({
    repository: "frostyard/updex",
    kind: "testing-gap-discovery",
    objective: "Identify one testing gap.",
    instructions: "Read and report only.",
    acceptanceCriteria: ["One gap has concrete evidence."],
    allowedActions: ["read"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const claimed = queue.claim({ worker: "claude:updex:cli-test" })!;
  queue.close();

  const output = execFileSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", "list", "claimed"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: stringEnvironment({ ...process.env, FLUENT_QUEUE_DB: path }),
  });
  const listed = JSON.parse(output) as Array<Record<string, unknown>>;

  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, claimed.id);
  assert.equal(listed[0]?.leaseOwner, "claude:updex:cli-test");
  assert.equal(listed[0]?.leaseToken, undefined);
  assert.equal(output.includes(claimed.leaseToken!), false);
});

test("the list command rejects an unknown status instead of printing an empty array", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-cli-status-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  queue.setRepositoryEnabled("frostyard/updex", true);
  queue.enqueueSeed({
    repository: "frostyard/updex",
    kind: "testing-gap-discovery",
    objective: "Identify one testing gap.",
    instructions: "Read and report only.",
    acceptanceCriteria: ["One gap has concrete evidence."],
    allowedActions: ["read"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  queue.close();
  const env = stringEnvironment({ ...process.env, FLUENT_QUEUE_DB: path });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });

  const invalid = run("list", "bogus");
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /unknown status: bogus/);
  assert.match(invalid.stderr, /proposed, queued, claimed, completed, blocked, cancelled/);

  const all = run("list");
  assert.equal(all.status, 0);
  assert.equal((JSON.parse(all.stdout) as unknown[]).length, 1);
  const queued = run("list", "queued");
  assert.equal(queued.status, 0);
  assert.equal((JSON.parse(queued.stdout) as unknown[]).length, 1);
  const completed = run("list", "completed");
  assert.equal(completed.status, 0);
  assert.deepEqual(JSON.parse(completed.stdout), []);
});

test("operator CLI exposes blocked requeue and cancellation without lease tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-cli-blocked-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  queue.setRepositoryEnabled("frostyard/updex", true);
  const first = queue.enqueueSeed({
    repository: "frostyard/updex",
    kind: "quality-gap-discovery",
    objective: "Inspect one gap.",
    instructions: "Read only.",
    acceptanceCriteria: ["One gap."],
    allowedActions: ["read"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const second = queue.enqueueSeed({
    repository: "frostyard/updex",
    kind: "ci-gap-discovery",
    objective: "Inspect one CI gap.",
    instructions: "Read only.",
    acceptanceCriteria: ["One gap."],
    allowedActions: ["read"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const firstClaim = queue.claim({ worker: "claude:updex:first" })!;
  queue.block(first.id, firstClaim.leaseToken!, "claude:updex:first", "Needs input.");
  const secondClaim = queue.claim({ worker: "claude:updex:second" })!;
  queue.block(second.id, secondClaim.leaseToken!, "claude:updex:second", "Needs input.");
  queue.close();

  const env = stringEnvironment({ ...process.env, FLUENT_QUEUE_DB: path });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });
  const requeued = run("requeue", first.id, "Operator supplied input.");
  assert.equal(requeued.status, 0);
  assert.equal(JSON.parse(requeued.stdout).status, "queued");
  assert.equal(requeued.stdout.includes("leaseToken"), false);
  const cancelled = run("cancel", second.id, "No longer needed.");
  assert.equal(cancelled.status, 0);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
  assert.equal(JSON.parse(cancelled.stdout).result.summary, "No longer needed.");

  const usage = run("help");
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /requeue <work-item-id> <reason>/);
  assert.match(usage.stderr, /cancel <work-item-id> <reason>/);
});

test("operator CLI can defer admitted work and approve it later", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-cli-defer-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  queue.setRepositoryEnabled("frostyard/updex", true);
  const seed = queue.enqueueSeed({
    repository: "frostyard/updex",
    kind: "quality-gap-discovery",
    objective: "Inspect one gap.",
    instructions: "Read only.",
    acceptanceCriteria: ["One gap."],
    allowedActions: ["read"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  queue.close();

  const env = stringEnvironment({ ...process.env, FLUENT_QUEUE_DB: path });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });
  const deferred = run("defer", seed.id, "Wait for the current writer.");
  assert.equal(deferred.status, 0);
  assert.equal(JSON.parse(deferred.stdout).status, "proposed");
  assert.equal(deferred.stdout.includes("leaseToken"), false);
  assert.equal((JSON.parse(run("list", "queued").stdout) as unknown[]).length, 0);
  assert.equal((JSON.parse(run("list", "proposed").stdout) as unknown[]).length, 1);

  const approved = run("approve", seed.id);
  assert.equal(approved.status, 0);
  assert.equal(JSON.parse(approved.stdout).status, "queued");
  const usage = run("help");
  assert.match(usage.stderr, /defer <work-item-id> <reason>/);
});

function stringEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

test("operator CLI reports metadata, backs up to a new path, and verifies the copy without printing lease tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-cli-backup-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  queue.setRepositoryEnabled("frostyard/updex", true);
  queue.enqueueSeed({
    repository: "frostyard/updex",
    kind: "testing-gap-discovery",
    objective: "Identify one testing gap.",
    instructions: "Read and report only.",
    acceptanceCriteria: ["One gap has concrete evidence."],
    allowedActions: ["read"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const claimed = queue.claim({ worker: "claude:updex:backup" })!;
  queue.close();
  const env = stringEnvironment({ ...process.env, FLUENT_QUEUE_DB: path });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });

  const metadata = run("metadata");
  assert.equal(metadata.status, 0, metadata.stderr);
  const meta = JSON.parse(metadata.stdout) as Record<string, unknown>;
  assert.equal(meta.databasePath, path);
  assert.equal(meta.schemaVersion, SCHEMA_VERSION);
  assert.equal(meta.workItems, 1);
  assert.match(String(meta.databaseId), /^[0-9a-f-]{36}$/);

  const missing = run("backup");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /backup path is required/);

  const backupPath = join(directory, "backups", "queue.db");
  const backup = run("backup", backupPath);
  assert.equal(backup.status, 0, backup.stderr);
  const manifest = JSON.parse(backup.stdout) as Record<string, unknown>;
  assert.equal(manifest.backupPath, backupPath);
  assert.equal(manifest.databaseId, meta.databaseId);
  assert.equal(manifest.workItems, 1);
  assert.equal(backup.stdout.includes(claimed.leaseToken!), false);

  const again = run("backup", backupPath);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already exists/);

  const verify = run("verify-backup", backupPath);
  assert.equal(verify.status, 0, verify.stderr);
  const inspected = JSON.parse(verify.stdout) as Record<string, unknown>;
  assert.equal(inspected.sha256, manifest.sha256);
  assert.equal(inspected.databaseId, manifest.databaseId);
  assert.equal(inspected.lastEventSequence, manifest.lastEventSequence);
  assert.equal(verify.stdout.includes(claimed.leaseToken!), false);

  const foreign = run("verify-backup", join(directory, "nope.db"));
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, /does not exist/);
});

test("operator CLI validates import-issues and seed-dogfood flags before touching GitHub or the queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-cli-import-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  queue.setRepositoryEnabled("frostyard/updex", true);
  queue.close();
  const env = stringEnvironment({ ...process.env, FLUENT_QUEUE_DB: path });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });

  const noLabel = run("import-issues", "frostyard/updex");
  assert.notEqual(noLabel.status, 0);
  assert.match(noLabel.stderr, /--label is required/);
  const unknownFlag = run("import-issues", "frostyard/updex", "--label", "fluent", "--bogus", "1");
  assert.notEqual(unknownFlag.status, 0);
  assert.match(unknownFlag.stderr, /unknown flag: --bogus/);
  const badPriority = run("import-issues", "frostyard/updex", "--label", "fluent", "--priority", "high");
  assert.notEqual(badPriority.status, 0);
  assert.match(badPriority.stderr, /priority must be an integer/);
  const danglingValue = run("import-issues", "frostyard/updex", "--label");
  assert.notEqual(danglingValue.status, 0);
  assert.match(danglingValue.stderr, /--label requires a value/);

  const badCooldown = run("seed-dogfood", "frostyard/updex", "--cooldown-hours", "-2");
  assert.notEqual(badCooldown.status, 0);
  assert.match(badCooldown.stderr, /must not be negative/);
  const seeded = run("seed-dogfood", "frostyard/updex", "--cooldown-hours", "0");
  assert.equal(seeded.status, 0, seeded.stderr);
  const result = JSON.parse(seeded.stdout) as { created: unknown[]; skippedKinds: string[]; cooledKinds: string[] };
  assert.equal(result.created.length, 4);
  assert.deepEqual(result.cooledKinds, []);
});

test("operator CLI verify-artifacts validates its flags and reports an empty pass without touching GitHub", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-cli-verify-test-"));
  const path = join(directory, "queue.db");
  new QueueStore(path).close();
  const env = stringEnvironment({ ...process.env, FLUENT_QUEUE_DB: path });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });

  const badLimit = run("verify-artifacts", "--limit", "500");
  assert.notEqual(badLimit.status, 0);
  assert.match(badLimit.stderr, /limit must be between 1 and 100/);
  const badRepository = run("verify-artifacts", "--repository", "not-a-repo");
  assert.notEqual(badRepository.status, 0);
  assert.match(badRepository.stderr, /repository/i);

  const empty = run("verify-artifacts");
  assert.equal(empty.status, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), { checked: 0, updated: [], unavailable: [], rejected: [] });
});
