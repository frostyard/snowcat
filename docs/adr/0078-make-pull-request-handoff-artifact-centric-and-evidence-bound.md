# 0078 — Make pull-request handoff artifact-centric and evidence-bound

- **Status:** Accepted
- **Date:** 2026-08-29

## Context

Snowcat accepts a worker completion as soon as GitHub confirms that its
reported pull request exists in the target repository. The worker procedure
also requires a repository-template-shaped body and concrete verification
evidence, but the server does not enforce either. A missing section therefore
survives until an independent review spends a round reporting a
`contract:pr-body:` blocker that only a human may cure.

After completion, the operator's `deliveries` view groups pending artifacts by
work item. The human action, however, is on one pull request or release at a
time. A work item containing more than one artifact obscures the exact merge,
review, or publication handoff.

The baseline metric `acceptedPerAttempt` divides pull requests merged from
completion events in one time window by claim events in that window. Those are
different cohorts: a claim may complete later, and a completed pull request may
have been claimed earlier. The ratio can therefore report zero or exceed one
without describing either worker effectiveness or delivery acceptance.

## Decision

Every pull request reported through `complete_work` must carry at least one
attempt evidence assertion before Snowcat performs any GitHub read. For an
open pull request, Snowcat then validates the remaining completion handoff
before committing the result:

1. the pull request body is non-empty;
2. every level-two section in the repository's canonical
   `.github/pull_request_template.md` is present, or, when that file does not
   exist, the body carries Summary, Verification, and Risk tier sections;
3. the Summary, Checks/Verification, and Risk sections contain visible
   content after comments and unchecked boxes are removed; and
4. when the template presents risk-tier checkboxes, exactly one of those
   declared options is checked; an unrelated checkbox does not satisfy risk
   selection.

The check reuses the pull-request response already acquired for artifact
verification and performs one bounded GitHub contents read per repository in
that operation for the canonical template. A definite defect rejects the whole
completion and leaves the lease active so the worker can edit the body and
retry. An unavailable or unreadable template answer keeps the GitHub
pull-request observation verified but records an unresolved handoff check
beside it. The ordinary artifact refresh repeats only unresolved handoff checks
with the retained attempt evidence. A later definite defect remains attached
to the verified pull request and appears as a repair handoff; a repaired body
clears it. Review waits while that marker exists, but the review gate's draft
requirement still uses the verified pull-request observation. Snowcat stores
neither pull-request body nor template bytes. Merged pull requests re-reported
as already-delivered work are outside this open-handoff check.

A contents 404 proves template absence only when the pull-request response
also proves the repository is public and Snowcat presented a credential.
Otherwise the response is ambiguous with missing Contents permission and the
handoff remains unresolved. Historical or operator-attached source-unverified
rows with no retained attempt evidence are source-verified without retroactively
inventing a permanently unrepairable evidence defect.

`queue -- deliveries` emits one row per unique verified pending pull request
or draft release, even when an origin, cure, and review fix all reported the
same artifact. Pull requests use the queue repository plus verified GitHub
number as identity, so URL casing or a retained pre-rename URL cannot duplicate
one pull request. Terminal observations participate in reconciliation before
pending rows are selected, so a newer merge or closure suppresses an older
open report. Source state and handoff state fold independently: a newer source
observation cannot erase a marker stored on another report; only a successful
refresh of that marker-bearing report clears it. The artifact URL, state, draft flag, observed head, and next
delivery handoff (`verify`, `repair`, `review`, `merge`, or `publish`) are
first-class fields; the oldest work-item identity and objective remain context
while the newest source observation supplies the artifact state. Verify is
source acquisition, repair is human description repair, review names the
bounded review gate, and merge and publish are human authority acts. Merge and
publish rows sort before the other handoffs, then oldest first.

Queue metrics retain raw stage transition counts but remove
`acceptedPerAttempt`. They expose an `acceptance` stage over the unique pull
requests reported by completions in the window, using the same repository and
GitHub-number identity: `numerator` is merged
pull-request delivery, `denominator` is terminal pull-request delivery
(`merged + closed`), and `rate` is their ratio. Still-open and unavailable
pull requests are censored counts, not failures; completion events with no
pull-request artifact are explicit exclusions. This prevents one origin plus
several cure or review-fix reports from weighting one GitHub delivery several
times. The newest verified source observation determines state; a later
unavailable read cannot erase it. The source remains the window's
`work.completed` events plus each artifact's current verification.

## Consequences

Obvious pull-request handoff defects return to the worker that can still fix
them instead of consuming review rounds and human adjudication. Review remains
responsible for whether body claims are true and whether the tree satisfies the
origin contract; completion validation proves only the bounded structural
handoff.

Template acquisition adds at most one read per repository to a completion or
refresh operation. An outage never becomes a success-shaped fallback and never
erases the verified pull request: the handoff is visibly waiting for source
verification until the refresh can decide.

The operator surface carries that handoff state into its pull-request
projection and artifact-handoff rail. A pull request waiting for verification
or repair cannot appear ready to mark or merge, including when the marker was
reported by a review-fix item rather than the origin.

The deliveries JSON shape changes from one item with nested artifacts to one
artifact per row. It is an operator CLI, not an MCP contract, but scripts that
consume it must move to the explicit `artifact` and `handoff` fields.

The acceptance rate may remain `null` while every pull request in the window is
still open. That is deliberate insufficient terminal evidence, not zero
acceptance.

## Alternatives considered

- **Leave body checks to independent review:** rejected because deterministic
  template omissions waste a bounded review round and route repair away from
  the worker that owns the open pull request.
- **Reject when GitHub or the template cannot be read:** rejected because
  source unavailability is not evidence of an invalid handoff.
- **Keep item-centric deliveries:** rejected because the operator action and
  GitHub identity are artifact-scoped.
- **Keep accepted-per-attempt with a warning:** rejected because a labeled but
  mathematically incoherent ratio remains easy to mistake for performance.
- **Treat open pull requests as failed acceptance:** rejected because their
  outcomes are censored, not terminal.

## References

- Shapes:
  [queue execution boundary](../design/queue-execution-boundary.md),
  [operating the work queue](../design/queue-operations.md),
  [operator surface](../design/operator-surface.md),
  [work queue](../specs/work-queue.md), and
  [maintenance fleet PRD](../prd/agent-fleet.md)
- Builds on:
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md),
  [ADR-0031](0031-separate-delivery-from-outcome-achievement.md),
  [ADR-0065](0065-gate-worker-pull-requests-behind-bounded-review.md),
  [ADR-0067](0067-adjudicate-description-blockers-by-a-human.md), and
  [ADR-0071](0071-pass-the-tree-when-only-adjudicated-description-blockers-remain.md)
