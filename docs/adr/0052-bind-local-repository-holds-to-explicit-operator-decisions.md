# 0052 — Bind local repository holds to explicit operator decisions

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

Core lifecycle pause and disable provide reviewed fleet authority, but they are
too slow and externally dependent for an immediate safety intervention. The
operator therefore needs a local repository hold that can stop new activity
even while Core or GitHub is unavailable.

A generic toggle would lose the actor, reason, exact repository, affected
gates, and recovery act. An expiring emergency hold could also resume work
while the operator is absent. Replacing an active hold in place would obscure
which condition was cleared, while binding the hold only to one Core snapshot
would silently remove it after an unrelated organization change.

## Decision

Fluent represents a local repository hold as a resolved, typed operator
decision over one immutable GitHub repository identity. V1 permits at most one
active local operator hold per repository. Imposition records the current Core
authorization it narrows, the stored operator principal, a bounded reason,
decision time, the fixed affected gates `discovery`, `admission`, `claim`, and
`lease-renewal`, and the recovery rule `operator-clear`.

The hold has no expiry. Clearing it is a second resolved operator decision that
must name the exact active hold decision and the current Core authorization.
Fluent rejects replacement of an active hold, clearing an inactive or stale
hold, and either command for a repository without a materialized declaration
from the active Core snapshot. Core revision changes do not clear an active
hold; after new authority materializes, the same hold remains an independent
narrowing input.

Current hold applicability is a deterministic reduction over the repository's
ordered local-hold decisions, not a mutable enrollment flag. The status surface
shows the active decision separately and derives `operator-held` for an
otherwise active declaration. RepositoryController performs no GitHub or
surface inspection and establishes no enrollment while that hold applies.
Direct enrollment also fails closed.

An already-issued lease is not revoked by this hold. It cannot be renewed, and
its later report does not restore authority or admit follow-up work. Clearing
the hold only removes this one narrowing input; it does not clear Core pause,
GitHub or surface failures, andons, policy denials, or held-work disposition.

## Consequences

- The operator gets a host-local kill switch whose scope and recovery are
  always visible and attributable.
- An outage or operator absence cannot expire the intervention into implicit
  resumption.
- Fixed gates make the v1 safety effect predictable but do not support a
  gentler partial repository hold; drains remain the appropriate later tool.
- A changed Core snapshot cannot accidentally erase an emergency condition.
- Explicit clear is slightly more cumbersome and intentionally does not make
  stale queued work claimable.
- The control registry, status projection, CLI, startup verification, and
  RepositoryController must understand the decision chain.

## Alternatives considered

- **Mutable held boolean:** rejected because it erases attribution, recovery,
  and the exact authority narrowed by the intervention.
- **Operator-selected gate subset:** rejected for v1 because an under-scoped
  emergency hold could leave another new-work path active.
- **Expiring hold:** rejected because operator absence is not authorization to
  resume; expiring graceful intervention belongs to drain.
- **Replace an active hold:** rejected because clear-then-impose preserves the
  identity and reason for each authority act.
- **Clear on Core activation:** rejected because an unrelated organization
  update must not remove a local safety condition.

## References

- Shapes: [repository enrollment](../design/repository-enrollment.md),
  [local repository hold contract](../specs/repository-local-holds.md), and
  [Core snapshot ingestion plan](../plans/core-snapshot-ingestion.md)
- Builds on: [ADR-0015](0015-authorize-repository-enrollment-through-core.md),
  [ADR-0035](0035-route-human-authority-through-typed-decisions.md),
  [ADR-0037](0037-store-facts-with-a-separate-event-ledger.md), and
  [ADR-0038](0038-separate-lifecycle-pause-from-runtime-interventions.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md#repository-enrollment)
