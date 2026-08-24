import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { createApp } from "../src/app.ts";
import { buildQueueMcpServer } from "../src/mcp/server.ts";
import { DatabaseSync } from "node:sqlite";

import { CLAIM_BACKOFF_WINDOW_SECONDS, QueueStore, validateClaimLabel } from "../src/queue/store.ts";
import { MAX_ITEM_ATTEMPTS } from "../src/queue/types.ts";

/**
 * The read-only attempt projection (spec rule 66): `list_work` and `get_work`
 * carry each item's newest leases with the authenticated principal, the exact
 * client label supplied at claim time, and how each lease ended. An observer
 * such as Snowcat Cockpit can therefore say which item a local worker holds
 * and whether that same attempt completed, blocked, released, or expired —
 * by exact identity, never by guessing from order, timestamps, or text — and
 * never sees a lease token or gains authority from a label.
 */
let now = new Date("2026-08-21T12:00:00.000Z");
const clock = () => now;

const parse = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as any;

function seed(queue: QueueStore, objective: string): string {
  return queue.enqueueSeed({
    repository: "frostyard/example",
    kind: "issue-resolution",
    objective,
    instructions: "Open one pull request.",
    acceptanceCriteria: ["A pull request."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    requiredArtifact: "pull-request",
    createdBy: "operator:test",
  }).id;
}

function inProcessFetch(app: ReturnType<typeof createApp>, authorization: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    request.headers.set("Authorization", authorization);
    return app.request(request);
  }) as typeof fetch;
}

async function connectHttp(app: ReturnType<typeof createApp>, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL("http://snowcat.test/mcp"), { fetch: inProcessFetch(app, `Bearer ${token}`) });
  const client = new Client({ name: "attempts-test", version: "0.1.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

test("over HTTP, concurrent claims with distinct labels are correlated by principal and exact label, and every terminal outcome stays readable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-attempts-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path, clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/example", true);
  queue.setRepositoryEnabled("frostyard/other", true);
  const ids = ["one", "two", "three", "four"].map((name) => seed(queue, `Resolve ${name}.`));
  const elsewhere = queue.enqueueSeed({ repository: "frostyard/other", kind: "issue-resolution", objective: "Elsewhere.", instructions: "x", acceptanceCriteria: ["y"], allowedActions: ["read"], delegableActions: [], createdBy: "operator:test" }).id;
  const app = createApp({ appToken: "surface-token", surfaceStores: () => ({ queue }), mcp: { queue: () => queue, queuePath: path, verifier: { clock } } });

  // Two fleet workers on one laptop share a member but not a client; the
  // observer holds a third, read-only token.
  const alpha = queue.mintMcpToken({ owner: "member:operator@frostyard.org", client: "cockpit fleet" });
  const beta = queue.mintMcpToken({ owner: "member:operator@frostyard.org", client: "cockpit fleet" });
  const observerToken = queue.mintMcpToken({ owner: "member:operator@frostyard.org", client: "cockpit observer", kinds: ["cockpit-observer-no-claim"] });
  const [a, b, observer] = await Promise.all([connectHttp(app, alpha.token), connectHttp(app, beta.token), connectHttp(app, observerToken.token)]);
  test.after(async () => {
    await Promise.all([a.close(), b.close(), observer.close()]);
  });

  // Concurrent claims: same principal, different stable worker ids as labels.
  const [claimedA, claimedB] = await Promise.all([
    a.client.callTool({ name: "claim_work", arguments: { worker: "cockpit:worker:aaaa1111", repository: "frostyard/example" } }).then(parse),
    b.client.callTool({ name: "claim_work", arguments: { worker: "cockpit:worker:bbbb2222", repository: "frostyard/example" } }).then(parse),
  ]);
  assert.notEqual(claimedA.id, claimedB.id);
  assert.equal(claimedA.leaseOwner, "member:operator@frostyard.org/cockpit fleet");
  assert.equal(claimedB.leaseOwner, claimedA.leaseOwner, "the principal alone cannot tell the two workers apart");

  // The observer reads the repository's claimed items and matches each to its
  // worker by the exact label, through the principal, with no ordering.
  const active = parse(await observer.client.callTool({ name: "list_work", arguments: { repository: "frostyard/example", status: "claimed" } }));
  assert.equal(active.length, 2);
  const byLabel = new Map<string, any>();
  for (const item of active) {
    assert.equal(item.attempts.length, 1);
    const [attempt] = item.attempts;
    assert.equal(attempt.worker, item.leaseOwner, "the active attempt's worker is the lease owner");
    assert.equal(attempt.outcome, undefined, "an active attempt has no outcome");
    assert.equal(typeof attempt.sequence, "number");
    assert.ok(!("leaseToken" in item) && !JSON.stringify(item).includes(claimedA.leaseToken) && !JSON.stringify(item).includes(claimedB.leaseToken));
    byLabel.set(attempt.label, item);
  }
  assert.equal(byLabel.get("cockpit:worker:aaaa1111")?.id, claimedA.id);
  assert.equal(byLabel.get("cockpit:worker:bbbb2222")?.id, claimedB.id);
  assert.ok(!JSON.stringify(active).includes(elsewhere), "the repository filter bounds the read");
  const filteredByKind = parse(await observer.client.callTool({ name: "list_work", arguments: { repository: "frostyard/example", kind: "pr-review" } }));
  assert.deepEqual(filteredByKind, [], "the kind filter bounds the read too");

  // Exact correlation filters: the principal plus the label of the newest
  // claim find one worker's item without paging through the repository.
  const mine = parse(await observer.client.callTool({ name: "list_work", arguments: { repository: "frostyard/example", leaseOwner: "member:operator@frostyard.org/cockpit fleet", label: "cockpit:worker:bbbb2222" } }));
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, claimedB.id);
  assert.deepEqual(parse(await observer.client.callTool({ name: "list_work", arguments: { label: "cockpit:worker:nobody" } })), []);
  assert.deepEqual(parse(await observer.client.callTool({ name: "list_work", arguments: { leaseOwner: "member:someone-else@frostyard.org/other laptop", label: "cockpit:worker:bbbb2222" } })), [], "the right label under the wrong principal finds nothing");
  assert.equal((await observer.client.callTool({ name: "list_work", arguments: { label: "x".repeat(121) } })).isError, true, "a label filter is bounded like a label");
  assert.equal((await observer.client.callTool({ name: "list_work", arguments: { leaseOwner: "operator:cli" } })).isError, true, "a reserved principal is not a lease owner");

  // A label cannot carry a live lease token into the projection, whole or
  // embedded, and cannot exceed one bounded line.
  const stolen = await b.client.callTool({ name: "claim_work", arguments: { worker: claimedA.leaseToken, repository: "frostyard/example" } });
  assert.equal(stolen.isError, true, "a label that is a live lease token is refused");
  const embedded = await b.client.callTool({ name: "claim_work", arguments: { worker: `cockpit:${claimedA.leaseToken}:1`, repository: "frostyard/example" } });
  assert.equal(embedded.isError, true, "a label that contains a live lease token is refused");
  assert.match(JSON.stringify(embedded.content), /claim label may not contain a lease token/);
  assert.equal((await b.client.callTool({ name: "claim_work", arguments: { worker: "w".repeat(121) } })).isError, true, "a label over 120 characters is refused at the schema");
  assert.equal((await b.client.callTool({ name: "claim_work", arguments: { worker: "cockpit:\nworker" } })).isError, true, "a label with a control character is refused");
  assert.equal(queue.list({ status: "claimed" }).length, 2, "none of the refused claims took a lease");
  assert.ok(!JSON.stringify(queue.events(ids[2]!)).includes(claimedA.leaseToken) && !JSON.stringify(queue.events(ids[3]!)).includes(claimedA.leaseToken), "the refusals left no trace of the token in any ledger");

  // A label grants nothing: beta cannot act on alpha's lease by naming alpha's
  // label, with a wrong token or with alpha's own token — the principal and
  // the lease token decide, and here only the token differs between clients.
  const spoofedWrongToken = await b.client.callTool({ name: "heartbeat_work", arguments: { id: claimedA.id, leaseToken: claimedB.leaseToken, worker: "cockpit:worker:aaaa1111" } });
  assert.equal(spoofedWrongToken.isError, true);
  const observerLabelled = queue.mintMcpToken({ owner: "member:someone-else@frostyard.org", client: "other laptop" });
  const other = await connectHttp(app, observerLabelled.token);
  test.after(other.close);
  const spoofedOtherPrincipal = await other.client.callTool({ name: "heartbeat_work", arguments: { id: claimedA.id, leaseToken: claimedA.leaseToken, worker: "cockpit:worker:aaaa1111" } });
  assert.equal(spoofedOtherPrincipal.isError, true, "another principal with the real lease token and the real label still has no authority");
  assert.equal(queue.get(claimedA.id)!.leaseOwner, "member:operator@frostyard.org/cockpit fleet");

  // Terminal transitions: alpha completes, beta blocks; each attempt keeps its
  // label and gains the outcome, and the item is found by id afterwards.
  const done = parse(await a.client.callTool({ name: "complete_work", arguments: { id: claimedA.id, leaseToken: claimedA.leaseToken, worker: "cockpit:worker:aaaa1111", result: { summary: "Done.", evidence: ["tests"], artifacts: [{ kind: "pull-request", url: "https://github.com/frostyard/example/pull/7" }] }, followUps: [] } }));
  assert.equal(done.completed.status, "completed");
  assert.equal(done.completed.attempts, undefined, "lifecycle tools return the bare item");
  now = new Date(now.getTime() + 1_000);
  const blocked = parse(await b.client.callTool({ name: "block_work", arguments: { id: claimedB.id, leaseToken: claimedB.leaseToken, worker: "cockpit:worker:bbbb2222", reason: "needs a decision" } }));
  assert.equal(blocked.status, "blocked");

  const afterA = parse(await observer.client.callTool({ name: "get_work", arguments: { id: claimedA.id } }));
  assert.equal(afterA.status, "completed");
  assert.deepEqual(afterA.attempts, [
    { sequence: afterA.attempts[0].sequence, claimedAt: "2026-08-21T12:00:00.000Z", worker: "member:operator@frostyard.org/cockpit fleet", label: "cockpit:worker:aaaa1111", outcome: "completed", endedAt: "2026-08-21T12:00:00.000Z", endedBy: "member:operator@frostyard.org/cockpit fleet" },
  ]);
  const afterB = parse(await observer.client.callTool({ name: "get_work", arguments: { id: claimedB.id } }));
  assert.equal(afterB.attempts[0].label, "cockpit:worker:bbbb2222");
  assert.equal(afterB.attempts[0].outcome, "blocked");
  assert.equal(afterB.attempts[0].endedAt, "2026-08-21T12:00:01.000Z");
  assert.ok(!JSON.stringify(afterB).includes("needs a decision") || afterB.result.summary === "needs a decision", "the attempt carries no worker text beyond the label; the block reason lives only in result.summary");
  assert.ok(!JSON.stringify(afterB.attempts).includes("needs a decision"));

  // Release, then a different worker reclaims: the released attempt survives
  // beside the new active one, each with its own label, oldest first.
  const claimedC = parse(await a.client.callTool({ name: "claim_work", arguments: { worker: "cockpit:worker:cccc3333", repository: "frostyard/example" } }));
  now = new Date(now.getTime() + 1_000);
  parse(await a.client.callTool({ name: "release_work", arguments: { id: claimedC.id, leaseToken: claimedC.leaseToken, worker: "cockpit:worker:cccc3333", reason: "mismatched" } }));
  const reclaimed = parse(await b.client.callTool({ name: "claim_work", arguments: { worker: "cockpit:worker:dddd4444", kinds: ["issue-resolution"], repository: "frostyard/example" } }));
  assert.equal(reclaimed.id, claimedC.id, "claim order brings the released item back first");
  const afterC = parse(await observer.client.callTool({ name: "get_work", arguments: { id: claimedC.id } }));
  assert.equal(afterC.status, "claimed");
  assert.equal(afterC.attempts.length, 2);
  assert.equal(afterC.attempts[0].label, "cockpit:worker:cccc3333");
  assert.equal(afterC.attempts[0].outcome, "released");
  assert.equal(afterC.attempts[1].label, "cockpit:worker:dddd4444");
  assert.equal(afterC.attempts[1].outcome, undefined);
  assert.ok(afterC.attempts[0].sequence < afterC.attempts[1].sequence);
  assert.ok(!JSON.stringify(afterC).includes(reclaimed.leaseToken) && !JSON.stringify(afterC).includes(claimedC.leaseToken));

  // Expiry: a lease that lapsed is closed as `expired` by the reclaim that
  // observed it, attributed to `system`, and the new attempt is active.
  const claimedD = parse(await a.client.callTool({ name: "claim_work", arguments: { worker: "cockpit:worker:eeee5555", repository: "frostyard/example", leaseSeconds: 30 } }));
  now = new Date(now.getTime() + 120_000);
  // Before anyone reclaims, the lapsed lease already reads as expired — from
  // the clock, at the lease's own expiry instant — never as active.
  const lapsed = parse(await observer.client.callTool({ name: "get_work", arguments: { id: claimedD.id } }));
  assert.equal(lapsed.status, "claimed");
  assert.deepEqual(lapsed.attempts, [
    { sequence: lapsed.attempts[0].sequence, claimedAt: lapsed.attempts[0].claimedAt, worker: "member:operator@frostyard.org/cockpit fleet", label: "cockpit:worker:eeee5555", outcome: "expired", endedAt: claimedD.leaseExpiresAt, endedBy: "system" },
  ]);
  const lapsedList = parse(await observer.client.callTool({ name: "list_work", arguments: { status: "claimed", label: "cockpit:worker:eeee5555" } }));
  assert.equal(lapsedList[0].attempts[0].outcome, "expired", "list_work agrees");
  const overTaken = parse(await b.client.callTool({ name: "claim_work", arguments: { worker: "cockpit:worker:ffff6666", repository: "frostyard/example" } }));
  assert.equal(overTaken.id, claimedD.id);
  const afterD = parse(await observer.client.callTool({ name: "get_work", arguments: { id: claimedD.id } }));
  assert.equal(afterD.attempts.length, 2);
  assert.equal(afterD.attempts[0].label, "cockpit:worker:eeee5555");
  assert.equal(afterD.attempts[0].outcome, "expired");
  assert.equal(afterD.attempts[0].endedBy, "system");
  assert.equal(afterD.attempts[0].endedAt, claimedD.leaseExpiresAt, "the reclaim's lease.expired event names the same expiry instant");
  assert.equal(queue.events(claimedD.id).find((event) => event.type === "lease.expired")!.payload.leaseExpiresAt, claimedD.leaseExpiresAt);
  assert.equal(afterD.attempts[1].label, "cockpit:worker:ffff6666");
  assert.equal(afterD.attempts[1].outcome, undefined);

  // The observer token never claimed anything and the ledger never held a token.
  assert.ok(ids.every((id) => !JSON.stringify(queue.events(id)).includes("leaseToken")));
  assert.equal(queue.listMcpTokens().length, 4);
});

test("the store bounds the projection to the newest attempts, oldest first, and answers an unknown id with nothing", () => {
  const queue = new QueueStore(":memory:", clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/example", true);
  const id = seed(queue, "Resolve many.");
  assert.deepEqual(queue.attempts("00000000-0000-4000-8000-000000000000"), []);
  assert.deepEqual(queue.attempts(id), [], "a queued item has no attempts yet");

  const cycles = MAX_ITEM_ATTEMPTS + 2;
  for (let round = 1; round <= cycles; round += 1) {
    // Spread the cycles wider than the claim backoff window (ADR-0072, spec
    // rule 69): this test exercises the projection's size bound, not churn,
    // so the item must stay claimable through all twelve rounds.
    now = new Date(now.getTime() + (CLAIM_BACKOFF_WINDOW_SECONDS + 1) * 1000);
    const claimed = queue.claim({ worker: `member:operator@frostyard.org/fleet`, label: `cockpit:worker:${round}` })!;
    queue.release(claimed.id, claimed.leaseToken!, "member:operator@frostyard.org/fleet", "next");
  }
  const attempts = queue.attempts(id);
  assert.equal(attempts.length, MAX_ITEM_ATTEMPTS);
  assert.deepEqual(
    attempts.map((attempt) => attempt.label),
    Array.from({ length: MAX_ITEM_ATTEMPTS }, (_, index) => `cockpit:worker:${index + 3}`),
    "the two oldest attempts fall out of the window; the rest keep their order",
  );
  assert.ok(attempts.every((attempt) => attempt.outcome === "released"));
  assert.ok(attempts.every((attempt, index) => index === 0 || attempt.sequence > attempts[index - 1]!.sequence));
  assert.equal(queue.attempts(id, 3).length, 3);
  assert.equal(queue.attempts(id, 3)[2]!.label, `cockpit:worker:${cycles}`);
  assert.throws(() => queue.attempts(id, 0), /limit must be between 1 and 10/);
  assert.throws(() => queue.attempts(id, MAX_ITEM_ATTEMPTS + 1), /limit must be between 1 and 10/);

  // A claim with no label (stdio, or a label equal to the worker) records none.
  const bare = queue.claim({ worker: "claude:stdio:1" })!;
  const last = queue.attempts(id).at(-1)!;
  assert.equal(last.worker, "claude:stdio:1");
  assert.equal(last.label, undefined);
  assert.equal(last.outcome, undefined);
  assert.equal(last.sequence, queue.events(bare.id).at(-1)!.sequence);

  // A credential-bounded claim carries its restriction on the attempt.
  queue.release(bare.id, bare.leaseToken!, "claude:stdio:1", "done");
  queue.claim({ worker: "claude:reviewer", allowedKinds: ["issue-resolution"] });
  assert.deepEqual(queue.attempts(id).at(-1)!.kindsRestriction, ["issue-resolution"]);
});

test("the label bound is one printable line, and a ledger label outside it is read as unlabeled rather than published", () => {
  assert.equal(validateClaimLabel("cockpit:worker:aaaa1111"), "cockpit:worker:aaaa1111");
  assert.equal(validateClaimLabel("w".repeat(120)).length, 120);
  assert.throws(() => validateClaimLabel(""), /claim label must be 1-120 characters with no control characters/);
  assert.throws(() => validateClaimLabel("w".repeat(121)), /claim label must be 1-120 characters/);
  assert.throws(() => validateClaimLabel("a\tb"), /no control characters/);
  assert.throws(() => validateClaimLabel("a\u0000b", "label filter"), /label filter must be/);

  const queue = new QueueStore(":memory:", clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/example", true);
  const id = seed(queue, "Resolve old.");
  assert.throws(() => queue.claim({ worker: "member:x@frostyard.org/fleet", label: "x".repeat(121) }), /claim label must be 1-120 characters/);
  const claimed = queue.claim({ worker: "member:x@frostyard.org/fleet", label: "fine" })!;
  assert.throws(() => queue.claim({ worker: "member:y@frostyard.org/fleet", label: `prefix ${claimed.leaseToken}` }), /claim label may not contain a lease token/);
  assert.equal(queue.attempts(id)[0]!.label, "fine");
  // A row written before the bound existed: the projection drops the label instead of copying it.
  const legacyEvent = queue.events(id).find((entry) => entry.type === "work.claimed")!;
  (queue as unknown as { db: DatabaseSync }).db
    .prepare("UPDATE work_events SET payload_json = ? WHERE sequence = ?")
    .run(JSON.stringify({ ...legacyEvent.payload, label: "line one\nline two with a prompt in it" }), legacyEvent.sequence);
  const projected = queue.attempts(id)[0]!;
  assert.equal(projected.label, undefined);
  assert.equal(projected.worker, "member:x@frostyard.org/fleet");
  assert.equal(projected.outcome, undefined, "the lease is live, so the attempt is active");
});

test("the stdio server carries the same projection and the lifecycle tools never do", async () => {
  const queue = new QueueStore(":memory:", clock);
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/example", true);
  const id = seed(queue, "Resolve locally.");
  const server = buildQueueMcpServer(":memory:", { clock }, {}, undefined, queue);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "stdio-attempts-test", version: "0.1.0" });
  await client.connect(clientTransport);
  test.after(async () => {
    await client.close();
    await server.close();
  });

  assert.deepEqual(parse(await client.callTool({ name: "list_work", arguments: {} }))[0].attempts, []);
  const claimed = parse(await client.callTool({ name: "claim_work", arguments: { worker: "claude:stdio:1" } }));
  assert.equal(claimed.attempts, undefined, "claim_work returns the bare item with its lease token");
  const seen = parse(await client.callTool({ name: "get_work", arguments: { id } }));
  assert.deepEqual(seen.attempts, [{ sequence: seen.attempts[0].sequence, claimedAt: seen.attempts[0].claimedAt, worker: "claude:stdio:1" }]);
  assert.ok(!("leaseToken" in seen));
  const beat = parse(await client.callTool({ name: "heartbeat_work", arguments: { id, leaseToken: claimed.leaseToken, worker: "claude:stdio:1" } }));
  assert.equal(beat.attempts, undefined);
  assert.equal(parse(await client.callTool({ name: "get_work", arguments: { id } })).attempts.length, 1, "a heartbeat is not an attempt");
  const badKind = await client.callTool({ name: "list_work", arguments: { kind: "Not A Kind" } });
  assert.equal(badKind.isError, true, "the kind filter is validated at the schema");
});
