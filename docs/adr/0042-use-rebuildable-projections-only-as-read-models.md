# 0042 — Use rebuildable projections only as read models

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

ADR-0037 permits rebuildable projections for display and coordination while
making facts, decisions, definitions, and current operational state answer
authority. Fluent nevertheless needs fast materialized views for worker
listing, ready inventory, repository and initiative summaries,
OperatorInbox, ProcessObserver funnels, search, and UI status.

Those views can become accidental sources of truth. A stale `eligible=true`
row could authorize an invalid claim after a hold or grant revocation. A cached
public classification could disclose a newly restricted item. A universal
status could conceal independent CI, review, merge, verification, and outcome
facts. If a projection can be rebuilt only by replaying events, it also
reintroduces the event-sourcing authority rejected by ADR-0037.

Operational state creates another boundary. A lease, cursor, fairness credit,
retry schedule, or WIP counter is a mutable current coordination value, not a
read model. Conversely, ready inventory is a materialized candidate set derived
from authority and capacity inputs; treating its membership as final claim
authority would make projection freshness a security property.

Fluent therefore needs explicit projection contracts, safe stale behavior,
rebuild and activation rules, and a transactional recheck boundary between
candidate selection and authoritative mutation.

## Decision

Fluent maintains a closed, versioned **projection-contract registry**. A
projection is a disposable read model produced under one registered contract.
It may accelerate queries, display, scheduling, search, and observation, but it
never establishes a fact, grants access or an action, satisfies evidence, owns
operational state, or authorizes a mutation.

Each projection contract declares at least:

- stable projection name, purpose, contract version, and consumers;
- output key and versioned row or document schema;
- exact source record classes, subject kinds, predicates, predicate-contract
  versions, decision types, and operational-state inputs;
- pure deterministic transformation and ordering rules;
- information-class and information-scope derivation and filtering behavior;
- source-watermark, freshness, lag, and unavailable semantics;
- full rebuild, incremental update, comparison, activation, and rollback
  procedures;
- invariants, drift checks, and safe behavior for unknown source versions; and
- generation retention and backup behavior.

Unknown projection names, contract versions, source versions, row schemas, or
transformation versions fail closed. A plugin, worker, model, controller, or UI
cannot register arbitrary SQL, predicate names, fields, or transformations as a
projection. Adding an ordinary read model requires registry code, schemas,
fixtures, rebuild tests, information-leak tests, and consumer review; it needs a
new ADR only when it changes an architecture or authority boundary.

### Source and rebuild boundary

A projection rebuild reads retained definitions, assertions where explicitly
allowed for non-authority display, observations, evidence relationships, facts,
decisions, and current operational state named by its contract. Authority-
sensitive results use registered fact reducers rather than reimplementing
predicate semantics inside projection code.

Events may trigger incremental refresh, provide diagnostic correlation, and
measure lag. They are not the sole rebuild source and an event payload cannot
stand in for the authoritative record or current operational state it reports.
Deleting a projection and its event cursor must not delete or change product
truth.

Projection transformations are pure with respect to their declared source
snapshot. They do not call models, networks, implicit clocks, mutable
configuration, or external authority systems. Time-relative output uses an
explicit evaluation time recorded in the generation metadata.

If a required source contract or reducer version is unknown, a source is
conflicted, or required operational state is unavailable, the affected result
is explicitly unavailable or omitted according to the projection contract. It
is not guessed from the newest row or event.

### Generations and activation

Each full rebuild creates a new immutable projection generation with unique
record identity, projection-contract and transformation versions, build time,
explicit evaluation time, source watermarks and digests, information-handling
version, row count, invariant results, and build outcome.

The builder writes a shadow generation, validates its schema and invariants,
compares it with the active generation under contract-declared expectations,
and atomically changes the active-generation pointer only after validation
succeeds. A failed or interrupted rebuild leaves the prior generation active
and records visible projection-health evidence.

Incremental maintenance is permitted only when the contract proves it
semantically equivalent to a full rebuild for the same source watermark.
Periodic or triggered full rebuild comparison detects incremental drift. Repair
rebuilds projection data only; they do not establish, invalidate, or rewrite
source facts, decisions, evidence, or operational state.

Old generations are retained only under their declared diagnostic and rollback
policy. Backups may omit disposable projection rows when restore runs and
validates a full rebuild before serving their consumers. If projection rows are
backed up, restore still verifies their contract, source watermark, and
information handling before activation.

### Authority and disclosure recheck

A projection may return candidate subject or record identities. Before Fluent
discloses non-public details, creates a lease, accepts a decision, or performs
any other authority-sensitive mutation, the serving command rechecks current
authenticated principal and session, role, grant, information access, subject
and revision binding, applicable facts and decisions, holds, policy,
operational state, idempotency, and invariants from their authoritative sources
inside the command transaction.

Projection generation, row version, status, or freshness marker is never an
optimistic-concurrency token for domain authority. Commands bind the actual
revision and authority inputs. A projection token may control caching or
pagination only.

A stale projection may conservatively omit currently permitted work or display
an explicit stale/unavailable state. It must never reveal a record the current
principal cannot access or make an invalid candidate claimable. Information
filtering and the final current-source access check occur before output,
ranking, counts, pagination, search snippets, notifications, and timing-visible
result distinctions as required by ADR-0041.

If a candidate fails recheck, the command creates no lease or other authority
transition. It records a safe rejection or refresh signal, and the projection
is invalidated or scheduled for repair without changing the source records.
Repeated rejection beyond the projection contract's bound becomes visible
projection-health evidence rather than an infinite retry loop.

### Ready inventory

Current ready inventory is a named materialized candidate-selection projection.
It combines authorized work, reduced eligibility inputs, dependencies, holds,
priority, routing requirements, current WIP and capacity state, and scheduling
policy at its source watermark. Inclusion means the item was a ready candidate
for that projection generation; it is not a durable assertion that it remains
eligible for a later session or claim.

The facts and decisions that authorize work and satisfy eligibility inputs
remain authoritative records. Leases, WIP counters, fairness credits, pins,
drains, capacity reductions, and other atomic scheduling mechanics remain
operational state. Materialization, exclusion, and selection events preserve
audit evidence but grant no authority.

List and scheduler queries may use ready inventory to select compatible
candidate IDs and order them. Atomic claim rechecks current authorization,
eligibility, access, grant compatibility, WIP, capacity, holds, drain state,
and lease absence before creating the attempt and lease. A targeted claim uses
the same path. Projection staleness can reduce utilization but cannot broaden
authority.

This decision refines ADR-0034's `ready` scheduling state as the materialized
candidate view between current eligibility evaluation and atomic claim. It does
not change ADR-0034's bounded source, WIP, priority, fairness, or one-step
selection-and-lease decisions.

### Status, inbox, and observer projections

Fluent may expose named status and stage projections for a declared subject and
consumer. Each output carries its projection contract and generation,
source-as-of watermark, freshness or unavailability, and the independent facts
it summarizes when the principal may see them. No universal status field or
cross-domain reducer owns every lifecycle.

OperatorInbox is a filtered projection of current typed decision records. Its
presence, ordering, grouping, or cached action labels do not grant the viewer a
disposition; submission reloads and validates the decision contract and current
authority.

ProcessObserver funnels, cohorts, and health summaries are projections or
observations under their own versioned profiles. Projection health—source lag,
build failure, invariant failure, drift, unknown version, stale generation, and
rejected-candidate rate—is observable. ProcessObserver may notice or create an
accepted scoped intervention from that evidence but cannot repair source truth
or declare its own projection healthy.

### Current queue migration

The queue spike's `work_items.status` remains truthful source state for the
implemented contract until coordinated migration code and spec changes land.
Migration first classifies its historical meanings into the accepted fact,
attempt, decision, and operational-state model, then builds target projections
from those records. It does not relabel the existing column as a projection or
infer target authority that the spike never recorded.

Current list and claim behavior remains governed by the live work-queue spec
until its replacement rechecks target authority transactionally. Projection
tables or caches may not be introduced as a silent alternate claim path.

## Consequences

- UI, scheduling, search, inbox, and observer queries can be fast without
  becoming new authority systems.
- Deleting or rebuilding a projection cannot erase facts or grant authority.
- Candidate selection tolerates stale false negatives while transactional
  recheck prevents stale false positives from becoming disclosures or leases.
- Ready inventory has a precise boundary: projection membership selects
  candidates; authoritative sources and operational state decide claim.
- Shadow generations and source watermarks make drift and rollout visible and
  reversible.
- Rebuilds do not depend on indefinite event retention or historical reducer
  replay as the sole truth source.
- Every projection requires schemas, source-version compatibility, information-
  leak tests, rebuild fixtures, health signals, and consumer rechecks.
- Rechecking current authority after projection lookup adds transaction work to
  claim, disclosure, and decision paths.
- Stale projections may temporarily underutilize available workers, which is
  safer than over-authorizing them but still requires operational objectives.
- Exact projection schemas, freshness objectives, retention, rebuild cadence,
  and comparison thresholds remain implementing decisions.

## Alternatives considered

- **Treat materialized projections as current truth:** rejected because stale
  cache state could grant authority or disclose restricted work.
- **Rebuild projections only from events:** rejected because it would make event
  retention and historical reducers an indirect authority source.
- **Never materialize views:** rejected because scheduling, search, UI, and
  ProcessObserver queries need bounded predictable performance.
- **Update projections synchronously and trust them:** rejected because
  transactional timing does not turn derived data into authority and later
  source changes can still make a row stale.
- **Use projection generation as the command concurrency token:** rejected
  because it does not bind the exact facts, decisions, revision, grant, or
  operational state the command depends on.
- **Treat ready membership as durable claim authority:** rejected because
  grants, holds, information access, WIP, and eligibility can change after
  materialization.
- **Make ready inventory operational state:** rejected because its membership
  is a rebuildable derived candidate set; only its atomic concurrency inputs and
  resulting lease are operational state.
- **Use one global status projection:** rejected because unrelated lifecycle,
  evidence, delivery, and outcome facts cannot be reduced honestly to one
  authoritative scalar.
- **Repair drift by rewriting source records:** rejected because a projection
  defect does not prove that source authority is wrong.
- **Dynamically redact one projection row for every caller:** rejected because
  class and scope filtering need registered, testable behavior and current
  source recheck rather than fragile field omission.

## References

- Refines bounded ready inventory and atomic claim from
  [ADR-0034](0034-schedule-a-bounded-ready-inventory.md), while preserving typed
  human decision submission from
  [ADR-0035](0035-route-human-authority-through-typed-decisions.md)
- Applies authoritative records, event boundaries, operational state, and
  projection rebuilding from
  [ADR-0037](0037-store-facts-with-a-separate-event-ledger.md)
- Uses record identity, predicate reducers, and information handling from
  [ADR-0039](0039-use-typed-source-native-subject-identities.md),
  [ADR-0040](0040-establish-facts-through-registered-predicate-contracts.md),
  and [ADR-0041](0041-enforce-three-information-classes-and-scoped-access.md)
- Supports ProcessObserver health from
  [ADR-0033](0033-observe-processes-and-pull-scoped-andons.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [portfolio scheduling and backpressure](../prd/agent-fleet.md#portfolio-scheduling-and-backpressure),
  [typed human decisions and OperatorInbox](../prd/agent-fleet.md#typed-human-decisions-and-operatorinbox),
  and
  [control-plane records and event ledger](../prd/agent-fleet.md#control-plane-records-and-event-ledger)
- Current implementation context:
  [queue execution boundary](../design/queue-execution-boundary.md),
  [work queue contract](../specs/work-queue.md), and
  [queue vertical spike](../plans/queue-vertical-spike.md)
- Delivery: [product foundation roadmap](../plans/product-foundation-roadmap.md)
