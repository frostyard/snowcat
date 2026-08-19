import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { createApp } from "../src/app.ts";
import { buildQueueMcpServer, mcpKindsFromEnvironment } from "../src/mcp/server.ts";
import { QueueStore } from "../src/queue/store.ts";
import { childEnvironment } from "./helpers/child-environment.ts";

/**
 * A minted token (or the stdio server's `SNOWCAT_MCP_KINDS`) may restrict what
 * the client is allowed to *claim*. The restriction is a property of the
 * credential, not a promise in a brief: a review-only client cannot lease an
 * `issue-resolution` item even when it omits `kinds` entirely.
 */
const clock = () => new Date("2026-08-19T12:00:00.000Z");

const parse = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as any;

function seedQueue(queue: QueueStore): void {
  queue.setRepositoryEnabled("frostyard/example", true);
  queue.enqueueSeed({
    repository: "frostyard/example",
    kind: "issue-resolution",
    objective: "Resolve #1.",
    instructions: "Open one pull request.",
    acceptanceCriteria: ["A pull request."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    createdBy: "operator:test",
  });
}

function seedReview(queue: QueueStore): void {
  queue.enqueueSeed({
    repository: "frostyard/example",
    kind: "pr-review",
    objective: "Review #1.",
    instructions: "Read the diff.",
    acceptanceCriteria: ["A verdict."],
    allowedActions: ["read", "run-tests"],
    delegableActions: [],
    createdBy: "operator:test",
  });
}

function inProcessFetch(app: ReturnType<typeof createApp>, authorization: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    request.headers.set("Authorization", authorization);
    return app.request(request);
  }) as typeof fetch;
}

async function connectHttp(app: ReturnType<typeof createApp>, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL("http://snowcat.test/mcp"), {
    fetch: inProcessFetch(app, `Bearer ${token}`),
  });
  const client = new Client({ name: "token-kinds-test", version: "0.1.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

test("a token minted with kinds claims only those kinds over the HTTP endpoint, and an unrestricted one is unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-token-kinds-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  test.after(() => queue.close());
  seedQueue(queue);
  const app = createApp({ appToken: "surface-token", surfaceStores: () => ({ queue }), mcp: { queue: () => queue, queuePath: path, verifier: { clock } } });

  const restricted = queue.mintMcpToken({ owner: "member:reviewer@frostyard.org", client: "codex reviewer", kinds: ["pr-review"] });
  assert.deepEqual(restricted.record.kinds, ["pr-review"]);

  const reviewer = await connectHttp(app, restricted.token);
  test.after(reviewer.close);

  // Only issue-resolution work is queued: the review-only client claims
  // nothing, whether or not it passes `kinds` itself. Never an error.
  const blind = parse(await reviewer.client.callTool({ name: "claim_work", arguments: { worker: "codex:reviewer:1" } }));
  assert.equal(blind, null, "a restricted token that omits kinds still claims nothing outside its set");
  const asked = parse(await reviewer.client.callTool({ name: "claim_work", arguments: { worker: "codex:reviewer:1", kinds: ["issue-resolution"] } }));
  assert.equal(asked, null, "a caller kinds outside the token's set never widens it");

  // The same queue, an unrestricted token: unchanged behaviour.
  const open = queue.mintMcpToken({ owner: "member:author@frostyard.org", client: "claude author" });
  assert.equal(open.record.kinds, undefined);
  const author = await connectHttp(app, open.token);
  test.after(author.close);
  const claimedByAuthor = parse(await author.client.callTool({ name: "claim_work", arguments: { worker: "claude:author:1" } }));
  assert.equal(claimedByAuthor.kind, "issue-resolution");
  assert.equal(claimedByAuthor.leaseOwner, "member:author@frostyard.org/claude author");
  const authorEvent = queue.events(claimedByAuthor.id).find((event) => event.type === "work.claimed")!;
  assert.equal(authorEvent.payload.kindsRestriction, undefined, "an unrestricted claim records no restriction");

  // Now queue a review round: the restricted token claims it, with or without
  // its own filter, and the ledger records the restriction that applied.
  seedReview(queue);
  const inside = parse(await reviewer.client.callTool({ name: "claim_work", arguments: { worker: "codex:reviewer:1", kinds: ["pr-review"] } }));
  assert.equal(inside.kind, "pr-review");
  assert.equal(inside.leaseOwner, "member:reviewer@frostyard.org/codex reviewer");
  const reviewEvent = queue.events(inside.id).find((event) => event.type === "work.claimed")!;
  assert.deepEqual(reviewEvent.payload.kindsRestriction, ["pr-review"]);
  assert.equal(reviewEvent.payload.label, "codex:reviewer:1");

  // A restricted token still finishes what it holds: only claiming is bounded.
  const beat = parse(await reviewer.client.callTool({ name: "heartbeat_work", arguments: { id: inside.id, leaseToken: inside.leaseToken, worker: "codex:reviewer:1" } }));
  assert.equal(beat.leaseOwner, "member:reviewer@frostyard.org/codex reviewer");
  const released = parse(await reviewer.client.callTool({ name: "release_work", arguments: { id: inside.id, leaseToken: inside.leaseToken, worker: "codex:reviewer:1", reason: "handing back" } }));
  assert.equal(released.status, "queued");

  // The listing shows the restriction and never a hash.
  const listed = queue.listMcpTokens("member:reviewer@frostyard.org")[0]!;
  assert.deepEqual(listed.kinds, ["pr-review"]);
  assert.equal(listed.tokenHash, "");
  assert.equal(queue.listMcpTokens("member:author@frostyard.org")[0]!.kinds, undefined);
});

test("SNOWCAT_MCP_KINDS restricts the stdio server the same way, and is validated", async () => {
  const queue = new QueueStore(":memory:");
  test.after(() => queue.close());
  seedQueue(queue);

  assert.equal(mcpKindsFromEnvironment({}), undefined, "unset is unrestricted");
  assert.equal(mcpKindsFromEnvironment({ SNOWCAT_MCP_KINDS: "  " }), undefined, "blank is unrestricted");
  assert.deepEqual(mcpKindsFromEnvironment({ SNOWCAT_MCP_KINDS: "pr-review-fix, pr-review ,pr-review" }), ["pr-review", "pr-review-fix"]);
  assert.throws(() => mcpKindsFromEnvironment({ SNOWCAT_MCP_KINDS: "Bad Kind" }), /SNOWCAT_MCP_KINDS: invalid work kind: Bad Kind/);

  const kinds = mcpKindsFromEnvironment({ SNOWCAT_MCP_KINDS: "pr-review" })!;
  const server = buildQueueMcpServer(":memory:", { clock }, {}, { kinds }, queue);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "stdio-kinds-test", version: "0.1.0" });
  await client.connect(clientTransport);
  test.after(async () => {
    await client.close();
    await server.close();
  });

  assert.equal(parse(await client.callTool({ name: "claim_work", arguments: { worker: "claude:stdio:1" } })), null, "only issue-resolution work is queued");
  assert.equal(parse(await client.callTool({ name: "claim_work", arguments: { worker: "claude:stdio:1", kinds: ["issue-resolution"] } })), null);

  seedReview(queue);
  const claimed = parse(await client.callTool({ name: "claim_work", arguments: { worker: "claude:stdio:1" } }));
  assert.equal(claimed.kind, "pr-review");
  // Stdio keeps the payload's worker as the principal (no transport identity).
  assert.equal(claimed.leaseOwner, "claude:stdio:1");
  const event = queue.events(claimed.id).find((entry) => entry.type === "work.claimed")!;
  assert.deepEqual(event.payload.kindsRestriction, ["pr-review"]);
});

test("the store itself enforces the restriction, so no non-MCP caller bypasses it", () => {
  const queue = new QueueStore(":memory:");
  test.after(() => queue.close());
  seedQueue(queue);
  seedReview(queue);

  assert.equal(queue.claim({ worker: "claude:direct", allowedKinds: ["pr-review"], kinds: ["issue-resolution"] }), undefined, "an empty intersection claims nothing");
  assert.equal(queue.claim({ worker: "claude:direct", allowedKinds: ["pr-review"] })?.kind, "pr-review");
  assert.throws(() => queue.claim({ worker: "claude:direct", allowedKinds: ["Bad Kind"] }), /claim allowedKinds: invalid work kind: Bad Kind/);
  assert.throws(() => queue.claim({ worker: "claude:direct", allowedKinds: [] }), /claim allowedKinds: at least one work kind/);
  assert.equal(queue.claim({ worker: "claude:direct" })?.kind, "issue-resolution", "an unrestricted claim is unchanged");
});

test("the CLI mints a restricted token, lists the restriction, and refuses a kind that is not one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-token-kinds-cli-test-"));
  const path = join(directory, "queue.db");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: childEnvironment({ SNOWCAT_QUEUE_DB: path }),
    });

  const minted = run("token", "mint", "member:reviewer@frostyard.org", "codex reviewer", "--kinds", "pr-review,pr-review-fix");
  assert.equal(minted.status, 0, minted.stderr);
  const printed = JSON.parse(minted.stdout) as { token: string; kinds: string[] };
  assert.deepEqual(printed.kinds, ["pr-review", "pr-review-fix"]);
  assert.match(printed.token, /^snowcat_[0-9a-f]{16}_/);

  const unrestricted = run("token", "mint", "member:author@frostyard.org", "claude author");
  assert.equal(unrestricted.status, 0, unrestricted.stderr);
  assert.equal((JSON.parse(unrestricted.stdout) as { kinds: string }).kinds, "unrestricted");

  const listed = JSON.parse(run("token", "list").stdout) as Array<{ client: string; kinds: string[] | string; tokenHash?: string }>;
  assert.deepEqual(
    Object.fromEntries(listed.map((token) => [token.client, token.kinds])),
    { "codex reviewer": ["pr-review", "pr-review-fix"], "claude author": "unrestricted" },
  );
  assert.ok(listed.every((token) => token.tokenHash === undefined), "listings never carry a hash");

  const bad = run("token", "mint", "member:x@example.com", "t", "--kinds", "Bad Kind");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /invalid work kind: Bad Kind/);
});
