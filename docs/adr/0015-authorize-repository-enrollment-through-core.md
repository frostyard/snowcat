# 0015 — Authorize repository enrollment through core

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

The PRD requires explicit repository opt-in and prohibits treating GitHub
organization membership as enrollment. [ADR-0007](0007-use-frostyard-core-as-the-organization-authority.md)
and [ADR-0014](0014-import-core-as-atomic-validated-snapshots.md) now provide a
reviewed, revisioned, atomically imported authority surface, making a merged
core change the natural enrollment decision.

Enrollment is operational configuration rather than a sixth organization
context kind. It must identify the exact GitHub repository, select maintenance
programs, and constrain actions without conflating portfolio lifecycle with
fleet participation.

Making core the *only* way to stop a repository would be unsafe. During an
incident, the operator needs an immediate local kill switch even if GitHub or
core is unavailable. That local action may narrow authority but must never
create enrollment or broaden it.

## Decision

[ADR-0013](0013-author-organization-records-as-strict-json.md)'s authoring tree
is extended with a repository registry:

```text
organization/
  schemas/v1/repository.schema.json
  repositories/<owner>/<repository>.json
```

A repository declaration is versioned operational configuration, not one of
the five context record kinds. Its v1 data includes:

- `schema_version`;
- GitHub `owner/name` plus the immutable GitHub repository ID represented as a
  string;
- accountable owners;
- fleet state: `enabled`, `paused`, or `disabled`;
- enabled maintenance programs chosen from quality improvement, CI,
  security, and architecture; and
- an action ceiling that must be a subset of Fluent's v1 platform ceiling.

The path owner and filename must match the declared slug. Registry files are
strict JSON, validated and imported with the same bounded, atomic catalog as
the five context kinds. They do not contain credentials, provider selection,
worker configuration, repository-local implementation details, or portfolio
lifecycle state.

Adding a valid `enabled` declaration through a PR merged to the configured core
branch is the only path that authorizes initial enrollment. Activating the
resulting core snapshot creates the durable repository workstream and an
attributed enrollment event, but creates no work by itself. Fluent's UI, CLI,
API, workers, models, GitHub topics, and organization membership cannot enable
an undeclared repository.

After import, Fluent resolves the declared slug through GitHub and requires the
returned immutable repository ID to match. A missing, transferred, renamed, or
archived repository, an ID mismatch, or unavailable required repository-local
policy places that repository on hold without rejecting unrelated records in
the already validated core snapshot. No discovery, admission, claim, or lease
renewal occurs while the hold remains. Updating a slug or intentional transfer
requires a new core PR.

`paused` temporarily opts the repository out of new discovery, admission,
claim, and lease renewal. `disabled` expresses intentional removal from the
fleet with the same execution restrictions. Neither state deletes the durable
workstream, items, snapshots, events, assessments, or evidence. A lease already
issued is not lengthened and ends normally; a late terminal report may be kept
as provenance but cannot restore authority or admit follow-ups.

Registry declarations are tombstoned with `disabled`, not deleted. Fluent
rejects removal of a declaration that existed in its active snapshot, preventing
accidental deletion from looking like a clean opt-out. Re-enabling through a
later core PR permits new work, but items held by the earlier pause or disable
do not become claimable automatically; an attributed operator reconciliation
must release or retire them.

The local operator may impose an immediate repository suspension with actor,
reason, and time. This override is stored in Fluent and intersects with the
core declaration: it can stop discovery, admission, claims, and renewal, but
cannot enable a repository, add a maintenance program, raise an action ceiling,
or otherwise broaden authority. Clearing it returns the repository only to the
state authorized by the active core snapshot.

Core branch protection, CODEOWNERS, and review roles determine who may merge
enrollment changes. Their exact named-member policy remains open, but Fluent
always records the source PR or commit when available and the activated
snapshot.

## Consequences

- Enrollment becomes reviewable organization history rather than mutable
  control-plane state or a GitHub metadata convention.
- A declaration makes repository identity, maintenance scope, and maximum
  authority explicit before any work is created.
- Immutable GitHub IDs prevent a renamed or transferred slug from silently
  directing agents at another repository.
- A core import problem cannot partially enroll a repository, and an external
  GitHub state problem holds only the affected repository rather than blocking
  unrelated organization-policy updates.
- Operators retain an immediate fail-safe that only narrows authority.
- Pause and disable preserve evidence and avoid surprising automatic resumption
  of stale queued work.
- Fluent needs registry schema support, GitHub identity reconciliation,
  repository holds, enrollment events, local suspension, and held-work
  reconciliation. None is implemented yet.

## Alternatives considered

- **Fluent database toggle as the enrollment authority:** rejected because it
  bypasses core review and makes organization participation harder to audit.
- **GitHub topic or organization membership:** rejected because either can
  change outside the accepted planning workflow and neither carries action or
  maintenance scope.
- **Repository-local opt-in file only:** rejected because a repository PR should
  not grant itself organization-fleet authority.
- **Require a second Fluent approval after the core PR:** rejected for initial
  enrollment because the reviewed merge is already the authorization event and
  the imported declaration carries explicit ceilings.
- **Forbid local suspension:** rejected because stopping unsafe work must not
  depend on GitHub availability or PR latency.
- **Allow local enablement for symmetry:** rejected because emergency controls
  should be able to remove authority, never create it.
- **Delete the declaration to opt out:** rejected because deletion loses the
  explicit state and can accidentally reactivate old work if the file returns.
- **Automatically resume held work after re-enrollment:** rejected because its
  context and value may be stale and resumption would be an implicit new
  admission decision.

## References

- Uses core authority from
  [ADR-0007](0007-use-frostyard-core-as-the-organization-authority.md), strict
  authoring from
  [ADR-0013](0013-author-organization-records-as-strict-json.md), and atomic
  import from
  [ADR-0014](0014-import-core-as-atomic-validated-snapshots.md)
- Preserves the coordination boundary in
  [ADR-0003](0003-separate-work-coordination-from-execution.md), deterministic
  authority in [ADR-0004](0004-keep-models-outside-the-control-path.md), and
  admission in [ADR-0005](0005-admit-worker-created-work-before-claiming.md)
- Product: [maintenance fleet PRD](../prd/agent-fleet.md), especially
  [repository enrollment](../prd/agent-fleet.md#repository-enrollment)
- Implementation design, contract, and delivery plan: not yet authored
