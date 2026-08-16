# 0006 — Enforce admission in the database

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

[ADR-0005](0005-admit-worker-created-work-before-claiming.md) made
worker-created follow-ups start as non-claimable `proposed` work. The
implementation stored that state as an `admitted` flag that application code
filters on when claiming and clears when inserting children.

During dogfooding on 2026-08-15 a Fluent MCP server process that had started
before that change kept running against the migrated database. Its `INSERT`
omitted the `admitted` column, so the column default admitted every child it
created, and its claim query never filtered on admission. Three worker
proposals became claimable without any approval event — exactly the
self-feeding loop ADR-0005 exists to prevent. Nothing in the database refused
the stale writes, and no version marker told the old process it was outdated.

Each MCP client and the operator CLI open their own SQLite connection to the
shared queue file, so a mixed-version fleet of long-lived processes is a normal
operating condition, not an edge case.

## Decision

The database, not only application code, enforces admission. `QueueStore`
migration installs two SQLite triggers:

- `work_items_claim_requires_admission` aborts any update that sets `status`
  to `claimed` while the row's `admitted` flag is `0` before or after the
  statement, so neither a legacy claim that omits the predicate nor a
  single-statement admit-and-claim can lease a proposal.
- `work_items_children_start_proposed` aborts any insert of a row that has a
  `parent_id` with `admitted = 1`, so a legacy insert that relies on the
  column default cannot create claimable children.

`approve()` remains the only application path that flips `admitted` to `1`,
and it does so only while the row stays `queued`.

`QueueStore` also records a code-defined `SCHEMA_VERSION` in
`PRAGMA user_version`. Construction fails when the database reports a newer
version, and every write transaction re-reads the version after taking the
write lock so a store opened before a later migration fails on its next
mutation. `SCHEMA_VERSION` MUST be bumped by any migration that changes queue
semantics.

## Consequences

- The observed bypass is closed by the database constraint: a client running
  pre-admission code now fails on the write instead of silently admitting or
  claiming proposals. The failure surfaces on that client's next completion or
  claim, which is the fail-closed outcome we want; the operator still has to
  restart that client.
- The schema-version guard bounds *future* drift only. Processes running code
  from before this ADR never read `user_version` and are not stopped by it;
  operators still restart those processes. Documentation must not describe the
  version check as protecting pre-guard clients.
- Legacy rows that were already admitted before the triggers existed are not
  retroactively re-proposed; the triggers validate transitions, not history.
  The three items affected on 2026-08-15 had already been returned to
  `proposed` by operator action before this change.
- Adding a migration now carries an obligation: bump `SCHEMA_VERSION`, and
  accept that older processes will start failing writes as soon as the new
  version lands.
- The invariant is enforced with SQLite triggers, so the storage engine choice
  for production (still unresolved) must offer an equivalent durable
  constraint or the design doc must record the gap.

## Alternatives considered

- **Application version check only:** rejected because it cannot reach
  processes that predate the check, which is precisely the stale-client
  population that caused the incident.
- **Change the `admitted` column default to `0`:** rejected because SQLite
  cannot alter a column default in place, and a default alone would not stop
  a legacy claim that ignores the flag.
- **Rebuild the status table with a real `proposed` status:** deferred; it is
  destructive for existing data and still needs a version guard to stop stale
  writers from inserting `queued` children.
- **Detect stale processes with a lock file or heartbeat registry:** rejected
  as more machinery than a per-write constraint and still advisory.

## References

- Shapes: [queue execution boundary](../design/queue-execution-boundary.md)
  and [work queue contract](../specs/work-queue.md)
- Builds on: [ADR-0005](0005-admit-worker-created-work-before-claiming.md)
  and [ADR-0004](0004-keep-models-outside-the-control-path.md)
- Product: [maintenance fleet PRD](../prd/agent-fleet.md)
- Delivered in: [queue vertical spike](../plans/queue-vertical-spike.md)
