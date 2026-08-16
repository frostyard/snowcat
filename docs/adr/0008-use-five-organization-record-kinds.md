# 0008 — Use five organization record kinds

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

[ADR-0007](0007-use-frostyard-core-as-the-organization-authority.md)
established `frostyard/core` as the Git-backed authority for accepted
organization context, while deliberately leaving its record contract open.
Without a small taxonomy, Fluent cannot distinguish direction that affects
priority from mandatory constraints, advisory knowledge, assessment criteria,
or approved departures. Treating all of those as generic Markdown would force
workers or models to infer their authority.

The opposite extreme is also harmful: converting every vision document,
meeting note, design exploration, or plan into a machine record would add
schema ceremony without making the control path safer.

## Decision

V1 recognizes five structured organization record kinds in `frostyard/core`:

- **Goal:** a scoped, normally time-bounded outcome that may influence work
  discovery and priority. A goal does not authorize actions or admit work.
- **Policy:** a mandatory constraint for its declared scope. Organization
  standards that govern repository behavior are policies rather than a sixth
  record kind.
- **Knowledge:** reviewed, attributable guidance or a factual claim. It informs
  a worker but is not mandatory merely because it has been accepted.
- **Criteria set:** an immutable, versioned assessment contract such as a
  Frostyard ACMM release. An assessment identifies the exact criteria version
  it applied.
- **Exception:** an approved, scoped, time-bounded departure from a named
  policy or criteria requirement. It records an owner and expiry; it does not
  silently alter the underlying record.

All five kinds share a machine-readable envelope with a schema version, stable
identifier, lifecycle status, owner, and applicability. Each kind then has a
separate validated body appropriate to its semantics. Exact fields and file
paths belong in the future organization-context specification.

Broad vision, meeting notes, exploratory designs, and ordinary plans remain
reviewed documentation unless Fluent needs deterministic applicability or
lifecycle semantics from them. They may motivate goals, but Fluent does not
interpret their prose as an instruction.

Every consumed record remains pinned to the `frostyard/core` Git revision
required by ADR-0007. Loading a record never creates, admits, or authorizes a
work item; those remain deterministic queue operations.

## Consequences

- Fluent can present context with explicit semantics instead of asking a model
  to infer whether text is mandatory, advisory, or merely aspirational.
- Organization standards use `policy`, while measurable maturity requirements
  use `criteria set`; authors must choose which behavior they intend.
- Goals may affect ranking, but cannot become a back door around operator
  admission or action ceilings.
- Knowledge can evolve through review without accidentally becoming policy.
- Exceptions are visible, attributable, and expiring instead of being buried
  in repository-specific prose.
- Schema validation, precedence, lifecycle transitions, and authoring workflow
  still require a design and specification before implementation.

## Alternatives considered

- **One generic organization-record kind:** rejected because its consumers
  would have to infer authority and behavior from prose.
- **A separate `standard` kind:** rejected for v1 because standards that impose
  requirements have policy semantics, while measurable conformance belongs in
  a criteria set.
- **A structured `vision` kind:** deferred because broad vision does not need to
  drive deterministic behavior. A later ADR may add it if a concrete use case
  cannot be represented by goals.
- **No structured knowledge:** rejected because workers need reviewed,
  attributable guidance that is useful without being mandatory.
- **Permanent exceptions:** rejected because deviations without an expiry or
  review point quietly become policy while bypassing the policy review path.

## References

- Defines the record taxonomy for
  [ADR-0007](0007-use-frostyard-core-as-the-organization-authority.md)
- Preserves deterministic authority from
  [ADR-0004](0004-keep-models-outside-the-control-path.md) and operator
  admission from
  [ADR-0005](0005-admit-worker-created-work-before-claiming.md)
- Product: [maintenance fleet PRD](../prd/agent-fleet.md), especially
  [organization direction, knowledge, and readiness](../prd/agent-fleet.md#organization-direction-knowledge-and-readiness)
- Implementation design, contract, and delivery plan: not yet authored
