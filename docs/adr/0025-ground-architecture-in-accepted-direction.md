# 0025 — Ground architecture in accepted direction

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

Architecture is the fourth initial maintenance program. An unbounded architect
prompt can turn personal preference into organization direction, produce broad
refactors with unclear value, or change public behavior under a maintenance
label. Hive gives its architect a clear structural remit, but Fluent must also
connect that work to versioned core direction and its existing policy,
readiness, and feature-delivery boundaries.

Architecture overlaps quality on local maintainability, CI on build structure,
security on trust boundaries, and feature delivery on public behavior and
product intent. It needs a bounded responsibility that can guide repositories
toward common standards without declaring every difference a defect.

## Decision

The architecture specialist reduces structural risk and guides a repository
toward accepted organization and repository direction without inventing
product intent. Its canonical role name is `architecture`.

Architecture owns:

- component, package, and subsystem boundaries;
- dependency direction, cycles, coupling, and cohesion;
- public and internal interface structure;
- data ownership and flow;
- cross-cutting duplication and structural technical debt;
- scalability, operability, and evolvability constraints;
- conformance with applicable accepted organization criteria and standards; and
- incremental structural migration plans.

An architect's preference is not a standard. A standards-based finding MUST
cite the exact accepted core goal, policy, knowledge record, criteria version,
or repository-owned decision that establishes the target direction. A finding
without such direction may still cite concrete repository evidence of risk or
cost, but it must present the target as a proposal rather than accepted
organization intent.

Each assessment examines one bounded component boundary, dependency direction,
interface, data flow, accepted standard, or structural hotspot at exact core and
repository revisions. It does not ask for a whole-system architecture review.
“No material structural concern in the examined boundary” is a valid result.

An architecture finding identifies:

- the current structure with exact code and document references;
- the concrete structural problem and observed cost or risk;
- the accepted directional source or an explicit statement that the target is
  only proposed;
- affected components, consumers, contracts, and protected boundaries;
- a bounded target state and incremental migration path;
- preserved behavior, compatibility requirements, and non-goals;
- validation, rollback, and completion evidence; and
- uncertainty, risk tier, and adjacent-program routing.

Local testability and small local simplification remain with quality. CI owns
workflow execution unless the finding concerns a broader build-system
boundary. Security owns threat, abuse, and trust consequences. Product intent,
public behavior changes, public API changes, and broad product migrations route
to feature delivery even when architecture advice shapes their plans.

Separately admitted architecture work may propose an ADR, issue, migration
plan, or bounded behavior-preserving refactor pull request. A proposed ADR does
not become accepted direction because an agent authored it; the repository's
human review and merge path makes that decision. Architecture authority MUST
NOT introduce product capability, silently break a consumer, or turn a broad
migration into a sequence of maintenance PRs that bypasses delivery-plan
approval.

Resolution requires evidence that the bounded structural condition and its
named consequences changed at an exact later revision. An ADR, issue, plan, or
partially completed refactor does not itself establish conformance or remove
the original risk.

## Consequences

- Architecture guidance can be traced to accepted direction or clearly labeled
  as a proposal.
- Repositories can evolve incrementally without equating architectural health
  with uniformity.
- Public behavior and broad migrations receive feature-delivery planning rather
  than lower-friction maintenance authority.
- Proposed ADRs remain useful artifacts while human merge retains decision
  ownership.
- Boundaries with quality, CI, and security reduce duplicate or contradictory
  work.
- Exact structural selectors, dependency-graph extraction, materiality rules,
  accepted-decision discovery, and the threshold for routing to delivery remain
  to be defined.

## Alternatives considered

- **Let the architect define organization standards:** rejected because model
  preference would become durable direction without core review.
- **Treat every repository difference as drift:** rejected because different
  products may need different structures and standardization has a cost.
- **Permit any behavior-preserving refactor:** rejected because “preserving” is
  often asserted too broadly and large migrations need explicit planning.
- **Put public API migrations under maintenance:** rejected because consumers,
  compatibility, sequencing, and product intent require feature-delivery
  controls.
- **Limit architecture to advisory issues:** rejected because a small, clearly
  evidenced structural refactor can be appropriate v1 pull-request work.
- **Treat a merged ADR as completed architecture work:** rejected because the
  decision artifact does not prove implementation or risk reduction.

## References

- Specializes the bounded maintenance loop in
  [ADR-0021](0021-run-bounded-maintenance-assessments.md)
- Applies core authority and context kinds from
  [ADR-0007](0007-use-frostyard-core-as-the-organization-authority.md) and
  [ADR-0008](0008-use-five-organization-record-kinds.md), with canonical risk
  controls from
  [ADR-0017](0017-standardize-actions-boundaries-and-risk.md)
- Maintains the specialist boundaries defined by
  [ADR-0022](0022-focus-quality-on-local-correctness.md),
  [ADR-0023](0023-base-ci-maintenance-on-observed-runs.md), and
  [ADR-0024](0024-restrict-security-findings-before-disclosure.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [architecture-maintenance workflow](../prd/agent-fleet.md#architecture-maintenance-workflow)
- External input: [Hive architect full policy](https://github.com/kubestellar/hive/blob/v4/v2/policies/architect-full.md)
- Implementation design, contract, and delivery plan: not yet authored
