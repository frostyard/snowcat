# 0010 — Enforce policies monotonically with expiring exceptions

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

[ADR-0008](0008-use-five-organization-record-kinds.md) distinguishes mandatory
policy from advisory knowledge and introduces explicit, expiring exceptions.
Unlike a goal, a policy must affect whether work is acceptable or which actions
it may take. That makes policy interpretation part of Fluent's authority
boundary.

Free-form model interpretation is not an enforcement mechanism. Some policy
requirements can be verified deterministically, while others require an
accountable human review. Fluent must make that difference visible rather than
accept a worker's claim that it complied.

Exceptions create another boundary. If an exception could widen Fluent's
platform ceiling, override unrelated policies, or remain usable after its
expiry, it would become a less visible route for granting permanent authority.

## Decision

Each policy contains one or more requirements with stable requirement
identifiers. The policy declares its lifecycle, owner, applicability, effective
date, rationale, required evidence, and the queue checkpoints at which each
requirement applies.

Every requirement declares one of two verification modes:

- **Deterministic:** a named, versioned verifier evaluates the requirement at
  its declared checkpoint. An unknown verifier, invalid input, or verifier
  error fails closed.
- **Review required:** an authorized actor records an explicit attestation at
  the declared checkpoint. A worker or model assertion is evidence for the
  reviewer, not the attestation itself.

There is no model-enforced mode. Initial checkpoints may include admission,
claim, and completion or artifact review; their exact contract belongs in the
future organization-context specification.

For each transition, Fluent deterministically selects policies by lifecycle,
effective time, and declared applicability, then produces a policy decision
containing the requirements considered, verifier or attestation results,
applicable exceptions, and exact `frostyard/core` revision. The operator and
worker receive a bounded projection of that decision with stable citations,
not an invitation to reinterpret the entire policy catalog.

Policy is monotonic with respect to authority. It may remove actions, add
obligations, or reject a transition, but it cannot grant an action forbidden by
Fluent's platform ceiling, repository enrollment, root authority, parent
delegation, or another applicable policy. The most restrictive applicable
result wins. Unsatisfied or contradictory requirements block the relevant
transition for operator resolution; a model does not choose precedence.

An exception names one exact policy requirement or one exact criteria-set
criterion and version. It also declares an owner, approving authority,
rationale, applicability no broader than its target, inclusive start and end
dates, and compensating controls. An exception waives only its named target. It
cannot waive repository opt-in, Fluent's platform action ceiling, root or
parent delegation, or any other applicable requirement.

Exception validity is re-evaluated at admission, claim, and lease renewal. A
lease relying on an exception cannot extend beyond that exception's end time.
Expiry or explicit revocation makes affected unclaimed work ineligible and
prevents renewal, but does not delete the item or its history. Fluent surfaces
the conflict so the operator can reject, defer, cancel, or re-admit the work
under valid context. A terminal report may still be retained as provenance;
expired authority cannot create follow-up authorization.

Admission snapshots the policy decision used for historical explanation.
Ordinary later policy edits affect future admissions by default and do not
silently rewrite admitted work. The operator must explicitly reconcile and
defer, cancel, or re-admit existing items when a changed policy should apply to
them. Exception status and expiry remain live eligibility checks because the
known limit is part of the original admission decision.

## Consequences

- Policy decisions are explainable in terms of stable requirements, verifiers,
  attestations, exceptions, and a Git revision.
- A repository policy cannot accidentally grant capabilities beyond the queue
  item's existing authority.
- Requirements that cannot be checked mechanically remain honest human review
  gates instead of becoming model assertions disguised as validation.
- Exceptions are narrow, attributable, compensating, and operationally
  expiring. Attaching one exception cannot suppress unrelated constraints.
- Work depending on an expiring exception may become ineligible while queued;
  the UI must make that dependency and deadline obvious before admission.
- Fluent needs a policy-decision model, verifier registry, attestations,
  exception-aware lease bounds, and reconciliation tooling. None is implemented
  by the current queue.

## Alternatives considered

- **Provide policy text only as worker context:** rejected because mandatory
  requirements would depend entirely on a worker's interpretation and report.
- **Ask a model whether work complies:** rejected because model output cannot
  authorize state transitions and is not a stable verifier.
- **Let policy grant new actions:** rejected because organization context must
  not widen the authority explicitly attached to a root or delegated by a
  parent.
- **Let a broad exception override a policy:** rejected because it obscures
  which requirement was waived and encourages accidental privilege expansion.
- **Freeze exception validity for the life of admitted work:** rejected because
  work admitted immediately before expiry could exercise waived constraints
  indefinitely.
- **Retroactively apply every policy edit to queued work:** rejected because it
  silently changes prior admission decisions and may make the queue unstable.
  Explicit reconciliation preserves control and auditability.

## References

- Defines policy and exception semantics for
  [ADR-0008](0008-use-five-organization-record-kinds.md) and preserves the
  revisioned authority in
  [ADR-0007](0007-use-frostyard-core-as-the-organization-authority.md)
- Preserves deterministic control from
  [ADR-0004](0004-keep-models-outside-the-control-path.md), operator admission
  from [ADR-0005](0005-admit-worker-created-work-before-claiming.md), and
  database enforcement from
  [ADR-0006](0006-enforce-admission-in-the-database.md)
- Product: [maintenance fleet PRD](../prd/agent-fleet.md), especially
  [policy and exception enforcement](../prd/agent-fleet.md#policy-and-exception-enforcement)
- Implementation design, contract, and delivery plan: not yet authored
