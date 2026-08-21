# 0069 — Declare the required artifact on every work item

- **Status:** Accepted
- **Date:** 2026-08-21

## Context

A work item's contract is its `allowedActions` (what the worker may do) and
its `delegableActions` (the widest thing a child may be granted). Artifact
reporting is gated on those actions: a `pull-request` artifact requires
`open-pr` ([work queue spec](../specs/work-queue.md) rule 10), and nothing
widens an admitted item afterwards. What the contract never said is what a
completion *must* report. Completion validated only the converse — "if a pull
request is reported, `open-pr` must be held" — so an item could legally
complete with a commit on a branch, a report, or nothing at all.

The maintenance-program catalog
([`src/queue/programs.ts`](../../src/queue/programs.ts)) assumes the
opposite: a discovery root proposes "one bounded implementation child" that
"a worker lands through one pull request", and the worker skill calls an
under-authorized change proposal invalid. Neither was enforced. On
2026-08-21 the live fleet proved it several times in one day: `*-gap`
discovery roots proposed implementation children whose `allowedActions` were
`read, write, run-tests` — no `open-pr` — the operator admitted them, and
the workers could only leave the change on a branch or block. Proposal and
admission both checked that actions were known and within the parent's
ceiling; neither asked whether the proposed work could be delivered at all.
Skill text asking workers to include `open-pr` had already been tried and did
not hold.

Fixing it by inference — treating `write` or a `*-fix` kind as "must deliver
a pull request" — would be wrong in both directions. A `release-needed` root
is granted `write` and `open-pr` and is told to complete with evidence and no
pull request when nothing needs to change before the tag; a discovery root is
read-only and completes on its result. Kinds are worker-selectable strings
the store does not interpret ([ADR-0059](0059-adopt-the-queue-store-as-the-v1-work-engine.md)).

## Decision

Every work item carries an explicit **required artifact** — `requiredArtifact`,
`none` or `pull-request` — declared by whoever defines the item and never
inferred from its kind or actions.

1. **Declared at definition.** A feeder, import, or sweep sets it on the roots
   it creates (`import-issues` roots, `dependency-bump`, `pr-cure`, and
   `pr-review-fix` declare `pull-request`; discovery roots, `release-needed`,
   `settings-drift`, and `pr-review` declare `none`). A worker proposing a
   follow-up declares it on the follow-up: the field is required at the MCP
   boundary and in the store, never defaulted. Omitted on an operator seed,
   it is `none`.
2. **Validated at proposal.** On every definition path the store refuses a
   contract the item's own authority cannot honor: `pull-request` without
   `open-pr`, and `write` without `open-pr` (a change that cannot leave the
   worker's checkout). A follow-up granting `write` must declare
   `pull-request`: a change child that declines to promise its pull request
   is the same under-delivery by another name. A refused follow-up rolls the
   whole completion back and leaves the parent claimed, like every other
   follow-up rule.
3. **Revalidated at admission.** `approve` runs the same predicate on the
   stored item and refuses to admit an inconsistent one, naming the problem
   and `reject`; a proposal that reached the store before this rule cannot
   become claimable work nobody can complete.
4. **Enforced at completion.** `complete_work` on an item whose required
   artifact is `pull-request` is refused — the item stays claimed — unless
   the reported artifacts include a `pull-request`. A worker that finds no
   change warranted blocks with the reason; deciding the item is done without
   its deliverable is the operator's call (`cancel`), not the worker's.
5. **Audited.** `queue -- audit-contracts [--repository]` lists every
   proposed, queued, claimed, or blocked item the predicate rejects, with the
   operator command that clears it, and exits non-zero when it lists
   anything. It reads only. The schema gains one column (rung 13,
   `required_artifact`, default `none`) and backfills nothing: existing rows
   read as `none`, and the audit — not a migration guessing from actions — is
   how the operator finds the ones to reject.

## Consequences

- A change proposal that cannot be delivered is refused at the moment it is
  made, with the follow-up named, instead of discovered by the worker that
  claims it. The operator admits nothing the store would refuse later.
- Workers must state the contract on every follow-up. Discovery roots'
  follow-ups are overwhelmingly implementation children, so in practice that
  is `requiredArtifact: "pull-request"` plus `open-pr`; the skill says so and
  the error message says so.
- An implementation item can no longer complete "successfully" on a branch
  commit. Items that legitimately may finish without a pull request must say
  so (`none`) when they are defined; the store does not decide for them.
- `attach-artifact` is unchanged: an item that required no pull request and
  completed without one can still have the operator's hand-carried pull
  request attached afterwards.
- Existing in-flight items keep their old (no-contract) behavior until the
  operator runs the audit and rejects or cancels what it lists. Nothing is
  rewritten under them.
- The vocabulary gains one term, *required artifact*, and one column. Adding
  another value (for example an issue a discovery item must file) is an enum
  extension and a completion check, not a redesign.

## Alternatives considered

- **Infer the contract from `write` or from the kind name:** rejected.
  `release-needed` proves `write` without a required pull request is a real
  shape, and kinds are uninterpreted strings; inference would refuse valid
  work and silently pass invalid work of a new name.
- **Widen an under-authorized proposal at admission (add `open-pr`):**
  rejected. Admission grants authority a worker proposed and the operator
  reviewed; rewriting the proposal under the operator's approval is exactly
  the mutation the queue refuses everywhere else ([ADR-0005](0005-admit-worker-created-work-before-claiming.md)).
- **Skill text only ("include `open-pr`"):** rejected by evidence. It was
  already in the skill when the live instance produced the items.
- **Backfill `pull-request` onto existing `write` rows in the migration
  rung:** rejected for the same reason as inference, and because a migration
  that changes what a claimed item's worker must report mid-lease is a
  surprise with no author.

## References

- Shapes: [specs/work-queue.md](../specs/work-queue.md) (work item field,
  rule 64), [design/queue-operations.md](../design/queue-operations.md)
  (admission and troubleshooting), the
  [work-snowcat-queue](../../.agents/skills/work-snowcat-queue/SKILL.md) and
  [write-snowcat-issues](../../.agents/skills/write-snowcat-issues/SKILL.md)
  skills, [domain/ubiquitous-language.md](../domain/ubiquitous-language.md)
  (required artifact)
- Builds on: [ADR-0005](0005-admit-worker-created-work-before-claiming.md),
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md),
  [ADR-0031](0031-separate-delivery-from-outcome-achievement.md),
  [ADR-0059](0059-adopt-the-queue-store-as-the-v1-work-engine.md),
  [ADR-0061](0061-cure-pull-requests-as-bounded-per-head-work.md),
  [ADR-0065](0065-gate-worker-pull-requests-behind-bounded-review.md)
