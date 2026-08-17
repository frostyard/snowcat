# 0056 — Derive required checks from enforced GitHub rules

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

ADR-0055 separates a complete evidence population from its rate evaluator but
leaves the population behind the proposed `github-check-runs:v1` adapter open.
A list of check runs cannot establish which checks were expected. Core could
name a convenient set of checks, but that set could drift from the checks that
actually govern repository changes while still being described as “required.”

GitHub also evaluates more than raw check-run rows. Required status checks can
be check runs or commit statuses, a same-named check and status may both need to
pass, the applicable commit may be the pull-request head or GitHub's test merge
commit, and merge queues evaluate a separate merge-group revision. Rules and
required-check producers can change over time. A retrospective query of current
rules therefore cannot truthfully reconstruct an earlier observation window.

Direct inspection on 2026-08-17 found no active rule applying to `main` and no
classic branch protection on either `frostyard/fluent` or `frostyard/core`.
Their GitHub Actions checks exist but are not currently required. Treating them
as required would be an invented authority claim.

## Decision

In v1, a required check is one enforced by an active GitHub ruleset applying to
the repository's observed default branch. GitHub is the canonical source of the
required-check selectors; Core declares the success measure and threshold but
MUST NOT duplicate the selector list. An optional CI check that is not present
in the applicable enforced rules is not a required check, regardless of its
name, workflow, apparent importance, or Core prose.

The source adapter identity for this contract is
`github-required-checks:v1`. The earlier `github-check-runs:v1` name remains
unsupported and MUST NOT be registered because the source can include both
GitHub check runs and commit statuses.

Before an observation window begins, Fluent MUST retain a complete baseline
containing the exact repository identity, default-branch locator, active
applicable rules, non-empty required-check selector set, and source revisions.
Every selector MUST bind an exact GitHub integration ID; an “any source” rule is
not sufficiently attributable for v1. The normalized default branch and
selector set MUST remain unchanged through the half-open interval
`[starts_at, ends_at)`. A ruleset or default-branch change makes the result
`unable`; v1 does not splice unlike populations into one rate.

The qualifying change population is every pull request whose GitHub
`merged_at` falls in that interval and whose base repository and branch match
the retained subject and default branch. Fluent MUST also reconcile
default-branch updates: an update that cannot be attributed to exactly one
qualifying pull request makes source coverage incomplete. A direct or bypass
push therefore cannot disappear from the measurement.

For each qualifying pull request, Fluent retains the exact commit revision that
GitHub evaluated for required checks at merge time. It may be the latest head
commit or GitHub's test merge commit; Fluent MUST NOT infer one from the final
merge commit after the fact. The evidence population contains one expected
occurrence for every `(pull request, required-check selector)` pair. All
check-run and commit-status records matching one selector are evidence for that
one occurrence, so a same-named check and status cannot silently enlarge or
shrink the denominator.

The adapter classifies an expected occurrence `missing` when no matching source
record exists, `inconclusive` when matching evidence lacks a stable terminal
interpretation, and `conclusive` when the retained evidence supplies an
unambiguous terminal result. A terminal failure is conclusive about CI behavior
even though it would normally block merge; bypass or enforcement failure is a
separate fact and policy concern. The raw normalized conclusions remain
available for that separate evaluation.

V1 rejects rather than approximates unsupported source shapes. A merge queue,
fork head repository, unbound integration, rule drift, default-branch drift,
unresolved required-check revision, incomplete pagination, source outage,
observation gap, conflicting source records, or expired GitHub check data makes
source coverage incomplete and the evaluator returns `unable`.

Fluent observes ruleset changes, pull requests, checks, statuses, and branch
updates through a read-only GitHub App. It accepts read-only Administration
permission because GitHub requires it for ruleset-change webhooks; the App
still has no repository write permission and remains separate from worker
credentials. Webhooks are authenticated, idempotent source notifications, not
sole authority. Bounded polling and reconciliation detect missed deliveries,
and any gap that prevents a complete historical account remains explicit.

Neither Core profile import nor a current-rules preflight establishes
historical support. Fluent MUST register `github-required-checks:v1` only after
the durable observation, completeness, normalization, and evidence-retention
path is implemented. Until then live Goals referencing it fail closed.

## Consequences

- “Required” has one external enforcement meaning and cannot be manufactured by
  a convenient Core list.
- A Goal cannot begin measuring until its repository actually enforces a
  stable, attributable, non-empty required-check ruleset.
- Missing checks and bypass updates remain visible instead of shrinking the
  population.
- Rule changes require a new measurement window or later adapter version rather
  than an incomparable blended rate.
- The App needs broader read visibility than a checks-only poller, including
  Administration read for ruleset-change notifications, but gains no write
  authority.
- Classic branch protection, merge queues, fork contributions, and changing
  rule populations remain unsupported in v1 and produce `unable`.
- `frostyard/fluent` and `frostyard/core` need enforced rulesets before the
  representative reliability Goal can yield a non-empty result.

## Alternatives considered

- **Declare check selectors in Core:** rejected because Core could call checks
  required while GitHub does not enforce them, creating two canonical sources.
- **Use current GitHub rules retrospectively:** rejected because current rules
  do not prove which rules applied during an earlier merge.
- **Measure all returned check runs:** rejected because optional runs and source
  gaps would make both numerator and denominator depend on incidental output.
- **Accept any-source required checks:** rejected in v1 because a matching name
  alone does not bind the producer whose result GitHub was intended to trust.
- **Blend rule revisions in one window:** rejected because a rate over changing
  expected populations is harder to explain and can conceal a weakening rule
  change.
- **Treat merge queues and forks as ordinary pull requests:** rejected because
  GitHub evaluates different revisions and repository associations for those
  paths.

## References

- Shapes:
  [success-measure verification](../design/success-measure-verification.md) and
  [product foundation roadmap](../plans/product-foundation-roadmap.md)
- Builds on:
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md),
  [ADR-0023](0023-base-ci-maintenance-on-observed-runs.md),
  [ADR-0031](0031-separate-delivery-from-outcome-achievement.md),
  [ADR-0054](0054-bind-success-measures-to-versioned-verification-profiles.md),
  and
  [ADR-0055](0055-separate-evidence-population-from-rate-evaluation.md)
