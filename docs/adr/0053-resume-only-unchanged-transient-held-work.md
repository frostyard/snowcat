# 0053 — Resume only unchanged transient held work

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

Repository work can become ineligible while GitHub metadata or canonical
surfaces are temporarily unavailable. Requiring the operator to reconcile
every short outage would turn normal recovery into inbox noise. Automatically
resuming every item when a repository later appears healthy is unsafe: Core
authority, the exact repository commit, canonical contracts, action ceilings,
or other inputs may have changed while work was held.

Core pause or disable and a local operator hold are deliberate authority acts,
not availability failures. A missing, moved, mismatched, archived, or
surface-invalid repository is also a substantive failed check rather than a
transient outage. Treating any of those as automatically recoverable would
erase the reason work stopped.

## Decision

Fluent binds eligible repository work to a versioned repository
authority-context digest. The digest covers the semantic inputs that established
enrollment: the exact Core snapshot and declaration, repository identity,
default branch and commit, canonical surface and governance contracts,
enrollment checkpoint result and evidence, maintenance programs, and action
ceiling. It excludes server record identities, evaluation times, and retry
occurrences so an equivalent successful reconciliation reproduces the same
digest.

Work held solely because GitHub metadata or canonical surfaces were
`unavailable` resumes automatically after successful reconciliation only when
the current repository is enrolled and its authority-context digest exactly
matches the digest bound before the outage. Until both conditions are true the
work remains held.

Core pause, Core disable, a local operator hold, any non-availability
reconciliation failure, and any changed authority-context digest never
auto-resume held work. Recovery creates or uses one attributed per-item
operator decision whose v1 choices are `resume` under the current exact context
or `cancel`. The decision cannot clear the underlying repository condition;
the repository must already be enrolled before either recovery path can make
work claimable.

An existing lease is not revoked by a repository hold, but renewal is denied.
A late report remains provenance and cannot admit follow-up work or manufacture
resumption. Automated and operator recovery are auditable transitions; neither
rewrites the original hold or work authorization.

## Consequences

- Brief source outages can recover without repetitive operator work.
- Automatic recovery is fail-closed across every meaningful authority or
  repository-content change.
- Intentional pauses and holds retain their human meaning after their
  repository-level condition clears.
- Target work records must retain the prior authority-context digest and hold
  cause; display status alone is insufficient.
- Equivalent semantic retries need a stable digest contract, while any future
  new authority input requires a digest-version change.

## Alternatives considered

- **Always require operator reconciliation:** rejected because ordinary
  transient outages would create low-value decision load.
- **Resume whenever repository status returns to enrolled:** rejected because
  changed authority or content could silently inherit stale work.
- **Resume all conditions when the digest is unchanged:** rejected because a
  Core pause, disable, or operator hold is an intentional authority act whose
  recovery must remain attributed.
- **Digest durable record IDs and timestamps:** rejected because equivalent
  retry observations would create a false context change.

## References

- Shapes: [repository enrollment](../design/repository-enrollment.md),
  [held-work recovery contract](../specs/repository-held-work-recovery.md),
  [control-plane kernel bootstrap](../plans/control-plane-kernel-bootstrap.md),
  and [Core snapshot ingestion plan](../plans/core-snapshot-ingestion.md)
- Builds on: [ADR-0015](0015-authorize-repository-enrollment-through-core.md),
  [ADR-0034](0034-schedule-a-bounded-ready-inventory.md),
  [ADR-0035](0035-route-human-authority-through-typed-decisions.md),
  [ADR-0038](0038-separate-lifecycle-pause-from-runtime-interventions.md), and
  [ADR-0052](0052-bind-local-repository-holds-to-explicit-operator-decisions.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md#repository-enrollment)

