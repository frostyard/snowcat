# 0029 — Bound adversarial review

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

Fluent now has three consequential artifacts that benefit from independent
semantic challenge: the PRD defines desired outcomes, the delivery plan defines
authorized decomposition and ordering, and each pull request claims to satisfy
one slice. Human review remains mandatory, but a capable worker can find
contradictions, unsafe intermediate states, incorrect implementations, and
false evidence before maintainers spend attention or dependent work proceeds.

An unconstrained “be adversarial” prompt can be as harmful as no review. A model
can produce endless stylistic objections, move the goalposts after every edit,
or block progress because it prefers another valid design. A reviewer can also
be wrong, so its semantic judgment cannot become policy authority or replace
human adjudication.

## Decision

The capable review role is named `adversarial-reviewer`. It has three separate
versioned profiles—`prd`, `delivery-plan`, and `pull-request`—with distinct
blocker criteria. One generic rubric MUST NOT substitute for the artifact-
specific contracts.

Adversarial means trying to falsify material claims and acceptance, not
maximizing comments. Review work is read-only. The reviewer cannot edit the
artifact, submit a GitHub review, approve or merge a pull request, admit follow-
up work, waive policy, or broaden the reviewed scope.

Every review binds to an immutable subject:

- a PRD profile binds to initiative ID, exact core commit, PRD blob and digest,
  declaration digest, and profile version;
- a delivery-plan profile binds to initiative ID, proposed plan bytes and
  digest, source PRD digest, target snapshots, and profile version; and
- a pull-request profile binds to repository ID, pull request number, base and
  head SHAs, verified diff, required CI observation, slice and plan IDs, and
  profile version.

The responsible FleetController or RepositoryController validates deterministic
prerequisites before creating a review item. A pull-request review is not
eligible until the artifact is independently verified, the exact head SHA is
known, and required CI facts are available or explicitly unavailable under the
accepted review policy.

A valid structured result has decision `pass`, `block`, or
`unable-to-review`, no more than five blockers, and no more than three
advisories. `pass` may include advisories. `unable-to-review` names the missing
input or capability and routes to human adjudication; it MUST NOT fabricate a
pass or blocker.

Every blocker includes:

- exact artifact location;
- the violated accepted requirement or contract, or a concrete counterexample;
- material impact;
- the minimally sufficient resolution rather than a preferred redesign;
- a verification method; and
- a stable fingerprint used for deduplication and re-review.

Style preferences, optional improvements, alternative valid designs,
speculative future concerns without current impact, and “while you are here”
work cannot block. Advisories never require resolution, never prevent
progression, and never create queue work automatically.

The PRD profile may block only for a material internal contradiction, an
unresolved decision that changes product scope or feasibility, an untestable
required outcome, a missing critical constraint, conflict with accepted
organization direction, or a known safety or security omission that prevents
responsible planning.

The delivery-plan profile may block only for an omitted or contradicted PRD
outcome, unsafe or cyclic ordering, a slice that cannot be independently
reviewed or merged without its missing compatibility mechanism, an omitted
dependency, impossible acceptance, policy or action mismatch, material risk or
protected-boundary underclassification, or missing rollout or rollback needed
for a safe intermediate state.

The pull-request profile may block only for a concrete correctness or security
defect, unmet slice acceptance criterion, unauthorized or out-of-scope behavior,
false or materially insufficient required evidence, missing required validation,
or a compatibility or contract break. It cannot block because it would have
implemented the slice differently.

The reviewer session and attempt must differ from the artifact-authoring
session and attempt. A different provider or model is preferred for cognitive
diversity but is descriptive metadata, not proof of independence or authority.
The author cannot review its own artifact through another caller-supplied name.

Each artifact review lineage receives at most three completed valid adversarial
review rounds before mandatory human adjudication. A re-review examines the
prior blockers and the diff from the previously reviewed subject; it MUST NOT
restart an unrestricted audit. A new blocker is permitted only when the diff
introduced it or made it newly assessable, and the reviewer must identify that
reason. Rewording or splitting an existing concern does not create a new
fingerprint or extend the review budget.

The review lineage follows the logical artifact across corrective revisions:
initiative and PRD profile for PRDs, initiative and proposed-plan lineage for
plans, and plan slice plus pull request for PRs. Creating another revision does
not automatically reset the budget. An attributed human may explicitly start a
new lineage only after a material scope change and with a recorded reason.

Any change to reviewed PRD or plan bytes invalidates its prior pass for
activation. Any change to a reviewed pull request head SHA invalidates the pass
for that PR state. The controller may enqueue a bounded re-review if budget
remains; otherwise it requires human adjudication.

`block` conservatively stops Fluent progression but remains an untrusted
semantic claim. `pass` satisfies the adversarial-review gate only; it does not
prove correctness, approve a core PR, accept policy risk, or replace maintainer
review. PRD planning activation and delivery-plan activation require a current
pass or explicit human disposition of every blocker. Pull-request slice outcome
verification requires the same before dependents may proceed.

An authorized human may mark a blocker `resolved`, `waived`, or `escalated`
with actor, rationale, exact subject digest or SHA, and supporting evidence.
Human disposition cannot override a deterministic policy denial, missing
required approval, denied action, repository hold, or mandatory security
control. Security-sensitive waivers retain the independent approval and
exception requirements of effective policy.

If GitHub reports that a pull request merged while an applicable adversarial
blocker remains unresolved, Fluent records the merge as fact but does not mark
the slice outcome verified or release dependent slices. An authorized human
must reconcile the blocker and merged state explicitly.

Review results, fingerprints, rounds, subject revisions, invalidations, human
dispositions, and resulting gate transitions remain durable provenance. Review
advisories are visible but do not enter the work queue unless a human separately
creates or admits work.

## Consequences

- PRDs, plans, and pull requests receive independent semantic challenge before
  their claims drive later work.
- Narrow blocker definitions and output caps focus reviews on material defects.
- Diff-based re-review and a three-round budget prevent automated goalpost
  movement from becoming an endless loop.
- Humans retain final adjudication while deterministic policy remains
  non-overridable.
- Exact digest and SHA binding makes stale review results visibly invalid.
- Requiring another worker attempt increases capable-agent use and latency for
  every delivery artifact.
- A faulty reviewer may conservatively block progress, but caps and human
  disposition bound the denial of service.
- Fluent needs structured review records, subject diffing, fingerprint
  deduplication, review-budget accounting, artifact-specific profiles, and
  human disposition controls.
- Exact reviewer capability matching, trigger UX, fingerprint algorithm,
  material-scope lineage reset, and treatment of unavailable CI remain open.

## Alternatives considered

- **Use one generic review prompt:** rejected because product, plan, and code
  artifacts have different material failure modes.
- **Allow unlimited blockers or rounds:** rejected because commentary volume and
  shifting preferences would become a progress veto.
- **Forbid new blockers on re-review:** rejected because a corrective diff can
  introduce a real defect; newly introduced or assessable blockers remain
  permitted with explanation.
- **Reset review budget on every revision:** rejected because trivial edits
  could restart an endless review loop.
- **Treat reviewer pass as approval:** rejected because semantic model output
  cannot replace human governance or deterministic policy.
- **Make review advisory-only:** rejected because known material defects should
  stop Fluent from automatically advancing dependent work.
- **Let a block override all human decisions:** rejected because the reviewer
  itself is fallible and its result is an untrusted claim.
- **Post every review to GitHub:** rejected for v1 because review authority is
  read-only and internal advisories should not create external noise.
- **Release dependents whenever GitHub merged the PR:** rejected because a merge
  may occur despite an unresolved known defect or outside Fluent's expected
  review path.

## References

- Builds on deterministic model treatment in
  [ADR-0004](0004-keep-models-outside-the-control-path.md), proposal admission
  in [ADR-0005](0005-admit-worker-created-work-before-claiming.md), and worker
  identity in
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md)
- Reviews PRD intake from
  [ADR-0027](0027-authorize-feature-planning-from-core-prds.md) and immutable
  delivery plans from
  [ADR-0028](0028-approve-immutable-delivery-plans-in-core.md)
- Preserves policy and security controls from
  [ADR-0010](0010-enforce-policies-monotonically-with-expiring-exceptions.md),
  [ADR-0017](0017-standardize-actions-boundaries-and-risk.md), and
  [ADR-0024](0024-restrict-security-findings-before-disclosure.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [bounded adversarial review](../prd/agent-fleet.md#bounded-adversarial-review)
- Implementation design, contract, and delivery plan: not yet authored
