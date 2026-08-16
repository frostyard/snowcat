# 0007 — Use frostyard/core as the organization authority

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

Fluent must apply organization-level vision, goals, policies, shared knowledge,
and repository-readiness criteria when it prioritizes and presents work. Those
inputs need an accountable authoring and review path, stable versions, and a
way for a completed work item to explain which direction it followed.

`frostyard/core` already serves as the Frostyard planning repository and holds
useful ACMM and design-system material. Its present layout and contents are
aspirational in places, however. Treating every file or prose statement in the
repository as policy would turn accidents of organization into an API and let
unreviewed observations silently direct the fleet.

Fluent also has a durable database, but making that database a second authoring
system for organization direction would create competing sources of truth and
remove normal Git review from consequential changes.

## Decision

Use `frostyard/core` as Fluent's initial Git-backed authority for accepted
organization direction, policy, shared knowledge, and versioned readiness
criteria.

Authority attaches only to explicit records that conform to a defined contract
and exist in a merged Git revision selected by the operator. It does not attach
to arbitrary prose, an unmerged branch, or the repository's current directory
layout. The record schemas, paths, precedence rules, and review roles remain to
be designed; this decision does not bless the existing structure as that
contract.

Fluent may ingest and index those records for retrieval, but its copy is a
derived snapshot rather than a competing authority. Each admitted work item
whose purpose or priority depends on organization context must retain the
source record identity and exact Git revision, directly or through an immutable
context snapshot. Later edits in `frostyard/core` must not rewrite the context
under which historical work was authorized.

Workers may propose additions or corrections when their work item permits it.
A worker observation, Fluent database row, or proposed change is not accepted
organization guidance until it passes the defined review path and appears in a
selected merged revision of `frostyard/core`.

## Consequences

- Organization direction gains Git history, review, and reproducible versions
  without introducing another policy editor in Fluent.
- Fluent will need deterministic ingestion, schema validation, snapshotting,
  and clear stale or unavailable-source behavior before organization context
  can affect work admission or priority.
- The future contract must distinguish vision, time-bounded goals, policies,
  knowledge, and readiness criteria; one undifferentiated Markdown collection
  is not sufficient.
- Repository maintainers and workers can trace a work item to the exact source
  that influenced it, even after the source evolves.
- `frostyard/core` becomes operationally important. Access control, reviewer
  roles, conflict resolution, and recovery from an invalid revision must be
  designed explicitly.
- No current Fluent design or queue contract implements this decision. A
  design, specification, and delivery phase are required before it becomes a
  live control-plane dependency.

## Alternatives considered

- **Make Fluent's database the authority:** rejected because it creates a
  second planning system, weakens normal Git review, and makes changes harder
  to inspect and reuse outside Fluent.
- **Treat all content in `frostyard/core` as authoritative:** rejected because
  the current structure is not known to be correct and free-form prose cannot
  provide a safe machine contract.
- **Create a new dedicated policy or knowledge repository immediately:**
  deferred because `frostyard/core` already has the right organizational role.
  A later ADR may split material if scale, access control, or ownership creates
  a concrete need.
- **Let each opted-in repository define organization policy independently:**
  rejected because it cannot express one reviewed organization direction and
  would make precedence and drift harder to reason about.

## References

- Product: [maintenance fleet PRD](../prd/agent-fleet.md), especially
  [organization direction, knowledge, and readiness](../prd/agent-fleet.md#organization-direction-knowledge-and-readiness)
- Builds on the coordination boundary in
  [ADR-0003](0003-separate-work-coordination-from-execution.md), the
  deterministic authority rule in
  [ADR-0004](0004-keep-models-outside-the-control-path.md), and proposal
  admission in
  [ADR-0005](0005-admit-worker-created-work-before-claiming.md)
- Implementation design, contract, and delivery plan: not yet authored
