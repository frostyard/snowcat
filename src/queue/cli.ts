#!/usr/bin/env node

import { refreshArtifactVerifications } from "./artifact-verification.ts";
import { queueStoreOptionsFromEnvironment } from "./eligibility.ts";
import { importLabeledIssues } from "./github-issues.ts";
import { QueueStore, queueDatabasePath } from "./store.ts";
import { DEFAULT_DOGFOOD_COOLDOWN_SECONDS, enqueueDogfoodBatch, enqueueTestingGap } from "./seeds.ts";
import { withoutLeaseToken, workStatuses, type WorkStatus } from "./types.ts";

const DEFAULT_WATCH_INTERVAL_SECONDS = 10;
const MIN_WATCH_INTERVAL_SECONDS = 2;
const WATCH_PAGE_SIZE = 500;

const queue = new QueueStore(queueDatabasePath(), undefined, queueStoreOptionsFromEnvironment());

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
  } else if (command === "prioritize") {
    const id = required(args[0], "work item id");
    const priority = parseSafeInteger(required(args[1], "priority"), "priority");
    const reason = required(args.slice(2).join(" "), "prioritize reason");
    print(withoutLeaseToken(queue.prioritize(id, "operator:cli", priority, reason)));
  } else if (command === "note") {
    const id = required(args[0], "work item id");
    const text = required(args.slice(1).join(" "), "note text");
    print(withoutLeaseToken(queue.note(id, "operator:cli", text)));
  } else if (command === "list") {
    const status = args[0] !== undefined && !args[0].startsWith("--") ? args[0] : undefined;
    const flags = parseFlags(status === undefined ? args : args.slice(1), ["repository", "kind", "limit"]);
    const limit = flags.limit === undefined ? undefined : parseNonNegativeInteger(flags.limit, "limit");
    if (limit !== undefined && (limit < 1 || limit > 100)) throw new Error("limit must be between 1 and 100");
    print(
      queue
        .list({ status: parseStatus(status), repository: flags.repository, kind: flags.kind, limit })
        .map(withoutLeaseToken),
    );
  } else if (command === "show") {
    const id = required(args[0], "work item id");
    const item = queue.get(id);
    if (!item) throw new Error(`work item not found: ${id}`);
    print({ item: withoutLeaseToken(item), events: queue.events(id) });
  } else if (command === "events") {
    const flags = parseFlags(args, ["since", "repository", "limit"]);
    const since = flags.since === undefined ? 0 : parseNonNegativeInteger(flags.since, "since");
    const limit = flags.limit === undefined ? undefined : parseNonNegativeInteger(flags.limit, "limit");
    if (limit !== undefined && (limit < 1 || limit > 500)) throw new Error("limit must be between 1 and 500");
    print(queue.eventsSince(since, { repository: flags.repository, limit }));
  } else if (command === "watch") {
    const flags = parseFlags(args, ["repository", "interval"]);
    const requested = flags.interval === undefined ? DEFAULT_WATCH_INTERVAL_SECONDS : parseNonNegativeInteger(flags.interval, "interval");
    if (requested < 1) throw new Error("interval must be at least 1 second");
    const intervalSeconds = Math.max(requested, MIN_WATCH_INTERVAL_SECONDS);
    await watchEvents(queue, { repository: flags.repository, intervalSeconds });
  } else if (command === "verify-artifacts") {
    const flags = parseFlags(args, ["repository", "limit"]);
    const limit = flags.limit === undefined ? undefined : parseNonNegativeInteger(flags.limit, "limit");
    if (limit !== undefined && (limit < 1 || limit > 100)) throw new Error("limit must be between 1 and 100");
    print(await refreshArtifactVerifications(queue, { repository: flags.repository, limit }));
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
    console.error("       npm run queue -- prioritize <work-item-id> <priority> <reason>");
    console.error("       npm run queue -- note <work-item-id> <text>");
    console.error("       npm run queue -- list [proposed|queued|claimed|completed|blocked|cancelled] [--repository <owner/repo>] [--kind <kind>] [--limit <1-100>]");
    console.error("       npm run queue -- show <work-item-id>");
    console.error("       npm run queue -- events [--since <sequence>] [--repository <owner/repo>] [--limit <1-500>]");
    console.error("       npm run queue -- watch [--repository <owner/repo>] [--interval <seconds>]");
    console.error("       npm run queue -- verify-artifacts [--repository <owner/repo>] [--limit <1-100>]");
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

/**
 * Read-only tail of the event ledger: polls `eventsSince` from the current
 * last sequence and prints one JSON line per new event until SIGINT or SIGTERM,
 * then returns so the store closes normally. Repository filtering happens in
 * the store; nothing here mutates the queue.
 */
async function watchEvents(store: QueueStore, options: { repository?: string; intervalSeconds: number }): Promise<void> {
  let cursor = store.metadata().lastEventSequence;
  let stopped = false;
  let wake: (() => void) | undefined;
  const stop = () => {
    stopped = true;
    wake?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.error(
    `watching ${options.repository ?? "all repositories"} from sequence ${cursor} every ${options.intervalSeconds}s (Ctrl-C to stop)`,
  );
  try {
    while (!stopped) {
      let page: ReturnType<QueueStore["eventsSince"]>;
      do {
        page = store.eventsSince(cursor, { repository: options.repository, limit: WATCH_PAGE_SIZE });
        for (const event of page) process.stdout.write(`${JSON.stringify(event)}\n`);
        if (page.length > 0) cursor = page[page.length - 1]!.sequence;
      } while (page.length === WATCH_PAGE_SIZE && !stopped);
      if (stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.intervalSeconds * 1000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = undefined;
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
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
