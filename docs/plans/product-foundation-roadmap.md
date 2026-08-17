# Plan: Product foundation roadmap

This plan moves Fluent from the completed queue spike and Discovery PRD to an
implementation-ready, dogfoodable v1. It orders decisions and vertical outcomes
rather than treating all 389 requirements as one build. Before an implementation
phase begins, that phase must author and link its current design and implementing
spec; this roadmap does not describe unimplemented architecture as current
reality.

Fluent's canonical source is `frostyard/fluent` under
[ADR-0045](../adr/0045-host-fluent-under-frostyard.md). Organization ownership
does not itself enroll the repository in the fleet.

## Phase 0 — Canonical language and documentation integrity (completed)

- Establish the canonical
  [Fluent ubiquitous language](../domain/ubiquitous-language.md) under
  [ADR-0036](../adr/0036-maintain-a-canonical-domain-language.md).
- Add the portable
  [`model-fluent-domain`](../../.agents/skills/model-fluent-domain/SKILL.md)
  procedure and root compatibility symlink.
- Enforce links, indexing, ADR and PRD numbering, domain-entry shape, Accepted
  term sources, and the canonical symlink through `npm run check:docs` and the
  existing [queue spike CI gate](queue-vertical-spike.md#phase-10-operational-queue-hardening-completed).
- **Done when:** `npm run check` reports valid documentation and the complete
  queue test, typecheck, and build suite passes from one command.

## Phase 1 — Settle the control-plane kernel (medium)

- Execute Phase 1 of the detailed
  [control-plane kernel bootstrap](control-plane-kernel-bootstrap.md) and treat
  the current queue as a disposable behavioral predecessor under
  [ADR-0044](../adr/0044-replace-the-queue-spike-database.md), not as target
  data to classify or import.
- Use accepted
  [ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md) as the
  control-plane persistence foundation.
- Apply
  [ADR-0039](../adr/0039-use-typed-source-native-subject-identities.md) when
  specifying subject, record-identity, display-locator, and revision registries.
- Apply
  [ADR-0040](../adr/0040-establish-facts-through-registered-predicate-contracts.md)
  when specifying predicates, establishment commands, reducers, conflicts,
  derivations, and authority-sensitive consumers.
- Apply
  [ADR-0041](../adr/0041-enforce-three-information-classes-and-scoped-access.md)
  when specifying record access, worker disclosure, events, projections,
  declassification, search, logs, and backup handling.
- Apply
  [ADR-0042](../adr/0042-use-rebuildable-projections-only-as-read-models.md)
  when specifying read models, ready inventory, projection generations, and
  authority rechecks.
- Apply
  [ADR-0043](../adr/0043-order-records-by-transaction-sequence-not-timestamps.md)
  when specifying transaction order, time fields, expiry, event cursors,
  late-data queries, and idempotency receipts.
- Preserve the canonical distinction between policy decision and effective
  authority in the
  [Fluent ubiquitous language](../domain/ubiquitous-language.md), and apply
  [ADR-0038](../adr/0038-separate-lifecycle-pause-from-runtime-interventions.md)
  when specifying lifecycle and runtime intervention records.
- Refine exact subject kinds, record envelopes, command and event schemas,
  idempotency, state machines, and registry contents in the current design and
  specs; record any remaining significant tradeoff in a new ADR.
- Author the current control-plane design and exact storage/event specs only
  after those choices are accepted; link them into this phase before code work.
- **Done when:** a reviewer can classify every field in the first target schema
  and every planned controller input as definition, assertion, observation,
  evidence reference, fact, decision, operational state, projection, or event
  without an unresolved authority ambiguity, and target initialization accepts
  only an empty target database.

## Phase 2 — Publish the core authoring contract (large)

- Merged core PR #80 now supplies the strict repository declaration,
  repository-surface, and agent-governance foundation. Fluent verifies that
  exact current slice through the
  [core snapshot ingestion design](../design/core-snapshot-ingestion.md),
  [verification contract](../specs/core-snapshot-verification.md), and
  [activation contract](../specs/core-snapshot-activation.md), and
  [ingestion plan](core-snapshot-ingestion.md). Fluent can now retain and
  activate the disabled fixture declaration without treating it as enrollment.
  The remaining record kinds below keep this phase open.
- Core PR #81 proposes the versioned verification-profile producer contract.
  Fluent's backward-compatible consumer support is implemented first through
  the [success-measure verification design](../design/success-measure-verification.md)
  and [profile-ingestion contract](../specs/verification-profile-ingestion.md):
  legacy snapshots remain valid, while the extension is pinned, retained, and
  cannot be removed or mutated by automatic forward activation after adoption,
  including after rollback.
- In `frostyard/core`, record the required core-side ADR that changes its current
  repository boundary, then author the canonical paths and strict schemas from
  [ADRs 0007–0017](../adr/0007-use-frostyard-core-as-the-organization-authority.md)
  and [ADRs 0026–0028](../adr/0026-coordinate-enrolled-repositories-with-fleetcontroller.md).
- Specify and fixture goal, policy, knowledge, criteria set, exception,
  enrollment, relationship, initiative, and delivery-plan records, including
  identity, ownership, applicability, lifecycle, precedence, and invalid cases.
- Migrate the initially enrolled Frostyard repositories to their one canonical
  local surfaces without treating current layout as correct by default.
- Add a core validation command that performs no model inference and fails
  unknown kinds, fields, schema versions, paths, identities, and lifecycle
  transitions.
- **Done when:** one merged core revision contains a valid representative record
  of every canonical type, every invalid fixture fails for its intended reason,
  and repository enrollment can be determined from that revision alone.

## Phase 3 — Bootstrap the durable control-plane store (large)

- Execute Phases 2–4 of the detailed
  [control-plane kernel bootstrap](control-plane-kernel-bootstrap.md) in a fresh
  SQLite database while the current
  [work queue contract](../specs/work-queue.md) remains an independently
  operable prototype until coordinated replacement.
- Add stable subjects, typed schema registries, exact revisions, idempotent
  command transactions, independent facts, operational state, event ledger,
  information classes, and rebuildable projections.
- Reimplement the useful admission, concurrency, and worker-interaction
  properties demonstrated by the
  [queue execution boundary](../design/queue-execution-boundary.md) without
  copying its rows, schema, identity stand-ins, or mixed status meanings.
- Preserve target newer-schema refusal, concurrent writer behavior, and
  backup/restore evidence; use existing queue tests as behavioral inputs rather
  than storage-compatibility gates.
- **Done when:** a fresh target database supports the registered kernel commands,
  rebuildable projections, recovery, and one fixture-backed target-native work
  lineage, while neither initialization nor runtime can read or import a spike
  database.

## Phase 4 — Observe GitHub without impersonating workers (large)

- Registry v17 and schema v7 implement the first internal, enrollment-bound
  post-authentication transaction for an allowlisted same-repository
  pull-request delivery. It writes a distinct receipt observation,
  pull-request observation, and audit event with exact replay, 30-day receipt
  retention metadata, source/causal lineage verification, and source-native
  subject creation. A pure exact-body HMAC verifier and allowlisted payload
  normalizer now precede the command, and an injectable POST-only router bounds
  streaming and failure disclosure. The default app does not mount it pending
  production listener lifecycle. The fixed pull-request-delivery audit scope
  now also persists point/continuation checkpoints, one lower-bounded open gap,
  and terminal complete-audit repair with reopen-time chain verification.
  The fixture-driven App-JWT delivery-list client now follows bounded opaque
  cursor pagination, produces exact page proofs, classifies closed failures,
  and derives per-repository selected summaries. It can now fetch one selected
  delivery and atomically retain distinct API audit and normalized
  pull-request observations without fabricating a receipt. Content gaps now
  require exact affected delivery identities, matching retained API repair
  audits, and complete interval audit before closure. Automatic gap creation,
  installation binding, scheduling, and leases remain.
- The source-independent `conclusive-run-rate:v1` arithmetic evaluator is
  implemented under
  [ADR-0055](../adr/0055-separate-evidence-population-from-rate-evaluation.md)
  and its [exact contract](../specs/conclusive-run-rate-evaluator.md). The
  `github-required-checks:v1` adapter remains deliberately unregistered until
  this phase implements the enforced-ruleset population and source-completeness
  boundary from
  [ADR-0056](../adr/0056-derive-required-checks-from-enforced-github-rules.md).
  The earlier `github-check-runs:v1` placeholder will not be registered.
- Configure and verify each initial repository through the
  [enforced required-check ruleset runbook](../design/required-check-ruleset-operations.md)
  before opening its first observation window.
- Author and implement the GitHub observation and reconciliation design/spec
  defined by the
  [GitHub observation design](../design/github-observation.md), as required by
  [ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md)
  and
  [ADR-0057](../adr/0057-require-webhook-ingress-for-github-observation.md).
  Recovery cadence and retention follow
  [ADR-0058](../adr/0058-bound-github-observation-recovery-and-retention.md).
- Install a least-privilege read-only GitHub App or approved host credential for
  the initial Frostyard scope; map immutable repository IDs, principals, worker
  GitHub actors, and maintainer authority.
- Reconcile issue, pull-request, commit, CI, review, branch, merge, and closure
  facts with exact revisions, bounded retry, unavailability, and duplicate or
  stale lineage.
- Implement authenticated webhook ingress, delivery receipts and audit,
  allowlisted observations, fully paginated polling, source checkpoints and
  gaps, repair, retention protection, outage behavior, and observation cursors
  before relying on GitHub state as a gate. Fork handling remains post-v1 for
  the required-check adapter.
- **Done when:** Fluent independently distinguishes a valid worker PR, a wrong-
  repository artifact, a stale-attempt artifact, a GitHub outage, formal
  maintainer changes requested, and the exact reviewed merge on a real enrolled
  test repository.

## Phase 5 — Coordinate one repository end to end (large)

- Complete Phase 5 of the
  [control-plane kernel bootstrap](control-plane-kernel-bootstrap.md), cutting
  over only after an archived spike backup is verified and without importing
  any spike record.
- Implement the deterministic
  [RepositoryController](../adr/0020-call-the-repository-coordinator-repositorycontroller.md)
  over atomic core snapshots and GitHub observations.
- Implement local operator authentication, server-bound worker sessions,
  repository-dedicated grants, capability profiles, pre-claim routing, and one-
  lease default from
  [ADR-0032](../adr/0032-route-work-with-operator-issued-grants.md).
- Implement the minimum bounded scheduler from
  [ADR-0034](../adr/0034-schedule-a-bounded-ready-inventory.md): authorization,
  eligibility, ready materialization, atomic claim, WIP limit, and capacity gap.
- Implement typed proposal, block, stale-artifact, grant, and temporary-hold
  decisions through one shared CLI/API contract from
  [ADR-0035](../adr/0035-route-human-authority-through-typed-decisions.md).
- Carry the implemented repository authority-context digest into target work
  and complete the per-item resume/cancel path from
  [ADR-0053](../adr/0053-resume-only-unchanged-transient-held-work.md) and the
  [held-work recovery contract](../specs/repository-held-work-recovery.md).
- **Done when:** an operator imports one enrolled repository from core, issues a
  repository-dedicated grant, starts an external worker, receives one matched
  item, and sees every authorization, lease, report, artifact, observation, and
  human decision under its exact identities and revisions.

## Phase 6 — Dogfood all maintenance programs (large)

- Author versioned workflow, role-brief, evidence, attempt-budget, review, and
  outcome contracts for the common maintenance loop and the quality, CI,
  security, and architecture specializations in
  [ADRs 0021–0025](../adr/0021-run-bounded-maintenance-assessments.md).
- Start with quality's bounded testing-gap path, then add observed-run CI and
  accepted-direction architecture using the same controller mechanics.
- Implement restricted finding storage, redaction, access, retention, reviewer,
  embargo, and private disclosure before enabling high or critical security
  assessment.
- Apply no-finding cooldowns, duplicate suppression, one-finding bounds,
  proposal admission, artifact reconciliation, review, and outcome verification
  without allowing maintenance to invent product features.
- **Done when:** each enabled program produces a valid no-finding or one bounded
  useful finding on a real enrolled repository, and at least one admitted
  maintenance change reaches a reconciled maintainer-reviewed PR and verified
  outcome without exposing a restricted finding.

## Phase 7 — Measure and stop failing processes (medium)

- Implement the event and funnel taxonomy, observation profiles, baselines,
  cohort boundaries, uncertainty rules, detector registry, and retention from
  [ADR-0033](../adr/0033-observe-processes-and-pull-scoped-andons.md).
- Derive ProcessObserver health, insufficient-data, notice, scoped-hold, and
  safety-stop behavior from the Phase 3 records and events.
- Implement one bounded process-improvement analyst brief and typed decision
  path without granting self-edit, self-review, or self-clear authority.
- Backfill no invented history: legacy and pre-profile events remain outside a
  mature cohort unless their required versions and evidence exist.
- **Done when:** fixtures demonstrate insufficient data before baseline,
  detection of a mature degraded cohort, the smallest scoped hold, immediate
  verified safety stop, deduplicated improvement proposal, and recovery only by
  the declared rule or permitted human disposition.

## Phase 8 — Coordinate repository relationships (large)

- Implement
  [FleetController](../adr/0026-coordinate-enrolled-repositories-with-fleetcontroller.md)
  over canonical core relationship declarations and independently observed
  producer and consumer contracts.
- Specify compatibility intent, producer-owned contract, consumer-owned
  expectation and test, rollout window, repository hold, partial completion,
  and rollback evidence without copying contract authority into core.
- Add fleet-specialist grants, fair scheduling across repositories, aggregate
  capacity gaps, and relationship-level views through the same Phase 5 APIs.
- **Done when:** a producer contract change affecting two enrolled consumers is
  detected at exact revisions, unsafe ordering holds the relevant work only,
  compatible staged changes proceed, and FleetController reports the common
  outcome from repository source facts.

## Phase 9 — Deliver one approved feature initiative (large)

- Implement core PRD and initiative intake, one bounded delivery-planner
  attempt, adversarial PRD and plan review, immutable core plan publication, and
  atomic activation from
  [ADRs 0027–0029](../adr/0027-authorize-feature-planning-from-core-prds.md).
- Implement dependency-ready slices, one-slice pull-request lineage, bounded
  repair, exact-head review invalidation, maintainer observation, merge signals,
  and post-merge delivery verification from
  [ADRs 0030–0031](../adr/0030-execute-one-slice-through-one-pull-request.md).
- Exercise deterministic, observational, and human-attested evidence modes while
  keeping implementation-complete, delivered, measuring, and outcome-achieved
  distinct. Every criterion and measure resolves through the exact profile,
  subject, absolute window, and parameter rules in the
  [success-measure verification design](../design/success-measure-verification.md).
- **Done when:** one approved core PRD becomes an adversarially reviewed plan,
  produces ordered PRs through operator-started workers, verifies every slice at
  its merge revision, and reports initiative success measures without treating
  merge count as success.

## Phase 10 — Operate v1 as a product (large)

- Build the Frostyard-design-system operator surface over the same authenticated
  APIs as CLI: fleet and repository views, OperatorInbox, decisions, grants,
  capacity gaps, holds, process health, restricted views, and evidence drill-
  down.
- Package the single-host service, SQLite backup/restore, secrets injection,
  health and ingestion monitoring, log redaction, upgrades, and disaster
  recovery for the operator's server.
- Run enough dogfood operations to set numeric PRD targets for useful outcomes,
  wasted attempts, reliability, traceability, repository improvement, and
  multi-repository delivery.
- Resolve or deliberately defer every remaining v1 PRD open question and change
  the PRD status only through its review path.
- **Done when:** the operator restores a backup into a clean host deployment,
  resumes controllers without duplicate authority or work, operates the fleet
  through CLI and UI, and the reviewed PRD has measurable targets and no
  unresolved v1 scope question.

## Later / ideas

- Named-member roles and separation of duties after the single-operator record
  and authority model has real evidence.
- Authenticated remote workers, event-driven wait, and multi-host control-plane
  operation.
- PostgreSQL only after measured SQLite concurrency, retention, or operations
  show a need.
- Additional optional local-model features only after repeatable evaluation
  shows benefit over deterministic code or plain UI.
- Merge, release, or deployment authority only under a future explicit product
  decision; they remain out of v1.

## Open questions

- **Core sequencing:** Phase 2 may proceed alongside Phase 3 after Phase 1, but
  Phase 5 cannot activate enrollment until both produce compatible exact
  subject and revision contracts.
- **Initial dogfood repositories:** choose the smallest repository for Phase 5
  and the producer/consumer pair for Phase 8 before those phases begin.
- **Numeric targets:** collect Phase 5–9 baselines before setting targets, but
  define the measurement formulas and minimum sample rules earlier so targets
  cannot be selected after seeing favorable data.
- **GitHub observation rollout:** configure stable, integration-bound required
  checks through active rulesets on the initial repositories before opening a
  measurement window. V1 then observes merged pull-request required-check
  revisions and treats merge queues, forks, rule drift, and unattributable
  default-branch updates as `unable` rather than approximating them.
- **UI timing:** retain CLI/API as the acceptance surface until Phase 5 behavior
  stabilizes; do not use UI work to conceal unsettled decision semantics.

## References

- Product: [GitHub organization agent fleet PRD](../prd/agent-fleet.md),
  especially its [discovery inventory](../prd/agent-fleet.md#discovery-inventory)
- Current design: [queue execution boundary](../design/queue-execution-boundary.md)
- Core authority boundary:
  [core snapshot ingestion](../design/core-snapshot-ingestion.md) and
  [core snapshot verification](../specs/core-snapshot-verification.md)
- Current contract: [work queue](../specs/work-queue.md)
- Repository recovery contract:
  [repository held-work recovery](../specs/repository-held-work-recovery.md)
- Completed predecessor: [queue vertical spike](queue-vertical-spike.md)
- Detailed kernel delivery:
  [control-plane kernel bootstrap](control-plane-kernel-bootstrap.md)
- Detailed core delivery: [core snapshot ingestion](core-snapshot-ingestion.md)
- Foundation decisions:
  [ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md) and
  [ADR-0038](../adr/0038-separate-lifecycle-pause-from-runtime-interventions.md),
  with identity and revision rules from
  [ADR-0039](../adr/0039-use-typed-source-native-subject-identities.md) and fact
  authority from
  [ADR-0040](../adr/0040-establish-facts-through-registered-predicate-contracts.md),
  with information boundaries from
  [ADR-0041](../adr/0041-enforce-three-information-classes-and-scoped-access.md)
  and projection boundaries from
  [ADR-0042](../adr/0042-use-rebuildable-projections-only-as-read-models.md),
  with record order and time semantics from
  [ADR-0043](../adr/0043-order-records-by-transaction-sequence-not-timestamps.md),
  and clean replacement of the queue-spike database from
  [ADR-0044](../adr/0044-replace-the-queue-spike-database.md), with canonical
  source ownership established by
  [ADR-0045](../adr/0045-host-fluent-under-frostyard.md), and held-work recovery
  bounded by
  [ADR-0053](../adr/0053-resume-only-unchanged-transient-held-work.md)
