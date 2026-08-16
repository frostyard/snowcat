# 0040 — Establish facts through registered predicate contracts

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

ADR-0037 makes typed facts—not event replay, model output, or one mutable
status—the basis of current authority. That architecture remains unsafe unless
Fluent controls which propositions can exist, what can establish them, and how
conflicting or superseded facts are interpreted.

A general `set_fact(subject, predicate, payload)` operation would let a worker,
adapter, controller, migration, or future plugin invent authority semantics by
choosing a plausible predicate string. Storing typed JSON would not fix that
problem if the type registry said nothing about evidence, establishing
mechanism, revision sufficiency, temporal behavior, or conflicts.

The opposite extreme—giving each controller private fact-writing logic—would
make the same predicate mean different things depending on which path produced
it. RepositoryController, FleetController, ProcessObserver, GitHub adapters,
typed human decisions, and migrations need one semantic owner without becoming
one universal state machine.

Derived propositions add another risk. A cached calculation may be convenient,
but treating every derived value as an authoritative fact can leave stale
authority after an input changes. Fluent must distinguish ordinary projections
from the few derivations whose contracts justify durable fact establishment.

## Decision

Fluent maintains a closed, versioned **predicate-contract registry**. A
predicate contract is the sole semantic owner of one named family of
authoritative propositions. General control-plane code, workers, models,
adapters, controllers, operators, and plugins cannot create new predicate names
or bypass the registered contract.

Predicate names are stable and namespaced by domain, such as `work.admitted` or
`artifact.identity-verified`. A semantic change creates a new contract version
and preserves the version attached to existing facts. Renaming, weakening, or
reinterpreting a predicate in place is prohibited.

Each predicate contract declares at least:

- stable predicate name and contract version;
- proposition meaning and versioned fact-payload schema;
- allowed subject kinds and required revision-binding kinds;
- cardinality and effective-time semantics;
- the finite establishment paths and command families permitted to invoke
  them;
- required principal, authority, input records, evidence modes, verifiers, or
  attestations for each path;
- minimum information class and safe projection behavior;
- supersession, invalidation, expiry, and conflict semantics;
- the versioned deterministic reducer for current applicability; and
- the authority-sensitive gates, commands, or projections allowed to consume
  the predicate.

Unknown predicates, contract versions, establishment paths, payload versions,
or reducers fail closed. Adding a predicate requires registry code, schemas,
positive and negative fixtures, migration analysis, and consumer review. It
requires another ADR only when the predicate changes a product or authority
boundary.

### Fact establishment

Fact establishment is a typed deterministic command, not a database insert.
The predicate contract may permit a finite set of paths drawn from:

- activation of an exact validated canonical-source snapshot;
- deterministic evaluation of trusted internal records;
- verification of observations from an accepted external adapter;
- a typed human decision or evidence-bound attestation; or
- a registered deterministic derivation over exact authoritative inputs.

The contract remains the one semantic owner even when it permits more than one
path. Each fact records the exact path, contract version, subject and revision
binding, principal or source, inputs, evidence references, verifier or
attestation version, effective and recorded time, information class,
idempotency identity, and payload digest required by its path. If two paths
would not establish precisely the same proposition, they use different
predicates.

Workers and models produce assertions and evidence proposals only. External
adapters produce observations. Neither can establish a fact merely through
trusted transport, valid syntax, a recognized provider, or confident wording.
A verifier may consume those records and establish only the predicate named by
its accepted contract.

A typed human disposition establishes only the exact predicates and effects
declared by its decision contract. Free-form rationale cannot create another
predicate, expand scope, change a revision binding, or bypass deterministic
denial.

There is no public, administrative, MCP, plugin, or controller-level generic
fact-writing endpoint. Import and migration use named establishment paths with
the same validation and provenance requirements. Lower-level persistence
functions are internal implementation details and accept only an already
validated typed establishment command.

### Transaction and concurrency

Fact establishment runs in the command transaction defined by ADR-0037. Before
appending a fact, the handler validates the predicate and payload versions,
subject identity and revision binding, establishment path, principal and
authority, evidence sufficiency, information class, idempotency key, expected
current facts, and predicate invariants.

The transaction appends the fact, its evidence relationships, dependency
relationships where applicable, and the attributable event together. A stale
revision, changed authority input, conflicting idempotency replay, unavailable
verifier, invalid evidence, or unhandled current conflict rejects the command
without partially establishing authority.

Controllers call shared typed commands and query the shared store. They may
decide when an accepted command should be attempted, but they do not own private
facts or write rows directly.

### Reduction and conflicts

Each predicate contract owns a pure, deterministic, versioned reducer over the
bounded facts for one predicate and subject. The reducer may use only its
declared fact payloads, effective intervals, supersession and invalidation
relationships, and explicit deterministic precedence. It does not call a
network, model, clock, mutable configuration, or unrelated event stream.

The reducer returns an explicit result such as no applicable fact, one current
value, an allowed set, conflict, or unavailable due to an unknown contract or
input version. Cardinality and exact result shape belong to the predicate
contract; Fluent does not force every proposition into one boolean or status.

Last-write-wins is not a default conflict rule. If a contract does not define
safe deterministic precedence, incompatible applicable facts remain visible as
a conflict and every authority-sensitive consumer fails closed. A typed human
decision may resolve a conflict only when the predicate contract declares that
decision path and its permitted effect.

Supersession, invalidation, expiry, and closure create new attributable records
or relationships. They never edit or delete the original fact or provenance.
Wall-clock expiry is evaluated against an explicit command time and recorded
effective interval rather than hidden reducer access to the current clock.

### Derivation and projection

A calculated value is a projection by default. It does not become a fact merely
because its calculation is deterministic, cached, frequently queried, or used
by a controller.

A predicate contract may permit durable deterministic derivation only when it
declares the derivation version, exact input predicates and record identities,
revision bindings, output schema, invalidation behavior, and authority-sensitive
consumers. The derived fact retains dependency edges. Changed, superseded,
invalidated, or conflicted required inputs make the derivation stale or
inapplicable until a new fact is established; they do not silently rewrite its
history.

ProcessObserver results remain observations or projections unless a predicate
contract explicitly establishes a narrow process fact. An event, metric,
projection, or alert never becomes authoritative simply because it exists in a
trusted Fluent subsystem.

### Initial examples and migration

`work.admitted` is established for an exact work-item definition only through
its declared admission decision path. A worker assertion that work is approved
cannot establish it.

`artifact.identity-verified` is established only by its deterministic verifier
from accepted GitHub observations that match repository identity, artifact
kind, attempt marker, actor, action authority, and required revision binding.
It does not establish code correctness, CI success, review acceptance, merge,
or outcome achievement; those require separate predicates.

Core enrollment authorization and GitHub identity reconciliation remain
separate predicates so a valid core declaration cannot conceal an external
identity mismatch. Eligibility consumes their applicable reduced results
rather than replacing them with one broad enrollment status.

Queue migration may establish `work.admitted` through a one-time registered
legacy path only where the existing database constraint and history prove that
exact proposition. Other legacy status or result fields remain explicitly
classified legacy records when they cannot satisfy a target predicate contract.
Migration does not manufacture stronger facts.

## Consequences

- Models, workers, adapters, and controllers cannot invent authority by writing
  plausible predicate strings or JSON.
- One predicate has one versioned semantic owner even when several accepted
  establishment paths exist.
- Facts retain enough evidence and mechanism detail to explain why they were
  authoritative.
- Separate predicates keep artifact existence, correctness, review, merge, and
  outcome from collapsing into one completion fact.
- Explicit reducers preserve conflicts and prevent accidental last-write-wins
  authorization.
- Defaulting calculations to projections reduces stale derived authority.
- Registry, schema, verifier, reducer, fixture, migration, and consumer review
  requirements add substantial work for every new authoritative proposition.
- Authority queries may fail closed during unknown-version or conflicting-fact
  conditions that a schemaless design would have hidden.
- Predicate and subject registries must evolve together without turning every
  ordinary addition into an architecture ceremony.

## Alternatives considered

- **Expose a generic fact-writing API:** rejected because syntax and
  authentication do not define proposition semantics or evidence sufficiency.
- **Let each controller own its facts:** rejected because authority would vary
  by code path and controllers could accumulate private truth.
- **Allow arbitrary predicates with JSON Schema:** rejected because payload
  shape does not define who may establish a fact, how it reduces, or what it
  authorizes.
- **Permit exactly one establishment mechanism per predicate:** rejected
  because an exact proposition may have several explicitly equivalent accepted
  paths; the contract must own and distinguish them.
- **Resolve every conflict by newest timestamp:** rejected because record time
  does not prove authority, applicability, or semantic precedence.
- **Store every deterministic calculation as a fact:** rejected because cached
  derivations can retain authority after their inputs change.
- **Never store derived facts:** rejected because some expensive or
  authority-relevant derivations need durable evidence and dependency lineage.
- **Let ProcessObserver findings establish process truth automatically:**
  rejected because observations and metrics do not justify an unreviewed
  self-modifying authority loop.

## References

- Preserves deterministic model boundaries and database enforcement from
  [ADR-0004](0004-keep-models-outside-the-control-path.md) and
  [ADR-0006](0006-enforce-admission-in-the-database.md)
- Applies policy verification, criteria evidence, source import, external
  reconciliation, outcome verification, and typed human authority from
  [ADR-0010](0010-enforce-policies-monotonically-with-expiring-exceptions.md),
  [ADR-0012](0012-version-criteria-and-preserve-assessment-truth.md),
  [ADR-0014](0014-import-core-as-atomic-validated-snapshots.md),
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md),
  [ADR-0031](0031-separate-delivery-from-outcome-achievement.md), and
  [ADR-0035](0035-route-human-authority-through-typed-decisions.md)
- Refines facts, conflicts, reducers, transactions, and projections from
  [ADR-0037](0037-store-facts-with-a-separate-event-ledger.md), using identity
  and revision binding from
  [ADR-0039](0039-use-typed-source-native-subject-identities.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [control-plane records and event ledger](../prd/agent-fleet.md#control-plane-records-and-event-ledger)
- Language: [Fluent ubiquitous language](../domain/ubiquitous-language.md)
- Delivery: [product foundation roadmap](../plans/product-foundation-roadmap.md)
