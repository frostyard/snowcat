import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { Client, InMemoryTransport, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { createApp } from "../src/app.ts";
import { buildQueueMcpServer, mcpToolsFromEnvironment, registeredMcpToolNames } from "../src/mcp/server.ts";
import { QueueStore, SCHEMA_VERSION, validateMcpTools } from "../src/queue/store.ts";
import { mcpTokenProfiles, mcpToolNames } from "../src/queue/types.ts";
import { childEnvironment } from "./helpers/child-environment.ts";

/**
 * A minted token may carry a tool grant (ADR-0070): the only MCP tools the
 * credential can call. The boundary is server-side — the server registers
 * only the granted tools for that client — so an observation-only token
 * cannot claim, renew, complete, block, or release whatever it sends, and a
 * client-side promise to call only `list_work` is no longer the safeguard.
 */
const clock = () => new Date("2026-08-21T12:00:00.000Z");

const parse = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as any;

const MUTATING_TOOLS = ["claim_work", "heartbeat_work", "complete_work", "block_work", "release_work"] as const;

function seedQueue(queue: QueueStore): string {
  queue.setRepositoryEnabled("frostyard/example", true);
  return queue.enqueueSeed({
    repository: "frostyard/example",
    kind: "issue-resolution",
    objective: "Resolve #1.",
    instructions: "Open one pull request.",
    acceptanceCriteria: ["A pull request."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    requiredArtifact: "pull-request",
    executionTarget: "new-pull-request",
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
  const transport = new StreamableHTTPClientTransport(new URL("http://snowcat.test/mcp"), {
    fetch: inProcessFetch(app, `Bearer ${token}`),
  });
  const client = new Client({ name: "token-tools-test", version: "0.1.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

/** Arguments that would pass every tool's input schema, so a refusal can only be the grant. */
function mutatingArguments(tool: (typeof MUTATING_TOOLS)[number], id: string): Record<string, unknown> {
  const leaseToken = "11111111-1111-4111-8111-111111111111";
  switch (tool) {
    case "claim_work":
      return { worker: "cockpit:observer:1", repository: "frostyard/example" };
    case "heartbeat_work":
      return { id, leaseToken, worker: "cockpit:observer:1" };
    case "complete_work":
      return { id, leaseToken, worker: "cockpit:observer:1", result: { summary: "done", evidence: [], artifacts: [] }, followUps: [] };
    case "block_work":
    case "release_work":
      return { id, leaseToken, worker: "cockpit:observer:1", reason: "trying" };
  }
}

test("the server registers exactly the contract's tools, and the observer profile is a subset of them", () => {
  assert.deepEqual([...registeredMcpToolNames], [...mcpToolNames]);
  for (const tools of Object.values(mcpTokenProfiles)) {
    assert.deepEqual(validateMcpTools(tools, "profile"), [...tools].sort(), "a profile is already sorted and names only real tools");
  }
  assert.deepEqual(mcpTokenProfiles.observer, ["get_work", "list_work"]);
});

test("an observation-only token lists and reads over HTTP but cannot call any mutating tool, and an unrestricted token is unchanged", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-token-tools-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  test.after(() => queue.close());
  const itemId = seedQueue(queue);
  const app = createApp({ appToken: "surface-token", surfaceStores: () => ({ queue }), mcp: { queue: () => queue, queuePath: path, verifier: { clock } } });

  const observer = queue.mintMcpToken({ owner: "member:operator@frostyard.org", client: "cockpit observer", tools: [...mcpTokenProfiles.observer] });
  assert.deepEqual(observer.record.tools, ["get_work", "list_work"]);
  const cockpit = await connectHttp(app, observer.token);
  test.after(cockpit.close);

  // The grant is what the client can even see: tools/list names only the granted tools.
  const advertised = (await cockpit.client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(advertised, ["get_work", "list_work"]);

  // The read tools work, and never carry a lease token.
  const listed = parse(await cockpit.client.callTool({ name: "list_work", arguments: { repository: "frostyard/example" } }));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, itemId);
  assert.equal(listed[0].status, "queued");
  assert.ok(!("leaseToken" in listed[0]));
  const read = parse(await cockpit.client.callTool({ name: "get_work", arguments: { id: itemId } }));
  assert.equal(read.id, itemId);
  assert.ok(!("leaseToken" in read));

  // Every mutating tool is refused before any handler runs: the item is
  // untouched and the ledger has no new event, whatever arguments were sent.
  const eventsBefore = queue.events(itemId).length;
  for (const tool of MUTATING_TOOLS) {
    await assert.rejects(
      cockpit.client.callTool({ name: tool, arguments: mutatingArguments(tool, itemId) }),
      (error: Error) => /not found|unknown tool|Tool .* not found/i.test(error.message),
      `${tool} must be refused as an unknown tool for this credential`,
    );
    const item = queue.get(itemId)!;
    assert.equal(item.status, "queued", `${tool} changed the item's status`);
    assert.equal(item.leaseOwner, undefined, `${tool} took a lease`);
    assert.equal(queue.events(itemId).length, eventsBefore, `${tool} wrote a ledger event`);
  }

  // A pre-existing, unrestricted token behaves as it always did: every tool,
  // a real lease, and the ledger names the principal with no grant.
  const open = queue.mintMcpToken({ owner: "member:author@frostyard.org", client: "claude author" });
  assert.equal(open.record.tools, undefined);
  const author = await connectHttp(app, open.token);
  test.after(author.close);
  assert.deepEqual((await author.client.listTools()).tools.map((tool) => tool.name).sort(), [...mcpToolNames].sort());
  const claimed = parse(await author.client.callTool({ name: "claim_work", arguments: { worker: "claude:author:1" } }));
  assert.equal(claimed.id, itemId);
  assert.equal(claimed.leaseOwner, "member:author@frostyard.org/claude author");
  const claimEvent = queue.events(itemId).find((event) => event.type === "work.claimed")!;
  assert.equal(claimEvent.actor, "member:author@frostyard.org/claude author");
  assert.equal(claimEvent.payload.toolsGrant, undefined, "an unrestricted claim records no grant");

  // The observer still cannot touch the now-claimed item, and still sees it truthfully.
  await assert.rejects(cockpit.client.callTool({ name: "release_work", arguments: mutatingArguments("release_work", itemId) }));
  const seen = parse(await cockpit.client.callTool({ name: "get_work", arguments: { id: itemId } }));
  assert.equal(seen.status, "claimed");
  assert.equal(seen.leaseOwner, "member:author@frostyard.org/claude author");
  assert.ok(!("leaseToken" in seen), "the observer never receives a lease token");
  assert.ok(!JSON.stringify(seen).includes(claimed.leaseToken), "the lease token appears nowhere in the observer's view");

  // A custom grant that includes claim_work records the grant in the ledger as provenance.
  const released = parse(await author.client.callTool({ name: "release_work", arguments: { id: itemId, leaseToken: claimed.leaseToken, worker: "claude:author:1", reason: "handing back" } }));
  assert.equal(released.status, "queued");
  const claimer = queue.mintMcpToken({ owner: "member:operator@frostyard.org", client: "claim only", tools: ["claim_work", "list_work", "release_work"] });
  const narrow = await connectHttp(app, claimer.token);
  test.after(narrow.close);
  const reclaimed = parse(await narrow.client.callTool({ name: "claim_work", arguments: { worker: "narrow:1" } }));
  assert.equal(reclaimed.id, itemId);
  const grantEvent = queue.events(itemId).filter((event) => event.type === "work.claimed").at(-1)!;
  assert.deepEqual(grantEvent.payload.toolsGrant, ["claim_work", "list_work", "release_work"]);
  assert.equal(grantEvent.payload.label, "narrow:1");
  assert.ok(!JSON.stringify(queue.events(itemId)).includes(reclaimed.leaseToken), "no event carries the lease token");
  await assert.rejects(narrow.client.callTool({ name: "heartbeat_work", arguments: { id: itemId, leaseToken: reclaimed.leaseToken, worker: "narrow:1" } }), "heartbeat_work is outside the grant");

  // Inventory shows the grant, never a hash or the bearer value.
  const inventory = queue.listMcpTokens("member:operator@frostyard.org");
  assert.deepEqual(
    Object.fromEntries(inventory.map((token) => [token.client, token.tools])),
    { "cockpit observer": ["get_work", "list_work"], "claim only": ["claim_work", "list_work", "release_work"] },
  );
  assert.ok(inventory.every((token) => token.tokenHash === ""));
  const observerSecret = observer.token.split("_").slice(2).join("_");
  assert.ok(!JSON.stringify(inventory).includes(observerSecret), "the secret is not in the inventory");
  assert.equal(queue.verifyMcpToken(observer.token)!.tools!.join(","), "get_work,list_work", "verification returns the grant with the record");
});

test("a token minted before rung 14 survives the migration unrestricted and still calls every tool", async () => {
  // Built by the current store and walked back to version 13 — the column
  // dropped, the version pinned — so the fixture cannot drift from the ladder.
  const directory = await mkdtemp(join(tmpdir(), "snowcat-token-tools-ladder-"));
  const path = join(directory, "queue.db");
  const before = new QueueStore(path);
  const itemId = seedQueue(before);
  const legacy = before.mintMcpToken({ owner: "member:author@frostyard.org", client: "laptop from before the rung", kinds: ["issue-resolution"] });
  before.close();
  const raw = new DatabaseSync(path);
  raw.exec("ALTER TABLE mcp_tokens DROP COLUMN tools_json; PRAGMA user_version = 13;");
  const columns = new Set((raw.prepare("PRAGMA table_info(mcp_tokens)").all() as Array<{ name: string }>).map((column) => column.name));
  assert.ok(!columns.has("tools_json"));
  assert.equal(raw.prepare("PRAGMA user_version").get()!.user_version, 13);
  raw.close();

  const queue = new QueueStore(path);
  test.after(() => queue.close());
  assert.equal(queue.schemaVersion(), SCHEMA_VERSION, "opening the store walks rung 14");
  const record = queue.verifyMcpToken(legacy.token);
  assert.ok(record, "the pre-rung token still verifies");
  assert.equal(record.tools, undefined, "NULL grant: every tool, as before the rung");
  assert.deepEqual(record.kinds, ["issue-resolution"], "its claim restriction is untouched");
  assert.equal(queue.listMcpTokens("member:author@frostyard.org")[0]!.tools, undefined);

  const app = createApp({ appToken: "surface-token", surfaceStores: () => ({ queue }), mcp: { queue: () => queue, queuePath: path, verifier: { clock } } });
  const client = await connectHttp(app, legacy.token);
  test.after(client.close);
  assert.deepEqual((await client.client.listTools()).tools.map((tool) => tool.name).sort(), [...mcpToolNames].sort());
  const claimed = parse(await client.client.callTool({ name: "claim_work", arguments: { worker: "claude:legacy:1" } }));
  assert.equal(claimed.id, itemId);
  const beat = parse(await client.client.callTool({ name: "heartbeat_work", arguments: { id: itemId, leaseToken: claimed.leaseToken, worker: "claude:legacy:1" } }));
  assert.equal(beat.status, "claimed");
  const released = parse(await client.client.callTool({ name: "release_work", arguments: { id: itemId, leaseToken: claimed.leaseToken, worker: "claude:legacy:1", reason: "done for now" } }));
  assert.equal(released.status, "queued");
  assert.equal(queue.events(itemId).find((event) => event.type === "work.claimed")!.payload.toolsGrant, undefined);
});

test("the store refuses an unknown tool, an empty grant, and stores a sorted unique grant", () => {
  const queue = new QueueStore(":memory:");
  test.after(() => queue.close());
  assert.throws(() => queue.mintMcpToken({ owner: "member:x@example.com", client: "t", tools: ["drop_everything"] }), /token tools: unknown MCP tool: drop_everything/);
  assert.throws(() => queue.mintMcpToken({ owner: "member:x@example.com", client: "t", tools: [] }), /token tools: at least one MCP tool is required/);
  const minted = queue.mintMcpToken({ owner: "member:x@example.com", client: "t", tools: ["list_work", "get_work", " list_work "] });
  assert.deepEqual(minted.record.tools, ["get_work", "list_work"]);
  // A grant on the claim input is provenance only and still must name real tools.
  seedQueue(queue);
  assert.throws(() => queue.claim({ worker: "claude:direct", allowedTools: ["nope"] }), /claim allowedTools: unknown MCP tool: nope/);
  const claimed = queue.claim({ worker: "claude:direct", allowedTools: ["claim_work"] })!;
  assert.deepEqual(queue.events(claimed.id).find((event) => event.type === "work.claimed")!.payload.toolsGrant, ["claim_work"]);
});

test("SNOWCAT_MCP_TOOLS restricts the stdio server the same way, and is validated", async () => {
  const queue = new QueueStore(":memory:");
  test.after(() => queue.close());
  const itemId = seedQueue(queue);

  assert.equal(mcpToolsFromEnvironment({}), undefined, "unset is every tool");
  assert.equal(mcpToolsFromEnvironment({ SNOWCAT_MCP_TOOLS: "  " }), undefined, "blank is every tool");
  assert.deepEqual(mcpToolsFromEnvironment({ SNOWCAT_MCP_TOOLS: "list_work, get_work ,list_work" }), ["get_work", "list_work"]);
  assert.throws(() => mcpToolsFromEnvironment({ SNOWCAT_MCP_TOOLS: "rm_rf" }), /SNOWCAT_MCP_TOOLS: unknown MCP tool: rm_rf/);

  const server = buildQueueMcpServer(":memory:", { clock }, {}, { tools: mcpToolsFromEnvironment({ SNOWCAT_MCP_TOOLS: "list_work" }) }, queue);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "stdio-tools-test", version: "0.1.0" });
  await client.connect(clientTransport);
  test.after(async () => {
    await client.close();
    await server.close();
  });
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ["list_work"]);
  assert.equal(parse(await client.callTool({ name: "list_work", arguments: {} }))[0].id, itemId);
  await assert.rejects(client.callTool({ name: "get_work", arguments: { id: itemId } }));
  await assert.rejects(client.callTool({ name: "claim_work", arguments: { worker: "claude:stdio:1" } }));
  assert.equal(queue.get(itemId)!.status, "queued");
  assert.throws(() => buildQueueMcpServer(":memory:", { clock }, {}, { tools: ["bogus"] }, queue), /MCP identity tools: unknown MCP tool: bogus/);
});

test("the CLI mints by --tools or --profile, lists the grant, and refuses unknown tools, unknown profiles, and both flags at once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-token-tools-cli-test-"));
  const path = join(directory, "queue.db");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: childEnvironment({ SNOWCAT_QUEUE_DB: path }),
    });

  const observer = run("token", "mint", "member:operator@frostyard.org", "cockpit observer", "--profile", "observer");
  assert.equal(observer.status, 0, observer.stderr);
  const printed = JSON.parse(observer.stdout) as { token: string; tools: string[]; kinds: string };
  assert.deepEqual(printed.tools, ["get_work", "list_work"]);
  assert.equal(printed.kinds, "unrestricted");
  assert.match(printed.token, /^snowcat_[0-9a-f]{16}_/);

  const custom = run("token", "mint", "member:operator@frostyard.org", "reviewer", "--kinds", "pr-review", "--tools", "claim_work,list_work,get_work,heartbeat_work,complete_work,block_work,release_work");
  assert.equal(custom.status, 0, custom.stderr);
  assert.deepEqual((JSON.parse(custom.stdout) as { tools: string[] }).tools, [...mcpToolNames].sort());

  const unrestricted = run("token", "mint", "member:author@frostyard.org", "claude author");
  assert.equal(unrestricted.status, 0, unrestricted.stderr);
  assert.equal((JSON.parse(unrestricted.stdout) as { tools: string }).tools, "unrestricted");

  const listed = JSON.parse(run("token", "list").stdout) as Array<{ client: string; tools: string[] | string; tokenHash?: string }>;
  assert.deepEqual(
    Object.fromEntries(listed.map((token) => [token.client, token.tools])),
    { "cockpit observer": ["get_work", "list_work"], reviewer: [...mcpToolNames].sort(), "claude author": "unrestricted" },
  );
  assert.ok(listed.every((token) => token.tokenHash === undefined), "listings never carry a hash");
  assert.ok(!run("token", "list").stdout.includes(printed.token), "listings never carry the bearer value");

  const badTool = run("token", "mint", "member:x@example.com", "t", "--tools", "list_work,drop_table");
  assert.notEqual(badTool.status, 0);
  assert.match(badTool.stderr, /unknown MCP tool: drop_table/);
  const badProfile = run("token", "mint", "member:x@example.com", "t", "--profile", "admin");
  assert.notEqual(badProfile.status, 0);
  assert.match(badProfile.stderr, /unknown token profile: admin \(expected observer\)/);
  const both = run("token", "mint", "member:x@example.com", "t", "--profile", "observer", "--tools", "list_work");
  assert.notEqual(both.status, 0);
  assert.match(both.stderr, /--tools and --profile are mutually exclusive/);

  const revoked = run("token", "revoke", JSON.parse(observer.stdout).id);
  assert.equal(revoked.status, 0, revoked.stderr);
  assert.ok(JSON.parse(revoked.stdout).revokedAt);
});
