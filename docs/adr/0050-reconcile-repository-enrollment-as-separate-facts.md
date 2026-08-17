# 0050 — Reconcile repository enrollment as separate facts

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

An active Core snapshot can contain a valid repository declaration while the
declared GitHub locator is missing, renamed, transferred, archived, or points
at a different immutable repository identity. Required canonical repository
surfaces can also be absent or invalid. Treating snapshot activation as one
indivisible enrollment flag would hide those distinctions and could grant
authority before external evidence exists.

Core activation must remain atomic and available when GitHub is unavailable.
Conversely, a GitHub observation must not create fleet authority for a
repository that the active Core snapshot does not declare. Reconciliation also
needs to converge after a crash without one repository failure blocking other
declarations.

## Decision

Fluent reconciles repository enrollment through independently registered fact
families on the immutable `github-repository` subject:

1. `repository.core-authorized` materializes one exact declaration from the
   active Core snapshot. It binds the snapshot, source commit, declaration
   path, declaration digest, fleet state, programs, action ceiling, accountable
   owners, and surface-contract version.
2. `repository.github-identity-reconciled` records the deterministic result of
   looking up the declaration's mutable owner/name locator through the GitHub
   metadata adapter and comparing the returned immutable ID, canonical locator,
   and archive state.
3. A later canonical-surface predicate will bind required files and policy at
   one exact repository commit. Until it exists and passes, an enabled,
   identity-matched repository is `awaiting-surfaces`, not enrolled.

Each declaration and each GitHub result is handled by its own idempotent SQLite
transaction. One failed or unavailable GitHub lookup therefore cannot roll
back Core authority, invalidate another repository, or partially write one
repository result. Commands bind the active snapshot, the exact prior
control-plane sequence, and the authority fact they consume.

Repository declarations may change only through a newer active Core snapshot.
A later snapshot must retain every repository identity declared by the current
snapshot; removal is invalid even during an operator rollback. Intentional
departure remains an explicit `disabled` declaration.

GitHub lookup retains only bounded selected metadata and a digest, never the
raw response or credentials. Its closed results are `matched`, `missing`,
`locator-mismatch`, `identity-mismatch`, `archived`, and `unavailable`.
Case-only locator differences are equivalent because GitHub owner/name routing
is case-insensitive; any other locator difference requires a Core change.

The read model derives one non-authoritative effective repository state from
the active declaration and latest applicable facts: `awaiting-authority`,
`disabled`, `paused`, `awaiting-github`, `github-held`, or
`awaiting-surfaces`. It deliberately has no `enrolled` state
until canonical-surface validation lands. No command in this slice creates
work, claims, leases, or a worker session.

## Consequences

- Core authority and external identity evidence remain independently visible
  and cannot conceal each other's failures.
- GitHub outages create scoped, retryable reconciliation evidence instead of
  blocking snapshot activation.
- Repository removals fail before an active declaration silently disappears.
- The control plane gains source-native GitHub repository subjects and exact
  declaration/metadata revision bindings.
- Reconciliation can commit several repository transactions for one snapshot;
  an interrupted run is intentionally partially progressed but idempotently
  resumable.
- An identity match is not yet enrollment. Canonical surfaces, local holds,
  and held-work disposition remain explicit subsequent gates.

## Alternatives considered

- **One broad enrollment status:** rejected because it collapses Core
  authorization, GitHub truth, surface validity, and holds into one mutable
  value.
- **Perform GitHub calls inside Core activation:** rejected because external
  latency or outage would prevent unrelated organization authority from
  activating.
- **Reconcile all repositories in one transaction:** rejected because one
  scoped failure would block progress for every declaration and hold a writer
  transaction across external calls.
- **Treat immutable-ID match as enrollment:** rejected because the PRD also
  requires canonical repository surfaces and local governance at an exact
  commit.
- **Permit deletion during operator rollback:** rejected because rollback is
  not authority to erase an enrolled repository's explicit lifecycle record.

## References

- Shapes: [repository enrollment design](../design/repository-enrollment.md),
  [repository authority reconciliation](../specs/repository-authority-reconciliation.md),
  and [Core snapshot ingestion plan](../plans/core-snapshot-ingestion.md)
- Builds on: [ADR-0015](0015-authorize-repository-enrollment-through-core.md),
  [ADR-0016](0016-read-only-canonical-repository-surfaces.md),
  [ADR-0039](0039-use-typed-source-native-subject-identities.md),
  [ADR-0040](0040-establish-facts-through-registered-predicate-contracts.md),
  and [ADR-0046](0046-separate-core-source-freshness-from-admission-readiness.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md#repository-enrollment)
