import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { QueueStore } from "../src/queue/store.ts";
import { readInbox } from "../src/surface/inbox.ts";

const REPOSITORY = "frostyard/updex";

function completeWithPullRequest(queue: QueueStore, worker: string, number: number, verification: Record<string, unknown>): string {
  queue.enqueueSeed({
    repository: REPOSITORY,
    kind: "issue-resolution",
    objective: `Resolve #${number}`,
    instructions: "Open a PR.",
    acceptanceCriteria: ["PR open."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const claimed = queue.claim({ worker })!;
  const completion = queue.complete({
    id: claimed.id,
    leaseToken: claimed.leaseToken!,
    worker,
    result: {
      summary: "Done.",
      evidence: [],
      artifacts: [{ kind: "pull-request", url: `https://github.com/frostyard/updex/pull/${number}`, verification } as never],
    },
    followUps: [],
  });
  return completion.completed.id;
}

// The inbox's "unverified artifacts" group is selected in the store (completed
// items with an unverified issue/pull-request artifact, newest first), not
// filtered out of list()'s first 100 completions: with more than 100 older,
// fully verified completions ahead of it, a newer unverified completion still
// appears, and the group is not flagged as truncated.
test("the inbox lists a newer unverified completion behind more than 100 terminal completions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-inbox-unverified-test-"));
  let now = Date.parse("2026-08-19T08:00:00.000Z");
  const queue = new QueueStore(join(directory, "queue.db"), () => new Date(now));
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);

  for (let index = 0; index < 105; index += 1) {
    now += 1000;
    completeWithPullRequest(queue, "claude:inbox-test", 1000 + index, {
      status: "verified",
      verifiedAt: new Date(now).toISOString(),
      number: 1000 + index,
      state: "merged",
      mergedAt: new Date(now).toISOString(),
    });
  }
  now += 1000;
  const newer = completeWithPullRequest(queue, "claude:inbox-test", 12, {
    status: "unverified",
    attemptedAt: new Date(now).toISOString(),
    reason: "GitHub API returned HTTP 504",
  });
  assert.equal(queue.list({ status: "completed", limit: 100 }).some((item) => item.id === newer), false, "list()'s 100-row page does not reach the newer item");

  const inbox = readInbox(queue, undefined);
  assert.deepEqual(inbox.unverified.map((row) => row.item.id), [newer]);
  assert.equal(inbox.unverified[0]?.artifact.verification.status, "unverified");
  assert.equal(inbox.stats.unverified, 1);
  assert.ok(!inbox.truncated.includes("unverified artifacts"), `truncated = ${inbox.truncated}`);
});

// The narrowed predicate: a verified-but-open pull request is pending for the
// sweeps but not for the inbox.
test("completedItemsWithPendingArtifacts with unverifiedOnly excludes verified open artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-inbox-predicate-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);
  const open = completeWithPullRequest(queue, "claude:inbox-test", 20, { status: "verified", verifiedAt: "2026-08-19T08:00:00.000Z", number: 20, state: "open", headSha: "a".repeat(40) });
  const unverified = completeWithPullRequest(queue, "claude:inbox-test", 21, { status: "unverified", attemptedAt: "2026-08-19T08:00:00.000Z", reason: "outage" });

  assert.deepEqual(queue.completedItemsWithPendingArtifacts({ repository: REPOSITORY }).map((item) => item.id).sort(), [open, unverified].sort());
  assert.deepEqual(queue.completedItemsWithPendingArtifacts({ repository: REPOSITORY, unverifiedOnly: true }).map((item) => item.id), [unverified]);
  assert.deepEqual(readInbox(queue, undefined).unverified.map((row) => row.item.id), [unverified]);
});
