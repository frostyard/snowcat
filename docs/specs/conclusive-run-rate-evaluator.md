# Spec: Conclusive-run-rate evaluator

This contract governs the callable `conclusive-run-rate:v1` verification
evaluator in Fluent's closed mechanism registry. The evaluator consumes a
source-adapter-produced evidence population; it does not acquire or classify
raw source data.

## Interface

The evaluator accepts this in-memory input:

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `minimumRate` | number | yes | finite, inclusive range `0..1` |
| `windowState` | `open` \| `closed` | yes | only `closed` can produce a rate |
| `sourceCoverage` | `complete` \| `incomplete` | yes | only `complete` can produce a rate |
| `occurrences` | array | yes | unique bounded keys and registered classifications |
| `occurrences[].key` | string | yes | 1–512 code units; no control characters |
| `occurrences[].classification` | `conclusive` \| `inconclusive` \| `missing` | yes | supplied by the registered source adapter |

It returns:

```json
{
  "outcome": "satisfied",
  "reason": "threshold-met",
  "minimumRate": 0.95,
  "counts": {
    "conclusive": 19,
    "inconclusive": 0,
    "missing": 1,
    "total": 20
  },
  "rate": { "numerator": 19, "denominator": 20 }
}
```

`outcome` is `satisfied`, `failed`, or `unable`. `reason` is exactly one of
`threshold-met`, `threshold-not-met`, `window-open`, `source-incomplete`, or
`population-empty`. `rate` is `null` for `unable`; otherwise it retains the
integer ratio used for the decision.

## Rules

1. Every occurrence MUST contribute exactly once to `counts.total`.
   `conclusive` contributes to the numerator; `inconclusive` and `missing` do
   not.
2. With a closed window, complete coverage, and non-empty population, the
   evaluator MUST return `satisfied` when the exact integer ratio is at least
   `minimumRate`; otherwise it MUST return `failed`.
3. Comparison MUST use the canonical numeric threshold as a rational value and
   MUST NOT depend on a rounded display percentage.
4. An open window, incomplete source coverage, or empty population MUST return
   `unable` with `rate: null`.
5. A malformed field, unregistered classification, invalid key, or duplicate
   key MUST throw `VerificationMechanismInputError`. Contract-invalid input is
   not an outcome about the measured subject.
6. The closed registry MUST resolve `conclusive-run-rate:v1` to this callable
   implementation. It MUST NOT report support for `github-check-runs:v1` until
   that adapter has its own implemented source contract.
7. This evaluator MUST NOT perform network access, parse raw GitHub payloads,
   retain evidence, establish a fact, aggregate a Goal, or mutate lifecycle.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| Mechanism support result | Presence of the actual callable under exact key `conclusive-run-rate:v1` |
| Bounded rate result | Validated population counts plus exact threshold comparison |
| Focused conformance tests | Threshold boundary, missing denominator, unable states, registry support, and malformed populations |

## References

- Rationale:
  [ADR-0055](../adr/0055-separate-evidence-population-from-rate-evaluation.md)
- Context:
  [success-measure verification](../design/success-measure-verification.md)
- Delivery:
  [product foundation roadmap — Phases 4 and 9](../plans/product-foundation-roadmap.md)
- Adjacent contracts:
  [verification-profile ingestion](verification-profile-ingestion.md) and
  [Goal ingestion](goal-ingestion.md)
