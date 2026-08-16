# 0035 — Route human authority through typed decisions

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

Fluent deliberately stops for human authority at proposal admission, blocker
disposition, additional repair attempts, artifact reconciliation, worker-grant
issuance, andon disposition, temporary scheduling overrides, semantic outcome
attestation, plan drift, and failed verification. Those decisions currently
span several conceptual workflows.

Putting them into the capable-worker queue would let an agent consume a task
that only a person may authorize. Treating them as free-form buttons would hide
their different subjects, evidence, authority, effects, and canonical systems.
In particular, a local Fluent approval cannot substitute for merging a PR in
`frostyard/core`, an authorized repository review, or a restricted security
disclosure decision.

Human decisions also become stale. A blocker may refer to an old PR head, a
grant to an old policy snapshot, or an attestation to evidence that has since
been invalidated. A useful operator surface must reject stale intent rather
than apply it to new facts.

## Decision

Fluent represents every required human authorization as a durable typed
`decision record`. `OperatorInbox` is the deterministic derived view of pending
decision records for the initial operator; it is not a work queue, controller,
agent, or separate source of authority.

Decision records are never claimable through worker MCP, never delegated to a
worker, and never completed by model output. A process-improvement proposal,
review report, or worker recommendation may create evidence for a decision but
cannot choose its disposition.

Each decision record contains at least:

- immutable decision identity, decision type, creation source, and correlation
  lineage;
- exact subject kind, stable identity, repository or initiative scope, and
  revision, digest, PR head SHA, or evidence snapshot being decided;
- risk, information class, applicable policy and authority snapshot, and
  evidence references safe for the deciding principal;
- why a decision is required and the explicit finite choices currently
  permitted;
- deterministic effects and remaining obligations for each choice;
- principal role or exact authority required to decide;
- required rationale, expiry or duration where applicable, creation time,
  review deadline, and invalidation conditions; and
- current state and an append-only event history of views, submissions,
  validation, resolution, expiry, supersession, and external observations.

Free-form rationale is evidence attached to a typed choice. It MUST NOT add a
choice, grant an action, change scope, waive an undeclared constraint, or become
instructions to a worker.

A decision submission uses optimistic concurrency. It repeats the exact subject
and authority versions rendered to the principal. Before applying a choice,
Fluent re-evaluates identity, role, subject revision, evidence, policy, holds,
decision state, and every invalidation condition in one transaction. If any
binding fact changed, the submission fails as `stale`; Fluent retains the
attempt and creates or refreshes the decision against current facts rather than
transferring the old choice.

Decision state distinguishes at least `pending`, `resolved`, `expired`,
`superseded`, `cancelled`, `stale`, and `waiting-external`. Resolution records
the authenticated principal, selected typed choice, rationale, exact subject,
effective deterministic changes, time, and resulting events. Repeated identical
submission is idempotent; a conflicting second submission cannot overwrite the
first.

Human authority remains bounded. A typed choice may perform only effects
declared by its versioned decision contract and allowed by current policy. It
cannot override a deterministic denial, action ceiling, expired exception,
restricted-data control, unresolved safety invariant, repository opt-out, or
canonical approval path. Where an exception is permitted, the choice initiates
or cites the accepted exception workflow rather than embedding a hidden waiver.

V1 Fluent-runtime decision types include at least:

- approve, reject, or defer a worker-created proposal;
- requeue or cancel blocked work;
- resolve, waive where policy permits, or escalate an adversarial blocker;
- authorize exactly one additional bounded repair or review attempt;
- adopt, reject, or supersede a reconciled stale or replacement artifact;
- issue, narrow, or revoke a worker grant;
- acknowledge a notice or disposition a scoped andon where its detector permits
  human disposition;
- pin, pause, drain, or reduce capacity with declared scope and expiry;
- provide a required semantic human attestation; and
- choose the permitted response to plan drift, failed verification, or another
  explicitly modeled block.

This list does not give every decision the same approver or effect. Each type
has its own versioned contract and authority rule.

Organization decisions owned by `frostyard/core` remain Git decisions. Fluent
may create a typed choice to dismiss, request preparation of a bounded PR
proposal, or link an existing core PR, but it records `waiting-external` until
the exact authorized merge is independently observed in a valid imported core
snapshot. A local “approve” action MUST NOT change enrollment, policy, goals,
criteria, initiatives, plans, organization records, or their lifecycle in lieu
of that merge.

Repository-owned decisions remain GitHub or canonical repository decisions.
Fluent independently observes authorized maintainer review, merge, repository
PRs, and artifact state; an inbox choice cannot forge those external acts or
make Fluent merge, release, or deploy.

Restricted security decisions use the private access and disclosure path from
[ADR-0024](0024-restrict-security-findings-before-disclosure.md). Unauthorized
principals see neither decision existence nor redacted details when even that
metadata would leak sensitive information. Batch operations never include
restricted security decisions in v1.

Batch decisions are allowed only for one decision type, authority rule,
information class, risk ceiling, choice, and governing contract version. The
interface presents every exact subject and net effect, enforces a hard batch
size, rejects the entire batch if any member is stale or unauthorized, and
records one disposition per subject. There is no universal “approve all.”

Web UI and CLI call the same authenticated decision API and receive the same
validation, preview, stale detection, and result. OperatorInbox supports views
by deadline, severity, repository, initiative, decision type, and restricted
access without copying decision authority into presentation state. Every
rendered action names the authority location and whether resolution is local,
requires a core PR, requires a repository or GitHub act, or requires the private
security path.

Pending decisions do not default to approval. Expiry applies the decision
type's fail-closed result, normally retaining the hold or leaving work
ineligible, and records that no authorization was granted. Deadlines and
notifications are operator aids, not implicit consent.

V1 has one operator principal, but the record and API preserve required roles
and exact deciding principal for future named members. Adding members requires
an explicit role and separation-of-duties decision; sharing the operator login
is not the migration path.

Every decision lifecycle event is available to ProcessObserver with type,
scope, governing versions, wait duration, staleness, and outcome, subject to
information controls. ProcessObserver may identify a failing decision process
but cannot resolve the decision or change its contract.

## Consequences

- The operator gets one coherent attention surface without collapsing distinct
  approval systems into one dangerous button.
- Workers cannot claim human authorization tasks or convert recommendations
  into decisions.
- Exact subject binding and optimistic concurrency prevent stale approvals from
  transferring to changed code, policy, plans, or evidence.
- Typed finite choices make effects reviewable, testable, and auditable while
  rationale remains useful context rather than hidden authority.
- External core and GitHub acts remain authoritative and independently
  observed.
- Strict batch homogeneity provides limited operator efficiency without broad
  approval ambiguity.
- Fail-closed expiry avoids consent by inaction but may leave work held until
  the operator returns.
- A shared API keeps CLI and Frostyard-design-system UI behavior consistent.
- Future named members can receive narrow decision roles without redefining the
  record model, but their role system remains undesigned.
- Fluent needs decision schemas, authority evaluators, optimistic concurrency,
  external-resolution observers, restricted views, and notification policy.
- Exact decision-type catalog, batch limit, deadlines, notification channels,
  role matrix, and retention rules remain open.

## Alternatives considered

- **Put human decisions in the worker queue:** rejected because capable agents
  are not the authority those tasks require.
- **Expose one generic approve or reject endpoint:** rejected because subjects,
  choices, effects, approvers, and invalidation rules differ materially.
- **Apply a decision to the latest subject revision:** rejected because consent
  to one revision is not consent to later code or evidence.
- **Let rationale modify the action:** rejected because prose would become an
  unvalidated authorization channel.
- **Treat a Fluent approval as a core or GitHub approval:** rejected because it
  bypasses the canonical authority and independent observation paths.
- **Allow unrestricted batch approval:** rejected because mixed risk, authority,
  and effects cannot be reviewed safely as one act.
- **Auto-approve on deadline:** rejected because operator absence is not
  authorization.
- **Design named-member RBAC now:** rejected because v1 is single-operator, but
  the data model preserves the separation needed for a later explicit design.

## References

- Builds on deterministic authority and proposal admission from
  [ADR-0004](0004-keep-models-outside-the-control-path.md),
  [ADR-0005](0005-admit-worker-created-work-before-claiming.md), and
  [ADR-0006](0006-enforce-admission-in-the-database.md)
- Preserves core, repository, and worker authority from
  [ADR-0007](0007-use-frostyard-core-as-the-organization-authority.md),
  [ADR-0015](0015-authorize-repository-enrollment-through-core.md), and
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md)
- Provides human decisions required by
  [ADR-0024](0024-restrict-security-findings-before-disclosure.md),
  [ADR-0029](0029-bound-adversarial-review.md),
  [ADR-0030](0030-execute-one-slice-through-one-pull-request.md),
  [ADR-0031](0031-separate-delivery-from-outcome-achievement.md),
  [ADR-0032](0032-route-work-with-operator-issued-grants.md),
  [ADR-0033](0033-observe-processes-and-pull-scoped-andons.md), and
  [ADR-0034](0034-schedule-a-bounded-ready-inventory.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [typed human decisions and OperatorInbox](../prd/agent-fleet.md#typed-human-decisions-and-operatorinbox)
- Implementation design, contract, and delivery plan: not yet authored
