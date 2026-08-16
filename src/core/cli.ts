#!/usr/bin/env node

import { coreGitSourceConfig, inspectCoreCandidate } from "./git-source.ts";
import { ControlPlaneStore, controlPlaneDatabasePath } from "../control/store.ts";

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "verify" && args.length === 0) {
    const candidate = await inspectCoreCandidate(coreGitSourceConfig());
    const { files: _files, ...summary } = candidate;
    console.log(JSON.stringify(summary, null, 2));
  } else if (command === "activate" && args.length === 1) {
    const expectedLastTransactionSequence = parsePositiveInteger(args[0]!);
    const candidate = await inspectCoreCandidate(coreGitSourceConfig());
    const store = new ControlPlaneStore(controlPlaneDatabasePath());
    try {
      console.log(
        JSON.stringify(store.activateCoreSnapshot({ candidate, expectedLastTransactionSequence }), null, 2),
      );
    } finally {
      store.close();
    }
  } else {
    throw new Error(
      "Usage: npm run --silent core -- verify\n" +
        "       npm run --silent core -- activate <expected-control-plane-sequence>",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (error && typeof error === "object" && "details" in error && Array.isArray(error.details)) {
    for (const detail of error.details) console.error(String(detail));
  }
  process.exitCode = 1;
}

function parsePositiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("expected control-plane sequence must be a positive canonical integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("expected control-plane sequence is outside the safe integer range");
  return parsed;
}
