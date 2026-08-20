import assert from "node:assert/strict";
import test from "node:test";

import { buildQueueMcpServer } from "../src/mcp/server.ts";
import { QueueStore } from "../src/queue/store.ts";

/**
 * ADR-0064 fixes the MCP server name as `snowcat`, in parallel with the
 * `frostyard/snowcat` repository, `@frostyard/snowcat` package, and `snowcat`
 * queue label. The advertised `serverInfo.name` must therefore be exactly
 * `snowcat`, not the pre-rename `snowcat-queue`.
 */
test("the queue MCP server advertises serverInfo.name = 'snowcat' (ADR-0064)", () => {
  const queue = new QueueStore(":memory:");
  test.after(() => queue.close());

  const server = buildQueueMcpServer(":memory:", {}, {}, undefined, queue);
  test.after(async () => server.close());

  // The underlying protocol Server holds the advertised identity; read it via
  // its outbound-identity accessor, falling back to the stored field.
  const underlying = (server as unknown as { server: { _outboundServerInfo?: () => { name: string }; _serverInfo?: { name: string } } }).server;
  const info = underlying._outboundServerInfo?.() ?? underlying._serverInfo;

  assert.equal(info?.name, "snowcat");
});
