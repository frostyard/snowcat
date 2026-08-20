#!/usr/bin/env node

import { attachVerifiedArtifact, refreshArtifactVerifications, type AttachableArtifactKind } from "./artifact-verification.ts";
import { queueStoreOptionsFromEnvironment } from "./eligibility.ts";
import { curePullRequests } from "./pull-request-cure.ts";
import { reviewGateWritesFromEnvironment, reviewPullRequests } from "./pull-request-review.ts";
import { importLabeledIssues, importLabeledIssuesForEnrolled } from "./github-issues.ts";
import { parseMetricsTimestamp, queueMetrics } from "./metrics.ts";
import { sweepFailureMessage, sweepInternalDependencies } from "./internal-dependencies.ts";
import { sweepRepositorySettings } from "./repository-settings.ts";
import { QueueStore, queueDatabasePath, type MutationPrecondition } from "./store.ts";
import {
  enqueueDogfoodBatch,
  enqueueDogfoodBatchForEnrolled,
  enqueueTestingGap,
} from "./seeds.ts";
import { withoutLeaseToken, workStatuses, type WorkStatus } from "./types.ts";
import { adoptLegacyEnvironment } from "../env-compat.ts";

// FLUENT_* is read for one release (Snowcat ADR-0064); every entry point adopts it first.
adoptLegacyEnvironment();

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
  } else if (command === "cure-foreign") {
    // Repository-level setting like opt-in: whether the cure sweep also lists
    // and inspects open pull requests no Snowcat item reported (ADR-0061).
    const repository = required(args[0], "repository");
    const value = required(args[1], "on|off");
    if (value !== "on" && value !== "off") throw new Error(`cure-foreign expects on or off, got ${value}`);
    queue.setRepositoryCureForeign(repository, value === "on");
    print({ repository, cureForeign: value === "on" });
  } else if (command === "review-gate") {
    // Repository-level setting like opt-in: whether workers open pull requests
    // as drafts and the verification pass creates bounded review rounds for
    // them (ADR-0065). Off by default.
    const repository = required(args[0], "repository");
    const value = required(args[1], "on|off");
    if (value !== "on" && value !== "off") throw new Error(`review-gate expects on or off, got ${value}`);
    queue.setRepositoryReviewGate(repository, value === "on");
    print({ repository, reviewGate: value === "on" });
  } else if (command === "rename-repository") {
    // After a GitHub rename: carry the opt-in and every item to the new slug;
    // history keeps the old strings. Attributed to the CLI operator.
    const from = required(args[0], "old repository");
    const to = required(args[1], "new repository");
    print(queue.renameRepository(from, to, "operator:cli"));
  } else if (command === "token") {
    // Snowcat-minted MCP tokens (ADR-0063): mint prints the plaintext exactly
    // once; list never shows hashes; revoke is idempotent.
    const action = required(args[0], "token action (mint|list|revoke)");
    if (action === "mint") {
      const owner = required(args[1], "token owner (member:<email>)");
      const client = required(args[2], "token client name");
      // --kinds narrows what the token may claim (schema rung 9); omitted, it
      // claims anything the queue offers, exactly as before.
      const flags = parseFlags(args.slice(3), ["kinds"]);
      const kinds = flags.kinds === undefined ? undefined : flags.kinds.split(",").map((kind) => kind.trim()).filter((kind) => kind !== "");
      const minted = queue.mintMcpToken({ owner, client, ...(kinds === undefined ? {} : { kinds }) });
      print({ token: minted.token, id: minted.record.id, owner: minted.record.owner, client: minted.record.client, kinds: minted.record.kinds ?? "unrestricted", createdAt: minted.record.createdAt, note: "The token is shown once; store it in the client's MCP configuration as a bearer header." });
    } else if (action === "list") {
      print(queue.listMcpTokens(args[1]).map(({ tokenHash: _hash, kinds, ...token }) => ({ ...token, kinds: kinds ?? "unrestricted" })));
    } else if (action === "revoke") {
      const id = required(args[1], "token id");
      const { tokenHash: _hash, ...revoked } = queue.revokeMcpToken(id, "operator:cli");
      print(revoked);
    } else {
      throw new Error(`unknown token action: ${action} (mint|list|revoke)`);
    }
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
      const controlPlanePath = process.env.SNOWCAT_CONTROL_DB;
      if (!controlPlanePath || controlPlanePath === ":memory:") {
        throw new Error("seed-dogfood --enrolled requires SNOWCAT_CONTROL_DB to name the control-plane database");
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
      const controlPlanePath = process.env.SNOWCAT_CONTROL_DB;
      if (!controlPlanePath || controlPlanePath === ":memory:") {
        throw new Error("import-issues --enrolled requires SNOWCAT_CONTROL_DB to name the control-plane database");
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
    // A gated item reads as stuck unless the reason is on the page: for an
    // item that declares predecessors, print each one's current satisfaction
    // — the same evaluation the claim gate runs (ADR-0066 decision 3), so what
    // is printed here is why the item is or is not claimable right now.
    print({
      item: withoutLeaseToken(item),
      ...(item.predecessors ? { predecessors: queue.predecessorStatuses(id) } : {}),
      events: queue.events(id),
    });
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
  } else if (command === "metrics") {
    // The PRD baseline numbers over one window: created items by current
    // status, attempts, completions by delivery, acceptance per attempt,
    // blocks, cancellations, and time to merge. It is a read of the ledger
    // and the current items — it writes nothing and is not exposed through
    // MCP. The window is half-open, `[since, until)`, and defaults to the
    // last 24 hours ending now.
    const flags = parseFlags(args, ["repository", "since", "until"]);
    print(
      queueMetrics(queue, {
        repository: flags.repository,
        since: flags.since === undefined ? undefined : parseMetricsTimestamp(flags.since, "--since"),
        until: flags.until === undefined ? undefined : parseMetricsTimestamp(flags.until, "--until"),
      }),
    );
  } else if (command === "sweep-dependencies") {
    // The internal dependency chain: release-needed on enrolled repositories
    // ahead of their latest tag, dependency-bump on ones behind a frostyard
    // module's latest release. Proposals only; the operator admits.
    const enrolled = args[0] === "--enrolled";
    const repository = enrolled ? undefined : required(args[0], "repository");
    const controlPlanePath = process.env.SNOWCAT_CONTROL_DB;
    if (enrolled && (!controlPlanePath || controlPlanePath === ":memory:")) {
      throw new Error("sweep-dependencies --enrolled requires SNOWCAT_CONTROL_DB to name the control-plane database");
    }
    const result = await sweepInternalDependencies(queue, controlPlanePath, repository ? { repository } : {});
    print(result);
    // Partial failure is reported, not fatal, exactly as for import-issues
    // --enrolled: only a total failure of the enrolled sweep exits non-zero.
    if (enrolled) {
      const failure = sweepFailureMessage(result);
      if (failure !== undefined) {
        console.error(failure);
        process.exitCode = 1;
      }
    }
  } else if (command === "sweep-repository-settings") {
    // Repository settings conformance (core ADR-0040): read-only diff of each
    // enrolled repository's live GitHub settings against the contract in the
    // active Core snapshot; one settings-drift proposal per drift set.
    const enrolled = args[0] === "--enrolled";
    const repository = enrolled ? undefined : required(args[0], "repository");
    const controlPlanePath = process.env.SNOWCAT_CONTROL_DB;
    if (!controlPlanePath || controlPlanePath === ":memory:") {
      throw new Error("sweep-repository-settings requires SNOWCAT_CONTROL_DB to name the control-plane database (the contract lives in the active Core snapshot)");
    }
    print(await sweepRepositorySettings(queue, controlPlanePath, repository ? { repository } : {}));
  } else if (command === "verify-artifacts") {
    const noCure = args.includes("--no-cure");
    const noReview = args.includes("--no-review");
    const flags = parseFlags(args.filter((argument) => argument !== "--no-cure" && argument !== "--no-review"), ["repository", "limit"]);
    const limit = flags.limit === undefined ? undefined : parseNonNegativeInteger(flags.limit, "limit");
    if (limit !== undefined && (limit < 1 || limit > 100)) throw new Error("limit must be between 1 and 100");
    const refreshed = await refreshArtifactVerifications(queue, { repository: flags.repository, limit });
    // The same pass detects pull-request decay and enqueues one pr-cure root
    // per decayed head (ADR-0061); --no-cure runs the refresh alone. It also
    // advances the review gate for draft pull requests in review-gated
    // repositories (ADR-0065); --no-review skips that step.
    const cure = noCure ? undefined : await curePullRequests(queue, { repository: flags.repository, limit });
    const review = noReview ? undefined : await reviewPullRequests(queue, { repository: flags.repository, limit, writes: reviewGateWritesFromEnvironment() });
    print({ ...refreshed, ...(cure ? { cure } : {}), ...(review ? { review } : {}) });
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
    console.error("       npm run queue -- rename-repository <old owner/repo> <new owner/repo>   (after a GitHub rename; history keeps the old slug)");
    console.error("       npm run queue -- token mint <member:email> <client name> | list [member:email] | revoke <id>   (MCP tokens; ADR-0063)");
    console.error("       npm run queue -- cure-foreign <owner/repo> on|off");
    console.error("       npm run queue -- review-gate <owner/repo> on|off   (workers open drafts; bounded pr-review rounds; ADR-0065)");
    console.error("       npm run queue -- seed-testing-gap <owner/repo>");
    console.error("       npm run queue -- seed-dogfood <owner/repo> [--cooldown-hours <n>]");
    console.error("       npm run queue -- seed-dogfood --enrolled [--cooldown-hours <n>]   (requires SNOWCAT_CONTROL_DB)");
    console.error("       npm run queue -- import-issues <owner/repo> --label <label> [--priority <n>]");
    console.error("       npm run queue -- import-issues --enrolled --label <label> [--priority <n>]   (requires SNOWCAT_CONTROL_DB; SNOWCAT_GITHUB_TOKEN in practice)");
    console.error("       npm run queue -- approve <work-item-id> [--if-updated-at <iso>]");
    console.error("       npm run queue -- reject <work-item-id> <reason> [--if-updated-at <iso>]");
    console.error("       npm run queue -- defer <work-item-id> <reason> [--if-updated-at <iso>]");
    console.error("       npm run queue -- requeue <work-item-id> <reason> [--if-updated-at <iso>]");
    console.error("       npm run queue -- cancel <work-item-id> <reason> [--if-updated-at <iso>]");
    console.error("       npm run queue -- prioritize <work-item-id> <priority> <reason> [--if-updated-at <iso>]");
    console.error("       npm run queue -- note <work-item-id> <text> [--if-updated-at <iso>]");
    console.error("       npm run queue -- attach-artifact <work-item-id> <url> [--kind pull-request|issue|release] [--description <text>] [--if-updated-at <iso>]");
    console.error("       npm run queue -- list [proposed|queued|claimed|completed|blocked|cancelled] [--repository <owner/repo>] [--kind <kind>] [--limit <1-100>]");
    console.error("       npm run queue -- show <work-item-id>");
    console.error("       npm run queue -- events [--since <sequence>] [--repository <owner/repo>] [--limit <1-500>]");
    console.error("       npm run queue -- watch [--repository <owner/repo>] [--interval <seconds>]");
    console.error("       npm run queue -- metrics [--repository <owner/repo>] [--since <iso>] [--until <iso>]   (read-only PRD baseline; default window the last 24 hours)");
    console.error("       npm run queue -- sweep-dependencies <owner/repo>");
    console.error("       npm run queue -- sweep-dependencies --enrolled   (requires SNOWCAT_CONTROL_DB; SNOWCAT_GITHUB_TOKEN in practice)");
    console.error("       npm run queue -- sweep-repository-settings <owner/repo> | --enrolled   (requires SNOWCAT_CONTROL_DB; SNOWCAT_GITHUB_TOKEN with admin read)");
    console.error("       npm run queue -- verify-artifacts [--repository <owner/repo>] [--limit <1-100>] [--no-cure] [--no-review]");
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
  if (value === "pull-request" || value === "issue" || value === "release") return value;
  throw new Error(`--kind must be pull-request, issue, or release: ${value}`);
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
