# 0071 — Pass the tree when only adjudicated description blockers remain

- **Status:** Accepted
- **Date:** 2026-08-23

## Context

[ADR-0067](0067-adjudicate-description-blockers-by-a-human.md) routes
`contract:pr-body:` description blockers to a human and forbids any
automated cure, while review rounds stay head-keyed and capped at three
([ADR-0065](0065-gate-worker-pull-requests-behind-bounded-review.md)). Those
two decisions compose into a deterministic burn: an honest later-round
reviewer must re-raise a still-uncured description blocker — the defect is
real, and only a human may cure it — so one unadjudicated body defect
converts every remaining round into a `block`.

The first gated operation produced exactly this (2026-08-23, snowcat#199;
[reality report finding 14](../design/reality.md)): round 2 blocked on a
tree defect plus a missing risk-classification section, the fix cured the
tree, and round 3 blocked over a clean tree solely on the description
blocker round 2 had already routed to a human. The gate spent its scarcest
resources — a review round and reviewer attention — re-deciding a question
it had already handed off, and the pull request ended labeled "blocked at
round three" when its true state was: tree done, description with a human.

## Decision

1. **Novelty partitions description blockers at consequence time.** Acting
   on a `block` verdict, the sweep treats a description blocker whose
   fingerprint appears among the previous round's description blockers (the
   verdict record's `priorBlockers`) as **outstanding** — already routed to
   adjudication — not a new finding. A description blocker raised for the
   first time is new, exactly as before.
2. **An all-outstanding verdict takes the pass consequence.** A `block`
   whose blockers are exclusively outstanding description blockers takes
   ADR-0065's pass consequence — marked ready with
   `SNOWCAT_REVIEW_GATE_WRITES=1`, reported `readyToMark` without —
   evaluated before the round-three rule, so a clean tree is never reported
   as "blocked at round three". Its blockers still ride to the Review
   adjudication report, with ADR-0067's staleness annotation; the round
   completed and counts against the budget.
3. **Everything else is unchanged.** Any tree blocker, and any description
   blocker raised for the first time, keeps ADR-0067's block consequences:
   the fix for tree blockers only, the adjudication report for description
   blockers, no automated description edit ever.
4. **The reviewer instructions state the convention.** A still-open
   description blocker is re-raised honestly under its prior fingerprint;
   Snowcat will not mint a fix or spend the remaining budget on what a
   human already holds.

## Consequences

- The burn disappears: a pull request whose only remaining defect is one the
  gate is forbidden to act on stops consuming rounds and reviewer attention,
  and its final state is legible — ready, with the outstanding description
  blocker on the adjudication report until the human acts.
- Nothing is hidden by the early ready: the human who edits the description
  is the same human a ready pull request reaches, and the adjudication entry
  stands beside it. Human authority over ready pull requests (ADR-0065) is
  unchanged.
- A ready pull request can now carry a known description defect. The
  adjudication report is the guard; an operator who merges past it accepts
  the defect knowingly, which is ADR-0067's premise (descriptions are
  humans' to judge).
- A reviewer who wrongly reuses a prior description fingerprint for a
  genuinely different body defect slips the new defect past the block
  consequence. Fingerprints are per-defect by convention and the
  adjudication report still carries the blocker's full text, so the human
  sees the substance either way.
- The sweep reports description adjudication at every round now, including
  round three, so one pull request can carry two `needsHuman` entries in one
  pass (the description detail and a tree-blocker round exhaustion); the
  inbox already groups them.

## Alternatives considered

- **Keep burning the rounds (status quo):** re-decides a handed-off
  question, ends in the same human's lap with a worse label, and wastes the
  gate's boundedness on defects it may not touch.
- **Stop scheduling rounds while a description blocker is outstanding:**
  holds the tree hostage to the body — new heads would land unreviewed
  behind a defect only a human can clear.
- **Ask reviewers to downgrade re-raised description blockers to
  advisories:** makes the gate's arithmetic depend on prompt discipline,
  the exact failure class the reality report's findings 8 and 10 document;
  honesty must stay cheap.

## References

- Shapes: [specs/work-queue.md](../specs/work-queue.md) (rule 55),
  [design/queue-operations.md](../design/queue-operations.md),
  [design/reality.md](../design/reality.md) (finding 14)
- Builds on:
  [ADR-0065](0065-gate-worker-pull-requests-behind-bounded-review.md),
  [ADR-0067](0067-adjudicate-description-blockers-by-a-human.md)
