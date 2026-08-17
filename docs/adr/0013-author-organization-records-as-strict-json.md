# 0013 — Author organization records as strict JSON

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

ADRs [0007](0007-use-frostyard-core-as-the-organization-authority.md) through
[0012](0012-version-criteria-and-preserve-assessment-truth.md) define five
organization record kinds and their semantics, but not their repository
layout or serialization.

The current `frostyard/core` repository already treats machine-readable
governance, explicit schema versions, deny-by-default behavior, and CI
validation as organization conventions. It is also intentionally lightweight:
there is no application runtime, and its existing documentation gate is a
small Node script. The record contract should fit that role without coupling
core to Fluent or requiring a model to parse prose.

Core's existing governance decision also rejects central-only policy because
repository CI needs local, repository-specific enforcement. Organization
records must complement that layer rather than overwrite it. Core's current
repository-boundary prose excludes anything specific to one repository, while
its portfolio plan already maps individual repositories and the exception
model requires narrow scopes. That boundary needs an explicit core-side ADR
when this contract is implemented; this Fluent ADR does not silently amend it.

Markdown with YAML frontmatter is pleasant to read, but robust YAML and
frontmatter parsing would add ambiguity and dependencies at every consumer.
Hand-writing a partial parser to preserve a nominally dependency-free gate
would be worse. The authoritative representation needs strict parsing,
portable schemas, editor support, and identical validation across core and
Fluent.

## Decision

Organization records live in this tool-neutral tree in `frostyard/core`:

```text
organization/
  README.md
  schemas/v1/
    envelope.schema.json
    goal.schema.json
    policy.schema.json
    knowledge.schema.json
    criteria-set.schema.json
    exception.schema.json
  goals/<id>.json
  policies/<id>.json
  knowledge/<id>.json
  criteria/<set-id>/<version>.json
  exceptions/<id>.json
```

The five record directories contain strict UTF-8 JSON, not JSONC, YAML, or
Markdown frontmatter. `README.md` explains authoring but is not a record.
Generated human-readable indexes may be added later; they are derived views
and cannot become another source of truth.

Every record has this common top-level shape:

```json
{
  "schema_version": 1,
  "kind": "goal",
  "metadata": {
    "id": "improve-ci-reliability-2026-q4",
    "status": "active",
    "owners": ["frostyard-maintainers"],
    "applies_to": {}
  },
  "spec": {}
}
```

`kind` is exactly `goal`, `policy`, `knowledge`, `criteria-set`, or
`exception`. The common envelope owns identity, lifecycle, ownership, and
applicability; each kind's schema owns its `spec`. IDs and path components are
lowercase kebab-case. For all kinds except criteria sets, the filename stem
must equal `metadata.id`. A criteria-set path, ID, and version must agree.
Cross-record references are structured objects containing kind, ID, and any
required version or sub-requirement identifier, not strings with an
application-specific parsing convention.

The tree contains organization-governed context, which may apply to the whole
organization, a class of repositories, or one repository when organization
approval is the point of the record. Repository-local implementation details
and enforcement policies remain in the repository they govern. Fluent combines
organization and repository constraints monotonically: either layer may be
stricter, and neither central records nor synchronization may overwrite the
repository's local policy files.

Schemas use JSON Schema Draft 2020-12. All object schemas reject unknown
properties. A schema version directory is immutable after acceptance; a
semantic schema change creates `schemas/v2/` and requires consumer support
before v2 records may be activated. V1 records cannot redefine or point to an
alternate schema.

Validation rejects duplicate JSON object keys, invalid UTF-8, non-regular
files, symlinks in the organization tree, unknown files in record directories,
unknown schema versions or kinds, path/identity disagreement, duplicate record
identities, unresolved references, invalid lifecycle transitions, and
cross-record violations such as an exception with broader applicability than
its target. Size, nesting, collection, and string limits are part of each
versioned schema and validator, not unbounded parser behavior.

Core exposes one canonical validation command,
`node scripts/check-organization.mjs`, and runs it in CI. The implementation
uses a pinned, standards-conforming JSON Schema library recorded in a lockfile;
it does not implement a partial schema engine. Core and Fluent share a corpus
of valid and invalid conformance fixtures so their independent validators
cannot drift silently. Fluent never executes the core validation script during
import.

## Consequences

- Organization context has one greppable, diffable, machine-safe source format
  independent of Fluent, Claude, Codex, or another agent product.
- Authors trade Markdown ergonomics for strict parsing and reliable validation.
  Pretty-printed JSON, schemas, editor completion, and generated views mitigate
  that cost.
- Fixed directories remove the need for a hand-maintained manifest and make
  missing or unexpected records detectable by traversal.
- Central records do not replace repository-local policy enforcement; Fluent
  and repository CI can consume the organization rule while retaining stricter
  local constraints.
- Immutable schema directories prevent a v1 schema edit from silently changing
  the meaning of existing records.
- Implementing this tree requires a `frostyard/core` ADR that intentionally
  expands its repository boundary to organization-governed, repository-scoped
  records.
- Core gains a pinned validation dependency and lockfile, but not an
  application service or runtime.
- Exact per-kind fields, schema limits, fixtures, and lifecycle transition
  tables must land with the validator implementation; they are not yet live.

## Alternatives considered

- **Markdown with YAML frontmatter:** rejected because YAML parsing and
  frontmatter extraction increase ambiguity across independent consumers.
- **JSON plus a hand-maintained Markdown companion for every record:** rejected
  because the two representations would drift. Human views should be
  generated.
- **One catalog JSON file:** rejected because unrelated changes would collide,
  reviews would be noisy, and one syntax error would make editing harder.
- **A required manifest listing every record:** rejected because the fixed tree
  is already enumerable and a second list creates drift without adding
  integrity; Git supplies content identity.
- **Put records under `.fluent/`:** rejected because organization direction is
  reusable authority, not Fluent configuration.
- **Make core policy the only repository policy:** rejected because local CI
  and tools need repository-owned enforcement, and a central sync must not
  erase stricter local rules.
- **Use a bespoke zero-dependency schema validator:** rejected because a
  partial JSON Schema implementation would create a deceptive compatibility
  surface and security boundary.

## References

- Defines the authoring surface for the five kinds in
  [ADR-0008](0008-use-five-organization-record-kinds.md), with semantics from
  [ADR-0009](0009-apply-goals-through-discovery-and-admission.md),
  [ADR-0010](0010-enforce-policies-monotonically-with-expiring-exceptions.md),
  [ADR-0011](0011-treat-knowledge-as-reviewed-advisory-evidence.md), and
  [ADR-0012](0012-version-criteria-and-preserve-assessment-truth.md)
- Builds on the core authority and revision rules in
  [ADR-0007](0007-use-frostyard-core-as-the-organization-authority.md)
- Preserves the local-policy boundary from
  [core ADR-0019](https://github.com/frostyard/core/blob/main/docs/adr/0019-governance-as-code-and-risk-tiers.md)
- Format standard: [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
- Product: [maintenance fleet PRD](../prd/agent-fleet.md), especially
  [core authoring and snapshot import](../prd/agent-fleet.md#core-authoring-and-snapshot-import)
- Goal import contract: [Goal ingestion](../specs/goal-ingestion.md)
