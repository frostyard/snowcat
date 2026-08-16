# Core snapshot ingestion

Living document. Rationale:
[ADR-0007](../adr/0007-use-frostyard-core-as-the-organization-authority.md),
[ADR-0013](../adr/0013-author-organization-records-as-strict-json.md), and
[ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md).
Contracts: [core snapshot verification](../specs/core-snapshot-verification.md).

## Overview

Core snapshot ingestion is the deterministic boundary between the mutable
`frostyard/core` branch and future Fluent authority. The implemented first
slice fetches one exact commit into a bare mirror, reads only its Git tree and
blob objects under `organization/`, validates the complete supported contract,
and emits a content-addressed candidate catalog. It does not write the
control-plane database, activate a Core snapshot, or create enrollment.

```text
frostyard/core refs/heads/main
              │ fetch, resolve exact commit
              ▼
      host-local bare mirror
              │ bounded Git tree/blob reads; no checkout
              ▼
  schema parity + strict catalog validation
              │
              ├──► rejected candidate diagnostics
              └──► immutable candidate summary (not authority)
```

## Design

### Git source boundary

[`git-source.ts`](../../src/core/git-source.ts) accepts only the configured
`frostyard/core` GitHub URL forms and one canonical `refs/heads/*` ref. The
defaults are HTTPS `frostyard/core`, `refs/heads/main`, and
`./data/core.git`. Git authentication remains in the host Git mechanism;
Fluent neither accepts credentials in the URL nor persists them in its
database.

The source is fetched into an internal candidate ref in a bare mirror. Git
hooks, the `ext` protocol, filesystem sources, ambient Git directory/object
environment variables, fsmonitor, and alternate object storage are disabled or
rejected. Tests alone can enable a filesystem source for an isolated fixture.
The reader resolves the candidate commit and `organization` tree IDs, enumerates
regular blobs, enforces limits before loading content, and uses `git cat-file`
instead of creating a working tree. Symlinks, submodules, non-blob entries,
unsafe paths, and unknown authority paths fail the whole candidate.
Replacement objects and lazy object fetching are disabled, so the resolved
object graph must be present in the fetched mirror exactly as addressed.

### Bundled contract and parity

Fluent bundles the three schema documents implemented by merged core PR #80:
repository declaration, repository surfaces, and repository agent governance.
The expected SHA-256 digest of each exact core schema blob is compiled into
Fluent. A fetched schema must match that byte digest, and its parsed canonical
content must match the bundled validator schema, before validation begins.
Fetched schema code or validation scripts are never executed.

The independent validator uses the same pinned Ajv 2020 and `jsonc-parser`
versions as core. It rejects invalid UTF-8, comments, trailing commas, duplicate
keys, unknown properties through the schemas, path/identity mismatch,
duplicate repository identities and owners, invalid surface catalogs, and
duplicate protected boundaries. It runs every recognized valid and invalid
fixture and refuses a corpus without both classes.

### Candidate catalog

Every recognized file contributes path, regular-file mode, Git object ID,
byte size, and content digest to a path-sorted canonical catalog digest. The
reported candidate binds source URL, source ref, commit ID, organization tree
ID, schema digests, fixture counts, and parsed repository declarations.
Repository declarations remain declarations: the merged `frostyard/core`
declaration is currently `disabled`, and even a future `enabled` declaration
will not become enrollment until a later transaction atomically persists and
activates the whole snapshot and GitHub reconciliation succeeds.

The bare mirror and JSON report are staging artifacts, not facts, projections,
or active authority. Re-running verification is safe and does not allocate a
control-plane transaction.

## Operational notes

- Run `npm run --silent core -- verify`. Success writes one JSON value to
  stdout; diagnostics and Git/Node warnings use stderr.
- `FLUENT_CORE_URL`, `FLUENT_CORE_REF`, and `FLUENT_CORE_MIRROR` select the
  exact allowed source, branch ref, and host-local mirror path.
- A valid report proves compatibility with the implemented repository-authority
  slice only. Core roadmap record kinds that do not yet exist remain unsupported
  and any unknown `organization/` path fails closed.
- A failed fetch or validation leaves no last-known-good state in this slice.
  Durable candidate diagnostics, atomic activation, ancestry checks, freshness,
  rollback authority, and polling belong to later phases of the
  [ingestion plan](../plans/core-snapshot-ingestion.md).
- The mirror contains organization-governed data and should be backed up and
  permissioned as an `organization` asset. It must never be mounted as an
  enrolled repository checkout or exposed to workers as a tool directory.

## References

- Rationale:
  [ADR-0007](../adr/0007-use-frostyard-core-as-the-organization-authority.md),
  [ADR-0013](../adr/0013-author-organization-records-as-strict-json.md),
  [ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md), and
  [ADR-0015](../adr/0015-authorize-repository-enrollment-through-core.md)
- Contract: [core snapshot verification](../specs/core-snapshot-verification.md)
- Built in: [core snapshot ingestion — Phase 1](../plans/core-snapshot-ingestion.md)
- Product: [GitHub organization agent fleet](../prd/agent-fleet.md)
