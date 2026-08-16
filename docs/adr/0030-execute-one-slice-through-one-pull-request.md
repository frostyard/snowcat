# 0030 — Execute one slice through one pull request

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

[ADR-0028](0028-approve-immutable-delivery-plans-in-core.md) activates exact
dependency-ordered slices, and
[ADR-0029](0029-bound-adversarial-review.md) challenges each resulting pull
request. Fluent still needs the worker and state contract that turns one
eligible slice into a reviewed, merged, and verified outcome without managing
the coding-agent process or merging the change itself.

Implementation is not a single transition. A worker may report a PR that does
not exist, CI may fail, adversarial review may find a blocker, maintainers may
request changes, the branch may move, or repository drift may invalidate the
approved approach. Retrying without a budget can produce an endless repair loop;
treating every comment as authority can let untrusted GitHub text redirect the
worker.

## Decision

The feature implementation role is named `delivery-implementer`. One worker
attempt receives one eligible approved slice through a versioned portable skill.
It does not receive a whole initiative or permission to choose another slice.

Before a slice becomes eligible, its RepositoryController verifies:

- active enrollment, feature-delivery enablement, current context, and no hold;
- exact active plan and PRD lineage with satisfied adversarial-review gates;
- every declared predecessor signal through independent observation;
- current effective policy, requested actions, risk, boundaries, and required
  evidence; and
- absence of another active implementation attempt or unresolved equivalent
  pull-request lineage.

The implementation brief binds the plan and slice, current default-branch name
and head SHA, predecessor outcomes, relevant relationship and contract facts,
accepted context, effective actions, required validation and review, existing
artifacts, and exact attempt identity. The approved plan snapshot remains the
scope authority, but implementation starts from the current default-branch head
rather than a stale planning checkout.

Advancement of the base branch is normal. The RepositoryController supplies the
deterministic delta from the plan's target snapshot where available, and the
worker evaluates feasibility. If current code or accepted direction materially
changes slice scope, acceptance, ordering, risk, boundaries, compatibility, or
rollback, the worker MUST block with `plan-drift` and propose a plan amendment.
It MUST NOT repair material drift by silently changing the slice.

Within the admitted item, the implementer may modify its client-owned isolated
working tree, run authorized validation, create local commits, push one non-
protected branch, and open or update one pull request when effective actions
permit. Worker credentials and isolation remain client-owned. The pull request
targets the repository's declared normal base branch, includes the Fluent item,
attempt, and correlation marker from
[ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md), and cites
the initiative, plan version, and slice without exposing secrets.

One slice has one pull-request lineage and produces at most one open pull
request by default. Corrective pushes update that PR. A second or replacement PR
requires attributed RepositoryController reconciliation of the old artifact;
the worker cannot create parallel candidates to escape review or CI state.

Completion reports summary, validation evidence, exact commits, branch and PR
artifact, observed limitations, and any plan-drift or follow-up proposals.
Worker reporting ends the attempt but does not establish artifact existence,
CI success, review pass, maintainer acceptance, merge, or slice outcome.

Delivery state is stored as separate facts rather than one mutable status:

- dependency and policy eligibility;
- implementation attempt and repair budget;
- branch and pull-request artifact reconciliation;
- required CI observations;
- adversarial-review subject, rounds, blockers, and dispositions;
- maintainer review and change-request state;
- merge or closure observation; and
- slice outcome-verification state.

Fluent may derive a stage such as `dependency-waiting`, `eligible`, `claimed`,
`artifact-verified`, `ci-pending`, `review-blocked`,
`awaiting-maintainer-review`, `changes-requested`, `merged`, or
`outcome-verified`, but the projection MUST NOT replace the underlying facts.

After artifact verification, the RepositoryController collects required CI
facts. Required failing or pending checks stop progression. Transient or
infrastructure failures remain explicitly classified; a delivery implementer
MUST NOT weaken a gate to obtain green status. When deterministic prerequisites
are satisfied, the controller creates the exact-head adversarial review item
defined by ADR-0029.

GitHub maintainer review is independently observed. A formal
changes-requested decision by an authorized maintainer stops progression and
may support bounded repair work. Free-form comments, issue text, review bodies,
and downloaded content remain untrusted data; they are included in a repair
brief with source and author but cannot expand scope, grant actions, or override
the plan. Approval does not merge the PR, and merge does not erase other gates.

A repair attempt remains attached to the same slice and PR lineage. Its brief
contains the exact current head SHA and only the unresolved CI failures,
adversarial blockers, authorized maintainer change requests, and related diff.
It does not reopen the entire slice for cleanup, feature additions, or review
advisories. The same authoring session cannot satisfy the independent reviewer
role.

One slice receives one initial implementation attempt and at most three repair
attempts by default across CI, adversarial, and maintainer feedback. When the
budget is exhausted, the RepositoryController blocks further ordinary repair
claims and requires attributed human adjudication: accept a plan amendment,
authorize one additional bounded attempt, replace or close the PR, cancel or
supersede the slice, or resolve it manually. Each additional authorization is
one attempt and records why further capable-agent use is justified.

Every corrective push changes the head SHA, invalidates prior head-bound
adversarial pass and affected CI evidence, and requires fresh observations.
Repair does not reset adversarial-review or repair budgets. Repeated failure
signatures and blocker fingerprints remain visible to prevent identical loops.

A PR closed without merge does not complete its slice. The controller preserves
the artifact and requires operator reconciliation before another PR or attempt.
If a PR merges with unresolved adversarial blockers, denied policy, missing
required checks, or unresolved authorized changes-requested state, Fluent
records merge as fact but withholds outcome verification and dependent work.

V1 delivery dependencies use only the predecessor signals `merged` and
`outcome-verified`. `merged` means the exact reviewed change was independently
observed on the declared base branch with required merge-time gates reconciled.
`outcome-verified` additionally means the slice's acceptance evidence was
verified at the resulting repository revision. A reported, open, CI-green, or
approved PR is not a predecessor signal.

After merge, the RepositoryController evaluates the slice's declared
verification method. Deterministic evidence is preferred. When semantic
verification is required, Fluent creates a separate bounded read-only
verification item; the implementer cannot attest its own outcome. Only a
verified predecessor signal plus a fresh policy check makes dependent work
eligible.

## Consequences

- Every implementation attempt has one exact approved outcome and one normal PR
  lineage.
- Current-base execution handles normal repository advancement while material
  drift becomes an explicit plan decision.
- CI, adversarial review, maintainer review, merge, and outcome verification
  remain independently observable facts.
- Three default repair attempts bound ordinary agent churn while a human can
  justify one additional attempt at a time.
- Treating review text as data prevents comments from becoming hidden prompt
  authority.
- One-PR lineage and reconciliation reduce duplicate or review-escaping
  artifacts.
- Restricting dependency signals to merge and verified outcome simplifies v1
  ordering but prevents speculative downstream implementation before merge.
- Semantic post-merge verification adds another capable-agent run for slices
  whose acceptance cannot be checked deterministically.
- Fluent needs maintainer-identity mapping, CI and review ingestion, repair
  budgets, PR-lineage reconciliation, drift detection, and outcome verifiers.
- Exact authorized-maintainer rules, transient-CI classification, additional-
  attempt policy, and verification-profile vocabulary remain open.

## Alternatives considered

- **Give one worker the whole initiative:** rejected because scope, credentials,
  failure recovery, and review would become unbounded.
- **Start from the planning snapshot:** rejected because predecessor merges and
  unrelated accepted changes make that checkout stale; scope stays fixed while
  the base advances.
- **Let workers adapt materially to drift:** rejected because changed scope,
  risk, or compatibility was not part of the approved plan.
- **Open a new PR for every repair:** rejected because review, CI, and lineage
  would fragment and duplicates would proliferate.
- **Allow unlimited repair attempts:** rejected because failing CI and review
  disagreement could consume agents indefinitely.
- **Treat every review comment as a change request:** rejected because comments
  may be suggestions, untrusted input, or authored by someone without authority.
- **Release dependents when a PR opens or turns green:** rejected because the
  change is not yet on the target branch and may still fail review or merge.
- **Use GitHub merge alone as success:** rejected because a merge can occur with
  unresolved Fluent gates and may not satisfy post-merge acceptance.
- **Let the implementer verify its own semantic outcome:** rejected because it
  is not independent evidence.

## References

- Executes immutable slices from
  [ADR-0028](0028-approve-immutable-delivery-plans-in-core.md) under bounded
  review from [ADR-0029](0029-bound-adversarial-review.md)
- Preserves coordination, credentials, and attempts from
  [ADR-0003](0003-separate-work-coordination-from-execution.md) and
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md)
- Applies repository policy and risk from
  [ADR-0015](0015-authorize-repository-enrollment-through-core.md) and
  [ADR-0017](0017-standardize-actions-boundaries-and-risk.md), with
  FleetController dependencies from
  [ADR-0026](0026-coordinate-enrolled-repositories-with-fleetcontroller.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [delivery slice execution and rework](../prd/agent-fleet.md#delivery-slice-execution-and-rework)
- Implementation design, contract, and delivery plan: not yet authored
