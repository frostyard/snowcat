# 0031 — Separate delivery from outcome achievement

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

[ADR-0030](0030-execute-one-slice-through-one-pull-request.md) distinguishes a
reported implementation, a reconciled pull request, merge, and post-merge
outcome verification. Fluent still needs to define how verification works and
how slice results aggregate into initiative progress.

Counting merged pull requests as success would reward activity rather than the
outcome authorized by the PRD. Requiring every outcome to be machine-verifiable
would instead encourage weak proxy measures and exclude legitimate product or
architectural judgment. A model-based worker can supply useful independent
criticism, but under
[ADR-0004](0004-keep-models-outside-the-control-path.md) its conclusion remains
an untrusted claim and cannot authorize a success transition by itself.

## Decision

The post-merge semantic verification role is named `delivery-verifier`. It is a
bounded, read-only role separate from the implementation attempt and session.
It evaluates one slice at the exact independently observed merge revision and
cannot modify code, open or update artifacts, expand acceptance, create
claimable work, or attest the implementer's success as an authority.

The RepositoryController starts slice verification only after it observes the
exact merge commit on the declared base branch and reconciles the merge-time
gates required by ADR-0030. A merge that lacks those gates remains a merge fact
but does not enter normal outcome verification until an authorized
reconciliation resolves the discrepancy.

The verification brief binds:

- initiative, PRD digest, plan version, and slice identity;
- exact merge commit and repository revision under evaluation;
- every slice acceptance criterion and its declared evidence mode;
- the criterion's source, threshold or decision rule, observation window,
  required evidence, and accountable owner where applicable;
- relevant predecessor outputs, relationships, contracts, rollout state, and
  known confounding changes; and
- exact verification attempt, allowed read operations, and reporting schema.

Every slice acceptance criterion and initiative success measure uses one of
three evidence modes:

- `deterministic` applies a versioned evaluator to trusted repository, CI,
  artifact, or system facts and records reproducible inputs and results;
- `observational` evaluates a named trusted source over a declared time window,
  baseline, threshold, and attribution limits; and
- `human-attested` requires a decision by an authorized named principal with
  subject, evidence, rationale, and timestamp.

Deterministic evidence is preferred when it measures the actual requirement.
Fluent MUST NOT replace an explicitly semantic outcome with a convenient proxy
merely to automate it. A capable delivery verifier may recommend `pass`,
`fail`, or `unable` for semantic criteria and provide criterion-level evidence,
but its recommendation remains untrusted input. Only a deterministic evaluator,
a completed observational rule over trusted facts, or an authorized human
attestation may satisfy a criterion and advance authoritative state.

Each criterion retains its own state and evidence. The RepositoryController may
derive slice states including `verification-pending`, `verification-failed`,
`verification-unable`, and `outcome-verified`, but it MUST NOT collapse or
discard criterion facts. A slice reaches `outcome-verified` only when every
required criterion is satisfied for the declared subject and no applicable
hold or invalidation remains.

An observation window is controller state, not a long-running worker lease. The
RepositoryController records its start, end, source observations, gaps, and
intervening changes. Missing or materially confounded evidence produces
`unable`, not a fabricated pass or fail. Evidence remains bound to the exact
subject and expires or invalidates only according to its versioned profile.

A failed or unable slice does not mutate the immutable approved slice, erase
its merge, or automatically authorize another implementation. The controller
may create a bounded proposed repair, rollback, investigation, or plan-amendment
item with the failed criteria and evidence. Normal admission and plan approval
still apply, and dependent slices waiting for `outcome-verified` remain held.

The FleetController derives initiative delivery state from the active plan's
required slices without replacing the canonical initiative lifecycle in
`frostyard/core`:

- `implementation-complete` means every required slice has the independently
  reconciled `merged` signal;
- `delivered` means every required slice has `outcome-verified`;
- `measuring` means delivery is complete but one or more required initiative
  success measures await an observation window or human attestation;
- `outcome-achieved` means every required initiative success measure is
  satisfied; and
- `outcome-not-achieved` means the applicable evaluation period is complete and
  at least one required success measure failed.

Paused, superseded, and cancelled remain authoritative initiative-lifecycle
facts imported from core rather than inferred success states. Delivery can be
complete without the intended outcome being achieved, and outcome failure does
not itself authorize rollback, feature expansion, a new plan, or a lifecycle
change.

The approved delivery plan MUST operationalize every required PRD success
measure with its evidence mode, subject, source, baseline where applicable,
threshold or human decision owner, observation window, and aggregation rule.
The plan MUST NOT silently weaken, replace, or omit a PRD measure. Ambiguous or
unmeasurable required outcomes block planning until the PRD is revised or the
ambiguity is explicitly resolved through its approval path.

The FleetController reports the exact plan, slice, criterion, measure, evidence,
and source revision behind every derived initiative state. It MUST NOT infer
business success from PR count, merge count, CI status, issue closure, worker
confidence, or elapsed time.

## Consequences

- Operators can distinguish implementation activity, delivered behavior, and
  achieved product outcomes.
- Criterion-level evidence makes partial, failed, unavailable, and confounded
  verification visible instead of compressing them into one status.
- Human judgment remains available without pretending a model recommendation
  is deterministic authority.
- Time-windowed measures do not consume worker leases and can survive process
  restarts.
- Failed post-merge acceptance becomes bounded proposed work rather than silent
  mutation or an automatic repair loop.
- Plans must specify measurement mechanics before implementation begins, which
  adds authoring and review work.
- Semantic criteria require an accountable human decision in v1 unless a real
  deterministic or observational evaluator exists.
- Fluent needs versioned verification profiles, trusted observation adapters,
  evidence invalidation, attestation authorization, and initiative-state
  aggregation.
- Exact evaluator interfaces, attester roles, observation sources, retention,
  and evidence-expiry defaults remain open.

## Alternatives considered

- **Treat merged PRs as completed initiatives:** rejected because merge proves
  code integration, not slice acceptance or PRD success.
- **Let the implementer verify the result:** rejected because self-attestation
  is not independent evidence.
- **Let an independent model verdict advance state:** rejected because provider
  diversity does not turn model output into deterministic authority.
- **Require all measures to be automated:** rejected because convenient proxies
  can distort product and architectural intent.
- **Require human approval for every criterion:** rejected because reproducible
  deterministic and observational evidence should not consume operator review.
- **Rewrite the original slice after a failed merge:** rejected because it would
  destroy plan and artifact history.
- **Automatically start repair after failed verification:** rejected because
  failure does not grant new implementation authority or amend the active plan.

## References

- Builds on deterministic authority from
  [ADR-0004](0004-keep-models-outside-the-control-path.md), accepted goals from
  [ADR-0009](0009-apply-goals-through-discovery-and-admission.md), and worker
  provenance from
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md)
- Verifies approved plans and slices from
  [ADR-0028](0028-approve-immutable-delivery-plans-in-core.md) and
  [ADR-0030](0030-execute-one-slice-through-one-pull-request.md), under bounded
  adversarial review from
  [ADR-0029](0029-bound-adversarial-review.md)
- Aggregates through
  [ADR-0026](0026-coordinate-enrolled-repositories-with-fleetcontroller.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [delivery and outcome verification](../prd/agent-fleet.md#delivery-and-outcome-verification)
- Implementation design, contract, and delivery plan: not yet authored
