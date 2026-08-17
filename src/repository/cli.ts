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
  } else {
    throw new Error(
      "Usage: npm run --silent repository -- status\n" +
        "       npm run --silent repository -- reconcile",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
