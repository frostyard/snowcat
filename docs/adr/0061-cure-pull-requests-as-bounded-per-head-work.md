# 0061 — Cure pull requests as bounded per-head work

- **Status:** Accepted
- **Date:** 2026-08-18

## Context

Fluent workers open pull requests; humans merge them
([ADR-0030](0030-execute-one-slice-through-one-pull-request.md)). Between
those two moments a pull request decays. On the first two dogfood days: a
second lease re-implemented an item and opened a duplicate (#6 against #5); a
pull request needed a retitle to satisfy the repository's title lint (#300); a
follow-up pull request (#309) was required for the first (#308) to meet its
own acceptance criterion; a finished pull request (#310) rotted while an
overlapping change (#319) landed and was closed unmerged; a pull request from
another tool (#313) sat un-mergeable until a Fluent worker rebased and
retitled it; and every pull request on updex accumulated a requested review
that nobody answered.

Nothing in Fluent owns that interval today. `verify-artifacts` already polls
every pull request a completed item reported, so the queue knows which pull
requests exist, their head SHA, their state, and — with two more fields —
whether they are mergeable and whether their checks pass. Discovery kinds
(quality, CI, security, architecture) are per-repository assessments on a
cooldown; a pull request needs attention per head, on the event that it
decayed.

The operator wants pull requests kept mergeable without being asked to
approve every rebase, and without a worker changing what a pull request does
under the name of "curing" it.

## Decision

Fluent cures pull requests as bounded work items, one per pull request head,
and decides admission by whether the cure changes the patch.

1. **A cure item is created per pull request head.** The verification pass
   that already re-checks reported pull requests (`verify-artifacts`, on the
   feed timer) also detects decay — `mergeable_state` dirty or behind, a
   failing required check, `changes_requested` or unresolved review threads,
   a title the repository's lint rejects, or age past a repository threshold —
   and enqueues one item of kind `pr-cure` with `sourceRef =
   <pull-request URL>@<head SHA>`. A new head after a push is a new source
   reference; the same head is never enqueued twice. Pull requests Fluent
   did not open are eligible only for repositories that opt in.
2. **Mechanical cures are admitted on creation; substantive cures are
   proposals.** A cure is *mechanical* when, after it, the pull request's
   patch is unchanged — the diff against its base has the same content
   (patch identity), and what changed is metadata: base (rebase without
   conflicts), title, body, labels, comment replies, a re-run of a check.
   Everything else — conflict resolution that edits code, a lint or review
   fix, a test change — is *substantive*. A `pr-cure` item is admitted on
   creation with authority `read, write, run-tests, open-pr` and the
   instruction to perform only mechanical cure; when the worker finds that
   curing requires changing the patch, it must not push and must instead
   propose one bounded child (`pr-cure-change`) describing the exact change,
   or block if the change is the maintainer's to make. Proposals are admitted
   by the operator like any other.
3. **The judgment is enforced by Fluent, not asserted by the worker.** The
   cure item records the head SHA and a patch digest at creation. On
   `complete_work`, the artifact verifier recomputes the digest of the pull
   request's patch; on a `pr-cure` item a changed digest refuses the
   completion, exactly as a wrong-repository artifact does today. A
   `pr-cure-change` child carries no such constraint; its criteria name the
   change.
4. **Merge remains human.** Cure never merges, approves, or dismisses a
   review; it makes a pull request mergeable and says so with evidence
   (checks green, `mergeable_state` clean, title lint green, the review
   threads it was asked to address resolved by reply or by the proposed
   change).
5. **Cadence and cooldown follow the source.** A cured head that decays again
   (a new merge to the base branch) is a new head only if the pull request
   is pushed; a stale-base decay on the same head is retried at most once
   per feed interval and then left for the operator, so a pull request that
   keeps losing to the base does not consume attention forever.

## Consequences

- Pull requests opened by workers (and, per repository, by anyone) stop
  decaying between open and merge, and the operator's inbox receives only
  the cures that change what a pull request does.
- The `verify-artifacts` pass grows two GitHub reads per pull request
  (mergeability and check runs) and one write path (enqueue); it stays on the
  existing timer.
- Patch identity becomes a first-class verification input; the verifier
  needs the pull request's file patches (`/pulls/N/files`), which is a bounded
  read for the pull-request sizes Fluent produces.
- Workers gain a kind whose success is not a new pull request but an
  unchanged patch on a healthier one; the skill and the issue-writing skill
  describe it.
- Repositories that opt in for foreign pull requests get help they did not
  ask a specific worker for; the opt-in and the mechanical-only default keep
  that from becoming unwanted edits.

## Alternatives considered

- **Make the original worker responsible until merge:** rejected; leases are
  bounded and the worker is gone; the decay happens hours later.
- **Gate every cure behind the operator:** rejected as the default; it puts
  one decision per pull request per day in the inbox for changes the operator
  would always accept, and merge is already the human gate. It remains
  available per repository as a policy.
- **A fifth discovery kind on the daily cooldown:** rejected; decay is per
  head and event-driven, not a repository assessment.
- **Let the worker declare whether its cure was mechanical:** rejected; the
  patch digest is cheap to compute and removes the judgment from the model.

## References

- Shapes: [maintenance programs plan](../plans/maintenance-programs.md),
  [work queue](../specs/work-queue.md), and the
  [queue execution boundary](../design/queue-execution-boundary.md)
- Builds on:
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md),
  [ADR-0021](0021-run-bounded-maintenance-assessments.md),
  [ADR-0030](0030-execute-one-slice-through-one-pull-request.md), and
  [ADR-0059](0059-adopt-the-queue-store-as-the-v1-work-engine.md)
