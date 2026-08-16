# 0019 — Include feature delivery in v1

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

Fluent's initial maintenance programs cover continuous quality improvement, CI,
security, and architecture. They provide a bounded proving ground for queueing,
policy, provenance, and capable-worker handoff, but maintenance alone does not
cover an important repository-agent outcome: giving Fluent an approved PRD and
receiving an ordered series of reviewable implementation pull requests.

Hive partially covers feature implementation through its scanner role, which
treats human-filed feature and enhancement issues as implementation work at
higher ACMM levels. Its policy set does not define the preceding durable path
from a PRD through decomposition into ordered work.

Leaving feature delivery in an unspecified `v.next` would make it easy to omit
from the product after the maintenance foundation is complete. Defining its
entire workflow now would interrupt the current task of understanding the
repository workstream and each maintenance-agent responsibility.

## Decision

Feature delivery is an explicit v1 program. For an opted-in repository where
the program is enabled, Fluent v1 will accept a human-authorized PRD, coordinate
its decomposition into bounded and ordered implementation work, and allow
capable workers to open the resulting pull requests. V1 still never authorizes
merge, release, or deployment.

The detailed feature-delivery workflow will be defined during discovery after
the repository workstream and maintenance-agent workflows have been specified.
This is an ordering decision for product discovery and implementation planning;
it imposes no requirement that maintenance work run before feature work during
normal Fluent operation.

The later workflow definition must resolve at least:

- the canonical PRD source, lifecycle, and exact revision Fluent accepts;
- the planning roles and how they use strategist and architect advice;
- the versioned representation of slices, dependencies, acceptance criteria,
  risk, and required evidence;
- the human approval boundary for a plan and its amendments;
- when independent work may proceed concurrently and when dependent work must
  wait for merge or another acceptance signal; and
- how the repository steward reports initiative progress and completion.

Until those decisions are accepted, a PRD MUST NOT directly create claimable
implementation work. Existing proposal admission, policy, action ceilings,
worker identity, and artifact verification continue to apply.

## Consequences

- Feature delivery cannot disappear into a future-version backlog while the
  maintenance workflows are refined.
- The maintenance vertical workflow remains the first implementation proving
  ground without defining the complete product boundary.
- Discovery can reuse lessons from the maintenance roles before fixing the
  planner and implementer contracts.
- The PRD must distinguish human-approved feature delivery from autonomous
  feature invention.
- V1 scope is larger than maintenance alone, while its exact delivery contract
  remains an explicit open design task.

## Alternatives considered

- **Defer feature delivery to `v.next`:** rejected because PRD-to-PR delivery is
  a desired core repository-agent outcome.
- **Fully specify feature delivery before maintenance roles:** rejected because
  the maintenance workflows will establish reusable work, evidence, policy,
  and stewardship patterns.
- **Put feature delivery inside architect or strategist:** rejected because
  advice about direction or structure is distinct from approved implementation
  work.
- **Treat the approved PRD as immediate implementation authority:** rejected
  until decomposition, amendment, risk, and approval contracts are defined.
- **Require maintenance to precede feature work at runtime:** rejected because
  no such operational ordering has been chosen.

## References

- Builds on the coordination/execution boundary in
  [ADR-0003](0003-separate-work-coordination-from-execution.md), proposal
  admission in [ADR-0005](0005-admit-worker-created-work-before-claiming.md),
  repository enrollment in
  [ADR-0015](0015-authorize-repository-enrollment-through-core.md), and the v1
  action ceiling in
  [ADR-0017](0017-standardize-actions-boundaries-and-risk.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [feature delivery](../prd/agent-fleet.md#feature-delivery)
- External input: [Hive scanner hold-gated policy](https://github.com/kubestellar/hive/blob/v4/v2/policies/scanner-holdgated.md)
- Implementation design, contract, and delivery plan: not yet authored
