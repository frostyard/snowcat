# 0054 — Bind success measures to versioned verification profiles

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

ADR-0031 requires every slice acceptance criterion and initiative success
measure to use deterministic, observational, or human-attested evidence. It
leaves the versioned evaluator interface open. The goal contract cannot be
called executable while a reviewer or model still has to interpret a prose
decision rule, invent a query, choose a source, or decide what counts as enough
evidence.

Core owns reviewed organization intent, while Fluent owns executable adapters
and control-plane facts. Embedding scripts, provider queries, or a generic
metrics expression language in Core would move executable code across that
boundary. Baking every decision rule into the goal schema would instead make
ordinary measurement growth require a new goal-schema version.

Core PR #81 defines a reusable verification-profile contract with immutable
identity, one evidence mode, versioned mechanism bindings, and an embedded
closed parameter schema. Fluent needs to adopt that contract without making
current three-schema Core snapshots invalid during rollout.

## Decision

Every v1 success measure and acceptance criterion binds one exact versioned
verification profile. The declaration repeats the profile's evidence mode,
names one typed source-native subject, supplies an absolute observation window,
and provides parameters that validate against the profile's embedded schema.
The repeated evidence mode MUST match the profile. The profile version plus its
validated parameters is the executable decision rule; v1 has no additional
free-form rule, script, query, or expression field.

A representative future measure has this conceptual shape; the goal schema
will pin its exact placement:

```json
{
  "id": "required-checks-stay-reliable",
  "required": true,
  "evidence_mode": "observational",
  "subject": {
    "kind": "github-repository",
    "id": "github.com:1331309458"
  },
  "observation_window": {
    "starts_at": "2026-10-01T00:00:00.000Z",
    "ends_at": "2026-10-31T23:59:59.999Z"
  },
  "verification_profile": {
    "id": "required-check-reliability",
    "version": 1
  },
  "parameters": {
    "minimum_rate": 0.95
  }
}
```

A verification profile is reusable contract infrastructure, not a sixth
organization record, policy, fact, goal, or grant. Core reviews and publishes
profiles at their canonical versioned paths. Fluent independently bundles the
exact profile schema, validates every profile and conformance fixture, and
retains the exact bytes and digest in the Core snapshot. Fluent never executes
Core code or loads a remote schema dependency.

Fluent owns a closed registry of versioned source adapters, evaluators, and
attestation policies. Before activating a goal, initiative, plan, or criterion
that references a profile, Fluent MUST recognize every binding and validate
the measure parameters. Merely importing an unreferenced profile grants no
authority and does not run its mechanisms. Adding a Core profile and adding a
Fluent implementation are distinct reviewed changes.

The rollout is backward compatible. Fluent accepts legacy Core snapshots that
contain the original three schemas only. A profile path or profile fixture is
invalid unless the exact supported profile schema is also present. Once a
profile-capable snapshot has ever been activated, automatic forward activation
MUST retain the profile schema and every historically activated profile version
byte-for-byte, even after an operator rollback. An attributed operator rollback
MAY select a retained older legacy snapshot; the rollback is an explicit
authority act rather than silent contract removal.

The current implementation stops at independent snapshot validation and
retention. It does not yet activate goals, execute profile mechanisms, collect
measurement evidence, or establish outcome facts.

## Consequences

- Every accepted v1 measure can be checked by a named implementation rather
  than interpreted from prose.
- The evidence mode remains obvious in a goal diff while the profile remains
  the single owner of mechanism semantics; mismatch fails closed.
- Core can add immutable profiles without changing the goal schema, but a
  referenced profile cannot become active before Fluent supports its bindings.
- Historical snapshots preserve the exact contract and parameters behind a
  result.
- The compatibility window adds an intentional two-shape import path until the
  profile contract is established in Core history.
- Authors cannot express arbitrary one-off metrics; a missing mechanism needs
  a reviewed profile and implementation or an authorized human-attested mode.

## Alternatives considered

- **Embed a generic expression language:** rejected because it creates an
  executable trust boundary and a second language to secure and version.
- **Store a prose decision rule:** rejected because it is not executable and a
  model interpretation cannot establish authoritative success.
- **Put source queries directly in goals:** rejected because provider syntax
  and credentials belong to Fluent adapters, not organization intent.
- **Infer evidence mode from the profile only:** rejected because reviewers
  need the mode visible at the measure and an exact-match check catches drift.
- **Require the new schema immediately:** rejected because deploying Core first
  or Fluent first would otherwise create a deterministic outage window.

## References

- Shapes: [success-measure verification](../design/success-measure-verification.md),
  [verification-profile ingestion](../specs/verification-profile-ingestion.md),
  [Goal ingestion](../specs/goal-ingestion.md),
  and [product foundation roadmap](../plans/product-foundation-roadmap.md)
- Builds on: [ADR-0004](0004-keep-models-outside-the-control-path.md),
  [ADR-0009](0009-apply-goals-through-discovery-and-admission.md),
  [ADR-0014](0014-import-core-as-atomic-validated-snapshots.md),
  [ADR-0031](0031-separate-delivery-from-outcome-achievement.md), and
  [ADR-0039](0039-use-typed-source-native-subject-identities.md)
- Producer contract:
  [Core ADR-0036](https://github.com/frostyard/core/blob/main/docs/adr/0036-publish-versioned-verification-profiles.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md)
