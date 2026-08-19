# 0065 — Gate worker pull requests behind bounded review

- **Status:** Accepted
- **Date:** 2026-08-19

## Context

Two days of running the queue at roughly forty-five items a day across four
repositories ([recovery plan, Phase 7](../plans/recover.md)) showed two
problems at the same seam — the moment a worker's pull request becomes a
human's to review.

First, worker pull requests reached the human with gaps and defects that
nothing had caught: an unmet acceptance criterion, a check that passed
locally on the wrong branch, a change that did more than the item asked.
[ADR-0029](0029-bound-adversarial-review.md) already decided what independent
semantic challenge looks like — a read-only reviewer that never submits a
GitHub review, a `pass | block | unable-to-review` verdict, at most five
fingerprinted blockers and three advisories, at most three completed rounds
per pull request before a human adjudicates, re-review confined to prior
blockers plus the diff, a pass invalidated by a new head — and is
unimplemented: nothing in the code creates a review, binds it to a head, or
acts on its result.

Second, GitHub Copilot's automatic pull-request review, at its default *Lite*
effort level, flagged non-issues and proposed broken changes on those same
pull requests. The effort level is not a ruleset option (the ruleset rule
"Automatically request Copilot code review" carries only *review new pushes*
and *review draft pull requests*); it is an organization or repository
setting under *Copilot → Code review → Review effort level*, which the
operator sets by hand. What turned a weak review into a mess was a loop
outside Snowcat: five fleet repositories carry a `copilot-review-apply`
workflow that, on any Copilot review, asks the Copilot coding agent to
"address every finding", which pushes a new head, which Copilot reviews
again, with no round cap; and Snowcat's pull-request cure
([ADR-0061](0061-cure-pull-requests-as-bounded-per-head-work.md)) then saw
the unresolved Copilot threads as decay and sent a second fixer at the same
review. Any review gate Snowcat adds has to be safe against exactly that
shape: two automated actors, one pull request, no bound.

One fact makes a bound cheap. A draft pull request is already a quiet zone
everywhere that matters: the cure sweep never decays a draft (spec rule 42),
Copilot's automatic review skips drafts unless a ruleset opts in, and every
one of the fleet's review-apply workflows runs only on non-drafts. A
pull request that stays a draft until Snowcat's own review passes is reviewed
by exactly one thing at a time.

## Decision

Snowcat gates worker pull requests behind bounded, read-only review — the
pull-request profile of ADR-0029, implemented through the queue's existing
per-head root and deterministic-consequence machinery — per repository and
off by default.

1. **The gate is a repository setting.** `queue -- review-gate <owner/repo>
   on|off` (schema rung 8, off for every existing repository, carried by
   `rename-repository`). Nothing below applies to a repository without it.
2. **Workers open drafts.** In a gated repository, `complete_work` refuses a
   completion that reports an open, non-draft pull request and leaves the
   item claimed, naming the `gh pr ready --undo` that converts it back.
   Merged and closed pull requests are accepted, `pr-cure` items are exempt
   (cure acts only on ready pull requests), and an unverifiable answer is
   accepted as `unverified` rather than guessed. The draft flag is recorded
   with the artifact's verification and refreshed like its state.
3. **Review rounds are created by the sweep, never by workers.** A child can
   never be created admitted (ADR-0006), so the `verify-artifacts` pass that
   already refreshes and cures reported pull requests also creates, for each
   open draft head reported by a completed item in a gated repository, one
   **admitted** root of kind `pr-review`, keyed `sourceRef =
   pr-review:<url>@<head SHA>`, with `read` and `run-tests` only, nothing
   delegable, the origin item's priority, and a review record binding the
   round to the head, the origin item, the patch identity when computable,
   the previous round's blockers verbatim, and the models the author and the
   previous reviewer reported. Rounds are counted per pull request URL, not
   per head: a push does not reset the budget, and the fourth head after
   three completed rounds is reported for a human, not reviewed.
4. **The verdict is structured and bound.** A `pr-review` completes with
   `review: { decision, blockers ≤ 5, advisories ≤ 3 }` on `complete_work`
   — a `block` with at least one blocker, a `pass` with none, each blocker
   carrying a stable fingerprint, location, violated contract or
   counterexample, impact, minimal resolution, and verification method — and
   is refused when the pull request's head on GitHub is no longer the one the
   round named (the worker blocks instead), or when GitHub cannot answer. The
   reviewer reports no artifact (the pull request is not its work), submits
   no GitHub review or comment, pushes nothing, and marks nothing ready.
   Every other kind is refused a verdict.
5. **Snowcat acts on the verdict; models never touch the pull request.** On
   the next pass: a `pass` on the current head marks the pull request ready
   for review through GraphQL as `policy:review-gate`, recording
   `artifact.ready` on the origin item — only when the host sets
   `SNOWCAT_REVIEW_GATE_WRITES=1` (the token then needs pull-requests write);
   otherwise the operator surface says "passed review — mark ready" and a
   human runs `gh pr ready`. A `block` while the round budget lasts creates
   one admitted root of kind `pr-review-fix` for that head, keyed
   `pr-review-fix:<url>@<head SHA>`, carrying exactly the fingerprinted
   blockers, with `read, write, run-tests, open-pr` and nothing delegable,
   instructed to keep the pull request a draft and change nothing else; its
   push is a new head and the sweep's next round. A third-round `block`, an
   `unable-to-review`, or a fix that completed without moving the head
   creates nothing and is reported — CLI output and the inbox's "Review
   adjudication" group — for a human, who marks ready, pushes, requeues, or
   notes. Merge remains human, always.
6. **Model provenance is descriptive.** `complete_work.result` accepts an
   optional `model` — the model the worker says it ran — retained as
   provenance under rule 13, never verified, granting nothing. The sweep
   copies the origin's model into the review record and the reviewer's
   instructions ask for a different model or provider when the client can
   choose; the reviewer's own model travels to the fix and the next round.
   Reviewer-is-not-author (ADR-0029) is not enforceable under one
   `member:` principal and is asked of the worker, not checked.

Copilot is addressed outside Snowcat, by the operator: the organization's
Copilot review effort level set to *Balanced*, and the `copilot-review-apply`
workflows retired in repositories the gate covers (a core ADR amendment and
one issue per repository), so that Snowcat's bounded rounds are the only
automated fixer on a draft and Copilot reviews what a human is about to.

## Consequences

- A worker pull request is reviewed against the item's own acceptance
  criteria, by a different model where the orchestrator can arrange it,
  before a human looks; the human sees a pull request that passed or one
  explicitly marked as needing a decision, never a pull request nobody
  checked.
- The loop is bounded twice over: three rounds per pull request URL, and
  draft-only review/fix against ready-only cure and Copilot, so no two
  automated actors work one pull request at once.
- `verify-artifacts` grows one GitHub read per draft head (plus the files
  read for the patch identity) and, with writes on, Snowcat's first GitHub
  write — a GraphQL mutation that flips draft to ready and nothing else.
  `SNOWCAT_GITHUB_TOKEN` must then carry pull-requests write; the runbook
  says so.
- Workers gain two kinds whose success is a verdict or a new head on the
  same draft, and one more obligation — open drafts in gated repositories
  and report the model they ran; the skill and the issue-writing skill
  describe both.
- Schema rung 8 (`work_items.review_json`, `repositories.review_gate`) and
  a `review` option on `complete_work`; admitted `pr-review-fix` roots carry
  write authority without a digest guard, bounded instead by the draft rule,
  the fingerprinted scope, the empty delegation ceiling, and the round
  budget — stated in the spec as their own bound.
- A faulty reviewer can delay a good pull request by at most three rounds of
  bounded fix work before a human sees it; a human can always mark ready.
- The surface learns to show draft, review round, passed-review, and
  needs-human states, and the inbox a fourth group.

## Alternatives considered

- **Let the implementing worker review its own pull request before
  completing:** rejected; it is what we had (the worker's own checks), and
  it is not independent.
- **Create the review as a follow-up child of the implementing item:**
  rejected; children are proposals by construction (ADR-0005, ADR-0006), so
  every review would wait on the operator — the inbox toil the gate is meant
  to remove.
- **Count rounds per head:** rejected; a push would reset the budget and a
  pair of models could loop forever one commit at a time.
- **Let the reviewer post a GitHub review or mark the pull request ready:**
  rejected; ADR-0029 keeps review read-only and ADR-0004 keeps models out
  of the control path. Deterministic code acts on a recorded verdict.
- **Make the fix a proposal:** rejected as the default; a block within
  budget is exactly the bounded work the operator would always admit, and
  the third round is where a human must decide. The operator can turn the
  gate off per repository.
- **Exclude Copilot's threads from cure decay instead of gating:** rejected;
  it treats a symptom, and `require_conversation_resolution` means the
  threads still block merge.
- **Mark ready always, with no write toggle:** rejected; a new write scope on
  the token is the operator's decision per host, and the surface hint is a
  complete product without it.

## References

- Shapes: [work queue spec](../specs/work-queue.md) (rules 52–55),
  [queue operations runbook](../design/queue-operations.md#review-gate),
  [operator surface](../design/operator-surface.md),
  [how Snowcat works](../design/how-snowcat-works.md), and the
  [work-snowcat-queue skill](../../.agents/skills/work-snowcat-queue/SKILL.md)
- Builds on:
  [ADR-0004](0004-keep-models-outside-the-control-path.md),
  [ADR-0005](0005-admit-worker-created-work-before-claiming.md),
  [ADR-0006](0006-enforce-admission-in-the-database.md),
  [ADR-0029](0029-bound-adversarial-review.md),
  [ADR-0059](0059-adopt-the-queue-store-as-the-v1-work-engine.md), and
  [ADR-0061](0061-cure-pull-requests-as-bounded-per-head-work.md)
- Plan: [recovery plan, Phase 7](../plans/recover.md)
- Terms: [review gate](../domain/ubiquitous-language.md#review-gate),
  [review round](../domain/ubiquitous-language.md#review-round),
  [pull-request cure](../domain/ubiquitous-language.md#pull-request-cure)
