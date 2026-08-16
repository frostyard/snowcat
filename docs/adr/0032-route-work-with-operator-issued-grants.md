# 0032 — Route work with operator-issued grants

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

Fluent needs both repository-dedicated workers and specialist workers operating
across a fleet. Those are operator-started coding-agent sessions, not durable
RepositoryControllers or Fluent-managed processes. A provider or client may be
suited to some work and not other work, but provider names and worker
self-description cannot safely establish authority or capability.

The queue spike currently lets a caller supply a worker identity and optional
repository or kind filters, then asks the worker skill to release work it cannot
perform. That proved portable consumption but exposes a brief and consumes a
lease before compatibility is known. It also cannot safely route restricted
security work or distinguish a deliberate repository assignment from a
caller-provided preference.

[ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md) already
requires server-bound principal and session identity while treating provider,
model, and caller strings as metadata. Routing needs the corresponding
server-side authorization object.

## Decision

Fluent routes claimable work through a short-lived, operator-issued `worker
grant`. A grant is an immutable authorization snapshot stored in Fluent's
durable operational state and bound to one authenticated principal and one
server-assigned worker session. It is not a credential for a coding provider,
a `frostyard/core` organization record, or a reusable agent persona.

In the initial local-stdio deployment, Fluent may create the grant through an
operator-only local command and bind the operator principal implicitly. Remote
transport MUST authenticate the principal before grant issuance. Named members
may issue or receive grants only after a separate role policy explicitly allows
it.

A worker grant records at least:

- immutable grant, principal, and worker-session identities;
- issuer, issuance time, expiry, revocation state, and reason history;
- one grant shape: `repository-dedicated` or `fleet-specialist`;
- exact immutable enrolled repository IDs in scope;
- allowed work roles and versioned capability-profile references;
- maximum risk tier, allowed actions, and information-access classes; and
- the core snapshot, repository-policy decisions, and role policy that limited
  the grant when it was issued.

A `repository-dedicated` grant names exactly one repository and one or more
permitted roles. A `fleet-specialist` grant names exactly one specialist role
and an explicit non-empty set of enrolled repositories. “All current and
future repositories” is not a valid v1 scope: later enrollment MUST NOT silently
broaden an existing grant. Reissuing a grant is cheap and preserves an
attributed scope change.

These shapes constrain a session; they do not imply a persistent process,
provider assignment, exclusive repository lock, free-form memory, or a new
controller. Repository continuity remains in the RepositoryController, so
different capable clients may perform successive items under independently
issued grants.

Each claimable work item declares routing requirements separately from its
instructions: immutable repository ID, work role, versioned required
capabilities, risk tier, requested actions, information-access class, and any
independence constraints such as “not the implementation session.” These fields
are fixed by admission or an authorized deterministic controller and cannot be
selected or weakened by a worker.

Capability names come from one versioned Fluent vocabulary. In v1, an
authorized operator assigns versioned capability profiles to a grant. Provider,
client, model, installed-tool, local-environment, and worker-supplied capability
claims remain descriptive metadata. Work history and observed outcomes may be
shown to the operator when issuing a later grant but MUST NOT automatically add
a capability, repository, role, risk tier, action, or information class.

Before listing a work brief or claiming it, Fluent deterministically requires
all of the following:

- the grant and session are current, unrevoked, and bound to the authenticated
  principal;
- the repository is both enrolled and explicitly present in the grant;
- the required role and every required capability are present;
- work risk does not exceed the grant ceiling;
- every requested action and information class is allowed by the grant; and
- current repository and organization policy, holds, independence rules,
  dependency state, admission state, and work-specific eligibility all pass.

Matching is an intersection, never a union: the work item, grant, current
policy, and existing v1 product ceiling each may remove authority, and none may
add authority absent from another required source. Unknown capability,
repository, role, risk, action, or information values fail closed.

An authenticated session may list only eligible work summaries. Ineligible or
restricted items MUST NOT disclose objectives, instructions, evidence, lineage,
or existence beyond aggregate operator views the principal is separately
authorized to see. A claim leases at most one eligible item. The default claim
path selects the highest-ranked eligible item using deterministic operator-
owned priority and stable server-side tie breaking; a provider or model MUST
NOT rank the global queue. Any future targeted-claim interface still MUST apply
the complete eligibility predicate.

Grant expiry bounds every lease. Revocation or expiry immediately prevents new
claims and lease renewal; completion or artifacts arriving afterward remain
stale provenance and do not recover authority. Every mutation rechecks the
current grant, session, lease, and effective policy. Revocation does not erase
the attempt, evidence, or artifact history.

The operator may narrow or revoke access at any time. Broadening requires a new
grant rather than mutation of an in-use authorization snapshot. A worker cannot
issue, renew, modify, delegate, or select its own grant, and follow-up work does
not inherit the worker grant; it passes through ordinary proposal, admission,
and later routing.

## Consequences

- Repository-dedicated and fleet-specialist workers share one portable routing
  and claim protocol.
- Briefs are matched before disclosure and lease creation, eliminating normal
  claim-and-release churn for capability mismatch.
- Provider choice remains flexible without becoming an authorization system.
- Exact repository snapshots prevent future enrollment from expanding a live
  specialist's reach.
- Restricted security work can be withheld from sessions without the required
  information class.
- Immutable, short-lived grants make scope changes and revocation attributable
  but add an operator grant-issuance step.
- A dedicated worker is a scoped session rather than a daemon, so Fluent still
  does not manage capable-agent processes.
- V1 relies on operator-assigned capability profiles; it does not automatically
  discover whether a client is genuinely capable.
- The current queue skill and MCP claim contract will require a future
  implementation change from caller-supplied identity and mismatch release to
  server-bound sessions and pre-claim routing.
- Exact capability vocabulary, profile schema, grant lifetime, priority aging,
  information classes, and operator UX remain open.

## Alternatives considered

- **Assign one permanent provider process per repository:** rejected because it
  reintroduces process, credential, and provider lifecycle management.
- **Trust a worker's capability declaration:** rejected because a prompt or
  client flag cannot establish competence or authority.
- **Route by provider or model name:** rejected because provider identity is a
  poor capability proxy and would make the product vendor-dependent.
- **Let a specialist grant cover future enrollments automatically:** rejected
  because repository enrollment would silently expand an active session's
  authority.
- **Lease first and let workers release mismatches:** rejected as the product
  design because it exposes unnecessary details, wastes leases, and cannot
  protect restricted work reliably.
- **Use successful history to expand grants automatically:** rejected because
  past performance is evidence for an operator, not consent to broader access.
- **Store worker grants in core:** rejected because short-lived session
  authorization and revocation are operational state, while core remains the
  Git-backed authority that constrains organization and repository policy.

## References

- Builds on the execution boundary in
  [ADR-0003](0003-separate-work-coordination-from-execution.md), deterministic
  authority in [ADR-0004](0004-keep-models-outside-the-control-path.md), and
  server-bound identity in
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md)
- Applies enrollment and policy from
  [ADR-0015](0015-authorize-repository-enrollment-through-core.md) and
  [ADR-0017](0017-standardize-actions-boundaries-and-risk.md), including
  restricted security handling from
  [ADR-0024](0024-restrict-security-findings-before-disclosure.md)
- Routes repository and fleet work coordinated by
  [ADR-0020](0020-call-the-repository-coordinator-repositorycontroller.md) and
  [ADR-0026](0026-coordinate-enrolled-repositories-with-fleetcontroller.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [worker grants and deterministic routing](../prd/agent-fleet.md#worker-grants-and-deterministic-routing)
- Current implementation context:
  [queue execution boundary](../design/queue-execution-boundary.md),
  [work queue contract](../specs/work-queue.md), and
  [queue vertical spike](../plans/queue-vertical-spike.md)
