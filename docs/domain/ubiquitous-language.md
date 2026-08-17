# Domain language: Fluent

- **Status:** Living
- **Last updated:** 2026-08-16

## Scope

This is the canonical language for Fluent product behavior. Use these terms in
normative docs, schemas, APIs, database concepts, UI labels, skills, and worker
briefs. Definitions describe the accepted target model; current spike code may
still require an explicit vocabulary migration.

Keep entries lean. This file defines words and boundaries, not fields,
transitions, implementation, or decision history. Follow
[ADR-0036](../adr/0036-maintain-a-canonical-domain-language.md) when changing
it.

## Terms

### People, workers, and authority

#### Principal

An authenticated human identity accountable for an action or decision. V1 has
one operator principal; a principal is not a worker process or provider account.

**Avoid:** user when authority matters; agent identity; caller-supplied worker
name. ([ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md))

#### Operator

The initial principal who runs Fluent and holds the v1 human authorities
explicitly assigned by product policy. Operator does not mean repository
maintainer, GitHub actor, or owner of every canonical decision.

**Avoid:** admin as a universal bypass; super-agent.
([ADR-0035](../adr/0035-route-human-authority-through-typed-decisions.md))

#### Provider

The external model or coding-agent service used by a worker client, such as
Claude, Codex, Copilot, or a local OpenAI-compatible endpoint. Provider is
descriptive metadata and never authority or proof of capability.

**Avoid:** worker; capability; identity.
([ADR-0003](../adr/0003-separate-work-coordination-from-execution.md),
[ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md))

#### Worker

An operator-started external capable client that performs one authorized work
item through Fluent's portable protocol. Fluent does not launch, supervise,
authenticate to the provider for, or sandbox the worker.

**Avoid:** RepositoryController; fleet agent; daemon; provider.
([ADR-0003](../adr/0003-separate-work-coordination-from-execution.md))

#### Worker role

A versioned responsibility and behavior contract for a class of work, such as
`delivery-implementer` or `adversarial-reviewer`. A role is not a running worker,
provider, skill file, or authority grant.

**Avoid:** agent definition; persona; process.
([ADR-0021](../adr/0021-run-bounded-maintenance-assessments.md),
[ADR-0029](../adr/0029-bound-adversarial-review.md))

#### Worker session

A server-assigned authenticated interaction context bound to one principal and
one current worker grant. A session may perform successive attempts but is not
the provider process identity or a reusable persona.

**Avoid:** worker identity string; attempt; conversation.
([ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md),
[ADR-0032](../adr/0032-route-work-with-operator-issued-grants.md))

#### Work attempt

One lease-bound execution of one work item by one worker session. Reclaiming,
retrying, repairing, or reviewing creates another attempt even when the logical
work or artifact lineage continues.

**Avoid:** session; run when identity matters; work item.
([ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md))

#### Worker grant

An immutable short-lived operational authorization snapshot binding a worker
session to explicit repositories, roles, capabilities, risk, actions, and
information access. It is not a provider credential and cannot be self-issued.

**Avoid:** API key; capability claim; agent profile; permission inheritance.
([ADR-0032](../adr/0032-route-work-with-operator-issued-grants.md))

#### Capability

A named versioned ability required to route a class of work. An operator assigns
capability profiles to grants; provider names, installed tools, self-description,
and past performance do not automatically establish a capability.

**Avoid:** provider; model name; allowed action; confidence.
([ADR-0032](../adr/0032-route-work-with-operator-issued-grants.md))

#### Action

A canonical operation that a work item and worker grant may permit, such as
reading, writing, running tests, or opening a pull request. Effective actions
are the intersection of every authority source, never an implication of role or
capability.

**Avoid:** capability; instruction; permission inferred from credentials.
([ADR-0017](../adr/0017-standardize-actions-boundaries-and-risk.md),
[ADR-0032](../adr/0032-route-work-with-operator-issued-grants.md))

#### Agent

Informal product language for the broad category of coding-agent tools. Agent is
not a normative Fluent domain type; use worker, worker role, worker session,
provider, skill, or the exact deterministic controller.

**Avoid:** agent as a schema type, authority, controller, or ambiguous actor.
([ADR-0036](../adr/0036-maintain-a-canonical-domain-language.md))

### Durable identity and records

#### Subject

A durable domain thing identified by the required pair of registered kind and
opaque canonical ID, independent of its display name, mutable locator, or
content revision.

**Avoid:** untyped ID; repository slug; current name; latest revision.
([ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md),
[ADR-0039](../adr/0039-use-typed-source-native-subject-identities.md))

#### Revision binding

A registered, kind-specific qualification of a stable subject reference with
the exact state relevant to a statement or authority act. It may contain
multiple components and does not replace subject identity.

**Avoid:** generic version string; latest; head SHA as complete pull-request
state; mutable branch name.
([ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md),
[ADR-0039](../adr/0039-use-typed-source-native-subject-identities.md))

#### Record identity

The unique server-assigned identity of one durable stored record occurrence,
distinct from the stable subject that record describes. New records use
UUIDv7; correlation, causation, idempotency, and lease identities do not
substitute for record identity.

**Avoid:** subject identity; correlation ID; idempotency key; lease token.
([ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md),
[ADR-0039](../adr/0039-use-typed-source-native-subject-identities.md))

#### Display locator

A mutable human-facing or routing alias for a subject, such as a repository
slug, URL, path, branch name, or label. Fluent retains locator history but never
uses a locator alone for an authority join.

**Avoid:** subject identity; authoritative slug; stable URL; canonical path as
identity. ([ADR-0039](../adr/0039-use-typed-source-native-subject-identities.md))

#### Definition

An immutable or explicitly versioned product input describing a subject or
contract, such as a work item, workflow version, plan, criterion, or
observation profile.

**Avoid:** fact; operational state; projection; mutable configuration blob.
([ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md))

### Time and ordering

#### Transaction sequence

The monotonically increasing order assigned to one committed Fluent write
transaction; transaction position orders its records. The pair orders accepted
record occurrences but does not imply causality, external occurrence, or
semantic precedence.

**Avoid:** timestamp order; UUID order; source-event order; contiguous counter.
([ADR-0043](../adr/0043-order-records-by-transaction-sequence-not-timestamps.md))

#### Recorded time

The server UTC time captured for an accepted write transaction and stored for
audit and operational duration. It does not replace transaction sequence or
make the latest record authoritative.

**Avoid:** effective time; source occurrence time; ordering key.
([ADR-0043](../adr/0043-order-records-by-transaction-sequence-not-timestamps.md))

#### Effective time

The optional domain time or interval at which a definition, fact, decision, or
source statement claims applicability. Only the governing contract may give it
precedence semantics.

**Avoid:** recorded time; ingestion order; automatic latest-wins timestamp.
([ADR-0043](../adr/0043-order-records-by-transaction-sequence-not-timestamps.md))

#### Evaluation time

The server UTC instant captured after acquiring the write transaction and used
for that command's authority and deadline checks. Time-bounded authority is
expired when evaluation time equals its expiry.

**Avoid:** client time; transaction sequence; long-running command start time.
([ADR-0043](../adr/0043-order-records-by-transaction-sequence-not-timestamps.md))

#### As-known boundary

The transaction sequence through which Fluent had accepted records for a
historical query, decision, or explanation. It keeps later-arriving information
from being presented as knowledge available to an earlier authority act.

**Avoid:** effective time alone; current knowledge projected backward.
([ADR-0043](../adr/0043-order-records-by-transaction-sequence-not-timestamps.md))

### Work coordination

#### Work item

The durable bounded unit Fluent coordinates, with one objective, acceptance
criteria, authority, repository scope, and lineage. A work item persists across
attempts and is not a GitHub issue, PR, worker process, or human decision.

**Avoid:** task; job; ticket; attempt.
([ADR-0003](../adr/0003-separate-work-coordination-from-execution.md),
[ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md))

#### Work kind

A stable semantic class of work, such as maintenance assessment, adversarial
review, or delivery implementation. Work kind selects the family of applicable
behavior but does not encode its workflow version, worker role, objective,
priority, or risk.

**Avoid:** role; workflow version; mutable task label.
([ADR-0021](../adr/0021-run-bounded-maintenance-assessments.md))

#### Proposal

A complete candidate work item that is retained for audit but is not yet
admitted or claimable. Worker-created follow-ups always begin as proposals.

**Avoid:** queued work; approved task; suggestion with no bounded contract.
([ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md))

#### Authorization

A specific accepted source fact permitting a bounded definition or operation to
exist. Authorization never means that current prerequisites pass or that a
particular principal may exercise every related action.

**Avoid:** authority; eligibility; generic approval.
([ADR-0034](../adr/0034-schedule-a-bounded-ready-inventory.md))

#### Admission

The authorization decision applied to one proposed work item, allowing it to
enter scheduling when all other gates pass. Admission does not make the item
eligible, ready, claimed, correct, or successful.

**Avoid:** approval; enqueue; completion.
([ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md),
[ADR-0006](../adr/0006-enforce-admission-in-the-database.md))

#### Authority

The effective ability of a principal, session, or work attempt to perform a
specific action on a specific scope at a specific time. Authority is the
intersection of policy, work, grant, lifecycle, and product ceilings.

**Avoid:** authorization; credentials; role; capability.
([ADR-0017](../adr/0017-standardize-actions-boundaries-and-risk.md),
[ADR-0032](../adr/0032-route-work-with-operator-issued-grants.md))

#### Eligibility

The current fact that an authorized work item passes its dependencies, policy,
context, holds, review and verification gates, and routing prerequisites.
Eligibility may change without changing the work item's authorization.

**Avoid:** admission; readiness; priority.
([ADR-0034](../adr/0034-schedule-a-bounded-ready-inventory.md))

#### Ready inventory

The bounded materialized candidate-selection projection used to find work for
atomic claim. Membership reflects one projection generation and never replaces
the claim transaction's current eligibility and authority recheck.

**Avoid:** claim authority; backlog; every authorized item; scheduled
assignment. ([ADR-0034](../adr/0034-schedule-a-bounded-ready-inventory.md),
[ADR-0042](../adr/0042-use-rebuildable-projections-only-as-read-models.md))

#### Claim

The atomic operation that selects one compatible ready work item and creates a
lease for one worker session. Claim is reserved for work acquisition; a
statement offered as evidence is an assertion.

**Avoid:** assertion; preassignment; generic ownership.
([ADR-0034](../adr/0034-schedule-a-bounded-ready-inventory.md),
[ADR-0036](../adr/0036-maintain-a-canonical-domain-language.md))

#### Lease

A time-bounded secret mutation capability for one work attempt. Expiry,
reclamation, or grant revocation ends its authority without erasing the attempt
or later stale provenance.

**Avoid:** lock; worker grant; artifact correlation nonce.
([ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md),
[ADR-0032](../adr/0032-route-work-with-operator-issued-grants.md))

#### Work lineage

The immutable root and parent-child ancestry connecting decomposition from one
authorized work outcome to bounded follow-up proposals. Work lineage does not
mean revisions of one document, review, or pull request.

**Avoid:** conversation history; review lineage; pull-request lineage.
([ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md))

#### Attempt report

The worker's structured summary, evidence assertions, artifacts, limitations,
and follow-up proposals at the end of an attempt. Reporting ends the attempt but
does not verify its assertions, artifacts, or outcome; an operator's rejection
or cancellation rationale is a decision fact, not an attempt report.

**Avoid:** result; work resolution; proof; verification; successful completion.
([ADR-0030](../adr/0030-execute-one-slice-through-one-pull-request.md),
[ADR-0035](../adr/0035-route-human-authority-through-typed-decisions.md))

#### Blocked work

A work item whose current attempt cannot make responsible progress without
human input or an external state change. Blocking ends the lease and preserves
the reason; it is not failure, cancellation, or a fleet-wide hold.

**Avoid:** review blocker; hold; andon; terminal failure.
([ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md),
[ADR-0035](../adr/0035-route-human-authority-through-typed-decisions.md))

#### Artifact

A durable external or stored output associated with an attempt, such as an
issue, pull request, commit, or report. Artifact existence and lineage can be
reconciled without establishing correctness or acceptance.

**Avoid:** outcome; evidence by itself; work item.
([ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md))

### Assertions, evidence, and assurance

#### Assertion

A statement from a worker, model, source, or person that has not yet been
established through its required verification or attestation path. Structured
shape and confident language do not turn an assertion into a fact.

**Avoid:** claim; fact; proof.
([ADR-0004](../adr/0004-keep-models-outside-the-control-path.md),
[ADR-0036](../adr/0036-maintain-a-canonical-domain-language.md))

#### Provenance

The recorded origin, identity, time, lineage, and method associated with an
assertion, observation, evidence item, or artifact. Provenance supports
evaluation but does not establish truth.

**Avoid:** verification; trust; correctness.
([ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md))

#### Observation

A reading obtained from a named source about an exact subject. It distinguishes
Fluent's server-assigned observation time from optional source occurrence time,
retains verification state, and may conflict with another observation without
either being silently erased.

**Avoid:** eternal fact; model summary; inferred status.
([ADR-0011](../adr/0011-treat-knowledge-as-reviewed-advisory-evidence.md),
[ADR-0023](../adr/0023-base-ci-maintenance-on-observed-runs.md),
[ADR-0043](../adr/0043-order-records-by-transaction-sequence-not-timestamps.md))

#### Evidence

The bounded set of relevant assertions, observations, artifacts, evaluations,
or attestations considered for a criterion or decision. Evidence carries
provenance and trust state; its presence alone does not imply sufficiency.

**Avoid:** proof; transcript dump; artifact URL alone.
([ADR-0011](../adr/0011-treat-knowledge-as-reviewed-advisory-evidence.md),
[ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md))

#### Fact

An authoritative durable proposition established by a mechanism accepted for
that subject, such as a deterministic evaluation, trusted external observation,
canonical merge, or typed human decision. A later fact may supersede its
applicability but does not rewrite its history.

**Avoid:** model conclusion; convenient inference; timeless truth.
([ADR-0004](../adr/0004-keep-models-outside-the-control-path.md),
[ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md),
[ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md),
[ADR-0040](../adr/0040-establish-facts-through-registered-predicate-contracts.md))

#### Predicate contract

The sole versioned semantic owner of one named authoritative proposition
family, defining its subjects, payload, establishment paths, evidence,
temporality, conflicts, reduction, and consumers.

**Avoid:** arbitrary predicate string; JSON shape as semantics; controller-owned
fact. ([ADR-0040](../adr/0040-establish-facts-through-registered-predicate-contracts.md))

#### Fact establishment

The validated transactional creation of a fact through one finite path allowed
by its predicate contract, citing the exact subject, revision binding, source,
inputs, evidence, and mechanism. It is not a generic database insertion.

**Avoid:** set fact; assertion promotion by mutation; trusted transport as
truth. ([ADR-0040](../adr/0040-establish-facts-through-registered-predicate-contracts.md))

#### Fact reducer

The pure versioned deterministic function that interprets applicable facts for
one predicate and subject under the predicate contract's temporal, conflict,
supersession, and invalidation rules.

**Avoid:** latest row wins; projection; network lookup; model judgment.
([ADR-0040](../adr/0040-establish-facts-through-registered-predicate-contracts.md))

#### Validation

The execution of declared structural or deterministic checks against an input,
contract, or artifact. Validation produces observations; it does not replace
semantic review, human authority, or outcome verification.

**Avoid:** review; attestation; generic proof that work is good.
([ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md),
[ADR-0030](../adr/0030-execute-one-slice-through-one-pull-request.md))

#### Verification

The authoritative evaluation of an exact subject against a declared criterion
using its accepted evidence mode. Verification is subject-specific: verifying
artifact identity does not verify code correctness or outcome achievement.

**Avoid:** validation; review recommendation; worker confidence.
([ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md),
[ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md))

#### Attestation

An authenticated named human's evidence-bound decision satisfying a criterion
whose accepted mode is `human-attested`. Attestation is not a model verdict,
generic approval, or permission to bypass deterministic policy.

**Avoid:** review pass; assertion; rubber stamp.
([ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md))

#### Reconciliation

The deterministic comparison of a report or prior record with current trusted
external facts, preserving matches, mismatches, unavailability, and stale
lineage. Reconciliation observes authority systems; it does not impersonate
their actions.

**Avoid:** validation; acceptance; overwrite with latest state.
([ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md),
[ADR-0035](../adr/0035-route-human-authority-through-typed-decisions.md))

#### Projection

A disposable reproducible read model over declared source records and current
operational state, used for display, filtering, or coordination. A projection
can be rebuilt and never replaces source truth, grants access, or authorizes a
mutation.

**Avoid:** source of truth; mutable status as the only record.
([ADR-0020](../adr/0020-call-the-repository-coordinator-repositorycontroller.md),
[ADR-0034](../adr/0034-schedule-a-bounded-ready-inventory.md),
[ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md),
[ADR-0042](../adr/0042-use-rebuildable-projections-only-as-read-models.md))

#### Projection contract

The versioned registry entry defining one projection's inputs, transformation,
schema, information handling, freshness, rebuild, activation, health, and
consumers. It owns read-model semantics but no source authority.

**Avoid:** arbitrary SQL view; predicate contract; source-of-truth schema.
([ADR-0042](../adr/0042-use-rebuildable-projections-only-as-read-models.md))

#### Projection generation

One immutable validated build of a projection at explicit source watermarks,
evaluation time, and contract versions. Activation selects a generation for
reads but does not make its rows authoritative.

**Avoid:** subject revision; authority snapshot; mutable cache contents.
([ADR-0042](../adr/0042-use-rebuildable-projections-only-as-read-models.md))

#### Operational state

Mutable current data used only for concurrency and delivery mechanics, such as
a lease, cursor, fairness credit, retry schedule, or WIP counter. Its
transactional history is attributable, but its current value is not
retrospective product truth.

**Avoid:** fact; product outcome; universal status; convenient source of truth.
([ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md))

#### Event

An append-only, past-tense, versioned account of a command, observation,
transition, invalidation, or reconciliation outcome, bound to its subject and
causal context. An event explains what happened but does not itself establish
authority or evidence sufficiency.

**Avoid:** fact; authorization; command; source of current truth.
([ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md))

#### Event ledger

The append-only collection of events used for audit, notification,
ProcessObserver funnels, and debugging. Current authority and projections must
remain answerable without treating replay of the ledger as the only database
of truth.

**Avoid:** event-sourced authority; fact store; mutable activity log.
([ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md))

#### Status

A compact projected label describing a subject's current stage for humans or
clients. Status is not a complete state machine, evidence record, or authority
fact.

**Avoid:** source fact; proof; one column standing in for independent states.
([ADR-0030](../adr/0030-execute-one-slice-through-one-pull-request.md))

#### Acceptance criterion

A verifiable condition for one work item or delivery slice. It defines the
bounded outcome required from that unit, not the initiative's longer-term
product success.

**Avoid:** task instructions; success measure; review preference.
([ADR-0028](../adr/0028-approve-immutable-delivery-plans-in-core.md),
[ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md))

#### Success measure

A declared measure of whether a goal or initiative achieved its intended
outcome, with an evidence mode, subject, absolute observation window, and exact
verification profile plus parameters as its decision rule. Success measures
remain distinct from merged artifacts and slice acceptance.

**Avoid:** acceptance criterion; activity count; convenient proxy.
([ADR-0009](../adr/0009-apply-goals-through-discovery-and-admission.md),
[ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md),
[ADR-0054](../adr/0054-bind-success-measures-to-versioned-verification-profiles.md))

#### Verification profile

An immutable versioned Core contract binding one evidence mode to closed
versioned Fluent mechanism identifiers and a strict parameter schema. A profile
supplies reusable verification mechanics but is not an organization record,
measure, policy, fact, or executable script from Core.

**Avoid:** metric DSL; goal; predicate contract; model rubric; remote query.
([ADR-0054](../adr/0054-bind-success-measures-to-versioned-verification-profiles.md))

### Organization governance

#### Core candidate

One exact bounded `frostyard/core` source revision materialized for validation
and possible activation. A candidate is staging input and becomes neither
authority nor a Core snapshot merely because it was fetched or validated.

**Avoid:** Core snapshot; latest branch contents; pending authority.
([ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md))

#### Core candidate rejection

A non-authoritative observation and audit event that one activation invocation
could not produce or activate a Core candidate, with bounded sanitized
diagnostics. Rejection leaves the current Core snapshot authoritative and does
not imply that a candidate or failed snapshot exists.

**Avoid:** failed snapshot; activation fact; repository hold; terminal failure.
([ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md),
[ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md),
[ADR-0048](../adr/0048-retain-core-check-detail-for-30-days.md))

#### Core source continuity

Verified Git ancestry from the active Core snapshot's source commit to a
different candidate commit. Automatic activation requires this evidence; a
rewound, unrelated, or unverifiable history remains non-authoritative.

**Avoid:** branch freshness; newer commit; trusted ref; fast-forward snapshot.
([ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md))

#### Core source check

One durable outcome from automatically inspecting the configured Core ref for
source availability, candidate validity, and eligibility to remain or become
authority. It is distinct from read-only verification, exact-commit rollback
inspection, and snapshot activation.

**Avoid:** sync attempt; health ping; verification result; activation result.
([ADR-0046](../adr/0046-separate-core-source-freshness-from-admission-readiness.md))

#### Core poll run

One leased operational invocation in which `CoreSourceController` inspects the
configured Core ref and applies synchronization bookkeeping. A run may suppress
unchanged hard-failure detail and therefore is not itself a Core source check,
authority record, or freshness event.

**Avoid:** Core source check; sync transaction; scheduler tick; agent run.
([ADR-0049](../adr/0049-poll-core-through-one-leased-controller.md))

#### Core check detail

The bounded diagnostic occurrences and retry receipt for one eligible Core
source check or candidate rejection. Fluent may prune ordinary detail after 30
days or beyond the eligible count limit, but a current-readiness anchor or
evidence cited by a retained decision remains protected.

**Avoid:** Core snapshot history; authority history; permanent audit log;
current-readiness state. ([ADR-0048](../adr/0048-retain-core-check-detail-for-30-days.md))

#### Core source freshness

The elapsed time since the configured Core ref last fetched and validated
successfully. Freshness says nothing by itself about continuity, persistence,
or permission to create organization-dependent work.

**Avoid:** Core admission readiness; branch freshness; active-snapshot age.
([ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md),
[ADR-0046](../adr/0046-separate-core-source-freshness-from-admission-readiness.md))

#### Core admission readiness

The deterministic precondition for new organization-dependent discovery and
admission, derived from active Core authority, source-check outcome, freshness,
and any applicable stale-source override. It does not gate retained-context
reads or already admitted work.

**Avoid:** source freshness; Core health; repository readiness; queue health.
([ADR-0046](../adr/0046-separate-core-source-freshness-from-admission-readiness.md))

#### Stale-source override

An attributed expiring operator decision that temporarily permits Core
admission readiness beyond its elapsed-time freshness boundary. It cannot
bypass missing authority, invalidity, continuity rejection, or persistence
failure, and one decision can last no more than 24 hours from issuance.

**Avoid:** Core rollback; validation waiver; continuity override; permanent exception.
([ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md),
[ADR-0035](../adr/0035-route-human-authority-through-typed-decisions.md),
[ADR-0046](../adr/0046-separate-core-source-freshness-from-admission-readiness.md),
[ADR-0047](../adr/0047-cap-stale-source-overrides-at-24-hours.md))

#### Core rollback activation

An attributed operator authority transition that names an exact verified Core
commit and reason while retaining all prior snapshots. It deliberately bypasses
automatic source-continuity eligibility but does not rewrite Git or undo a
database transaction.

**Avoid:** transaction rollback; branch reset; force-push acceptance; restore.
([ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md),
[ADR-0035](../adr/0035-route-human-authority-through-typed-decisions.md))

#### Core snapshot

One atomic validated import of the canonical `frostyard/core` organization
records at an exact Git revision. Fluent either activates the whole snapshot or
retains the prior one; individual files never become authority independently.

**Avoid:** latest branch contents; arbitrary core prose; partial import.
([ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md))

#### Core snapshot activation

The authority act that selects one retained Core snapshot as the current
organization authority for one Fluent deployment. Activation is distinct from
fetching, validation, importing bytes, following the latest branch, and
repository enrollment.

**Avoid:** successful validation; latest core; enrollment; mutable pointer.
([ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md),
[ADR-0040](../adr/0040-establish-facts-through-registered-predicate-contracts.md))

#### Organization record

A strict versioned JSON record in core with common identity, lifecycle,
ownership, and applicability. V1 organization records have exactly five kinds:
goal, policy, knowledge, criteria set, and exception.

**Avoid:** any file in core; repository-local configuration; initiative
declaration. ([ADR-0008](../adr/0008-use-five-organization-record-kinds.md),
[ADR-0013](../adr/0013-author-organization-records-as-strict-json.md))

#### Goal

A reviewed time-bounded statement of desired organization outcome and success
measures. A goal influences discovery and priority but never grants an action or
admits work.

**Avoid:** policy; authorization; vision prose treated as executable.
([ADR-0009](../adr/0009-apply-goals-through-discovery-and-admission.md))

#### Policy

A mandatory scoped constraint from an accepted organization or repository
authority. Policies combine monotonically: a narrower source may tighten but
not silently relax a broader requirement.

**Avoid:** guidance; goal; model instruction; preference.
([ADR-0010](../adr/0010-enforce-policies-monotonically-with-expiring-exceptions.md))

#### Policy decision

The immutable, revision-bound result of deterministically evaluating applicable
policies for one exact subject and checkpoint, including considered
requirements, verifier or attestation results, exceptions, and source
citations. It may narrow or deny a transition but is not the subject's complete
effective authority.

**Avoid:** effective authority; human decision; generic permission; model
verdict. ([ADR-0010](../adr/0010-enforce-policies-monotonically-with-expiring-exceptions.md),
[ADR-0017](../adr/0017-standardize-actions-boundaries-and-risk.md))

#### Knowledge

Reviewed advisory information with sources, applicability, confidence, and
lifecycle. Knowledge informs reasoning but never becomes policy, authorization,
or verified truth merely because a worker contributed it.

**Avoid:** memory; policy; fact without verification state.
([ADR-0011](../adr/0011-treat-knowledge-as-reviewed-advisory-evidence.md))

#### Criteria set

An immutable versioned collection of readiness criteria and evidence rules used
for a repository assessment. A level or score without its criteria-set version
is incomplete.

**Avoid:** mutable checklist; ACMM level by itself; vendor-settings test.
([ADR-0012](../adr/0012-version-criteria-and-preserve-assessment-truth.md))

#### Assessment

An evaluation of one exact repository revision against one exact criteria-set
version, retaining criterion-level evidence and uncertainty. A later assessment
does not rewrite an earlier result under new criteria.

**Avoid:** timeless maturity level; maintenance finding; audit with unbounded
scope. ([ADR-0012](../adr/0012-version-criteria-and-preserve-assessment-truth.md))

#### Exception

An accepted, scoped, owned, expiring authorization to depart from one named
policy requirement with compensating controls and a closure plan. An exception
never erases the underlying policy or creates a general precedent.

**Avoid:** waiver in prose; local override; permanent relaxation.
([ADR-0010](../adr/0010-enforce-policies-monotonically-with-expiring-exceptions.md))

#### Enrollment

The core-authorized lifecycle connecting one immutable GitHub repository
identity to Fluent programs, ceilings, and organization context. Organization
membership or local configuration alone does not enroll a repository.

**Avoid:** opt-in flag as sole authority; discovery; GitHub organization
membership. ([ADR-0015](../adr/0015-authorize-repository-enrollment-through-core.md))

#### Repository declaration

The versioned core authority record that identifies one GitHub repository and
sets its fleet state, maintenance programs, action ceiling, accountable owners,
and repository-surface contract. It is an input to enrollment, not evidence of
runtime enrollment and not a repository-local policy instance.

**Avoid:** enrollment state; repository opt-in file; local governance policy.
([ADR-0015](../adr/0015-authorize-repository-enrollment-through-core.md))

#### Repository reconciliation

The deterministic, resumable process that materializes one active Core
repository declaration, compares its mutable GitHub locator with the immutable
source identity, and later validates canonical surfaces as separate facts. An
identity match alone does not establish enrollment.

**Avoid:** repository sync as one status; GitHub lookup as enrollment; agent
onboarding. ([ADR-0050](../adr/0050-reconcile-repository-enrollment-as-separate-facts.md))

#### Repository authority-context digest

The versioned digest of the semantic Core, GitHub identity, exact repository
commit, canonical-surface, checkpoint, program, and action-ceiling inputs that
established one repository enrollment. Equivalent retry records and check times
do not change it; changed authority or repository content does.

**Avoid:** snapshot ID alone; current status hash; event digest; proof that work
is correct. ([ADR-0053](../adr/0053-resume-only-unchanged-transient-held-work.md))

#### Canonical surface

The one declared path and format from which Fluent reads a type of repository or
organization information. Compatibility symlinks may point to it, but alternate
copies and vendor-specific files do not become competing authority.

**Avoid:** convention inferred from duplicates; any familiar vendor path.
([ADR-0016](../adr/0016-read-only-canonical-repository-surfaces.md))

#### Canonical-surface validation

The exact-commit evaluation that loads only the paths selected by the active
Core surface contract, verifies their Git object types and content, and records
an enrollment-checkpoint decision. A valid result is an enrollment prerequisite,
not enrollment itself.

**Avoid:** repository checkout validation; file presence as enrollment; latest
branch files. ([ADR-0016](../adr/0016-read-only-canonical-repository-surfaces.md),
[ADR-0051](../adr/0051-pin-surfaces-to-the-observed-default-branch-head.md))

#### Repository identity

The immutable GitHub repository ID used for authority, lineage, and
reconciliation. The owner/name slug is a mutable display and routing locator,
not stable identity.

**Avoid:** repository slug as immutable identity; local checkout path.
([ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md),
[ADR-0045](../adr/0045-host-fluent-under-frostyard.md))

#### Risk tier

The highest plausible impact classification for a bounded work item or change,
using `low`, `moderate`, `high`, or `critical`. Risk determines controls and is
not scheduling priority.

**Avoid:** urgency; confidence; repository-specific replacement scale.
([ADR-0017](../adr/0017-standardize-actions-boundaries-and-risk.md),
[ADR-0034](../adr/0034-schedule-a-bounded-ready-inventory.md))

#### Information class

A policy-controlled sensitivity class of `public`, `organization`, or
`restricted`, governing whether a principal or worker grant may know that
information exists and inspect it. Class is ordered but remains independent
from action authority, capability, risk, and subject-level scope.

**Avoid:** risk tier; redaction alone; repository visibility.
([ADR-0024](../adr/0024-restrict-security-findings-before-disclosure.md),
[ADR-0032](../adr/0032-route-work-with-operator-issued-grants.md),
[ADR-0041](../adr/0041-enforce-three-information-classes-and-scoped-access.md))

#### Information scope

The exact repositories, subjects, roles, and restricted compartments within
which a principal, session, or grant may know of or read records at an allowed
information class. A class ceiling alone grants no record access.

**Avoid:** information class; repository membership; all restricted records.
([ADR-0041](../adr/0041-enforce-three-information-classes-and-scoped-access.md))

#### Declassification

The governed creation of a new lower-class record from exact higher-class
sources through authorized review, bounded schema, leakage checks, and
attestation. It never relabels or exposes a filtered view of the source record.

**Avoid:** redaction in place; projection; aggregation; automatic downgrade.
([ADR-0041](../adr/0041-enforce-three-information-classes-and-scoped-access.md))

### Controllers, programs, and delivery

#### CoreSourceController

The single leased deterministic coordinator for periodic Core source
inspection, backoff, duplicate disposition, and retention maintenance. It owns
operational schedule state but does not establish organization authority or
decide admission readiness.

**Avoid:** Core agent; snapshot authority; RepositoryController; polling worker.
([ADR-0049](../adr/0049-poll-core-through-one-leased-controller.md))

#### RepositoryController

The single durable deterministic coordinator for one enrolled repository,
holding its accepted context, programs, observations, work, and outcome history.
It is code plus state, never an LLM, worker, or provider session.

**Avoid:** repository agent; steward; manager process.
([ADR-0020](../adr/0020-call-the-repository-coordinator-repositorycontroller.md))

#### FleetController

The single durable deterministic coordinator for relationships and outcomes
across enrolled repositories. It derives fleet state from repository and core
facts without becoming the authority for repository contracts or product
intent.

**Avoid:** fleet agent; central architect; organization super-controller.
([ADR-0026](../adr/0026-coordinate-enrolled-repositories-with-fleetcontroller.md))

#### ProcessObserver

The single durable deterministic observer of Fluent's own operational funnels,
baselines, and versioned process performance. It may pull a scoped andon under
accepted rules but never modifies or approves the process it measures.

**Avoid:** observer agent; self-improving model; dashboard only.
([ADR-0033](../adr/0033-observe-processes-and-pull-scoped-andons.md))

#### Maintenance program

An explicitly enabled recurring class of bounded repository improvement, such
as quality, CI, security, or architecture. A program authorizes its declared
assessment cadence, not arbitrary findings or implementation.

**Avoid:** worker role; one work item; perpetual audit.
([ADR-0021](../adr/0021-run-bounded-maintenance-assessments.md))

#### Workflow

A versioned contract describing the roles, briefs, gates, evidence, attempts,
and outcomes for one work kind. A workflow is not a running attempt, delivery
plan, or free-form prompt.

**Avoid:** process session; skill file alone; phase.
([ADR-0021](../adr/0021-run-bounded-maintenance-assessments.md),
[ADR-0033](../adr/0033-observe-processes-and-pull-scoped-andons.md))

#### Workflow version

The immutable identifier and digest of the exact workflow contract governing a
subject. Changing roles, briefs, gates, evidence, attempts, or outcome rules
creates another workflow version without changing the work kind.

**Avoid:** work kind; latest workflow; skill version by itself.
([ADR-0021](../adr/0021-run-bounded-maintenance-assessments.md),
[ADR-0033](../adr/0033-observe-processes-and-pull-scoped-andons.md))

#### Stage

A projected label for a subject's current location in a workflow, derived from
independent facts. Stage is for coordination and display; it is not the stored
authority or a roadmap phase.

**Avoid:** status as sole state; phase; gate.
([ADR-0030](../adr/0030-execute-one-slice-through-one-pull-request.md))

#### Gate

A named deterministic predicate that must pass before a subject advances to a
later stage. A review recommendation or worker assertion supplies evidence to a
gate but cannot redefine or bypass it.

**Avoid:** workflow stage; human preference; prompt instruction.
([ADR-0029](../adr/0029-bound-adversarial-review.md),
[ADR-0030](../adr/0030-execute-one-slice-through-one-pull-request.md))

#### Review

A bounded semantic evaluation of an exact subject and revision under a named
profile, producing findings and a recommendation. Review does not itself grant
authority, merge an artifact, or verify an outcome.

**Avoid:** approval; validation; verification.
([ADR-0029](../adr/0029-bound-adversarial-review.md))

#### Review blocker

A material review finding that matches the profile's finite blocking criteria
and therefore prevents its gate from passing until resolved or validly
dispositioned. A preference, advisory, or repeated rewording is not a blocker.

**Avoid:** blocked work; nit; every review comment.
([ADR-0029](../adr/0029-bound-adversarial-review.md))

#### Initiative

A core-authorized coordinated product outcome linking one canonical PRD to an
exact lifecycle, target repositories, planning authority, and active delivery
plan. An initiative is not the PRD narrative, plan, or collection of arbitrary
work items.

**Avoid:** project; epic; PRD as machine authority.
([ADR-0027](../adr/0027-authorize-feature-planning-from-core-prds.md))

#### Product requirements document (PRD)

The canonical human-readable statement of an initiative's problem, desired
outcomes, scope, constraints, non-goals, and success measures. A PRD informs
planning but does not directly authorize claimable implementation work.

**Avoid:** delivery plan; implementation spec; prompt.
([ADR-0027](../adr/0027-authorize-feature-planning-from-core-prds.md))

#### Delivery plan

An immutable core-approved versioned dependency graph of bounded delivery
slices operationalizing one exact PRD revision and its success measures. A plan
activates atomically and changes only through a new approved version.

**Avoid:** mutable backlog; PRD; worker decomposition report.
([ADR-0028](../adr/0028-approve-immutable-delivery-plans-in-core.md))

#### Delivery slice

One dependency-bounded, independently reviewable implementation outcome from an
approved delivery plan, normally carried through one pull-request lineage. A
slice is not an arbitrary file group or an entire initiative.

**Avoid:** task; phase; PR itself; feature epic.
([ADR-0028](../adr/0028-approve-immutable-delivery-plans-in-core.md),
[ADR-0030](../adr/0030-execute-one-slice-through-one-pull-request.md))

#### Pull-request lineage

The reconciled history connecting one delivery slice to its normal pull request
and any explicitly adopted replacement. Corrective pushes stay in the same
lineage; parallel PRs do not create a clean slate.

**Avoid:** work lineage; every PR sharing a title; review lineage.
([ADR-0030](../adr/0030-execute-one-slice-through-one-pull-request.md))

#### Implementation-complete

The initiative projection meaning every required slice has a reconciled merged
signal. It says nothing yet about post-merge slice acceptance or PRD success.

**Avoid:** delivered; done; outcome achieved.
([ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md))

#### Delivered

The initiative projection meaning every required delivery slice is
outcome-verified. Delivery may still enter measurement and fail to achieve the
initiative's success measures.

**Avoid:** merged; implementation-complete; successful.
([ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md))

#### Outcome-achieved

The initiative projection meaning every required PRD success measure is
satisfied through its accepted evidence mode. It is not inferred from PR count,
merge, CI, elapsed time, or worker confidence.

**Avoid:** complete; delivered; active; successful because code shipped.
([ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md))

### Intervention, scheduling, and human decisions

#### Hold

A runtime condition that makes a bounded subject or scope ineligible or blocks
named advancement gates until its explicit recovery rule is satisfied. Holds
preserve underlying work and evidence, and independent holds clear
independently.

**Avoid:** pause; drain; blocked work; cancellation; process termination.
([ADR-0033](../adr/0033-observe-processes-and-pull-scoped-andons.md),
[ADR-0038](../adr/0038-separate-lifecycle-pause-from-runtime-interventions.md))

#### Operator repository hold

The non-expiring, host-local typed decision that narrows one declared GitHub
repository by blocking discovery, admission, claims, and lease renewal. It is
active until the stored operator clears that exact hold decision; it is not a
Core pause, external reconciliation failure, drain, or held-work disposition.

**Avoid:** suspension; local pause; repository toggle; automatic expiry.
([ADR-0052](../adr/0052-bind-local-repository-holds-to-explicit-operator-decisions.md))

#### Held-work recovery

The deterministic act that keeps, automatically resumes, or presents a
per-item operator disposition after the repository condition that held work is
gone. Only an unchanged authority-context digest after a transient GitHub or
surface outage permits automatic recovery.

**Avoid:** clearing a repository hold; blocked-work requeue; unconditional
resume; batch approval. ([ADR-0053](../adr/0053-resume-only-unchanged-transient-held-work.md))

#### Andon

A ProcessObserver intervention created from a versioned detector and evidence
profile. It is a notice, scoped hold, or safety stop with explicit scope,
review, and recovery conditions—not a free-form model alarm.

**Avoid:** alert without contract; fleet-wide panic button; worker blocker.
([ADR-0033](../adr/0033-observe-processes-and-pull-scoped-andons.md))

#### Pause

A lifecycle state authored by a canonical core record whose schema defines
`paused`. Activating a later authorized core revision is the only way to enter
or leave that state; Fluent runtime state cannot impersonate it.

**Avoid:** runtime pause; local toggle; hold; drain; defer.
([ADR-0015](../adr/0015-authorize-repository-enrollment-through-core.md),
[ADR-0038](../adr/0038-separate-lifecycle-pause-from-runtime-interventions.md))

#### Drain

An attributed, expiring runtime scheduling intervention that prevents new
claims in a bounded scope while allowing existing leases to reach their
normally permitted reporting boundary. Drain alone does not create
ineligibility, quarantine artifacts, or block downstream advancement.

**Avoid:** pause; hold; lease revocation; safety stop.
([ADR-0038](../adr/0038-separate-lifecycle-pause-from-runtime-interventions.md))

#### Defer

The operator decision that withdraws admission from one unclaimed work item
without rejecting or deleting its proposal. Deferred work may later return
through the normal admission decision.

**Avoid:** pause; block; cancel; lower priority.
([ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md))

#### Cancel

An explicit terminal lifecycle decision for the named subject that prevents its
ordinary continuation while preserving history. Cancellation does not delete
evidence, undo external artifacts, or automatically cancel related subjects.

**Avoid:** defer; pause; opt-out; erase.
([ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md),
[ADR-0035](../adr/0035-route-human-authority-through-typed-decisions.md))

#### Supersede

The explicit relationship by which a newer immutable definition replaces an
older one for future applicability while preserving the old identity and
history. Supersession is not mutation, deletion, or proof that in-flight work
was reconciled.

**Avoid:** edit in place; cancel; latest silently wins.
([ADR-0012](../adr/0012-version-criteria-and-preserve-assessment-truth.md),
[ADR-0028](../adr/0028-approve-immutable-delivery-plans-in-core.md))

#### Capacity gap

A derived explanation that authorized or eligible work has no compatible
active worker grant, naming the missing scope or capability. It is operator
information, not permission to duplicate work, weaken requirements, or broaden
a grant.

**Avoid:** empty queue; failure; auto-scaling request.
([ADR-0034](../adr/0034-schedule-a-bounded-ready-inventory.md))

#### Priority band

The scheduling class `urgent`, `high`, `normal`, or `background` assigned only
by accepted policy or an attributed operator decision. Priority orders capacity
and remains independent from risk.

**Avoid:** risk tier; worker-selected integer; importance inferred by a model.
([ADR-0034](../adr/0034-schedule-a-bounded-ready-inventory.md))

#### Work-in-progress limit

A versioned scheduling bound on ready or active work for a declared scope and
stage. It controls materialization and concurrency but does not cancel work,
grant authority, or satisfy dependencies.

**Avoid:** token budget; queue target; admission rule.
([ADR-0034](../adr/0034-schedule-a-bounded-ready-inventory.md))

#### Decision record

A durable typed request for one human authority act, bound to an exact subject,
revision, evidence snapshot, finite choices, and deterministic effects. It is
not a work item and cannot be claimed or resolved by a worker.

**Avoid:** approval task; prompt; generic confirmation dialog.
([ADR-0035](../adr/0035-route-human-authority-through-typed-decisions.md))

#### OperatorInbox

The deterministic derived view of pending decision records visible to the
operator under current access rules. It presents authority but does not own,
broaden, or replace it.

**Avoid:** worker queue; controller; universal approval center.
([ADR-0035](../adr/0035-route-human-authority-through-typed-decisions.md))

#### Disposition

The authenticated selection of one permitted choice for an exact decision or
review finding, with rationale and resulting effects. A disposition is subject-
bound and cannot transfer to a changed revision.

**Avoid:** generic approval; free-form command; waiver without an exception
path. ([ADR-0029](../adr/0029-bound-adversarial-review.md),
[ADR-0035](../adr/0035-route-human-authority-through-typed-decisions.md))

## Current implementation divergence

The disposable queue spike uses caller-supplied `worker`, logical `queued`,
integer `priority`, repository slug identity, one `status`, and a mixed
`result`. These are local terms of the prototype contract, not aliases for the
canonical target concepts. Under
[ADR-0044](../adr/0044-replace-the-queue-spike-database.md), their rows will not
migrate into session identity, factored scheduling, priority bands, immutable
repository identity, independent facts, attempt reports, or typed decisions.
The target vocabulary is implemented cleanly through the
[control-plane kernel bootstrap](../plans/control-plane-kernel-bootstrap.md).

## References

- Practice: [ADR-0036](../adr/0036-maintain-a-canonical-domain-language.md)
- Product: [GitHub organization agent fleet](../prd/agent-fleet.md)
- Current implementation:
  [queue execution boundary](../design/queue-execution-boundary.md) and
  [work queue](../specs/work-queue.md)
