#!/usr/bin/env node

import { QueueStore, queueDatabasePath } from "./store.ts";
import { enqueueDogfoodBatch, enqueueTestingGap } from "./seeds.ts";
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
    print(enqueueDogfoodBatch(queue, repository));
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
  } else {
    console.error("Usage: npm run queue -- opt-in <owner/repo>");
    console.error("       npm run queue -- opt-out <owner/repo>");
    console.error("       npm run queue -- seed-testing-gap <owner/repo>");
    console.error("       npm run queue -- seed-dogfood <owner/repo>");
    console.error("       npm run queue -- approve <work-item-id>");
    console.error("       npm run queue -- reject <work-item-id> <reason>");
    console.error("       npm run queue -- defer <work-item-id> <reason>");
    console.error("       npm run queue -- requeue <work-item-id> <reason>");
    console.error("       npm run queue -- cancel <work-item-id> <reason>");
    console.error("       npm run queue -- list [proposed|queued|claimed|completed|blocked|cancelled]");
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

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}
