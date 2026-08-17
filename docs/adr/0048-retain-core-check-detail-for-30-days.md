# 0048 — Retain Core check detail for 30 days

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

Manual Core synchronization already records two detailed occurrences and an
idempotency receipt for every eligible check or rejected candidate. Periodic
polling will turn that bounded per-attempt payload into unbounded database
growth unless Fluent owns a deterministic retention boundary before polling
starts.

Core snapshots and operator decisions are durable authority and audit history.
Automatic check and rejection detail is operational evidence: it is useful for
diagnosis and process baselines, but retaining every poll forever is not
required. Some otherwise-expired checks still anchor current readiness or are
cited by retained decisions and therefore cannot be removed with ordinary
detail.

## Decision

Fluent retains detailed eligible Core source checks and candidate rejections
for 30 days. It also retains at most the newest 10,000 purge-eligible check
transactions, so a fast polling configuration cannot exceed the time window's
intended volume. A check becomes purge-eligible when either it is older than
the 30-day cutoff or more than 10,000 newer purge-eligible checks exist.

The following are protected regardless of age and do not count against the
10,000 purge-eligible-detail limit:

- the latest automatic source check;
- the latest successful validation and latest substantive readiness outcome
  needed to reproduce current readiness;
- a check cited by any retained operator decision; and
- any future check evidence explicitly referenced by another retained
  authoritative record.

Core snapshots, snapshot bytes, activation and rollback history, operator
decisions and their events, and protected evidence are not subject to this
detail policy. Authority/reference retention wins if it causes total stored
checks to exceed 10,000.

Pruning is one typed deterministic maintenance command with optimistic
sequence binding. It deletes complete eligible check transactions: their paired
record/event occurrences, subtype rows, and command receipt. It never edits a
remaining occurrence, snapshot, decision, or sequence allocation and never
reuses a transaction sequence. The command emits a retained summary observation
and event containing the evaluation cutoff, count threshold, deleted
transaction and occurrence counts, deleted sequence bounds, a digest of the
deleted identities and payload digests, and the remaining detailed count.

Disposable projections are rebuilt from the post-prune authoritative source in
the same database transaction. A failure rolls back the deletions, audit
summary, sequence allocation, projections, and receipt together. An empty
prune still records its evaluated result so polling can prove retention ran.

## Consequences

- Periodic checks have a deterministic storage bound while current readiness
  and operator-decision evidence remain reproducible.
- Detailed diagnosis normally covers the preceding 30 days; older unprotected
  payloads cannot be recovered from Fluent after a committed prune.
- The retained prune digest proves exactly which occurrence identities and
  payload digests left the live database without retaining their diagnostics.
- Transaction order remains monotonic but may contain intentional historical
  gaps. Consumers must never infer corruption merely from a missing pruned
  sequence.
- Projection rebuild cost becomes part of pruning and must remain atomic.
- Protected cited evidence can make total check storage exceed 10,000; silently
  breaking a retained authority reference is worse than violating the ordinary
  detail target.

## Alternatives considered

- **Retain detail for 90 days:** rejected in favor of the operator-selected
  30-day diagnostic and baseline window.
- **Retain every check forever:** rejected because polling frequency would
  become unbounded database growth.
- **Use only a count limit:** rejected because the diagnostic time horizon
  would vary unpredictably with polling cadence.
- **Delete old records without an audit transaction:** rejected because live
  authoritative content would change without an attributable ordered cause.
- **Delete cited evidence to enforce an absolute total cap:** rejected because
  retained decisions and current readiness must remain independently
  verifiable.

## References

- Shapes: [Core snapshot ingestion](../design/core-snapshot-ingestion.md),
  [Core check-detail retention](../specs/core-check-detail-retention.md), and
  [Core snapshot ingestion plan](../plans/core-snapshot-ingestion.md)
- Product: [maintenance fleet PRD](../prd/agent-fleet.md)
- Builds on:
  [ADR-0014](0014-import-core-as-atomic-validated-snapshots.md),
  [ADR-0035](0035-route-human-authority-through-typed-decisions.md),
  [ADR-0037](0037-store-facts-with-a-separate-event-ledger.md),
  [ADR-0042](0042-use-rebuildable-projections-only-as-read-models.md),
  [ADR-0043](0043-order-records-by-transaction-sequence-not-timestamps.md),
  and [ADR-0046](0046-separate-core-source-freshness-from-admission-readiness.md)
