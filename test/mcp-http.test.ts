import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { createApp } from "../src/app.ts";
import { QueueStore } from "../src/queue/store.ts";

const clock = () => new Date("2026-08-18T23:00:00.000Z");

/** Routes the SDK's HTTP client into the Hono app in-process, with a fixed Authorization header. */
function inProcessFetch(app: ReturnType<typeof createApp>, authorization?: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    if (authorization) request.headers.set("Authorization", authorization);
    return app.request(request);
  }) as typeof fetch;
}

async function connect(app: ReturnType<typeof createApp>, authorization?: string) {
  const transport = new StreamableHTTPClientTransport(new URL("http://snowcat.test/mcp"), { fetch: inProcessFetch(app, authorization) });
  const client = new Client({ name: "http-test", version: "0.1.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

const parse = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, any>;

test("the HTTP MCP endpoint refuses without a valid minted token and acts as the token's member identity with one", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-mcp-http-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/example", true);
  queue.enqueueSeed({ repository: "frostyard/example", kind: "quality-gap-discovery", objective: "Find one gap.", instructions: "Read only.", acceptanceCriteria: ["One gap."], allowedActions: ["read", "create-followup"], delegableActions: ["read"], executionTarget: "read-only", createdBy: "operator:test" });
  const app = createApp({ appToken: "surface-token", surfaceStores: () => ({ queue }), mcp: { queue: () => queue, queuePath: path, verifier: { clock } } });

  // No token, malformed token, unknown token, revoked token: 401 with a challenge, no distinguishable reason.
  for (const header of [undefined, "Bearer nope", `Bearer snowcat_${"0".repeat(16)}_${"a".repeat(32)}`, "Basic abc"]) {
    const response = await app.request("/mcp", { method: "POST", headers: { ...(header ? { Authorization: header } : {}), "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(response.status, 401, String(header));
    assert.match(response.headers.get("WWW-Authenticate") ?? "", /Bearer realm="snowcat-mcp"/);
  }

  const minted = queue.mintMcpToken({ owner: "member:bketelsen@gmail.com", client: "codex-laptop" });
  const revoked = queue.mintMcpToken({ owner: "member:bketelsen@gmail.com", client: "old-laptop" });
  queue.revokeMcpToken(revoked.record.id, "operator:test");
  const denied = await app.request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${revoked.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(denied.status, 401);

  // With the token: the tools are there and act as member:<owner>/<client>; the payload's worker is only a label.
  const { client, close } = await connect(app, `Bearer ${minted.token}`);
  test.after(close);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "claim_work"));
  const claimed = parse(await client.callTool({ name: "claim_work", arguments: { worker: "codex:frostyard/example:session1", repository: "frostyard/example" } }));
  assert.equal(claimed.leaseOwner, "member:bketelsen@gmail.com/codex-laptop");
  const claimEvent = queue.events(claimed.id).find((event) => event.type === "work.claimed")!;
  assert.equal(claimEvent.actor, "member:bketelsen@gmail.com/codex-laptop");
  assert.equal(claimEvent.payload.label, "codex:frostyard/example:session1");

  // A worker cannot smuggle a member: identity through the payload even over HTTP.
  const forged = await client.callTool({ name: "heartbeat_work", arguments: { id: claimed.id, leaseToken: claimed.leaseToken, worker: "member:someone-else@x.io/evil" } });
  assert.equal(forged.isError, true);

  // The lease belongs to the identity, so the same client (any declared worker) can heartbeat and complete.
  const beat = parse(await client.callTool({ name: "heartbeat_work", arguments: { id: claimed.id, leaseToken: claimed.leaseToken, worker: "codex:whatever" } }));
  assert.equal(beat.leaseOwner, "member:bketelsen@gmail.com/codex-laptop");
  const done = parse(await client.callTool({ name: "complete_work", arguments: { id: claimed.id, leaseToken: claimed.leaseToken, worker: "codex:whatever", result: { summary: "No gap.", evidence: ["src/"], artifacts: [] }, followUps: [] } }));
  assert.equal(done.completed.status, "completed");
  assert.equal(queue.events(claimed.id).find((event) => event.type === "work.completed")!.actor, "member:bketelsen@gmail.com/codex-laptop");
  assert.equal(queue.verifyMcpToken(minted.token)!.lastUsedAt !== undefined, true, "the token's last use is recorded");
});
