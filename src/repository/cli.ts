#!/usr/bin/env node

import { ControlPlaneStore, controlPlaneDatabasePath } from "../control/store.ts";
import { reconcileRepositories } from "./controller.ts";

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "status" && args.length === 0) {
    const store = new ControlPlaneStore(controlPlaneDatabasePath());
    try {
      console.log(JSON.stringify(store.repositoryStatuses(), null, 2));
    } finally {
      store.close();
    }
  } else if (command === "reconcile" && args.length === 0) {
    const store = new ControlPlaneStore(controlPlaneDatabasePath());
    try {
      console.log(JSON.stringify(await reconcileRepositories(store), null, 2));
    } finally {
      store.close();
    }
  } else if (command === "hold" && args.length === 3) {
    const store = new ControlPlaneStore(controlPlaneDatabasePath());
    try {
      console.log(
        JSON.stringify(
          store.imposeRepositoryOperatorHold({
            expectedLastTransactionSequence: Number(args[0]),
            repositoryId: args[1]!,
            reason: args[2]!,
          }),
          null,
          2,
        ),
      );
    } finally {
      store.close();
    }
  } else if (command === "clear-hold" && args.length === 4) {
    const store = new ControlPlaneStore(controlPlaneDatabasePath());
    try {
      console.log(
        JSON.stringify(
          store.clearRepositoryOperatorHold({
            expectedLastTransactionSequence: Number(args[0]),
            repositoryId: args[1]!,
            holdDecisionId: args[2]!,
            reason: args[3]!,
          }),
          null,
          2,
        ),
      );
    } finally {
      store.close();
    }
  } else {
    throw new Error(
      "Usage: npm run --silent repository -- status\n" +
        "       npm run --silent repository -- reconcile\n" +
        "       npm run --silent repository -- hold <expected-sequence> <github.com:id> <reason>\n" +
        "       npm run --silent repository -- clear-hold <expected-sequence> <github.com:id> <hold-decision-id> <reason>",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
