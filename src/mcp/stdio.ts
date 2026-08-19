#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { queueStoreOptionsFromEnvironment } from "../queue/eligibility.ts";
import { buildQueueMcpServer, mcpKindsFromEnvironment } from "./server.ts";
import { adoptLegacyEnvironment } from "../env-compat.ts";

// FLUENT_* is read for one release (Snowcat ADR-0064); every entry point adopts it first.
adoptLegacyEnvironment();

// SNOWCAT_MCP_KINDS is stdio's equivalent of a minted token's kinds: the
// local server may then claim only those kinds (unset = unrestricted).
const kinds = mcpKindsFromEnvironment();

serveStdio(() => buildQueueMcpServer(undefined, {}, queueStoreOptionsFromEnvironment(), kinds ? { kinds } : undefined));
console.error(
  `Snowcat queue MCP server listening on stdio${kinds ? ` (may claim only: ${kinds.join(", ")})` : ""}`,
);
