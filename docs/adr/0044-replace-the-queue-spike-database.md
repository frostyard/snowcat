# 0044 — Replace the queue spike database

- **Status:** Superseded by [0059](0059-adopt-the-queue-store-as-the-v1-work-engine.md)
- **Date:** 2026-08-16

## Context

The implemented SQLite queue is a successful vertical spike. It proved that an
operator-started Claude, Codex, Copilot, or other worker can claim one bounded
item through MCP, produce durable bookkeeping, and propose follow-up work
without Fluent managing the worker process. Its rows have not become the
organization's authoritative planning history: enrollment, goals, policies,
GitHub reconciliation, authenticated worker sessions, grants, controllers, and
outcome verification are not yet implemented.

The spike schema also deliberately combines concepts that the accepted target
model separates. A repository slug stands in for source-native identity;
caller-supplied worker text stands in for a bound session; `status`, `admitted`,
lease columns, integer priority, mixed results, event timestamps, and event
sequence each have narrower spike meanings. Importing those rows would require
one-time classifiers, compatibility writes, comparison projections, identity
exceptions, and cutover machinery. That work would preserve prototype data
while increasing the risk that ambiguous spike state is mistaken for target
authority.

The operator has confirmed that no queue-spike data needs to survive as live
control-plane state. We therefore need an explicit replacement boundary rather
than a record migration whose only beneficiary is disposable dogfood data.

## Decision

Fluent will bootstrap the accepted control-plane kernel in a fresh database.
The target runtime will not migrate, backfill, reinterpret, dual-write, or read
through records from the queue-spike database.

The current queue remains an independently operable prototype until the target
work path is ready. Target development uses a separate database path and schema
lineage; it does not advance the spike database's `PRAGMA user_version` or add
target tables beside spike tables. Useful worker-facing behavior may be
reimplemented deliberately, but neither the physical schema nor accidental API
semantics are compatibility requirements.

Cutover is a bounded operator procedure:

1. stop feeders and all MCP or CLI mutation of the spike queue;
2. allow useful active work to finish or explicitly abandon it, then confirm
   that no live spike lease is being relied upon;
3. create and verify a timestamped read-only backup, plus a secret-safe export
   if human-readable archaeology is useful;
4. configure Fluent to use a newly initialized target database;
5. re-author any still-useful objective through the target admission path,
   receiving new subject, record, transaction, time, session, and provenance
   identities; and
6. retain the old database outside the live runtime until its retention period
   expires, then remove it through an explicit operator action.

Lease tokens and other secrets are never copied into an export or the target
database. An archived spike row remains evidence only of spike behavior. It
cannot establish a target fact, satisfy a target gate, reserve target identity,
or claim a historical target transaction position.

The target database still uses forward-only schema evolution after its initial
release. Backup and restore must preserve its database-lineage identity and
transaction-sequence high-water mark. This decision removes only the one-time
spike-to-target data migration; it does not prohibit future migrations between
released target schema versions.

This decision supersedes the spike-data-migration provisions in
[ADR-0037](0037-store-facts-with-a-separate-event-ledger.md),
[ADR-0040](0040-establish-facts-through-registered-predicate-contracts.md),
[ADR-0042](0042-use-rebuildable-projections-only-as-read-models.md), and
[ADR-0043](0043-order-records-by-transaction-sequence-not-timestamps.md). Their
control-plane, predicate, projection, and ordering decisions remain in force.

## Consequences

- The target schema can express the accepted model directly, without legacy
  columns, one-time authority paths, dual writes, or historical classifiers.
- No ambiguous spike status, slug, worker string, result, timestamp, or event is
  promoted into target truth.
- Kernel implementation and testing become materially smaller, and destructive
  cutover failure remains recoverable from the archived spike database.
- The current queue can continue supporting design dogfood until target cutover,
  but work created there is intentionally temporary.
- Any useful uncompleted objective must be consciously re-authored. It loses its
  spike queue identity and place, which is acceptable because those identities
  have no production consumers.
- Cutover requires a short mutation freeze and an operator-visible archive and
  reset step. Fluent must never silently erase or automatically import the old
  database.
- Existing queue tests remain evidence for interaction and concurrency lessons,
  not a requirement that the target schema reproduce spike implementation
  details.

## Alternatives considered

- **Classify and migrate every spike row:** rejected because it adds substantial
  one-time machinery to preserve disposable data and risks manufacturing target
  authority from weaker meanings.
- **Dual-write spike and target schemas until parity:** rejected because it
  creates two competing representations and prolongs the ambiguous authority
  boundary without a continuity requirement.
- **Replace the database immediately:** rejected because the target work path is
  not implemented; the spike remains useful for design dogfood until a bounded
  cutover can succeed.
- **Copy only admitted or unfinished work:** rejected because selective copying
  still requires identity, admission, provenance, time, and lease
  reinterpretation. Re-authoring makes the new authority act explicit.

## References

- Shapes: [queue execution boundary](../design/queue-execution-boundary.md),
  [work queue](../specs/work-queue.md), and
  [control-plane kernel bootstrap](../plans/control-plane-kernel-bootstrap.md)
- Product: [GitHub organization agent fleet](../prd/agent-fleet.md)
- Delivery order: [product foundation roadmap](../plans/product-foundation-roadmap.md)
- Builds on:
  [ADR-0037](0037-store-facts-with-a-separate-event-ledger.md),
  [ADR-0039](0039-use-typed-source-native-subject-identities.md),
  [ADR-0040](0040-establish-facts-through-registered-predicate-contracts.md),
  [ADR-0041](0041-enforce-three-information-classes-and-scoped-access.md),
  [ADR-0042](0042-use-rebuildable-projections-only-as-read-models.md), and
  [ADR-0043](0043-order-records-by-transaction-sequence-not-timestamps.md)
