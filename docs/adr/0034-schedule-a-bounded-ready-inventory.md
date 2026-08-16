# 0034 — Schedule a bounded ready inventory

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

RepositoryControllers, FleetController, approved feature plans, and
ProcessObserver can all produce authorized work. Operator-started capable
clients may consume that work continuously, but Fluent must not manufacture
speculative tasks merely to keep a client busy. Unbounded implementation also
creates downstream congestion: opening more pull requests is harmful when
review, repair, or verification capacity is already exhausted.

The queue spike represents admitted claimable work with one logical `queued`
state and orders it by an operator-owned integer priority. The product now needs
to distinguish authorization, prerequisites, materialization, and lease state;
provide fairness across repositories; reserve downstream capacity; and report
which capable-worker capacity is missing. Because Fluent does not manage worker
processes, reserving work for an offline agent would strand it.

Scheduling must also produce the versioned operational evidence required by
[ADR-0033](0033-observe-processes-and-pull-scoped-andons.md). A scheduler that
cannot explain why work was or was not selected cannot support meaningful
process baselines.

## Decision

Portfolio scheduling is a deterministic control-plane function shared by
RepositoryControllers and FleetController. It is not a model, specialist
worker, persistent agent, or additional source of product intent.

Fluent stores these scheduling facts separately:

- `authorized` means a recognized source permits the work to exist: explicit
  operator admission, an enabled maintenance program under
  [ADR-0021](0021-run-bounded-maintenance-assessments.md), an active approved
  delivery plan, or another accepted deterministic source;
- `eligible` means current dependencies, policies, context, holds, review and
  verification gates, and work-specific prerequisites pass;
- `ready` means Fluent materialized the eligible work into bounded claimable
  inventory; and
- `claimed` means one eligible worker session atomically selected and leased it.

Resolved, blocked, cancelled, deferred, superseded, and reconciled outcomes
remain separate source facts. A derived display status may summarize these
facts, but MUST NOT replace them. V1 implementation may migrate the spike's
logical `queued` state into this factored model when the corresponding schema
and contract code lands.

There is no separate preassigned `scheduled` state. Selection and lease
creation are one atomic claim operation. A ready item remains available to any
compatible grant until claimed, held, invalidated, or withdrawn; Fluent does
not reserve it for an external process that may never run.

Authorized work comes from bounded sources:

- RepositoryController contributes due maintenance assessments, admitted
  repairs, repository-local review and verification, and eligible feature
  slices;
- FleetController contributes cross-repository compatibility, fleet
  architecture and integration, and multi-repository feature work; and
- ProcessObserver contributes only admitted process-investigation or
  improvement work and may remove affected work from eligibility through an
  andon.

An absence of authorized or eligible work is a valid empty state. A ready-
inventory target, idle worker, active grant, organizational goal, or model
suggestion is not authority to invent work.

Versioned scheduling policy defines independent work-in-progress limits for at
least:

- total ready and claimed inventory;
- active lineages per repository;
- ready and active items per maintenance program or work role;
- parallel slices per initiative, within the approved plan's stricter limit;
- open implementation pull requests awaiting review or verification;
- review, repair, and verification inventory; and
- issue- or pull-request-producing outcomes per repository and time window.

Every applicable limit must have room before new work is materialized. The
scheduler reserves configured capacity for review, repair, and verification so
implementation cannot consume every slot. Limits restrict concurrency and
materialization; they do not cancel existing work, grant actions, satisfy
dependencies, or authorize a source.

Each worker session has at most one active lease by default. A future explicit
concurrency grant may raise that limit only when the client and isolation model
support it, but does not change repository, role, risk, action, or information
authority.

Scheduling priority uses the ordered bands `urgent`, `high`, `normal`, and
`background`. Priority is distinct from risk: high-impact changes often require
more controls rather than faster execution. A versioned deterministic policy or
attributed operator decision may map a condition such as an accepted critical
security response into a priority band, but work and workers cannot select or
raise their own band.

After all eligibility and worker-grant checks, the default atomic claim
algorithm is:

1. select the highest band containing compatible ready work;
2. select a repository through deterministic deficit round-robin within that
   band, using equal repository weight unless accepted policy provides another
   weight;
3. select the oldest ready item for that repository and band; and
4. use stable item identity as the final tie breaker.

Fairness state and accepted weights are durable and reconstructable. A
repository without compatible work does not accumulate an unbounded claim on
future capacity. Exact credit limits and recovery rules belong to the later
scheduling contract.

Versioned aging policy may promote an eligible ready item by at most one band
after a declared wait. Aging never promotes work into `urgent`, bypasses a hold,
changes its risk or actions, or overrides a worker-grant mismatch. Aging history
is retained rather than rewriting original priority.

An attributed operator may pin one eligible item ahead of ordinary selection
or temporarily pause, drain, or reduce capacity for a bounded scope. Temporary
overrides require a reason and expiry. They affect ordering or capacity only;
they cannot bypass admission, policy, dependencies, andons, WIP limits,
information access, or worker-grant checks.

Continuous consumption is an explicit client mode. The operator starts and
owns the capable client and grant; the client claims and resolves one item at a
time, then requests another. Grant expiry or revocation, an applicable andon,
budget exhaustion, or no eligible work ends normal consumption. A future
authenticated wait or event stream may reduce polling, but Fluent still does
not launch, supervise, restart, or terminate the client.

When authorized or eligible work has no compatible active worker grant, Fluent
derives a capacity gap with the missing repository scope, role, capability,
risk ceiling, action, information class, or independence property. A capacity
gap is operator information, not permission to broaden a grant, duplicate the
work, lower its requirements, or start a process.

Recurring maintenance cadence is versioned per program and repository. A
completed valid no-meaningful-finding assessment increases its next interval
within declared minimum and maximum bounds. A relevant repository change,
governing criteria or workflow version change, regression signal, accepted
finding, or attributed operator action may reset the cooldown. A failed,
blocked, invalid, or unavailable assessment does not count as a no-finding
success.

Enforceable scheduling budgets use facts Fluent can independently observe:
claims and attempts, active lineages, review and repair rounds, elapsed windows,
open issues and pull requests, created items per interval, and concurrent work
per repository, program, role, and initiative. Provider token counts and costs
may remain labeled observations for ProcessObserver but are not authoritative
v1 scheduling inputs unless a trusted adapter is later defined.

Durable organization-wide scheduling constraints, weights, and cadence bounds
are canonical core policies. Temporary runtime pin, pause, drain, and capacity-
reduction overrides live in Fluent's attributed operational state and expire
unless the operator deliberately replaces them. Runtime state cannot relax a
core maximum or prohibition.

Every authorization, eligibility, materialization, exclusion, selection,
aging, capacity-gap, budget, and override decision emits enough versioned input
and result evidence for ProcessObserver to reconstruct the applicable funnel
and cohort without retaining secret work content.

## Consequences

- A continuously running capable client can consume useful work without Fluent
  generating an unlimited queue.
- Factoring authorization, eligibility, readiness, and claim prevents empty
  capacity from being mistaken for permission to create work.
- Atomic selection avoids reservations for offline external agents.
- WIP limits and downstream reservations favor finishing and verifying work
  over accumulating implementation PRs.
- Priority bands plus repository fairness reduce starvation while leaving
  explicit operator control.
- Capacity gaps tell the operator which worker to start without automatically
  broadening access.
- No-finding cooldowns reduce repeated low-yield maintenance assessments.
- Attempt and artifact budgets are enforceable across providers; token-based
  optimization remains advisory until trustworthy usage exists.
- Core policy holds durable scheduling intent while transient operational
  overrides remain fast and attributable.
- The existing work-queue schema, priority integer, MCP claim path, CLI, and
  worker skill need a future coordinated migration when this behavior is
  implemented.
- Exact WIP defaults, fair-queue credit math, aging intervals, priority mapping,
  cooldown formula, capacity reservations, and override UX remain open.

## Alternatives considered

- **Always keep a fixed number of tasks queued:** rejected because inventory
  targets do not authorize useful work and would encourage speculative tasks.
- **Preassign work to a named agent:** rejected because Fluent does not manage
  the external process and a reservation could strand work.
- **Use strict global priority ordering:** rejected because busy or favored
  repositories could starve the rest of the fleet indefinitely.
- **Equate risk with urgency:** rejected because risky work may require slower,
  stronger controls rather than faster execution.
- **Let workers select priority:** rejected because workers would control the
  competition for fleet capacity.
- **Start every eligible implementation slice immediately:** rejected because
  downstream review and verification would become unbounded bottlenecks.
- **Duplicate work when no compatible worker is active:** rejected because
  duplication does not create capacity and increases reconciliation failures.
- **Use subscription token budgets as hard scheduling limits:** rejected because
  providers expose inconsistent or unavailable usage evidence.
- **Store temporary pins in core:** rejected because short-lived operating
  decisions need immediate attributed state, while durable policy remains in
  the canonical Git authority.

## References

- Builds on deterministic coordination and admission in
  [ADR-0003](0003-separate-work-coordination-from-execution.md),
  [ADR-0004](0004-keep-models-outside-the-control-path.md), and
  [ADR-0005](0005-admit-worker-created-work-before-claiming.md)
- Schedules repository, fleet, feature, and process work defined by
  [ADR-0020](0020-call-the-repository-coordinator-repositorycontroller.md),
  [ADR-0021](0021-run-bounded-maintenance-assessments.md),
  [ADR-0026](0026-coordinate-enrolled-repositories-with-fleetcontroller.md),
  [ADR-0028](0028-approve-immutable-delivery-plans-in-core.md), and
  [ADR-0033](0033-observe-processes-and-pull-scoped-andons.md)
- Uses worker routing from
  [ADR-0032](0032-route-work-with-operator-issued-grants.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [portfolio scheduling and backpressure](../prd/agent-fleet.md#portfolio-scheduling-and-backpressure)
- Current implementation context:
  [queue execution boundary](../design/queue-execution-boundary.md),
  [work queue contract](../specs/work-queue.md), and
  [queue vertical spike](../plans/queue-vertical-spike.md)
