import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlPlaneStore } from "../src/control/store.ts";
import { QueueStore, SCHEMA_VERSION } from "../src/queue/store.ts";
import { disabledDeclaration, enrollExampleRepository } from "./helpers/core-fixtures.ts";
import { childEnvironment } from "./helpers/child-environment.ts";

test("administrative queue listings do not expose a live lease token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cli-test-"));
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
    env: childEnvironment({ SNOWCAT_QUEUE_DB: path }),
  });
  const listed = JSON.parse(output) as Array<Record<string, unknown>>;

  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.id, claimed.id);
  assert.equal(listed[0]?.leaseOwner, "claude:updex:cli-test");
  assert.equal(listed[0]?.leaseToken, undefined);
  assert.equal(output.includes(claimed.leaseToken!), false);
});

test("the list command rejects an unknown status instead of printing an empty array", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cli-status-test-"));
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
  const env = childEnvironment({ SNOWCAT_QUEUE_DB: path });
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
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cli-blocked-test-"));
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

  const env = childEnvironment({ SNOWCAT_QUEUE_DB: path });
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
  assert.deepEqual(
    JSON.parse(requeued.stdout).operatorNotes.map((note: Record<string, unknown>) => [note.actor, note.action, note.reason]),
    [["operator:cli", "requeue", "Operator supplied input."]],
  );
  assert.deepEqual(JSON.parse(requeued.stdout).previousResults, [{ summary: "Needs input.", evidence: [], artifacts: [] }]);

  const prioritized = run("prioritize", first.id, "7", "Operator wants this next.");
  assert.equal(prioritized.status, 0, prioritized.stderr);
  const prioritizedItem = JSON.parse(prioritized.stdout);
  assert.equal(prioritizedItem.status, "queued");
  assert.equal(prioritizedItem.priority, 7);
  assert.equal(prioritized.stdout.includes("leaseToken"), false);
  assert.deepEqual(
    [prioritizedItem.operatorNotes.at(-1).actor, prioritizedItem.operatorNotes.at(-1).action, prioritizedItem.operatorNotes.at(-1).reason],
    ["operator:cli", "prioritize", "Operator wants this next."],
  );
  const badPriority = run("prioritize", first.id, "high", "Operator wants this next.");
  assert.notEqual(badPriority.status, 0);
  assert.match(badPriority.stderr, /priority must be an integer/);
  const fractional = run("prioritize", first.id, "1.5", "Operator wants this next.");
  assert.notEqual(fractional.status, 0);
  assert.match(fractional.stderr, /priority must be an integer/);
  const missingReason = run("prioritize", first.id, "3");
  assert.notEqual(missingReason.status, 0);
  assert.match(missingReason.stderr, /prioritize reason is required/);

  const noted = run("note", first.id, "PR #5 already exists; re-report it.");
  assert.equal(noted.status, 0, noted.stderr);
  const notedItem = JSON.parse(noted.stdout);
  assert.equal(notedItem.status, "queued");
  assert.equal(notedItem.operatorNotes.length, 3);
  assert.deepEqual(
    [notedItem.operatorNotes[2].actor, notedItem.operatorNotes[2].action, notedItem.operatorNotes[2].reason],
    ["operator:cli", "note", "PR #5 already exists; re-report it."],
  );
  assert.equal(noted.stdout.includes("leaseToken"), false);
  const missingText = run("note", first.id);
  assert.notEqual(missingText.status, 0);
  assert.match(missingText.stderr, /note text is required/);
  const cancelled = run("cancel", second.id, "No longer needed.");
  assert.equal(cancelled.status, 0);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
  assert.equal(JSON.parse(cancelled.stdout).result.summary, "No longer needed.");

  const usage = run("help");
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /requeue <work-item-id> <reason>/);
  assert.match(usage.stderr, /cancel <work-item-id> <reason>/);
  assert.match(usage.stderr, /note <work-item-id> <text>/);
  assert.match(usage.stderr, /prioritize <work-item-id> <priority> <reason>/);
});

test("operator CLI can defer admitted work and approve it later", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cli-defer-test-"));
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

  const env = childEnvironment({ SNOWCAT_QUEUE_DB: path });
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

test("operator CLI --if-updated-at refuses a stale approve, prioritize, and note, and applies a fresh one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cli-precondition-test-"));
  const path = join(directory, "queue.db");
  let now = new Date("2026-08-18T00:00:00.000Z");
  const queue = new QueueStore(path, () => now);
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
  now = new Date(now.getTime() + 1000);
  const proposed = queue.defer(seed.id, "operator:test", "Hold.");
  assert.equal(proposed.status, "proposed");
  assert.notEqual(proposed.updatedAt, seed.updatedAt);
  queue.close();

  const env = childEnvironment({ SNOWCAT_QUEUE_DB: path });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });
  const show = () => JSON.parse(run("show", seed.id).stdout) as { item: Record<string, unknown>; events: unknown[] };

  // Stale render (the pre-defer updatedAt): refused, item stays proposed, no event.
  const before = show();
  const stale = run("approve", seed.id, "--if-updated-at", seed.updatedAt);
  assert.notEqual(stale.status, 0);
  assert.equal(stale.stdout, "");
  assert.match(stale.stderr, new RegExp(`item changed since it was read: ${seed.id} is now proposed \\(updated ${proposed.updatedAt}\\)`));
  assert.deepEqual(show(), before);
  assert.equal(before.item.status, "proposed");

  // Flag validation happens before any store call.
  const missing = run("approve", seed.id, "--if-updated-at");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--if-updated-at requires a value/);
  const garbage = run("approve", seed.id, "--if-updated-at", "yesterday");
  assert.notEqual(garbage.status, 0);
  assert.match(garbage.stderr, /--if-updated-at must be an ISO 8601 timestamp/);
  assert.deepEqual(show(), before);

  // Fresh render: applied. The flag may sit anywhere among the reason words.
  const approved = run("approve", seed.id, "--if-updated-at", proposed.updatedAt);
  assert.equal(approved.status, 0, approved.stderr);
  const approvedItem = JSON.parse(approved.stdout) as { status: string; updatedAt: string };
  assert.equal(approvedItem.status, "queued");
  const staleNote = run("note", seed.id, "still", "--if-updated-at", proposed.updatedAt, "waiting");
  assert.notEqual(staleNote.status, 0);
  assert.match(staleNote.stderr, /item changed since it was read/);
  const prioritized = run("prioritize", seed.id, "3", "--if-updated-at", approvedItem.updatedAt, "front", "of", "line");
  assert.equal(prioritized.status, 0, prioritized.stderr);
  const prioritizedItem = JSON.parse(prioritized.stdout) as { priority: number; updatedAt: string; operatorNotes: Array<{ reason: string }> };
  assert.equal(prioritizedItem.priority, 3);
  assert.equal(prioritizedItem.operatorNotes.at(-1)?.reason, "front of line");
  const noted = run("note", seed.id, "still", "--if-updated-at", prioritizedItem.updatedAt, "waiting");
  assert.equal(noted.status, 0, noted.stderr);
  assert.equal((JSON.parse(noted.stdout) as { operatorNotes: Array<{ reason: string }> }).operatorNotes.at(-1)?.reason, "still waiting");
  const usage = run("help");
  assert.match(usage.stderr, /approve <work-item-id> \[--if-updated-at <iso>\]/);
});


test("operator CLI reports metadata, backs up to a new path, and verifies the copy without printing lease tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cli-backup-test-"));
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
  const env = childEnvironment({ SNOWCAT_QUEUE_DB: path });
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
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cli-import-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  queue.setRepositoryEnabled("frostyard/updex", true);
  queue.close();
  const env = childEnvironment({ SNOWCAT_QUEUE_DB: path });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });

  const noLabel = run("import-issues", "frostyard/updex");
  assert.notEqual(noLabel.status, 0);
  assert.match(noLabel.stderr, /--label is required/);
  const unknownFlag = run("import-issues", "frostyard/updex", "--label", "snowcat", "--bogus", "1");
  assert.notEqual(unknownFlag.status, 0);
  assert.match(unknownFlag.stderr, /unknown flag: --bogus/);
  const badPriority = run("import-issues", "frostyard/updex", "--label", "snowcat", "--priority", "high");
  assert.notEqual(badPriority.status, 0);
  assert.match(badPriority.stderr, /priority must be an integer/);
  const danglingValue = run("import-issues", "frostyard/updex", "--label");
  assert.notEqual(danglingValue.status, 0);
  assert.match(danglingValue.stderr, /--label requires a value/);

  const fetchFixture = `data:text/javascript,${encodeURIComponent(`
    globalThis.fetch = async () => new Response(JSON.stringify([{
      number: 136,
      title: "Record observations",
      body: "",
      html_url: "https://github.com/frostyard/updex/issues/136",
      state: "open",
      labels: [{ name: "snowcat" }]
    }]), { status: 200, headers: { "content-type": "application/json" } });
  `)}`;
  const imported = spawnSync(
    process.execPath,
    ["--import", fetchFixture, "--import", "tsx", "src/queue/cli.ts", "import-issues", "frostyard/updex", "--label", "snowcat"],
    { cwd: process.cwd(), encoding: "utf8", env },
  );
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal((JSON.parse(imported.stdout) as { observed: number }).observed, 1);

  // --enrolled: needs a label, and SNOWCAT_CONTROL_DB naming the control plane; both are refused before any GitHub read.
  const enrolledNoLabel = run("import-issues", "--enrolled");
  assert.notEqual(enrolledNoLabel.status, 0);
  assert.match(enrolledNoLabel.stderr, /--label is required/);
  const enrolledUnconfigured = run("import-issues", "--enrolled", "--label", "snowcat");
  assert.notEqual(enrolledUnconfigured.status, 0);
  assert.equal(enrolledUnconfigured.stdout, "");
  assert.match(enrolledUnconfigured.stderr, /import-issues --enrolled requires SNOWCAT_CONTROL_DB/);
  const enrolledMemory = spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", "import-issues", "--enrolled", "--label", "snowcat"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...env, SNOWCAT_CONTROL_DB: ":memory:" },
  });
  assert.notEqual(enrolledMemory.status, 0);
  assert.match(enrolledMemory.stderr, /requires SNOWCAT_CONTROL_DB/);
  const usage = run("help");
  assert.match(usage.stderr, /import-issues --enrolled --label <label> \[--priority <n>\]   \(requires SNOWCAT_CONTROL_DB; SNOWCAT_GITHUB_TOKEN in practice\)/);

  const badCooldown = run("seed-dogfood", "frostyard/updex", "--cooldown-hours", "-2");
  assert.notEqual(badCooldown.status, 0);
  assert.match(badCooldown.stderr, /must not be negative/);
  const seeded = run("seed-dogfood", "frostyard/updex", "--cooldown-hours", "0");
  assert.equal(seeded.status, 0, seeded.stderr);
  const result = JSON.parse(seeded.stdout) as { created: unknown[]; skippedKinds: string[]; cooledKinds: string[] };
  assert.equal(result.created.length, 8);
  assert.deepEqual(result.cooledKinds, []);
});

test("operator CLI verify-artifacts validates its flags and reports an empty pass without touching GitHub", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cli-verify-test-"));
  const path = join(directory, "queue.db");
  new QueueStore(path).close();
  const env = childEnvironment({ SNOWCAT_QUEUE_DB: path });
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
  assert.deepEqual(JSON.parse(empty.stdout), {
    checked: 0,
    updated: [],
    unavailable: [],
    rejected: [],
    cure: { inspected: 0, foreign: { listed: 0, inspected: 0 }, enqueued: [], healthy: [], skipped: [], unavailable: [], notes: [] },
    review: { inspected: 0, enqueued: [], markedReady: [], readyToMark: [], needsHuman: [], skipped: [], unavailable: [], unreported: [], unreportedPending: [] },
  });
});

test("operator CLI cure-foreign is a repository-level setting: on|off for an opted-in repository only", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cli-cure-foreign-test-"));
  const path = join(directory, "queue.db");
  const seeded = new QueueStore(path);
  seeded.setRepositoryEnabled("frostyard/updex", true);
  seeded.close();
  const env = childEnvironment({ SNOWCAT_QUEUE_DB: path });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });

  const on = run("cure-foreign", "frostyard/updex", "on");
  assert.equal(on.status, 0, on.stderr);
  assert.deepEqual(JSON.parse(on.stdout), { repository: "frostyard/updex", cureForeign: true });

  const notOptedIn = run("cure-foreign", "frostyard/lodge", "on");
  assert.notEqual(notOptedIn.status, 0);
  assert.match(notOptedIn.stderr, /not opted in/);

  const badValue = run("cure-foreign", "frostyard/updex", "yes");
  assert.notEqual(badValue.status, 0);
  assert.match(badValue.stderr, /on or off/);
  const missing = run("cure-foreign", "frostyard/updex");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /on\|off is required/);

  const off = run("cure-foreign", "frostyard/updex", "off");
  assert.equal(off.status, 0, off.stderr);
  assert.deepEqual(JSON.parse(off.stdout), { repository: "frostyard/updex", cureForeign: false });
  const inspect = new QueueStore(path);
  assert.deepEqual(inspect.repositoryCureSettings(), [{ repository: "frostyard/updex", cureForeign: false }]);
  inspect.close();

  const usage = run("nonsense");
  assert.match(usage.stderr, /cure-foreign <owner\/repo> on\|off/);
});

test("operator CLI review-gate is a repository-level setting: on|off for an opted-in repository only, and verify-artifacts can skip the review step", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cli-review-gate-test-"));
  const path = join(directory, "queue.db");
  const seeded = new QueueStore(path);
  seeded.setRepositoryEnabled("frostyard/updex", true);
  seeded.close();
  const env = childEnvironment({ SNOWCAT_QUEUE_DB: path });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });

  const on = run("review-gate", "frostyard/updex", "on");
  assert.equal(on.status, 0, on.stderr);
  assert.deepEqual(JSON.parse(on.stdout), { repository: "frostyard/updex", reviewGate: true });

  const notOptedIn = run("review-gate", "frostyard/lodge", "on");
  assert.notEqual(notOptedIn.status, 0);
  assert.match(notOptedIn.stderr, /not opted in/);

  const badValue = run("review-gate", "frostyard/updex", "yes");
  assert.notEqual(badValue.status, 0);
  assert.match(badValue.stderr, /on or off/);
  const missing = run("review-gate", "frostyard/updex");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /on\|off is required/);

  // With the gate on and no draft pull request reported, the review step
  // inspects nothing and creates nothing. Its unreported pass (ADR-0065) is
  // the one step that reads GitHub without a candidate — one bounded open
  // pull-request listing for the gated repository — so `unreported` and the
  // sweep's `unavailable` depend on what GitHub answers here and are not
  // pinned; nothing is created either way.
  const swept = run("verify-artifacts", "--no-cure");
  assert.equal(swept.status, 0, swept.stderr);
  const sweptOutput = JSON.parse(swept.stdout) as {
    checked: number;
    updated: unknown[];
    unavailable: unknown[];
    rejected: unknown[];
    review: { inspected: number; enqueued: unknown[]; markedReady: unknown[]; readyToMark: unknown[]; needsHuman: unknown[]; unreported: unknown[]; unreportedPending: unknown[] };
  };
  assert.deepEqual(
    { ...sweptOutput, review: { ...sweptOutput.review, skipped: undefined, unavailable: undefined, unreported: undefined } },
    {
      checked: 0,
      updated: [],
      unavailable: [],
      rejected: [],
      review: { inspected: 0, enqueued: [], markedReady: [], readyToMark: [], needsHuman: [], skipped: undefined, unavailable: undefined, unreported: undefined, unreportedPending: [] },
    },
  );
  assert.ok(Array.isArray(sweptOutput.review.unreported), "the review sweep always reports its unreported list");
  assert.ok(Array.isArray(sweptOutput.review.unreportedPending), "the review sweep always reports its pending list");
  const noReview = run("verify-artifacts", "--no-cure", "--no-review");
  assert.equal(noReview.status, 0, noReview.stderr);
  assert.deepEqual(JSON.parse(noReview.stdout), { checked: 0, updated: [], unavailable: [], rejected: [] });

  const off = run("review-gate", "frostyard/updex", "off");
  assert.equal(off.status, 0, off.stderr);
  assert.deepEqual(JSON.parse(off.stdout), { repository: "frostyard/updex", reviewGate: false });
  const inspect = new QueueStore(path);
  assert.deepEqual(inspect.repositoryReviewGateSettings(), [{ repository: "frostyard/updex", reviewGate: false }]);
  inspect.close();

  const usage = run("nonsense");
  assert.match(usage.stderr, /review-gate <owner\/repo> on\|off/);
  assert.match(usage.stderr, /verify-artifacts \[--repository <owner\/repo>\] \[--limit <1-100>\] \[--no-cure\] \[--no-review\]/);
});

test("operator CLI attach-artifact verifies against GitHub first: refuses another repository and a 404, attaches unverified on 5xx, and verify-artifacts later promotes it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cli-attach-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  queue.setRepositoryEnabled("frostyard/updex", true);
  // A local-only follow-up (no open-pr) completed with no artifacts; the operator opened the PR by hand.
  const seed = queue.enqueueSeed({
    repository: "frostyard/updex",
    kind: "quality-implementation",
    objective: "Make the merged-state signal instance-scoped.",
    instructions: "Implement on a local branch; do not open a pull request.",
    acceptanceCriteria: ["Tests pass."],
    allowedActions: ["read", "write", "run-tests"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const lease = queue.claim({ worker: "claude:updex:local", repository: "frostyard/updex" })!;
  queue.complete({
    id: seed.id,
    leaseToken: lease.leaseToken!,
    worker: "claude:updex:local",
    result: { summary: "Left on branch fix/instance-scoped.", evidence: ["make check green"], artifacts: [] },
    followUps: [],
  });
  const leaseToken = lease.leaseToken!;
  queue.close();

  const fixturePath = join(directory, "github.json");
  const logPath = join(directory, "requests.log");
  const setGitHub = (answers: Record<string, { status: number; body?: unknown }>) => writeFile(fixturePath, JSON.stringify(answers));
  const requests = async () => (await readFile(logPath, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const env = childEnvironment({
    SNOWCAT_QUEUE_DB: path,
    SNOWCAT_GITHUB_TOKEN: "test-token", // so a 404 counts as absence, exactly as complete_work treats it
    SNOWCAT_TEST_FAKE_GITHUB: fixturePath,
    SNOWCAT_TEST_FAKE_GITHUB_LOG: logPath,
  });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "--import", "./test/helpers/fake-github-fetch.ts", "src/queue/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });
  const show = () => {
    const shown = run("show", seed.id);
    assert.equal(shown.status, 0, shown.stderr);
    return JSON.parse(shown.stdout) as { item: { delivery?: string; result: { artifacts: Array<Record<string, unknown>> } }; events: Array<{ type: string }> };
  };

  // Usage names the command; a malformed kind or a non-GitHub URL is refused before GitHub is asked.
  await setGitHub({});
  const usage = run();
  assert.match(usage.stderr, /attach-artifact <work-item-id> <url> \[--kind pull-request\|issue\] \[--description <text>\] \[--if-updated-at <iso>\]/);
  const badKind = run("attach-artifact", seed.id, "https://github.com/frostyard/updex/pull/326", "--kind", "commit");
  assert.notEqual(badKind.status, 0);
  assert.match(badKind.stderr, /--kind must be pull-request or issue/);
  const notGitHub = run("attach-artifact", seed.id, "https://example.com/frostyard/updex/pull/326");
  assert.notEqual(notGitHub.status, 0);
  assert.match(notGitHub.stderr, /artifact pull-request URL is not a frostyard\/updex pull-request URL/);
  assert.deepEqual(await requests(), [], "nothing is asked of GitHub for a URL outside the repository");

  // Another repository's pull request is refused with the reason and nothing is written.
  const foreign = run("attach-artifact", seed.id, "https://github.com/frostyard/lodge/pull/1");
  assert.notEqual(foreign.status, 0);
  assert.match(foreign.stderr, /artifact rejected: artifact pull-request URL is not a frostyard\/updex pull-request URL/);
  assert.deepEqual(await requests(), []);
  assert.deepEqual(show().item.result.artifacts, []);

  // GitHub says 404 (with a token): refused, nothing written.
  const missing = run("attach-artifact", seed.id, "https://github.com/frostyard/updex/pull/999");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /artifact rejected: pull-request https:\/\/github\.com\/frostyard\/updex\/pull\/999 does not exist on GitHub/);
  assert.deepEqual(await requests(), ["/repos/frostyard/updex/pulls/999"]);
  assert.deepEqual(show().item.result.artifacts, []);
  assert.equal(show().events.some((event) => event.type === "artifact.attached"), false);

  // GitHub answers 5xx: attached as unverified with the reason, delivery reads unverified.
  await setGitHub({ "/repos/frostyard/updex/pulls/326": { status: 503 } });
  const outage = run("attach-artifact", seed.id, "https://github.com/frostyard/updex/pull/326", "--description", "Opened by the operator from the local branch");
  assert.equal(outage.status, 0, outage.stderr);
  const attached = JSON.parse(outage.stdout) as { item: Record<string, unknown> & { delivery?: string; result: { artifacts: Array<Record<string, unknown>> } }; verification: Record<string, unknown> };
  assert.equal(attached.item.delivery, "unverified");
  assert.deepEqual(attached.verification, { status: "unverified", attemptedAt: attached.verification.attemptedAt, reason: "GitHub API returned HTTP 503" });
  assert.equal(attached.item.result.artifacts.length, 1);
  assert.equal(attached.item.result.artifacts[0]!.kind, "pull-request", "kind defaulted from the /pull/ path");
  assert.equal(attached.item.result.artifacts[0]!.description, "Opened by the operator from the local branch");
  assert.equal(outage.stdout.includes("leaseToken"), false);
  assert.equal(outage.stdout.includes(leaseToken), false);
  assert.deepEqual(show().events.filter((event) => event.type === "artifact.attached").length, 1);

  // The same URL a second time is refused; a stale --if-updated-at is refused per rule 39.
  const twice = run("attach-artifact", seed.id, "https://github.com/frostyard/updex/pull/326");
  assert.notEqual(twice.status, 0);
  assert.match(twice.stderr, /artifact already reported: https:\/\/github\.com\/frostyard\/updex\/pull\/326/);
  await setGitHub({
    "/repos/frostyard/updex/pulls/326": { status: 503 },
    "/repos/frostyard/updex/issues/300": { status: 200, body: { number: 300, html_url: "https://github.com/frostyard/updex/issues/300", state: "closed", repository_url: "https://api.github.com/repos/frostyard/updex" } },
  });
  const stale = run("attach-artifact", seed.id, "https://github.com/frostyard/updex/issues/300", "--if-updated-at", "2020-01-01T00:00:00.000Z");
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, new RegExp(`item changed since it was read: ${seed.id} is now completed`));
  assert.equal(show().item.result.artifacts.length, 1);

  // A later verify-artifacts pass promotes the unverified attachment to verified · merged.
  await setGitHub({
    "/repos/frostyard/updex/pulls/326": {
      status: 200,
      body: { number: 326, html_url: "https://github.com/frostyard/updex/pull/326", state: "closed", merged: true, merged_at: "2026-08-18T13:00:00Z", closed_at: "2026-08-18T13:00:00Z", head: { sha: "0123456789abcdef0123456789abcdef01234567" }, base: { repo: { full_name: "frostyard/updex" } } },
    },
  });
  const verified = run("verify-artifacts", "--repository", "frostyard/updex");
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(JSON.parse(verified.stdout).updated, [{ id: seed.id, url: "https://github.com/frostyard/updex/pull/326", status: "verified", state: "merged" }]);
  const final = show();
  assert.equal(final.item.delivery, "merged");
  assert.equal(final.item.result.artifacts[0]!.verification && (final.item.result.artifacts[0]!.verification as { status: string }).status, "verified");
  assert.deepEqual(final.events.map((event) => event.type).slice(-2), ["artifact.attached", "artifact.verified"]);
  assert.equal(JSON.stringify(final).includes(leaseToken), false);
});

test("operator CLI list filters by repository and kind, and show prints an item with its events but no lease token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cli-show-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  for (const repository of ["frostyard/updex", "frostyard/lodge"]) queue.setRepositoryEnabled(repository, true);
  const seedOne = (repository: string, kind: string) =>
    queue.enqueueSeed({
      repository,
      kind,
      objective: `${kind} for ${repository}`,
      instructions: "Read only.",
      acceptanceCriteria: ["One gap."],
      allowedActions: ["read"],
      delegableActions: [],
      createdBy: "operator:test",
    });
  const target = seedOne("frostyard/updex", "quality-gap-discovery");
  seedOne("frostyard/updex", "ci-gap-discovery");
  seedOne("frostyard/lodge", "quality-gap-discovery");
  const claimed = queue.claim({ worker: "claude:show-test", repository: "frostyard/updex", kinds: ["quality-gap-discovery"] })!;
  queue.close();
  const env = childEnvironment({ SNOWCAT_QUEUE_DB: path });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", ...args], { cwd: process.cwd(), encoding: "utf8", env });

  const byRepository = run("list", "--repository", "frostyard/updex");
  assert.equal(byRepository.status, 0, byRepository.stderr);
  assert.equal((JSON.parse(byRepository.stdout) as unknown[]).length, 2);
  const byKind = run("list", "queued", "--kind", "quality-gap-discovery", "--limit", "10");
  assert.equal(byKind.status, 0, byKind.stderr);
  const kinds = JSON.parse(byKind.stdout) as Array<{ repository: string }>;
  assert.deepEqual(kinds.map((item) => item.repository), ["frostyard/lodge"]);
  const badLimit = run("list", "--limit", "0");
  assert.notEqual(badLimit.status, 0);
  assert.match(badLimit.stderr, /limit must be between 1 and 100/);

  const shown = run("show", target.id);
  assert.equal(shown.status, 0, shown.stderr);
  const detail = JSON.parse(shown.stdout) as { item: Record<string, unknown>; events: Array<{ type: string }> };
  assert.equal(detail.item.id, target.id);
  assert.equal(detail.item.leaseOwner, "claude:show-test");
  assert.equal(detail.item.leaseToken, undefined);
  assert.deepEqual(detail.events.map((event) => event.type), ["work.queued", "work.claimed"]);
  assert.equal(shown.stdout.includes(claimed.leaseToken!), false);
  const missing = run("show", "00000000-0000-4000-8000-000000000000");
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /not found/);
});

test("operator CLI events reads the ledger since a sequence as JSON without lease tokens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cli-events-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  for (const repository of ["frostyard/updex", "frostyard/lodge"]) queue.setRepositoryEnabled(repository, true);
  const seedOne = (repository: string) =>
    queue.enqueueSeed({
      repository,
      kind: "quality-gap-discovery",
      objective: `quality for ${repository}`,
      instructions: "Read only.",
      acceptanceCriteria: ["One gap."],
      allowedActions: ["read"],
      delegableActions: [],
      createdBy: "operator:test",
    });
  const updex = seedOne("frostyard/updex");
  seedOne("frostyard/lodge");
  const claimed = queue.claim({ worker: "claude:events-test", repository: "frostyard/updex" })!;
  queue.close();
  const env = childEnvironment({ SNOWCAT_QUEUE_DB: path });
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", ...args], { cwd: process.cwd(), encoding: "utf8", env });

  const all = run("events");
  assert.equal(all.status, 0, all.stderr);
  const events = JSON.parse(all.stdout) as Array<Record<string, unknown>>;
  assert.deepEqual(events.map((event) => event.type), ["work.queued", "work.queued", "work.claimed"]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
  assert.equal(events[2]?.workItemId, updex.id);
  assert.equal(events[2]?.repository, "frostyard/updex");
  assert.equal(events[2]?.kind, "quality-gap-discovery");
  assert.equal(events[2]?.status, "claimed");
  assert.equal(all.stdout.includes(claimed.leaseToken!), false);
  assert.equal(all.stdout.includes("leaseToken"), false);

  const since = run("events", "--since", "1");
  assert.equal(since.status, 0, since.stderr);
  assert.deepEqual((JSON.parse(since.stdout) as Array<{ sequence: number }>).map((event) => event.sequence), [2, 3]);
  const filtered = run("events", "--since", "0", "--repository", "frostyard/lodge", "--limit", "500");
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.deepEqual((JSON.parse(filtered.stdout) as Array<{ sequence: number }>).map((event) => event.sequence), [2]);
  const tail = run("events", "--since", "3");
  assert.equal(tail.status, 0, tail.stderr);
  assert.deepEqual(JSON.parse(tail.stdout), []);

  const badLimit = run("events", "--limit", "501");
  assert.notEqual(badLimit.status, 0);
  assert.match(badLimit.stderr, /limit must be between 1 and 500/);
  const badSince = run("events", "--since", "-1");
  assert.notEqual(badSince.status, 0);
  assert.match(badSince.stderr, /since must not be negative/);
  const badFlag = run("events", "--kind", "x");
  assert.notEqual(badFlag.status, 0);
  assert.match(badFlag.stderr, /unknown flag: --kind/);
});

test("operator CLI watch tails new events as JSON lines and stops cleanly when signalled", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cli-watch-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/updex", true);
  const seeded = queue.enqueueSeed({
    repository: "frostyard/updex",
    kind: "quality-gap-discovery",
    objective: "quality for updex",
    instructions: "Read only.",
    acceptanceCriteria: ["One gap."],
    allowedActions: ["read"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const env = childEnvironment({ SNOWCAT_QUEUE_DB: path });

  const invalid = spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", "watch", "--interval", "0"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env,
  });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /interval must be at least 1 second/);

  const child = spawn(
    process.execPath,
    ["--import", "tsx", "src/queue/cli.ts", "watch", "--repository", "frostyard/updex", "--interval", "1"],
    { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));
  const lines: string[] = [];
  const reader = createInterface({ input: child.stdout });
  // Every observable change (stdout line, stderr chunk, exit) pokes the current waiter.
  let announce: (() => void) | undefined;
  reader.on("line", (line) => {
    lines.push(line);
    announce?.();
  });
  child.stderr.on("data", () => announce?.());
  child.on("exit", () => announce?.());
  const waitFor = (predicate: () => boolean, what: string, timeoutMs: number) =>
    new Promise<void>((resolve, reject) => {
      if (predicate()) return resolve();
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; stderr: ${stderr.join("")}`)), timeoutMs);
      announce = () => {
        if (!predicate()) return;
        clearTimeout(timer);
        announce = undefined;
        resolve();
      };
    });
  try {
    // The tail starts at the current last sequence; the seed above predates it and must not print.
    await waitFor(() => stderr.join("").includes("watching frostyard/updex from sequence 1 every 2s"), "watch startup", 15_000);
    assert.equal(child.exitCode, null, `watch exited early: ${stderr.join("")}`);
    const claimed = queue.claim({ worker: "claude:watch-test", repository: "frostyard/updex" })!;
    assert.equal(claimed.id, seeded.id);
    await waitFor(() => lines.length >= 1, "the claim event", 10_000);
    const event = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(event.type, "work.claimed");
    assert.equal(event.sequence, 2);
    assert.equal(event.workItemId, seeded.id);
    assert.equal(event.repository, "frostyard/updex");
    assert.equal(event.status, "claimed");
    assert.equal(lines[0]!.includes(claimed.leaseToken!), false);
    assert.equal(lines[0]!.includes("leaseToken"), false);
  } finally {
    child.kill("SIGTERM");
  }
  const [code, signal] = (await exited) as [number | null, NodeJS.Signals | null];
  assert.equal(signal, null, "watch handles SIGTERM itself instead of dying from it");
  assert.equal(code, 0);
  assert.equal(lines.length, 1, `only the claim was printed: ${lines.join("\n")}`);
  reader.close();
});

test("operator CLI seed-dogfood --enrolled requires SNOWCAT_CONTROL_DB and seeds only enrolled opt-ins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-cli-enrolled-test-"));
  const path = join(directory, "queue.db");
  const controlPath = join(directory, "control-plane.db");
  const store = new ControlPlaneStore(controlPath, () => new Date("2026-08-17T12:00:00.000Z"));
  await enrollExampleRepository(store, { additionalDeclarations: [disabledDeclaration()] });
  store.close();
  const queue = new QueueStore(path);
  queue.setRepositoryEnabled("frostyard/example", true);
  queue.setRepositoryEnabled("frostyard/retired", true);
  queue.close();
  const baseEnvironment = childEnvironment({ SNOWCAT_QUEUE_DB: path });
  delete baseEnvironment.SNOWCAT_CONTROL_DB;
  const run = (env: Record<string, string>, ...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });

  const unconfigured = run(baseEnvironment, "seed-dogfood", "--enrolled");
  assert.notEqual(unconfigured.status, 0);
  assert.match(unconfigured.stderr, /SNOWCAT_CONTROL_DB/);
  assert.equal(unconfigured.stdout, "");
  const memory = run({ ...baseEnvironment, SNOWCAT_CONTROL_DB: ":memory:" }, "seed-dogfood", "--enrolled");
  assert.notEqual(memory.status, 0);
  assert.match(memory.stderr, /SNOWCAT_CONTROL_DB/);
  const badFlag = run({ ...baseEnvironment, SNOWCAT_CONTROL_DB: controlPath }, "seed-dogfood", "--enrolled", "--bogus", "1");
  assert.notEqual(badFlag.status, 0);
  assert.match(badFlag.stderr, /unknown flag: --bogus/);

  const seeded = run({ ...baseEnvironment, SNOWCAT_CONTROL_DB: controlPath }, "seed-dogfood", "--enrolled", "--cooldown-hours", "0");
  assert.equal(seeded.status, 0, seeded.stderr);
  const result = JSON.parse(seeded.stdout) as {
    seeded: Array<{ repository: string; programs: string[]; created: Array<{ kind: string; status: string }>; skippedKinds: string[]; cooledKinds: string[]; undeclaredKinds: string[] }>;
    notOptedIn: string[];
  };
  assert.deepEqual(result.notOptedIn, []);
  // The example declaration lists `quality` and `ci`; the feeder honors it and names what it left out.
  assert.deepEqual(
    result.seeded.map((entry) => [entry.repository, entry.programs, entry.created.map((item) => item.kind), entry.skippedKinds, entry.cooledKinds, entry.undeclaredKinds]),
    [["frostyard/example", ["quality", "ci"], ["quality-gap-discovery", "ci-gap-discovery"], [], [], ["security-gap-discovery", "architecture-gap-discovery", "conformance-gap-discovery", "triage-discovery", "dependencies-gap-discovery", "docs-drift-discovery"]]],
  );
  assert.equal(seeded.stdout.includes("leaseToken"), false);

  const verify = new QueueStore(path);
  assert.deepEqual(verify.list({ repository: "frostyard/retired" }), []);
  assert.equal(verify.list({ repository: "frostyard/example", status: "queued" }).length, 2);
  verify.close();
});
