# Spec: Core snapshot verification

This contract governs the read-only candidate verifier that consumes the
supported `organization/` tree in `frostyard/core`. It produces a deterministic
report for operators and later snapshot activation code; it creates no Fluent
authority by itself.

## Interface

The host-local command is:

```sh
npm run --silent core -- verify
```

It accepts no additional arguments. Configuration is read from:

| Variable | Default | Constraint |
| --- | --- | --- |
| `FLUENT_CORE_URL` | `https://github.com/frostyard/core.git` | Exact HTTPS, SCP-style SSH, or `ssh://` form for `frostyard/core`; credentials in URLs are not accepted |
| `FLUENT_CORE_REF` | `refs/heads/main` | Canonical full `refs/heads/*` name without traversal, reflog syntax, empty component, or trailing slash/dot |
| `FLUENT_CORE_MIRROR` | `./data/core.git` | Filesystem path to a new or existing bare Git repository without object alternates |

Success emits one JSON object with these fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `sourceUrl`, `ref` | string | Configured source and branch ref |
| `commitId`, `treeId` | string | Exact 40- or 64-lowercase-hex Git commit and `organization` tree objects |
| `catalogDigest` | SHA-256 string | Digest of the canonical path-sorted file catalog |
| `fileCount`, `totalBytes` | integer | Bounded materialized tree totals |
| `schemaDigests` | object | Exact expected/fetched schema-blob digests by contract kind |
| `repositoryCount` | integer | Number of valid live repository declarations |
| `validFixtureCount`, `invalidFixtureCount` | integer | Conformance fixtures that behaved as declared |
| `repositories` | array | Declaration path, byte digest, and strictly validated declaration |

Failure emits no success JSON, writes a bounded diagnostic to stderr, and exits
nonzero.

## Rules

1. Verification MUST fetch into a bare mirror and MUST NOT create a working
   tree, follow a filesystem symlink, execute a hook, load a module, or run a
   source-repository script.
2. Production source URLs MUST identify `frostyard/core` through an allowed
   GitHub transport. The Git `ext` and filesystem protocols MUST be disabled.
3. Ambient `GIT_DIR`, `GIT_WORK_TREE`, `GIT_OBJECT_DIRECTORY`, and
   `GIT_ALTERNATE_OBJECT_DIRECTORIES`, injected configuration tuples, and Git
   executable paths MUST NOT change the mirror, command, or object source. A
   persisted Git alternates file MUST be rejected; replacement objects and
   lazy object fetching MUST be disabled.
4. The candidate MUST resolve to one exact commit and one exact
   `organization` tree before any blob is interpreted.
5. The tree MUST contain at most 256 files, each no larger than 1,048,576 bytes,
   at most 8,388,608 bytes total, paths no longer than 512 UTF-8 bytes, and at
   most 12 path components. Limits MUST be checked from tree metadata before
   blob materialization.
6. Every authority entry MUST be a regular `100644` or `100755` Git blob under
   `organization/`. Symlinks, submodules, non-blobs, invalid UTF-8 paths,
   traversal components, duplicates, and unknown paths MUST reject the entire
   candidate.
7. `organization/README.md`, all three supported v1 schemas, and the v1
   repository-surface contract MUST exist. A schema blob MUST match Fluent's
   exact expected SHA-256 digest before its fetched content is used for parity
   comparison.
8. Fluent MUST compile its bundled schemas, not dynamically trust a changed
   fetched schema. The bundled and fetched parsed schema content MUST be
   canonically equal.
9. Every JSON document interpreted by the contract MUST be strict UTF-8 JSON
   without comments, trailing commas, empty content, or duplicate object keys.
10. Live records and conformance fixtures MUST satisfy their schema and the
    path, identity, owner, surface, repository-ID, and protected-boundary
    invariants implemented by core PR #80.
11. Every recognized valid fixture MUST pass and every recognized invalid
    fixture MUST fail. At least one of each MUST exist.
12. The catalog digest MUST cover every recognized tree entry's path, regular
    mode, Git object ID, byte size, and SHA-256 content digest in deterministic
    path order.
13. Verification MUST NOT initialize or mutate `FLUENT_CONTROL_DB`, activate a
    Core snapshot, create enrollment, reconcile GitHub, or create work.
14. Re-running verification of unchanged Git objects MUST return the same
    commit, tree, catalog, schema, and declaration content identities.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| Bare core mirror | Git fetch of the configured branch into the internal candidate ref |
| Candidate catalog | Bounded tree enumeration plus strict validation and content hashing |
| Schema parity evidence | Exact fetched blob digests plus canonical comparison to bundled schemas |
| Focused conformance tests | `test/core-source.test.ts` |

## References

- Rationale:
  [ADR-0013](../adr/0013-author-organization-records-as-strict-json.md) and
  [ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md), with
  enrollment semantics from
  [ADR-0015](../adr/0015-authorize-repository-enrollment-through-core.md)
- Context: [core snapshot ingestion](../design/core-snapshot-ingestion.md)
- Delivery: [core snapshot ingestion plan](../plans/core-snapshot-ingestion.md)
