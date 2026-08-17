# Success-measure verification

Living document. Rationale:
[ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md) and
[ADR-0054](../adr/0054-bind-success-measures-to-versioned-verification-profiles.md).
Current contract:
[verification-profile ingestion](../specs/verification-profile-ingestion.md)
and [Goal ingestion](../specs/goal-ingestion.md).

## Overview

Success-measure verification connects reviewed outcome intent in Core to
versioned executable mechanisms in Fluent without executing repository-authored
code or treating a model verdict as authority. The implemented foundation
imports and retains profile definitions and validates Goal fixtures, references,
parameters, and lifecycle rules. Mechanism implementations, Goal application,
evidence collection, evaluation, attestation, and aggregation remain later
delivery work.

```text
Core profile + measure declaration
          │ strict snapshot validation and exact retention
          ▼
profile resolution + parameter validation          (Goal import implemented)
          │ closed Fluent mechanism registry
          ▼
trusted observations / deterministic facts / attestation
          │ versioned evaluation and evidence retention
          ▼
criterion fact ──► slice state ──► initiative outcome projection
```

## Design

### Authority split

| Concern | Owner |
| --- | --- |
| Goal, initiative, and success-measure intent | Reviewed Core records |
| Profile identity, mode, mechanism contract, and parameter schema | Immutable Core verification profile |
| Adapter/evaluator/attestation-policy implementation | Closed versioned Fluent registry |
| External source truth | Registered source adapter and source-native revision |
| Verification result and retained evidence | Fluent predicate contract and facts |
| Goal lifecycle change | Reviewed Core change, never inferred from a result |

A profile is not an organization record and has no lifecycle or applicability.
It becomes relevant only through an accepted measure reference. A declaration
repeats `evidence_mode`; resolution requires it to equal the profile's mode.
The profile and parameter object together own the decision rule, leaving no
second expression for consumers to reconcile.

### Implemented import boundary

[`validator.ts`](../../src/core/validator.ts) supports the legacy Core catalog
and the profile-capable extension. The extension pins the exact Core schema
bytes and independently enforces canonical profile paths, strict JSON, profile
size, evidence-mode/mechanism agreement, canonical embedded schema identity,
closed parameters, local-only references, and strict Draft 2020-12 compilation.
Its positive and rejection fixtures pass through the same path as live data.

Validated live profiles are carried in the candidate report and retained as
raw snapshot files. New snapshot definitions include the profile count and
optional profile-schema digest; old definition records remain valid. Automatic
activation can add the extension but cannot remove its schema or remove or
change any historically activated profile version. That history check still
applies after rollback. Operator rollback retains its existing ability to
select an exact older snapshot through an attributed decision.

This compatibility path is intentionally asymmetric:

```text
legacy active ──automatic──► profile-capable candidate     allowed
profile active ──automatic──► legacy/changed candidate     rejected
profile active ──operator rollback──► retained legacy      allowed
```

### Measure resolution

The Goal candidate validator now resolves each live measure against the same
candidate before activation. A future delivery-plan validator will perform the
same resolution before a plan can influence verification. A
measure contains a stable local ID, required/optional designation, repeated
evidence mode, typed subject, absolute start/end instants, exact profile ID and
version, and parameters. Resolution fails when the profile is absent, the mode
differs, parameters fail its embedded schema, the subject kind is unsupported,
the window is invalid, or any named mechanism version is absent from Fluent's
closed registry. That registry currently has no implementations, so the merged
fixture-only Goal contract validates while a live Goal fails closed.

Profiles may be published before they are referenced. Publication alone does
not claim executable support, create a controller timer, collect observations,
or make work eligible.

### Evidence and evaluation

A deterministic evaluator consumes only registered trusted facts and records
the exact predicate and mechanism versions, subject revisions, inputs, and
result. An observational profile additionally names a trusted-source adapter;
the controller owns its absolute window, source gaps, baseline, threshold, and
confounding evidence without holding a worker lease. A human-attested profile
routes a typed decision to an authorized named principal and retains the
subject, evidence, rationale, decision, and time.

Each evaluation produces a conclusive satisfied or failed result, or `unable`
when required evidence is missing, unavailable, unsupported, or materially
confounded. A capable worker may propose or critique evidence but cannot write
the verification fact. Aggregation preserves every criterion result and follows
ADR-0031; it never converts merge count or elapsed time into outcome success.

## Operational notes

- Deploy Goal-capable Fluent before publishing the first live Goal in Core.
- A candidate rejection naming the profile schema digest indicates producer/
  consumer byte drift, not a retryable source outage.
- A profile fixture failure rejects the complete candidate and leaves the last
  active snapshot authoritative.
- Imported profiles currently have no execution surface. Goal fixtures prove
  the contract, but a live Goal cannot activate until its closed mechanism
  implementations land.
- Keep old retained snapshots and profile bytes available for rollback and
  historical evidence explanation.

## References

- Rationale:
  [ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md) and
  [ADR-0054](../adr/0054-bind-success-measures-to-versioned-verification-profiles.md)
- Contracts:
  [verification-profile ingestion](../specs/verification-profile-ingestion.md),
  [Goal ingestion](../specs/goal-ingestion.md), and
  [Core snapshot verification](../specs/core-snapshot-verification.md)
- Built in:
  [product foundation roadmap — Phases 2 and 9](../plans/product-foundation-roadmap.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md)
