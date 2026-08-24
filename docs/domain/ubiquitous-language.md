# Domain language: Snowcat

- **Status:** Living
- **Last updated:** 2026-08-18

## Scope

This is the canonical language for Snowcat product behavior (the product was
named Fluent until 2026-08-18; ADR-0064). Use these terms in
normative docs, schemas, APIs, database concepts, UI labels, skills, and worker
briefs. Definitions describe the accepted model; the queue store is the v1 work
engine under
[ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md), and
its terms below are v1 vocabulary, not stand-ins awaiting replacement.

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

The initial principal who runs Snowcat and holds the v1 human authorities
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
item through Snowcat's portable protocol. Snowcat does not launch, supervise,
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
not a normative Snowcat domain type; use worker, worker role, worker session,
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
slug, URL, path, branch name, or label. Snowcat retains locator history but never
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

The monotonically increasing order assigned to one committed Snowcat write
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

The transaction sequence through which Snowcat had accepted records for a
historical query, decision, or explanation. It keeps later-arriving information
from being presented as knowledge available to an earlier authority act.

**Avoid:** effective time alone; current knowledge projected backward.
([ADR-0043](../adr/0043-order-records-by-transaction-sequence-not-timestamps.md))

### Work coordination

#### Work item

The durable bounded unit Snowcat coordinates, with one objective, acceptance
criteria, authority, repository scope, and lineage. A work item persists across
attempts and is not a GitHub issue, PR, worker process, or human decision.

**Avoid:** task; job; ticket; attempt.
([ADR-0003](../adr/0003-separate-work-coordination-from-execution.md),
[ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md))

#### Source reference

The stable external origin of an imported work item, such as the GitHub
issue URL, unique per repository. It makes repeated imports idempotent and
tells a worker where the work came from; it is not the item's identity.

**Avoid:** issue link; external id; ticket.
([ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md))

#### Operator note

An operator- or policy-authored annotation carried on a work item to the next
lease — appended by requeue, deferral, prioritization, or an explicit note. It
tells a later worker what happened before; it never changes the definition
and is never written by a worker.

**Avoid:** comment; instruction update; hint from a worker.
([ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md))

#### Delivery state

The state derived on read from a completed work item's verified pull-request
artifacts — none, unverified, open, closed, or merged — or, where the item
reported a release, from its release artifacts, which read published once a
human has published the tag and open while it is still a draft. It records
whether the reported pull request was merged or the reported release
published, not whether the intended outcome was achieved.

**Avoid:** delivered (the initiative projection); done; success.
([ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md),
[ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md),
[ADR-0066](../adr/0066-sequence-project-slices-on-observed-predecessor-delivery.md))

#### Claim eligibility

The decision, made at claim time on top of repository opt-in, that a
repository's admitted work may be leased right now — in v1 supplied by the
control-plane store as "the repository is enrolled". It filters candidates; it
does not admit, order, or lease work.

**Avoid:** enrollment (the control-plane fact itself); permission; grant.
([ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md))

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
intersection of policy, [work](#ceiling-delegation-ceiling), grant, lifecycle,
and product ceilings.

**Avoid:** authorization; credentials; role; capability.
([ADR-0017](../adr/0017-standardize-actions-boundaries-and-risk.md),
[ADR-0032](../adr/0032-route-work-with-operator-issued-grants.md))

#### Ceiling (delegation ceiling)

The `delegableActions` of one work item: the most any child of that item may be
allowed to perform or may itself delegate further. Ceiling is monotonically
non-widening down a work lineage — a child's allowed and delegable actions can
only narrow relative to its parent's ceiling, never widen it. A repository
declaration's action ceiling is a distinct enrollment-level ceiling over an
enrolled repository, not this term
([ADR-0015](../adr/0015-authorize-repository-enrollment-through-core.md)).

**Avoid:** permission; role; grant; action ceiling (the enrollment-level
declaration ceiling).
([ADR-0017](../adr/0017-standardize-actions-boundaries-and-risk.md),
[ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md))

#### Eligibility

The current fact that an authorized work item passes its dependencies, policy,
context, holds, review and verification gates, and routing prerequisites.
Eligibility may change without changing the work item's authorization.

**Avoid:** admission; readiness; priority.
([ADR-0034](../adr/0034-schedule-a-bounded-ready-inventory.md))

#### Predecessor

A dependency one imported work item declares on another through the other
item's source reference, satisfied only when that item is completed and its
verified artifacts are observed delivered. A predecessor delays only the item
declaring it; it grants nothing and is never satisfied by a worker's
assertion.

**Avoid:** blocker (the review term); parent; prerequisite issue link as
mere documentation.
([ADR-0066](../adr/0066-sequence-project-slices-on-observed-predecessor-delivery.md))

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

#### Root

The first item of a work lineage, created by an operator, policy, or feeder
and never by a worker. A root carries `rootId = id` for itself and every
descendant, and is admitted or proposed according to its source, the same as
any other work item; being first in a lineage does not make a root non-leaf
work.

**Avoid:** parent (a root can be a leaf); epic; ticket.
([ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md),
[ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md))

#### Follow-up

A worker-proposed child of the item it completes. A follow-up always begins as
a [proposal](#proposal), inherits its parent's priority, and is bounded by the
parent's [ceiling](#ceiling-delegation-ceiling); one completion proposes at most
ten follow-ups, and a lineage holds at most four edges below its root.

**Avoid:** subtask; next step; approval.
([ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md),
[ADR-0006](../adr/0006-enforce-admission-in-the-database.md))

#### Work lineage

The immutable [root](#root) and parent-child ancestry connecting decomposition
from one authorized work outcome to bounded [follow-up](#follow-up) proposals.
Work lineage does not mean revisions of one document, review, or pull request.

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

#### Required artifact

The artifact kind a work item's completion must report — a pull request, or
none — declared on the item by whoever defined it and never inferred from its
kind or actions. It is the item's delivery contract: an item that requires a
pull request is admitted only with the authority to open one and completes
only when one is reported. It says what must be delivered, not whether the
delivery was merged (delivery state) or the outcome achieved.

**Avoid:** expected artifact; deliverable (the initiative projection);
implied by `write`; fix item.

([ADR-0069](../adr/0069-declare-the-required-artifact-on-every-work-item.md),
[ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md))

#### Execution target

Where a work item's execution happens, declared on the item by whoever
defined it and never inferred from its kind or actions: `read-only` (a
checkout to read and run checks, mutating nothing), `new-pull-request` (a
fresh branch from a fresh default-branch base, delivering a new pull
request), or `existing-pull-request` (the bound pull request's branch at
exactly the recorded head). It describes the checkout and its mutation
mode, not the worker's permissions (allowed actions) or what completion
must report (required artifact); the three must agree, and the queue
refuses an item where they cannot.

**Avoid:** branch mode; workspace type; implied by kind; implied by
`open-pr` (authority to publish a pull request is not authority to alter
the tree).
([ADR-0073](../adr/0073-declare-the-execution-target-on-every-work-item.md))

#### Policy binding

The Core authority revision and repository governance digest a work item was
defined and admitted under, stamped on the item so its authorization is
evidence rather than circumstance. An item defined without a control-plane
store — or before the binding existed — is *unbound*: visible as such, never
back-filled. The binding is what admission judges and what the delivered
diff is checked against; it does not itself grant anything.

**Avoid:** policy snapshot (Core snapshots are the control plane's);
implied by enrollment; authority (the binding cites authority, it is not
one).
([ADR-0074](../adr/0074-compile-policy-into-work-admission.md))

#### Standing authorization

A closed in-code registry entry naming the Accepted ADR that pre-authorizes
one mechanical admission path — a cure, a review round, a review fix — and
the exact action set it may cover. A mechanically admitted item cites its
standing authorization the way a human-admitted item records its approver;
a mechanical path with no entry cannot mint admitted work and proposes
instead.

**Avoid:** auto-approval; policy exception; hard-coded admission; implied
by kind.
([ADR-0074](../adr/0074-compile-policy-into-work-admission.md))

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
Snowcat's server-assigned observation time from optional source occurrence time,
retains verification state, and may conflict with another observation without
either being silently erased.

**Avoid:** eternal fact; model summary; inferred status.
([ADR-0011](../adr/0011-treat-knowledge-as-reviewed-advisory-evidence.md),
[ADR-0023](../adr/0023-base-ci-maintenance-on-observed-runs.md),
[ADR-0043](../adr/0043-order-records-by-transaction-sequence-not-timestamps.md))

#### GitHub delivery receipt

The durable observation-class account that Snowcat authenticated and processed
one directly received GitHub App webhook delivery, bound to its delivery GUID
and exact-body digest. It proves ingress handling, not the truth or completeness
of GitHub state, and cannot be reconstructed from a later delivery-API read.

**Avoid:** GitHub observation; source checkpoint; webhook as authority.
([ADR-0057](../adr/0057-require-webhook-ingress-for-github-observation.md))

#### GitHub delivery-audit observation

The durable observation obtained by reading one GitHub App delivery through
GitHub's authenticated delivery API, including the selected delivery metadata
and exact response digest. It can causally support an API-sourced normalized
observation when no direct receipt was observed, but never reconstructs the
missing webhook receipt or its exact-body digest.

**Avoid:** webhook receipt; redelivery request; source checkpoint.
([ADR-0057](../adr/0057-require-webhook-ingress-for-github-observation.md))

#### GitHub observer installation binding

A reconciled GitHub source relationship stating whether the configured
read-only observer App has one identified installation with current access to
an immutable repository and the required permission/event profile. Its source
observation and reconciliation outcome are durable, but it remains mutable
source access—not Core authorization, repository enrollment, or a credential.

**Avoid:** enrolled App; repository authorization; installation token.
([ADR-0039](../adr/0039-use-typed-source-native-subject-identities.md),
[ADR-0057](../adr/0057-require-webhook-ingress-for-github-observation.md),
[ADR-0058](../adr/0058-bound-github-observation-recovery-and-retention.md))

#### Source checkpoint

A durable adapter observation that completely enumerates one declared source
scope at an exact observation time, including its pagination and source-
revision proof. It establishes that bounded read, not continuous coverage
before or after it.

**Avoid:** polling cursor; observation window; proof of no intervening change.
([ADR-0057](../adr/0057-require-webhook-ingress-for-github-observation.md))

#### Source gap

A registered source scope and lower-bounded interval for which Snowcat cannot
establish required coverage. Its end remains open until exact repair evidence
bounds it; repair never erases the gap occurrence or what Snowcat knew when it
was recorded. A delivery-content gap names the affected source identities and
requires matching repaired observations plus restored interval coverage; an
interval-only gap carries no invented source identity.

**Avoid:** source outage; missing expected occurrence; failed verification.
([ADR-0057](../adr/0057-require-webhook-ingress-for-github-observation.md))

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
versioned Snowcat mechanism identifiers and a strict parameter schema. A profile
supplies reusable verification mechanics but is not an organization record,
measure, policy, fact, or executable script from Core.

**Avoid:** metric DSL; goal; predicate contract; model rubric; remote query.
([ADR-0054](../adr/0054-bind-success-measures-to-versioned-verification-profiles.md))

#### Evidence population

The closed set of uniquely keyed expected occurrences that a registered source
adapter declares complete for one subject and observation window. It includes
missing expected occurrences and is not whatever records a source happened to
return.

**Avoid:** API response list; successful observations only; evaluator-selected
sample. ([ADR-0055](../adr/0055-separate-evidence-population-from-rate-evaluation.md))

#### Verification result

The bounded `satisfied`, `failed`, or `unable` output of one exact verification
mechanism version over retained evidence. A result is not by itself a Goal
lifecycle change, aggregate outcome fact, or worker recommendation.

**Avoid:** Goal status; model verdict; generic success.
([ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md),
[ADR-0055](../adr/0055-separate-evidence-population-from-rate-evaluation.md))

#### Enforced required check

A source-attributed status-check selector in an active GitHub ruleset applying
to an exact repository branch. It is enforcement configuration, not an
optional CI run, a check name mentioned in Core, or one observed result.

**Avoid:** important check; declared CI job; every check run.
([ADR-0056](../adr/0056-derive-required-checks-from-enforced-github-rules.md))

#### Required-check revision

The exact Git commit revision GitHub evaluated for enforced required checks
when a pull request merged. It may be a pull-request head or test merge commit
and must be observed rather than inferred from the final merge commit.

**Avoid:** merge commit by default; latest head; current branch tip.
([ADR-0056](../adr/0056-derive-required-checks-from-enforced-github-rules.md))

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
source check or candidate rejection. Snowcat may prune ordinary detail after 30
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
records at an exact Git revision. Snowcat either activates the whole snapshot or
retains the prior one; individual files never become authority independently.

**Avoid:** latest branch contents; arbitrary core prose; partial import.
([ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md))

#### Core snapshot activation

The authority act that selects one retained Core snapshot as the current
organization authority for one Snowcat deployment. Activation is distinct from
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
identity to Snowcat programs, ceilings, and organization context. Organization
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

The one declared path and format from which Snowcat reads a type of repository or
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

#### GitHub reconciliation controller

The deterministic coordinator for the observer App's leased delivery audit and
independently leased repository source reads. Its schedule and acquisition
outcomes are operational state; only separate typed observations, checkpoints,
and gaps establish durable source evidence or coverage.

**Avoid:** GitHub agent; webhook ingress; source checkpoint; delivery worker.
([ADR-0057](../adr/0057-require-webhook-ingress-for-github-observation.md),
[ADR-0058](../adr/0058-bound-github-observation-recovery-and-retention.md))

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

The single durable deterministic observer of Snowcat's own operational funnels,
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

#### Description blocker

A review blocker whose only cure is a change to the pull-request description,
named by the `contract:pr-body:` fingerprint prefix. A description blocker is
adjudicated by a human and never mints automated fix work, because rounds key
on heads and a description cure moves none.

**Avoid:** tree blocker; template nit; body comment.
([ADR-0067](../adr/0067-adjudicate-description-blockers-by-a-human.md))

#### Review gate

A per-repository setting under which worker pull requests stay drafts until
one bounded review round passes. While it is on, a completion that reports an
open, non-draft pull request is refused, the verification pass creates review
rounds for draft heads, and Snowcat — not a model — acts on each verdict: a
pass marks the pull request ready for a human, a block within budget creates
one bounded fix, and anything else waits for a person.

**Avoid:** required approval; merge gate; branch protection; Copilot review.
([ADR-0065](../adr/0065-gate-worker-pull-requests-behind-bounded-review.md),
[ADR-0029](../adr/0029-bound-adversarial-review.md))

#### Review round

One read-only `pr-review` work item bound to one pull request head, counted
per pull request (not per head) toward a budget of three completed rounds
before human adjudication. A round's verdict — pass, block, or
unable-to-review, with at most five fingerprinted blockers — binds to that
head alone: a new head invalidates it, and only its blockers are carried into
the next round, as prior blockers the re-review must examine.

**Avoid:** review comment; re-review of a fresh audit; attempt; lease.
([ADR-0065](../adr/0065-gate-worker-pull-requests-behind-bounded-review.md),
[ADR-0029](../adr/0029-bound-adversarial-review.md))

#### Pull-request cure

One admitted `pr-cure` work item bound to one decayed, non-draft pull request
head, whose success is an unchanged patch on a healthier pull request:
mechanical changes only, enforced by recomputing the patch identity on
completion; a needed substantive change becomes a `pr-cure-change` proposal.
Cure acts only after a pull request is ready for review; the review gate acts
only while it is a draft.

**Avoid:** fix; rebase bot; review; merge.
([ADR-0061](../adr/0061-cure-pull-requests-as-bounded-per-head-work.md),
[ADR-0065](../adr/0065-gate-worker-pull-requests-behind-bounded-review.md))

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
or leave that state; Snowcat runtime state cannot impersonate it.

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

#### Operator surface

The server-rendered web view over the same store methods the CLI uses —
inbox, repository board, item page — through which the operator reads the
queue and makes the CLI's operator decisions. It owns no state, adds no
transition, and renders no lease token.

**Avoid:** dashboard (as a separate system); admin app; worker UI.
([ADR-0060](../adr/0060-bring-the-operator-surface-forward-as-a-read-first-inbox.md))

#### Stale-intent precondition

The rendered status and last-updated time a mutation carries so the store can
refuse a decision made against an item that has since changed. It protects
the operator from acting on stale facts; it is not a lock or a lease.

**Avoid:** optimistic lock; version check; retry.
([ADR-0035](../adr/0035-route-human-authority-through-typed-decisions.md),
[ADR-0060](../adr/0060-bring-the-operator-surface-forward-as-a-read-first-inbox.md))

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

The queue store's local vocabulary — a caller-supplied worker identity string,
integer priority, repository slug identity, one status column plus an
admission flag, a mixed result, derived delivery state, operator notes, and
source references — is the v1 vocabulary under
[ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md). Each
of those compromises is upgraded in place, by a numbered migration rung, when
a real repository shows the need; none of them is a stand-in awaiting a
rewrite. The control-plane store's typed subjects, facts, and decisions are
the vocabulary of the authority and observation sidecar, coupled to the queue
only through claim eligibility.

## References

- Practice: [ADR-0036](../adr/0036-maintain-a-canonical-domain-language.md)
- Product: [GitHub organization agent fleet](../prd/agent-fleet.md)
- Current implementation:
  [queue execution boundary](../design/queue-execution-boundary.md) and
  [work queue](../specs/work-queue.md)
