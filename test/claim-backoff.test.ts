import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CLAIM_BACKOFF_RELEASES, CLAIM_BACKOFF_WINDOW_SECONDS, QueueStore, SCHEMA_VERSION } from "../src/queue/store.ts";
import { childEnvironment } from "./helpers/child-environment.ts";

function seed(queue: QueueStore, repository: string, objective: string) {
  return queue.enqueueSeed({
    repository,
    kind: "testing-gap-discovery",
    objective,
    instructions: "Read and report only.",
    acceptanceCriteria: ["One gap has concrete evidence."],
    allowedActions: ["read"],
    delegableActions: [],
    executionTarget: "read-only",
    createdBy: "operator:test",
  });
}

test("three rapid worker releases back an item off claim selection; the window slides it back in (rule 69)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-claim-backoff-test-"));
  let now = new Date("2026-08-23T12:00:00.000Z");
  const queue = new QueueStore(join(directory, "queue.db"), () => now);
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/updex", true);
  const churner = seed(queue, "frostyard/updex", "The item workers keep declining.");
  // The bystander is created later, so claim order alone would always pick
  // the churner first — until the backoff takes it out of the running.
  now = new Date("2026-08-23T12:00:01.000Z");
  const bystander = seed(queue, "frostyard/updex", "The item workers can do.");

  for (let attempt = 0; attempt < CLAIM_BACKOFF_RELEASES; attempt += 1) {
    now = new Date(Date.parse("2026-08-23T12:01:00.000Z") + attempt * 60_000);
    const claimed = queue.claim({ worker: `claude:updex:decliner-${attempt}` })!;
    assert.equal(claimed.id, churner.id, "the churner keeps winning claim order until it backs off");
    queue.release(churner.id, claimed.leaseToken!, `claude:updex:decliner-${attempt}`, `Cannot honor the contract (attempt ${attempt}).`);
  }

  // Backed off: the churner is out of the running, the bystander claims.
  const next = queue.claim({ worker: "claude:updex:worker" })!;
  assert.equal(next.id, bystander.id);
  assert.equal(queue.claim({ worker: "claude:updex:worker-2" }), undefined, "nothing else is claimable while the backoff holds");

  // The churn view names the item, the decliners, their reasons, and the lapse.
  const churning = queue.churningItems();
  assert.equal(churning.length, 1);
  assert.equal(churning[0]!.item.id, churner.id);
  assert.equal(churning[0]!.item.leaseToken, undefined, "the view never carries a token");
  assert.equal(churning[0]!.releases.length, CLAIM_BACKOFF_RELEASES);
  assert.equal(churning[0]!.releases[0]!.worker, "claude:updex:decliner-2", "newest release first");
  assert.match(churning[0]!.releases[0]!.reason ?? "", /Cannot honor the contract \(attempt 2\)/);
  // The decisive release is the oldest of the three: the backoff lapses when it leaves the window.
  const oldestRelease = churning[0]!.releases.at(-1)!.at;
  const expectedUntil = new Date(Date.parse(oldestRelease) + CLAIM_BACKOFF_WINDOW_SECONDS * 1000).toISOString();
  assert.equal(churning[0]!.backoffUntil, expectedUntil);
  assert.equal(queue.churningItems({ repository: "frostyard/other" }).length, 0);

  // The instant the decisive release leaves the window, the item is back.
  now = new Date(Date.parse(expectedUntil) + 1000);
  const reclaimed = queue.claim({ worker: "claude:updex:retry" })!;
  assert.equal(reclaimed.id, churner.id);
  assert.deepEqual(queue.churningItems(), [], "no longer churning once claimable again");
});

test("operator lease releases and slow-spread releases never trip the backoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-claim-backoff-operator-test-"));
  let now = new Date("2026-08-23T12:00:00.000Z");
  const queue = new QueueStore(join(directory, "queue.db"), () => now);
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/std", true);
  const item = seed(queue, "frostyard/std", "Two worker declines and one dead worker.");

  // Two worker releases plus one operator lease release (rule 67): the
  // operator release evidences a gone holder, not a declined contract.
  for (const worker of ["claude:std:one", "claude:std:two"]) {
    const claimed = queue.claim({ worker })!;
    queue.release(item.id, claimed.leaseToken!, worker, "Not mine.");
  }
  queue.claim({ worker: "claude:std:gone" });
  queue.releaseLease(item.id, "operator:test", "Holder is gone.");
  const third = queue.claim({ worker: "claude:std:three" })!;
  assert.equal(third.id, item.id, "still claimable: only two worker releases count");

  // The third worker release inside the window does trip it.
  queue.release(item.id, third.leaseToken!, "claude:std:three", "Also not mine.");
  assert.equal(queue.claim({ worker: "claude:std:four" }), undefined);
  assert.equal(queue.churningItems()[0]?.item.id, item.id);

  // Releases spread wider than the window never accumulate: past the window,
  // slow declines keep the in-window count below the threshold.
  now = new Date(now.getTime() + (CLAIM_BACKOFF_WINDOW_SECONDS + 60) * 1000);
  for (const worker of ["claude:std:five", "claude:std:six"]) {
    const claimed = queue.claim({ worker })!;
    assert.equal(claimed.id, item.id);
    queue.release(item.id, claimed.leaseToken!, worker, "Still not mine.");
    now = new Date(now.getTime() + (CLAIM_BACKOFF_WINDOW_SECONDS / 2) * 1000);
  }
  assert.equal(queue.claim({ worker: "claude:std:seven" })?.id, item.id);
  assert.deepEqual(queue.churningItems(), []);
});

test("the churn CLI prints the backed-off items, newest release first, and never a token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-claim-backoff-cli-test-"));
  const path = join(directory, "queue.db");
  // The CLI opens the store on the real clock, so the fixture anchors its
  // injected clock a few minutes in the real past.
  let now = new Date(Date.now() - 300_000);
  const queue = new QueueStore(path, () => now);
  queue.setRepositoryEnabled("frostyard/updex", true);
  const item = seed(queue, "frostyard/updex", "Declined three times in five minutes.");
  for (const worker of ["one", "two", "three"].map((name) => `claude:updex:${name}`)) {
    const claimed = queue.claim({ worker })!;
    queue.release(item.id, claimed.leaseToken!, worker, `Not mine (${worker}).`);
    now = new Date(now.getTime() + 60_000);
  }
  queue.close();

  const output = execFileSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", "churn"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: childEnvironment({ SNOWCAT_QUEUE_DB: path }),
  });
  const rows = JSON.parse(output) as Array<{ id: string; backoffUntil: string; releases: Array<{ worker: string }> }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, item.id);
  assert.equal(rows[0]!.releases.length, 3);
  assert.equal(rows[0]!.releases[0]!.worker, "claude:updex:three");
  assert.ok(!output.includes("leaseToken"));
  assert.equal((JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", "churn", "--repository", "frostyard/std"], { cwd: process.cwd(), encoding: "utf8", env: childEnvironment({ SNOWCAT_QUEUE_DB: path }) })) as unknown[]).length, 0);
});

test("a version-14 database gains rung 15's work_events index on open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-claim-backoff-ladder-test-"));
  const path = join(directory, "queue.db");
  const current = new QueueStore(path);
  current.close();

  const raw = new DatabaseSync(path);
  raw.exec("DROP INDEX IF EXISTS work_events_item; PRAGMA user_version = 14;");
  const before = (raw.prepare("PRAGMA index_list(work_events)").all() as Array<Record<string, unknown>>).map((row) => String(row.name));
  assert.ok(!before.includes("work_events_item"));
  raw.close();

  const migrated = new QueueStore(path);
  test.after(() => migrated.close());
  assert.equal(migrated.schemaVersion(), SCHEMA_VERSION);
  const inspect = new DatabaseSync(path, { readOnly: true });
  const indexes = (inspect.prepare("PRAGMA index_list(work_events)").all() as Array<Record<string, unknown>>).map((row) => String(row.name));
  inspect.close();
  assert.ok(indexes.includes("work_events_item"), "rung 15 adds work_events(work_item_id, event_type, occurred_at)");
});
