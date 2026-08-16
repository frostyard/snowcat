# 0026 — Coordinate enrolled repositories with FleetController

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

One RepositoryController preserves state and coordinates work for one enrolled
repository. Organization goals, shared features, and integration contracts
often span several repositories: a contract published by one project must match
a consumer's expectation, or several projects must change in a compatible
order to deliver one outcome.

Evaluating each repository independently cannot answer whether those boundaries
align or coordinate a multi-repository dependency graph. A continuously running
organization-level model would recreate the ambiguity removed by naming the
RepositoryController. Copying producer contracts and consumer expectations into
core would create stale competing sources of truth.

The product also needs precise terminology: repositories are `enrolled` in
Fluent, while work is `admitted` to the queue.

## Decision

`FleetController` is the canonical name for the deterministic code and durable
state that coordinate all repositories enrolled in one Fluent fleet. It is not
an LLM, prompt, conversation, provider session, or worker process. It remains
operational without a model endpoint and presents the aggregate of distinct
RepositoryControllers rather than replacing their local authority.

The FleetController owns:

- the enrolled repository inventory and exact RepositoryController snapshots;
- declared cross-repository producer, consumer, dependency, and ownership
  relationships;
- compatibility observations, verification results, and unresolved findings;
- organization goals, policies, knowledge, criteria, and exceptions applicable
  across repositories;
- multi-repository initiative plans and dependency progress; and
- aggregate readiness and outcome projections that retain each source fact.

Core is the canonical authority for declaring that a cross-repository
relationship exists. V1 stores strict JSON relationship declarations under
`organization/relationships/<relationship-id>.json`, validated by the canonical
schema at `organization/schemas/v1/relationship.schema.json`. A relationship
declaration is versioned operational configuration, like enrollment, not a
sixth organization context record.

An initial relationship declaration identifies its stable ID, lifecycle state,
purpose, accountable owners, producer repository and canonical contract
reference, one or more consumer repositories and canonical expectation or test
references, and required compatibility policy. Every repository reference
includes its immutable GitHub repository ID. Exact fields and bounded reference
grammar remain to be specified before implementation.

Core declares the relationship and compatibility intent but MUST NOT copy the
contract or consumer expectation. The producer repository owns its canonical
published contract; each consumer owns its canonical expectation or
compatibility test. Those artifacts must be added to a versioned repository-
surface contract before Fluent reads them. The FleetController evaluates all
sources at the exact commits selected by their RepositoryControllers.

A missing, invalid, unsupported, or mismatched repository artifact places only
that relationship on hold. It does not invalidate unrelated core records or
RepositoryControllers. A relationship cannot authorize enrollment, broaden a
repository action ceiling, override local policy, or make another repository's
contract authoritative for the producer.

Semantic comparison requiring judgment is performed by a bounded
`fleet-architecture` worker. An assessment examines one declared relationship,
contract surface, or common architectural outcome and cites every source
revision. Its result is an untrusted finding until deterministic contract tests,
schema comparison, other accepted verification, or accountable human review
confirms it. Mere structural difference is not a defect; the finding must cite
the declared compatibility policy, accepted direction, or measurable
cross-repository cost.

For a common feature or outcome, an accepted organization goal or human-
authorized PRD may produce a proposed versioned multi-repository delivery plan.
The FleetController validates that every target is enrolled and intersects each
slice with the target RepositoryController's effective policy. Operator approval
admits only the exact plan version. Each slice remains owned and executed through
its RepositoryController; fleet coordination cannot bypass local holds,
admission, evidence, or review.

Cross-repository delivery uses explicit dependencies and compatibility-first
sequencing by default: add a backward-compatible producer contract, adopt it in
consumers, verify adoption, then remove deprecated behavior in a later change.
Independent slices may proceed concurrently. Dependent pull requests do not
pretend to merge atomically and do not become eligible until their declared
predecessor signal is independently observed.

Aggregate fleet health is a projection, not an authoritative scalar judgment.
The FleetController exposes repository, relationship, initiative, context,
finding, artifact, and readiness states separately and retains their exact
sources.

## Consequences

- Fluent can answer cross-repository compatibility questions and coordinate
  shared outcomes without an always-running organization model.
- Core records reviewed relationship intent while producer and consumer
  repositories retain ownership of their actual artifacts.
- Cross-repository work remains constrained independently by every target
  repository.
- Compatibility-first sequencing makes partial rollout survivable but may take
  more pull requests and elapsed time.
- A held relationship does not stop unrelated repository maintenance.
- `fleet-architecture` adds a second bounded analysis scope beyond repository
  architecture while sharing its evidence discipline.
- Core needs a relationship schema and review policy; repository surfaces need
  canonical contract and expectation artifact types.
- Exact compatibility-policy vocabulary, artifact formats, verifier interface,
  plan schema, partial-failure recovery, and aggregate presentation remain open.

## Alternatives considered

- **Let each RepositoryController infer relationships:** rejected because
  neither side can establish organization intent or see the complete fleet
  dependency graph.
- **Run one organization-level LLM continuously:** rejected because durable
  coordination, authority, and memory must remain deterministic.
- **Copy all contracts into core:** rejected because copied artifacts drift from
  producer and consumer implementations and create competing authority.
- **Allow arbitrary declaration paths:** rejected because Fluent reads one
  canonical location for each artifact type and does not search repositories.
- **Treat repository uniformity as fleet health:** rejected because commonality
  is valuable only when accepted direction or compatibility needs justify it.
- **Merge cross-repository changes as if atomic:** rejected because GitHub pull
  requests across repositories have independent review, CI, and merge events.
- **Let fleet approval override local policy:** rejected because aggregate
  coordination cannot broaden repository authority.

## References

- Extends the per-repository deterministic boundary in
  [ADR-0020](0020-call-the-repository-coordinator-repositorycontroller.md) and
  architecture evidence rules in
  [ADR-0025](0025-ground-architecture-in-accepted-direction.md)
- Uses core authority and strict JSON authoring from
  [ADR-0007](0007-use-frostyard-core-as-the-organization-authority.md) and
  [ADR-0013](0013-author-organization-records-as-strict-json.md), atomic import
  from [ADR-0014](0014-import-core-as-atomic-validated-snapshots.md), enrollment
  from [ADR-0015](0015-authorize-repository-enrollment-through-core.md), and
  canonical repository surfaces from
  [ADR-0016](0016-read-only-canonical-repository-surfaces.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [FleetController and cross-repository coordination](../prd/agent-fleet.md#fleetcontroller-and-cross-repository-coordination)
- Implementation design, contract, and delivery plan: not yet authored
