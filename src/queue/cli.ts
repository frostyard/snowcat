#!/usr/bin/env node

import { attachVerifiedArtifact, refreshArtifactVerifications, type AttachableArtifactKind } from "./artifact-verification.ts";
import { queueStoreOptionsFromEnvironment } from "./eligibility.ts";
import { importLabeledIssues, importLabeledIssuesForEnrolled } from "./github-issues.ts";
import { QueueStore, queueDatabasePath, type MutationPrecondition } from "./store.ts";
import {
  enqueueDogfoodBatch,
  enqueueDogfoodBatchForEnrolled,
  enqueueTestingGap,
} from "./seeds.ts";
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
    const enrolled = args[0] === "--enrolled";
    const repository = enrolled ? undefined : required(args[0], "repository");
    const flags = parseFlags(args.slice(1), ["cooldown-hours"]);
    const cooldownHours = flags["cooldown-hours"] === undefined ? undefined : parseNonNegativeInteger(flags["cooldown-hours"], "cooldown-hours");
    const cooldownSeconds = cooldownHours === undefined ? undefined : cooldownHours * 3600;
    if (repository !== undefined) {
      print(enqueueDogfoodBatch(queue, repository, { cooldownSeconds }));
    } else {
      const controlPlanePath = process.env.FLUENT_CONTROL_DB;
      if (!controlPlanePath || controlPlanePath === ":memory:") {
        throw new Error("seed-dogfood --enrolled requires FLUENT_CONTROL_DB to name the control-plane database");
      }
      print(enqueueDogfoodBatchForEnrolled(queue, controlPlanePath, { cooldownSeconds }));
    }
  } else if (command === "import-issues") {
    const enrolled = args[0] === "--enrolled";
    const repository = enrolled ? undefined : required(args[0], "repository");
    const flags = parseFlags(args.slice(1), ["label", "priority"]);
    const label = required(flags.label, "--label");
    const priority = flags.priority === undefined ? undefined : parseSafeInteger(flags.priority, "priority");
    if (repository !== undefined) {
      const result = await importLabeledIssues(queue, repository, label, { priority });
      print({ ...result, created: result.created.map(withoutLeaseToken) });
    } else {
      const controlPlanePath = process.env.FLUENT_CONTROL_DB;
      if (!controlPlanePath || controlPlanePath === ":memory:") {
        throw new Error("import-issues --enrolled requires FLUENT_CONTROL_DB to name the control-plane database");
      }
      const result = await importLabeledIssuesForEnrolled(queue, controlPlanePath, label, { priority });
      print({
        ...result,
        imported: result.imported.map((entry) => ({ ...entry, created: entry.created.map(withoutLeaseToken) })),
      });
      // Partial failure is reported, not fatal: the timer must not lose the
      // repositories that did import. Only a total failure exits non-zero.
      if (result.failed.length > 0 && result.imported.length === 0) {
        console.error(`import-issues --enrolled: every repository failed (${result.failed.map((entry) => entry.repository).join(", ")})`);
        process.exitCode = 1;
      }
    }
  } else if (command === "approve") {
    const { rest, ifUpdatedAt } = extractIfUpdatedAt(args);
    const id = required(rest[0], "work item id");
    print(withoutLeaseToken(queue.approve(id, "operator:cli", precondition("proposed", ifUpdatedAt))));
  } else if (command === "reject") {
    const { rest, ifUpdatedAt } = extractIfUpdatedAt(args);
    const id = required(rest[0], "work item id");
    const reason = required(rest.slice(1).join(" "), "rejection reason");
    print(withoutLeaseToken(queue.reject(id, "operator:cli", reason, precondition("proposed", ifUpdatedAt))));
  } else if (command === "defer") {
    const { rest, ifUpdatedAt } = extractIfUpdatedAt(args);
    const id = required(rest[0], "work item id");
    const reason = required(rest.slice(1).join(" "), "deferral reason");
    print(withoutLeaseToken(queue.defer(id, "operator:cli", reason, precondition("queued", ifUpdatedAt))));
  } else if (command === "requeue") {
    const { rest, ifUpdatedAt } = extractIfUpdatedAt(args);
    const id = required(rest[0], "work item id");
    const reason = required(rest.slice(1).join(" "), "requeue reason");
    print(withoutLeaseToken(queue.requeue(id, "operator:cli", reason, precondition("blocked", ifUpdatedAt))));
  } else if (command === "cancel") {
    const { rest, ifUpdatedAt } = extractIfUpdatedAt(args);
    const id = required(rest[0], "work item id");
    const reason = required(rest.slice(1).join(" "), "cancellation reason");
    print(withoutLeaseToken(queue.cancel(id, "operator:cli", reason, precondition("blocked", ifUpdatedAt))));
  } else if (command === "prioritize") {
    const { rest, ifUpdatedAt } = extractIfUpdatedAt(args);
    const id = required(rest[0], "work item id");
    const priority = parseSafeInteger(required(rest[1], "priority"), "priority");
    const reason = required(rest.slice(2).join(" "), "prioritize reason");
    print(withoutLeaseToken(queue.prioritize(id, "operator:cli", priority, reason, currentStatusPrecondition(id, ifUpdatedAt))));
  } else if (command === "note") {
    const { rest, ifUpdatedAt } = extractIfUpdatedAt(args);
    const id = required(rest[0], "work item id");
    const text = required(rest.slice(1).join(" "), "note text");
    print(withoutLeaseToken(queue.note(id, "operator:cli", text, currentStatusPrecondition(id, ifUpdatedAt))));
  } else if (command === "attach-artifact") {
    const { rest, ifUpdatedAt } = extractIfUpdatedAt(args);
    const id = required(rest[0], "work item id");
    const url = required(rest[1], "artifact url");
    const flags = parseFlags(rest.slice(2), ["kind", "description"]);
    const kind = parseAttachableKind(flags.kind);
    const { item, check } = await attachVerifiedArtifact(
      queue,
      id,
      "operator:cli",
      { url, kind, description: flags.description },
      { precondition: currentStatusPrecondition(id, ifUpdatedAt) },
    );
    print({ item: withoutLeaseToken(item), verification: check.verification });
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
    console.error("       npm run queue -- seed-dogfood --enrolled [--cooldown-hours <n>]   (requires FLUENT_CONTROL_DB)");
    console.error("       npm run queue -- import-issues <owner/repo> --label <label> [--priority <n>]");
    console.error("       npm run queue -- import-issues --enrolled --label <label> [--priority <n>]   (requires FLUENT_CONTROL_DB; FLUENT_GITHUB_TOKEN in practice)");
    console.error("       npm run queue -- approve <work-item-id> [--if-updated-at <iso>]");
    console.error("       npm run queue -- reject <work-item-id> <reason> [--if-updated-at <iso>]");
    console.error("       npm run queue -- defer <work-item-id> <reason> [--if-updated-at <iso>]");
    console.error("       npm run queue -- requeue <work-item-id> <reason> [--if-updated-at <iso>]");
    console.error("       npm run queue -- cancel <work-item-id> <reason> [--if-updated-at <iso>]");
    console.error("       npm run queue -- prioritize <work-item-id> <priority> <reason> [--if-updated-at <iso>]");
    console.error("       npm run queue -- note <work-item-id> <text> [--if-updated-at <iso>]");
    console.error("       npm run queue -- attach-artifact <work-item-id> <url> [--kind pull-request|issue] [--description <text>] [--if-updated-at <iso>]");
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

/**
 * Pulls `--if-updated-at <iso>` out of an operator command's arguments wherever
 * it appears, so the remaining words are the id, priority, and free-text
 * reason exactly as before. The flag is opt-in: without it no precondition is
 * passed and the command behaves as it always has.
 */
function extractIfUpdatedAt(args: string[]): { rest: string[]; ifUpdatedAt: string | undefined } {
  const rest: string[] = [];
  let ifUpdatedAt: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg !== "--if-updated-at") {
      rest.push(arg);
      continue;
    }
    if (ifUpdatedAt !== undefined) throw new Error("--if-updated-at may be given only once");
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error("--if-updated-at requires a value");
    if (Number.isNaN(Date.parse(value))) throw new Error("--if-updated-at must be an ISO 8601 timestamp");
    ifUpdatedAt = value;
    index += 1;
  }
  return { rest, ifUpdatedAt };
}

/** Precondition for a command whose single required state is known from the command itself. */
function precondition(status: WorkStatus, ifUpdatedAt: string | undefined): MutationPrecondition | undefined {
  return ifUpdatedAt === undefined ? undefined : { status, updatedAt: ifUpdatedAt };
}

/**
 * Precondition for `prioritize` and `note`, which accept more than one state:
 * the status is the one the item has right now and `updatedAt` carries the
 * stale-intent check, since every mutation advances it. The store compares
 * both inside its transaction, so a change between this read and the write is
 * still refused.
 */
function currentStatusPrecondition(id: string, ifUpdatedAt: string | undefined): MutationPrecondition | undefined {
  if (ifUpdatedAt === undefined) return undefined;
  const item = queue.get(id);
  if (!item) throw new Error(`work item not found: ${id}`);
  return { status: item.status, updatedAt: ifUpdatedAt };
}

function parseAttachableKind(value: string | undefined): AttachableArtifactKind | undefined {
  if (value === undefined) return undefined;
  if (value === "pull-request" || value === "issue") return value;
  throw new Error(`--kind must be pull-request or issue: ${value}`);
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
