# 0027 — Authorize feature planning from core PRDs

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

[ADR-0019](0019-include-feature-delivery-in-v1.md) commits v1 to accepting a
human-authorized PRD and coordinating ordered implementation work.
[ADR-0026](0026-coordinate-enrolled-repositories-with-fleetcontroller.md)
establishes core as the authority for cross-repository relationships and the
FleetController as the coordinator for common outcomes. The product still needs
one canonical intake path that distinguishes accepted product direction from a
model's interpretation of prose.

`frostyard/core` is the central organization planning repository, but its
current structure has no `docs/prd/` or `organization/` tree. Its current
repository boundary also says that anything specific to one repository belongs
there, while its portfolio plan already coordinates organization outcomes and
links repository-local implementation plans. Fleet-authorized product direction
therefore requires an explicit core boundary decision rather than an assumption
that the desired structure already exists.

A Markdown PRD is useful for human reasoning but unsuitable as a machine
authorization record. Parsing words such as “approved,” target names, or action
descriptions from prose would make ambiguous model or document interpretation
part of Fluent's control path. Replacing the PRD with JSON would make the
product definition needlessly hostile to human review.

## Decision

Every feature initiative that Fluent may plan has one canonical human-readable
PRD in `frostyard/core` at `docs/prd/<initiative-id>.md`. Repository-local PRDs
may exist for other workflows, but Fluent v1 does not treat them as fleet
delivery authority. A PRD is an organization planning artifact; detailed
repository implementation plans and resulting code remain in the repositories
they serve.

Each PRD is paired at the same core commit with one strict machine-readable
initiative declaration at
`organization/initiatives/<initiative-id>.json`, validated by
`organization/schemas/v1/initiative.schema.json`. The Markdown PRD is the
canonical product narrative. The JSON declaration is the canonical lifecycle,
target, ownership, and planning-authorization record. They are different
artifact types and MUST NOT duplicate each other's full content.

An initiative declaration contains at least:

- `schema_version` and stable `id` matching both paths;
- lifecycle state: `draft`, `approved-for-planning`, `paused`, `completed`, or
  `cancelled`;
- accountable owners and required planning approvers;
- the canonical PRD path and content digest;
- target repository slugs and immutable GitHub repository IDs;
- applicable goal references; and
- the selected feature-delivery program and any declaration-level narrowing of
  its planning scope.

Unknown fields are rejected. The PRD path must remain under `docs/prd/`, match
the initiative ID, and resolve to a regular Git blob in the same core tree. It
MUST NOT be a symlink, submodule, generated artifact, remote URL, mutable branch
reference, or path supplied by a worker. Fluent retains the exact core commit,
blob ID, raw bytes, digest, declaration, and validation report.

The canonical PRD template requires human-readable problem, desired outcomes,
users or beneficiaries, scope, non-goals, constraints, success measures,
affected repositories, risks, and unresolved questions. Core CI validates its
structure, size, path, declaration pairing, target identities, links, and
absence of known secret patterns. Structural validity does not prove that the
product direction is wise or complete.

A PR merged to core with lifecycle `approved-for-planning` is the attributed
human authorization for the FleetController to create one bounded read-only
planning root for that exact PRD revision when no equivalent active planning
lineage exists. It authorizes planning only. It does not admit implementation
slices, authorize GitHub mutation, override repository policy, or allow the
planning worker to approve its output.

Every target repository must be enrolled, identity-reconciled, not held, and
have feature delivery enabled before the planning root becomes eligible. A
failure holds only the initiative and exposes the affected target; it does not
invalidate the core snapshot or unrelated RepositoryControllers. `paused`,
`completed`, and `cancelled` prevent new planning and plan admission while
preserving history and without silently revoking already issued lease
capabilities.

PRD prose is accepted human direction but remains data when presented to a
worker. Text inside it cannot grant an action, raise priority, select a worker
principal, change target repositories, weaken policy, or issue instructions
outside the bounded planning role. Machine authority comes only from the
validated declaration, effective policy, and later attributed plan admission.

Changing the PRD or declaration creates a new source revision. Existing work
retains its original PRD snapshot. A new revision MUST NOT silently rewrite,
cancel, or expand an approved plan or admitted slice. The FleetController marks
the divergence and requires attributed reconciliation before new planning or
plan amendment uses the revision.

Neither artifact may contain credentials, secret values, private keys, provider
tokens, exploit payloads, or unrestricted sensitive logs. References to
supporting material do not make that material authoritative unless another
accepted contract says so.

This decision requires a core-side ADR that adds the PRD documentation category,
permits fleet-authorized product direction scoped to named repositories, and
establishes the initiative tree and review path. Fluent MUST NOT activate the
intake contract until that core decision and validation are present.

## Consequences

- Operators can review product direction in normal Markdown while Fluent uses
  strict JSON for lifecycle and planning authority.
- Every planning attempt cites one immutable PRD and declaration revision.
- Core becomes the canonical intake surface for both single- and multi-
  repository Fluent initiatives without absorbing repository implementation
  plans.
- Merging an approved PRD cannot directly produce implementation PRs; a
  separately reviewed delivery plan remains necessary.
- Existing local PRDs need an explicit core intake PR before Fluent may act on
  them, adding process but preventing ambiguous authority.
- PRD revisions do not silently move work already in flight, so reconciliation
  and amendment handling are required.
- Core must change its current documentation categories and repository boundary
  deliberately.
- Exact initiative schema fields, PRD template checks, approval roles, secret
  scanning, size limits, reconciliation choices, and plan handoff remain to be
  specified.

## Alternatives considered

- **Treat any repository PRD as delivery authority:** rejected because every
  repository could enroll its own product work outside central planning review.
- **Store only the PRD in core:** rejected because parsing lifecycle, targets,
  and approval from Markdown would put prose interpretation in the control path.
- **Store the entire PRD as JSON:** rejected because product discovery and human
  review benefit from a readable narrative document.
- **Duplicate the PRD body in JSON:** rejected because the copies would drift
  and create conflicting product narratives.
- **Let a merged PRD admit implementation immediately:** rejected because PRDs
  need bounded decomposition, dependency analysis, risk classification, and a
  separate plan approval.
- **Resolve PRDs from external URLs or repository-specific paths:** rejected
  because mutable and arbitrary sources violate the canonical-location and
  bounded-import rules.
- **Apply a new PRD revision automatically to active work:** rejected because
  operators did not approve the changed scope for existing attempts or plans.
- **Assume core's current boundary already permits this:** rejected because the
  present instructions explicitly place single-repository material elsewhere.

## References

- Builds on core authority and strict JSON authoring from
  [ADR-0007](0007-use-frostyard-core-as-the-organization-authority.md) and
  [ADR-0013](0013-author-organization-records-as-strict-json.md), atomic
  snapshots from
  [ADR-0014](0014-import-core-as-atomic-validated-snapshots.md), repository
  enrollment from
  [ADR-0015](0015-authorize-repository-enrollment-through-core.md), and feature
  scope from [ADR-0019](0019-include-feature-delivery-in-v1.md)
- Uses FleetController coordination from
  [ADR-0026](0026-coordinate-enrolled-repositories-with-fleetcontroller.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [feature initiative intake](../prd/agent-fleet.md#feature-initiative-intake)
- Implementation design, contract, and delivery plan: not yet authored
