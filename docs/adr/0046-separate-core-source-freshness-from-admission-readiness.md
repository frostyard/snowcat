# 0046 — Separate Core source freshness from admission readiness

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

[ADR-0014](0014-import-core-as-atomic-validated-snapshots.md) measures Core
freshness from the last successful fetch and validation of the configured ref
and stops new organization-dependent discovery and admission after 24 hours.
That elapsed-time rule does not cover a more immediate failure: the configured
ref can fetch and validate successfully while naming a commit that is not a
descendant of the active authority. The same separation exists when validated
bytes cannot be persisted.

Treating every successful validation as permission to admit would leave Fluent
using known-divergent organization authority. Treating every source outage as
an immediate stop would discard the deliberate last-known-good operating
window. A stale-source override also needs a boundary that cannot turn it into
a general bypass for invalid or divergent authority.

## Decision

Fluent records Core source freshness separately from Core admission readiness.
Source freshness is the elapsed time since the configured ref last fetched and
validated successfully. A source-unavailable result does not immediately make
admission unready; it leaves that clock advancing toward the default 24-hour
maximum staleness.

Core admission readiness is the deterministic gate for creating goal-derived
discovery or admitting new work that depends on organization context. It
requires an active Core snapshot and is blocked immediately by the latest
automatic source check ending in candidate invalidity, source-continuity
rejection, or persistence failure. A later successful automatic check that
confirms or activates eligible authority clears the corresponding block.
Existing admitted work and reads of retained context continue while this gate
is blocked.

An attributed operator rollback is an authority transition, not a freshness
override. When it activates the exact validated commit named by a continuity
rejection, it resolves that continuity block but does not manufacture a newer
configured-ref fetch or validation time.

A stale-source override may bypass only the elapsed-time failure of Core
admission readiness. It is a typed, attributed, reasoned decision with a local
expiry and conspicuous degraded-state reporting. It cannot bypass a missing
active snapshot, invalid candidate, unresolved continuity rejection, or
persistence failure. Local evaluation time continues to advance during source
outage and therefore expires the override normally.

Readiness evaluation records the exact control-plane sequence, active snapshot,
latest automatic source-check outcome, last successful fetch-and-validation
time, evaluation time, maximum staleness, and applicable override decision.
Callers receive the specific reason for an unready result rather than a single
ambiguous health flag.

## Consequences

- A freshly validated force-pushed branch cannot authorize new work merely by
  refreshing an elapsed-time clock.
- Temporary source outages retain the bounded last-known-good behavior chosen
  in ADR-0014.
- Operators cannot use a stale-source override to accept invalid bytes, bypass
  Git ancestry, hide a failed authority transaction, or create initial
  authority.
- Fluent must distinguish automatic configured-ref checks from read-only
  verification and exact-commit rollback attempts in its durable vocabulary.
- Admission and discovery code gain one mandatory readiness precondition and
  must preserve the evaluated evidence with their decisions.
- Readiness has more states than a Boolean, but its failures become actionable
  and auditable.

## Alternatives considered

- **Use validation freshness as admission readiness:** rejected because a
  valid non-descendant candidate would appear healthy while Fluent knowingly
  retained different authority.
- **Block immediately on every source outage:** rejected because ADR-0014
  deliberately permits bounded operation from the last known-good snapshot.
- **Let the stale-source override bypass every failure:** rejected because it
  would become an unattributed substitute for validation, rollback, and
  successful persistence.
- **Measure freshness from snapshot activation:** rejected because an unchanged
  configured ref can be checked successfully without creating another
  authority transition.

## References

- Shapes: [Core snapshot ingestion](../design/core-snapshot-ingestion.md),
  [Core source readiness](../specs/core-source-readiness.md), and
  [Core snapshot ingestion plan](../plans/core-snapshot-ingestion.md)
- Product: [maintenance fleet PRD](../prd/agent-fleet.md)
- Builds on:
  [ADR-0014](0014-import-core-as-atomic-validated-snapshots.md),
  [ADR-0035](0035-route-human-authority-through-typed-decisions.md),
  [ADR-0040](0040-establish-facts-through-registered-predicate-contracts.md),
  and [ADR-0043](0043-order-records-by-transaction-sequence-not-timestamps.md)
