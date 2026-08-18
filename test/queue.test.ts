import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { PreconditionMismatchError, QueueStore, SCHEMA_VERSION } from "../src/queue/store.ts";
import type { FollowUpInput } from "../src/queue/types.ts";

test("seed work requires an opted-in repository and preserves child lineage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-queue-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());

  assert.throws(() => seedTestingGap(queue, "frostyard/updex"), /not opted in/);
  queue.setRepositoryEnabled("frostyard/updex", true);

  const seed = seedTestingGap(queue, "frostyard/updex");
  const claimed = queue.claim({ worker: "codex:updex:one", repository: "frostyard/updex", leaseSeconds: 60 });
  assert.equal(claimed?.id, seed.id);
  assert.equal(queue.claim({ worker: "claude:updex:two", repository: "frostyard/updex" }), undefined);

  const completion = queue.complete({
    id: claimed!.id,
    leaseToken: claimed!.leaseToken!,
    worker: "codex:updex:one",
    result: {
      summary: "The retry path has no regression test.",
      evidence: ["pkg/retry/retry.go handles timeout retries; pkg/retry/retry_test.go covers only success."],
      artifacts: [],
    },
    followUps: [
      {
        kind: "test-implementation",
        objective: "Add a regression test for retry exhaustion after timeouts.",
        instructions: "Add the smallest deterministic test and run the repository check.",
        acceptanceCriteria: ["The test fails without retry exhaustion handling and passes with current behavior."],
        allowedActions: ["read", "write", "run-tests", "open-pr"],
        delegableActions: [],
      },
    ],
  });

  assert.equal(completion.completed.status, "completed");
  assert.equal(completion.followUps.length, 1);
  assert.equal(completion.followUps[0]?.parentId, seed.id);
  assert.equal(completion.followUps[0]?.rootId, seed.id);
  assert.equal(completion.followUps[0]?.repository, "frostyard/updex");
  assert.equal(completion.followUps[0]?.status, "proposed");
  assert.equal(queue.claim({ worker: "claude:updex:child", repository: "frostyard/updex" }), undefined);
  const approved = queue.approve(completion.followUps[0]!.id, "operator:test");
  assert.equal(approved.status, "queued");
  assert.equal(queue.claim({ worker: "claude:updex:child", repository: "frostyard/updex" })?.id, approved.id);
  assert.deepEqual(
    queue.events(approved.id).map((event) => event.type),
    ["work.proposed", "work.approved", "work.claimed"],
  );
  assert.deepEqual(
    queue.events(seed.id).map((event) => event.type),
    ["work.queued", "work.claimed", "work.completed"],
  );
});

test("expired leases can be reclaimed without accepting the old token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-lease-test-"));
  let now = new Date("2026-08-14T12:00:00.000Z");
  const queue = new QueueStore(join(directory, "queue.db"), () => now);
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/chairlift", true);
  seedTestingGap(queue, "frostyard/chairlift");

  const first = queue.claim({ worker: "codex:chairlift:one", leaseSeconds: 30 })!;
  now = new Date("2026-08-14T12:00:31.000Z");

  // Expiry alone does not requeue: the item stays claimed until reclaimed.
  assert.deepEqual(queue.list({ status: "queued" }), []);
  assert.deepEqual(
    queue.list({ status: "claimed" }).map((item) => [item.id, item.leaseOwner, item.leaseExpiresAt]),
    [[first.id, "codex:chairlift:one", first.leaseExpiresAt]],
  );
  assert.equal(queue.counts().queued, 0);
  assert.equal(queue.counts().claimed, 1);
  assert.deepEqual(
    queue.events(first.id).map((event) => event.type),
    ["work.queued", "work.claimed"],
  );

  const second = queue.claim({ worker: "claude:chairlift:two", leaseSeconds: 30 })!;

  assert.equal(second.id, first.id);
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.throws(
    () => queue.heartbeat(first.id, first.leaseToken!, "codex:chairlift:one", 30),
    /owner or token/,
  );
  assert.deepEqual(
    queue.events(first.id).map((event) => event.type),
    ["work.queued", "work.claimed", "lease.expired", "work.claimed"],
  );
  assert.equal(queue.get(first.id)?.leaseOwner, "claude:chairlift:two");
});

test("released work clears its lease, invalidates the old token, and can be reclaimed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-release-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/chairlift", true);
  const seed = seedTestingGap(queue, "frostyard/chairlift");
  const claimed = queue.claim({ worker: "codex:chairlift:mismatch", leaseSeconds: 60 })!;
  const oldToken = claimed.leaseToken!;

  const released = queue.release(seed.id, oldToken, "codex:chairlift:mismatch", "Wrong specialty.");
  assert.equal(released.status, "queued");
  assert.equal(released.leaseOwner, undefined);
  assert.equal(released.leaseToken, undefined);
  assert.equal(released.leaseExpiresAt, undefined);
  assert.equal(released.result, undefined);
  assert.equal(queue.counts().queued, 1);
  assert.equal(queue.counts().claimed, 0);
  const releaseEvent = queue.events(seed.id).at(-1)!;
  assert.equal(releaseEvent.type, "work.released");
  assert.equal(releaseEvent.actor, "codex:chairlift:mismatch");
  assert.deepEqual(releaseEvent.payload, { reason: "Wrong specialty." });

  assert.throws(() => queue.heartbeat(seed.id, oldToken, "codex:chairlift:mismatch"), /not claimed/);
  assert.throws(
    () =>
      queue.complete({
        id: seed.id,
        leaseToken: oldToken,
        worker: "codex:chairlift:mismatch",
        result: { summary: "Stale completion.", evidence: ["test"], artifacts: [] },
        followUps: [],
      }),
    /not claimed/,
  );
  assert.throws(() => queue.block(seed.id, oldToken, "codex:chairlift:mismatch", "Stale block."), /not claimed/);
  assert.throws(() => queue.release(seed.id, oldToken, "codex:chairlift:mismatch", "Again."), /not claimed/);

  const reclaimed = queue.claim({ worker: "claude:chairlift:correct", leaseSeconds: 60 })!;
  assert.equal(reclaimed.id, seed.id);
  assert.notEqual(reclaimed.leaseToken, oldToken);
  assert.equal(reclaimed.leaseOwner, "claude:chairlift:correct");
});

test("a worker cannot grant follow-up actions above the delegation ceiling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-ceiling-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/core", true);
  const seed = queue.enqueueSeed({
    repository: "frostyard/core",
    kind: "read-only-review",
    objective: "Report one documentation ambiguity.",
    instructions: "Read and report only.",
    acceptanceCriteria: ["One ambiguity is supported by a path reference."],
    allowedActions: ["read", "create-followup"],
    delegableActions: ["read"],
    createdBy: "operator:test",
  });
  const claimed = queue.claim({ worker: "copilot:core:one" })!;

  assert.throws(
    () =>
      queue.complete({
        id: seed.id,
        leaseToken: claimed.leaseToken!,
        worker: "copilot:core:one",
        result: { summary: "Found ambiguity.", evidence: ["docs/README.md"], artifacts: [] },
        followUps: [
          {
            kind: "rewrite-docs",
            objective: "Rewrite the documentation.",
            instructions: "Edit the ambiguous section.",
            acceptanceCriteria: ["The ambiguity is removed."],
            allowedActions: ["read", "write"],
            delegableActions: [],
          },
        ],
      }),
    /delegation ceiling: write/,
  );
  assert.equal(queue.get(seed.id)?.status, "claimed");
  assert.equal(queue.list({ repository: "frostyard/core" }).length, 1);
});

test("completion artifacts are rejected when the matching action is not allowed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-artifact-deny-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/lodge", true);
  queue.enqueueSeed({
    repository: "frostyard/lodge",
    kind: "read-only-review",
    objective: "Report findings without producing GitHub artifacts.",
    instructions: "Read and report only.",
    acceptanceCriteria: ["Findings reference concrete paths."],
    allowedActions: ["read", "run-tests"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const claimed = queue.claim({ worker: "codex:lodge:one" })!;

  assert.throws(
    () =>
      queue.complete({
        id: claimed.id,
        leaseToken: claimed.leaseToken!,
        worker: "codex:lodge:one",
        result: {
          summary: "Opened a pull request.",
          evidence: ["src/queue/store.ts"],
          artifacts: [{ kind: "pull-request", url: "https://github.com/frostyard/lodge/pull/1" }],
        },
        followUps: [],
      }),
    /requires allowed action open-pr/,
  );
  assert.equal(queue.get(claimed.id)?.status, "claimed");

  assert.throws(
    () =>
      queue.complete({
        id: claimed.id,
        leaseToken: claimed.leaseToken!,
        worker: "codex:lodge:one",
        result: {
          summary: "Opened an issue.",
          evidence: ["src/queue/store.ts"],
          artifacts: [{ kind: "issue", url: "https://github.com/frostyard/lodge/issues/2" }],
        },
        followUps: [],
      }),
    /requires allowed action open-issue/,
  );
  assert.throws(
    () =>
      queue.complete({
        id: claimed.id,
        leaseToken: claimed.leaseToken!,
        worker: "codex:lodge:one",
        result: {
          summary: "Pushed a commit.",
          evidence: ["src/queue/store.ts"],
          artifacts: [{ kind: "commit", url: "https://github.com/frostyard/lodge/commit/abc123" }],
        },
        followUps: [],
      }),
    /requires allowed action write/,
  );
  assert.equal(queue.get(claimed.id)?.status, "claimed");
});

test("completion stores a pull-request artifact when open-pr is allowed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-artifact-allow-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/lodge", true);
  queue.enqueueSeed({
    repository: "frostyard/lodge",
    kind: "test-implementation",
    objective: "Land a test via pull request.",
    instructions: "Write the test and open a pull request.",
    acceptanceCriteria: ["The pull request contains the new test."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const claimed = queue.claim({ worker: "codex:lodge:two" })!;

  const completion = queue.complete({
    id: claimed.id,
    leaseToken: claimed.leaseToken!,
    worker: "codex:lodge:two",
    result: {
      summary: "Opened a pull request with the new test.",
      evidence: ["test/queue.test.ts"],
      artifacts: [
        { kind: "pull-request", url: "https://github.com/frostyard/lodge/pull/7", description: "New test" },
      ],
    },
    followUps: [],
  });

  assert.equal(completion.completed.status, "completed");
  assert.deepEqual(completion.completed.result?.artifacts, [
    { kind: "pull-request", url: "https://github.com/frostyard/lodge/pull/7", description: "New test" },
  ]);
});

test("GitHub artifact claims must match the work repository and declared kind", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-artifact-scope-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/lodge", true);
  const seed = queue.enqueueSeed({
    repository: "frostyard/lodge",
    kind: "implementation",
    objective: "Implement and report one repository-scoped change.",
    instructions: "Report only artifacts created for this repository.",
    acceptanceCriteria: ["The reported artifact belongs to frostyard/lodge."],
    allowedActions: ["read", "write", "run-tests", "open-issue", "open-pr", "create-followup"],
    delegableActions: ["read"],
    createdBy: "operator:test",
  });
  const claimed = queue.claim({ worker: "claude:lodge:scope" })!;

  const invalidArtifacts = [
    { kind: "pull-request" as const, url: "https://github.com/frostyard/other/pull/7" },
    { kind: "pull-request" as const, url: "https://github.com/frostyard/lodge/issues/7" },
    { kind: "pull-request" as const, url: "https://github.com/frostyard/lodge/pull/0" },
    { kind: "pull-request" as const, url: "https://github.com/frostyard/lodge/pull/7/files" },
    { kind: "pull-request" as const, url: "https://github.com/frostyard/lodge/pull/7?reported=true" },
    { kind: "pull-request" as const, url: "https://github.com/frostyard/lodge/pull/7#discussion" },
    { kind: "pull-request" as const, url: "https://github.com.evil.example/frostyard/lodge/pull/7" },
    { kind: "commit" as const, url: "https://github.com/frostyard/lodge/commit/not-a-sha" },
  ];

  for (const artifact of invalidArtifacts) {
    assert.throws(
      () =>
        queue.complete({
          id: seed.id,
          leaseToken: claimed.leaseToken!,
          worker: "claude:lodge:scope",
          result: { summary: "Reported artifact.", evidence: ["worker report"], artifacts: [artifact] },
          followUps: [
            {
              kind: "review",
              objective: "Review the reported change.",
              instructions: "Read the change.",
              acceptanceCriteria: ["The change is reviewed."],
              allowedActions: ["read"],
              delegableActions: [],
            },
          ],
        }),
      /URL must match/,
    );
    assert.equal(queue.get(seed.id)?.status, "claimed");
    assert.equal(queue.get(seed.id)?.result, undefined);
    assert.equal(queue.list({ repository: "frostyard/lodge" }).length, 1);
  }

  const completion = queue.complete({
    id: seed.id,
    leaseToken: claimed.leaseToken!,
    worker: "claude:lodge:scope",
    result: {
      summary: "Reported repository-scoped artifacts.",
      evidence: ["worker report"],
      artifacts: [
        { kind: "issue", url: "https://github.com/FrostYard/LODGE/issues/12" },
        { kind: "pull-request", url: "https://github.com/frostyard/lodge/pull/7" },
        { kind: "commit", url: "https://github.com/frostyard/lodge/commit/0123456789abcdef" },
      ],
    },
    followUps: [],
  });

  assert.equal(completion.completed.status, "completed");
  assert.equal(completion.completed.result?.artifacts.length, 3);
});

test("artifact URLs reject credentials before provenance is stored", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-artifact-credentials-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/lodge", true);
  const seed = queue.enqueueSeed({
    repository: "frostyard/lodge",
    kind: "report",
    objective: "Record a report URL.",
    instructions: "Do not include credentials.",
    acceptanceCriteria: ["The report URL contains no credentials."],
    allowedActions: ["read"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const claimed = queue.claim({ worker: "codex:lodge:credentials" })!;

  assert.throws(
    () =>
      queue.complete({
        id: seed.id,
        leaseToken: claimed.leaseToken!,
        worker: "codex:lodge:credentials",
        result: {
          summary: "Recorded report.",
          evidence: ["worker report"],
          artifacts: [{ kind: "report", url: "https://token:secret@example.com/report/1" }],
        },
        followUps: [],
      }),
    /must not contain credentials/,
  );
  assert.equal(queue.get(seed.id)?.status, "claimed");
  assert.equal(queue.get(seed.id)?.result, undefined);
});

test("rejected proposals remain auditable and cannot be claimed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-rejection-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/core", true);
  const seed = seedTestingGap(queue, "frostyard/core");
  const claimed = queue.claim({ worker: "claude:core:discovery" })!;
  const completion = queue.complete({
    id: seed.id,
    leaseToken: claimed.leaseToken!,
    worker: "claude:core:discovery",
    result: { summary: "Proposed unnecessary work.", evidence: ["docs/example.md"], artifacts: [] },
    followUps: [
      {
        kind: "test-implementation",
        objective: "Add a redundant test.",
        instructions: "Duplicate existing coverage.",
        acceptanceCriteria: ["A duplicate test exists."],
        allowedActions: ["read"],
        delegableActions: [],
      },
    ],
  });
  const proposal = completion.followUps[0]!;

  const rejected = queue.reject(proposal.id, "operator:test", "Existing coverage is sufficient.");
  assert.equal(rejected.status, "cancelled");
  assert.equal(rejected.result?.summary, "Existing coverage is sufficient.");
  assert.equal(queue.claim({ worker: "codex:core:implementation" }), undefined);
  assert.deepEqual(
    queue.events(proposal.id).map((event) => event.type),
    ["work.proposed", "work.rejected"],
  );
});

test("an operator can defer admitted work and later approve it again", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-defer-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/core", true);
  const seed = seedTestingGap(queue, "frostyard/core");

  assert.throws(() => queue.defer(seed.id, "", "later"), /actor is required/);
  assert.throws(() => queue.defer(seed.id, "operator:test", ""), /reason is required/);
  assert.throws(() => queue.defer(seed.id, "claude:worker", "later"), /operator: or policy: principal namespace/);
  const deferred = queue.defer(seed.id, "operator:test", "Serialize repository writers.");
  assert.equal(deferred.status, "proposed");
  assert.equal(deferred.leaseOwner, undefined);
  assert.deepEqual(
    deferred.operatorNotes.map((note) => [note.actor, note.action, note.reason]),
    [["operator:test", "defer", "Serialize repository writers."]],
  );
  assert.equal(queue.claim({ worker: "claude:core:early" }), undefined);
  const deferredEvent = queue.events(seed.id).at(-1)!;
  assert.equal(deferredEvent.type, "work.deferred");
  assert.equal(deferredEvent.actor, "operator:test");
  assert.deepEqual(deferredEvent.payload, { reason: "Serialize repository writers." });
  assert.throws(() => queue.defer(seed.id, "operator:test", "again"), /not queued and admitted/);

  const approved = queue.approve(seed.id, "operator:test");
  assert.equal(approved.status, "queued");
  const claimed = queue.claim({ worker: "codex:core:ready" })!;
  assert.equal(claimed.id, seed.id);
  assert.throws(() => queue.defer(seed.id, "operator:test", "too late"), /not queued and admitted/);
  queue.complete({
    id: seed.id,
    leaseToken: claimed.leaseToken!,
    worker: "codex:core:ready",
    result: { summary: "Done.", evidence: ["test"], artifacts: [] },
    followUps: [],
  });
  assert.throws(() => queue.defer(seed.id, "operator:test", "terminal"), /not queued and admitted/);
});

test("follow-up count and lineage depth are hard bounded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-runaway-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/core", true);
  const root = seedTestingGap(queue, "frostyard/core");
  let claimed = queue.claim({ worker: "claude:core:depth-0" })!;

  const tooMany = Array.from({ length: 11 }, (_, index) => ({
    kind: "test-implementation",
    objective: `Proposed child ${index}.`,
    instructions: "Read only.",
    acceptanceCriteria: ["One observation is recorded."],
    allowedActions: ["read" as const],
    delegableActions: ["read" as const, "create-followup" as const],
  }));
  assert.throws(
    () =>
      queue.complete({
        id: root.id,
        leaseToken: claimed.leaseToken!,
        worker: "claude:core:depth-0",
        result: { summary: "Too many proposals.", evidence: ["test"], artifacts: [] },
        followUps: tooMany,
      }),
    /at most 10/,
  );
  assert.equal(queue.get(root.id)?.status, "claimed");
  assert.equal(queue.list({ repository: "frostyard/core" }).length, 1);

  let current = root;
  for (let depth = 1; depth <= 4; depth += 1) {
    const completion = queue.complete({
      id: current.id,
      leaseToken: claimed.leaseToken!,
      worker: `claude:core:depth-${depth - 1}`,
      result: { summary: `Completed depth ${depth - 1}.`, evidence: ["test"], artifacts: [] },
      followUps: [
        {
          kind: "test-implementation",
          objective: `Inspect depth ${depth}.`,
          instructions: "Read and propose only.",
          acceptanceCriteria: ["One observation is recorded."],
          allowedActions: ["read", "create-followup"],
          delegableActions: ["read", "create-followup"],
        },
      ],
    });
    current = queue.approve(completion.followUps[0]!.id, "operator:test");
    claimed = queue.claim({ worker: `claude:core:depth-${depth}` })!;
    assert.equal(claimed.id, current.id);
  }

  assert.throws(
    () =>
      queue.complete({
        id: current.id,
        leaseToken: claimed.leaseToken!,
        worker: "claude:core:depth-4",
        result: { summary: "Reached the limit.", evidence: ["test"], artifacts: [] },
        followUps: [
          {
            kind: "test-implementation",
            objective: "Exceed the depth limit.",
            instructions: "Read only.",
            acceptanceCriteria: ["This must not be admitted."],
            allowedActions: ["read"],
            delegableActions: [],
          },
        ],
      }),
    /at most 4 edges deep/,
  );
  assert.equal(queue.get(current.id)?.status, "claimed");
});

test("the database itself refuses to claim or create claimable proposals through legacy SQL", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-admission-trigger-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  const legacy = new DatabaseSync(path);
  test.after(() => {
    legacy.close();
    queue.close();
  });
  queue.setRepositoryEnabled("frostyard/core", true);
  const seed = seedTestingGap(queue, "frostyard/core");
  const claimed = queue.claim({ worker: "claude:core:discovery" })!;
  const completion = queue.complete({
    id: seed.id,
    leaseToken: claimed.leaseToken!,
    worker: "claude:core:discovery",
    result: { summary: "Proposed one child.", evidence: ["docs/example.md"], artifacts: [] },
    followUps: [
      {
        kind: "test-implementation",
        objective: "Add the missing test.",
        instructions: "Add the test and run the check.",
        acceptanceCriteria: ["The test exists and passes."],
        allowedActions: ["read", "write", "run-tests"],
        delegableActions: [],
      },
    ],
  });
  const proposal = completion.followUps[0]!;
  assert.equal(proposal.status, "proposed");

  // A pre-admission client claims by status alone and never touches `admitted`.
  const legacyClaim = legacy.prepare(
    `UPDATE work_items
     SET status = 'claimed', lease_owner = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
     WHERE id = ? AND status = 'queued'`,
  );
  assert.throws(
    () => legacyClaim.run("legacy:worker", "legacy-token", "2099-01-01T00:00:00.000Z", "2026-08-15T00:00:00.000Z", proposal.id),
    /must be admitted before it can be claimed/,
  );
  // Nor may a single statement admit and claim in one step.
  assert.throws(
    () =>
      legacy
        .prepare("UPDATE work_items SET status = 'claimed', admitted = 1, lease_owner = 'legacy:worker' WHERE id = ?")
        .run(proposal.id),
    /must be admitted before it can be claimed/,
  );
  assert.equal(queue.get(proposal.id)?.status, "proposed");
  assert.equal(queue.get(proposal.id)?.leaseOwner, undefined);
  assert.equal(queue.claim({ worker: "claude:core:child" }), undefined);

  // A pre-admission client inserts children without the admitted column, so the
  // column default would make them claimable; the database rejects that too.
  assert.throws(
    () =>
      legacy
        .prepare(
          `INSERT INTO work_items (
             id, root_id, parent_id, repository, kind, objective, instructions,
             acceptance_criteria_json, allowed_actions_json, delegable_actions_json,
             priority, status, created_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run(
          "11111111-1111-4111-8111-111111111111",
          seed.id,
          seed.id,
          "frostyard/core",
          "test-implementation",
          "Legacy child.",
          "Inserted by legacy code.",
          "[]",
          '["read"]',
          "[]",
          0,
          "legacy:worker",
          "2026-08-15T00:00:00.000Z",
          "2026-08-15T00:00:00.000Z",
        ),
    /must be created as proposed/,
  );
  assert.equal(queue.list({ repository: "frostyard/core" }).length, 2);

  // The only admission path still works and the admitted child is claimable.
  const approved = queue.approve(proposal.id, "operator:test");
  assert.equal(approved.status, "queued");
  const row = legacy.prepare("SELECT admitted, status FROM work_items WHERE id = ?").get(proposal.id) as {
    admitted: number;
    status: string;
  };
  assert.equal(row.admitted, 1);
  assert.equal(row.status, "queued");
  assert.equal(queue.claim({ worker: "claude:core:child" })?.id, proposal.id);
});

test("a queue store refuses databases newer than its schema version, even after opening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-schema-version-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  const other = new DatabaseSync(path);
  test.after(() => {
    other.close();
    queue.close();
  });
  assert.equal(queue.schemaVersion(), SCHEMA_VERSION);
  assert.equal((other.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
  queue.setRepositoryEnabled("frostyard/core", true);

  // A later migration from another process advances the database version.
  other.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);

  const newer = new RegExp(`schema version ${SCHEMA_VERSION + 1} is newer than the supported version ${SCHEMA_VERSION}`);
  assert.throws(() => new QueueStore(path), newer);
  assert.throws(() => seedTestingGap(queue, "frostyard/core"), newer);
  assert.throws(() => queue.setRepositoryEnabled("frostyard/core", false), /newer than the supported version/);
  assert.equal(queue.list({ repository: "frostyard/core" }).length, 0);
  assert.equal(
    (other.prepare("SELECT enabled FROM repositories WHERE slug = ?").get("frostyard/core") as { enabled: number })
      .enabled,
    1,
  );

  // Restoring the version lets the same open store write again.
  other.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  assert.equal(seedTestingGap(queue, "frostyard/core").status, "queued");
});

test("two stores on one database file both write, and a writer waits out another connection's lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-busy-timeout-test-"));
  const path = join(directory, "queue.db");
  const first = new QueueStore(path);
  const second = new QueueStore(path);
  test.after(() => {
    second.close();
    first.close();
  });

  first.setRepositoryEnabled("frostyard/core", true);
  const seed = seedTestingGap(second, "frostyard/core");
  assert.equal(first.get(seed.id)?.status, "queued");
  const claimed = second.claim({ worker: "codex:core:other-process" });
  assert.equal(claimed?.id, seed.id);
  assert.equal(first.get(seed.id)?.status, "claimed");

  // Another thread holds the write lock for a while; this connection must wait
  // for it rather than failing immediately with SQLITE_BUSY.
  const HOLD_MS = 400;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const holder = new Worker(
    `(async () => {
       const { workerData } = await import("node:worker_threads");
       const { DatabaseSync } = await import("node:sqlite");
       const db = new DatabaseSync(workerData.path);
       db.exec("BEGIN IMMEDIATE");
       Atomics.store(workerData.signal, 0, 1);
       Atomics.notify(workerData.signal, 0);
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);
       db.exec("COMMIT");
       db.close();
     })();`,
    { eval: true, workerData: { path, signal, holdMs: HOLD_MS } },
  );
  const exited = new Promise<number>((resolve) => holder.once("exit", resolve));
  assert.equal(Atomics.wait(signal, 0, 0, 5000), "ok");

  const started = Date.now();
  first.setRepositoryEnabled("frostyard/lodge", true);
  const waited = Date.now() - started;
  assert.ok(waited >= HOLD_MS - 50, `write should have waited for the lock, waited ${waited}ms`);
  assert.equal(await exited, 0);
  assert.equal(seedTestingGap(second, "frostyard/lodge").status, "queued");
});

test("queue startup installs its busy timeout before journal-mode negotiation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-startup-timeout-test-"));
  const path = join(directory, "queue.db");
  const bootstrap = new DatabaseSync(path);
  bootstrap.exec("CREATE TABLE bootstrap_marker (value INTEGER NOT NULL)");
  bootstrap.close();

  const HOLD_MS = 400;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const holder = new Worker(
    `(async () => {
       const { workerData } = await import("node:worker_threads");
       const { DatabaseSync } = await import("node:sqlite");
       const db = new DatabaseSync(workerData.path);
       db.exec("BEGIN EXCLUSIVE");
       Atomics.store(workerData.signal, 0, 1);
       Atomics.notify(workerData.signal, 0);
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);
       db.exec("COMMIT");
       db.close();
     })();`,
    { eval: true, workerData: { path, signal, holdMs: HOLD_MS } },
  );
  const exited = new Promise<number>((resolve) => holder.once("exit", resolve));
  assert.equal(Atomics.wait(signal, 0, 0, 5000), "ok");

  const started = Date.now();
  const queue = new QueueStore(path);
  const waited = Date.now() - started;
  assert.ok(waited >= HOLD_MS - 50, `startup should have waited for the lock, waited ${waited}ms`);
  assert.equal(queue.schemaVersion(), SCHEMA_VERSION);
  queue.close();
  assert.equal(await exited, 0);
});

test("scheduling priority is operator-owned: workers cannot set it and children inherit it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-priority-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/core", true);

  for (const priority of [1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        queue.enqueueSeed({
          repository: "frostyard/core",
          kind: "testing-gap-discovery",
          objective: "Seed with an invalid priority.",
          instructions: "Read only.",
          acceptanceCriteria: ["Never created."],
          allowedActions: ["read", "create-followup"],
          delegableActions: ["read", "write"],
          priority,
          createdBy: "operator:test",
        }),
      /priority must be a safe integer/,
    );
  }
  assert.equal(queue.list({ repository: "frostyard/core" }).length, 0);

  const root = queue.enqueueSeed({
    repository: "frostyard/core",
    kind: "testing-gap-discovery",
    objective: "Identify one testing gap.",
    instructions: "Read only and propose one child.",
    acceptanceCriteria: ["Exactly one gap has file-level evidence."],
    allowedActions: ["read", "create-followup"],
    delegableActions: ["read", "write", "run-tests", "create-followup"],
    priority: 7,
    createdBy: "operator:test",
  });
  assert.equal(root.priority, 7);
  const claimed = queue.claim({ worker: "claude:core:priority" })!;
  const child = {
    kind: "test-implementation",
    objective: "Add the missing test.",
    instructions: "Add the test and run the check.",
    acceptanceCriteria: ["The test passes."],
    allowedActions: ["read", "write", "run-tests"] as const,
    delegableActions: [] as const,
  };

  // A worker-supplied priority (even a low one) rejects the whole completion.
  const smuggled = { ...child, priority: 0 } as unknown as FollowUpInput;
  assert.throws(
    () =>
      queue.complete({
        id: root.id,
        leaseToken: claimed.leaseToken!,
        worker: "claude:core:priority",
        result: { summary: "Found a gap.", evidence: ["src/example.ts"], artifacts: [] },
        followUps: [{ ...child, allowedActions: [...child.allowedActions], delegableActions: [] }, smuggled],
      }),
    /follow-up items may not set priority/,
  );
  assert.equal(queue.get(root.id)?.status, "claimed");
  assert.equal(queue.get(root.id)?.result, undefined);
  assert.equal(queue.list({ repository: "frostyard/core" }).length, 1);

  // Without a priority the child inherits the parent's exact (nonzero) value.
  const completion = queue.complete({
    id: root.id,
    leaseToken: claimed.leaseToken!,
    worker: "claude:core:priority",
    result: { summary: "Found a gap.", evidence: ["src/example.ts"], artifacts: [] },
    followUps: [{ ...child, allowedActions: [...child.allowedActions], delegableActions: [] }],
  });
  assert.equal(completion.followUps[0]?.priority, 7);
  assert.equal(queue.get(completion.followUps[0]!.id)?.priority, 7);
});

test("blocking stores the reason as the item's result and clears the lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-block-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/core", true);
  const seed = seedTestingGap(queue, "frostyard/core");
  const claimed = queue.claim({ worker: "claude:core:blocker" })!;

  const blocked = queue.block(seed.id, claimed.leaseToken!, "claude:core:blocker", "Needs operator credentials.");
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.result, { summary: "Needs operator credentials.", evidence: [], artifacts: [] });
  assert.equal(blocked.leaseOwner, undefined);
  assert.equal(blocked.leaseToken, undefined);
  assert.equal(blocked.leaseExpiresAt, undefined);
  assert.deepEqual(queue.get(seed.id)?.result, { summary: "Needs operator credentials.", evidence: [], artifacts: [] });

  const events = queue.events(seed.id);
  assert.deepEqual(
    events.map((event) => event.type),
    ["work.queued", "work.claimed", "work.blocked"],
  );
  assert.deepEqual(events.at(-1)?.payload, { reason: "Needs operator credentials." });
  assert.equal(queue.claim({ worker: "claude:core:next" }), undefined);
  assert.throws(
    () => queue.heartbeat(seed.id, claimed.leaseToken!, "claude:core:blocker", 60),
    /not claimed/,
  );
});

test("an operator can requeue blocked work and a different worker can claim it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-requeue-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/core", true);
  const seed = seedTestingGap(queue, "frostyard/core");
  const first = queue.claim({ worker: "claude:core:first" })!;
  queue.block(seed.id, first.leaseToken!, "claude:core:first", "Waiting for operator input.");

  assert.throws(() => queue.requeue(seed.id, "", "resume"), /actor is required/);
  assert.throws(() => queue.requeue(seed.id, "operator:test", ""), /reason is required/);
  assert.throws(() => queue.requeue(seed.id, "claude:core:first", "resume"), /operator: or policy: principal namespace/);
  const requeued = queue.requeue(seed.id, "operator:test", "Input supplied.");
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.result, undefined);
  assert.equal(requeued.leaseOwner, undefined);
  assert.equal(requeued.leaseToken, undefined);
  assert.equal(requeued.leaseExpiresAt, undefined);
  // History is carried, not erased: the block reason and the requeue note travel to the next lease.
  assert.deepEqual(requeued.previousResults, [{ summary: "Waiting for operator input.", evidence: [], artifacts: [] }]);
  assert.equal(requeued.operatorNotes.length, 1);
  assert.equal(requeued.operatorNotes[0]?.actor, "operator:test");
  assert.equal(requeued.operatorNotes[0]?.action, "requeue");
  assert.equal(requeued.operatorNotes[0]?.reason, "Input supplied.");
  assert.equal(requeued.operatorNotes[0]?.at, requeued.updatedAt);
  assert.deepEqual(queue.events(seed.id).at(-1), {
    sequence: queue.events(seed.id).at(-1)?.sequence,
    workItemId: seed.id,
    type: "work.requeued",
    actor: "operator:test",
    payload: { reason: "Input supplied." },
    occurredAt: queue.events(seed.id).at(-1)?.occurredAt,
  });

  const second = queue.claim({ worker: "codex:core:second" })!;
  assert.equal(second.id, seed.id);
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.equal(second.operatorNotes[0]?.reason, "Input supplied.");
  assert.equal(second.previousResults[0]?.summary, "Waiting for operator input.");
  assert.throws(() => queue.requeue(seed.id, "operator:test", "already active"), /not blocked/);

  // A second block/requeue cycle appends rather than overwrites.
  queue.block(seed.id, second.leaseToken!, "codex:core:second", "Still waiting.");
  const again = queue.requeue(seed.id, "policy:auto-resume", "Retry once more.");
  assert.deepEqual(
    again.previousResults.map((result) => result.summary),
    ["Waiting for operator input.", "Still waiting."],
  );
  assert.deepEqual(
    again.operatorNotes.map((note) => [note.actor, note.action, note.reason]),
    [
      ["operator:test", "requeue", "Input supplied."],
      ["policy:auto-resume", "requeue", "Retry once more."],
    ],
  );
});

test("an operator can prioritize proposed, queued, or blocked work, and only an operator can", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-prioritize-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/updex", true);

  // An older discovery root at priority 0 and a parent whose admitted child
  // inherits 0: the child queues behind the root on creation time alone.
  const olderRoot = seedTestingGap(queue, "frostyard/updex");
  const parent = queue.enqueueSeed({
    repository: "frostyard/updex",
    kind: "security-gap-discovery",
    objective: "Find one security gap.",
    instructions: "Read only.",
    acceptanceCriteria: ["One gap."],
    allowedActions: ["read", "create-followup"],
    delegableActions: ["read", "write", "run-tests", "open-pr"],
    createdBy: "operator:test",
  });
  const claimedParent = queue.claim({ worker: "claude:updex:parent", kinds: ["security-gap-discovery"] })!;
  const completion = queue.complete({
    id: parent.id,
    leaseToken: claimedParent.leaseToken!,
    worker: "claude:updex:parent",
    result: { summary: "One gap.", evidence: ["src/auth.ts"], artifacts: [] },
    followUps: [
      {
        kind: "security-implementation",
        objective: "Fix the gap.",
        instructions: "Patch and test.",
        acceptanceCriteria: ["Regression test passes."],
        allowedActions: ["read", "write", "run-tests", "open-pr"],
        delegableActions: [],
      },
    ],
  });
  const child = completion.followUps[0]!;
  assert.equal(child.priority, 0);

  // Prioritizing works while proposed, and the event carries previous, new, and reason.
  assert.throws(() => queue.prioritize(child.id, "claude:updex:worker", 9, "urgent"), /operator: or policy: principal namespace/);
  assert.throws(() => queue.prioritize(child.id, "operator:test", 1.5, "urgent"), /safe integer/);
  assert.throws(() => queue.prioritize(child.id, "operator:test", 9, " "), /prioritize reason is required/);
  const proposed = queue.prioritize(child.id, "operator:test", 9, "Security fix outranks discovery.");
  assert.equal(proposed.status, "proposed");
  assert.equal(proposed.priority, 9);
  assert.deepEqual(
    proposed.operatorNotes.map((note) => [note.actor, note.action, note.reason]),
    [["operator:test", "prioritize", "Security fix outranks discovery."]],
  );
  const event = queue.events(child.id).at(-1)!;
  assert.equal(event.type, "work.prioritized");
  assert.equal(event.actor, "operator:test");
  assert.deepEqual(event.payload, { previous: 0, priority: 9, reason: "Security fix outranks discovery." });

  // Once admitted, the prioritized child is claimed ahead of the older queued root.
  queue.approve(child.id, "operator:test");
  const claimed = queue.claim({ worker: "codex:updex:implementer" })!;
  assert.equal(claimed.id, child.id);
  assert.equal(claimed.priority, 9);
  assert.equal(claimed.operatorNotes[0]?.action, "prioritize");

  // A claimed item cannot be reprioritized and keeps its value.
  assert.throws(() => queue.prioritize(child.id, "operator:test", 1, "too late"), /not proposed, queued, or blocked/);
  assert.equal(queue.get(child.id)?.priority, 9);
  assert.equal(queue.events(child.id).filter((entry) => entry.type === "work.prioritized").length, 1);

  // Queued and blocked items can be; completed and cancelled cannot.
  const requeuedRoot = queue.prioritize(olderRoot.id, "policy:triage", -1, "Discovery can wait.");
  assert.equal(requeuedRoot.priority, -1);
  queue.block(child.id, claimed.leaseToken!, "codex:updex:implementer", "Needs a decision.");
  assert.equal(queue.prioritize(child.id, "operator:test", 10, "Still urgent.").priority, 10);
  const stillBlocked = queue.get(child.id)!;
  assert.equal(stillBlocked.status, "blocked");
  assert.equal(stillBlocked.result?.summary, "Needs a decision.");
  queue.cancel(child.id, "operator:test", "Handled elsewhere.");
  assert.throws(() => queue.prioritize(child.id, "operator:test", 11, "terminal"), /not proposed, queued, or blocked/);
  assert.throws(() => queue.prioritize(parent.id, "operator:test", 11, "terminal"), /not proposed, queued, or blocked/);
});

test("an operator note appends to the item without changing its status, and workers cannot write one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-note-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/core", true);
  const seed = seedTestingGap(queue, "frostyard/core");
  assert.deepEqual(seed.operatorNotes, []);
  assert.deepEqual(seed.previousResults, []);

  assert.throws(() => queue.note(seed.id, "", "hello"), /note actor is required/);
  assert.throws(() => queue.note(seed.id, "operator:test", "  "), /note text is required/);
  assert.throws(() => queue.note(seed.id, "claude:core:worker", "hello"), /operator: or policy: principal namespace/);
  assert.throws(() => queue.note(seed.id, "system", "hello"), /operator: or policy: principal namespace/);
  assert.throws(() => queue.note(seed.id, "system:expiry", "hello"), /operator: or policy: principal namespace/);
  assert.throws(() => queue.note(seed.id, "operator:test", "x".repeat(4001)), /exceeds 4000 characters/);
  assert.throws(() => queue.note("00000000-0000-0000-0000-000000000000", "operator:test", "hello"), /not found/);

  const noted = queue.note(seed.id, "operator:test", "PR #5 already exists — re-report it, no code change needed.");
  assert.equal(noted.status, "queued");
  assert.equal(noted.result, undefined);
  assert.equal(noted.leaseOwner, undefined);
  assert.deepEqual(noted.operatorNotes, [
    {
      at: noted.updatedAt,
      actor: "operator:test",
      action: "note",
      reason: "PR #5 already exists — re-report it, no code change needed.",
    },
  ]);
  const event = queue.events(seed.id).at(-1)!;
  assert.equal(event.type, "work.noted");
  assert.equal(event.actor, "operator:test");
  assert.deepEqual(event.payload, { reason: "PR #5 already exists — re-report it, no code change needed." });

  // The note reaches the next lease and a claimed item can still be annotated.
  const claimed = queue.claim({ worker: "claude:core:next" })!;
  assert.equal(claimed.operatorNotes[0]?.reason, "PR #5 already exists — re-report it, no code change needed.");
  const second = queue.note(seed.id, "policy:review", "Also close issue #2 in the PR body.");
  assert.equal(second.status, "claimed");
  assert.equal(second.leaseOwner, "claude:core:next");
  assert.equal(second.operatorNotes.length, 2);
  assert.equal(second.operatorNotes[1]?.action, "note");
  assert.equal(queue.get(seed.id)?.leaseToken, claimed.leaseToken, "a note never disturbs the live lease");
});

test("cancelling the final blocked descendant makes its specialty inactive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-cancel-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/core", true);
  const root = seedTestingGap(queue, "frostyard/core");
  const rootClaim = queue.claim({ worker: "claude:core:discovery" })!;
  const completion = queue.complete({
    id: root.id,
    leaseToken: rootClaim.leaseToken!,
    worker: "claude:core:discovery",
    result: { summary: "Found one gap.", evidence: ["src/example.ts"], artifacts: [] },
    followUps: [
      {
        kind: "test-implementation",
        objective: "Add the missing test.",
        instructions: "Add one test and run the check.",
        acceptanceCriteria: ["The test passes."],
        allowedActions: ["read", "write", "run-tests"],
        delegableActions: [],
      },
    ],
  });
  const child = queue.approve(completion.followUps[0]!.id, "operator:test");
  const childClaim = queue.claim({ worker: "codex:core:implementation" })!;
  queue.block(child.id, childClaim.leaseToken!, "codex:core:implementation", "Dependency unavailable.");
  assert.deepEqual(queue.activeRootKinds("frostyard/core"), ["testing-gap-discovery"]);

  assert.throws(() => queue.cancel(root.id, "operator:test", "not blocked"), /not blocked/);
  assert.throws(() => queue.cancel(child.id, "", "stop"), /actor is required/);
  assert.throws(() => queue.cancel(child.id, "operator:test", ""), /reason is required/);
  const cancelled = queue.cancel(child.id, "operator:test", "No longer needed.");
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.result, { summary: "No longer needed.", evidence: [], artifacts: [] });
  assert.deepEqual(queue.activeRootKinds("frostyard/core"), []);
  const event = queue.events(child.id).at(-1)!;
  assert.equal(event.type, "work.cancelled");
  assert.equal(event.actor, "operator:test");
  assert.deepEqual(event.payload, { reason: "No longer needed." });
});

test("opening an up-to-date database performs no schema writes, and unversioned databases migrate once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-migration-test-"));
  const path = join(directory, "queue.db");
  const first = new QueueStore(path);
  const raw = new DatabaseSync(path);
  test.after(() => {
    raw.close();
    first.close();
  });
  const pragma = (name: string) => Number((raw.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[name]);
  const schemaObjects = () =>
    (raw.prepare("SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger') ORDER BY name").all() as Row[])
      .map((row) => String(row.name));

  assert.equal(pragma("user_version"), SCHEMA_VERSION);
  const before = pragma("schema_version");
  const objectsBefore = schemaObjects();
  assert.ok(objectsBefore.includes("work_items_claimable"));
  assert.ok(objectsBefore.includes("work_items_claim_requires_admission"));
  assert.ok(objectsBefore.includes("work_items_children_start_proposed"));

  const second = new QueueStore(path);
  second.close();
  assert.equal(pragma("schema_version"), before, "a second open must not run any DDL");
  assert.equal(pragma("user_version"), SCHEMA_VERSION);
  assert.deepEqual(schemaObjects(), objectsBefore);

  // A database that has the tables but predates schema versioning migrates once.
  raw.exec("PRAGMA user_version = 0");
  raw.exec("DROP TRIGGER work_items_claim_requires_admission");
  const migrated = new QueueStore(path);
  migrated.close();
  assert.equal(pragma("user_version"), SCHEMA_VERSION);
  assert.deepEqual(schemaObjects(), objectsBefore);
  assert.ok(pragma("schema_version") > before, "migration is a real schema change");
  const afterMigration = pragma("schema_version");
  new QueueStore(path).close();
  assert.equal(pragma("schema_version"), afterMigration);
});

test("worker identities cannot use reserved principal namespaces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-principal-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/updex", true);
  const seed = seedTestingGap(queue, "frostyard/updex");

  for (const worker of ["operator:cli", "OPERATOR:dogfood", "policy:auto", "system:lease", "System", " system "]) {
    assert.throws(() => queue.claim({ worker, repository: "frostyard/updex" }), /reserved principal namespace/);
  }
  assert.equal(queue.get(seed.id)?.status, "queued");
  assert.equal(queue.get(seed.id)?.leaseOwner, undefined);
  assert.deepEqual(
    queue.events(seed.id).map((event) => event.type),
    ["work.queued"],
  );

  const claimed = queue.claim({ worker: "codex:updex:one", repository: "frostyard/updex" })!;
  assert.equal(claimed.id, seed.id);
  const attempt = (worker: string) => ({
    id: seed.id,
    leaseToken: claimed.leaseToken!,
    worker,
    result: { summary: "Spoofed.", evidence: ["none"], artifacts: [] },
    followUps: [
      {
        kind: "test-implementation",
        objective: "Look operator-authored.",
        instructions: "Read only.",
        acceptanceCriteria: ["Never created."],
        allowedActions: ["read" as const],
        delegableActions: [],
      },
    ],
  });
  assert.throws(() => queue.heartbeat(seed.id, claimed.leaseToken!, "operator:cli", 60), /reserved principal namespace/);
  assert.throws(() => queue.complete(attempt("operator:cli")), /reserved principal namespace/);
  assert.throws(() => queue.block(seed.id, claimed.leaseToken!, "system", "spoof"), /reserved principal namespace/);
  assert.throws(() => queue.release(seed.id, claimed.leaseToken!, "policy:x", "spoof"), /reserved principal namespace/);
  assert.equal(queue.get(seed.id)?.status, "claimed");
  assert.equal(queue.get(seed.id)?.leaseOwner, "codex:updex:one");
  assert.equal(queue.list({ repository: "frostyard/updex" }).length, 1);

  // Fluent's own principals still write their reserved names.
  const completion = queue.complete(attempt("codex:updex:one"));
  const approved = queue.approve(completion.followUps[0]!.id, "operator:cli");
  assert.equal(approved.status, "queued");
  assert.deepEqual(
    queue.events(approved.id).map((event) => [event.type, event.actor]),
    [
      ["work.proposed", "codex:updex:one"],
      ["work.approved", "operator:cli"],
    ],
  );
  assert.equal(seed.createdBy, "operator:test");
});

test("operator mutations honor a status/updatedAt precondition and refuse stale intent without changing anything", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-precondition-test-"));
  let now = new Date("2026-08-18T00:00:00.000Z");
  const tick = () => {
    now = new Date(now.getTime() + 1000);
  };
  const queue = new QueueStore(join(directory, "queue.db"), () => now);
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/core", true);
  const actor = "operator:test";

  // Fresh, admitted seed → make it proposed for approve/reject.
  const seedA = seedTestingGap(queue, "frostyard/core");
  tick();
  queue.defer(seedA.id, actor, "Hold for review.");
  const proposedA = queue.get(seedA.id)!;
  assert.equal(proposedA.status, "proposed");
  const stale = { status: proposedA.status, updatedAt: seedA.updatedAt }; // the pre-defer render
  assert.notEqual(stale.updatedAt, proposedA.updatedAt);

  const eventCount = (id: string) => queue.events(id).length;

  /** A mismatch throws the typed error, leaves the row byte-identical, and appends no event. */
  const assertRefused = (id: string, mutate: () => unknown, expectedStatus: string) => {
    const before = queue.get(id)!;
    const events = eventCount(id);
    assert.throws(mutate, (error: unknown) => {
      assert.ok(error instanceof PreconditionMismatchError);
      assert.equal(error.name, "PreconditionMismatchError");
      assert.equal(error.id, id);
      assert.equal(error.status, expectedStatus);
      assert.equal(error.updatedAt, before.updatedAt);
      assert.equal(
        error.message,
        `item changed since it was read: ${id} is now ${expectedStatus} (updated ${before.updatedAt})`,
      );
      return true;
    });
    assert.deepEqual(queue.get(id), before);
    assert.equal(eventCount(id), events);
  };

  // approve: stale updatedAt, wrong status, then a matching precondition succeeds.
  assertRefused(seedA.id, () => queue.approve(seedA.id, actor, stale), "proposed");
  assertRefused(seedA.id, () => queue.approve(seedA.id, actor, { status: "queued", updatedAt: proposedA.updatedAt }), "proposed");
  tick();
  const approved = queue.approve(seedA.id, actor, { status: "proposed", updatedAt: proposedA.updatedAt });
  assert.equal(approved.status, "queued");
  assert.equal(queue.events(seedA.id).at(-1)?.type, "work.approved");

  // defer: the item is queued now; the approve-time render is stale.
  assertRefused(seedA.id, () => queue.defer(seedA.id, actor, "again", { status: "queued", updatedAt: proposedA.updatedAt }), "queued");
  assertRefused(seedA.id, () => queue.defer(seedA.id, actor, "again", { status: "proposed", updatedAt: approved.updatedAt }), "queued");
  tick();
  const deferred = queue.defer(seedA.id, actor, "again", { status: "queued", updatedAt: approved.updatedAt });
  assert.equal(deferred.status, "proposed");

  // reject: proposed again.
  assertRefused(seedA.id, () => queue.reject(seedA.id, actor, "no", { status: "proposed", updatedAt: approved.updatedAt }), "proposed");
  assertRefused(seedA.id, () => queue.reject(seedA.id, actor, "no", { status: "queued", updatedAt: deferred.updatedAt }), "proposed");
  tick();
  const rejected = queue.reject(seedA.id, actor, "no", { status: "proposed", updatedAt: deferred.updatedAt });
  assert.equal(rejected.status, "cancelled");

  // prioritize + note on a second admitted seed.
  const seedB = seedTestingGap(queue, "frostyard/core");
  tick();
  queue.note(seedB.id, actor, "first note");
  const notedB = queue.get(seedB.id)!;
  assertRefused(seedB.id, () => queue.prioritize(seedB.id, actor, 5, "bump", { status: "queued", updatedAt: seedB.updatedAt }), "queued");
  assertRefused(seedB.id, () => queue.prioritize(seedB.id, actor, 5, "bump", { status: "proposed", updatedAt: notedB.updatedAt }), "queued");
  tick();
  const prioritized = queue.prioritize(seedB.id, actor, 5, "bump", { status: "queued", updatedAt: notedB.updatedAt });
  assert.equal(prioritized.priority, 5);
  assertRefused(seedB.id, () => queue.note(seedB.id, actor, "second", { status: "queued", updatedAt: notedB.updatedAt }), "queued");
  assertRefused(seedB.id, () => queue.note(seedB.id, actor, "second", { status: "blocked", updatedAt: prioritized.updatedAt }), "queued");
  tick();
  const noted = queue.note(seedB.id, actor, "second", { status: "queued", updatedAt: prioritized.updatedAt });
  assert.equal(noted.operatorNotes.at(-1)?.reason, "second");

  // requeue + cancel on blocked work: block a third seed, then a fourth.
  const block = (id: string) => {
    tick();
    const lease = queue.claim({ worker: "claude:core:pre", repository: "frostyard/core" })!;
    assert.equal(lease.id, id);
    tick();
    return queue.block(id, lease.leaseToken!, "claude:core:pre", "Need input.");
  };
  const blockedB = block(seedB.id);
  assert.equal(blockedB.status, "blocked");
  assertRefused(seedB.id, () => queue.requeue(seedB.id, actor, "go", { status: "blocked", updatedAt: noted.updatedAt }), "blocked");
  assertRefused(seedB.id, () => queue.requeue(seedB.id, actor, "go", { status: "queued", updatedAt: blockedB.updatedAt }), "blocked");
  tick();
  const requeued = queue.requeue(seedB.id, actor, "go", { status: "blocked", updatedAt: blockedB.updatedAt });
  assert.equal(requeued.status, "queued");

  const blockedAgain = block(seedB.id);
  assertRefused(seedB.id, () => queue.cancel(seedB.id, actor, "stop", { status: "blocked", updatedAt: requeued.updatedAt }), "blocked");
  assertRefused(seedB.id, () => queue.cancel(seedB.id, actor, "stop", { status: "queued", updatedAt: blockedAgain.updatedAt }), "blocked");
  tick();
  const cancelled = queue.cancel(seedB.id, actor, "stop", { status: "blocked", updatedAt: blockedAgain.updatedAt });
  assert.equal(cancelled.status, "cancelled");

  // Omitted precondition: unchanged behavior on every mutation.
  const seedC = seedTestingGap(queue, "frostyard/core");
  tick();
  assert.equal(queue.note(seedC.id, actor, "plain").operatorNotes.length, 1);
  tick();
  assert.equal(queue.prioritize(seedC.id, actor, 2, "plain").priority, 2);
  tick();
  assert.equal(queue.defer(seedC.id, actor, "plain").status, "proposed");
  tick();
  assert.equal(queue.approve(seedC.id, actor).status, "queued");
  const blockedC = block(seedC.id);
  tick();
  assert.equal(queue.requeue(seedC.id, actor, "plain").status, "queued");
  block(seedC.id);
  tick();
  assert.equal(queue.cancel(seedC.id, actor, "plain").status, "cancelled");
  const seedD = seedTestingGap(queue, "frostyard/core");
  tick();
  queue.defer(seedD.id, actor, "plain");
  tick();
  assert.equal(queue.reject(seedD.id, actor, "plain").status, "cancelled");
  assert.equal(blockedC.status, "blocked");
});

test("approve, reject, and cancel accept only operator or policy actors and change nothing for anyone else", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-admission-actor-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/core", true);

  /** The call throws naming the namespace rule, and the item and its ledger are byte-identical afterwards. */
  const refused = (id: string, call: () => unknown) => {
    const before = queue.get(id)!;
    const events = queue.events(id).length;
    assert.throws(call, /must use the operator: or policy: principal namespace/);
    assert.deepEqual(queue.get(id), before);
    assert.equal(queue.events(id).length, events);
  };
  const forbidden = ["claude:core:worker", "copilot-cli:frostyard/core:1", "system:", "system:lease-expiry", "System:Ops"];

  // approve / reject on proposed items: one proposal per outcome, refused for every worker and system actor first.
  const proposeOne = () => {
    const seed = seedTestingGap(queue, "frostyard/core");
    queue.defer(seed.id, "operator:test", "hold");
    assert.equal(queue.get(seed.id)!.status, "proposed");
    return seed.id;
  };
  const toApprove = proposeOne();
  for (const actor of forbidden) refused(toApprove, () => queue.approve(toApprove, actor));
  assert.throws(() => queue.approve(toApprove, ""), /approval actor is required/);
  assert.equal(queue.approve(toApprove, "policy:test").status, "queued");
  assert.equal(queue.events(toApprove).at(-1)!.actor, "policy:test");
  const toReject = proposeOne();
  for (const actor of forbidden) refused(toReject, () => queue.reject(toReject, actor, "no"));
  assert.throws(() => queue.reject(toReject, "", "no"), /rejection actor is required/);
  assert.equal(queue.reject(toReject, "operator:test", "no").status, "cancelled");
  const toRejectByPolicy = proposeOne();
  assert.equal(queue.reject(toRejectByPolicy, "policy:test", "no").status, "cancelled");

  // cancel on a blocked item.
  queue.setRepositoryEnabled("frostyard/blocked", true); // separate repository so the approved item above is not what gets claimed
  const blockOne = () => {
    const seed = seedTestingGap(queue, "frostyard/blocked");
    const lease = queue.claim({ worker: "claude:core:w", repository: "frostyard/blocked" })!;
    assert.equal(lease.id, seed.id);
    queue.block(seed.id, lease.leaseToken!, "claude:core:w", "need input");
    return seed.id;
  };
  const toCancel = blockOne();
  for (const actor of forbidden) refused(toCancel, () => queue.cancel(toCancel, actor, "stop"));
  assert.throws(() => queue.cancel(toCancel, "", "stop"), /cancellation actor is required/);
  assert.equal(queue.cancel(toCancel, "operator:test", "stop").status, "cancelled");
  const toCancelByPolicy = blockOne();
  assert.equal(queue.cancel(toCancelByPolicy, "policy:test", "stop").status, "cancelled");
  assert.equal(queue.events(toCancelByPolicy).at(-1)!.actor, "policy:test");
});

type Row = Record<string, unknown>;

function seedTestingGap(queue: QueueStore, repository: string) {
  return queue.enqueueSeed({
    repository,
    kind: "testing-gap-discovery",
    objective: "Identify one meaningful testing gap and propose a test that covers it.",
    instructions: "Read and report one gap. Do not edit files. Create a bounded implementation follow-up.",
    acceptanceCriteria: ["Exactly one gap has file-level evidence."],
    allowedActions: ["read", "create-followup"],
    delegableActions: ["read", "write", "run-tests", "open-pr", "create-followup"],
    createdBy: "operator:test",
  });
}

test("eventsSince reads the ledger across items in global order with joined item fields and no lease token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-events-since-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  for (const repository of ["frostyard/updex", "frostyard/lodge"]) queue.setRepositoryEnabled(repository, true);

  const updex = queue.enqueueSeed({
    repository: "frostyard/updex",
    kind: "test-implementation",
    objective: "Land a test via pull request.",
    instructions: "Write the test and open a pull request.",
    acceptanceCriteria: ["The pull request contains the new test."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const [lodge] = queue.enqueueProposedRoots("frostyard/lodge", [
    {
      kind: "issue-resolution",
      objective: "Resolve lodge#4.",
      instructions: "Read the issue.",
      acceptanceCriteria: ["A pull request closes the issue."],
      allowedActions: ["read"],
      delegableActions: [],
      createdBy: "operator:import-issues",
      sourceRef: "https://github.com/frostyard/lodge/issues/4",
    },
  ]).created;
  const claimed = queue.claim({ worker: "codex:updex:events", repository: "frostyard/updex" })!;
  queue.heartbeat(claimed.id, claimed.leaseToken!, "codex:updex:events");
  const pullRequest = "https://github.com/frostyard/updex/pull/9";
  queue.complete({
    id: claimed.id,
    leaseToken: claimed.leaseToken!,
    worker: "codex:updex:events",
    result: { summary: "Opened the pull request.", evidence: ["test/queue.test.ts"], artifacts: [{ kind: "pull-request", url: pullRequest }] },
    followUps: [],
  });
  queue.recordArtifactVerification(
    claimed.id,
    pullRequest,
    { status: "verified", verifiedAt: "2026-08-17T00:00:00.000Z", number: 9, state: "open", headSha: "abc" },
    "operator:test",
  );

  const all = queue.eventsSince(0);
  assert.deepEqual(
    all.map((event) => event.type),
    ["work.queued", "work.proposed", "work.claimed", "lease.renewed", "work.completed", "artifact.verified"],
  );
  assert.deepEqual(
    all.map((event) => event.sequence),
    all.map((_, index) => index + 1),
    "events come back in global sequence order",
  );
  assert.equal(all.every((event, index) => index === 0 || event.sequence > all[index - 1]!.sequence), true);
  const first = all[0]!;
  assert.equal(first.workItemId, updex.id);
  assert.equal(first.repository, "frostyard/updex");
  assert.equal(first.kind, "test-implementation");
  assert.equal(first.sourceRef, undefined);
  assert.equal(first.status, "completed", "joined status is the item's current status, not the status at event time");
  const proposed = all[1]!;
  assert.equal(proposed.workItemId, lodge!.id);
  assert.equal(proposed.repository, "frostyard/lodge");
  assert.equal(proposed.kind, "issue-resolution");
  assert.equal(proposed.sourceRef, "https://github.com/frostyard/lodge/issues/4");
  assert.equal(proposed.status, "proposed");
  assert.equal(all.at(-1)?.payload.url, pullRequest);

  const later = queue.eventsSince(2);
  assert.deepEqual(later.map((event) => event.sequence), [3, 4, 5, 6]);
  assert.deepEqual(queue.eventsSince(6), []);
  assert.deepEqual(
    queue.eventsSince(0, { repository: "frostyard/lodge" }).map((event) => event.type),
    ["work.proposed"],
  );
  assert.deepEqual(queue.eventsSince(0, { limit: 2 }).map((event) => event.sequence), [1, 2]);

  const serialized = JSON.stringify(all);
  assert.equal(serialized.includes(claimed.leaseToken!), false, "no event, including work.claimed, carries the lease token");
  assert.equal(/leaseToken/.test(serialized), false);
  for (const event of all) assert.equal("leaseToken" in event, false);

  assert.throws(() => queue.eventsSince(-1), /non-negative integer/);
  assert.throws(() => queue.eventsSince(0, { limit: 0 }), /between 1 and 500/);
  assert.throws(() => queue.eventsSince(0, { limit: 501 }), /between 1 and 500/);
  assert.throws(() => queue.eventsSince(0, { repository: "not-a-slug" }));
});

test("rename-repository carries the opt-in and every item to the new slug and leaves history alone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-rename-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/fluent", true);
  queue.setRepositoryCureForeign("frostyard/fluent", true);
  const root = queue.enqueueSeed({
    repository: "frostyard/fluent",
    kind: "quality-gap-discovery",
    objective: "Find one gap.",
    instructions: "Read only.",
    acceptanceCriteria: ["One gap."],
    allowedActions: ["read"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const imported = queue.enqueueProposedRoots("frostyard/fluent", [
    {
      sourceRef: "https://github.com/frostyard/fluent/issues/7",
      kind: "issue-resolution",
      objective: "Resolve #7",
      instructions: "Do it.",
      acceptanceCriteria: ["PR open."],
      allowedActions: ["read", "write", "open-pr"],
      delegableActions: [],
      createdBy: "operator:test",
    },
  ]);
  assert.throws(() => queue.renameRepository("frostyard/fluent", "frostyard/fluent", "operator:test"), /different slug/);
  assert.throws(() => queue.renameRepository("frostyard/nope", "frostyard/snowcat", "operator:test"), /not known/);
  assert.throws(() => queue.renameRepository("frostyard/fluent", "frostyard/snowcat", "claude:worker"), /operator: or policy:/);
  const renamed = queue.renameRepository("frostyard/fluent", "frostyard/snowcat", "operator:test");
  assert.deepEqual(renamed, { from: "frostyard/fluent", to: "frostyard/snowcat", items: 2 });
  assert.deepEqual(queue.enabledRepositories(), ["frostyard/snowcat"]);
  assert.deepEqual(queue.repositoryCureSettings(), [{ repository: "frostyard/snowcat", cureForeign: true }]);
  assert.equal(queue.get(root.id)?.repository, "frostyard/snowcat");
  assert.equal(queue.get(imported.created[0]!.id)?.sourceRef, "https://github.com/frostyard/fluent/issues/7", "history keeps the recorded string");
  assert.equal(queue.list({ repository: "frostyard/fluent" }).length, 0);
  assert.equal(queue.list({ repository: "frostyard/snowcat" }).length, 2);
  assert.throws(() => queue.renameRepository("frostyard/snowcat", "frostyard/snowcat2", "operator:test") && queue.renameRepository("frostyard/snowcat2", "frostyard/snowcat2", "operator:test"), /different slug/);
  // Claiming under the new slug works; the old slug is gone.
  assert.equal(queue.claim({ worker: "claude:rename-test", repository: "frostyard/snowcat2" })?.id, root.id);
});

