import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PreconditionMismatchError, QueueStore, SCHEMA_VERSION } from "../src/queue/store.ts";
import type { ArtifactVerification } from "../src/queue/types.ts";

const MERGED: ArtifactVerification = {
  status: "verified",
  verifiedAt: "2026-08-18T12:00:00.000Z",
  number: 326,
  state: "merged",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  mergedAt: "2026-08-18T11:30:00.000Z",
};

/** A local-only follow-up (no open-pr) completed with an empty artifact list, as the four updex items were. */
function completedLocalOnly(queue: QueueStore, repository = "frostyard/updex") {
  const seed = queue.enqueueSeed({
    repository,
    kind: "quality-implementation",
    objective: "Make the merged-state signal instance-scoped.",
    instructions: "Implement on a local branch; do not open a pull request.",
    acceptanceCriteria: ["Tests pass."],
    allowedActions: ["read", "write", "run-tests"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const lease = queue.claim({ worker: "claude:updex:local", repository })!;
  queue.complete({
    id: seed.id,
    leaseToken: lease.leaseToken!,
    worker: "claude:updex:local",
    result: { summary: "Change left on branch fix/instance-scoped.", evidence: ["make check green"], artifacts: [] },
    followUps: [],
  });
  return queue.get(seed.id)!;
}

test("attachArtifact appends a verified pull request to a completed item so delivery reads merged, once per URL, with one artifact.attached event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-attach-artifact-test-"));
  let now = new Date("2026-08-18T12:00:00.000Z");
  const queue = new QueueStore(join(directory, "queue.db"), () => now);
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/updex", true);
  assert.equal(SCHEMA_VERSION, 8, "attaching needs no schema rung of its own: result_json already holds artifacts (rung 5 is the pull-request cure column, rung 6 the repository cure_foreign setting, rung 7 the mcp_tokens table, rung 8 the review gate)");

  const completed = completedLocalOnly(queue);
  assert.equal(completed.delivery, "none");
  const url = "https://github.com/frostyard/updex/pull/326";

  now = new Date("2026-08-18T12:05:00.000Z");
  const attached = queue.attachArtifact(completed.id, "operator:cli", { kind: "pull-request", url, description: "Opened by the operator from the local branch", verification: MERGED });
  assert.equal(attached.status, "completed");
  assert.equal(attached.delivery, "merged");
  assert.deepEqual(attached.result!.artifacts, [{ kind: "pull-request", url, description: "Opened by the operator from the local branch", verification: MERGED }]);
  assert.equal(attached.result!.summary, completed.result!.summary, "the worker's result text is untouched");
  assert.notEqual(attached.updatedAt, completed.updatedAt);
  assert.equal(queue.get(completed.id)!.delivery, "merged", "delivery is derived on read from the stored artifact");

  // The same URL is attached at most once; a second attempt writes nothing.
  const before = queue.get(completed.id)!;
  assert.throws(() => queue.attachArtifact(completed.id, "operator:cli", { kind: "pull-request", url, verification: MERGED }), /artifact already reported: https:\/\/github\.com\/frostyard\/updex\/pull\/326/);
  assert.deepEqual(queue.get(completed.id), before);

  // Exactly one artifact.attached event, naming url, kind, status, and state.
  const attachedEvents = queue.events(completed.id).filter((event) => event.type === "artifact.attached");
  assert.equal(attachedEvents.length, 1);
  assert.equal(attachedEvents[0]!.actor, "operator:cli");
  assert.deepEqual(attachedEvents[0]!.payload, { url, kind: "pull-request", status: "verified", state: "merged" });
  assert.equal(queue.events(completed.id).at(-1)!.type, "artifact.attached", "the refused second attach recorded nothing");

  // The attached artifact then behaves like any reported one: verify-artifacts' recorder replaces its verification.
  const issueUrl = "https://github.com/frostyard/updex/issues/300";
  queue.attachArtifact(completed.id, "operator:web", {
    kind: "issue",
    url: issueUrl,
    verification: { status: "unverified", attemptedAt: "2026-08-18T12:06:00.000Z", reason: "GitHub API unavailable" },
  });
  const reverified = queue.recordArtifactVerification(
    completed.id,
    issueUrl,
    { status: "verified", verifiedAt: "2026-08-18T12:10:00.000Z", number: 300, state: "closed" },
    "operator:cli",
  );
  assert.equal(reverified.result!.artifacts.length, 2);
  assert.equal(reverified.result!.artifacts[1]!.verification!.status, "verified");
  assert.equal(queue.events(completed.id).at(-1)!.type, "artifact.verified");
});

test("attachArtifact refuses non-completed items, other repositories, non-GitHub kinds, missing verification, worker actors, and stale preconditions without writing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-attach-artifact-refusals-test-"));
  let now = new Date("2026-08-18T12:00:00.000Z");
  const queue = new QueueStore(join(directory, "queue.db"), () => now);
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/updex", true);
  const url = "https://github.com/frostyard/updex/pull/327";

  const assertUnchanged = (id: string, attempt: () => unknown, expected: RegExp | ((error: unknown) => boolean)) => {
    const before = queue.get(id)!;
    const events = queue.events(id).length;
    assert.throws(attempt, expected);
    assert.deepEqual(queue.get(id), before);
    assert.equal(queue.events(id).length, events);
  };

  const completed = completedLocalOnly(queue);

  // A queued item has no result to attach to.
  const queued = queue.enqueueSeed({
    repository: "frostyard/updex",
    kind: "quality-implementation",
    objective: "Still queued.",
    instructions: "Do it.",
    acceptanceCriteria: ["Done."],
    allowedActions: ["read", "write"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  assert.equal(queued.status, "queued");
  assertUnchanged(queued.id, () => queue.attachArtifact(queued.id, "operator:cli", { kind: "pull-request", url, verification: MERGED }), /work item is not completed/);

  // Only an operator or policy actor may attach.
  assertUnchanged(completed.id, () => queue.attachArtifact(completed.id, "claude:updex:local", { kind: "pull-request", url, verification: MERGED }), /must use the operator:, policy:, or member: principal namespace/);
  // Only the item's own repository.
  assertUnchanged(
    completed.id,
    () => queue.attachArtifact(completed.id, "operator:cli", { kind: "pull-request", url: "https://github.com/frostyard/lodge/pull/1", verification: { ...MERGED, number: 1 } }),
    /artifact pull-request URL must match https:\/\/github\.com\/frostyard\/updex\/pull\/<positive integer>/,
  );
  // Only issue or pull-request kinds, and never without a verification.
  assertUnchanged(
    completed.id,
    () => queue.attachArtifact(completed.id, "operator:cli", { kind: "commit" as "issue", url: "https://github.com/frostyard/updex/commit/0123456789abcdef", verification: MERGED }),
    /artifact kind must be issue or pull-request/,
  );
  assertUnchanged(
    completed.id,
    () => queue.attachArtifact(completed.id, "operator:cli", { kind: "pull-request", url, verification: undefined as unknown as ArtifactVerification }),
    /attached artifact requires a verification/,
  );
  assertUnchanged(
    completed.id,
    () => queue.attachArtifact(completed.id, "operator:cli", { kind: "pull-request", url, verification: { status: "bogus" } as unknown as ArtifactVerification }),
    /verification status is invalid/,
  );

  // Rule 39: a precondition naming a stale updatedAt is refused with the typed error and no write.
  now = new Date("2026-08-18T12:01:00.000Z");
  queue.note(completed.id, "operator:cli", "PR opened by hand from the local branch.");
  const moved = queue.get(completed.id)!;
  assert.notEqual(moved.updatedAt, completed.updatedAt);
  assertUnchanged(
    completed.id,
    () => queue.attachArtifact(completed.id, "operator:cli", { kind: "pull-request", url, verification: MERGED }, { status: "completed", updatedAt: completed.updatedAt }),
    (error: unknown) => {
      assert.ok(error instanceof PreconditionMismatchError);
      assert.equal(error.status, "completed");
      assert.equal(error.updatedAt, moved.updatedAt);
      return true;
    },
  );
  // A precondition naming the current render is honored.
  now = new Date("2026-08-18T12:02:00.000Z");
  const attached = queue.attachArtifact(completed.id, "policy:backfill", { kind: "pull-request", url, verification: MERGED }, { status: "completed", updatedAt: moved.updatedAt });
  assert.equal(attached.delivery, "merged");
  assert.equal(queue.events(completed.id).filter((event) => event.type === "artifact.attached").length, 1);
});
