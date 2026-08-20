# 0067 — Adjudicate description blockers by a human

- **Status:** Accepted
- **Date:** 2026-08-20

## Context

The review gate ([ADR-0065](0065-gate-worker-pull-requests-behind-bounded-review.md))
binds every round to a pull request's head SHA: a new head is the next round,
a pass is invalidated by a push, the fix item is keyed
`pr-review-fix:<url>@<head SHA>`, and a fix that completes without moving the
head is reported for a human. The pull request's *description* — its body,
where the repository's template contracts live (risk tier, required evidence,
attestation sections) — is outside that key entirely: editing it moves no
head, resets nothing, and is observed by a reviewer only as-of the moment the
review happened to read it.

The first night of gated fleet operation (2026-08-20) produced the collision
this makes inevitable. Snowcat#144's round 1 blocked on two fingerprints, one
in the tree and one in the description (`contract:pr-body:credential-risk-tier`,
a Tier 1 selection on a change inside a Tier 4 boundary). The fix worker
pushed the tree cure at 02:42:50Z — which the sweep correctly took as the
next head — and landed the description cure by `gh pr edit` at 03:00:37Z. The
round-2 verdict was recorded at 02:58:14Z, between the two: the reviewer
judged the 02:34Z description, re-raised the already-being-cured blocker as
if uncured, and a second fix item was minted whose audit (GraphQL
`userContentEdits`) showed there was nothing left to cure. The item completed
without a new head and the pull request went to human adjudication — the
right destination, reached by burning a review round, a fix lease, and an
operator-confusing "blocked again" on the way.

The failure is structural, not a worker error. A description cure has no
head to move, so the gate can never observe that it happened, never re-review
it, and never order it against the rounds — the same class of problem
[ADR-0066](0066-sequence-project-slices-on-observed-predecessor-delivery.md)
excludes from work sequencing by requiring an independently observed signal.
Meanwhile the description defects themselves are judgment calls (which risk
tier a diff *belongs* to, whether Tier 4 evidence is *sufficient*), the same
ones [docs/risk-tiers.md](../risk-tiers.md) already reserves for humans, and
the destination for everything the gate cannot decide already exists: the
"Review adjudication" report of ADR-0065's decision point 5.

## Decision

Description blockers go straight to human adjudication. The gate never mints
a `pr-review-fix` for one, and no automated actor edits a pull-request
description to satisfy a review. Heads are machines' to move; descriptions
are humans' to.

1. **A description blocker is named by its fingerprint.** A blocker whose
   only cure is a change to the pull-request description carries the
   fingerprint prefix `contract:pr-body:`, and its location names the
   description, not a file. The reviewer instructions the sweep issues state
   this convention; the two fingerprint classes partition a verdict.
2. **A verdict's description blockers are reported, not fixed.** When the
   sweep acts on a `block`, description blockers are excluded from the fix
   item: a verdict with only description blockers creates no `pr-review-fix`
   and goes to the Review adjudication report with its blockers; a mixed
   verdict mints the fix for the tree blockers only, and its description
   blockers ride to the same report. The round still counts against the
   budget — it completed.
3. **Fix items keep their hands off the description.** A `pr-review-fix`
   cures tree blockers on the branch; it does not edit the pull-request
   body. A fix worker that believes a description blocker was mis-partitioned
   says so in evidence for the human, and nothing else.
4. **A stale description blocker is visible as stale.** When the sweep
   reports a description blocker for adjudication, it reads the description's
   last-edited time from GitHub; if the description changed after the
   verdict's `reviewedAt`, the report says so ("description changed after
   review"), so a blocker that raced a human's (or an earlier round's) edit
   is legible as possibly-cured rather than re-litigated.
5. **The gate never re-reviews a description.** Rounds remain purely
   head-keyed. The human who edits the description adjudicates its own
   compliance; marking ready remains the existing pass/human path of
   ADR-0065, unchanged.

## Consequences

- The race class disappears from the automated path: nothing automated
  writes what the rounds cannot key, so no cure can land invisibly between
  a read and a verdict. A reviewer can still judge a description that a
  human edits mid-round — decision 4 makes that visible instead of
  preventing it, which is the cheapest honest treatment.
- Operators get description toil back, deliberately: one body edit plus one
  adjudication for defects that are judgment calls about risk and evidence.
  The first night's data says the volume is real (two of five gated
  pull requests) but the cure is one `gh pr edit` — and most of the volume
  is template mismatch a future mechanical check at `complete_work` could
  drain upstream without judging correctness (an open idea, not part of
  this decision).
- One fewer automated writer of GitHub state: fix workers stop editing
  bodies, so the gate's writes remain exactly ADR-0065's ready/draft
  mutations and nothing else.
- The sweep learns to partition blockers by fingerprint prefix and to read
  one more field (description last-edited time) when reporting; the
  reviewer instructions and the worker skill state the convention; the
  work-queue spec rules amend alongside that implementing change.
- A mis-partitioned blocker (a tree defect fingerprinted `contract:pr-body:`)
  stalls on a human instead of a fix worker — the safe direction; the human
  requeues it into scope with a note.

## Alternatives considered

- **Bind rounds to head plus a description version:** rejected; it puts a
  frequently and casually edited surface into the identity that keys rounds,
  budgets, `sourceRef`s, and cures, churning rounds on wording edits and
  complicating exactly the invariant that keeps the gate simple.
- **Keep automated description cures and rely on the existing
  no-new-head → human path:** rejected; that is the shape that produced the
  race — a cure whose completion the gate cannot observe violates the
  observed-signal principle, and the human still ends up adjudicating, one
  burned round later.
- **Refuse noncompliant descriptions at `complete_work` (template lint):**
  not adopted here; presence of required sections is mechanically checkable
  and could drain most of the volume upstream, but the defects that blocked
  were about *correctness* (the tier chosen), which lint cannot judge. Left
  as a separately decidable upstream check that would complement, not
  replace, this decision.
- **Let the reviewer edit the description itself:** rejected; ADR-0029 and
  ADR-0065 keep review read-only, and a reviewer that edits what it judges
  is not independent.

## References

- Shapes: [work queue spec](../specs/work-queue.md) (review-gate rules,
  amended with the implementing change),
  [queue operations runbook](../design/queue-operations.md#review-gate), and
  the [work-snowcat-queue skill](../../.agents/skills/work-snowcat-queue/SKILL.md)
  (reviewer and fix-worker rules)
- Builds on:
  [ADR-0004](0004-keep-models-outside-the-control-path.md),
  [ADR-0029](0029-bound-adversarial-review.md),
  [ADR-0065](0065-gate-worker-pull-requests-behind-bounded-review.md), and
  [ADR-0066](0066-sequence-project-slices-on-observed-predecessor-delivery.md)
- Plan: [recovery plan, Later / ideas](../plans/recover.md#later-ideas)
- Terms: [description blocker](../domain/ubiquitous-language.md#description-blocker),
  [review blocker](../domain/ubiquitous-language.md#review-blocker),
  [review round](../domain/ubiquitous-language.md#review-round)
