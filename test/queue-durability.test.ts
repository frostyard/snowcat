import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { QueueStore, SCHEMA_VERSION } from "../src/queue/store.ts";

type Row = Record<string, unknown>;

/**
 * Builds a version-1 queue database by hand: the baseline tables and triggers
 * without `queue_metadata`, stamped `user_version = 1`, with one opted-in
 * repository, one queued item, and one event — the shape every pre-ladder
 * database on an operator host has.
 */
function createVersionOneDatabase(path: string): { itemId: string } {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE repositories (
      slug TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE work_items (
      id TEXT PRIMARY KEY,
      root_id TEXT NOT NULL,
      parent_id TEXT REFERENCES work_items(id),
      repository TEXT NOT NULL REFERENCES repositories(slug),
      kind TEXT NOT NULL,
      objective TEXT NOT NULL,
      instructions TEXT NOT NULL,
      acceptance_criteria_json TEXT NOT NULL,
      allowed_actions_json TEXT NOT NULL,
      delegable_actions_json TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'completed', 'blocked', 'cancelled')),
      admitted INTEGER NOT NULL DEFAULT 1 CHECK (admitted IN (0, 1)),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_token TEXT,
      lease_expires_at TEXT,
      result_json TEXT
    );
    CREATE TABLE work_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id TEXT NOT NULL REFERENCES work_items(id),
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    CREATE INDEX work_items_claimable
      ON work_items(status, admitted, lease_expires_at, priority DESC, created_at);
    CREATE INDEX work_items_lineage ON work_items(root_id, parent_id);
    CREATE TRIGGER work_items_claim_requires_admission
      BEFORE UPDATE OF status ON work_items
      WHEN NEW.status = 'claimed' AND (OLD.admitted = 0 OR NEW.admitted = 0)
    BEGIN
      SELECT RAISE(ABORT, 'work item must be admitted before it can be claimed');
    END;
    CREATE TRIGGER work_items_children_start_proposed
      BEFORE INSERT ON work_items
      WHEN NEW.parent_id IS NOT NULL AND NEW.admitted = 1
    BEGIN
      SELECT RAISE(ABORT, 'child work items must be created as proposed (admitted = 0)');
    END;
    INSERT INTO repositories VALUES ('frostyard/updex', 1, '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z');
    INSERT INTO work_items (
      id, root_id, repository, kind, objective, instructions, acceptance_criteria_json,
      allowed_actions_json, delegable_actions_json, priority, status, admitted, created_by, created_at, updated_at
    ) VALUES (
      '11111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'frostyard/updex',
      'testing-gap-discovery', 'Find one gap.', 'Read only.', '["One gap."]', '["read"]', '[]',
      3, 'queued', 1, 'operator:legacy', '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z'
    );
    INSERT INTO work_events (work_item_id, event_type, actor, payload_json, occurred_at)
      VALUES ('11111111-1111-4111-8111-111111111111', 'work.queued', 'operator:legacy', '{"root":true}', '2026-08-15T00:00:00.000Z');
    PRAGMA user_version = 1;
  `);
  db.close();
  return { itemId: "11111111-1111-4111-8111-111111111111" };
}

test("a version-1 database upgrades in place through the ladder and keeps its history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-ladder-test-"));
  const path = join(directory, "queue.db");
  const { itemId } = createVersionOneDatabase(path);
  assert.equal(SCHEMA_VERSION, 10, "this test pins the ladder at rung 10; extend it when a rung is added");

  const queue = new QueueStore(path);
  test.after(() => queue.close());

  assert.equal(queue.schemaVersion(), SCHEMA_VERSION);
  const metadata = queue.metadata();
  assert.match(metadata.databaseId, /^[0-9a-f-]{36}$/);
  assert.equal(metadata.schemaVersion, SCHEMA_VERSION);
  assert.equal(metadata.workItems, 1);
  assert.equal(metadata.workEvents, 1);
  assert.equal(metadata.lastEventSequence, 1);

  // History and behavior survive: the legacy item is still claimable and keeps its priority.
  const item = queue.get(itemId);
  assert.equal(item?.status, "queued");
  assert.equal(item?.priority, 3);
  const claimed = queue.claim({ worker: "claude:ladder-test" });
  assert.equal(claimed?.id, itemId);

  // Rung 7 arrived too: MCP tokens mint and verify on the upgraded database.
  const minted = queue.mintMcpToken({ owner: "member:ladder@frostyard.org", client: "ladder-test" });
  assert.equal(queue.verifyMcpToken(minted.token)?.client, "ladder-test");
  assert.equal(queue.verifyMcpToken(minted.token)?.kinds, undefined, "rung 9 leaves a token unrestricted unless kinds are given");

  // Rung 9 arrived too: a restricted token is stored and read back sorted.
  const restricted = queue.mintMcpToken({ owner: "member:ladder@frostyard.org", client: "ladder-reviewer", kinds: ["pr-review-fix", "pr-review"] });
  assert.deepEqual(queue.verifyMcpToken(restricted.token)?.kinds, ["pr-review", "pr-review-fix"]);

  // Rung 5 arrived too: a pr-cure root carries its typed cure record on the upgraded database.
  const cured = queue.enqueueCureRoot("frostyard/updex", {
    sourceRef: "https://github.com/frostyard/updex/pull/9@" + "c".repeat(40),
    kind: "pr-cure",
    objective: "Cure #9",
    instructions: "Mechanical only.",
    acceptanceCriteria: ["Patch unchanged."],
    allowedActions: ["read", "write", "run-tests", "open-pr", "create-followup"],
    delegableActions: ["read", "write", "run-tests", "open-pr"],
    createdBy: "operator:test",
    cure: { pullRequestUrl: "https://github.com/frostyard/updex/pull/9", headSha: "c".repeat(40), patchDigest: `sha256:${"1".repeat(64)}`, decay: ["behind"] },
  });
  assert.deepEqual(queue.get(cured!.id)?.cure?.decay, ["behind"]);

  // Rung 8 arrived too: a pr-review root carries its typed review record and the repository has a review-gate setting.
  const reviewed = queue.enqueueReviewRoot("frostyard/updex", {
    sourceRef: "pr-review:https://github.com/frostyard/updex/pull/9@" + "c".repeat(40),
    kind: "pr-review",
    objective: "Review #9",
    instructions: "Read-only.",
    acceptanceCriteria: ["Verdict supplied."],
    allowedActions: ["read", "run-tests"],
    delegableActions: [],
    createdBy: "policy:review-gate",
    review: { pullRequestUrl: "https://github.com/frostyard/updex/pull/9", headSha: "c".repeat(40), round: 1, priorBlockers: [] },
  });
  assert.equal(queue.get(reviewed!.id)?.review?.round, 1);
  assert.deepEqual(queue.repositoryReviewGateSettings(), [{ repository: "frostyard/updex", reviewGate: false }]);

  // Rung 3 arrived too: imported roots can be recorded and deduplicated on the upgraded database.
  const imported = queue.enqueueProposedRoots("frostyard/updex", [
    {
      sourceRef: "https://github.com/frostyard/updex/issues/7",
      kind: "issue-resolution",
      objective: "Resolve #7",
      instructions: "Do it.",
      acceptanceCriteria: ["PR open."],
      allowedActions: ["read", "write", "open-pr"],
      delegableActions: [],
      createdBy: "operator:test",
    },
  ]);
  assert.equal(imported.created.length, 1);
  assert.equal(imported.created[0]?.status, "proposed");
  assert.equal(imported.created[0]?.sourceRef, "https://github.com/frostyard/updex/issues/7");

  // Rung 4 arrived too: legacy items read as note-free, and operator notes can be appended.
  assert.deepEqual(queue.get(itemId)?.operatorNotes, []);
  assert.deepEqual(queue.get(itemId)?.previousResults, []);
  const noted = queue.note(itemId, "operator:ladder-test", "Carried across the upgrade.");
  assert.equal(noted.operatorNotes.length, 1);
  assert.equal(noted.operatorNotes[0]?.action, "note");

  // Re-opening runs no rungs and preserves the identity assigned during upgrade.
  const again = new QueueStore(path);
  assert.equal(again.metadata().databaseId, metadata.databaseId);
  again.close();
});

test("a version-3 database upgrades in place through rung 4 and keeps a blocked item's history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-ladder-v3-test-"));
  const path = join(directory, "queue.db");
  const { itemId } = createVersionOneDatabase(path);
  // Bring the hand-built database to exactly version 3 with rungs 2 and 3's
  // objects, then park the item as blocked the way pre-rung-4 code left it.
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE queue_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO queue_metadata (key, value) VALUES ('database_id', '22222222-2222-4222-8222-222222222222');
    INSERT INTO queue_metadata (key, value) VALUES ('created_at', '2026-08-15T00:00:00.000Z');
    ALTER TABLE work_items ADD COLUMN source_ref TEXT;
    CREATE UNIQUE INDEX work_items_source_ref ON work_items(repository, source_ref) WHERE source_ref IS NOT NULL;
    UPDATE work_items SET status = 'blocked', result_json = '{"summary":"Needs a credential.","evidence":[],"artifacts":[]}'
      WHERE id = '${itemId}';
    INSERT INTO work_events (work_item_id, event_type, actor, payload_json, occurred_at)
      VALUES ('${itemId}', 'work.blocked', 'claude:legacy', '{"reason":"Needs a credential."}', '2026-08-15T01:00:00.000Z');
    PRAGMA user_version = 3;
  `);
  raw.close();

  const queue = new QueueStore(path);
  test.after(() => queue.close());
  assert.equal(queue.schemaVersion(), SCHEMA_VERSION);
  assert.equal(queue.metadata().databaseId, "22222222-2222-4222-8222-222222222222");
  const inspect = new DatabaseSync(path, { readOnly: true });
  const columns = new Set((inspect.prepare("PRAGMA table_info(work_items)").all() as Row[]).map((column) => String(column.name)));
  inspect.close();
  assert.ok(columns.has("operator_notes_json"));
  assert.ok(columns.has("previous_results_json"));

  const blocked = queue.get(itemId)!;
  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.operatorNotes, []);
  assert.deepEqual(blocked.previousResults, []);

  const requeued = queue.requeue(itemId, "operator:ladder-test", "Credential supplied; resume.");
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.result, undefined);
  assert.deepEqual(requeued.previousResults, [{ summary: "Needs a credential.", evidence: [], artifacts: [] }]);
  assert.deepEqual(
    requeued.operatorNotes.map((note) => [note.actor, note.action, note.reason]),
    [["operator:ladder-test", "requeue", "Credential supplied; resume."]],
  );
  const claimed = queue.claim({ worker: "claude:ladder-test" });
  assert.equal(claimed?.id, itemId);
  assert.equal(claimed?.operatorNotes[0]?.reason, "Credential supplied; resume.");
});

test("a version-5 database gains rung 6's cure_foreign column, off for every existing repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-ladder-v5-test-"));
  const path = join(directory, "queue.db");
  createVersionOneDatabase(path);
  // Bring the hand-built database to exactly version 5 with rungs 2–5's objects.
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE queue_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO queue_metadata (key, value) VALUES ('database_id', '55555555-5555-4555-8555-555555555555');
    INSERT INTO queue_metadata (key, value) VALUES ('created_at', '2026-08-15T00:00:00.000Z');
    ALTER TABLE work_items ADD COLUMN source_ref TEXT;
    CREATE UNIQUE INDEX work_items_source_ref ON work_items(repository, source_ref) WHERE source_ref IS NOT NULL;
    ALTER TABLE work_items ADD COLUMN operator_notes_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE work_items ADD COLUMN previous_results_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE work_items ADD COLUMN cure_json TEXT;
    PRAGMA user_version = 5;
  `);
  const before = new Set((raw.prepare("PRAGMA table_info(repositories)").all() as Row[]).map((column) => String(column.name)));
  assert.ok(!before.has("cure_foreign"));
  raw.close();

  const queue = new QueueStore(path);
  test.after(() => queue.close());
  assert.equal(queue.schemaVersion(), SCHEMA_VERSION);
  assert.equal(queue.metadata().databaseId, "55555555-5555-4555-8555-555555555555");
  const inspect = new DatabaseSync(path, { readOnly: true });
  const column = (inspect.prepare("PRAGMA table_info(repositories)").all() as Row[]).find((entry) => String(entry.name) === "cure_foreign");
  const stored = inspect.prepare("SELECT cure_foreign FROM repositories WHERE slug = 'frostyard/updex'").get() as Row;
  inspect.close();
  assert.ok(column, "rung 6 adds repositories.cure_foreign");
  assert.equal(Number(column!.notnull), 1);
  assert.equal(String(column!.dflt_value), "0");
  assert.equal(Number(stored.cure_foreign), 0, "existing rows default to off");
  assert.deepEqual(queue.repositoryCureSettings(), [{ repository: "frostyard/updex", cureForeign: false }]);

  queue.setRepositoryCureForeign("frostyard/updex", true);
  assert.deepEqual(queue.repositoryCureSettings(), [{ repository: "frostyard/updex", cureForeign: true }]);
  assert.throws(() => queue.setRepositoryCureForeign("frostyard/lodge", true), /not opted in/);
  queue.setRepositoryEnabled("frostyard/updex", false);
  assert.deepEqual(queue.repositoryCureSettings(), [], "only opted-in repositories carry a cure setting");
});

test("a version-7 database gains rung 8's review_json column and review_gate setting, off for every existing repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-ladder-v7-test-"));
  const path = join(directory, "queue.db");
  createVersionOneDatabase(path);
  // Bring the hand-built database to exactly version 7 with rungs 2–7's objects.
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE queue_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO queue_metadata (key, value) VALUES ('database_id', '77777777-7777-4777-8777-777777777777');
    INSERT INTO queue_metadata (key, value) VALUES ('created_at', '2026-08-15T00:00:00.000Z');
    ALTER TABLE work_items ADD COLUMN source_ref TEXT;
    CREATE UNIQUE INDEX work_items_source_ref ON work_items(repository, source_ref) WHERE source_ref IS NOT NULL;
    ALTER TABLE work_items ADD COLUMN operator_notes_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE work_items ADD COLUMN previous_results_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE work_items ADD COLUMN cure_json TEXT;
    ALTER TABLE repositories ADD COLUMN cure_foreign INTEGER NOT NULL DEFAULT 0 CHECK (cure_foreign IN (0, 1));
    CREATE TABLE mcp_tokens (id TEXT PRIMARY KEY, owner TEXT NOT NULL, client TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, revoked_by TEXT);
    CREATE INDEX mcp_tokens_owner ON mcp_tokens(owner, created_at);
    PRAGMA user_version = 7;
  `);
  const before = new Set((raw.prepare("PRAGMA table_info(repositories)").all() as Row[]).map((column) => String(column.name)));
  assert.ok(!before.has("review_gate"));
  raw.close();

  const queue = new QueueStore(path);
  test.after(() => queue.close());
  assert.equal(queue.schemaVersion(), SCHEMA_VERSION);
  assert.equal(queue.metadata().databaseId, "77777777-7777-4777-8777-777777777777");
  const inspect = new DatabaseSync(path, { readOnly: true });
  const gate = (inspect.prepare("PRAGMA table_info(repositories)").all() as Row[]).find((entry) => String(entry.name) === "review_gate");
  const review = (inspect.prepare("PRAGMA table_info(work_items)").all() as Row[]).find((entry) => String(entry.name) === "review_json");
  const stored = inspect.prepare("SELECT review_gate FROM repositories WHERE slug = 'frostyard/updex'").get() as Row;
  inspect.close();
  assert.ok(gate, "rung 8 adds repositories.review_gate");
  assert.ok(review, "rung 8 adds work_items.review_json");
  assert.equal(Number(gate!.notnull), 1);
  assert.equal(String(gate!.dflt_value), "0");
  assert.equal(Number(stored.review_gate), 0, "existing rows default to off");
  assert.equal(queue.reviewGateEnabled("frostyard/updex"), false);
  assert.deepEqual(queue.repositoryReviewGateSettings(), [{ repository: "frostyard/updex", reviewGate: false }]);
  assert.deepEqual(queue.repositoryCureSettings(), [{ repository: "frostyard/updex", cureForeign: false }], "rung 6's setting is untouched");

  queue.setRepositoryReviewGate("frostyard/updex", true);
  assert.equal(queue.reviewGateEnabled("frostyard/updex"), true);
  assert.throws(() => queue.setRepositoryReviewGate("frostyard/lodge", true), /not opted in/);
  queue.setRepositoryEnabled("frostyard/updex", false);
  assert.deepEqual(queue.repositoryReviewGateSettings(), [], "only opted-in repositories carry a review-gate setting");
  assert.equal(queue.reviewGateEnabled("frostyard/updex"), false, "a disabled repository is not gated");
});

test("a version-8 database gains rung 9's mcp_tokens.kinds_json column, NULL for every existing token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-ladder-v8-test-"));
  const path = join(directory, "queue.db");
  createVersionOneDatabase(path);
  // Bring the hand-built database to exactly version 8 with rungs 2–8's objects,
  // and give it one pre-rung-9 token row.
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE queue_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO queue_metadata (key, value) VALUES ('database_id', '88888888-8888-4888-8888-888888888888');
    INSERT INTO queue_metadata (key, value) VALUES ('created_at', '2026-08-15T00:00:00.000Z');
    ALTER TABLE work_items ADD COLUMN source_ref TEXT;
    CREATE UNIQUE INDEX work_items_source_ref ON work_items(repository, source_ref) WHERE source_ref IS NOT NULL;
    ALTER TABLE work_items ADD COLUMN operator_notes_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE work_items ADD COLUMN previous_results_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE work_items ADD COLUMN cure_json TEXT;
    ALTER TABLE repositories ADD COLUMN cure_foreign INTEGER NOT NULL DEFAULT 0 CHECK (cure_foreign IN (0, 1));
    CREATE TABLE mcp_tokens (id TEXT PRIMARY KEY, owner TEXT NOT NULL, client TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, revoked_by TEXT);
    CREATE INDEX mcp_tokens_owner ON mcp_tokens(owner, created_at);
    INSERT INTO mcp_tokens (id, owner, client, token_hash, created_at)
      VALUES ('0123456789abcdef', 'member:legacy@frostyard.org', 'legacy-client', 'deadbeef', '2026-08-18T00:00:00.000Z');
    ALTER TABLE work_items ADD COLUMN review_json TEXT;
    ALTER TABLE repositories ADD COLUMN review_gate INTEGER NOT NULL DEFAULT 0 CHECK (review_gate IN (0, 1));
    PRAGMA user_version = 8;
  `);
  const before = new Set((raw.prepare("PRAGMA table_info(mcp_tokens)").all() as Row[]).map((column) => String(column.name)));
  assert.ok(!before.has("kinds_json"));
  raw.close();

  const queue = new QueueStore(path);
  test.after(() => queue.close());
  assert.equal(queue.schemaVersion(), SCHEMA_VERSION);
  assert.equal(queue.metadata().databaseId, "88888888-8888-4888-8888-888888888888");
  const inspect = new DatabaseSync(path, { readOnly: true });
  const column = (inspect.prepare("PRAGMA table_info(mcp_tokens)").all() as Row[]).find((entry) => String(entry.name) === "kinds_json");
  const stored = inspect.prepare("SELECT kinds_json FROM mcp_tokens WHERE id = '0123456789abcdef'").get() as Row;
  inspect.close();
  assert.ok(column, "rung 9 adds mcp_tokens.kinds_json");
  assert.equal(Number(column!.notnull), 0, "the column is nullable: NULL is unrestricted");
  assert.equal(stored.kinds_json, null, "an existing token stays unrestricted");
  assert.equal(queue.listMcpTokens("member:legacy@frostyard.org")[0]?.kinds, undefined);
  assert.deepEqual(queue.repositoryReviewGateSettings(), [{ repository: "frostyard/updex", reviewGate: false }], "rung 8's setting is untouched");

  // The new restriction narrows only claiming: the legacy row keeps behaving
  // as before and a fresh restricted token stores its sorted, unique list.
  const restricted = queue.mintMcpToken({ owner: "member:reviewer@frostyard.org", client: "codex reviewer", kinds: ["pr-review", "pr-review", "issue-resolution"] });
  assert.deepEqual(queue.verifyMcpToken(restricted.token)?.kinds, ["issue-resolution", "pr-review"]);
  assert.throws(() => queue.mintMcpToken({ owner: "member:reviewer@frostyard.org", client: "bad", kinds: ["Bad Kind"] }), /invalid work kind: Bad Kind/);
  assert.throws(() => queue.mintMcpToken({ owner: "member:reviewer@frostyard.org", client: "empty", kinds: [] }), /at least one work kind/);
});

test("a version-9 database gains rung 10's repositories.unreported_pull_requests_json column, NULL for every existing repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-ladder-v9-test-"));
  const path = join(directory, "queue.db");
  createVersionOneDatabase(path);
  // Bring the hand-built database to exactly version 9 with rungs 2–9's objects.
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE queue_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO queue_metadata (key, value) VALUES ('database_id', '99999999-9999-4999-8999-999999999999');
    INSERT INTO queue_metadata (key, value) VALUES ('created_at', '2026-08-15T00:00:00.000Z');
    ALTER TABLE work_items ADD COLUMN source_ref TEXT;
    CREATE UNIQUE INDEX work_items_source_ref ON work_items(repository, source_ref) WHERE source_ref IS NOT NULL;
    ALTER TABLE work_items ADD COLUMN operator_notes_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE work_items ADD COLUMN previous_results_json TEXT NOT NULL DEFAULT '[]';
    ALTER TABLE work_items ADD COLUMN cure_json TEXT;
    ALTER TABLE repositories ADD COLUMN cure_foreign INTEGER NOT NULL DEFAULT 0 CHECK (cure_foreign IN (0, 1));
    CREATE TABLE mcp_tokens (id TEXT PRIMARY KEY, owner TEXT NOT NULL, client TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT, revoked_by TEXT);
    CREATE INDEX mcp_tokens_owner ON mcp_tokens(owner, created_at);
    ALTER TABLE work_items ADD COLUMN review_json TEXT;
    ALTER TABLE repositories ADD COLUMN review_gate INTEGER NOT NULL DEFAULT 0 CHECK (review_gate IN (0, 1));
    ALTER TABLE mcp_tokens ADD COLUMN kinds_json TEXT;
    PRAGMA user_version = 9;
  `);
  const before = new Set((raw.prepare("PRAGMA table_info(repositories)").all() as Row[]).map((column) => String(column.name)));
  assert.ok(!before.has("unreported_pull_requests_json"));
  raw.close();

  const queue = new QueueStore(path);
  test.after(() => queue.close());
  assert.equal(queue.schemaVersion(), SCHEMA_VERSION);
  assert.equal(queue.metadata().databaseId, "99999999-9999-4999-8999-999999999999");
  const inspect = new DatabaseSync(path, { readOnly: true });
  const column = (inspect.prepare("PRAGMA table_info(repositories)").all() as Row[]).find((entry) => String(entry.name) === "unreported_pull_requests_json");
  const stored = inspect.prepare("SELECT unreported_pull_requests_json FROM repositories WHERE slug = 'frostyard/updex'").get() as Row;
  inspect.close();
  assert.ok(column, "rung 10 adds repositories.unreported_pull_requests_json");
  assert.equal(Number(column!.notnull), 0, "the column is nullable: NULL is 'not yet observed'");
  assert.equal(stored.unreported_pull_requests_json, null, "an existing repository reads as never observed");
  assert.equal(queue.repositoryUnreportedPullRequests("frostyard/updex"), undefined);
  assert.deepEqual(queue.repositoryReviewGateSettings(), [{ repository: "frostyard/updex", reviewGate: false }], "rung 8's setting is untouched");

  // The observation is written whole and overwritten whole, an empty list included.
  const url = "https://github.com/frostyard/updex/pull/370";
  queue.recordUnreportedPullRequests(
    "frostyard/updex",
    { observedAt: "2026-08-19T12:00:00.000Z", pullRequests: [{ url, number: 370, draft: true, createdAt: "2026-08-19T09:00:00.000Z" }] },
    "policy:review-gate",
  );
  assert.deepEqual(queue.repositoryUnreportedPullRequests("frostyard/updex"), {
    observedAt: "2026-08-19T12:00:00.000Z",
    pullRequests: [{ url, number: 370, draft: true, createdAt: "2026-08-19T09:00:00.000Z" }],
  });
  queue.recordUnreportedPullRequests("frostyard/updex", { observedAt: "2026-08-19T13:00:00.000Z", pullRequests: [] }, "operator:cli");
  assert.deepEqual(queue.repositoryUnreportedPullRequests("frostyard/updex"), { observedAt: "2026-08-19T13:00:00.000Z", pullRequests: [] });
  assert.throws(
    () => queue.recordUnreportedPullRequests("frostyard/updex", { observedAt: "2026-08-19T13:00:00.000Z", pullRequests: [{ url: "https://example.com/x", number: 1, draft: false }] }, "policy:review-gate"),
    /not a GitHub pull-request URL/,
  );
  assert.throws(() => queue.recordUnreportedPullRequests("frostyard/lodge", { observedAt: "2026-08-19T13:00:00.000Z", pullRequests: [] }, "policy:review-gate"), /not opted in/);
});

test("re-running the ladder from an unversioned database converges without changing the identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-ladder-rerun-test-"));
  const path = join(directory, "queue.db");
  const first = new QueueStore(path);
  const identity = first.metadata().databaseId;
  first.close();

  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA user_version = 0");
  raw.close();

  const rerun = new QueueStore(path);
  test.after(() => rerun.close());
  assert.equal(rerun.schemaVersion(), SCHEMA_VERSION);
  assert.equal(rerun.metadata().databaseId, identity, "rung 2 must be idempotent so lineage is stable");
});

test("a database newer than the ladder is refused, and one older is upgraded rather than refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-ladder-refuse-test-"));
  const path = join(directory, "queue.db");
  new QueueStore(path).close();
  const raw = new DatabaseSync(path);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
  raw.close();
  assert.throws(() => new QueueStore(path), /newer than the supported version/);

  const older = new DatabaseSync(path);
  older.exec("PRAGMA user_version = 1");
  older.close();
  const upgraded = new QueueStore(path);
  assert.equal(upgraded.schemaVersion(), SCHEMA_VERSION);
  upgraded.close();
});

test("backup copies the live queue to a new file, verifies it, and never overwrites", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-backup-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/updex", true);
  const seed = queue.enqueueSeed({
    repository: "frostyard/updex",
    kind: "testing-gap-discovery",
    objective: "Identify one testing gap.",
    instructions: "Read and report only.",
    acceptanceCriteria: ["One gap has concrete evidence."],
    allowedActions: ["read"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const claimed = queue.claim({ worker: "claude:backup-test" })!;
  const live = queue.metadata();

  assert.throws(() => queue.backup(path), /must differ from the live database path/);
  assert.throws(() => queue.backup(":memory:"), /filesystem path/);

  const backupPath = join(directory, "backups", "queue-1.db");
  const manifest = queue.backup(backupPath);
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.backupPath, backupPath);
  assert.equal(manifest.databaseId, live.databaseId);
  assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
  assert.equal(manifest.workItems, 1);
  assert.equal(manifest.workEvents, live.workEvents);
  assert.equal(manifest.lastEventSequence, live.lastEventSequence);
  assert.equal(manifest.sha256, createHash("sha256").update(readFileSync(backupPath)).digest("hex"));
  assert.equal(statSync(backupPath).mode & 0o777, 0o600, "backups carry lease tokens and are created private");

  // Inspection re-derives the manifest byte for byte, and refuses to overwrite an existing path.
  assert.deepEqual(QueueStore.inspectBackup(backupPath, manifest.createdAt), manifest);
  assert.throws(() => queue.backup(backupPath), /already exists/);
  assert.throws(() => QueueStore.inspectBackup(join(directory, "missing.db")), /does not exist/);

  // The copy is a complete, independent queue: same item, same lease, same events.
  // Opening it as a QueueStore is a restore: it switches the file to WAL and changes its digest,
  // which is why verification precedes restore.
  const restored = new QueueStore(backupPath);
  assert.equal(restored.get(seed.id)?.leaseOwner, "claude:backup-test");
  assert.equal(restored.get(seed.id)?.leaseToken, claimed.leaseToken);
  assert.equal(restored.events(seed.id).length, queue.events(seed.id).length);
  assert.equal(restored.metadata().databaseId, live.databaseId);
  restored.close();
  assert.notEqual(QueueStore.inspectBackup(backupPath).sha256, manifest.sha256, "opening a backup changes it");

  // Writes after the backup do not invalidate it; a later backup carries the later ledger.
  queue.heartbeat(seed.id, claimed.leaseToken!, "claude:backup-test");
  const later = queue.backup(join(directory, "backups", "queue-2.db"));
  assert.ok(later.lastEventSequence >= manifest.lastEventSequence);
  assert.equal(later.databaseId, manifest.databaseId);
});

test("inspection rejects a file that is not a supported queue backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-backup-reject-test-"));
  const foreign = join(directory, "foreign.db");
  const db = new DatabaseSync(foreign);
  db.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
  db.close();
  assert.throws(() => QueueStore.inspectBackup(foreign), /schema version 0 does not match/);

  const stripped = join(directory, "stripped.db");
  new QueueStore(stripped).close();
  const raw = new DatabaseSync(stripped);
  raw.exec("DELETE FROM queue_metadata");
  raw.close();
  assert.throws(() => QueueStore.inspectBackup(stripped), /no database identity/);
  const rows = (new DatabaseSync(stripped, { readOnly: true }).prepare("SELECT * FROM queue_metadata").all()) as Row[];
  assert.equal(rows.length, 0);
});
