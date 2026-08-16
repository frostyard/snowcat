# 0047 — Cap stale-source overrides at 24 hours

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

[ADR-0046](0046-separate-core-source-freshness-from-admission-readiness.md)
permits an attributed expiring decision to relax only the elapsed-time failure
of Core admission readiness. “Time-bounded” is not mechanically useful without
a maximum: an expiry years in the future would behave like a permanent
validation waiver, while a fixed very short window could make an ordinary
source outage operationally impractical.

The base freshness window is 24 hours. Continuing beyond it is a deliberate
degraded operation that should return to the operator's attention regularly,
without converting a temporary override into another authority source.

## Decision

Each stale-source override expires no later than 24 hours after its server
decision time. The operator chooses an exact canonical UTC expiry after the
decision time and at or before that maximum, supplies a bounded reason, and
binds the decision to the exact control-plane sequence, active Core snapshot,
latest automatic source check, and stale boundary evaluated in the decision
transaction.

Fluent issues an override only when readiness without an override is
`source-stale`. A current override does not prevent another attributed
decision, but each decision is independently limited to 24 hours from its own
issuance. Continued degraded operation therefore requires another explicit
operator decision and reason; expiry never renews itself.

The latest unexpired decision bound to the still-active snapshot may relax only
`source-stale`. A new active snapshot, hard readiness failure, expiry, backward
clock, or changed binding makes it inapplicable. An applicable override makes
readiness `ready` and `degraded`; it does not rewrite source checks, validation
time, staleness, snapshots, or prior decisions.

## Consequences

- No single override can silently authorize more than one additional day of
  organization-dependent discovery or admission.
- A long outage can continue only through repeated, attributable operator
  decisions, creating evidence that ProcessObserver can later evaluate.
- Operators may renew before the current decision expires, but cannot stack
  duration beyond 24 hours from the newest decision time.
- A source recovery still clears degraded readiness naturally; the retained
  decision remains historical evidence and never becomes authority for another
  snapshot.
- The CLI and store need exact expiry parsing, optimistic sequence binding,
  typed decision/event vocabulary, and conspicuous readiness output.

## Alternatives considered

- **Permit any future expiry:** rejected because a nominally expiring decision
  could become an effectively permanent bypass.
- **Cap the override at four hours:** rejected because it creates unnecessary
  operator churn during a bounded overnight or provider outage.
- **Cap the override at 72 hours:** rejected because it delays reconsideration
  well beyond the freshness window that triggered the stop.
- **Automatically renew while the source is unavailable:** rejected because
  operator absence is not continuing authorization.

## References

- Shapes: [Core snapshot ingestion](../design/core-snapshot-ingestion.md),
  [Core source readiness](../specs/core-source-readiness.md), and
  [Core snapshot ingestion plan](../plans/core-snapshot-ingestion.md)
- Product: [maintenance fleet PRD](../prd/agent-fleet.md)
- Builds on:
  [ADR-0014](0014-import-core-as-atomic-validated-snapshots.md),
  [ADR-0035](0035-route-human-authority-through-typed-decisions.md),
  [ADR-0043](0043-order-records-by-transaction-sequence-not-timestamps.md),
  and [ADR-0046](0046-separate-core-source-freshness-from-admission-readiness.md)
