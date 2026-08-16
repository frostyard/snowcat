# 0014 — Import core as atomic validated snapshots

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

[ADR-0013](0013-author-organization-records-as-strict-json.md) defines a fixed,
validated organization tree in `frostyard/core`. Fluent needs to follow the
accepted branch, retain exact context for historical work, and remain useful
during temporary GitHub or network failures.

Importing individual files as they validate would expose combinations that
never existed as one reviewed commit. Executing a validator or build script
from the fetched repository would also turn organization data into code running
inside the control plane. Following a rewritten branch without notice could
silently roll policy backward.

The current queue is deliberately useful without model inference. Core import
must preserve that property and fail visibly without burning model tokens.

## Decision

Fluent configures one organization source repository and branch ref. The
initial source is `frostyard/core` at `refs/heads/main`. V1 supports manual
“sync now” and configurable periodic polling; webhooks are not required.
Authentication, when needed, comes from the host's Git credential mechanism or
runtime secret and is never stored in the Fluent database.

Fluent maintains a read-only bare Git mirror. It fetches the configured ref,
resolves it to a full commit ID, and reads only Git tree entries and blob bytes
under `organization/`. It does not create a working tree, follow filesystem
symlinks, load modules, execute hooks, or run scripts from the source
repository. Symlinks, submodules, non-blob record entries, and paths outside
the fixed tree are rejected.

Fluent recognizes only schema versions bundled with its release. The schema
files in core exist for authoring and parity checks; fetched schemas do not
redefine what the running service accepts. Core and Fluent validators must pass
the same conformance fixtures. Fluent compares the fetched files for every
recognized schema version with its bundled expected digests and rejects an
in-place schema change. An unknown schema version requires a Fluent upgrade
rather than dynamic execution or permissive fallback.

Every candidate commit is imported as one transaction:

1. enumerate the complete fixed tree;
2. enforce byte, depth, count, and path limits before materialization;
3. reject duplicate JSON keys and parse every record;
4. validate schemas, identities, references, lifecycles, and cross-record
   invariants;
5. construct a deterministic catalog sorted by record identity;
6. persist the source URL, ref, commit and tree IDs, raw record bytes, parsed
   records, per-record content hashes, validation report, import time, and a
   digest covering the whole catalog; and
7. move the active-snapshot pointer only after every write succeeds.

There is no partial activation. If fetching, parsing, validation, or storage
fails, Fluent keeps the last known-good snapshot active, records the failed
candidate and diagnostics, and alerts the operator. Retrying the same commit is
idempotent. Existing work references the immutable snapshot ID plus record
identities; the snapshot remains available even if Git history is later
rewritten or the source repository is unavailable.

The next automatically activated commit must be a fast-forward descendant of
the active source commit. A ref rewind, unrelated history, or explicit rollback
requires an attributed operator action that names the target commit and reason;
it creates a new snapshot without deleting prior snapshots.

Freshness is measured from the last successful fetch and validation of the
configured ref. V1 defaults to a 24-hour maximum staleness for creating
goal-derived discovery or admitting new work that depends on organization
context. After that boundary, those transitions fail closed while context
reading and already admitted work remain available from the last known-good
snapshot. Date-based goal and exception rules continue to advance locally; in
particular, an offline source cannot prolong an exception. The operator may
record a time-bounded stale-source override with a reason, but Fluent must make
that degraded state conspicuous.

## Consequences

- Workers see only catalogs that existed as complete, validated Git commits.
- A malformed core commit cannot partially update policy while leaving goals or
  exceptions at another revision.
- The control plane treats core as untrusted data until validation and never
  executes repository-controlled code.
- Last known-good snapshots let queued work and historical inspection continue
  through outages, while bounded staleness prevents indefinite new admission
  against an unchecked branch.
- Branch rewrites and rollbacks become explicit operator events rather than
  silent policy regression.
- Raw bytes and normalized data consume more storage, but make historical
  context durable and independently auditable.
- Fluent needs Git mirroring, strict parsing, schema parity, snapshot storage,
  freshness enforcement, diagnostics, and operator sync controls. None is
  implemented yet.

## Alternatives considered

- **Read files directly from a mutable local checkout:** rejected because the
  tree may be mid-update, contain uncommitted edits, or follow filesystem
  symlinks.
- **Run core's validator during import:** rejected because fetched repository
  code must not execute inside Fluent's control plane.
- **Fetch and activate records individually:** rejected because it can create a
  policy/goal/exception combination that never passed review together.
- **Trust fetched v1 schema files dynamically:** rejected because changing a
  schema in place could redefine accepted input beneath a running Fluent
  release.
- **Stop all work whenever GitHub is unavailable:** rejected because existing
  admitted work already has frozen context and should survive a control-source
  outage.
- **Use the last known-good snapshot indefinitely for new admission:** rejected
  because Fluent would never observe revoked exceptions or stronger policy.
- **Automatically follow force-pushes and rollbacks:** rejected because policy
  history regression must be explicit and attributable.

## References

- Imports the authoring contract from
  [ADR-0013](0013-author-organization-records-as-strict-json.md) and implements
  the snapshot authority established by
  [ADR-0007](0007-use-frostyard-core-as-the-organization-authority.md)
- Preserves exception expiry from
  [ADR-0010](0010-enforce-policies-monotonically-with-expiring-exceptions.md)
  and goal admission snapshots from
  [ADR-0009](0009-apply-goals-through-discovery-and-admission.md)
- Preserves deterministic control from
  [ADR-0004](0004-keep-models-outside-the-control-path.md)
- Product: [maintenance fleet PRD](../prd/agent-fleet.md), especially
  [core authoring and snapshot import](../prd/agent-fleet.md#core-authoring-and-snapshot-import)
- Implementation design, contract, and delivery plan: not yet authored
