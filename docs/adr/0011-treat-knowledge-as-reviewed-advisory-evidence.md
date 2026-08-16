# 0011 — Treat knowledge as reviewed advisory evidence

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

Workers need to reuse lessons, repository facts, and proven implementation
patterns instead of rediscovering them in every run. [ADR-0008](0008-use-five-organization-record-kinds.md)
therefore includes accepted knowledge as an organization record kind.

Knowledge ages and can be contradicted. A worker report can also sound
plausible while relying on invalid evidence, as the first Fluent spike showed.
A numeric confidence score would conceal those distinctions, and placing every
accepted record into every prompt would burn context without improving work.

Knowledge must remain advisory. If accepting a knowledge record could change
authorization, admission, policy compliance, or queue priority, it would
bypass the more accountable record types and control paths created for those
decisions.

## Decision

An accepted knowledge record declares a stable identifier, owner,
applicability, concise claim or guidance, supporting basis, known limitations,
lifecycle, review date, and `review_after` date. Each material basis entry
identifies its source and whether it is merely reported or independently
verified. Fluent does not collapse that provenance into a scalar confidence
score.

Knowledge lifecycle states are `active`, `superseded`, and `retracted`. An
active record whose `review_after` date has passed becomes stale: it remains
searchable and historically citeable, but Fluent excludes it from default
worker context and labels it as requiring review. Superseded and retracted
records remain in history but are not eligible for default context.

Initial retrieval is deterministic and bounded. Fluent filters by declared
repository, language, component, maintenance kind, and other validated
applicability metadata, then uses exact metadata or full-text matching. Results
carry the stable record identity and exact `frostyard/core` revision. Optional
semantic or model-assisted search may suggest additional records later, but it
cannot change lifecycle, verification state, or authority and must preserve the
same citations.

Discovery work may receive a bounded set of applicable active knowledge.
Execution work receives only the records linked during admission and may query
for more explicitly. Context projection never substitutes a generated summary
for the cited source snapshot; summaries are presentation aids only.

Workers may propose new knowledge, corrections, supersession, or retraction as
bounded work with sources and limitations. The proposal is not accepted
knowledge until the authorized `frostyard/core` review path merges it. Fluent
retains the originating work and evidence in its provenance.

Knowledge may explain or support work, but it cannot authorize an action,
admit or prioritize work, waive a policy, satisfy a verifier by itself, or
change a readiness result. Conflicting active records are surfaced together
for review; a model does not silently choose one as true.

## Consequences

- Workers receive reusable, attributable guidance without confusing advice
  with mandatory policy.
- Source and verification state remain visible instead of being obscured by a
  confidence percentage.
- Review dates prevent old implementation advice from remaining evergreen by
  accident while preserving historical traceability.
- Bounded applicability-based retrieval controls token use and can operate
  without an embedding model.
- Worker discoveries can improve the organization knowledge base through the
  same reviewable Git workflow as other accepted context.
- Fluent needs schemas, deterministic indexing, stale-state presentation,
  conflict discovery, and a contribution workflow. None is implemented yet.

## Alternatives considered

- **Store all worker observations directly as knowledge:** rejected because
  provenance is not verification and plausible reports can be wrong.
- **Assign every record a numeric confidence score:** rejected because one
  number hides source quality, independent verification, age, and limitations.
- **Put every active record into every worker prompt:** rejected because it
  wastes context and makes irrelevant guidance harder to distinguish.
- **Require semantic search from the start:** rejected because metadata and
  full-text retrieval are deterministic, inexpensive, and sufficient for the
  first self-hosted version.
- **Allow knowledge to act as lightweight policy:** rejected because it would
  create an ambiguous and less reviewed authority path.
- **Delete retracted or stale knowledge:** rejected because historical work
  must retain the context and evidence it used.

## References

- Defines knowledge semantics for
  [ADR-0008](0008-use-five-organization-record-kinds.md) and uses the revisioned
  source of authority in
  [ADR-0007](0007-use-frostyard-core-as-the-organization-authority.md)
- Preserves the evidence boundary in
  [ADR-0004](0004-keep-models-outside-the-control-path.md)
- Product: [maintenance fleet PRD](../prd/agent-fleet.md), especially
  [shared knowledge](../prd/agent-fleet.md#shared-knowledge)
- Implementation design, contract, and delivery plan: not yet authored
