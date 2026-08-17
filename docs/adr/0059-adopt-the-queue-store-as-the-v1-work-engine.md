# 0059 — Adopt the queue store as the v1 work engine

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

The queue implemented in `src/queue/store.ts` and served through
`src/mcp/server.ts` was built as a disposable vertical spike. It has since
become the only part of Fluent that hands work to a worker: as of this date the
live queue database holds roughly forty-five completed items, mostly on Fluent
itself, each claimed by an operator-started Codex or Claude session over MCP,
resolved with recorded evidence, and in many cases followed by an
operator-admitted implementation child. Its admission gate, lease tokens,
delegation ceiling, priority inheritance, and reserved-principal rules are
enforced by SQLite triggers and covered by the largest test file in the
repository.

The accepted target control-plane store in `src/control/store.ts` has no
work-facing surface. It provides Core snapshot verification, activation,
rollback, and polling; repository authority, surface, and enrollment
reconciliation; operator holds; and the parked GitHub observation slice
(webhook verification, delivery-list acquisition, checkpoints, gaps, and
installation reconciliation). None of its commands create, lease, claim, or
complete work. Under
[ADR-0044](0044-replace-the-queue-spike-database.md) the queue was to be
retired only after that store gained a target-native work path; the
[product foundation roadmap](../plans/product-foundation-roadmap.md) places
that first matched item at Phase 5, behind Phases 2–4, each estimated large.

The control-plane store also refuses to open a database whose `user_version`
is older than its own ("this kernel slice does not define an upgrade"). Its
schema advanced from version 1 to 8 and its registry from 1 to 18 between
2026-08-15 and 2026-08-17, and the local database created two days earlier can
no longer be opened by current code. Continuing to build authority depth on a
store with no work path and no upgrade path moves the first real matched item
further away with each change.

The operator has decided that Fluent must produce work on a real repository
before it accumulates further observation and authority machinery.

## Decision

The queue store and its MCP contract are the v1 work engine, not a predecessor
awaiting replacement.

1. `QueueStore` and the seven MCP tools remain the durable, worker-facing
   work path for v1. They evolve additively through the
   [work queue contract](../specs/work-queue.md); the physical schema and the
   MCP tool surface are compatibility requirements from this decision forward.
2. `QueueStore` gains a forward-only, versioned migration ladder. A database
   at an older supported `user_version` is upgraded in place inside one
   write transaction; a newer database is still refused. Every future queue
   schema change is a numbered rung, never a rewrite.
3. The control-plane store becomes an authority and observation sidecar. Its
   Core snapshot, readiness, repository enrollment, and hold facts are consumed
   by the queue as a claim-eligibility filter; they do not replace the queue's
   own repository opt-in, and the queue does not import control-plane rows.
4. GitHub observation (webhook ingress, delivery audit, checkpoints, gaps,
   installation reconciliation) is parked at registry version 18 and schema
   version 8. It is neither removed nor extended until the queue verifies
   worker artifacts on demand through the GitHub REST API and that path is
   shown insufficient. On-demand artifact verification records evidence on the
   work item; it does not establish observation facts under
   [ADR-0057](0057-require-webhook-ingress-for-github-observation.md), which
   continues to govern the parked subsystem.
5. Operator-issued grants, the bounded scheduler, and typed decisions from
   [ADR-0032](0032-route-work-with-operator-issued-grants.md),
   [ADR-0034](0034-schedule-a-bounded-ready-inventory.md), and
   [ADR-0035](0035-route-human-authority-through-typed-decisions.md) remain
   accepted direction. They are implemented as additions to `QueueStore` when
   a real repository shows the need, not as prerequisites for the first
   external pull request.
6. The [recovery plan](../plans/recover.md) is the current delivery order.
   Roadmap phases that require the control-plane store to hand out work are
   re-sequenced behind it.

This decision supersedes [ADR-0044](0044-replace-the-queue-spike-database.md).
Its cutover procedure and its rule that no spike row becomes control-plane
truth are moot: there is no cutover, and the queue's rows are the work history.
The remaining decisions of ADR-0037, 0040, 0042, and 0043 continue to govern
the control-plane store's own persistence.

## Consequences

- Fluent can reach "operator enrolls a repository, starts an external worker,
  receives a matched item, and sees its lease, report, artifact, and decision"
  by extending roughly one thousand lines of proven code instead of building
  four large phases first.
- The queue database becomes durable production state: it needs a migration
  ladder, verified backups, and a documented host layout. Existing queue tests
  become compatibility gates, not merely behavioral inputs.
- Slug-keyed repository identity, caller-supplied worker identity, integer
  priority, and mixed result storage — the compromises ADR-0044 wanted to
  avoid promoting — are now v1 truth. Each is upgraded in place, by a rung,
  when a real repository needs it.
- Two SQLite databases coexist by design: the queue as work truth and the
  control plane as authority and observation truth. The claim-eligibility hook
  is the only coupling, and it degrades to plain opt-in when the control-plane
  database is absent.
- The parked GitHub observation code carries maintenance weight without
  producing evidence until it is unparked. Its tests continue to run.
- New ADRs that add control-plane authority or observation depth need to show
  a recovery-plan phase that consumes them; the roadmap no longer justifies
  them on its own.

## Alternatives considered

- **Continue ADR-0044 as written:** rejected because the target store's work
  path is four large phases away and its no-upgrade rule already orphaned the
  local database; the plan optimizes for authority purity over producing work.
- **Port `QueueStore` into the control-plane store now:** rejected because it
  reproduces the migration risk ADR-0044 sought to avoid, in reverse, and
  delays the first external pull request for a representation change with no
  production consumer.
- **Delete the control-plane store:** rejected because Core snapshot
  verification/activation and repository enrollment reconciliation work today
  and are the intended eligibility source; only their position in the
  critical path changes.
- **Keep both databases and defer the decision:** rejected because the roadmap
  and every new ADR would keep treating the queue as disposable, and the
  operator wants an explicit boundary.

## References

- Shapes: [queue execution boundary](../design/queue-execution-boundary.md),
  [work queue](../specs/work-queue.md), and the
  [recovery plan](../plans/recover.md)
- Re-sequences:
  [product foundation roadmap](../plans/product-foundation-roadmap.md) and
  [control-plane kernel bootstrap](../plans/control-plane-kernel-bootstrap.md)
- Product: [GitHub organization agent fleet](../prd/agent-fleet.md)
- Supersedes: [ADR-0044](0044-replace-the-queue-spike-database.md)
- Builds on:
  [ADR-0003](0003-separate-work-coordination-from-execution.md),
  [ADR-0004](0004-keep-models-outside-the-control-path.md),
  [ADR-0005](0005-admit-worker-created-work-before-claiming.md),
  [ADR-0006](0006-enforce-admission-in-the-database.md), and
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md)
