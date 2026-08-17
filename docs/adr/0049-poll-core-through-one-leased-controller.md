# 0049 — Poll Core through one leased controller

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

Manual Core synchronization, source readiness, stale-source overrides, and
check-detail retention are implemented. V1 also requires configurable periodic
polling without models or GitHub webhooks. A polling loop must not overlap Git
inspection with another loop, must remain recoverable after a process crash,
and must not turn a persistent invalid commit into thousands of identical
diagnostic records.

Polling cadence is controller operational state, not Core authority. A poll run
may inspect the source again while the durable Core source-check outcome remains
unchanged. Conflating those concepts would either stop freshness from advancing
after successful unchanged checks or manufacture duplicate authority-readiness
evidence merely to prove the loop ran.

## Decision

Fluent runs periodic Core synchronization through one deterministic
`CoreSourceController`. Its healthy default interval is 15 minutes, measured
from completion of the prior run. The interval is host-configurable within a
bounded supported range. The controller awaits each run before scheduling the
next and acquires a durable ten-minute poll lease before any Git operation. A
second process reports the active lease or next due time and performs no Git
work. An expired lease may be recovered.

Every Git subprocess has a five-minute timeout, leaving time for validation and
atomic persistence before lease expiry. A successful, invalid, continuity-
blocked, or persistence-failed run schedules the next attempt at the healthy
interval. Consecutive `source-unavailable` outcomes schedule the next attempt
after 30 minutes, then 60 minutes, remaining at 60 minutes until a non-source-
unavailable result resets the streak.

Eligible checks remain durable on every successful poll because each one
advances source freshness. A consecutive candidate-invalid or
continuity-blocked result for the same candidate commit and same relevant
active commit is inspected but does not append another identical rejection
transaction. The controller records the suppressed disposition in its bounded
operational counters. A changed outcome, candidate commit, or relevant active
commit records new check detail.

The controller applies the accepted check-detail prune contract at most once
per 24 hours. Poll schedule, lease, completion, backoff, and suppression
counters live in one validated singleton operational-state row. They do not
establish authority, change admission readiness, or allocate a control-plane
transaction sequence. Backup integrity covers this state. This pre-production
schema change starts from a fresh database rather than migrating an earlier
target.

## Consequences

- Core changes normally become visible within 15 minutes without model work or
  webhook infrastructure.
- A source outage reduces repeated network load while the independent 24-hour
  freshness boundary continues to advance.
- Two controller processes cannot intentionally overlap a live poll, while a
  crashed process delays recovery by at most the remaining lease duration.
- Consecutive deterministic hard failures remain visible in controller state
  without consuming duplicate diagnostic history.
- Successful unchanged checks are intentionally not deduplicated because they
  are the evidence that refreshes source freshness.
- Operational state can change without a new authority transaction sequence;
  consumers must not interpret poll-run count as authority history.

## Alternatives considered

- **Rely on one process by convention:** rejected because an accidental second
  service instance could overlap Git and persistence work.
- **Hold a SQLite write transaction during Git inspection:** rejected because
  network work must not monopolize the control-plane writer lock.
- **Record every identical hard failure:** rejected because a persistent bad
  commit would create noise without changing readiness or diagnosis.
- **Suppress successful unchanged checks:** rejected because source freshness
  requires evidence of each later successful fetch and validation.
- **Back off every failure:** rejected because invalid and divergent authority
  should be noticed promptly when a correcting commit appears.
- **Use webhooks first:** rejected because polling is sufficient for v1 and
  avoids GitHub App delivery state before that integration is justified.

## References

- Shapes: [Core snapshot ingestion](../design/core-snapshot-ingestion.md),
  [Core source polling](../specs/core-source-polling.md), and
  [Core snapshot ingestion plan](../plans/core-snapshot-ingestion.md)
- Product: [maintenance fleet PRD](../prd/agent-fleet.md)
- Builds on:
  [ADR-0004](0004-keep-models-outside-the-control-path.md),
  [ADR-0014](0014-import-core-as-atomic-validated-snapshots.md),
  [ADR-0043](0043-order-records-by-transaction-sequence-not-timestamps.md),
  [ADR-0046](0046-separate-core-source-freshness-from-admission-readiness.md),
  and [ADR-0048](0048-retain-core-check-detail-for-30-days.md)
