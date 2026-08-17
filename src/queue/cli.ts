#!/usr/bin/env node

import { importLabeledIssues } from "./github-issues.ts";
import { QueueStore, queueDatabasePath } from "./store.ts";
import { DEFAULT_DOGFOOD_COOLDOWN_SECONDS, enqueueDogfoodBatch, enqueueTestingGap } from "./seeds.ts";
import { withoutLeaseToken, workStatuses, type WorkStatus } from "./types.ts";

const queue = new QueueStore(queueDatabasePath());

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "opt-in") {
    const repository = required(args[0], "repository");
    queue.setRepositoryEnabled(repository, true);
    print({ repository, enabled: true });
  } else if (command === "opt-out") {
    const repository = required(args[0], "repository");
    queue.setRepositoryEnabled(repository, false);
    print({ repository, enabled: false });
  } else if (command === "seed-testing-gap") {
    const repository = required(args[0], "repository");
    print(enqueueTestingGap(queue, repository));
  } else if (command === "seed-dogfood") {
    const repository = required(args[0], "repository");
    const flags = parseFlags(args.slice(1), ["cooldown-hours"]);
    const cooldownHours = flags["cooldown-hours"] === undefined ? undefined : parseNonNegativeInteger(flags["cooldown-hours"], "cooldown-hours");
    print(
      enqueueDogfoodBatch(queue, repository, {
        cooldownSeconds: cooldownHours === undefined ? DEFAULT_DOGFOOD_COOLDOWN_SECONDS : cooldownHours * 3600,
      }),
    );
  } else if (command === "import-issues") {
    const repository = required(args[0], "repository");
    const flags = parseFlags(args.slice(1), ["label", "priority"]);
    const label = required(flags.label, "--label");
    const priority = flags.priority === undefined ? undefined : parseSafeInteger(flags.priority, "priority");
    const result = await importLabeledIssues(queue, repository, label, { priority });
    print({ ...result, created: result.created.map(withoutLeaseToken) });
  } else if (command === "approve") {
    const id = required(args[0], "work item id");
    print(withoutLeaseToken(queue.approve(id, "operator:cli")));
  } else if (command === "reject") {
    const id = required(args[0], "work item id");
    const reason = required(args.slice(1).join(" "), "rejection reason");
    print(withoutLeaseToken(queue.reject(id, "operator:cli", reason)));
  } else if (command === "defer") {
    const id = required(args[0], "work item id");
    const reason = required(args.slice(1).join(" "), "deferral reason");
    print(withoutLeaseToken(queue.defer(id, "operator:cli", reason)));
  } else if (command === "requeue") {
    const id = required(args[0], "work item id");
    const reason = required(args.slice(1).join(" "), "requeue reason");
    print(withoutLeaseToken(queue.requeue(id, "operator:cli", reason)));
  } else if (command === "cancel") {
    const id = required(args[0], "work item id");
    const reason = required(args.slice(1).join(" "), "cancellation reason");
    print(withoutLeaseToken(queue.cancel(id, "operator:cli", reason)));
  } else if (command === "list") {
    print(queue.list({ status: parseStatus(args[0]) }).map(withoutLeaseToken));
  } else if (command === "metadata") {
    print(queue.metadata());
  } else if (command === "backup") {
    const path = required(args[0], "backup path");
    print(queue.backup(path));
  } else if (command === "verify-backup") {
    const path = required(args[0], "backup path");
    print(QueueStore.inspectBackup(path));
  } else {
    console.error("Usage: npm run queue -- opt-in <owner/repo>");
    console.error("       npm run queue -- opt-out <owner/repo>");
    console.error("       npm run queue -- seed-testing-gap <owner/repo>");
    console.error("       npm run queue -- seed-dogfood <owner/repo> [--cooldown-hours <n>]");
    console.error("       npm run queue -- import-issues <owner/repo> --label <label> [--priority <n>]");
    console.error("       npm run queue -- approve <work-item-id>");
    console.error("       npm run queue -- reject <work-item-id> <reason>");
    console.error("       npm run queue -- defer <work-item-id> <reason>");
    console.error("       npm run queue -- requeue <work-item-id> <reason>");
    console.error("       npm run queue -- cancel <work-item-id> <reason>");
    console.error("       npm run queue -- list [proposed|queued|claimed|completed|blocked|cancelled]");
    console.error("       npm run queue -- metadata");
    console.error("       npm run queue -- backup <new-file-path>");
    console.error("       npm run queue -- verify-backup <backup-file-path>");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  queue.close();
}

function parseStatus(value: string | undefined): WorkStatus | undefined {
  if (value === undefined) return undefined;
  if ((workStatuses as readonly string[]).includes(value)) return value as WorkStatus;
  throw new Error(`unknown status: ${value} (expected one of ${workStatuses.join(", ")})`);
}

function parseFlags(args: string[], known: string[]): Record<string, string | undefined> {
  const flags: Record<string, string | undefined> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (!known.includes(name)) throw new Error(`unknown flag: ${arg} (expected ${known.map((flag) => `--${flag}`).join(", ")})`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    flags[name] = value;
    index += 1;
  }
  return flags;
}

function parseSafeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function parseNonNegativeInteger(value: string, name: string): number {
  const parsed = parseSafeInteger(value, name);
  if (parsed < 0) throw new Error(`${name} must not be negative`);
  return parsed;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
