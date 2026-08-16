# 0028 — Approve immutable delivery plans in core

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

[ADR-0027](0027-authorize-feature-planning-from-core-prds.md) authorizes a
bounded planning attempt from an approved core PRD but deliberately grants no
implementation authority. Fluent needs a durable handoff from a capable
planner's semantic decomposition to exact, ordered work that several
RepositoryControllers can execute.

A planner may misunderstand the PRD, invent scope, underestimate risk, choose
unsafe ordering, or create slices that are individually unreviewable. Storing
its output directly as admitted queue children would allow the same model to
define the implementation graph and put it into motion. Keeping the plan only
in Fluent's database would also bypass the Git-backed review path chosen for
organization direction.

The plan must be machine-readable enough to validate dependencies and admission
while remaining reviewable by humans. It must support both one-repository and
multi-repository initiatives without pretending that their pull requests merge
atomically.

## Decision

The capable planning role is named `delivery-planner`. A planning worker
receives the exact approved PRD and declaration revision, exact target
RepositoryController snapshots, applicable organization context, relationship
and contract facts, effective policy, and a versioned portable planning skill.
It receives read-only planning authority and returns at most one strict delivery-
plan proposal or a bounded set of blocking questions.

Ambiguity is a valid blocking result. The planner MUST NOT fabricate product
intent, silently add a target repository, convert an unresolved product choice
into an assumption, or make an unsafe slice merely to complete a graph.

Approved delivery plans live in core at
`organization/delivery-plans/<initiative-id>/<plan-version>.json` and validate
against `organization/schemas/v1/delivery-plan.schema.json`. `plan-version` is
a positive decimal integer with no leading zero. A plan version is immutable:
core and Fluent reject modifying or deleting a version previously present in
an active snapshot.

A plan contains at least:

- schema version, initiative ID, plan version, and the exact source PRD path,
  blob ID, and digest;
- plan outcome, completion criteria, assumptions, and no unresolved blocking
  questions;
- every target repository slug and immutable GitHub repository ID;
- an ordered acyclic slice graph; and
- plan-level compatibility, rollout, rollback, risk, and evidence expectations.

Each slice contains at least:

- a stable plan-local ID and one target repository;
- one independently reviewable outcome, explicit non-goals, and acceptance
  criteria;
- bounded implementation scope and affected canonical surfaces;
- dependencies and the required predecessor signal from a versioned bounded
  vocabulary;
- requested actions, expected artifacts, validation, and review evidence;
- proposed risk tier and protected boundaries; and
- compatibility, rollout, and rollback obligations where applicable.

Requested actions, risk, and boundaries are untrusted planning inputs. They do
not grant authority. Core CI validates schema, path and identity agreement,
source digests, target membership, unique IDs, dependency existence and
acyclicity, bounded sizes, and recognized vocabularies. Fluent independently
revalidates the plan and intersects every slice with current platform, core,
enrollment, root, parent, and repository policy.

Slices represent outcomes, not arbitrary file groups, prompt fragments, model
context chunks, or token estimates. One slice produces at most one pull request
by default. Work that cannot be reviewed or merged independently must declare
the compatibility mechanism that keeps intermediate states safe or be combined
with its inseparable work.

The planning worker returns the proposed JSON to Fluent; read-only planning
authority does not let it push to core. An operator or separately admitted
publication worker opens a core PR that adds the new immutable plan file and
updates the paired initiative declaration's `active_plan` pointer with plan
version and digest. The PR MUST NOT modify an older plan version.

Merging that core PR is the attributed human approval of the exact plan. When
the resulting core snapshot activates, the FleetController validates the whole
plan atomically against current target state. If any target is held, missing,
unenrolled, delivery-disabled, stale, or denies a requested slice action, the
plan is held and no slice is admitted. Fluent MUST NOT silently drop, narrow, or
partially activate slices because doing so may invalidate the approved outcome
or ordering.

Successful activation materializes every slice as actor-attributed admitted
work bound to the plan, PRD, core snapshot, and target RepositoryController.
Dependencies make only initially eligible slices claimable. Later slices become
claimable only after the FleetController independently observes their declared
predecessor signals and rechecks effective policy. Plan merge is therefore an
explicit batch admission, not delegated planner authority.

Independent slices may proceed concurrently within repository and fleet limits.
Dependent slices normally wait for predecessor merge or another explicitly
defined accepted signal. V1 does not create dependent stacked pull requests by
default.

Any change to plan outcome, slices, acceptance criteria, dependencies, target
repositories, requested actions, risk, boundaries, compatibility, rollout, or
rollback creates a new immutable plan version and another core PR. Updating the
initiative's `active_plan` pointer does not silently cancel or rewrite claimed,
completed, or admitted work from the prior version. The FleetController exposes
the divergence and requires attributed reconciliation of unfinished old slices
before new or changed slices become eligible.

Every plan proposal, review PR, approval merge, activation attempt, validation
failure, materialized slice, dependency transition, and reconciliation retains
its provenance. A generated human rendering may aid review, but the strict JSON
plan is canonical.

## Consequences

- The planning model can propose a graph but cannot approve or activate it.
- Core provides durable human review and immutable history for implementation
  scope across repositories.
- One merge can explicitly admit many exact slices without approving recursive
  worker-generated work.
- Atomic activation prevents a partially authorized graph from masquerading as
  the reviewed plan.
- Outcome-oriented slices and compatibility requirements discourage token-sized
  or file-based decomposition.
- Operators need a publication path from Fluent's plan proposal to a core PR.
- Plan amendments require reconciliation when work from an older version is in
  flight, increasing ceremony but exposing scope drift.
- Strict JSON is less pleasant to review directly, so UI and CI renderings will
  be important but non-authoritative.
- Exact plan and slice size limits, predecessor-signal vocabulary, publication
  UX, required reviewers, and old-plan reconciliation transitions remain to be
  specified.

## Alternatives considered

- **Admit planner-created queue children directly:** rejected because the model
  would define and activate its own implementation authority.
- **Approve the plan only in Fluent's database:** rejected because it bypasses
  core's reviewed organization-planning history.
- **Use Markdown as the canonical dependency graph:** rejected because exact
  IDs, dependencies, action requests, and validation invariants would require
  ambiguous prose parsing.
- **Store both canonical Markdown and JSON plans:** rejected because the two
  plans could drift; generated human rendering is safer.
- **Permit mutable plan files:** rejected because in-flight work would lose its
  immutable approved source.
- **Partially activate permitted slices:** rejected because omitted work may
  invalidate dependencies, compatibility, and initiative completion.
- **Treat plan risk and actions as grants:** rejected because a planner cannot
  broaden platform or repository authority.
- **Open every plan PR immediately:** rejected because dependent stacked changes
  create conflicts and waste work when earlier slices change.

## References

- Builds on feature intake from
  [ADR-0027](0027-authorize-feature-planning-from-core-prds.md), proposal
  admission from [ADR-0005](0005-admit-worker-created-work-before-claiming.md),
  database enforcement from
  [ADR-0006](0006-enforce-admission-in-the-database.md), and strict core import
  from [ADR-0013](0013-author-organization-records-as-strict-json.md) and
  [ADR-0014](0014-import-core-as-atomic-validated-snapshots.md)
- Applies policy and risk from
  [ADR-0017](0017-standardize-actions-boundaries-and-risk.md), artifact and
  attempt lineage from
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md), and
  cross-repository coordination from
  [ADR-0026](0026-coordinate-enrolled-repositories-with-fleetcontroller.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [delivery planning and approval](../prd/agent-fleet.md#delivery-planning-and-approval)
- Implementation design, contract, and delivery plan: not yet authored
