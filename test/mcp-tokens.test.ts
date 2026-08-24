import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { QueueStore, SCHEMA_VERSION, validateMemberPrincipal, validateOperatorActor, validateWorkerIdentity } from "../src/queue/store.ts";

test("minted MCP tokens verify by hash, touch last_used_at sparingly, revoke idempotently, and never leak the hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-tokens-test-"));
  let now = new Date("2026-08-18T22:00:00.000Z");
  const queue = new QueueStore(join(directory, "queue.db"), () => now);
  test.after(() => queue.close());
  assert.equal(SCHEMA_VERSION, 15);

  const minted = queue.mintMcpToken({ owner: "member:bketelsen@gmail.com", client: "codex on the laptop" });
  assert.match(minted.token, /^snowcat_[0-9a-f]{16}_[A-Za-z0-9_-]{20,}$/);
  assert.equal(minted.record.owner, "member:bketelsen@gmail.com");
  assert.equal(minted.record.client, "codex on the laptop");
  assert.equal(minted.record.lastUsedAt, undefined);

  const verified = queue.verifyMcpToken(minted.token)!;
  assert.equal(verified.id, minted.record.id);
  assert.equal(verified.lastUsedAt, "2026-08-18T22:00:00.000Z");
  now = new Date("2026-08-18T22:00:30.000Z");
  assert.equal(queue.verifyMcpToken(minted.token)!.lastUsedAt, "2026-08-18T22:00:00.000Z", "not touched within a minute");
  now = new Date("2026-08-18T22:02:00.000Z");
  assert.equal(queue.verifyMcpToken(minted.token)!.lastUsedAt, "2026-08-18T22:02:00.000Z");

  // Wrong secret, wrong shape, unknown id: nothing, no reason.
  assert.equal(queue.verifyMcpToken(minted.token.slice(0, -4) + "AAAA"), undefined);
  assert.equal(queue.verifyMcpToken("nope"), undefined);
  assert.equal(queue.verifyMcpToken(`snowcat_${"f".repeat(16)}_${"a".repeat(32)}`), undefined);

  // Listing hides hashes; owner filter works.
  const other = queue.mintMcpToken({ owner: "member:someone@frostyard.org", client: "claude-code" });
  assert.equal(queue.listMcpTokens().length, 2);
  assert.deepEqual(queue.listMcpTokens("member:someone@frostyard.org").map((token) => token.client), ["claude-code"]);
  assert.ok(queue.listMcpTokens().every((token) => token.tokenHash === ""));

  // Revoke: a member only their own; an operator any; idempotent; a revoked token no longer verifies.
  assert.throws(() => queue.revokeMcpToken(other.record.id, "member:bketelsen@gmail.com"), /belongs to/);
  assert.throws(() => queue.revokeMcpToken(other.record.id, "claude:worker"), /operator:, policy:, or member:/);
  const revoked = queue.revokeMcpToken(minted.record.id, "member:bketelsen@gmail.com");
  assert.equal(revoked.revokedBy, "member:bketelsen@gmail.com");
  assert.equal(queue.verifyMcpToken(minted.token), undefined);
  assert.equal(queue.revokeMcpToken(minted.record.id, "operator:cli").revokedAt, revoked.revokedAt, "idempotent");
  assert.equal(queue.revokeMcpToken(other.record.id, "operator:cli").revokedBy, "operator:cli");
  assert.throws(() => queue.revokeMcpToken("deadbeefdeadbeef", "operator:cli"), /not found/);

  // Validation of owner and client.
  assert.throws(() => queue.mintMcpToken({ owner: "bketelsen", client: "x" }), /member: principal/);
  assert.throws(() => queue.mintMcpToken({ owner: "member:me@x.io", client: "" }), /client/);
});

test("member: is a principal only a transport may set: operators accept it, workers may not claim it", () => {
  assert.equal(validateOperatorActor("member:me@frostyard.org", "test"), "member:me@frostyard.org");
  assert.throws(() => validateWorkerIdentity("member:me@frostyard.org"), /reserved principal namespace/);
  assert.equal(validateMemberPrincipal(" member:me@x.io ", "owner"), "member:me@x.io");
  assert.throws(() => validateMemberPrincipal("member:", "owner"), /member: principal/);
  assert.throws(() => validateMemberPrincipal("member:a b", "owner"), /member: principal/);
});

test("a claim may carry the client's declared name as a label beside the transport identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-claim-label-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/example", true);
  queue.enqueueSeed({ repository: "frostyard/example", kind: "quality-gap-discovery", objective: "o", instructions: "i", acceptanceCriteria: ["a"], allowedActions: ["read"], delegableActions: [], createdBy: "operator:test" });
  const claimed = queue.claim({ worker: "member:me@frostyard.org/codex", label: "codex:frostyard/example:abc" })!;
  assert.equal(claimed.leaseOwner, "member:me@frostyard.org/codex");
  const event = queue.events(claimed.id).find((entry) => entry.type === "work.claimed")!;
  assert.equal(event.actor, "member:me@frostyard.org/codex");
  assert.equal(event.payload.label, "codex:frostyard/example:abc");
});
