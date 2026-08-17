#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { queueStoreOptionsFromEnvironment } from "../queue/eligibility.ts";
import { buildQueueMcpServer } from "./server.ts";

serveStdio(() => buildQueueMcpServer(undefined, {}, queueStoreOptionsFromEnvironment()));
console.error("Fluent queue MCP server listening on stdio");
