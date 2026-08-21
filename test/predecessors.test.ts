import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { QueueStore, SCHEMA_VERSION } from "../src/queue/store.ts";
import type { CureRootInput, ProposedRootInput, ReviewRootInput, SeedWorkInput } from "../src/queue/types.ts";

type Row = Record<string, unknown>;

const REPOSITORY = "frostyard/updex";
const SLICE_ONE = "https://github.com/frostyard/snowcat/issues/158";
const SLICE_TWO = "https://github.com/frostyard/snowcat/issues/159";
const SLICE_THREE = "https://github.com/frostyard/snowcat/issues/161";

async function openQueue(prefix: string, clock?: () => Date): Promise<QueueStore> {
  const directory = await mkdtemp(join(tmpdir(), `snowcat-${prefix}-`));
  const queue = new QueueStore(join(directory, "queue.db"), clock);
  queue.setRepositoryEnabled(REPOSITORY, true);
  return queue;
}

function proposedRoot(overrides: Partial<ProposedRootInput> = {}): ProposedRootInput {
  return {
    sourceRef: "https://github.com/frostyard/updex/issues/1",
    kind: "issue-resolution",
    objective: "Land the slice.",
    instructions: "Read the issue, then open one pull request.",
    acceptanceCriteria: ["A pull request is open."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    createdBy: "operator:import-issues",
    ...overrides,
  };
}

/**
 * A version-11 database — every column through rung 11 and none of rung 12's —
 * built by the current store and then walked back, so the fixture cannot drift
 * from the ladder it is meant to test.
 */
async function createVersionElevenDatabase(prefix: string): Promise<{ path: string; itemId: string }> {
  const directory = await mkdtemp(join(tmpdir(), `snowcat-${prefix}-`));
  const path = join(directory, "queue.db");
  const current = new QueueStore(path);
  current.setRepositoryEnabled(REPOSITORY, true);
  const item = current.enqueueSeed({
    repository: REPOSITORY,
    kind: "testing-gap-discovery",
    objective: "Find one gap.",
    instructions: "Read only.",
    acceptanceCriteria: ["One gap."],
    allowedActions: ["read"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  current.close();

  const raw = new DatabaseSync(path);
  raw.exec(`
    ALTER TABLE work_items DROP COLUMN predecessors_json;
    PRAGMA user_version = 11;
  `);
  const before = new Set((raw.prepare("PRAGMA table_info(work_items)").all() as Row[]).map((column) => String(column.name)));
  assert.ok(!before.has("predecessors_json"));
  raw.close();
  return { path, itemId: item.id };
}

test("a version-11 database gains rung 12's work_items.predecessors_json column, NULL for every existing item", async () => {
  // Importing the store module already throws unless SCHEMA_VERSION equals the
  // ladder length; this pins the value the rung was appended for.
  assert.equal(SCHEMA_VERSION, 13, "this test pins the ladder at rung 13; extend it when a rung is added");
  const { path, itemId } = await createVersionElevenDatabase("predecessors-ladder");

  const migrated = new QueueStore(path);
  test.after(() => migrated.close());
  assert.equal(migrated.schemaVersion(), SCHEMA_VERSION, "opening the store enforces SCHEMA_VERSION === MIGRATIONS.length");
  assert.equal(migrated.metadata().schemaVersion, SCHEMA_VERSION);

  const inspect = new DatabaseSync(path, { readOnly: true });
  const column = (inspect.prepare("PRAGMA table_info(work_items)").all() as Row[]).find(
    (entry) => String(entry.name) === "predecessors_json",
  );
  const stored = inspect.prepare("SELECT predecessors_json FROM work_items WHERE id = ?").get(itemId) as Row;
  inspect.close();
  assert.ok(column, "rung 12 adds work_items.predecessors_json");
  assert.equal(Number(column!.notnull), 0, "the column is nullable: NULL is 'declares no predecessor'");
  assert.equal(stored.predecessors_json, null, "an item that existed before the rung declares none");
  assert.equal(migrated.get(itemId)!.predecessors, undefined);

  // The rung is idempotent: reopening runs no DDL and changes nothing.
  const reopened = new QueueStore(path);
  reopened.close();
  assert.equal(migrated.get(itemId)!.predecessors, undefined);
});

test("a proposed root round-trips its predecessors sorted and deduplicated, and an item without any stores NULL", async () => {
  const queue = await openQueue("predecessors-roundtrip");
  test.after(() => queue.close());

  const { created } = queue.enqueueProposedRoots(REPOSITORY, [
    proposedRoot({
      sourceRef: "https://github.com/frostyard/updex/issues/10",
      predecessors: [SLICE_TWO, SLICE_ONE, SLICE_TWO],
    }),
    proposedRoot({ sourceRef: "https://github.com/frostyard/updex/issues/11" }),
    proposedRoot({ sourceRef: "https://github.com/frostyard/updex/issues/12", predecessors: [] }),
  ]);
  assert.equal(created.length, 3);

  const gated = created[0]!;
  const plain = created[1]!;
  const empty = created[2]!;
  assert.deepEqual(gated.predecessors, [SLICE_ONE, SLICE_TWO], "stored sorted and deduplicated");
  assert.deepEqual(queue.get(gated.id)!.predecessors, [SLICE_ONE, SLICE_TWO], "and read back the same way");
  assert.equal(plain.predecessors, undefined);
  assert.equal(empty.predecessors, undefined, "an empty list is 'declares none', not an empty array");
  assert.equal(gated.status, "proposed", "predecessors change nothing about admission");

  // The import event names the edges the untrusted issue body declared.
  const proposedEvent = queue.events(gated.id).at(-1)!;
  assert.equal(proposedEvent.type, "work.proposed");
  assert.deepEqual(proposedEvent.payload, {
    root: true,
    sourceRef: "https://github.com/frostyard/updex/issues/10",
    predecessors: [SLICE_ONE, SLICE_TWO],
  });
  assert.deepEqual(queue.events(plain.id).at(-1)!.payload, {
    root: true,
    sourceRef: "https://github.com/frostyard/updex/issues/11",
  });
});

test("predecessors that are not bounded GitHub issue URLs are refused", async () => {
  const queue = await openQueue("predecessors-validation");
  test.after(() => queue.close());

  let candidate = 100;
  const refuse = (predecessors: string[], pattern: RegExp): void => {
    candidate += 1;
    assert.throws(
      () => queue.enqueueProposedRoots(REPOSITORY, [proposedRoot({ sourceRef: `https://github.com/frostyard/updex/issues/${candidate}`, predecessors })]),
      pattern,
    );
  };

  refuse(["not a url"], /predecessor is not a GitHub issue URL/);
  refuse(["http://github.com/frostyard/snowcat/issues/158"], /predecessor is not a GitHub issue URL/);
  refuse(["https://example.com/frostyard/snowcat/issues/158"], /predecessor is not a GitHub issue URL/);
  refuse(["https://github.com/frostyard/snowcat/pull/158"], /predecessor is not a GitHub issue URL/);
  refuse(["https://github.com/frostyard/snowcat/issues/0"], /predecessor is not a GitHub issue URL/);
  refuse([`https://github.com/frostyard/${"a".repeat(520)}/issues/1`], /predecessor exceeds 512 characters/);
  refuse(
    Array.from({ length: 21 }, (_, index) => `https://github.com/frostyard/snowcat/issues/${index + 1}`),
    /predecessors exceed the supported maximum of 20/,
  );

  // Twenty distinct edges are the boundary and are accepted.
  const { created } = queue.enqueueProposedRoots(REPOSITORY, [
    proposedRoot({
      sourceRef: "https://github.com/frostyard/updex/issues/20",
      predecessors: Array.from({ length: 20 }, (_, index) => `https://github.com/frostyard/snowcat/issues/${index + 1}`),
    }),
  ]);
  assert.equal(created[0]!.predecessors!.length, 20);

  // Nothing was created by any refused call: validation precedes the write.
  assert.equal(queue.list({ repository: REPOSITORY }).length, 1);
});

test("only the proposed-root path accepts predecessors: seeds, cure and review roots, and follow-ups refuse them", async () => {
  const queue = await openQueue("predecessors-scope");
  test.after(() => queue.close());
  const smuggled = { predecessors: [SLICE_ONE] };

  const seed: SeedWorkInput = {
    repository: REPOSITORY,
    kind: "testing-gap-discovery",
    objective: "Find one gap.",
    instructions: "Read only.",
    acceptanceCriteria: ["One gap."],
    allowedActions: ["read", "create-followup"],
    delegableActions: ["read", "write", "run-tests", "open-pr"],
    createdBy: "operator:test",
  };
  assert.throws(() => queue.enqueueSeed({ ...seed, ...smuggled } as SeedWorkInput), /a seed root must not carry predecessors/);
  assert.throws(
    () => queue.enqueueInactiveRootBatch(REPOSITORY, [{ ...seed, ...smuggled } as Omit<SeedWorkInput, "repository">]),
    /a seed root must not carry predecessors/,
  );

  const headSha = "a".repeat(40);
  const cure: CureRootInput = {
    sourceRef: `https://github.com/frostyard/updex/pull/7@${headSha}`,
    kind: "pr-cure",
    objective: "Cure the head.",
    instructions: "Rebase only.",
    acceptanceCriteria: ["The head is current."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    createdBy: "policy:pull-request-cure",
    cure: {
      pullRequestUrl: "https://github.com/frostyard/updex/pull/7",
      headSha,
      patchDigest: `sha256:${"b".repeat(64)}`,
      decay: ["behind"],
    },
  };
  assert.throws(() => queue.enqueueCureRoot(REPOSITORY, { ...cure, ...smuggled } as CureRootInput), /a cure root must not carry predecessors/);

  const review: ReviewRootInput = {
    sourceRef: `pr-review:https://github.com/frostyard/updex/pull/7@${headSha}`,
    kind: "pr-review",
    objective: "Review the head.",
    instructions: "Read the diff.",
    acceptanceCriteria: ["A verdict is reported."],
    allowedActions: ["read", "run-tests"],
    delegableActions: [],
    createdBy: "policy:review-gate",
    review: { pullRequestUrl: "https://github.com/frostyard/updex/pull/7", headSha, round: 1, priorBlockers: [] },
  };
  assert.throws(
    () => queue.enqueueReviewRoot(REPOSITORY, { ...review, ...smuggled } as ReviewRootInput),
    /a pr-review root must not carry predecessors/,
  );

  // A worker follow-up is lineage, never a project edge.
  const parent = queue.enqueueSeed(seed);
  const claimed = queue.claim({ worker: "claude:test:discovery", repository: REPOSITORY })!;
  assert.throws(
    () =>
      queue.complete({
        id: parent.id,
        leaseToken: claimed.leaseToken!,
        worker: "claude:test:discovery",
        result: { summary: "Found one gap.", evidence: ["src/example.ts"], artifacts: [] },
        followUps: [
          {
            kind: "testing-gap-fix",
            objective: "Add the missing test.",
            instructions: "Add one test.",
            acceptanceCriteria: ["The test passes."],
            allowedActions: ["read", "write", "run-tests", "open-pr"],
            delegableActions: [],
            requiredArtifact: "pull-request",
            ...smuggled,
          } as never,
        ],
      }),
    /a follow-up item must not carry predecessors/,
  );
  assert.equal(queue.get(parent.id)!.status, "claimed", "the refused completion left the item alone");
  assert.equal(queue.children(parent.id).length, 0);
});

test("replaceProposedPredecessors rewrites a proposed item's edges, records the event, and refuses an admitted one", async () => {
  let now = new Date("2026-08-20T12:00:00.000Z");
  const queue = await openQueue("predecessors-replace", () => now);
  test.after(() => queue.close());

  const { created } = queue.enqueueProposedRoots(REPOSITORY, [
    proposedRoot({ sourceRef: "https://github.com/frostyard/updex/issues/30", predecessors: [SLICE_ONE] }),
    proposedRoot({ sourceRef: "https://github.com/frostyard/updex/issues/31" }),
  ]);
  const refreshed = created[0]!;
  const admitted = created[1]!;

  now = new Date("2026-08-20T12:05:00.000Z");
  const updated = queue.replaceProposedPredecessors(refreshed.id, [SLICE_THREE, SLICE_TWO, SLICE_TWO], "operator:import-issues");
  assert.deepEqual(updated.predecessors, [SLICE_TWO, SLICE_THREE], "the replacement is sorted and deduplicated");
  assert.equal(updated.status, "proposed", "nothing else about the item moved");
  assert.equal(updated.updatedAt, "2026-08-20T12:05:00.000Z");
  const event = queue.events(refreshed.id).at(-1)!;
  assert.equal(event.type, "work.predecessors-updated");
  assert.equal(event.actor, "operator:import-issues");
  assert.deepEqual(event.payload, { predecessors: [SLICE_TWO, SLICE_THREE], previous: [SLICE_ONE] });

  // Clearing is a replacement with nothing, and stores NULL again.
  const cleared = queue.replaceProposedPredecessors(refreshed.id, [], "policy:import");
  assert.equal(cleared.predecessors, undefined);
  assert.deepEqual(queue.events(refreshed.id).at(-1)!.payload, { predecessors: [], previous: [SLICE_TWO, SLICE_THREE] });

  // The same validation applies, and a refused replacement writes nothing.
  assert.throws(() => queue.replaceProposedPredecessors(refreshed.id, ["nope"], "operator:import-issues"), /not a GitHub issue URL/);
  assert.throws(
    () => queue.replaceProposedPredecessors(refreshed.id, [SLICE_ONE], "claude:test:worker"),
    /must use the operator:, policy:, or member: principal namespace/,
    "a worker cannot move an edge",
  );
  assert.equal(queue.get(refreshed.id)!.predecessors, undefined);
  assert.equal(queue.events(refreshed.id).filter((entry) => entry.type === "work.predecessors-updated").length, 2);

  // Admission is the plan-review moment: after it, edges are frozen.
  const approved = queue.approve(admitted.id, "operator:test");
  assert.equal(approved.status, "queued");
  assert.throws(
    () => queue.replaceProposedPredecessors(admitted.id, [SLICE_ONE], "operator:import-issues"),
    /is not proposed, so its predecessors cannot be replaced/,
  );
  const claimed = queue.claim({ worker: "claude:test:author", repository: REPOSITORY })!;
  assert.throws(
    () => queue.replaceProposedPredecessors(claimed.id, [SLICE_ONE], "operator:import-issues"),
    /is not proposed, so its predecessors cannot be replaced/,
  );
  assert.throws(
    () => queue.replaceProposedPredecessors("00000000-0000-4000-8000-000000000000", [SLICE_ONE], "operator:import-issues"),
    /work item not found/,
  );
});

test("an admitted item whose predecessors are unmet is not claimed, and stays visibly queued", async () => {
  const queue = await openQueue("predecessors-gated");
  test.after(() => queue.close());

  // Both predecessors name issues no item in this queue carries as a
  // sourceRef, so neither is delivered by any reading of ADR-0066's rule.
  const { created } = queue.enqueueProposedRoots(REPOSITORY, [
    proposedRoot({ sourceRef: "https://github.com/frostyard/updex/issues/40", predecessors: [SLICE_ONE, SLICE_TWO] }),
  ]);
  const gated = created[0]!;
  assert.equal(queue.list({ repository: REPOSITORY, status: "proposed" }).length, 1);
  assert.deepEqual(queue.claim({ worker: "claude:test:author", repository: REPOSITORY }), undefined, "still proposed, so nothing to claim");

  // This assertion was deliberately the opposite in slice 1
  // (frostyard/snowcat#158), where predecessors were inert storage. The claim
  // gate of slice 3 (frostyard/snowcat#161, ADR-0066 decision 3) is what
  // flipped it; test/predecessor-gate.test.ts holds the whole behaviour.
  queue.approve(gated.id, "operator:test");
  assert.equal(queue.claim({ worker: "claude:test:author", repository: REPOSITORY }), undefined, "an unmet edge withholds the item");
  const item = queue.get(gated.id)!;
  assert.equal(item.status, "queued", "withheld, not blocked or hidden");
  assert.deepEqual(item.predecessors, [SLICE_ONE, SLICE_TWO]);
  assert.deepEqual(
    queue.predecessorStatuses(gated.id).map((entry) => entry.satisfied),
    [false, false],
  );
});
