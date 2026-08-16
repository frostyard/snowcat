import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import {
  allowedActions,
  workStatuses,
  type AllowedAction,
  type ClaimInput,
  type CompletionInput,
  type FollowUpInput,
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

/**
 * Schema version recorded in SQLite `PRAGMA user_version`. Bump it whenever a
 * migration changes queue semantics so a process running older code refuses
 * to keep writing to a database that newer code has already migrated.
 */
export const SCHEMA_VERSION = 1;

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

export function queueDatabasePath(): string {
  return process.env.FLUENT_QUEUE_DB ?? resolve("./data/queue.db");
}

export class QueueStore {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
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

  enqueueInactiveRootBatch(
    repository: string,
    candidates: Array<Omit<SeedWorkInput, "repository">>,
  ): { created: WorkItem[]; skippedKinds: string[] } {
    validateRepository(repository);
    return this.transaction(() => {
      this.assertRepositoryEnabled(repository);
      const activeKinds = new Set(this.activeRootKinds(repository));
      const created: WorkItem[] = [];
      const skippedKinds: string[] = [];

      for (const candidate of candidates) {
        const input: SeedWorkInput = { ...candidate, repository };
        validateWorkDefinition(input);
        if (activeKinds.has(input.kind)) {
          skippedKinds.push(input.kind);
          continue;
        }

        const id = randomUUID();
        const now = this.now();
        this.insertWork({ ...input, id, rootId: id, priority: input.priority ?? 0, admitted: true, createdAt: now });
        this.addEvent(id, "work.queued", input.createdBy, { root: true });
        created.push(this.getRequired(id));
        activeKinds.add(input.kind);
      }
      return { created, skippedKinds };
    });
  }

  get(id: string): WorkItem | undefined {
    const row = this.db.prepare("SELECT * FROM work_items WHERE id = ?").get(id) as Row | undefined;
    return row ? decodeWorkItem(row) : undefined;
  }

  list(options: { status?: WorkStatus; repository?: string; limit?: number } = {}): WorkItem[] {
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
    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM work_items ${where} ORDER BY priority DESC, created_at ASC LIMIT ?`)
      .all(...params, limit) as Row[];
    return rows.map(decodeWorkItem);
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

  /** Runs inside migrate()'s transaction. Every statement must be idempotent. */
  private applyMigrations(): void {
    this.db.exec(`
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

    const columns = this.db.prepare("PRAGMA table_info(work_items)").all() as Row[];
    if (!columns.some((column) => String(column.name) === "admitted")) {
      this.db.exec("ALTER TABLE work_items ADD COLUMN admitted INTEGER NOT NULL DEFAULT 1 CHECK (admitted IN (0, 1))");
    }

    // Databases created before the schema was versioned may carry a claimable
    // index that predates the admitted column; rebuild it once, then keep it.
    this.db.exec(`
      DROP INDEX IF EXISTS work_items_claimable;
      CREATE INDEX IF NOT EXISTS work_items_claimable
        ON work_items(status, admitted, lease_expires_at, priority DESC, created_at);
      CREATE INDEX IF NOT EXISTS work_items_lineage ON work_items(root_id, parent_id);
    `);

    // Admission is enforced by the database itself so that a process still
    // running older code (which neither filters on nor writes the admitted
    // column) cannot claim or create claimable work through legacy SQL.
    this.db.exec(`
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

    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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
  }): void {
    this.db
      .prepare(
        `INSERT INTO work_items (
          id, root_id, parent_id, repository, kind, objective, instructions,
          acceptance_criteria_json, allowed_actions_json, delegable_actions_json,
          priority, status, admitted, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
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
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    leaseOwner: row.lease_owner == null ? undefined : String(row.lease_owner),
    leaseToken: row.lease_token == null ? undefined : String(row.lease_token),
    leaseExpiresAt: row.lease_expires_at == null ? undefined : String(row.lease_expires_at),
    result: row.result_json == null ? undefined : parseJson<WorkResult | undefined>(row.result_json, undefined),
  };
}

function parseJson<T>(value: SQLInputValue | undefined, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
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
