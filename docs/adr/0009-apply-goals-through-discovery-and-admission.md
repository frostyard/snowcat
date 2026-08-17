# 0009 — Apply goals through discovery and admission

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

[ADR-0008](0008-use-five-organization-record-kinds.md) defines a goal as a
scoped, normally time-bounded outcome that may influence discovery and
priority, but may not authorize actions or admit work. That boundary still
leaves several failure-prone interpretations open.

If merging a goal immediately generated claimable work, `frostyard/core` would
bypass Fluent's admission boundary. If a worker could claim relevance to a
high-priority goal and thereby raise its own queue position, priority would no
longer be operator-owned. If later goal edits silently changed queued work,
historical authorization and ordering would no longer be reproducible.

Goals still need a concrete effect. Merely attaching them as background prose
would not make organization direction meaningfully influence repository work.

## Decision

An accepted goal declares a stable identifier, lifecycle status, owner,
applicability, start and end dates, priority band, outcome, success measures,
encouraged work, and explicitly excluded work. V1 uses three priority bands:
`high`, `normal`, and `low`. Urgent interruption is an operator action, not a
fourth goal band.

A goal is active for new work only when its record status is `active`, the
current date is within its inclusive start and end dates, and it applies to the
opted-in repository. Other lifecycle states are `planned`, `paused`,
`completed`, and `cancelled`; only an accepted `frostyard/core` revision changes
that lifecycle.

Goals influence work in two bounded places:

1. A maintenance program may include a repository's applicable active goals in
   a bounded discovery item's context. The goal does not itself run a model or
   create the item; an operator or separately authorized deterministic seeder
   does that.
2. Discovered work may cite one or more goals and explain the expected
   contribution. A capable execution worker receives only the goal snapshots
   accepted with its work item, rather than the entire organization catalog.

A worker-proposed goal reference is an untrusted claim. During admission, the
operator confirms or removes the reference and may reject irrelevant work.
Future automatic admission may accept goal references only through an
independently approved deterministic policy; a model's relevance judgment is
never sufficient.

On initial admission or operator-authored seeding, goal priority supplies a
default for the queue's operator-owned integer priority. The mapping from goal
bands to queue integers is deterministic and configured by Fluent. When work
cites multiple goals, the highest band wins; bands are not added together. Work
without a goal retains the maintenance program's or operator's default. An
operator may override the resulting priority only with an attributed reason.
Workers cannot set or change priority.

Admission freezes the selected goal records, source Git revision, accepted
goal references, and resulting priority with the work item. Pausing,
completing, cancelling, expiring, or reprioritizing a goal affects future
discovery and admission only. It does not silently cancel, reorder, or rewrite
existing work; the operator may explicitly defer, cancel, or reprioritize that
work with an attributed reason.

Goal success measures inform progress reporting, but measurements do not
automatically complete a goal. Goal lifecycle changes are accepted changes in
`frostyard/core`. Fluent presents conflicting applicable goals to the operator
and does not ask a model to resolve their precedence.

## Consequences

- Repository discovery receives current organization direction without making
  every execution worker consume the entire goal catalog.
- Goals have a deterministic scheduling effect while workers remain unable to
  promote their own work.
- Attaching several goals cannot amplify priority, and urgent work remains an
  explicit operator decision.
- Historical work retains the direction and ordering under which it was
  admitted even after `frostyard/core` changes.
- Goal completion remains reviewable and Git-backed instead of being inferred
  from possibly incomplete metrics or model output.
- Fluent needs future support for goal snapshots, goal-reference review,
  attributed priority overrides, and deterministic band mapping. The current
  queue does not yet implement these mechanics.

## Alternatives considered

- **Create work automatically when a goal becomes active:** rejected because a
  goal describes an outcome, not a verified repository gap, and must not bypass
  admission.
- **Let workers assign goal relevance and priority:** rejected because workers
  could promote their own output and models cannot authorize queue state.
- **Continuously recompute queued priority from the latest goals:** rejected
  because later edits would rewrite historical admission decisions and produce
  surprising queue movement.
- **Add the priority of every cited goal:** rejected because duplicate or
  tenuous references would reward goal stuffing. The highest applicable band
  is sufficient.
- **Use an `urgent` or `critical` goal band:** rejected for v1 because an
  operational interruption should be explicit, attributed, and immediately
  visible rather than encoded in a long-lived planning record.
- **Automatically complete goals from their measures:** rejected because the
  first versions of those measures may be incomplete or require judgment.

## References

- Refines goal semantics from
  [ADR-0008](0008-use-five-organization-record-kinds.md) and the Git authority
  and snapshot rules in
  [ADR-0007](0007-use-frostyard-core-as-the-organization-authority.md)
- Preserves deterministic control from
  [ADR-0004](0004-keep-models-outside-the-control-path.md) and operator
  admission from
  [ADR-0005](0005-admit-worker-created-work-before-claiming.md)
- Product: [maintenance fleet PRD](../prd/agent-fleet.md), especially
  [goal application](../prd/agent-fleet.md#goal-application)
- Import contract: [Goal ingestion](../specs/goal-ingestion.md)
