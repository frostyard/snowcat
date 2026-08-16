#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { buildQueueMcpServer } from "./server.ts";

serveStdio(() => buildQueueMcpServer());
console.error("Fluent queue MCP server listening on stdio");
