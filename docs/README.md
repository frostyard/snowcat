# Documentation

Docs are split by the question they answer:

| Directory | Question | Contents |
| --- | --- | --- |
| [adr/](adr/) | **Why** did we choose this? | Architecture Decision Records — immutable once accepted; superseded, never edited |
| [design/](design/) | **How** does it fit together? | Living documents describing the current architecture |
| [specs/](specs/) | **What exactly** is the contract? | Precise, testable interface definitions |
| [plans/](plans/) | **When/in what order** do we build? | Roadmaps and phase plans; updated as work lands |
| [prd/](prd/) | **Why/for whom** are we building? | Living product requirements, scope, and success measures |
| [domain/](domain/) | **What do our words mean?** | Canonical ubiquitous language — living, lean, and human-reviewed |

## Index

### Decisions (ADRs)

- [0001 — Record architecture decisions](adr/0001-record-architecture-decisions.md)
- [0002 — Agent-portable instruction surface](adr/0002-agent-portable-instruction-surface.md)
- [0003 — Separate work coordination from execution](adr/0003-separate-work-coordination-from-execution.md)
- [0004 — Keep models outside the control path](adr/0004-keep-models-outside-the-control-path.md)
- [0005 — Admit worker-created work before claiming](adr/0005-admit-worker-created-work-before-claiming.md)
- [0006 — Enforce admission in the database](adr/0006-enforce-admission-in-the-database.md)
- [0007 — Use frostyard/core as the organization authority](adr/0007-use-frostyard-core-as-the-organization-authority.md)
- [0008 — Use five organization record kinds](adr/0008-use-five-organization-record-kinds.md)
- [0009 — Apply goals through discovery and admission](adr/0009-apply-goals-through-discovery-and-admission.md)
- [0010 — Enforce policies monotonically with expiring exceptions](adr/0010-enforce-policies-monotonically-with-expiring-exceptions.md)
- [0011 — Treat knowledge as reviewed advisory evidence](adr/0011-treat-knowledge-as-reviewed-advisory-evidence.md)
- [0012 — Version criteria and preserve assessment truth](adr/0012-version-criteria-and-preserve-assessment-truth.md)
- [0013 — Author organization records as strict JSON](adr/0013-author-organization-records-as-strict-json.md)
- [0014 — Import core as atomic validated snapshots](adr/0014-import-core-as-atomic-validated-snapshots.md)
- [0015 — Authorize repository enrollment through core](adr/0015-authorize-repository-enrollment-through-core.md)
- [0016 — Read only canonical repository surfaces](adr/0016-read-only-canonical-repository-surfaces.md)
- [0017 — Standardize actions, boundaries, and risk](adr/0017-standardize-actions-boundaries-and-risk.md)
- [0018 — Bind worker sessions and verify GitHub artifacts](adr/0018-bind-worker-sessions-and-verify-github-artifacts.md)
- [0019 — Include feature delivery in v1](adr/0019-include-feature-delivery-in-v1.md)
- [0020 — Call the repository coordinator RepositoryController](adr/0020-call-the-repository-coordinator-repositorycontroller.md)
- [0021 — Run bounded maintenance assessments](adr/0021-run-bounded-maintenance-assessments.md)
- [0022 — Focus quality on local correctness](adr/0022-focus-quality-on-local-correctness.md)
- [0023 — Base CI maintenance on observed runs](adr/0023-base-ci-maintenance-on-observed-runs.md)
- [0024 — Restrict security findings before disclosure](adr/0024-restrict-security-findings-before-disclosure.md)
- [0025 — Ground architecture in accepted direction](adr/0025-ground-architecture-in-accepted-direction.md)
- [0026 — Coordinate enrolled repositories with FleetController](adr/0026-coordinate-enrolled-repositories-with-fleetcontroller.md)
- [0027 — Authorize feature planning from core PRDs](adr/0027-authorize-feature-planning-from-core-prds.md)
- [0028 — Approve immutable delivery plans in core](adr/0028-approve-immutable-delivery-plans-in-core.md)
- [0029 — Bound adversarial review](adr/0029-bound-adversarial-review.md)
- [0030 — Execute one slice through one pull request](adr/0030-execute-one-slice-through-one-pull-request.md)
- [0031 — Separate delivery from outcome achievement](adr/0031-separate-delivery-from-outcome-achievement.md)
- [0032 — Route work with operator-issued grants](adr/0032-route-work-with-operator-issued-grants.md)
- [0033 — Observe processes and pull scoped andons](adr/0033-observe-processes-and-pull-scoped-andons.md)
- [0034 — Schedule a bounded ready inventory](adr/0034-schedule-a-bounded-ready-inventory.md)
- [0035 — Route human authority through typed decisions](adr/0035-route-human-authority-through-typed-decisions.md)
- [0036 — Maintain a canonical domain language](adr/0036-maintain-a-canonical-domain-language.md)
- [0037 — Store facts with a separate event ledger](adr/0037-store-facts-with-a-separate-event-ledger.md)
- [0038 — Separate lifecycle pause from runtime interventions](adr/0038-separate-lifecycle-pause-from-runtime-interventions.md)
- [0039 — Use typed source-native subject identities](adr/0039-use-typed-source-native-subject-identities.md)
- [0040 — Establish facts through registered predicate contracts](adr/0040-establish-facts-through-registered-predicate-contracts.md)
- [0041 — Enforce three information classes and scoped access](adr/0041-enforce-three-information-classes-and-scoped-access.md)
- [0042 — Use rebuildable projections only as read models](adr/0042-use-rebuildable-projections-only-as-read-models.md)
- [0043 — Order records by transaction sequence, not timestamps](adr/0043-order-records-by-transaction-sequence-not-timestamps.md)
- [0044 — Replace the queue spike database](adr/0044-replace-the-queue-spike-database.md)
- [0045 — Host Fluent under the Frostyard organization](adr/0045-host-fluent-under-frostyard.md)
- [0046 — Separate Core source freshness from admission readiness](adr/0046-separate-core-source-freshness-from-admission-readiness.md)
- [0047 — Cap stale-source overrides at 24 hours](adr/0047-cap-stale-source-overrides-at-24-hours.md)
- [0048 — Retain Core check detail for 30 days](adr/0048-retain-core-check-detail-for-30-days.md)
- [0049 — Poll Core through one leased controller](adr/0049-poll-core-through-one-leased-controller.md)
- [0050 — Reconcile repository enrollment as separate facts](adr/0050-reconcile-repository-enrollment-as-separate-facts.md)
- [0051 — Pin surfaces to the observed default-branch head](adr/0051-pin-surfaces-to-the-observed-default-branch-head.md)
- [0052 — Bind local repository holds to explicit operator decisions](adr/0052-bind-local-repository-holds-to-explicit-operator-decisions.md)
- [0053 — Resume only unchanged transient held work](adr/0053-resume-only-unchanged-transient-held-work.md)
- [0054 — Bind success measures to versioned verification profiles](adr/0054-bind-success-measures-to-versioned-verification-profiles.md)
- [0055 — Separate evidence population from rate evaluation](adr/0055-separate-evidence-population-from-rate-evaluation.md)
- [0056 — Derive required checks from enforced GitHub rules](adr/0056-derive-required-checks-from-enforced-github-rules.md)

### Domain language

- [Fluent ubiquitous language](domain/ubiquitous-language.md)

### Design

- [Queue execution boundary](design/queue-execution-boundary.md)
- [Control-plane kernel](design/control-plane-kernel.md)
- [Core snapshot ingestion](design/core-snapshot-ingestion.md)
- [Repository enrollment](design/repository-enrollment.md)
- [Success-measure verification](design/success-measure-verification.md)

### Specs

- [Work queue](specs/work-queue.md)
- [Control-plane kernel](specs/control-plane-kernel.md)
- [Core snapshot verification](specs/core-snapshot-verification.md)
- [Core snapshot activation](specs/core-snapshot-activation.md)
- [Core source readiness](specs/core-source-readiness.md)
- [Core check-detail retention](specs/core-check-detail-retention.md)
- [Core source polling](specs/core-source-polling.md)
- [Repository authority reconciliation](specs/repository-authority-reconciliation.md)
- [Repository surface reconciliation](specs/repository-surface-reconciliation.md)
- [Local repository holds](specs/repository-local-holds.md)
- [Repository held-work recovery](specs/repository-held-work-recovery.md)
- [Verification-profile ingestion](specs/verification-profile-ingestion.md)
- [Goal ingestion](specs/goal-ingestion.md)
- [Conclusive-run-rate evaluator](specs/conclusive-run-rate-evaluator.md)

### Plans

- [Queue vertical spike](plans/queue-vertical-spike.md)
- [Product foundation roadmap](plans/product-foundation-roadmap.md)
- [Control-plane kernel bootstrap](plans/control-plane-kernel-bootstrap.md)
- [Core snapshot ingestion](plans/core-snapshot-ingestion.md)

### Product requirements

- [GitHub organization agent fleet](prd/agent-fleet.md)

## Conventions

- **New docs start from their category's `TEMPLATE.md`** (in each directory).
- New decision → new ADR with the next number; if it reverses an old one, mark
  the old one `Superseded by NNNN` rather than editing it.
- Design docs are updated in place to always reflect reality.
- Specs change only alongside the code that implements them.
- Domain language is updated when terms are resolved; it stays lean and never
  substitutes for a design, spec, ADR, plan, or PRD.
- Cross-links between categories are mandatory in both directions — see the
  documentation rules in [AGENTS.md](../AGENTS.md) (CLAUDE.md/GEMINI.md are
  symlinks to it, ADR-0002).
- Adding a doc means adding it to the index above.
