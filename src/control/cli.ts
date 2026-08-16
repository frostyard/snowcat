#!/usr/bin/env node

import { readFileSync } from "node:fs";

import {
  ControlPlaneStore,
  controlPlaneDatabasePath,
  type ControlPlaneBackupManifest,
} from "./store.ts";

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "verify-backup") {
    expectArguments(args, 3, "verify-backup <manifest.json> <database-lineage-id> <minimum-sequence>");
    const manifest = readManifest(args[0]!);
    print(
      ControlPlaneStore.verifyBackup(manifest, {
        databaseLineageId: args[1]!,
        minimumLastTransactionSequence: positiveInteger(args[2]!, "minimum sequence"),
      }),
    );
  } else if (command === "stage-restore") {
    expectArguments(
      args,
      4,
      "stage-restore <manifest.json> <new-target.db> <database-lineage-id> <minimum-sequence>",
    );
    const manifest = readManifest(args[0]!);
    print(
      await ControlPlaneStore.stageRestore(manifest, args[1]!, {
        databaseLineageId: args[2]!,
        minimumLastTransactionSequence: positiveInteger(args[3]!, "minimum sequence"),
      }),
    );
  } else if (command === "repair-projections") {
    expectArguments(args, 0, "repair-projections");
    const store = ControlPlaneStore.openForProjectionRepair(controlPlaneDatabasePath());
    try {
      print(store.repairProjections());
    } finally {
      store.close();
    }
  } else if (
    command === "metadata" ||
    command === "check-integrity" ||
    command === "projection-health" ||
    command === "rebuild-projections" ||
    command === "backup"
  ) {
    const store = new ControlPlaneStore(controlPlaneDatabasePath());
    try {
      if (command === "metadata") {
        expectArguments(args, 0, "metadata");
        print({ ...store.metadata(), authoritativeDigest: store.authoritativeDigest() });
      } else if (command === "check-integrity") {
        expectArguments(args, 2, "check-integrity <expected-sequence> <idempotency-key>");
        print(
          store.checkIntegrity({
            expectedLastTransactionSequence: positiveInteger(args[0]!, "expected sequence"),
            idempotencyKey: args[1]!,
          }),
        );
      } else if (command === "projection-health") {
        expectArguments(args, 0, "projection-health");
        print(store.projectionHealth());
      } else if (command === "rebuild-projections") {
        expectArguments(args, 0, "rebuild-projections");
        print(store.rebuildProjections());
      } else {
        expectArguments(args, 1, "backup <new-backup.db>");
        print(await store.createBackup(args[0]!));
      }
    } finally {
      store.close();
    }
  } else {
    usage();
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function readManifest(path: string): ControlPlaneBackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read backup manifest ${path}: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`backup manifest ${path} must contain one JSON object`);
  }
  return parsed as ControlPlaneBackupManifest;
}

function positiveInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive canonical integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} must be a positive safe integer`);
  return result;
}

function expectArguments(args: string[], count: number, commandUsage: string): void {
  if (args.length !== count) throw new Error(`Usage: npm run --silent control -- ${commandUsage}`);
}

function usage(): void {
  console.error("Usage: npm run --silent control -- metadata");
  console.error("       npm run --silent control -- check-integrity <expected-sequence> <idempotency-key>");
  console.error("       npm run --silent control -- projection-health");
  console.error("       npm run --silent control -- rebuild-projections");
  console.error("       npm run --silent control -- repair-projections");
  console.error("       npm run --silent control -- backup <new-backup.db>");
  console.error("       npm run --silent control -- verify-backup <manifest.json> <database-lineage-id> <minimum-sequence>");
  console.error(
    "       npm run --silent control -- stage-restore <manifest.json> <new-target.db> <database-lineage-id> <minimum-sequence>",
  );
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
