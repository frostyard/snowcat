# 0055 — Separate evidence population from rate evaluation

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

ADR-0054 requires a closed Fluent implementation for every source adapter and
evaluator referenced by a live verification profile. The first proposed
observational profile pairs `github-check-runs:v1` with
`conclusive-run-rate:v1`, but GitHub exposes check runs for an exact Git
reference rather than a repository-wide observation window. Returned runs also
have pagination, rerun, app-identity, and fork limitations. Treating whatever a
single API request returned as the denominator would make missing checks improve
the reported rate.

The arithmetic evaluator does not need to know GitHub's payloads or make those
source-selection choices. Combining source acquisition, population selection,
normalization, and threshold evaluation in one implementation would make the
result difficult to explain and would allow source incompleteness to be
mistaken for a failed threshold.

## Decision

A rate evaluator consumes a closed evidence population produced by its named
source adapter. The source adapter owns subject and revision resolution,
population selection, source pagination, duplicate and rerun handling,
source-native normalization, and a positive completeness assertion. The
evaluator owns only validation of that normalized population, exact rate
calculation, threshold comparison, and its bounded evaluation result.

`conclusive-run-rate:v1` counts every expected occurrence in the denominator.
An occurrence classified `conclusive` contributes to the numerator; an
`inconclusive` or `missing` occurrence does not. A missing expected occurrence
therefore lowers the rate instead of disappearing. An open observation window,
incomplete source coverage, or empty population produces `unable`, not
`satisfied` or `failed`. Malformed or duplicate occurrence keys violate the
mechanism contract and are rejected rather than converted into an outcome.

The evaluator returns the integer numerator and denominator that determined
the result. It compares that ratio to `minimum_rate` without rounding a
displayed percentage. It does not classify raw GitHub conclusions, perform
network access, retain evidence, establish a fact, or change Goal lifecycle.

Fluent registers a mechanism version only when its registry entry contains the
actual callable implementation. This slice registers
`conclusive-run-rate:v1`. It deliberately leaves `github-check-runs:v1`
unsupported until the GitHub observation contract defines and implements its
population and completeness semantics. Consequently, the representative live
Goal remains fail-closed at activation.

## Consequences

- Source gaps cannot silently improve a measured rate.
- The same rate evaluator can consume another adapter's closed population
  without learning that source's payload format.
- An operator can distinguish a threshold failure from an inability to obtain
  complete evidence.
- GitHub-specific classification and population choices remain unresolved and
  cannot accidentally become authority through the generic evaluator.
- A profile needs both implemented halves before a live Goal can activate, so
  landing the evaluator alone intentionally does not unlock measurement.

## Alternatives considered

- **Evaluate every returned GitHub check run:** rejected because absent runs,
  truncated pagination, and selector drift would shrink the denominator.
- **Treat incomplete source coverage as a failed rate:** rejected because an
  outage is not evidence that the measured outcome failed.
- **Register the adapter name before its controller exists:** rejected because
  registry membership is an executable-support claim, not a roadmap marker.
- **Put GitHub status classification in the rate evaluator:** rejected because
  it would couple source semantics to otherwise source-independent arithmetic.

## References

- Shapes:
  [success-measure verification](../design/success-measure-verification.md),
  [conclusive-run-rate evaluator](../specs/conclusive-run-rate-evaluator.md),
  and [product foundation roadmap](../plans/product-foundation-roadmap.md)
- Builds on:
  [ADR-0023](0023-base-ci-maintenance-on-observed-runs.md),
  [ADR-0031](0031-separate-delivery-from-outcome-achievement.md), and
  [ADR-0054](0054-bind-success-measures-to-versioned-verification-profiles.md)
