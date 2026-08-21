import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { QueueStore } from "../src/queue/store.ts";

// A single corrupt persisted-JSON value must never turn a bounded read into an
// uncaught exception: every persisted-JSON column in src/queue/store.ts is read
// through the defensive parseJson helper, which degrades to a fallback rather
// than throwing. This test corrupts each such column with a malformed string
// through a second connection and asserts the corresponding read still returns
// its fallback / null contract.
test("store read paths tolerate malformed persisted JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-parse-"));
  const dbPath = join(directory, "queue.db");
  const queue = new QueueStore(dbPath);
  test.after(() => queue.close());

  const repository = "frostyard/updex";
  queue.setRepositoryEnabled(repository, true);

  // 1) mcp_tokens.kinds_json (decodeMcpToken).
  const owner = "member:parse@example.com";
  const { record } = queue.mintMcpToken({ owner, client: "parse-client", kinds: ["pr-review"] });

  // 2) repositories.unreported_pull_requests_json (repositoryUnreportedPullRequests).
  queue.recordUnreportedPullRequests(
    repository,
    { observedAt: new Date().toISOString(), pullRequests: [] },
    "operator:test",
  );

  // 3) repositories.labeled_issue_observations_json (repositoryLabeledIssueObservations).
  queue.recordLabeledIssueObservations(
    repository,
    [{ url: `https://github.com/${repository}/issues/1`, title: "example", outcome: "existing" }],
    "operator:test",
  );

  // 4) work_items.result_json on the metricsWindow path: create, claim, complete.
  const seed = queue.enqueueSeed({
    repository,
    kind: "testing-gap-discovery",
    objective: "Identify one meaningful testing gap.",
    instructions: "Read and report one gap.",
    acceptanceCriteria: ["Exactly one gap has file-level evidence."],
    allowedActions: ["read", "create-followup"],
    delegableActions: ["read"],
    createdBy: "operator:test",
  });
  const claimed = queue.claim({ worker: "codex:updex:one", repository, leaseSeconds: 60 });
  assert.ok(claimed, "expected to claim the seeded item");
  assert.equal(claimed.id, seed.id);
  queue.complete({
    id: claimed.id,
    leaseToken: claimed.leaseToken!,
    worker: "codex:updex:one",
    result: { summary: "done", evidence: ["evidence"], artifacts: [] },
    followUps: [],
  });

  // Corrupt every persisted-JSON column with a malformed string via a second
  // connection, then close it so the store's connection is unobstructed.
  const raw = new DatabaseSync(dbPath);
  raw.prepare("UPDATE mcp_tokens SET kinds_json = ? WHERE id = ?").run("{not valid json", record.id);
  raw
    .prepare("UPDATE repositories SET unreported_pull_requests_json = ?, labeled_issue_observations_json = ? WHERE slug = ?")
    .run("{not valid json", "{not valid json", repository);
  raw.prepare("UPDATE work_items SET result_json = ? WHERE id = ?").run("{not valid json", claimed.id);
  raw.close();

  // None of these reads may throw; each degrades to its documented fallback.
  assert.doesNotThrow(() => queue.listMcpTokens(owner));
  const tokens = queue.listMcpTokens(owner);
  assert.equal(tokens.length, 1);

  assert.doesNotThrow(() => queue.repositoryUnreportedPullRequests(repository));
  assert.equal(queue.repositoryUnreportedPullRequests(repository), undefined);

  assert.doesNotThrow(() => queue.repositoryLabeledIssueObservations(repository));
  assert.equal(queue.repositoryLabeledIssueObservations(repository), undefined);

  const now = Date.now();
  const since = new Date(now - 3_600_000).toISOString();
  const until = new Date(now + 3_600_000).toISOString();
  assert.doesNotThrow(() => queue.metricsWindow({ since, until, repository }));
});
