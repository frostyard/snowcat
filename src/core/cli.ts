#!/usr/bin/env node

import { coreGitSourceConfig, inspectCoreCandidate } from "./git-source.ts";

const [command, ...args] = process.argv.slice(2);

try {
  if (command !== "verify" || args.length !== 0) {
    throw new Error("Usage: npm run --silent core -- verify");
  }
  const candidate = await inspectCoreCandidate(coreGitSourceConfig());
  console.log(JSON.stringify(candidate, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (error && typeof error === "object" && "details" in error && Array.isArray(error.details)) {
    for (const detail of error.details) console.error(String(detail));
  }
  process.exitCode = 1;
}
