import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  allowedActions,
  deriveDelivery,
  workStatuses,
  type AllowedAction,
  type ArtifactVerification,
  type ClaimInput,
  type CompletionInput,
  type FollowUpInput,
  type ProposedRootInput,
  type SeedWorkInput,
  type WorkArtifact,
  type WorkEvent,
  type WorkItem,
  type WorkResult,
  type WorkStatus,
} from "./types.ts";

type Row = Record<string, SQLInputValue>;

const DEFAULT_LEASE_SECONDS = 15 * 60;
const MAX_LEASE_SECONDS = 60 * 60;
const MAX_FOLLOW_UPS = 10;
const MAX_LINEAGE_DEPTH = 4;
const BUSY_TIMEOUT_MS = 5000;
const MAX_SOURCE_REF_LENGTH = 512;

/**
 * Schema version recorded in SQLite `PRAGMA user_version`. It equals the length
 * of the migration ladder below: rung N upgrades a database from version N-1
 * to N. A process running older code refuses to keep writing to a database
 * that newer code has already migrated; newer code upgrades an older database
 * in place, forward only, inside one write transaction.
 */
export const SCHEMA_VERSION = 3;

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
 * Principal namespaces written only by Fluent itself (operator CLI, feeders,
 * lease expiry). Worker identities may not use them, so createdBy and event
 * actors cannot be spoofed to look operator- or system-authored.
 */
export const RESERVED_PRINCIPAL_PREFIXES = ["operator:", "policy:", "system:"] as const;

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
 * Decides whether a repository's admitted work may be claimed right now, on
 * top of the queue's own opt-in. The control-plane store supplies one that
 * requires `enrolled` (which already excludes operator holds); without a
 * hook, opt-in alone governs. A hook that throws fails the claim closed.
 */
export type ClaimEligibility = (repository: string) => boolean;

export interface QueueStoreOptions {
  claimEligibility?: ClaimEligibility;
}

export function queueDatabasePath(): string {
  const configured = process.env.FLUENT_QUEUE_DB;
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

  enqueueSeed(input: SeedWorkInput): WorkItem {
    validateWorkDefinition(input);
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
   * repository. With `cooldownSeconds`, a kind whose most recent root completed
   * within that window without proposing any child (a no-finding assessment)
   * is also skipped and reported in `cooledKinds`, so a repeating feeder does
   * not re-ask a question that was just answered "nothing to do".
   */
  enqueueInactiveRootBatch(
    repository: string,
    candidates: Array<Omit<SeedWorkInput, "repository">>,
    options: { cooldownSeconds?: number } = {},
  ): { created: WorkItem[]; skippedKinds: string[]; cooledKinds: string[] } {
    validateRepository(repository);
    const cooldownSeconds = options.cooldownSeconds ?? 0;
    if (!Number.isSafeInteger(cooldownSeconds) || cooldownSeconds < 0) {
      throw new Error("cooldownSeconds must be a non-negative safe integer");
    }
    return this.transaction(() => {
      this.assertRepositoryEnabled(repository);
      const activeKinds = new Set(this.activeRootKinds(repository));
      const cooled = cooldownSeconds > 0 ? new Set(this.recentNoFindingRootKinds(repository, cooldownSeconds)) : new Set<string>();
      const created: WorkItem[] = [];
      const skippedKinds: string[] = [];
      const cooledKinds: string[] = [];

      for (const candidate of candidates) {
        const input: SeedWorkInput = { ...candidate, repository };
        validateWorkDefinition(input);
        if (activeKinds.has(input.kind)) {
          skippedKinds.push(input.kind);
          continue;
        }
        if (cooled.has(input.kind)) {
          cooledKinds.push(input.kind);
          continue;
        }

        const id = randomUUID();
        const now = this.now();
        this.insertWork({ ...input, id, rootId: id, priority: input.priority ?? 0, admitted: true, createdAt: now });
        this.addEvent(id, "work.queued", input.createdBy, { root: true });
        created.push(this.getRequired(id));
        activeKinds.add(input.kind);
      }
      return { created, skippedKinds, cooledKinds };
    });
  }

  /**
   * Creates one `proposed` root per candidate whose `sourceRef` is not already
   * present for the repository, in one transaction. Nothing here is claimable
   * until an operator approves it; repeated imports of the same source create
   * nothing new, whatever the earlier item's status became.
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
        const { sourceRef, ...definition } = candidate;
        const input: SeedWorkInput = { ...definition, repository };
        validateWorkDefinition(input);
        validateSourceRef(sourceRef);
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
        });
        this.addEvent(id, "work.proposed", input.createdBy, { root: true, sourceRef });
        created.push(this.getRequired(id));
      }
      return { created, skippedSourceRefs };
    });
  }

  get(id: string): WorkItem | undefined {
    const row = this.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as Row | undefined;
    return row ? withDelivery(decodeWorkItem(row)) : undefined;
  }

  list(options: { status?: WorkStatus; repository?: string; kind?: string; limit?: number } = {}): WorkItem[] {
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
    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM work_items ${where} ORDER BY priority DESC, created_at ASC LIMIT ?`)
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
   * Kinds whose most recent root in the repository completed within the window
   * and proposed no child: the assessment ran and found nothing actionable.
   */
  private recentNoFindingRootKinds(repository: string, cooldownSeconds: number): string[] {
    const cutoff = new Date(this.clock().getTime() - cooldownSeconds * 1000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT latest.kind AS kind
         FROM work_items latest
         WHERE latest.repository = ? AND latest.parent_id IS NULL
           AND latest.updated_at = (
             SELECT MAX(root.updated_at) FROM work_items root
             WHERE root.repository = latest.repository AND root.parent_id IS NULL AND root.kind = latest.kind
           )
           AND latest.status = 'completed' AND latest.updated_at >= ?
           AND NOT EXISTS (SELECT 1 FROM work_items child WHERE child.parent_id = latest.id)
         ORDER BY latest.kind`,
      )
      .all(repository, cutoff) as Row[];
    return rows.map((row) => String(row.kind));
  }

  private sourceRefExists(repository: string, sourceRef: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS present FROM work_items WHERE repository = ? AND source_ref = ? LIMIT 1")
      .get(repository, sourceRef) as Row | undefined;
    return row !== undefined;
  }

  counts(): Record<WorkStatus, number> {
    const result = Object.fromEntries(workStatuses.map((status) => [status, 0])) as Record<WorkStatus, number>;
    const rows = this.db
      .prepare(
        `SELECT CASE WHEN status = 'queued' AND admitted = 0 THEN 'proposed' ELSE status END AS logical_status,
                COUNT(*) AS count
         FROM work_items
         GROUP BY logical_status`,
      )
      .all() as Row[];
    for (const row of rows) result[String(row.logical_status) as WorkStatus] = Number(row.count);
    return result;
  }

  claim(input: ClaimInput): WorkItem | undefined {
    const worker = validateWorkerIdentity(input.worker);
    if (input.repository) validateRepository(input.repository);
    const leaseSeconds = boundedLease(input.leaseSeconds);

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
      if (input.kinds && input.kinds.length > 0) {
        clauses.push(`w.kind IN (${input.kinds.map(() => "?").join(", ")})`);
        params.push(...input.kinds);
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
      this.addEvent(id, "work.claimed", worker, { leaseExpiresAt: expiresAt });
      return this.getRequired(id);
    });
  }

  heartbeat(id: string, leaseToken: string, worker: string, leaseSeconds?: number): WorkItem {
    validateWorkerIdentity(worker);
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
    validateWorkerIdentity(input.worker);
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

      const now = this.now();
      const children: WorkItem[] = [];
      for (const followUp of input.followUps) {
        // Scheduling priority is operator-owned. Reject any worker-supplied
        // value here as well as at the MCP schema so non-MCP callers cannot
        // bypass the rule; accepted children inherit the parent's priority.
        if ("priority" in followUp) {
          throw new Error("follow-up items may not set priority; children inherit the parent's priority");
        }
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
           SET status = 'completed', result_json = ?, lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(input.result), now, input.id);
      this.addEvent(input.id, "work.completed", input.worker, {
        followUpIds: children.map((child) => child.id),
        artifactCount: input.result.artifacts.length,
      });
      return { completed: this.getRequired(input.id), followUps: children };
    });
  }

  block(id: string, leaseToken: string, worker: string, reason: string): WorkItem {
    validateWorkerIdentity(worker);
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
    validateWorkerIdentity(worker);
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

  approve(id: string, actor: string): WorkItem {
    if (!actor.trim()) throw new Error("approval actor is required");
    return this.transaction(() => {
      const item = this.getRequired(id);
      if (item.status !== "proposed") throw new Error(`work item is not proposed: ${id}`);
      const now = this.now();
      this.db.prepare("UPDATE work_items SET admitted = 1, updated_at = ? WHERE id = ?").run(now, id);
      this.addEvent(id, "work.approved", actor, {});
      return this.getRequired(id);
    });
  }

  defer(id: string, actor: string, reason: string): WorkItem {
    if (!actor.trim()) throw new Error("deferral actor is required");
    if (!reason.trim()) throw new Error("deferral reason is required");
    return this.transaction(() => {
      const item = this.getRequired(id);
      if (item.status !== "queued") throw new Error(`work item is not queued and admitted: ${id}`);
      const now = this.now();
      this.db.prepare("UPDATE work_items SET admitted = 0, updated_at = ? WHERE id = ?").run(now, id);
      this.addEvent(id, "work.deferred", actor, { reason });
      return this.getRequired(id);
    });
  }

  reject(id: string, actor: string, reason: string): WorkItem {
    if (!actor.trim()) throw new Error("rejection actor is required");
    if (!reason.trim()) throw new Error("rejection reason is required");
    return this.transaction(() => {
      const item = this.getRequired(id);
      if (item.status !== "proposed") throw new Error(`work item is not proposed: ${id}`);
      const now = this.now();
      this.db
        .prepare("UPDATE work_items SET status = 'cancelled', result_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify({ summary: reason, evidence: [], artifacts: [] }), now, id);
      this.addEvent(id, "work.rejected", actor, { reason });
      return this.getRequired(id);
    });
  }

  requeue(id: string, actor: string, reason: string): WorkItem {
    if (!actor.trim()) throw new Error("requeue actor is required");
    if (!reason.trim()) throw new Error("requeue reason is required");
    return this.transaction(() => {
      const item = this.getRequired(id);
      if (item.status !== "blocked") throw new Error(`work item is not blocked: ${id}`);
      const now = this.now();
      this.db
        .prepare(
          `UPDATE work_items
           SET status = 'queued', result_json = NULL, lease_owner = NULL, lease_token = NULL,
               lease_expires_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(now, id);
      this.addEvent(id, "work.requeued", actor, { reason });
      return this.getRequired(id);
    });
  }

  cancel(id: string, actor: string, reason: string): WorkItem {
    if (!actor.trim()) throw new Error("cancellation actor is required");
    if (!reason.trim()) throw new Error("cancellation reason is required");
    return this.transaction(() => {
      const item = this.getRequired(id);
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
      if (artifact.kind !== "issue" && artifact.kind !== "pull-request") {
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

  events(id: string): WorkEvent[] {
    return (this.db.prepare("SELECT * FROM work_events WHERE work_item_id = ? ORDER BY sequence").all(id) as Row[]).map(
      (row) => ({
        sequence: Number(row.sequence),
        workItemId: String(row.work_item_id),
        type: String(row.event_type),
        actor: String(row.actor),
        payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
        occurredAt: String(row.occurred_at),
      }),
    );
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
  }): void {
    this.db
      .prepare(
        `INSERT INTO work_items (
          id, root_id, parent_id, repository, kind, objective, instructions,
          acceptance_criteria_json, allowed_actions_json, delegable_actions_json,
          priority, status, admitted, created_by, created_at, updated_at, source_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
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
      if (action) assertGitHubArtifactScope(item.repository, artifact);
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
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    leaseOwner: row.lease_owner == null ? undefined : String(row.lease_owner),
    leaseToken: row.lease_token == null ? undefined : String(row.lease_token),
    leaseExpiresAt: row.lease_expires_at == null ? undefined : String(row.lease_expires_at),
    result: row.result_json == null ? undefined : parseJson<WorkResult | undefined>(row.result_json, undefined),
  };
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

function validateSourceRef(sourceRef: string): void {
  if (!sourceRef.trim() || sourceRef !== sourceRef.trim()) throw new Error("sourceRef must be a non-empty trimmed string");
  if (sourceRef.length > MAX_SOURCE_REF_LENGTH) throw new Error(`sourceRef exceeds ${MAX_SOURCE_REF_LENGTH} characters`);
}

function validateVerification(verification: ArtifactVerification): void {
  if (verification.status === "verified") {
    if (!Number.isSafeInteger(verification.number) || verification.number < 1) throw new Error("verification number is invalid");
    if (!["open", "closed", "merged"].includes(verification.state)) throw new Error("verification state is invalid");
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
  for (const artifact of result.artifacts) {
    if (artifact.verification !== undefined) {
      if (artifact.kind !== "issue" && artifact.kind !== "pull-request") {
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
}

function assertGitHubArtifactScope(repository: string, artifact: WorkArtifact): void {
  const url = new URL(artifact.url);
  const [owner, name] = repository.split("/") as [string, string];
  const segments = url.pathname.split("/");
  const expectedPath = artifact.kind === "issue" ? "issues" : artifact.kind === "pull-request" ? "pull" : "commit";
  const identifier = segments[4] ?? "";
  const validIdentifier =
    artifact.kind === "commit" ? /^[0-9a-f]{7,64}$/i.test(identifier) : /^[1-9][0-9]*$/.test(identifier);
  const matchesRepository =
    (segments[1] ?? "").toLowerCase() === owner.toLowerCase() &&
    (segments[2] ?? "").toLowerCase() === name.toLowerCase();

  if (
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    segments.length !== 5 ||
    !matchesRepository ||
    segments[3] !== expectedPath ||
    !validIdentifier
  ) {
    const identifierShape = artifact.kind === "commit" ? "<7-64 hexadecimal characters>" : "<positive integer>";
    throw new Error(
      `artifact ${artifact.kind} URL must match https://github.com/${repository}/${expectedPath}/${identifierShape}`,
    );
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
