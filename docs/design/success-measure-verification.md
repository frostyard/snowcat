# Success-measure verification

Living document. Rationale:
[ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md) and
[ADR-0054](../adr/0054-bind-success-measures-to-versioned-verification-profiles.md),
with evidence-population boundaries from
[ADR-0055](../adr/0055-separate-evidence-population-from-rate-evaluation.md)
and enforced-check authority from
[ADR-0056](../adr/0056-derive-required-checks-from-enforced-github-rules.md),
with webhook and reconciliation coverage from
[ADR-0057](../adr/0057-require-webhook-ingress-for-github-observation.md).
Current contract:
[verification-profile ingestion](../specs/verification-profile-ingestion.md),
[Goal ingestion](../specs/goal-ingestion.md), and the first executable
[conclusive-run-rate evaluator](../specs/conclusive-run-rate-evaluator.md).

## Overview

Success-measure verification connects reviewed outcome intent in Core to
versioned executable mechanisms in Fluent without executing repository-authored
code or treating a model verdict as authority. The implemented foundation
imports and retains profile definitions, validates Goal fixtures, references,
parameters, and lifecycle rules, and exposes one pure registered evaluator.
Goal application, source adapters, evidence retention, fact establishment,
attestation, and aggregation remain later delivery work.

```text
Core profile + measure declaration
          │ strict snapshot validation and exact retention
          ▼
profile resolution + parameter validation          (Goal import implemented)
          │ closed Fluent mechanism registry       (first evaluator implemented)
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
closed registry. That registry currently contains
`conclusive-run-rate:v1` but not the required
`github-required-checks:v1` source adapter, so the merged fixture-only Goal
contract validates while the representative live Goal still fails closed. The
earlier `github-check-runs:v1` placeholder will not be registered because raw
check runs do not establish the enforced population.

Profiles may be published before they are referenced. Publication alone does
not claim executable support, create a controller timer, collect observations,
or make work eligible.

### Evidence population and evaluation

A deterministic evaluator consumes only registered trusted facts and records
the exact predicate and mechanism versions, subject revisions, inputs, and
result. An observational profile additionally names a trusted-source adapter;
the controller owns its absolute window, source gaps, baseline, threshold, and
confounding evidence without holding a worker lease. A human-attested profile
routes a typed decision to an authorized named principal and retains the
subject, evidence, rationale, decision, and time.

ADR-0055 requires a source adapter to produce a closed evidence population
independently of the evaluator. Missing expected occurrences remain in that
population; source incompleteness cannot shrink the denominator. The implemented
`conclusive-run-rate:v1` evaluator validates unique keys and classifications,
counts `conclusive` occurrences over the full population, and compares the
integer ratio to the declared threshold without rounded display arithmetic. An
open window, incomplete coverage, or empty population returns `unable`.

The evaluator deliberately does not decide which GitHub commits or enforced
required checks belong in the population, how reruns or duplicate names
collapse, or which GitHub conclusions are conclusive. Those are versioned
`github-required-checks:v1` adapter semantics and remain unsupported. GitHub's
API lists check runs for an exact ref, may cap a ref query at runs associated
with the 1,000 most recent check suites, and can return incomplete fork
associations; registering the adapter before those boundaries are implemented
would make an unsupported claim.

### Enforced GitHub required-check population

ADR-0056 resolves the source choice: GitHub's active rulesets, not a duplicated
Core selector list, own which checks are required. A measurement window starts
only after Fluent retains a non-empty, integration-bound ruleset baseline for
the observed default branch. The branch and normalized selector set remain
fixed through the half-open window. Any observed drift, source gap, or
unsupported rule shape makes the population incomplete.

The qualifying change population contains pull requests merged during that
window into the retained default branch. Fluent also reconciles every update to
that branch; a direct or bypass update that cannot be attributed to exactly one
qualifying pull request prevents completeness. For each qualifying pull
request, the controller must already have the required-check revision GitHub
actually evaluated. GitHub may require the latest head commit or a test merge
commit, so the final merge commit is not a safe substitute.

One expected occurrence is the pair of one qualifying pull request and one
enforced selector. Check runs and commit statuses with the same required name
are evidence inside that occurrence rather than extra denominator rows. A
terminal failure may be conclusive evidence of CI behavior while separately
establishing a bypass or enforcement problem; the rate evaluator does not erase
the raw conclusion or establish policy compliance.

V1 supports only a stable active ruleset on the default branch, selectors bound
to exact integration IDs, non-fork pull requests, and non-merge-queue changes.
Classic protection, “any source” selectors, merge queues, forks, rule drift,
unresolved check revisions, conflicting source records, and incomplete
pagination return `unable`. This is intentionally narrower than GitHub's full
feature set.

Collection uses the separate read-only GitHub App and the
[GitHub observation boundary](github-observation.md). Authenticated webhook
ingress retains transient pre-merge state; fully paginated polling reconciles
current state and audits recent delivery GUIDs. A GitHub delivery receipt is
transport provenance rather than an observation or coverage proof. Only source
checkpoints plus uninterrupted or repaired delivery coverage may close a
window; a relevant source gap makes the population incomplete.

Each completed mechanism evaluation produces `satisfied`, `failed`, or
`unable`. A capable worker may propose or critique evidence but cannot write the
verification fact. The current evaluator returns a result only; evidence
retention and fact establishment are not yet implemented. Future aggregation
preserves every criterion result and follows ADR-0031; it never converts merge
count or elapsed time into outcome success.

## Operational notes

- Deploy Goal-capable Fluent before publishing the first live Goal in Core.
- A candidate rejection naming the profile schema digest indicates producer/
  consumer byte drift, not a retryable source outage.
- A profile fixture failure rejects the complete candidate and leaves the last
  active snapshot authoritative.
- The closed registry now resolves `conclusive-run-rate:v1` to real callable
  code. Goal fixtures prove the surrounding contract, but a live Goal cannot
  activate until its source adapter and every other referenced mechanism land.
- A required-check window cannot begin on a repository without an active,
  non-empty, integration-bound GitHub ruleset applying to its default branch.
  Operators configure and verify that boundary through the
  [required-check ruleset runbook](required-check-ruleset-operations.md).
- Keep old retained snapshots and profile bytes available for rollback and
  historical evidence explanation.

## References

- Rationale:
  [ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md) and
  [ADR-0054](../adr/0054-bind-success-measures-to-versioned-verification-profiles.md),
  with [ADR-0055](../adr/0055-separate-evidence-population-from-rate-evaluation.md)
  and [ADR-0056](../adr/0056-derive-required-checks-from-enforced-github-rules.md),
  plus [ADR-0057](../adr/0057-require-webhook-ingress-for-github-observation.md)
- Contracts:
  [verification-profile ingestion](../specs/verification-profile-ingestion.md),
  [Goal ingestion](../specs/goal-ingestion.md),
  [conclusive-run-rate evaluator](../specs/conclusive-run-rate-evaluator.md), and
  [Core snapshot verification](../specs/core-snapshot-verification.md)
- Built in:
  [product foundation roadmap — Phases 2 and 9](../plans/product-foundation-roadmap.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md)
- Operations:
  [enforced required-check rulesets](required-check-ruleset-operations.md)
- Source acquisition:
  [GitHub observation and reconciliation](github-observation.md)
- Source constraints:
  [GitHub check-runs API](https://docs.github.com/en/rest/checks/runs) and
  [GitHub protected-branch required checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
  [rules for a branch](https://docs.github.com/en/rest/repos/rules), and
  [required-check troubleshooting](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)
