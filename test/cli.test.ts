import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { QueueStore } from "../src/queue/store.ts";

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
