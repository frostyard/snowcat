import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PreconditionMismatchError, QueueStore } from "../src/queue/store.ts";
import { releaseLeaseForm } from "../src/surface/forms.ts";
import { applyItemMutation, itemMutations } from "../src/surface/mutations.ts";
import { childEnvironment } from "./helpers/child-environment.ts";

function seedClaimable(queue: QueueStore, repository: string) {
  queue.setRepositoryEnabled(repository, true);
  return queue.enqueueSeed({
    repository,
    kind: "testing-gap-discovery",
    objective: "Identify one testing gap.",
    instructions: "Read and report only.",
    acceptanceCriteria: ["One gap has concrete evidence."],
    allowedActions: ["read"],
    delegableActions: [],
    executionTarget: "read-only",
    createdBy: "operator:test",
  });
}

test("an operator releases a live lease: the item requeues, the note travels, and the dead worker's token is fenced (rule 67)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-release-lease-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  const seed = seedClaimable(queue, "frostyard/updex");
  const claimed = queue.claim({ worker: "claude:updex:dead", leaseSeconds: 3600 })!;

  // Input and state validation mirrors the other operator mutations.
  assert.throws(() => queue.releaseLease(seed.id, "", "worker gone"), /actor is required/);
  assert.throws(() => queue.releaseLease(seed.id, "operator:test", ""), /reason is required/);
  assert.throws(() => queue.releaseLease(seed.id, "claude:updex:dead", "worker gone"), /operator:, policy:, or member: principal namespace/);

  const released = queue.releaseLease(seed.id, "operator:test", "Container gone; narrated completion without complete_work.");
  assert.equal(released.status, "queued");
  assert.equal(released.leaseOwner, undefined);
  assert.equal(released.leaseToken, undefined);
  assert.equal(released.leaseExpiresAt, undefined);
  // Definition and result are untouched (the successful re-claim below
  // proves admission survived); the reason travels as a note.
  assert.equal(released.result, undefined);
  assert.deepEqual(
    released.operatorNotes.map((note) => [note.actor, note.action, note.reason]),
    [["operator:test", "release-lease", "Container gone; narrated completion without complete_work."]],
  );

  // The ledger closes the attempt as released, ended by the operator, and
  // the payload names whose lease was cut and when it would have lapsed.
  const event = queue.events(seed.id).at(-1)!;
  assert.equal(event.type, "work.released");
  assert.equal(event.actor, "operator:test");
  assert.deepEqual(event.payload, {
    reason: "Container gone; narrated completion without complete_work.",
    previousOwner: "claude:updex:dead",
    leaseExpiresAt: claimed.leaseExpiresAt,
  });
  const attempt = queue.attempts(seed.id).at(-1)!;
  assert.equal(attempt.outcome, "released");
  assert.equal(attempt.endedBy, "operator:test");

  // The outstanding token is fenced: every mutation with it now fails.
  assert.throws(() => queue.heartbeat(seed.id, claimed.leaseToken!, "claude:updex:dead", 60), /not claimed/);
  assert.throws(
    () =>
      queue.complete({
        id: seed.id,
        leaseToken: claimed.leaseToken!,
        worker: "claude:updex:dead",
        result: { summary: "Late narration.", evidence: ["none"], artifacts: [] },
        followUps: [],
      }),
    /not claimed/,
  );

  // The item is immediately claimable again, on a fresh token.
  const second = queue.claim({ worker: "claude:updex:next" })!;
  assert.equal(second.id, seed.id);
  assert.notEqual(second.leaseToken, claimed.leaseToken);
  assert.equal(second.operatorNotes[0]?.action, "release-lease");

  // Only claimed items can be released.
  queue.release(seed.id, second.leaseToken!, "claude:updex:next", "Not started.");
  assert.throws(() => queue.releaseLease(seed.id, "operator:test", "again"), /not claimed: /);
});

test("release-lease accepts a lapsed-but-unreclaimed lease and honors the rule 39 precondition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-release-lease-clock-test-"));
  let now = new Date("2026-08-23T12:00:00.000Z");
  const queue = new QueueStore(join(directory, "queue.db"), () => now);
  test.after(() => queue.close());
  const seed = seedClaimable(queue, "frostyard/clix");
  queue.claim({ worker: "copilot:clix:gone", leaseSeconds: 30 })!;
  now = new Date("2026-08-23T12:10:00.000Z");

  // A stale precondition refuses before the state check, changing nothing.
  assert.throws(
    () => queue.releaseLease(seed.id, "operator:test", "gone", { status: "claimed", updatedAt: "2026-08-23T11:59:59.000Z" }),
    PreconditionMismatchError,
  );
  assert.equal(queue.get(seed.id)!.status, "claimed");

  const item = queue.get(seed.id)!;
  const released = queue.releaseLease(seed.id, "operator:test", "Expired without reclaim; holder gone.", {
    status: "claimed",
    updatedAt: item.updatedAt,
  });
  assert.equal(released.status, "queued");
  assert.equal(released.operatorNotes[0]?.action, "release-lease");
});

test("the CLI lists claims lapsed-first and releases a lease; the surface offers the same mutation on a claimed item", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-release-lease-cli-test-"));
  const path = join(directory, "queue.db");
  // The claims CLI judges staleness by the real wall clock, so the fixture
  // anchors its injected clock to real now: the lapsed lease was claimed ten
  // minutes ago for 30 seconds, the live one just now for an hour.
  let now = new Date(Date.now() - 600_000);
  const queue = new QueueStore(path, () => now);
  const live = seedClaimable(queue, "frostyard/updex");
  queue.setRepositoryEnabled("frostyard/std", true);
  const lapsed = queue.enqueueSeed({
    repository: "frostyard/std",
    kind: "testing-gap-discovery",
    objective: "Identify one testing gap.",
    instructions: "Read and report only.",
    acceptanceCriteria: ["One gap has concrete evidence."],
    allowedActions: ["read"],
    delegableActions: [],
    executionTarget: "read-only",
    createdBy: "operator:test",
  });
  queue.claim({ worker: "copilot:std:gone", repository: "frostyard/std", leaseSeconds: 30 });
  now = new Date();
  queue.claim({ worker: "claude:updex:live", repository: "frostyard/updex", leaseSeconds: 3600 });
  queue.close();

  const run = (args: string[]) =>
    execFileSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: childEnvironment({ SNOWCAT_QUEUE_DB: path }),
    });

  // Lapsed leases sort first; no lease token appears anywhere in the output.
  const claims = JSON.parse(run(["claims"])) as Array<Record<string, unknown>>;
  assert.deepEqual(
    claims.map((claim) => [claim.id, claim.leaseOwner, claim.expired]),
    [
      [lapsed.id, "copilot:std:gone", true],
      [live.id, "claude:updex:live", false],
    ],
  );
  assert.equal(claims[0]?.secondsRemaining, 0);
  assert.equal(claims[0]?.label, undefined);
  assert.ok(!run(["claims"]).includes("leaseToken"));
  assert.equal((JSON.parse(run(["claims", "--repository", "frostyard/std"])) as unknown[]).length, 1);

  const released = JSON.parse(run(["release-lease", lapsed.id, "Worker container is gone."])) as Record<string, unknown>;
  assert.equal(released.status, "queued");
  assert.equal(released.leaseToken, undefined);
  const reopened = new QueueStore(path);
  test.after(() => reopened.close());
  assert.equal(reopened.get(lapsed.id)!.operatorNotes[0]?.reason, "Worker container is gone.");

  // The surface applies the same store method under the same mutation name.
  assert.ok((itemMutations as readonly string[]).includes("release-lease"));
  const item = reopened.get(live.id)!;
  const outcome = applyItemMutation(reopened, "release-lease", live.id, {
    status: item.status,
    updatedAt: item.updatedAt,
    reason: "Session interrupted; nothing is driving this lease.",
  });
  assert.equal(outcome.eventType, "work.released");
  assert.equal(reopened.get(live.id)!.status, "queued");
  assert.equal(reopened.events(live.id).at(-1)?.actor, "operator:web");

  // The claimed-item page offers the form, carrying the precondition fields.
  const form = releaseLeaseForm({ ...reopened.get(live.id)!, status: "claimed" }, "/progress").value;
  assert.match(form, /action="\/items\/[0-9a-f-]+\/release-lease"/);
  assert.match(form, /<input type="hidden" name="status" value="claimed">/);
  assert.match(form, /name="reason"[^>]*required/);
});
