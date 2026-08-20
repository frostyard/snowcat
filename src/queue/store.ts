import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  allowedActions,
  deriveDelivery,
  MAX_REVIEW_ADVISORIES,
  MAX_REVIEW_BLOCKERS,
  MODEL_NAME_PATTERN,
  PREDECESSOR_URL_PATTERN,
  pullRequestDecays,
  RELEASE_TAG_PATTERN,
  reviewDecisions,
  workStatuses,
  type AllowedAction,
  type ArtifactVerification,
  type ClaimInput,
  type CompletionInput,
  type FollowUpInput,
  type LabeledIssueObservationOutcome,
  type LabeledIssueObservations,
  type ObservedWorkEvent,
  type OperatorNote,
  type CureRootInput,
  type ProposedRootInput,
  type PullRequestCure,
  type PullRequestReview,
  type ReviewAdvisory,
  type ReviewBlocker,
  type ReviewResult,
  type ReviewRootInput,
  type SeedWorkInput,
  type UnreportedPullRequest,
  type UnreportedPullRequestObservation,
  type WorkArtifact,
  type WorkEvent,
  type WorkItem,
  type WorkResult,
  type WorkStatus,
} from "./types.ts";

type Row = Record<string, SQLInputValue>;

const DEFAULT_LEASE_SECONDS = 15 * 60;
export const MAX_LEASE_SECONDS = 60 * 60;
const MAX_FOLLOW_UPS = 10;
const MAX_LINEAGE_DEPTH = 4;
const BUSY_TIMEOUT_MS = 5000;
const MAX_SOURCE_REF_LENGTH = 512;
const DEFAULT_EVENTS_SINCE_LIMIT = 100;
const MAX_EVENTS_SINCE_LIMIT = 500;
const MAX_OPERATOR_NOTE_LENGTH = 4000;
const MAX_LABELED_ISSUE_OBSERVATIONS = 500;
/** Predecessor source references one work item may declare (ADR-0066). */
const MAX_PREDECESSORS = 20;
/** Ledger events the metrics window reads; no other event bears on the reported numbers. */
const METRICS_EVENT_TYPES = ["work.claimed", "work.completed", "work.blocked", "work.cancelled"] as const;
/** Events one metrics window may carry before it is refused instead of aggregated. */
export const MAX_METRICS_WINDOW_EVENTS = 100_000;

/**
 * Schema version recorded in SQLite `PRAGMA user_version`. It equals the length
 * of the migration ladder below: rung N upgrades a database from version N-1
 * to N. A process running older code refuses to keep writing to a database
 * that newer code has already migrated; newer code upgrades an older database
 * in place, forward only, inside one write transaction.
 */
export const SCHEMA_VERSION = 12;

/**
 * Backup manifest emitted by `QueueStore.backup` and re-derived by
 * `QueueStore.inspectBackup`. `databaseId` is the queue's lineage identity
 * (rung 2); a manifest whose identity differs from the live database was not
 * taken from it.
 */
export interface QueueBackupManifest {
  formatVersion: 1;
  backupPath: string;
  databaseId: string;
  schemaVersion: number;
  lastEventSequence: number;
  workItems: number;
  workEvents: number;
  sha256: string;
  createdAt: string;
}

export interface QueueMetadata {
  databasePath: string;
  databaseId: string;
  schemaVersion: number;
  createdAt: string;
  workItems: number;
  workEvents: number;
  lastEventSequence: number;
}

/**
 * Principal namespaces written only by Snowcat itself (operator CLI, feeders,
 * lease expiry). Worker identities may not use them, so createdBy and event
 * actors cannot be spoofed to look operator- or system-authored.
 */
/**
 * Namespaces a worker may not claim for itself. `member:` is the identity a
 * transport establishes for a person (Access JWT) or a person's minted MCP
 * token (ADR-0063); a payload-supplied `member:` is a forgery attempt.
 */
export const RESERVED_PRINCIPAL_PREFIXES = ["operator:", "policy:", "system:", "member:"] as const;

/**
 * Principals allowed to decide about work: the operator CLI, the operator
 * surface, and approved policy. Admission (`approve`, `reject`), blocked
 * exits (`requeue`, `cancel`), `defer`, `prioritize`, and `note` are all
 * operator authority and MUST NOT be forgeable by a worker, so `system:` and
 * every worker namespace are rejected here (spec rule 37).
 */
export function validateOperatorActor(actor: string, purpose: string): string {
  const identity = actor.trim();
  if (!identity) throw new Error(`${purpose} actor is required`);
  const lowered = identity.toLowerCase();
  if (!lowered.startsWith("operator:") && !lowered.startsWith("policy:") && !lowered.startsWith("member:")) {
    throw new Error(`${purpose} actor "${identity}" must use the operator:, policy:, or member: principal namespace`);
  }
  return identity;
}

/** A verified person: `member:<email or login>` — set only by a transport, never by a payload. */
export function validateMemberPrincipal(principal: string, purpose: string): string {
  const identity = principal.trim();
  if (!/^member:[^\s:]{1,254}$/i.test(identity)) throw new Error(`${purpose} must be a member: principal`);
  return identity;
}

export interface McpTokenRecord {
  id: string;
  owner: string;
  client: string;
  /** Empty in listings; present internally for verification only. */
  tokenHash: string;
  createdAt: string;
  /**
   * The work kinds this token may claim (schema rung 9). Absent means
   * unrestricted — exactly how every token minted before the rung behaves.
   * It narrows `claim_work` only; a restricted token still heartbeats,
   * completes, blocks, and releases whatever it already holds.
   */
  kinds?: string[];
  lastUsedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
}

/** The work-kind shape every seed, follow-up, and token restriction shares. */
export const WORK_KIND_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * Validates a claim restriction: every entry must be a work kind, and the
 * result is sorted and de-duplicated so a restriction has one stored shape.
 * An empty list is refused rather than read as "unrestricted": a token that
 * may claim nothing is a mistake, and `NULL` already means unrestricted.
 */
export function validateWorkKinds(kinds: readonly string[], purpose: string): string[] {
  const trimmed = kinds.map((kind) => kind.trim());
  for (const kind of trimmed) {
    if (!WORK_KIND_PATTERN.test(kind)) throw new Error(`${purpose}: invalid work kind: ${kind}`);
  }
  const unique = [...new Set(trimmed)].sort();
  if (unique.length === 0) throw new Error(`${purpose}: at least one work kind is required`);
  return unique;
}

function decodeMcpToken(row: Row): McpTokenRecord {
  return {
    id: String(row.id),
    owner: String(row.owner),
    client: String(row.client),
    tokenHash: String(row.token_hash),
    createdAt: String(row.created_at),
    ...(row.kinds_json == null ? {} : { kinds: JSON.parse(String(row.kinds_json)) as string[] }),
    ...(row.last_used_at == null ? {} : { lastUsedAt: String(row.last_used_at) }),
    ...(row.revoked_at == null ? {} : { revokedAt: String(row.revoked_at) }),
    ...(row.revoked_by == null ? {} : { revokedBy: String(row.revoked_by) }),
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The payload-facing rule: a worker may not name itself into any reserved
 * namespace, `member:` included — that one is set by the transport from a
 * verified token (ADR-0063), never accepted from a request body.
 */
export function validateWorkerIdentity(worker: string): string {
  const identity = worker.trim();
  if (!identity) throw new Error("worker is required");
  const lowered = identity.toLowerCase();
  if (lowered === "system" || RESERVED_PRINCIPAL_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
    throw new Error(
      `worker identity "${identity}" uses a reserved principal namespace (${RESERVED_PRINCIPAL_PREFIXES.join(", ")}, system)`,
    );
  }
  return identity;
}

/**
 * The store-facing rule: any worker principal except the operator, policy,
 * and system namespaces. `member:` is admitted here because only code that
 * verified a token or a session can construct it.
 */
export function validateWorkerPrincipal(worker: string): string {
  const identity = worker.trim();
  if (!identity) throw new Error("worker is required");
  const lowered = identity.toLowerCase();
  if (lowered === "system" || ["operator:", "policy:", "system:"].some((prefix) => lowered.startsWith(prefix))) {
    throw new Error(`worker identity "${identity}" uses a reserved principal namespace (operator:, policy:, system:)`);
  }
  return identity;
}

/**
 * The item state an operator observed before deciding. An operator mutation
 * that carries one is refused when the item's logical `status` or `updatedAt`
 * no longer matches, so intent formed against a stale render is never applied
 * to an item a worker or another shell has since moved (ADR-0035, ADR-0060).
 */
export interface MutationPrecondition {
  status: WorkStatus;
  updatedAt: string;
}

/**
 * Thrown by an operator mutation whose precondition no longer holds. Callers
 * can render the item's current `status` and `updatedAt` instead of a generic
 * failure. Nothing has been changed and no event has been recorded.
 */
export class PreconditionMismatchError extends Error {
  constructor(
    readonly id: string,
    readonly status: WorkStatus,
    readonly updatedAt: string,
  ) {
    super(`item changed since it was read: ${id} is now ${status} (updated ${updatedAt})`);
    this.name = "PreconditionMismatchError";
  }
}

/**
 * Decides whether a repository's admitted work may be claimed right now, on
 * top of the queue's own opt-in. The control-plane store supplies one that
 * requires `enrolled` (which already excludes operator holds); without a
 * hook, opt-in alone governs. A hook that throws fails the claim closed.
 */
export type ClaimEligibility = (repository: string) => boolean;

export interface QueueStoreOptions {
  claimEligibility?: ClaimEligibility;
}

/**
 * One group of items created inside a metrics window: how many items the
 * window created in `repository` that hold `status` now. The status is the
 * item's logical status as of the read, not its status at creation.
 */
export interface QueueMetricsCreatedRow {
  repository: string;
  status: WorkStatus;
  count: number;
}

/**
 * One lifecycle event inside a metrics window, joined with its item's
 * repository and — for a completion — the item's current result, so delivery
 * and merge times are read from what the item says now.
 */
export interface QueueMetricsEventRow {
  type: string;
  repository: string;
  workItemId: string;
  occurredAt: string;
  result?: WorkResult;
}

/**
 * The bounded read `QueueStore.metricsWindow` returns. It carries rows, not
 * metrics: the field definitions live in `src/queue/metrics.ts`.
 */
export interface QueueMetricsWindow {
  since: string;
  until: string;
  repository?: string;
  created: QueueMetricsCreatedRow[];
  events: QueueMetricsEventRow[];
}

export function queueDatabasePath(): string {
  const configured = process.env.SNOWCAT_QUEUE_DB;
  if (configured === ":memory:") return configured;
  return resolve(configured ?? "./data/queue.db");
}

export class QueueStore {
  private readonly db: DatabaseSync;
  private readonly databasePath: string;

  private readonly claimEligibility: ClaimEligibility | undefined;

  constructor(
    path: string,
    private readonly clock: () => Date = () => new Date(),
    options: QueueStoreOptions = {},
  ) {
    this.claimEligibility = options.claimEligibility;
    this.databasePath = path === ":memory:" ? path : resolve(path);
    if (path !== ":memory:") mkdirSync(dirname(this.databasePath), { recursive: true });
    // Install the busy handler while SQLite opens the connection. Setting it
    // later with PRAGMA leaves journal-mode negotiation and startup reads able
    // to fail immediately when another process is closing a write transaction.
    this.db = new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
    const journalMode = this.db.prepare("PRAGMA journal_mode").get() as Row | undefined;
    if (String(journalMode?.journal_mode).toLowerCase() !== "wal") {
      this.db.exec("PRAGMA journal_mode = WAL");
    }
    this.db.exec("PRAGMA foreign_keys = ON");
    // Each MCP server process and CLI invocation opens its own connection to the
    // shared queue file, so brief write contention is normal; wait for the lock
    // instead of failing immediately with SQLITE_BUSY.
    this.assertSupportedSchemaVersion();
    this.migrate();
  }

  schemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as Row | undefined;
    return Number(row?.user_version ?? 0);
  }

  close(): void {
    this.db.close();
  }

  metadata(): QueueMetadata {
    const rows = this.db.prepare("SELECT key, value FROM queue_metadata").all() as Row[];
    const values = new Map(rows.map((row) => [String(row.key), String(row.value)]));
    const databaseId = values.get("database_id");
    const createdAt = values.get("created_at");
    if (!databaseId || !createdAt) throw new Error("queue metadata is incomplete; the database was not migrated");
    return {
      databasePath: this.databasePath,
      databaseId,
      schemaVersion: this.schemaVersion(),
      createdAt,
      ...countRows(this.db),
    };
  }

  /**
   * Copies the live database to a new file with `VACUUM INTO`, a consistent
   * snapshot taken on this connection without touching the WAL, then re-opens
   * the copy read-only and verifies it before returning its manifest. The copy
   * contains lease tokens: store it with the same access controls as the live
   * database. Restore is an operator file operation; this store never
   * overwrites a live path. Verify a backup before opening it with
   * `QueueStore`, because opening switches the copy to WAL mode and changes
   * its bytes.
   */
  backup(path: string): QueueBackupManifest {
    if (path === ":memory:") throw new Error("backup path must be a filesystem path");
    const backupPath = resolve(path);
    if (backupPath === this.databasePath) throw new Error("backup path must differ from the live database path");
    if (existsSync(backupPath)) throw new Error(`backup path already exists: ${backupPath}`);
    const before = this.metadata();
    const createdAt = this.now();
    mkdirSync(dirname(backupPath), { recursive: true });
    reserveBackupPath(backupPath);
    this.db.prepare("VACUUM INTO ?").run(backupPath);
    const manifest = QueueStore.inspectBackup(backupPath, createdAt);
    if (manifest.databaseId !== before.databaseId) {
      throw new Error("completed backup does not carry the live database identity");
    }
    if (manifest.schemaVersion !== before.schemaVersion) {
      throw new Error("completed backup does not carry the live schema version");
    }
    if (manifest.lastEventSequence < before.lastEventSequence) {
      throw new Error("completed backup is older than the live event ledger");
    }
    return manifest;
  }

  /**
   * Opens a backup read-only, runs `PRAGMA quick_check`, and derives the
   * manifest a fresh backup would have produced. Compare `databaseId`,
   * `schemaVersion`, `lastEventSequence`, and `sha256` against the manifest
   * saved at backup time before restoring.
   */
  static inspectBackup(path: string, createdAt?: string): QueueBackupManifest {
    const backupPath = resolve(path);
    if (!existsSync(backupPath)) throw new Error(`backup file does not exist: ${backupPath}`);
    const db = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const check = db.prepare("PRAGMA quick_check").all() as Row[];
      if (check.length !== 1 || String(check[0]?.quick_check) !== "ok") {
        throw new Error(`backup failed quick_check: ${check.map((row) => String(row.quick_check)).join("; ")}`);
      }
      const schemaVersion = Number((db.prepare("PRAGMA user_version").get() as Row).user_version);
      if (schemaVersion !== SCHEMA_VERSION) {
        throw new Error(`backup schema version ${schemaVersion} does not match the supported version ${SCHEMA_VERSION}`);
      }
      const row = db.prepare("SELECT value FROM queue_metadata WHERE key = 'database_id'").get() as Row | undefined;
      const databaseId = row ? String(row.value) : "";
      if (!databaseId) throw new Error("backup carries no database identity");
      return {
        formatVersion: 1,
        backupPath,
        databaseId,
        schemaVersion,
        ...countRows(db),
        sha256: createHash("sha256").update(readFileSync(backupPath)).digest("hex"),
        createdAt: createdAt ?? new Date().toISOString(),
      };
    } finally {
      db.close();
    }
  }

  /** Slugs of every repository currently opted in, in slug order. */
  enabledRepositories(): string[] {
    const rows = this.db.prepare("SELECT slug FROM repositories WHERE enabled = 1 ORDER BY slug").all() as Row[];
    return rows.map((row) => String(row.slug));
  }

  setRepositoryEnabled(repository: string, enabled: boolean): void {
    validateRepository(repository);
    this.transaction(() => {
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO repositories (slug, enabled, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(slug) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
        )
        .run(repository, enabled ? 1 : 0, now, now);
    });
  }

  /**
   * The pull-request cure setting of every opted-in repository, in slug order:
   * `cureForeign` says whether the cure sweep also lists and inspects open
   * pull requests no Snowcat item reported (ADR-0061's per-repository opt-in).
   */
  /**
   * Renames a repository slug in place — the opt-in row and every work item
   * that carries it — after the repository was renamed on GitHub (its
   * immutable ID and Core enrollment continue under the new name). History
   * is not rewritten: `sourceRef`s, results, and events keep the strings they
   * were recorded with. Attributed operator command; refuses an unknown old
   * slug, an existing new slug, or a rename to the same slug.
   */
  renameRepository(from: string, to: string, actor: string): { from: string; to: string; items: number } {
    validateRepository(from);
    validateRepository(to);
    validateOperatorActor(actor, "repository rename");
    if (from.toLowerCase() === to.toLowerCase()) throw new Error("repository rename needs a different slug");
    return this.transaction(() => {
      const row = this.db.prepare("SELECT slug, enabled, cure_foreign, review_gate, created_at FROM repositories WHERE slug = ?").get(from) as Row | undefined;
      if (!row) throw new Error(`repository is not known to the queue: ${from}`);
      if (this.db.prepare("SELECT 1 AS present FROM repositories WHERE slug = ?").get(to)) throw new Error(`repository already exists: ${to}`);
      const now = this.now();
      this.db
        .prepare("INSERT INTO repositories (slug, enabled, cure_foreign, review_gate, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(to, Number(row.enabled), Number(row.cure_foreign), Number(row.review_gate), String(row.created_at), now);
      const updated = this.db.prepare("UPDATE work_items SET repository = ? WHERE repository = ?").run(to, from);
      this.db.prepare("DELETE FROM repositories WHERE slug = ?").run(from);
      return { from, to, items: Number(updated.changes) };
    });
  }

  /**
   * Mints one MCP token for a member (ADR-0063). The plaintext is returned
   * exactly once and never stored: the row keeps `sha256(secret)`, the owner
   * (a `member:` principal — the verified person), and the client name the
   * person gave the process that will hold it. Token format:
   * `snowcat_<id>_<secret>`.
   */
  mintMcpToken(input: { owner: string; client: string; kinds?: string[] }): { token: string; record: McpTokenRecord } {
    const owner = validateMemberPrincipal(input.owner, "token owner");
    const client = input.client.trim();
    if (!client || client.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9 ._:@/-]*$/.test(client)) {
      throw new Error("token client must be a short human-readable name (letters, digits, space, . _ : @ / -)");
    }
    // Rung 9: an optional claim restriction, stored sorted and unique, or
    // NULL for an unrestricted token. It narrows what the token may claim and
    // can never widen it.
    const kinds = input.kinds === undefined ? undefined : validateWorkKinds(input.kinds, "token kinds");
    const id = randomBytes(8).toString("hex");
    const secret = randomBytes(24).toString("base64url");
    const token = `snowcat_${id}_${secret}`;
    const now = this.now();
    this.db
      .prepare("INSERT INTO mcp_tokens (id, owner, client, token_hash, created_at, kinds_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, owner, client, sha256Hex(secret), now, kinds === undefined ? null : JSON.stringify(kinds));
    return { token, record: this.mcpToken(id)! };
  }

  /**
   * Resolves a presented token to its record when it exists and is not
   * revoked; touches `last_used_at` at most once a minute. Anything else —
   * malformed, unknown, revoked, hash mismatch — is `undefined`, never a
   * reason.
   */
  verifyMcpToken(presented: string): McpTokenRecord | undefined {
    const match = /^snowcat_([0-9a-f]{16})_([A-Za-z0-9_-]{20,})$/.exec(presented.trim());
    if (!match) return undefined;
    const record = this.mcpToken(match[1]!);
    if (!record || record.revokedAt) return undefined;
    const expected = Buffer.from(record.tokenHash, "hex");
    const actual = Buffer.from(sha256Hex(match[2]!), "hex");
    if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) return undefined;
    const now = this.now();
    if (!record.lastUsedAt || new Date(now).getTime() - new Date(record.lastUsedAt).getTime() > 60_000) {
      this.db.prepare("UPDATE mcp_tokens SET last_used_at = ? WHERE id = ?").run(now, record.id);
      record.lastUsedAt = now;
    }
    return record;
  }

  /** Revokes one token; a member may revoke only their own, an operator any. Idempotent. */
  revokeMcpToken(id: string, actor: string): McpTokenRecord {
    const principal = validateOperatorActor(actor, "token revocation");
    return this.transaction(() => {
      const record = this.mcpToken(id);
      if (!record) throw new Error(`token not found: ${id}`);
      if (principal.toLowerCase().startsWith("member:") && principal.toLowerCase() !== record.owner.toLowerCase()) {
        throw new Error(`token ${id} belongs to ${record.owner}`);
      }
      if (record.revokedAt) return record;
      const now = this.now();
      this.db.prepare("UPDATE mcp_tokens SET revoked_at = ?, revoked_by = ? WHERE id = ?").run(now, principal, id);
      return this.mcpToken(id)!;
    });
  }

  /** Tokens, newest first; optionally one owner's. Hashes are never returned. */
  listMcpTokens(owner?: string): McpTokenRecord[] {
    const rows = owner
      ? (this.db.prepare("SELECT * FROM mcp_tokens WHERE owner = ? ORDER BY created_at DESC").all(owner) as Row[])
      : (this.db.prepare("SELECT * FROM mcp_tokens ORDER BY created_at DESC").all() as Row[]);
    return rows.map(decodeMcpToken).map(({ tokenHash: _hash, ...visible }) => ({ ...visible, tokenHash: "" }));
  }

  private mcpToken(id: string): McpTokenRecord | undefined {
    const row = this.db.prepare("SELECT * FROM mcp_tokens WHERE id = ?").get(id) as Row | undefined;
    return row ? decodeMcpToken(row) : undefined;
  }

  repositoryCureSettings(): Array<{ repository: string; cureForeign: boolean }> {
    const rows = this.db.prepare("SELECT slug, cure_foreign FROM repositories WHERE enabled = 1 ORDER BY slug").all() as Row[];
    return rows.map((row) => ({ repository: String(row.slug), cureForeign: Number(row.cure_foreign) === 1 }));
  }

  /** Turns foreign pull-request cure on or off for one opted-in repository. */
  setRepositoryCureForeign(repository: string, enabled: boolean): void {
    this.transaction(() => {
      this.assertRepositoryEnabled(repository);
      this.db
        .prepare("UPDATE repositories SET cure_foreign = ?, updated_at = ? WHERE slug = ?")
        .run(enabled ? 1 : 0, this.now(), repository);
    });
  }

  /**
   * The review-gate setting of every opted-in repository, in slug order
   * (ADR-0065): with `reviewGate` on, workers open pull requests as drafts
   * and the verification pass creates bounded `pr-review` rounds for them.
   */
  repositoryReviewGateSettings(): Array<{ repository: string; reviewGate: boolean }> {
    const rows = this.db.prepare("SELECT slug, review_gate FROM repositories WHERE enabled = 1 ORDER BY slug").all() as Row[];
    return rows.map((row) => ({ repository: String(row.slug), reviewGate: Number(row.review_gate) === 1 }));
  }

  /** Whether the review gate is on for an opted-in repository; off for unknown or disabled ones. */
  reviewGateEnabled(repository: string): boolean {
    validateRepository(repository);
    const row = this.db.prepare("SELECT review_gate FROM repositories WHERE slug = ? AND enabled = 1").get(repository) as Row | undefined;
    return row !== undefined && Number(row.review_gate) === 1;
  }

  /** Turns the review gate on or off for one opted-in repository. */
  setRepositoryReviewGate(repository: string, enabled: boolean): void {
    this.transaction(() => {
      this.assertRepositoryEnabled(repository);
      this.db
        .prepare("UPDATE repositories SET review_gate = ?, updated_at = ? WHERE slug = ?")
        .run(enabled ? 1 : 0, this.now(), repository);
    });
  }

  /**
   * Records the review sweep's whole unreported-pull-request finding for one
   * opted-in repository (ADR-0065, schema rung 10): the open pull requests
   * GitHub listed that no completed item reported and no `pr-review`,
   * `pr-review-fix`, or `pr-cure` item is bound to. Each pass overwrites the
   * previous observation — an empty list included, so a closed or attached
   * orphan disappears — and nothing else changes: no work item, no event, no
   * artifact. Policy or operator actors only.
   */
  recordUnreportedPullRequests(repository: string, observation: UnreportedPullRequestObservation, actor: string): void {
    validateOperatorActor(actor, "unreported pull requests");
    const pullRequests = observation.pullRequests.map((pull) => {
      if (!/^https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/[1-9][0-9]*$/.test(pull.url)) {
        throw new Error(`unreported pull request URL is not a GitHub pull-request URL: ${pull.url}`);
      }
      if (!Number.isSafeInteger(pull.number) || pull.number < 1) throw new Error(`unreported pull request number is invalid: ${pull.number}`);
      return {
        url: pull.url,
        number: pull.number,
        draft: pull.draft === true,
        ...(pull.createdAt ? { createdAt: pull.createdAt } : {}),
      } satisfies UnreportedPullRequest;
    });
    this.transaction(() => {
      this.assertRepositoryEnabled(repository);
      this.db
        .prepare("UPDATE repositories SET unreported_pull_requests_json = ?, updated_at = ? WHERE slug = ?")
        .run(JSON.stringify({ observedAt: observation.observedAt, pullRequests }), this.now(), repository);
    });
  }

  /** The last unreported-pull-request observation for a repository, or `undefined` when no sweep has observed it yet. */
  repositoryUnreportedPullRequests(repository: string): UnreportedPullRequestObservation | undefined {
    validateRepository(repository);
    const row = this.db.prepare("SELECT unreported_pull_requests_json FROM repositories WHERE slug = ?").get(repository) as Row | undefined;
    const raw = row?.unreported_pull_requests_json;
    if (typeof raw !== "string") return undefined;
    const parsed = JSON.parse(raw) as UnreportedPullRequestObservation;
    return { observedAt: String(parsed.observedAt), pullRequests: parsed.pullRequests ?? [] };
  }

  /**
   * Replaces the latest labeled-issue observations for one opted-in repository.
   * The write is bounded to 500 entries and records one shared transaction time
   * as each issue's `seenAt`; it creates no work or event.
   */
  recordLabeledIssueObservations(
    repository: string,
    issues: ReadonlyArray<{ url: string; title: string; outcome: LabeledIssueObservationOutcome }>,
    actor: string,
  ): LabeledIssueObservations {
    validateOperatorActor(actor, "labeled issue observations");
    const validated = issues.map((issue) => {
      const match = /^https:\/\/github\.com\/([^\s/]+)\/([^\s/]+)\/issues\/[1-9][0-9]*$/.exec(issue.url);
      if (!match || `${match[1]}/${match[2]}`.toLowerCase() !== repository.toLowerCase()) {
        throw new Error(`labeled issue URL is not a GitHub issue URL: ${issue.url}`);
      }
      if (!issue.title.trim()) throw new Error("labeled issue title is required");
      if (issue.outcome !== "created" && issue.outcome !== "existing") {
        throw new Error(`invalid labeled issue outcome: ${String(issue.outcome)}`);
      }
      return { url: issue.url, title: issue.title.trim(), outcome: issue.outcome };
    });
    return this.transaction(() => {
      this.assertRepositoryEnabled(repository);
      const seenAt = this.now();
      const observation: LabeledIssueObservations = {
        issues: validated.slice(0, MAX_LABELED_ISSUE_OBSERVATIONS).map((issue) => ({ ...issue, seenAt })),
        truncated: validated.length > MAX_LABELED_ISSUE_OBSERVATIONS,
      };
      this.db
        .prepare("UPDATE repositories SET labeled_issue_observations_json = ?, updated_at = ? WHERE slug = ?")
        .run(JSON.stringify(observation), seenAt, repository);
      return observation;
    });
  }

  /** The latest successful labeled-issue import observation, or `undefined` before the first one. */
  repositoryLabeledIssueObservations(repository: string): LabeledIssueObservations | undefined {
    validateRepository(repository);
    const row = this.db.prepare("SELECT labeled_issue_observations_json FROM repositories WHERE slug = ?").get(repository) as Row | undefined;
    const raw = row?.labeled_issue_observations_json;
    if (typeof raw !== "string") return undefined;
    const parsed = JSON.parse(raw) as LabeledIssueObservations;
    return { issues: parsed.issues ?? [], truncated: parsed.truncated === true };
  }

  /**
   * Every pull-request URL in a repository the queue can already account for,
   * lowercased: one a completed item reported as an artifact — any kind, any
   * verification state, `pr-review` and `pr-review-fix` rounds included — and
   * one a `pr-review`, `pr-review-fix`, or `pr-cure` item is bound to,
   * whatever its status. Uncapped, so a large queue cannot make a known pull
   * request look unreported. The complement of this set within GitHub's open
   * listing is what the review gate reports as unreported.
   */
  knownPullRequestUrls(repository: string): string[] {
    validateRepository(repository);
    const rows = this.db
      .prepare(
        `SELECT lower(json_extract(artifact.value, '$.url')) AS url
           FROM work_items item, json_each(item.result_json, '$.artifacts') artifact
          WHERE item.repository = ? AND item.status = 'completed' AND item.result_json IS NOT NULL
            AND json_extract(artifact.value, '$.kind') = 'pull-request'
          UNION
         SELECT lower(json_extract(review_json, '$.pullRequestUrl')) AS url
           FROM work_items WHERE repository = ? AND review_json IS NOT NULL
          UNION
         SELECT lower(json_extract(cure_json, '$.pullRequestUrl')) AS url
           FROM work_items WHERE repository = ? AND cure_json IS NOT NULL`,
      )
      .all(repository, repository, repository) as Row[];
    return rows.map((row) => String(row.url)).filter((url) => url !== "null" && url.length > 0);
  }

  enqueueSeed(input: SeedWorkInput): WorkItem {
    validateWorkDefinition(input);
    assertNoPredecessors(input, "a seed root");
    return this.transaction(() => {
      this.assertRepositoryEnabled(input.repository);
      const id = randomUUID();
      const now = this.now();
      this.insertWork({ ...input, id, rootId: id, priority: input.priority ?? 0, admitted: true, createdAt: now });
      this.addEvent(id, "work.queued", input.createdBy, { root: true });
      return this.getRequired(id);
    });
  }

  /**
   * Creates the candidate roots whose kind has no active lineage in the
   * repository. A candidate's `cooldownSeconds` (or `options.cooldownSeconds`,
   * which overrides every candidate's) is its no-finding cooldown: a kind whose
   * most recent root completed within that window without proposing any child
   * (a no-finding assessment) is skipped and reported in `cooledKinds`, so a
   * repeating feeder does not re-ask a question that was just answered
   * "nothing to do".
   */
  enqueueInactiveRootBatch(
    repository: string,
    candidates: Array<Omit<SeedWorkInput, "repository"> & { cooldownSeconds?: number }>,
    options: { cooldownSeconds?: number } = {},
  ): { created: WorkItem[]; skippedKinds: string[]; cooledKinds: string[] } {
    validateRepository(repository);
    const cooldownOf = (candidate: { cooldownSeconds?: number }): number => {
      const cooldownSeconds = options.cooldownSeconds ?? candidate.cooldownSeconds ?? 0;
      if (!Number.isSafeInteger(cooldownSeconds) || cooldownSeconds < 0) {
        throw new Error("cooldownSeconds must be a non-negative safe integer");
      }
      return cooldownSeconds;
    };
    const cooldowns = candidates.map(cooldownOf);
    return this.transaction(() => {
      this.assertRepositoryEnabled(repository);
      const activeKinds = new Set(this.activeRootKinds(repository));
      const noFindingAt = cooldowns.some((seconds) => seconds > 0) ? this.latestNoFindingRoots(repository) : new Map<string, string>();
      const created: WorkItem[] = [];
      const skippedKinds: string[] = [];
      const cooledKinds: string[] = [];

      candidates.forEach((candidate, index) => {
        const { cooldownSeconds: _cooldownSeconds, ...definition } = candidate;
        const input: SeedWorkInput = { ...definition, repository };
        validateWorkDefinition(input);
        assertNoPredecessors(input, "a seed root");
        if (activeKinds.has(input.kind)) {
          skippedKinds.push(input.kind);
          return;
        }
        const completedAt = noFindingAt.get(input.kind);
        const cooldownSeconds = cooldowns[index]!;
        if (completedAt !== undefined && cooldownSeconds > 0 && new Date(completedAt).getTime() >= this.clock().getTime() - cooldownSeconds * 1000) {
          cooledKinds.push(input.kind);
          return;
        }

        const id = randomUUID();
        const now = this.now();
        this.insertWork({ ...input, id, rootId: id, priority: input.priority ?? 0, admitted: true, createdAt: now });
        this.addEvent(id, "work.queued", input.createdBy, { root: true });
        created.push(this.getRequired(id));
        activeKinds.add(input.kind);
      });
      return { created, skippedKinds, cooledKinds };
    });
  }

  /**
   * Creates one admitted `pr-cure` root for a pull-request head (ADR-0061),
   * keyed by `sourceRef` (`<pull-request URL>@<head SHA>`); the same head is
   * never enqueued twice, whatever the earlier item's status became, so this
   * returns `undefined` when the head is already known. Admitted on creation
   * because a mechanical cure never changes the patch; the substantive kind
   * (`pr-cure-change`) is a worker proposal like any other.
   */
  enqueueCureRoot(repository: string, input: CureRootInput): WorkItem | undefined {
    validateRepository(repository);
    validateSourceRef(input.sourceRef);
    validateCure(input.cure);
    if (input.kind !== "pr-cure") throw new Error("a cure root must have kind pr-cure");
    assertNoPredecessors(input, "a cure root");
    const definition: SeedWorkInput = { ...input, repository };
    validateWorkDefinition(definition);
    return this.transaction(() => {
      this.assertRepositoryEnabled(repository);
      if (this.sourceRefExists(repository, input.sourceRef)) return undefined;
      const id = randomUUID();
      const now = this.now();
      this.insertWork({
        ...definition,
        id,
        rootId: id,
        priority: definition.priority ?? 0,
        admitted: true,
        createdAt: now,
        sourceRef: input.sourceRef,
        cure: input.cure,
      });
      this.addEvent(id, "work.queued", input.createdBy, {
        root: true,
        cure: { pullRequestUrl: input.cure.pullRequestUrl, headSha: input.cure.headSha, decay: input.cure.decay },
      });
      return this.getRequired(id);
    });
  }

  /**
   * Creates one admitted `pr-review` or `pr-review-fix` root (ADR-0065),
   * keyed by `sourceRef` (`pr-review:<url>@<headSha>` or
   * `pr-review-fix:<url>@<headSha>`); the same head and kind are never
   * enqueued twice, whatever the earlier item's status became, so this returns
   * `undefined` when the head is already known. A `pr-review` is read-only
   * (at most `read` and `run-tests`, nothing delegable); a `pr-review-fix`
   * carries exactly `read, write, run-tests, open-pr` and nothing delegable.
   * Both are created by the review sweep under a `policy:` actor, never by a
   * worker.
   */
  enqueueReviewRoot(repository: string, input: ReviewRootInput): WorkItem | undefined {
    validateRepository(repository);
    validateSourceRef(input.sourceRef);
    validateReview(input.review);
    if (input.kind !== "pr-review" && input.kind !== "pr-review-fix") {
      throw new Error("a review root must have kind pr-review or pr-review-fix");
    }
    assertNoPredecessors(input, `a ${input.kind} root`);
    if (input.delegableActions.length > 0) throw new Error(`a ${input.kind} root delegates nothing`);
    if (input.kind === "pr-review") {
      assertSubset(input.allowedActions, ["read", "run-tests"], "pr-review allowedActions");
    } else {
      const expected = ["read", "write", "run-tests", "open-pr"];
      const actual = [...input.allowedActions].sort();
      if (actual.length !== expected.length || actual.some((action, index) => action !== [...expected].sort()[index])) {
        throw new Error("a pr-review-fix root must carry exactly read, write, run-tests, open-pr");
      }
      if (!input.review.reviewItemId) throw new Error("a pr-review-fix root must name the review item it addresses");
    }
    const definition: SeedWorkInput = { ...input, repository };
    validateWorkDefinition(definition);
    return this.transaction(() => {
      this.assertRepositoryEnabled(repository);
      if (this.sourceRefExists(repository, input.sourceRef)) return undefined;
      const id = randomUUID();
      const now = this.now();
      this.insertWork({
        ...definition,
        id,
        rootId: id,
        priority: definition.priority ?? 0,
        admitted: true,
        createdAt: now,
        sourceRef: input.sourceRef,
        review: input.review,
      });
      this.addEvent(id, "work.queued", input.createdBy, {
        root: true,
        review: {
          kind: input.kind,
          pullRequestUrl: input.review.pullRequestUrl,
          headSha: input.review.headSha,
          round: input.review.round,
          ...(input.review.reviewItemId ? { reviewItemId: input.review.reviewItemId } : {}),
          ...(input.kind === "pr-review-fix" ? { fingerprints: (input.review.blockers ?? []).map((blocker) => blocker.fingerprint) } : {}),
        },
      });
      return this.getRequired(id);
    });
  }

  /**
   * Every `pr-review` and `pr-review-fix` item bound to one pull request in a
   * repository, oldest first and uncapped: the review sweep derives the round
   * count, what is in flight, and the latest verdict from this one read.
   */
  pullRequestReviewItems(repository: string, pullRequestUrl: string): WorkItem[] {
    validateRepository(repository);
    const rows = this.db
      .prepare(
        `SELECT * FROM work_items
         WHERE repository = ? AND kind IN ('pr-review', 'pr-review-fix')
           AND lower(json_extract(review_json, '$.pullRequestUrl')) = lower(?)
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(repository, pullRequestUrl) as Row[];
    return rows.map((row) => withDelivery(decodeWorkItem(row)));
  }

  /**
   * Records that Snowcat marked a reviewed draft pull request ready for
   * review (ADR-0065): rewrites the origin item's verification of that
   * artifact without `draft` and records `artifact.ready` naming the head and
   * the review that passed. Policy or operator actors only.
   */
  recordPullRequestReady(id: string, url: string, actor: string, payload: { headSha: string; reviewItemId: string }): WorkItem {
    validateOperatorActor(actor, "ready-for-review");
    return this.transaction(() => {
      const item = this.getRequired(id);
      if (item.status !== "completed" || !item.result) throw new Error(`work item is not completed: ${id}`);
      const index = item.result.artifacts.findIndex((artifact) => artifact.url.toLowerCase() === url.toLowerCase());
      if (index === -1) throw new Error(`work item ${id} has no artifact ${url}`);
      const artifact = item.result.artifacts[index]!;
      if (artifact.kind !== "pull-request") throw new Error(`artifact is not a pull request: ${url}`);
      const artifacts = item.result.artifacts.slice();
      if (artifact.verification?.status === "verified") {
        const { draft: _draft, ...verification } = artifact.verification;
        artifacts[index] = { ...artifact, verification };
      }
      const now = this.now();
      this.db
        .prepare("UPDATE work_items SET result_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ ...item.result, artifacts }), now, id);
      this.addEvent(id, "artifact.ready", actor, { url, headSha: payload.headSha, reviewItemId: payload.reviewItemId });
      return this.getRequired(id);
    });
  }

  /**
   * Creates one `proposed` root per candidate whose `sourceRef` is not already
   * present for the repository, in one transaction. Nothing here is claimable
   * until an operator approves it; repeated imports of the same source create
   * nothing new, whatever the earlier item's status became.
   *
   * A candidate may declare `predecessors` (ADR-0066): the source references it
   * waits for, stored sorted and deduplicated. They are inert here — nothing
   * resolves, gates, or reorders on them in this slice — and this is the only
   * creation path that accepts them.
   */
  enqueueProposedRoots(
    repository: string,
    candidates: ProposedRootInput[],
  ): { created: WorkItem[]; skippedSourceRefs: string[] } {
    validateRepository(repository);
    return this.transaction(() => {
      this.assertRepositoryEnabled(repository);
      const created: WorkItem[] = [];
      const skippedSourceRefs: string[] = [];
      const seen = new Set<string>();
      for (const candidate of candidates) {
        const { sourceRef, predecessors: declared, ...definition } = candidate;
        const input: SeedWorkInput = { ...definition, repository };
        validateWorkDefinition(input);
        validateSourceRef(sourceRef);
        const predecessors = normalizePredecessors(declared);
        if (seen.has(sourceRef) || this.sourceRefExists(repository, sourceRef)) {
          skippedSourceRefs.push(sourceRef);
          continue;
        }
        seen.add(sourceRef);
        const id = randomUUID();
        const now = this.now();
        this.insertWork({
          ...input,
          id,
          rootId: id,
          priority: input.priority ?? 0,
          admitted: false,
          createdAt: now,
          sourceRef,
          ...(predecessors ? { predecessors } : {}),
        });
        this.addEvent(id, "work.proposed", input.createdBy, {
          root: true,
          sourceRef,
          ...(predecessors ? { predecessors } : {}),
        });
        created.push(this.getRequired(id));
      }
      return { created, skippedSourceRefs };
    });
  }

  /**
   * Replaces the predecessors of one still-proposed item (ADR-0066), so a
   * re-import can refresh edges an operator has not admitted yet. It refuses an
   * item that is not queued-unadmitted — admitted, claimed, completed, blocked,
   * or cancelled — because admission is the plan-review moment and nothing may
   * move an edge under work the operator already approved. One write
   * transaction, one `work.predecessors-updated` event, nothing else: no
   * status, priority, admission, or lease change, and no claim effect (gating
   * is slice 3, frostyard/snowcat#161). Operator or policy actors only.
   */
  replaceProposedPredecessors(id: string, predecessors: readonly string[], actor: string): WorkItem {
    validateOperatorActor(actor, "predecessors");
    const replacement = normalizePredecessors(predecessors);
    return this.transaction(() => {
      const item = this.getRequired(id);
      const row = this.db.prepare("SELECT admitted FROM work_items WHERE id = ?").get(id) as Row;
      if (Number(row.admitted) !== 0 || item.status !== "proposed") {
        throw new Error(`work item is not proposed, so its predecessors cannot be replaced: ${id}`);
      }
      const previous = item.predecessors ?? [];
      this.db
        .prepare("UPDATE work_items SET predecessors_json = ?, updated_at = ? WHERE id = ?")
        .run(replacement ? JSON.stringify(replacement) : null, this.now(), id);
      this.addEvent(id, "work.predecessors-updated", actor, { predecessors: replacement ?? [], previous });
      return this.getRequired(id);
    });
  }

  /**
   * The still-`proposed` item carrying one source reference, or `undefined`
   * when the repository has no item for it or that item has moved past
   * proposal. The re-import predecessor refresh (ADR-0066) reads this to decide
   * whether an edge may still be replaced; absence is the answer "not yours to
   * move", not an error. Read-only: it creates, admits, and changes nothing.
   */
  proposedItemBySourceRef(repository: string, sourceRef: string): WorkItem | undefined {
    const row = this.db
      .prepare("SELECT * FROM work_items WHERE repository = ? AND source_ref = ? AND status = 'queued' AND admitted = 0 LIMIT 1")
      .get(repository, sourceRef) as Row | undefined;
    return row ? withDelivery(decodeWorkItem(row)) : undefined;
  }

  get(id: string): WorkItem | undefined {
    const row = this.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as Row | undefined;
    return row ? withDelivery(decodeWorkItem(row)) : undefined;
  }

  /** Direct children of one item, oldest first; empty for a leaf or an unknown id. */
  children(id: string): WorkItem[] {
    const rows = this.db.prepare("SELECT * FROM work_items WHERE parent_id = ? ORDER BY created_at ASC, id ASC").all(id) as Row[];
    return rows.map((row) => withDelivery(decodeWorkItem(row)));
  }

  list(options: { status?: WorkStatus; repository?: string; kind?: string; limit?: number } = {}): WorkItem[] {
    const { clauses, params } = this.filterClauses(options);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM work_items ${where} ORDER BY priority DESC, created_at ASC LIMIT ?`)
      .all(...params, limit) as Row[];
    return rows.map((row) => withDelivery(decodeWorkItem(row)));
  }

  /**
   * The same filters as list(), ordered by `updated_at` DESC (ties by
   * `created_at` DESC) instead of claim order, so the most recently touched
   * items are the ones the limit keeps. list() selects in claim order
   * (priority, then oldest first) and clamps to 100, which starves any reader
   * that cares about recent activity once a status holds more than 100 rows:
   * the progress view reads the terminal statuses this way so that hundreds of
   * old merged completions cannot hide today's work behind the ceiling. Like
   * completedItemsWithPendingArtifacts, the limit is the caller's own ceiling.
   */
  recentlyUpdatedItems(options: { status?: WorkStatus; repository?: string; kind?: string; limit?: number } = {}): WorkItem[] {
    const { clauses, params } = this.filterClauses(options);
    const limit = Math.max(1, Math.floor(options.limit ?? 100));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM work_items ${where} ORDER BY updated_at DESC, created_at DESC, id DESC LIMIT ?`)
      .all(...params, limit) as Row[];
    return rows.map((row) => withDelivery(decodeWorkItem(row)));
  }

  /** The status/repository/kind filter list() and recentlyUpdatedItems() share. */
  private filterClauses(options: { status?: WorkStatus; repository?: string; kind?: string }): { clauses: string[]; params: SQLInputValue[] } {
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    if (options.status === "proposed") {
      clauses.push("status = 'queued' AND admitted = 0");
    } else if (options.status === "queued") {
      clauses.push("status = 'queued' AND admitted = 1");
    } else if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    if (options.repository) {
      validateRepository(options.repository);
      clauses.push("repository = ?");
      params.push(options.repository);
    }
    if (options.kind) {
      clauses.push("kind = ?");
      params.push(options.kind);
    }
    return { clauses, params };
  }

  /**
   * Completed items with at least one issue, pull-request, or release artifact
   * that is not yet terminal — no verification, `verification.status`
   * `unverified`, or `verification.state` `open` (issue, pull request) or
   * `draft` (release: the tag is not published yet) — the predicate the
   * artifact sweeps apply per artifact — newest first by `updated_at`, so `verify-artifacts` and
   * the cure sweep never starve a recent completion behind older, already
   * terminal ones. Unlike list(), the limit bounds items that need checking
   * and is not clamped to 100; the callers own their ceilings.
   *
   * `unverifiedOnly` narrows the predicate to artifacts whose
   * `verification.status` is `unverified` (the operator inbox's "unverified
   * artifacts" group): a verified-but-open pull request is not waiting on
   * the operator, it is waiting on GitHub.
   */
  completedItemsWithPendingArtifacts(options: { repository?: string; limit?: number; unverifiedOnly?: boolean } = {}): WorkItem[] {
    const params: SQLInputValue[] = [];
    let repositoryClause = "";
    if (options.repository) {
      validateRepository(options.repository);
      repositoryClause = "AND repository = ?";
      params.push(options.repository);
    }
    const limit = Math.max(1, Math.floor(options.limit ?? 100));
    const pending = options.unverifiedOnly
      ? `json_extract(artifact.value, '$.verification.status') = 'unverified'`
      : `json_type(artifact.value, '$.verification') IS NULL
                 OR json_extract(artifact.value, '$.verification.status') = 'unverified'
                 OR json_extract(artifact.value, '$.verification.state') IN ('open', 'draft')`;
    const rows = this.db
      .prepare(
        `SELECT * FROM work_items item
         WHERE status = 'completed' AND result_json IS NOT NULL ${repositoryClause}
           AND EXISTS (
             SELECT 1 FROM json_each(item.result_json, '$.artifacts') artifact
             WHERE json_extract(artifact.value, '$.kind') IN ('issue', 'pull-request', 'release')
               AND (
                 ${pending}
               )
           )
         ORDER BY updated_at DESC, created_at DESC LIMIT ?`,
      )
      .all(...params, limit) as Row[];
    return rows.map((row) => withDelivery(decodeWorkItem(row)));
  }

  /**
   * Kinds of every root in `repository` whose lineage still has non-terminal
   * work (proposed, queued, claimed, or blocked). Unlike list(), this is not
   * capped, so feeders can detect active lineages regardless of queue size.
   */
  activeRootKinds(repository: string): string[] {
    validateRepository(repository);
    const rows = this.db
      .prepare(
        `SELECT DISTINCT root.kind AS kind
         FROM work_items item
         JOIN work_items root ON root.id = item.root_id
         WHERE item.repository = ? AND item.status NOT IN ('completed', 'cancelled')
         ORDER BY root.kind`,
      )
      .all(repository) as Row[];
    return rows.map((row) => String(row.kind));
  }

  /**
   * For each kind whose most recent root in the repository is `completed` and
   * proposed no child — the assessment ran and found nothing actionable — the
   * completion time, so a caller can apply its own cooldown window per kind.
   */
  private latestNoFindingRoots(repository: string): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT latest.kind AS kind, latest.updated_at AS updated_at
         FROM work_items latest
         WHERE latest.repository = ? AND latest.parent_id IS NULL
           AND latest.updated_at = (
             SELECT MAX(root.updated_at) FROM work_items root
             WHERE root.repository = latest.repository AND root.parent_id IS NULL AND root.kind = latest.kind
           )
           AND latest.status = 'completed'
           AND NOT EXISTS (SELECT 1 FROM work_items child WHERE child.parent_id = latest.id)
         ORDER BY latest.kind`,
      )
      .all(repository) as Row[];
    return new Map(rows.map((row) => [String(row.kind), String(row.updated_at)]));
  }

  private sourceRefExists(repository: string, sourceRef: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS present FROM work_items WHERE repository = ? AND source_ref = ? LIMIT 1")
      .get(repository, sourceRef) as Row | undefined;
    return row !== undefined;
  }

  /** Items per logical status, across the queue or for one repository. */
  counts(repository?: string): Record<WorkStatus, number> {
    const result = Object.fromEntries(workStatuses.map((status) => [status, 0])) as Record<WorkStatus, number>;
    if (repository !== undefined) validateRepository(repository);
    const rows = this.db
      .prepare(
        `SELECT CASE WHEN status = 'queued' AND admitted = 0 THEN 'proposed' ELSE status END AS logical_status,
                COUNT(*) AS count
         FROM work_items
         ${repository === undefined ? "" : "WHERE repository = ?"}
         GROUP BY logical_status`,
      )
      .all(...(repository === undefined ? [] : [repository])) as Row[];
    for (const row of rows) result[String(row.logical_status) as WorkStatus] = Number(row.count);
    return result;
  }

  /**
   * The bounded read behind `queue -- metrics`: items created in the
   * half-open window `[since, until)` grouped by repository and current
   * logical status, plus every `work.claimed`, `work.completed`,
   * `work.blocked`, and `work.cancelled` event that occurred in it, each
   * joined with its item's repository and — for a completion — the item's
   * current result. It writes nothing and is not exposed through MCP;
   * `src/queue/metrics.ts` turns these rows into the reported numbers. A
   * window carrying more than `MAX_METRICS_WINDOW_EVENTS` events is refused
   * rather than aggregated, so one call can never sweep the whole ledger by
   * accident.
   */
  metricsWindow(options: { since: string; until: string; repository?: string }): QueueMetricsWindow {
    const since = normalizeTimestamp(options.since, "since");
    const until = normalizeTimestamp(options.until, "until");
    if (since >= until) throw new Error(`since must be before until (got ${since} and ${until})`);
    if (options.repository !== undefined) validateRepository(options.repository);
    const repositoryParams: SQLInputValue[] = options.repository === undefined ? [] : [options.repository];
    const createdRows = this.db
      .prepare(
        `SELECT repository,
                CASE WHEN status = 'queued' AND admitted = 0 THEN 'proposed' ELSE status END AS logical_status,
                COUNT(*) AS count
         FROM work_items
         WHERE created_at >= ? AND created_at < ? ${options.repository === undefined ? "" : "AND repository = ?"}
         GROUP BY repository, logical_status
         ORDER BY repository, logical_status`,
      )
      .all(since, until, ...repositoryParams) as Row[];
    const eventRows = this.db
      .prepare(
        `SELECT e.event_type, e.occurred_at, e.work_item_id, w.repository, w.result_json
         FROM work_events e
         JOIN work_items w ON w.id = e.work_item_id
         WHERE e.event_type IN (${METRICS_EVENT_TYPES.map(() => "?").join(", ")})
           AND e.occurred_at >= ? AND e.occurred_at < ?
           ${options.repository === undefined ? "" : "AND w.repository = ?"}
         ORDER BY e.sequence
         LIMIT ?`,
      )
      .all(...METRICS_EVENT_TYPES, since, until, ...repositoryParams, MAX_METRICS_WINDOW_EVENTS + 1) as Row[];
    if (eventRows.length > MAX_METRICS_WINDOW_EVENTS) {
      throw new Error(
        `the metrics window carries more than ${MAX_METRICS_WINDOW_EVENTS} events; narrow it with --since and --until`,
      );
    }
    return {
      since,
      until,
      ...(options.repository === undefined ? {} : { repository: options.repository }),
      created: createdRows.map((row) => ({
        repository: String(row.repository),
        status: String(row.logical_status) as WorkStatus,
        count: Number(row.count),
      })),
      events: eventRows.map((row) => {
        const result = row.result_json == null ? undefined : (JSON.parse(String(row.result_json)) as WorkResult);
        return {
          type: String(row.event_type),
          repository: String(row.repository),
          workItemId: String(row.work_item_id),
          occurredAt: String(row.occurred_at),
          ...(result === undefined ? {} : { result }),
        };
      }),
    };
  }

  claim(input: ClaimInput): WorkItem | undefined {
    const worker = validateWorkerPrincipal(input.worker);
    if (input.repository) validateRepository(input.repository);
    const leaseSeconds = boundedLease(input.leaseSeconds);
    // A credential-carried restriction (a minted token's kinds, or the stdio
    // server's `SNOWCAT_MCP_KINDS`) narrows the caller's own filter and can
    // never widen it: the effective filter is the intersection, and an empty
    // intersection claims nothing rather than raising. The guard lives here so
    // no caller — MCP or not — can bypass it by going straight to the store.
    const restriction = input.allowedKinds === undefined ? undefined : validateWorkKinds(input.allowedKinds, "claim allowedKinds");
    const requested = input.kinds && input.kinds.length > 0 ? input.kinds : undefined;
    const kinds =
      restriction === undefined
        ? requested
        : requested === undefined
          ? restriction
          : requested.filter((kind) => restriction.includes(kind.trim()));
    if (restriction !== undefined && kinds!.length === 0) return undefined;

    return this.transaction(() => {
      const now = this.now();
      const clauses = [
        "r.enabled = 1",
        "((w.status = 'queued' AND w.admitted = 1) OR (w.status = 'claimed' AND w.lease_expires_at <= ?))",
      ];
      const params: SQLInputValue[] = [now];
      if (input.repository) {
        clauses.push("w.repository = ?");
        params.push(input.repository);
      }
      if (kinds && kinds.length > 0) {
        clauses.push(`w.kind IN (${kinds.map(() => "?").join(", ")})`);
        params.push(...kinds);
      }
      if (this.claimEligibility) {
        // Ask the hook once per candidate repository, then keep the atomic
        // single-row selection: an ineligible repository's items are simply
        // not in the running, whatever their priority.
        const candidateRepositories = (
          this.db
            .prepare(
              `SELECT DISTINCT w.repository AS repository FROM work_items w
               JOIN repositories r ON r.slug = w.repository
               WHERE ${clauses.join(" AND ")}`,
            )
            .all(...params) as Row[]
        ).map((candidate) => String(candidate.repository));
        const eligible = candidateRepositories.filter((repository) => this.claimEligibility!(repository) === true);
        if (eligible.length === 0) return undefined;
        clauses.push(`w.repository IN (${eligible.map(() => "?").join(", ")})`);
        params.push(...eligible);
      }

      const row = this.db
        .prepare(
          `SELECT w.* FROM work_items w
           JOIN repositories r ON r.slug = w.repository
           WHERE ${clauses.join(" AND ")}
           ORDER BY w.priority DESC, w.created_at ASC
           LIMIT 1`,
        )
        .get(...params) as Row | undefined;
      if (!row) return undefined;

      const id = String(row.id);
      if (row.status === "claimed") {
        this.addEvent(id, "lease.expired", "system", { previousOwner: row.lease_owner });
      }
      const token = randomUUID();
      const expiresAt = new Date(this.clock().getTime() + leaseSeconds * 1000).toISOString();
      this.db
        .prepare(
          `UPDATE work_items
           SET status = 'claimed', lease_owner = ?, lease_token = ?, lease_expires_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(worker, token, expiresAt, now, id);
      this.addEvent(id, "work.claimed", worker, {
        leaseExpiresAt: expiresAt,
        // A transport-established identity may carry the client's own name as
        // a label beside it (ADR-0063); it is provenance, never authority.
        ...(input.label !== undefined && input.label !== worker ? { label: input.label } : {}),
        // The credential's own claim restriction, when one applied: the ledger
        // says the lease was bounded by the token, not only by the request.
        ...(restriction === undefined ? {} : { kindsRestriction: restriction }),
      });
      return this.getRequired(id);
    });
  }

  heartbeat(id: string, leaseToken: string, worker: string, leaseSeconds?: number): WorkItem {
    validateWorkerPrincipal(worker);
    return this.transaction(() => {
      this.assertActiveLease(id, leaseToken, worker);
      const now = this.now();
      const expiresAt = new Date(this.clock().getTime() + boundedLease(leaseSeconds) * 1000).toISOString();
      this.db
        .prepare("UPDATE work_items SET lease_expires_at = ?, updated_at = ? WHERE id = ?")
        .run(expiresAt, now, id);
      this.addEvent(id, "lease.renewed", worker, { leaseExpiresAt: expiresAt });
      return this.getRequired(id);
    });
  }

  complete(input: CompletionInput): { completed: WorkItem; followUps: WorkItem[] } {
    validateWorkerPrincipal(input.worker);
    validateResult(input.result);
    if (input.followUps.length > MAX_FOLLOW_UPS) {
      throw new Error(`completion may propose at most ${MAX_FOLLOW_UPS} follow-up items`);
    }
    return this.transaction(() => {
      const parent = this.assertActiveLease(input.id, input.leaseToken, input.worker);
      if (input.followUps.length > 0 && !parent.allowedActions.includes("create-followup")) {
        throw new Error("work item does not allow creating follow-up work");
      }
      if (input.followUps.length > 0 && this.lineageDepth(parent) >= MAX_LINEAGE_DEPTH) {
        throw new Error(`work lineage may be at most ${MAX_LINEAGE_DEPTH} edges deep`);
      }
      this.assertArtifactsAllowed(parent, input.result.artifacts);
      // A pr-review completes with a structured verdict and nothing else does
      // (ADR-0065); the verdict is merged into the item's review record.
      let reviewJson: string | undefined;
      if (parent.kind === "pr-review") {
        if (!input.review) throw new Error("pr-review completion requires a review result (decision, blockers, advisories)");
        if (!parent.review) throw new Error("pr-review item has no review record");
        validateReviewResult(input.review);
        reviewJson = JSON.stringify({ ...parent.review, ...input.review, reviewedAt: this.now() });
      } else if (input.review !== undefined) {
        throw new Error("review results are accepted only on pr-review items");
      }

      const now = this.now();
      const children: WorkItem[] = [];
      for (const followUp of input.followUps) {
        // Scheduling priority is operator-owned. Reject any worker-supplied
        // value here as well as at the MCP schema so non-MCP callers cannot
        // bypass the rule; accepted children inherit the parent's priority.
        if ("priority" in followUp) {
          throw new Error("follow-up items may not set priority; children inherit the parent's priority");
        }
        // Sequencing edges belong to imported roots, not to lineage (ADR-0066).
        assertNoPredecessors(followUp, "a follow-up item");
        validateWorkDefinition({ ...followUp, createdBy: input.worker });
        assertSubset(followUp.allowedActions, parent.delegableActions, "follow-up allowedActions");
        assertSubset(followUp.delegableActions, parent.delegableActions, "follow-up delegableActions");
        const id = randomUUID();
        this.insertWork({
          ...followUp,
          id,
          rootId: parent.rootId,
          parentId: parent.id,
          repository: parent.repository,
          priority: parent.priority,
          createdBy: input.worker,
          admitted: false,
          createdAt: now,
        });
        this.addEvent(id, "work.proposed", input.worker, { parentId: parent.id, rootId: parent.rootId });
        children.push(this.getRequired(id));
      }

      this.db
        .prepare(
          `UPDATE work_items
           SET status = 'completed', result_json = ?, review_json = COALESCE(?, review_json), lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(input.result), reviewJson ?? null, now, input.id);
      this.addEvent(input.id, "work.completed", input.worker, {
        followUpIds: children.map((child) => child.id),
        artifactCount: input.result.artifacts.length,
        ...(input.result.model ? { model: input.result.model } : {}),
      });
      if (input.review && parent.review) {
        this.addEvent(input.id, "work.reviewed", input.worker, {
          decision: input.review.decision,
          round: parent.review.round,
          headSha: parent.review.headSha,
          pullRequestUrl: parent.review.pullRequestUrl,
          fingerprints: input.review.blockers.map((blocker) => blocker.fingerprint),
        });
      }
      return { completed: this.getRequired(input.id), followUps: children };
    });
  }

  block(id: string, leaseToken: string, worker: string, reason: string): WorkItem {
    validateWorkerPrincipal(worker);
    if (!reason.trim()) throw new Error("block reason is required");
    return this.transaction(() => {
      this.assertActiveLease(id, leaseToken, worker);
      const now = this.now();
      this.db
        .prepare(
          `UPDATE work_items
           SET status = 'blocked', result_json = ?, lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify({ summary: reason, evidence: [], artifacts: [] }), now, id);
      this.addEvent(id, "work.blocked", worker, { reason });
      return this.getRequired(id);
    });
  }

  release(id: string, leaseToken: string, worker: string, reason: string): WorkItem {
    validateWorkerPrincipal(worker);
    return this.transaction(() => {
      this.assertActiveLease(id, leaseToken, worker);
      const now = this.now();
      this.db
        .prepare(
          `UPDATE work_items
           SET status = 'queued', lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, id);
      this.addEvent(id, "work.released", worker, { reason });
      return this.getRequired(id);
    });
  }

  approve(id: string, actor: string, precondition?: MutationPrecondition): WorkItem {
    validateOperatorActor(actor, "approval");
    return this.transaction(() => {
      const item = this.getRequired(id);
      this.assertPrecondition(item, precondition);
      if (item.status !== "proposed") throw new Error(`work item is not proposed: ${id}`);
      const now = this.now();
      this.db.prepare("UPDATE work_items SET admitted = 1, updated_at = ? WHERE id = ?").run(now, id);
      this.addEvent(id, "work.approved", actor, {});
      return this.getRequired(id);
    });
  }

  defer(id: string, actor: string, reason: string, precondition?: MutationPrecondition): WorkItem {
    validateOperatorActor(actor, "deferral");
    validateOperatorNoteReason(reason, "deferral reason");
    return this.transaction(() => {
      const item = this.getRequired(id);
      this.assertPrecondition(item, precondition);
      if (item.status !== "queued") throw new Error(`work item is not queued and admitted: ${id}`);
      const now = this.now();
      this.db
        .prepare("UPDATE work_items SET admitted = 0, operator_notes_json = ?, updated_at = ? WHERE id = ?")
        .run(appendOperatorNote(item, { at: now, actor, action: "defer", reason }), now, id);
      this.addEvent(id, "work.deferred", actor, { reason });
      return this.getRequired(id);
    });
  }

  /**
   * Appends one operator or policy note to an item without changing its
   * status, admission, lease, or result, and records `work.noted`. The note is
   * carried to the next lease through `operatorNotes`; it is advice about
   * earlier leases, never a change to the definition.
   */
  note(id: string, actor: string, reason: string, precondition?: MutationPrecondition): WorkItem {
    validateOperatorActor(actor, "note");
    validateOperatorNoteReason(reason, "note text");
    return this.transaction(() => {
      const item = this.getRequired(id);
      this.assertPrecondition(item, precondition);
      const now = this.now();
      this.db
        .prepare("UPDATE work_items SET operator_notes_json = ?, updated_at = ? WHERE id = ?")
        .run(appendOperatorNote(item, { at: now, actor, action: "note", reason }), now, id);
      this.addEvent(id, "work.noted", actor, { reason });
      return this.getRequired(id);
    });
  }

  /**
   * Changes the scheduling priority of proposed, queued, or blocked work.
   * Priority is operator-owned: only an operator or policy actor may call
   * this, a claimed or terminal item is refused, children still inherit
   * their parent's value at creation, and the change is recorded both as
   * `work.prioritized` and as a `prioritize` note carried to the next lease.
   */
  prioritize(id: string, actor: string, priority: number, reason: string, precondition?: MutationPrecondition): WorkItem {
    validateOperatorActor(actor, "prioritize");
    if (!Number.isSafeInteger(priority)) throw new Error("priority must be a safe integer");
    validateOperatorNoteReason(reason, "prioritize reason");
    return this.transaction(() => {
      const item = this.getRequired(id);
      this.assertPrecondition(item, precondition);
      if (item.status !== "proposed" && item.status !== "queued" && item.status !== "blocked") {
        throw new Error(`work item is not proposed, queued, or blocked: ${id}`);
      }
      const now = this.now();
      this.db
        .prepare("UPDATE work_items SET priority = ?, operator_notes_json = ?, updated_at = ? WHERE id = ?")
        .run(priority, appendOperatorNote(item, { at: now, actor, action: "prioritize", reason }), now, id);
      this.addEvent(id, "work.prioritized", actor, { previous: item.priority, priority, reason });
      return this.getRequired(id);
    });
  }

  reject(id: string, actor: string, reason: string, precondition?: MutationPrecondition): WorkItem {
    validateOperatorActor(actor, "rejection");
    if (!reason.trim()) throw new Error("rejection reason is required");
    return this.transaction(() => {
      const item = this.getRequired(id);
      this.assertPrecondition(item, precondition);
      if (item.status !== "proposed") throw new Error(`work item is not proposed: ${id}`);
      const now = this.now();
      this.db
        .prepare("UPDATE work_items SET status = 'cancelled', result_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ summary: reason, evidence: [], artifacts: [] }), now, id);
      this.addEvent(id, "work.rejected", actor, { reason });
      return this.getRequired(id);
    });
  }

  /**
   * Returns blocked work to the queue. The block result is not erased: it
   * moves to the end of `previousResults`, and the operator's reason is
   * appended to `operatorNotes`, so the next lease can read both what stopped
   * the earlier one and what the operator said about it.
   */
  requeue(id: string, actor: string, reason: string, precondition?: MutationPrecondition): WorkItem {
    validateOperatorActor(actor, "requeue");
    validateOperatorNoteReason(reason, "requeue reason");
    return this.transaction(() => {
      const item = this.getRequired(id);
      this.assertPrecondition(item, precondition);
      if (item.status !== "blocked") throw new Error(`work item is not blocked: ${id}`);
      const now = this.now();
      const previousResults = item.result ? [...item.previousResults, item.result] : item.previousResults;
      this.db
        .prepare(
          `UPDATE work_items
           SET status = 'queued', result_json = NULL, previous_results_json = ?, operator_notes_json = ?,
               lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          JSON.stringify(previousResults),
          appendOperatorNote(item, { at: now, actor, action: "requeue", reason }),
          now,
          id,
        );
      this.addEvent(id, "work.requeued", actor, { reason });
      return this.getRequired(id);
    });
  }

  cancel(id: string, actor: string, reason: string, precondition?: MutationPrecondition): WorkItem {
    validateOperatorActor(actor, "cancellation");
    if (!reason.trim()) throw new Error("cancellation reason is required");
    return this.transaction(() => {
      const item = this.getRequired(id);
      this.assertPrecondition(item, precondition);
      if (item.status !== "blocked") throw new Error(`work item is not blocked: ${id}`);
      const now = this.now();
      this.db
        .prepare(
          `UPDATE work_items
           SET status = 'cancelled', result_json = ?, lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify({ summary: reason, evidence: [], artifacts: [] }), now, id);
      this.addEvent(id, "work.cancelled", actor, { reason });
      return this.getRequired(id);
    });
  }

  /**
   * Replaces the verification of one artifact on a completed item and records
   * `artifact.verified`. Used by the completion-time verifier's later refresh
   * pass; the artifact itself (kind, URL, description) never changes.
   */
  recordArtifactVerification(id: string, url: string, verification: ArtifactVerification, actor: string): WorkItem {
    if (!actor.trim()) throw new Error("verification actor is required");
    validateVerification(verification);
    return this.transaction(() => {
      const item = this.getRequired(id);
      if (item.status !== "completed" || !item.result) throw new Error(`work item is not completed: ${id}`);
      const index = item.result.artifacts.findIndex((artifact) => artifact.url === url);
      if (index === -1) throw new Error(`work item ${id} has no artifact ${url}`);
      const artifact = item.result.artifacts[index]!;
      if (artifact.kind !== "issue" && artifact.kind !== "pull-request" && artifact.kind !== "release") {
        throw new Error(`artifact ${artifact.kind} is not verifiable: ${url}`);
      }
      const artifacts = item.result.artifacts.slice();
      artifacts[index] = { ...artifact, verification };
      const now = this.now();
      this.db
        .prepare("UPDATE work_items SET result_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ ...item.result, artifacts }), now, id);
      this.addEvent(id, "artifact.verified", actor, {
        url,
        kind: artifact.kind,
        status: verification.status,
        state: verification.status === "verified" ? verification.state : undefined,
        previousState: artifact.verification?.status === "verified" ? artifact.verification.state : undefined,
      });
      return this.getRequired(id);
    });
  }

  /**
   * Appends one issue, pull-request, or release artifact to a completed item's
   * result and records `artifact.attached`. This is the operator's way to
   * record a GitHub artifact the worker did not report — typically a local-only
   * follow-up whose pull request the operator opened by hand, or the release
   * tag a human published for a release slice (ADR-0066) — so `delivery`
   * and later `verify-artifacts` passes see it. The caller MUST have checked
   * the URL against GitHub first and supplies that observation as
   * `verification` (`verified`, or `unverified` with the reason); the store
   * never invents one and never accepts an artifact without one. Only an
   * operator or policy actor may attach; the URL must be a GitHub issue,
   * pull-request, or release URL in the item's own repository; the same URL is attached
   * at most once. Unlike a worker's completion report, attaching does not
   * require the item's `allowedActions` to include `open-pr` or
   * `open-issue`: the operator, not the worker, produced the artifact.
   * Honors the rule 39 precondition like `note`.
   */
  attachArtifact(
    id: string,
    actor: string,
    artifact: { kind: "issue" | "pull-request" | "release"; url: string; description?: string; verification: ArtifactVerification },
    precondition?: MutationPrecondition,
  ): WorkItem {
    validateOperatorActor(actor, "attach-artifact");
    if (artifact.kind !== "issue" && artifact.kind !== "pull-request" && artifact.kind !== "release") {
      throw new Error(`artifact kind must be issue, pull-request, or release: ${String(artifact.kind)}`);
    }
    if (artifact.verification === undefined) throw new Error("attached artifact requires a verification");
    validateVerification(artifact.verification);
    if (artifact.description !== undefined) {
      if (!artifact.description.trim()) throw new Error("artifact description must not be empty");
      if (artifact.description.length > MAX_OPERATOR_NOTE_LENGTH) {
        throw new Error(`artifact description exceeds ${MAX_OPERATOR_NOTE_LENGTH} characters`);
      }
    }
    return this.transaction(() => {
      const item = this.getRequired(id);
      this.assertPrecondition(item, precondition);
      if (item.status !== "completed" || !item.result) throw new Error(`work item is not completed: ${id}`);
      const attached: WorkArtifact = {
        kind: artifact.kind,
        url: artifact.url,
        ...(artifact.description !== undefined ? { description: artifact.description } : {}),
        verification: artifact.verification,
      };
      validateArtifact(attached);
      assertGitHubArtifactScope(item.repository, attached);
      if (item.result.artifacts.some((existing) => existing.url === attached.url)) {
        throw new Error(`artifact already reported: ${attached.url}`);
      }
      const artifacts = [...item.result.artifacts, attached];
      const now = this.now();
      this.db
        .prepare("UPDATE work_items SET result_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ ...item.result, artifacts }), now, id);
      this.addEvent(id, "artifact.attached", actor, {
        url: attached.url,
        kind: attached.kind,
        status: artifact.verification.status,
        state: artifact.verification.status === "verified" ? artifact.verification.state : undefined,
      });
      return this.getRequired(id);
    });
  }

  events(id: string): WorkEvent[] {
    return (this.db.prepare("SELECT * FROM work_events WHERE work_item_id = ? ORDER BY sequence").all(id) as Row[]).map(
      decodeWorkEvent,
    );
  }

  /**
   * Reads the newest bounded slice of one item's ledger, returned oldest
   * first so callers can derive transitions without loading an item's
   * unbounded history.
   */
  recentEvents(id: string, limit = DEFAULT_EVENTS_SINCE_LIMIT): WorkEvent[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENTS_SINCE_LIMIT) {
      throw new Error(`limit must be between 1 and ${MAX_EVENTS_SINCE_LIMIT}`);
    }
    const rows = this.db
      .prepare(
        `SELECT *
         FROM (
           SELECT *
           FROM work_events
           WHERE work_item_id = ?
           ORDER BY sequence DESC
           LIMIT ?
         )
         ORDER BY sequence`,
      )
      .all(id, limit) as Row[];
    return rows.map(decodeWorkEvent);
  }

  /**
   * Reads ledger events across items strictly after a global `sequence`,
   * oldest first, each joined with its item's `repository`, `kind`,
   * `sourceRef`, and current logical status. This is the read-only operator
   * observation surface behind `events` and `watch`; it never exposes a lease
   * token because event payloads never carry one and the join selects none.
   */
  eventsSince(sequence: number, options: { repository?: string; limit?: number } = {}): ObservedWorkEvent[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("sequence must be a non-negative integer");
    const limit = options.limit ?? DEFAULT_EVENTS_SINCE_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENTS_SINCE_LIMIT) {
      throw new Error(`limit must be between 1 and ${MAX_EVENTS_SINCE_LIMIT}`);
    }
    const clauses = ["e.sequence > ?"];
    const params: SQLInputValue[] = [sequence];
    if (options.repository) {
      validateRepository(options.repository);
      clauses.push("w.repository = ?");
      params.push(options.repository);
    }
    const rows = this.db
      .prepare(
        `SELECT e.sequence, e.work_item_id, e.event_type, e.actor, e.payload_json, e.occurred_at,
                w.repository, w.kind, w.source_ref,
                CASE WHEN w.status = 'queued' AND w.admitted = 0 THEN 'proposed' ELSE w.status END AS logical_status
         FROM work_events e
         JOIN work_items w ON w.id = e.work_item_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY e.sequence
         LIMIT ?`,
      )
      .all(...params, limit) as Row[];
    return rows.map((row) => ({
      ...decodeWorkEvent(row),
      repository: String(row.repository),
      kind: String(row.kind),
      sourceRef: row.source_ref == null ? undefined : String(row.source_ref),
      status: String(row.logical_status) as WorkStatus,
    }));
  }

  private migrate(): void {
    // Opening an up-to-date database performs no schema writes: observation
    // commands and server starts must not take the write lock or rebuild
    // indexes. Newer-than-supported databases were already rejected.
    if (this.schemaVersion() >= SCHEMA_VERSION) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Re-check under the write lock: another process may have migrated
      // between our first read and acquiring the lock.
      if (this.schemaVersion() < SCHEMA_VERSION) this.applyMigrations();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Runs inside migrate()'s transaction. Applies every rung above the current
   * `user_version` in order and stamps the version after each one, so a
   * database at any supported older version upgrades forward in place.
   */
  private applyMigrations(): void {
    let version = this.schemaVersion();
    while (version < SCHEMA_VERSION) {
      const rung = MIGRATIONS[version];
      if (!rung) throw new Error(`queue migration ladder has no rung for version ${version + 1}`);
      rung(this.db, { now: this.now() });
      version += 1;
      this.db.exec(`PRAGMA user_version = ${version}`);
    }
  }

  private assertSupportedSchemaVersion(): void {
    const found = this.schemaVersion();
    if (found > SCHEMA_VERSION) {
      throw new Error(
        `queue database schema version ${found} is newer than the supported version ${SCHEMA_VERSION}; ` +
          "restart this process with current code",
      );
    }
  }

  private insertWork(input: FollowUpInput & {
    id: string;
    rootId: string;
    parentId?: string;
    repository: string;
    priority: number;
    createdBy: string;
    admitted: boolean;
    createdAt: string;
    sourceRef?: string;
    predecessors?: readonly string[];
    cure?: PullRequestCure;
    review?: PullRequestReview;
  }): void {
    this.db
      .prepare(
        `INSERT INTO work_items (
          id, root_id, parent_id, repository, kind, objective, instructions,
          acceptance_criteria_json, allowed_actions_json, delegable_actions_json,
          priority, status, admitted, created_by, created_at, updated_at, source_ref,
          predecessors_json, cure_json, review_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.rootId,
        input.parentId ?? null,
        input.repository,
        input.kind,
        input.objective,
        input.instructions,
        JSON.stringify(input.acceptanceCriteria),
        JSON.stringify(input.allowedActions),
        JSON.stringify(input.delegableActions),
        input.priority,
        input.admitted ? 1 : 0,
        input.createdBy,
        input.createdAt,
        input.createdAt,
        input.sourceRef ?? null,
        input.predecessors && input.predecessors.length > 0 ? JSON.stringify(input.predecessors) : null,
        input.cure ? JSON.stringify(input.cure) : null,
        input.review ? JSON.stringify(input.review) : null,
      );
  }

  private assertRepositoryEnabled(repository: string): void {
    validateRepository(repository);
    const row = this.db.prepare("SELECT enabled FROM repositories WHERE slug = ?").get(repository) as Row | undefined;
    if (!row || Number(row.enabled) !== 1) throw new Error(`repository is not opted in: ${repository}`);
  }

  private assertActiveLease(id: string, leaseToken: string, worker: string): WorkItem {
    const item = this.getRequired(id);
    if (item.status !== "claimed") throw new Error(`work item is not claimed: ${id}`);
    if (item.leaseToken !== leaseToken || item.leaseOwner !== worker) throw new Error("lease owner or token does not match");
    if (!item.leaseExpiresAt || item.leaseExpiresAt <= this.now()) throw new Error("lease has expired");
    return item;
  }

  private assertArtifactsAllowed(item: WorkItem, artifacts: WorkArtifact[]): void {
    const requiredAction: Partial<Record<WorkArtifact["kind"], AllowedAction>> = {
      issue: "open-issue",
      "pull-request": "open-pr",
      commit: "write",
    };
    for (const artifact of artifacts) {
      const action = requiredAction[artifact.kind];
      if (action && !item.allowedActions.includes(action)) {
        throw new Error(`artifact ${artifact.kind} requires allowed action ${action}`);
      }
      // A release carries no required action: Snowcat never publishes or tags
      // anything (ADR-0066), so a reported release is one a human published
      // and there is no `release` action to hold. It is scoped like the rest.
      if (action || artifact.kind === "release") assertGitHubArtifactScope(item.repository, artifact);
    }
  }

  /**
   * Refuses an operator mutation whose observed `status`/`updatedAt` no longer
   * match the item (rule 39). Runs inside the caller's transaction before any
   * write, so a mismatch leaves the row and the event ledger untouched.
   */
  private assertPrecondition(item: WorkItem, precondition: MutationPrecondition | undefined): void {
    if (!precondition) return;
    if (item.status !== precondition.status || item.updatedAt !== precondition.updatedAt) {
      throw new PreconditionMismatchError(item.id, item.status, item.updatedAt);
    }
  }

  private getRequired(id: string): WorkItem {
    const item = this.get(id);
    if (!item) throw new Error(`work item not found: ${id}`);
    return item;
  }

  private lineageDepth(item: WorkItem): number {
    let depth = 0;
    let current = item;
    while (current.parentId) {
      depth += 1;
      if (depth > MAX_LINEAGE_DEPTH) throw new Error("work lineage exceeds the supported depth");
      current = this.getRequired(current.parentId);
    }
    return depth;
  }

  private addEvent(id: string, type: string, actor: string, payload: Record<string, unknown>): void {
    this.db
      .prepare(
        "INSERT INTO work_events (work_item_id, event_type, actor, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, type, actor, JSON.stringify(payload), this.now());
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Re-check inside the write lock so a store opened before a later
      // migration fails on its next mutation instead of writing stale semantics.
      this.assertSupportedSchemaVersion();
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function decodeWorkEvent(row: Row): WorkEvent {
  return {
    sequence: Number(row.sequence),
    workItemId: String(row.work_item_id),
    type: String(row.event_type),
    actor: String(row.actor),
    payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    occurredAt: String(row.occurred_at),
  };
}

function decodeWorkItem(row: Row): WorkItem {
  return {
    id: String(row.id),
    rootId: String(row.root_id),
    parentId: row.parent_id == null ? undefined : String(row.parent_id),
    repository: String(row.repository),
    kind: String(row.kind),
    objective: String(row.objective),
    instructions: String(row.instructions),
    acceptanceCriteria: parseJson<string[]>(row.acceptance_criteria_json, []),
    allowedActions: parseJson<AllowedAction[]>(row.allowed_actions_json, []),
    delegableActions: parseJson<AllowedAction[]>(row.delegable_actions_json, []),
    priority: Number(row.priority),
    status: row.status === "queued" && Number(row.admitted) === 0 ? "proposed" : (String(row.status) as WorkStatus),
    createdBy: String(row.created_by),
    sourceRef: row.source_ref == null ? undefined : String(row.source_ref),
    ...(row.predecessors_json == null ? {} : { predecessors: parseJson<string[]>(row.predecessors_json, []) }),
    ...(row.cure_json == null ? {} : { cure: parseJson<PullRequestCure | undefined>(row.cure_json, undefined) }),
    ...(row.review_json == null ? {} : { review: parseJson<PullRequestReview | undefined>(row.review_json, undefined) }),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    leaseOwner: row.lease_owner == null ? undefined : String(row.lease_owner),
    leaseToken: row.lease_token == null ? undefined : String(row.lease_token),
    leaseExpiresAt: row.lease_expires_at == null ? undefined : String(row.lease_expires_at),
    result: row.result_json == null ? undefined : parseJson<WorkResult | undefined>(row.result_json, undefined),
    operatorNotes: parseJson<OperatorNote[]>(row.operator_notes_json, []),
    previousResults: parseJson<WorkResult[]>(row.previous_results_json, []),
  };
}

function appendOperatorNote(item: WorkItem, note: OperatorNote): string {
  return JSON.stringify([...item.operatorNotes, note]);
}

function validateOperatorNoteReason(reason: string, name: string): void {
  if (!reason.trim()) throw new Error(`${name} is required`);
  if (reason.length > MAX_OPERATOR_NOTE_LENGTH) throw new Error(`${name} exceeds ${MAX_OPERATOR_NOTE_LENGTH} characters`);
}

function withDelivery(item: WorkItem): WorkItem {
  if (item.status !== "completed") return item;
  return { ...item, delivery: deriveDelivery(item.result) };
}

function parseJson<T>(value: SQLInputValue | undefined, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function validateCure(cure: PullRequestCure): void {
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/.test(cure.pullRequestUrl)) {
    throw new Error("cure pullRequestUrl must be a GitHub pull-request URL");
  }
  if (!/^[0-9a-f]{40}$/.test(cure.headSha)) throw new Error("cure headSha must be a 40-hex commit SHA");
  if (!/^sha256:[0-9a-f]{64}$/.test(cure.patchDigest)) throw new Error("cure patchDigest must be a sha256: digest");
  if (
    !Array.isArray(cure.decay) ||
    cure.decay.length === 0 ||
    new Set(cure.decay).size !== cure.decay.length ||
    !cure.decay.every((reason) => (pullRequestDecays as readonly string[]).includes(reason))
  ) {
    throw new Error("cure decay must name at least one distinct known reason");
  }
  if (cure.originItemId !== undefined && typeof cure.originItemId !== "string") throw new Error("cure originItemId must be a string");
}

function validateReviewBlockers(blockers: ReviewBlocker[], name: string): void {
  if (!Array.isArray(blockers)) throw new Error(`${name} must be a list`);
  if (blockers.length > MAX_REVIEW_BLOCKERS) throw new Error(`${name} may name at most ${MAX_REVIEW_BLOCKERS} blockers`);
  const fingerprints = new Set<string>();
  for (const blocker of blockers) {
    for (const field of ["fingerprint", "location", "contract", "impact", "resolution", "verification"] as const) {
      if (typeof blocker[field] !== "string" || !blocker[field].trim()) throw new Error(`${name} blocker ${field} is required`);
    }
    if (fingerprints.has(blocker.fingerprint)) throw new Error(`${name} blocker fingerprints must be distinct: ${blocker.fingerprint}`);
    fingerprints.add(blocker.fingerprint);
  }
}

function validateReviewAdvisories(advisories: ReviewAdvisory[], name: string): void {
  if (!Array.isArray(advisories)) throw new Error(`${name} must be a list`);
  if (advisories.length > MAX_REVIEW_ADVISORIES) throw new Error(`${name} may name at most ${MAX_REVIEW_ADVISORIES} advisories`);
  for (const advisory of advisories) {
    if (typeof advisory.fingerprint !== "string" || !advisory.fingerprint.trim()) throw new Error(`${name} advisory fingerprint is required`);
    if (typeof advisory.text !== "string" || !advisory.text.trim()) throw new Error(`${name} advisory text is required`);
  }
}

/** The verdict a `pr-review` worker supplies: decision, bounded blockers, bounded advisories, consistent with each other. */
function validateReviewResult(review: ReviewResult): void {
  if (!(reviewDecisions as readonly string[]).includes(review.decision)) throw new Error("review decision is invalid");
  validateReviewBlockers(review.blockers, "review");
  validateReviewAdvisories(review.advisories, "review");
  if (review.decision === "block" && review.blockers.length === 0) throw new Error("review decision block requires at least one blocker");
  if (review.decision === "pass" && review.blockers.length > 0) throw new Error("review decision pass must carry no blockers");
}

function validateReview(review: PullRequestReview): void {
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/.test(review.pullRequestUrl)) {
    throw new Error("review pullRequestUrl must be a GitHub pull-request URL");
  }
  if (!/^[0-9a-f]{40}$/.test(review.headSha)) throw new Error("review headSha must be a 40-hex commit SHA");
  if (review.patchDigest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(review.patchDigest)) {
    throw new Error("review patchDigest must be a sha256: digest");
  }
  if (!Number.isInteger(review.round) || review.round < 1) throw new Error("review round must be a positive integer");
  for (const field of ["originItemId", "authorModel", "priorReviewerModel", "reviewItemId", "reviewerModel"] as const) {
    if (review[field] !== undefined && typeof review[field] !== "string") throw new Error(`review ${field} must be a string`);
  }
  validateReviewBlockers(review.priorBlockers, "review priorBlockers");
  if (review.blockers !== undefined) validateReviewBlockers(review.blockers, "review");
  if (review.advisories !== undefined) validateReviewAdvisories(review.advisories, "review");
  if (review.decision !== undefined && !(reviewDecisions as readonly string[]).includes(review.decision)) {
    throw new Error("review decision is invalid");
  }
}

function validateSourceRef(sourceRef: string): void {
  if (!sourceRef.trim() || sourceRef !== sourceRef.trim()) throw new Error("sourceRef must be a non-empty trimmed string");
  if (sourceRef.length > MAX_SOURCE_REF_LENGTH) throw new Error(`sourceRef exceeds ${MAX_SOURCE_REF_LENGTH} characters`);
}

/**
 * Normalizes the source references an item waits for (ADR-0066): each entry
 * matches `PREDECESSOR_URL_PATTERN` — a verbatim, case-sensitive absolute
 * GitHub issue URL over HTTPS — at most `MAX_SOURCE_REF_LENGTH` characters,
 * at most `MAX_PREDECESSORS` of them.
 * Returns them deduplicated and sorted so storage is deterministic, or
 * `undefined` when none are declared — which is what stores NULL. It resolves
 * nothing: an unimported predecessor is a normal, visible state.
 */
function normalizePredecessors(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values)) throw new Error("predecessors must be an array of GitHub issue URLs");
  if (values.length > MAX_PREDECESSORS) {
    throw new Error(`predecessors exceed the supported maximum of ${MAX_PREDECESSORS}`);
  }
  for (const value of values) {
    if (typeof value !== "string") throw new Error("predecessors must be an array of GitHub issue URLs");
    if (value.length > MAX_SOURCE_REF_LENGTH) {
      throw new Error(`predecessor exceeds ${MAX_SOURCE_REF_LENGTH} characters`);
    }
    if (!PREDECESSOR_URL_PATTERN.test(value)) {
      throw new Error(`predecessor is not a GitHub issue URL: ${value}`);
    }
  }
  const unique = [...new Set(values)].sort();
  return unique.length === 0 ? undefined : unique;
}

/**
 * Refuses predecessors on every creation path but the proposed root
 * (ADR-0066). The typed inputs already omit the field; this stops an untyped
 * caller from smuggling it onto a seed, a cure or review root, or a follow-up.
 */
function assertNoPredecessors(input: object, what: string): void {
  if ("predecessors" in input && (input as { predecessors?: unknown }).predecessors !== undefined) {
    throw new Error(`${what} must not carry predecessors: only an imported proposed root declares them`);
  }
}

function validateVerification(verification: ArtifactVerification): void {
  if (verification.status === "verified") {
    if (!Number.isSafeInteger(verification.number) || verification.number < 1) throw new Error("verification number is invalid");
    if (!["open", "closed", "merged", "published", "draft"].includes(verification.state)) {
      throw new Error("verification state is invalid");
    }
    if (!verification.verifiedAt.trim()) throw new Error("verification verifiedAt is required");
    return;
  }
  if (verification.status === "unverified") {
    if (!verification.attemptedAt.trim() || !verification.reason.trim()) {
      throw new Error("unverified verification needs attemptedAt and reason");
    }
    return;
  }
  throw new Error("verification status is invalid");
}

/**
 * Normalizes an operator-supplied timestamp to the ISO-8601 UTC form the
 * ledger stores, so a string comparison in SQL is a time comparison.
 */
function normalizeTimestamp(value: string, name: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${name} must be an ISO timestamp (for example 2026-08-19T00:00:00Z), got ${value}`);
  }
  return parsed.toISOString();
}

function validateRepository(repository: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error(`repository must be an owner/name slug: ${repository}`);
  }
}

function validateWorkDefinition(input: {
  kind: string;
  objective: string;
  instructions: string;
  acceptanceCriteria: string[];
  allowedActions: AllowedAction[];
  delegableActions: AllowedAction[];
  priority?: number;
  createdBy: string;
}): void {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(input.kind)) throw new Error(`invalid work kind: ${input.kind}`);
  if (input.priority !== undefined && !Number.isSafeInteger(input.priority)) {
    throw new Error("priority must be a safe integer");
  }
  if (!input.objective.trim()) throw new Error("objective is required");
  if (!input.instructions.trim()) throw new Error("instructions are required");
  if (input.acceptanceCriteria.length === 0 || input.acceptanceCriteria.some((criterion) => !criterion.trim())) {
    throw new Error("at least one non-empty acceptance criterion is required");
  }
  if (!input.createdBy.trim()) throw new Error("createdBy is required");
  assertKnownActions(input.allowedActions);
  assertKnownActions(input.delegableActions);
}

function validateResult(result: WorkResult): void {
  if (!result.summary.trim()) throw new Error("result summary is required");
  if (result.evidence.some((evidence) => !evidence.trim())) throw new Error("evidence entries must not be empty");
  if (result.model !== undefined && (typeof result.model !== "string" || !MODEL_NAME_PATTERN.test(result.model))) {
    throw new Error("result model must be a short model identifier (letters, digits, . _ : / @ -)");
  }
  for (const artifact of result.artifacts) validateArtifact(artifact);
}

function validateArtifact(artifact: WorkArtifact): void {
  if (artifact.verification !== undefined) {
    if (artifact.kind !== "issue" && artifact.kind !== "pull-request" && artifact.kind !== "release") {
      throw new Error(`artifact ${artifact.kind} cannot carry verification`);
    }
    validateVerification(artifact.verification);
  }
  let url: URL;
  try {
    url = new URL(artifact.url);
  } catch {
    throw new Error("artifact URLs must be valid HTTPS URLs");
  }
  if (url.protocol !== "https:") throw new Error("artifact URLs must use HTTPS");
  if (url.username || url.password) throw new Error("artifact URLs must not contain credentials");
}

function assertGitHubArtifactScope(repository: string, artifact: WorkArtifact): void {
  const url = new URL(artifact.url);
  const [owner, name] = repository.split("/") as [string, string];
  const segments = url.pathname.split("/");
  // A release names a tag, not a number, and its URL carries one more segment
  // (`/releases/tag/<tag>`) than the other kinds (ADR-0066).
  const release = artifact.kind === "release";
  const expectedPath = release ? "releases/tag" : artifact.kind === "issue" ? "issues" : artifact.kind === "pull-request" ? "pull" : "commit";
  const identifier = release ? decodeTagSegment(segments[5] ?? "") : (segments[4] ?? "");
  const validIdentifier = release
    ? RELEASE_TAG_PATTERN.test(identifier)
    : artifact.kind === "commit"
      ? /^[0-9a-f]{7,64}$/i.test(identifier)
      : /^[1-9][0-9]*$/.test(identifier);
  const matchesRepository =
    (segments[1] ?? "").toLowerCase() === owner.toLowerCase() &&
    (segments[2] ?? "").toLowerCase() === name.toLowerCase();
  const matchesPath = release ? segments[3] === "releases" && segments[4] === "tag" : segments[3] === expectedPath;

  if (
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    segments.length !== (release ? 6 : 5) ||
    !matchesRepository ||
    !matchesPath ||
    !validIdentifier
  ) {
    const identifierShape = release
      ? "<tag>"
      : artifact.kind === "commit"
        ? "<7-64 hexadecimal characters>"
        : "<positive integer>";
    throw new Error(
      `artifact ${artifact.kind} URL must match https://github.com/${repository}/${expectedPath}/${identifierShape}`,
    );
  }
}

/** A percent-decoded release tag segment, or `""` when the segment is not decodable. */
function decodeTagSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return "";
  }
}

function assertKnownActions(actions: AllowedAction[]): void {
  const known = new Set<string>(allowedActions);
  for (const action of actions) if (!known.has(action)) throw new Error(`unknown allowed action: ${action}`);
}

function assertSubset(values: AllowedAction[], ceiling: AllowedAction[], field: string): void {
  const allowed = new Set(ceiling);
  const excess = values.filter((value) => !allowed.has(value));
  if (excess.length > 0) throw new Error(`${field} exceeds delegation ceiling: ${excess.join(", ")}`);
}

function boundedLease(seconds = DEFAULT_LEASE_SECONDS): number {
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > MAX_LEASE_SECONDS) {
    throw new Error(`leaseSeconds must be an integer between 30 and ${MAX_LEASE_SECONDS}`);
  }
  return seconds;
}

type Migration = (db: DatabaseSync, context: { now: string }) => void;

/**
 * Forward-only migration ladder. Index N-1 upgrades a database from version
 * N-1 to N. Rungs are appended, never edited or reordered, and every statement
 * is idempotent so an unversioned database that already carries some objects
 * converges on the same schema.
 */
const MIGRATIONS: readonly Migration[] = [
  // Rung 1: the baseline queue schema, admission triggers, and indexes.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS repositories (
        slug TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        root_id TEXT NOT NULL,
        parent_id TEXT REFERENCES work_items(id),
        repository TEXT NOT NULL REFERENCES repositories(slug),
        kind TEXT NOT NULL,
        objective TEXT NOT NULL,
        instructions TEXT NOT NULL,
        acceptance_criteria_json TEXT NOT NULL,
        allowed_actions_json TEXT NOT NULL,
        delegable_actions_json TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'completed', 'blocked', 'cancelled')),
        admitted INTEGER NOT NULL DEFAULT 1 CHECK (admitted IN (0, 1)),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        result_json TEXT
      );

      CREATE TABLE IF NOT EXISTS work_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        work_item_id TEXT NOT NULL REFERENCES work_items(id),
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
    `);

    const columns = db.prepare("PRAGMA table_info(work_items)").all() as Row[];
    if (!columns.some((column) => String(column.name) === "admitted")) {
      db.exec("ALTER TABLE work_items ADD COLUMN admitted INTEGER NOT NULL DEFAULT 1 CHECK (admitted IN (0, 1))");
    }

    // Databases created before the schema was versioned may carry a claimable
    // index that predates the admitted column; rebuild it once, then keep it.
    db.exec(`
      DROP INDEX IF EXISTS work_items_claimable;
      CREATE INDEX IF NOT EXISTS work_items_claimable
        ON work_items(status, admitted, lease_expires_at, priority DESC, created_at);
      CREATE INDEX IF NOT EXISTS work_items_lineage ON work_items(root_id, parent_id);
    `);

    // Admission is enforced by the database itself so that a process still
    // running older code (which neither filters on nor writes the admitted
    // column) cannot claim or create claimable work through legacy SQL.
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS work_items_claim_requires_admission
        BEFORE UPDATE OF status ON work_items
        WHEN NEW.status = 'claimed' AND (OLD.admitted = 0 OR NEW.admitted = 0)
      BEGIN
        SELECT RAISE(ABORT, 'work item must be admitted before it can be claimed');
      END;

      CREATE TRIGGER IF NOT EXISTS work_items_children_start_proposed
        BEFORE INSERT ON work_items
        WHEN NEW.parent_id IS NOT NULL AND NEW.admitted = 1
      BEGIN
        SELECT RAISE(ABORT, 'child work items must be created as proposed (admitted = 0)');
      END;
    `);
  },
  // Rung 2: durable per-database lineage identity for backup verification.
  (db, { now }) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS queue_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    db.prepare("INSERT OR IGNORE INTO queue_metadata (key, value) VALUES ('database_id', ?)").run(randomUUID());
    db.prepare("INSERT OR IGNORE INTO queue_metadata (key, value) VALUES ('created_at', ?)").run(now);
  },
  // Rung 3: external source reference for imported roots, unique per repository.
  (db) => {
    const columns = db.prepare("PRAGMA table_info(work_items)").all() as Row[];
    if (!columns.some((column) => String(column.name) === "source_ref")) {
      db.exec("ALTER TABLE work_items ADD COLUMN source_ref TEXT");
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS work_items_source_ref
        ON work_items(repository, source_ref) WHERE source_ref IS NOT NULL;
    `);
  },
  // Rung 4: operator notes and requeue-superseded results carried on the item,
  // so the next lease sees what happened on earlier ones.
  (db) => {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(work_items)").all() as Row[]).map((column) => String(column.name)),
    );
    if (!columns.has("operator_notes_json")) {
      db.exec("ALTER TABLE work_items ADD COLUMN operator_notes_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!columns.has("previous_results_json")) {
      db.exec("ALTER TABLE work_items ADD COLUMN previous_results_json TEXT NOT NULL DEFAULT '[]'");
    }
  },
  // Rung 5: the pull-request cure a `pr-cure` root is bound to (ADR-0061):
  // head SHA, patch digest, and decay, typed in one nullable column.
  (db) => {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(work_items)").all() as Row[]).map((column) => String(column.name)),
    );
    if (!columns.has("cure_json")) {
      db.exec("ALTER TABLE work_items ADD COLUMN cure_json TEXT");
    }
  },
  // Rung 6: per-repository opt-in to curing foreign pull requests — ones no
  // Snowcat item reported (ADR-0061). Off for every existing row.
  (db) => {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(repositories)").all() as Row[]).map((column) => String(column.name)),
    );
    if (!columns.has("cure_foreign")) {
      db.exec("ALTER TABLE repositories ADD COLUMN cure_foreign INTEGER NOT NULL DEFAULT 0 CHECK (cure_foreign IN (0, 1))");
    }
  },
  // Rung 7: Snowcat-minted MCP tokens (ADR-0063). Only the secret's hash is
  // stored; the owner is the verified member identity that minted it and the
  // client is a human-readable name for the process that will hold it.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tokens (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        client TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT,
        revoked_by TEXT
      );
      CREATE INDEX IF NOT EXISTS mcp_tokens_owner ON mcp_tokens(owner, created_at);
    `);
  },
  // Rung 8: the review gate (ADR-0065): the review record a `pr-review` or
  // `pr-review-fix` root is bound to, typed in one nullable column, and the
  // per-repository opt-in. Off for every existing row.
  (db) => {
    const items = new Set(
      (db.prepare("PRAGMA table_info(work_items)").all() as Row[]).map((column) => String(column.name)),
    );
    if (!items.has("review_json")) {
      db.exec("ALTER TABLE work_items ADD COLUMN review_json TEXT");
    }
    const repositories = new Set(
      (db.prepare("PRAGMA table_info(repositories)").all() as Row[]).map((column) => String(column.name)),
    );
    if (!repositories.has("review_gate")) {
      db.exec("ALTER TABLE repositories ADD COLUMN review_gate INTEGER NOT NULL DEFAULT 0 CHECK (review_gate IN (0, 1))");
    }
  },
  // Rung 9: the work kinds a minted MCP token may claim — a JSON array, or
  // NULL for an unrestricted token, which is what every existing row becomes.
  // Narrowing only: it bounds `claim_work` and nothing else.
  (db) => {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(mcp_tokens)").all() as Row[]).map((column) => String(column.name)),
    );
    if (!columns.has("kinds_json")) {
      db.exec("ALTER TABLE mcp_tokens ADD COLUMN kinds_json TEXT");
    }
  },
  // Rung 10: the review gate's last unreported-pull-request observation per
  // repository (ADR-0065) — a JSON object, or NULL for a repository the sweep
  // has not observed yet, which is what every existing row becomes. Nullable
  // and overwritten whole; it is an observation, never queue state.
  (db) => {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(repositories)").all() as Row[]).map((column) => String(column.name)),
    );
    if (!columns.has("unreported_pull_requests_json")) {
      db.exec("ALTER TABLE repositories ADD COLUMN unreported_pull_requests_json TEXT");
    }
  },
  // Rung 11: the labeled open issues seen by the latest successful import for
  // each repository — a bounded JSON object, or NULL before the first import.
  // Overwritten whole; it is an observation, never queue state.
  (db) => {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(repositories)").all() as Row[]).map((column) => String(column.name)),
    );
    if (!columns.has("labeled_issue_observations_json")) {
      db.exec("ALTER TABLE repositories ADD COLUMN labeled_issue_observations_json TEXT");
    }
  },
  // Rung 12: the source references an item waits for (ADR-0066) — a JSON array
  // of GitHub issue URLs, or NULL for an item that declares none, which is what
  // every existing row becomes. Inert data: no index, no trigger, no claim
  // effect (gating arrives with slice 3, frostyard/snowcat#161).
  (db) => {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(work_items)").all() as Row[]).map((column) => String(column.name)),
    );
    if (!columns.has("predecessors_json")) {
      db.exec("ALTER TABLE work_items ADD COLUMN predecessors_json TEXT");
    }
  },
];

if (MIGRATIONS.length !== SCHEMA_VERSION) {
  throw new Error(`SCHEMA_VERSION ${SCHEMA_VERSION} does not match the migration ladder length ${MIGRATIONS.length}`);
}

function countRows(db: DatabaseSync): { workItems: number; workEvents: number; lastEventSequence: number } {
  const items = db.prepare("SELECT COUNT(*) AS count FROM work_items").get() as Row;
  const events = db.prepare("SELECT COUNT(*) AS count, COALESCE(MAX(sequence), 0) AS last FROM work_events").get() as Row;
  return {
    workItems: Number(items.count),
    workEvents: Number(events.count),
    lastEventSequence: Number(events.last),
  };
}

function reserveBackupPath(path: string): void {
  try {
    closeSync(openSync(path, "wx", 0o600));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`backup path could not be reserved without overwrite: ${detail}`);
  }
}
