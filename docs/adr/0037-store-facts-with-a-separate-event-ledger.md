# 0037 — Store facts with a separate event ledger

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

Accepted Fluent behavior depends on distinctions that the queue spike's single
work-item row cannot represent safely: assertions versus facts, source
authorization versus eligibility, independent CI/review/merge/verification
state, exact subject revisions, typed human decisions, invalidation, and
ProcessObserver funnels. The spike's `status` and mixed `result_json` are
truthful for the implemented vertical slice but cannot become the general
control-plane model.

Fluent also needs an append-only operational history. ProcessObserver must know
which versioned stage, gate, workflow, policy, skill, grant, and decision
produced an outcome. Operators need attribution and stale-decision detection.
Reconciliation must preserve conflicting and unavailable observations rather
than overwrite them with the latest response.

That requirement does not automatically justify event sourcing. If authority
could be reconstructed only by replaying every historical event, a defect in an
old reducer, missing event migration, retention policy, or restricted-record
redaction could change current authorization. Conversely, maintaining one
mutable status row would erase the independent evidence and history already
required by the PRD.

## Decision

Fluent uses a fact-oriented relational control-plane store with a separate
append-only event ledger. Typed authoritative records and current operational
state answer control decisions; events explain what happened and feed
ProcessObserver. Fluent does not use event replay as the sole source of current
authority.

### Stable subjects and exact revisions

Every durable domain subject has one stable typed identity independent of its
display name, mutable locator, or revision. References use a registered subject
kind plus stable ID; when a statement applies to exact content, the reference
also binds the applicable revision, digest, or external SHA.

Generic untyped ID strings and owner/name repository slugs do not establish
identity. Repository authority uses immutable GitHub repository ID; Git
documents retain blob or commit identity; pull-request review binds a head SHA;
workflow, policy, criteria, schema, skill, plan, and observation profiles bind
their exact versions or digests.

### Record classes

The durable model separates these record classes:

- **definition** — immutable or versioned product input such as a work-item
  definition, workflow version, plan, criterion, or observation profile;
- **assertion** — untrusted worker, model, person, or source statement, including
  an attempt report;
- **observation** — timestamped reading from a named adapter about an exact
  subject, preserving match, mismatch, unavailable, and source revision;
- **evidence reference** — a typed relationship selecting bounded assertions,
  observations, artifacts, evaluations, or attestations for a criterion or
  decision;
- **fact** — an authoritative proposition established by the accepted mechanism
  for its predicate;
- **decision** — the typed human authority record and its exact disposition;
- **operational state** — mutable concurrency and delivery mechanics such as a
  lease, fairness credit, ingestion cursor, retry schedule, or WIP counter; and
- **projection** — a rebuildable display or query view over definitions, facts,
  decisions, observations, and operational state.

An event is not another record class that can silently substitute for these. It
is an append-only account of a command, observation, transition, invalidation,
or external reconciliation outcome.

### Common record envelope

Every durable assertion, observation, evidence reference, fact, decision, and
event carries a common conceptual envelope: unique record identity, record and
schema kind, exact subject reference, source and source revision, recorded and
effective time, correlation and causation identities, information class,
payload digest, and idempotency identity where applicable. The later specs own
exact field names and encoding.

Payloads remain typed by a versioned registry. Unknown kinds or schema versions
fail closed at authority boundaries. Free-form JSON cannot create a predicate,
transition, subject kind, action, or decision effect merely because a model
produced valid syntax.

### Facts, supersession, and invalidation

Facts are append-only propositions. A later record may supersede applicability,
invalidate evidence, close an effective interval, or establish a newer value,
but it does not edit the historical payload or provenance. Queries for current
authority apply a versioned deterministic reducer over the bounded fact family
for one subject and predicate, not over the entire event history.

Conflicting facts are not resolved by last-write-wins unless that predicate's
accepted contract explicitly defines temporal precedence. Otherwise the
conflict is retained and the affected gate fails closed or requires a typed
decision.

Assertions never become facts through mutation. Verification or attestation
creates a new fact citing the assertion and evidence it evaluated. Likewise, an
external observation does not become a canonical merge or policy decision
unless the accepted adapter and predicate rules establish that fact.

### Commands and transactions

A deterministic command handler receives the authenticated principal and
session, command schema version, exact expected subject revision, idempotency
key, and typed payload. It reads the applicable definitions, facts, decisions,
holds, and operational state; evaluates authority and invariants; then performs
all accepted writes and event insertion in one SQLite transaction.

Optimistic concurrency rejects a command whose bound subject or authority facts
changed. Repeating the same idempotency key and equivalent payload returns the
recorded result; reuse with another payload fails. A rejected command may emit a
sanitized audit event when policy permits, but it creates no domain fact or
authority transition.

Operational state may be updated in place where concurrency requires one
current value, such as claiming a lease or advancing a cursor. The same
transaction records the attributable event and any resulting domain fact.
Operational state never becomes retrospective product truth merely because it
is mutable and convenient.

### Event ledger

Events are append-only, past-tense, schema-versioned, subject-bound records with
correlation and causation. They provide audit history, notification input,
ProcessObserver funnels, and deterministic debugging. Sensitive payloads use
references and information controls rather than copying restricted content into
a broadly readable stream.

An event is not authorization, evidence sufficiency, or a canonical external
act. Projections can be rebuilt from authoritative records and current
operational state without replaying events as the only database of truth. Event
retention or projection failure therefore cannot grant or relax authority.

### Controllers and projections

RepositoryController, FleetController, and ProcessObserver are deterministic
services over the same typed store, not rows that own private copies of truth.
RepositoryController scopes repository facts and commands; FleetController
derives relationship and initiative coordination across repositories;
ProcessObserver consumes versioned events and source records for process
evaluation without writing the facts it measures.

No universal status field owns a subject lifecycle. Typed independent facts
represent source authorization, admission, eligibility inputs, attempts,
artifacts, CI, reviews, decisions, merge, verification, holds, and outcomes.
Named status and stage projections remain caches or views and carry their
projection version.

### SQLite and migration

The single-host v1 store remains SQLite with forward-only schema versions,
transactional constraints, WAL-compatible concurrency, bounded busy handling,
backup validation, and startup refusal for an unknown newer schema. Exact table
layout belongs in implementing specs.

Migration from the queue spike preserves its history while separating concepts:

- the work-item definition remains the stable subject;
- `admitted` becomes an admission fact;
- caller `worker` metadata remains legacy provenance while server-bound sessions
  and grants become authoritative for new attempts;
- `queued`, `claimed`, `completed`, `blocked`, and `cancelled` map to their
  historical queue meanings rather than being reinterpreted as target outcome
  facts;
- mixed `result_json` is classified as a worker attempt report, worker block
  reason, or operator decision rationale according to its originating event;
- integer priority and repository slug remain legacy values while new records
  use priority bands and immutable repository identity; and
- existing events retain their original schema and gain migration metadata
  rather than being rewritten as if the target model had existed.

The migration must ship with code, spec changes, fixtures, rollback/restore
evidence, and projection comparisons. This ADR does not by itself authorize
rewriting the live queue schema or spec.

## Consequences

- Independent facts match the accepted product distinctions and avoid one
  overloaded status or result field.
- Append-only assertions, observations, facts, decisions, and events preserve
  provenance and prevent history from being silently rewritten.
- Current authority does not depend solely on replaying an indefinitely growing
  event stream.
- Operational values that need atomic mutation remain practical in SQLite
  without being mistaken for product truth.
- Typed subject and revision references make stale decisions, reviews,
  verification, and artifact reconciliation mechanically detectable.
- ProcessObserver receives reconstructable funnels while restricted content can
  remain behind information-class controls.
- Fact reducers, predicate registries, record schemas, information controls,
  idempotency, and projection versions add substantial implementation surface.
- The distinction between record time and effective time requires explicit
  clock, ordering, and late-observation rules.
- The queue migration will be a real schema and API migration, not a rename.
- Exact record envelopes, predicate taxonomy, tables, indices, retention,
  reducer rules, and backup contract remain to be specified and implemented.

## Alternatives considered

- **Use full event sourcing:** not selected because current authority would
  depend on replaying every historical event and reducer version, complicating
  retention, redaction, and safe migration.
- **Use one mutable aggregate row per subject:** not selected because it erases
  independent facts, conflicts, evidence provenance, and exact invalidation.
- **Make the event ledger authoritative and keep snapshots:** not selected
  because snapshots become a second authority whose rebuild and migration
  semantics are difficult to secure; typed records already provide the needed
  current source.
- **Store every value as an immutable fact:** not selected because leases,
  cursors, fairness credits, and concurrency counters need efficient atomic
  current state and are not retrospective domain truth.
- **Use a schemaless JSON event store:** not selected because unknown model-
  authored predicates and effects cannot be allowed into the authority path.
- **Adopt PostgreSQL before modeling:** not selected because database scale is
  not the current uncertainty and the single-host SQLite constraint remains
  adequate for v1 discovery.
- **Rewrite queue history into the new vocabulary:** not selected because it
  would fabricate facts and identities the spike did not record.

## References

- Builds on deterministic authority and atomic database enforcement from
  [ADR-0004](0004-keep-models-outside-the-control-path.md) and
  [ADR-0006](0006-enforce-admission-in-the-database.md)
- Preserves atomic source snapshots, versioned truth, identity, and typed
  decisions from
  [ADR-0012](0012-version-criteria-and-preserve-assessment-truth.md),
  [ADR-0014](0014-import-core-as-atomic-validated-snapshots.md),
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md), and
  [ADR-0035](0035-route-human-authority-through-typed-decisions.md)
- Supports independent delivery, observer, routing, and scheduling facts from
  [ADR-0030](0030-execute-one-slice-through-one-pull-request.md) through
  [ADR-0034](0034-schedule-a-bounded-ready-inventory.md)
- Uses the [Fluent ubiquitous language](../domain/ubiquitous-language.md) under
  [ADR-0036](0036-maintain-a-canonical-domain-language.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially the
  [discovery inventory](../prd/agent-fleet.md#discovery-inventory)
- Current implementation:
  [queue execution boundary](../design/queue-execution-boundary.md) and
  [work queue contract](../specs/work-queue.md)
- Delivery: [product foundation roadmap](../plans/product-foundation-roadmap.md)
