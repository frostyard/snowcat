#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { queueStoreOptionsFromEnvironment } from "../queue/eligibility.ts";
import { buildQueueMcpServer } from "./server.ts";
import { adoptLegacyEnvironment } from "../env-compat.ts";

// FLUENT_* is read for one release (Snowcat ADR-0064); every entry point adopts it first.
adoptLegacyEnvironment();

serveStdio(() => buildQueueMcpServer(undefined, {}, queueStoreOptionsFromEnvironment()));
console.error("Snowcat queue MCP server listening on stdio");
