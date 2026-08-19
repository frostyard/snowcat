import { createMcpHandler, type AuthInfo, type McpHttpHandler } from "@modelcontextprotocol/server";
import type { Hono } from "hono";

import type { ArtifactVerifierOptions } from "../queue/artifact-verification.ts";
import type { QueueStore, QueueStoreOptions } from "../queue/store.ts";
import { buildQueueMcpServer } from "./server.ts";

/**
 * The Streamable HTTP MCP endpoint (ADR-0063): the same tools as stdio,
 * behind a Snowcat-minted bearer token. The token is verified against the
 * queue store on every request; the member and client it names become the
 * transport identity every tool acts as (`member:<owner>/<client>`), and the
 * payload's `worker` is demoted to the claim's label; a token minted with
 * `kinds` may claim only those. No token → 401 with a
 * `WWW-Authenticate` challenge; a malformed, unknown, or revoked token is
 * indistinguishable from none. Cloudflare Access is expected to bypass this
 * path (the token is the credential); the surface routes stay behind Access.
 */
export interface McpHttpOptions {
  path?: string;
  /** Opened lazily on the first request, like the surface's stores. */
  queue: () => QueueStore;
  queuePath: string;
  storeOptions?: QueueStoreOptions;
  verifier?: ArtifactVerifierOptions;
}

export function mountMcpHttp(app: Hono, options: McpHttpOptions): McpHttpHandler {
  const path = options.path ?? "/mcp";
  const handler = createMcpHandler(
    (context) => {
      const principal = context.authInfo?.extra?.principal;
      if (typeof principal !== "string") throw new Error("MCP HTTP request reached the server factory without a verified principal");
      // A token minted with kinds (schema rung 9) may claim only those; the
      // restriction rides the identity and narrows claim_work in the store.
      const kinds = context.authInfo?.extra?.kinds;
      return buildQueueMcpServer(
        options.queuePath,
        options.verifier ?? {},
        options.storeOptions ?? {},
        { principal, ...(Array.isArray(kinds) ? { kinds: kinds as string[] } : {}) },
        options.queue(),
      );
    },
    { legacy: "stateless" },
  );
  app.all(path, async (context) => {
    const authorization = context.req.header("Authorization") ?? "";
    const presented = /^Bearer\s+(\S+)$/i.exec(authorization)?.[1];
    const record = presented ? options.queue().verifyMcpToken(presented) : undefined;
    if (!record) {
      return new Response(JSON.stringify({ error: "unauthorized", hint: "send a Snowcat-minted MCP token as a bearer header" }), {
        status: 401,
        headers: { "content-type": "application/json", "WWW-Authenticate": 'Bearer realm="snowcat-mcp"' },
      });
    }
    const authInfo: AuthInfo = {
      token: presented!,
      clientId: record.id,
      scopes: [],
      extra: {
        principal: `${record.owner}/${record.client}`,
        owner: record.owner,
        client: record.client,
        tokenId: record.id,
        ...(record.kinds ? { kinds: record.kinds } : {}),
      },
    };
    return handler.fetch(context.req.raw, { authInfo });
  });
  return handler;
}
