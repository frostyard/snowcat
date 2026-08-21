#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { queueStoreOptionsFromEnvironment } from "../queue/eligibility.ts";
import { buildQueueMcpServer, mcpKindsFromEnvironment, mcpToolsFromEnvironment } from "./server.ts";
import { adoptLegacyEnvironment } from "../env-compat.ts";

// FLUENT_* is read for one release (Snowcat ADR-0064); every entry point adopts it first.
adoptLegacyEnvironment();

// SNOWCAT_MCP_KINDS is stdio's equivalent of a minted token's kinds: the
// local server may then claim only those kinds (unset = unrestricted).
// SNOWCAT_MCP_TOOLS is the equivalent of a token's tool grant (ADR-0070): the
// local server registers only those tools (unset = every tool).
const kinds = mcpKindsFromEnvironment();
const tools = mcpToolsFromEnvironment();
const identity = kinds || tools ? { ...(kinds ? { kinds } : {}), ...(tools ? { tools } : {}) } : undefined;

serveStdio(() => buildQueueMcpServer(undefined, {}, queueStoreOptionsFromEnvironment(), identity));
console.error(
  `Snowcat queue MCP server listening on stdio${kinds ? ` (may claim only: ${kinds.join(", ")})` : ""}${tools ? ` (tools: ${tools.join(", ")})` : ""}`,
);
