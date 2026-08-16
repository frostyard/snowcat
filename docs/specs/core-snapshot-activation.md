# Spec: Core snapshot activation

This contract governs the typed control-plane transaction that turns one
successfully verified `frostyard/core` candidate into a retained Core snapshot
and selects it as current organization authority. It is consumed by the
host-local Core CLI and internal Fluent code; it does not create repository
enrollment, reconcile GitHub, or admit work.

## Interface

The host-local command is:

```sh
npm run --silent core -- activate <expected-control-plane-sequence>
```

It uses the same `FLUENT_CORE_URL`, `FLUENT_CORE_REF`, and
`FLUENT_CORE_MIRROR` source contract as
[Core snapshot verification](core-snapshot-verification.md), plus
`FLUENT_CONTROL_DB` from the
[control-plane kernel](control-plane-kernel.md). The expected sequence is a
positive canonical safe integer that optimistically binds the new transaction
to the operator's observed target state.

Success emits one JSON object:

| Field | Type | Constraint |
| --- | --- | --- |
| `snapshotId` | UUIDv7 | New Fluent-native `core-snapshot` subject |
| `definitionRecordId` | UUIDv7 | `core.snapshot-definition` at position `0` |
| `activeFactRecordId` | UUIDv7 | `core.snapshot-active` at position `1` |
| `eventRecordId` | UUIDv7 | `core.snapshot-activated` at position `2` |
| `catalogDigest` | SHA-256 string | Exact verified catalog identity |
| `sourceCommitId` | 40 lowercase hex | Exact source Git commit |
| `importedAt` | canonical UTC instant | Shared evaluation and recorded time |
| `transactionPositions` | tuple | Exactly `[0, 1, 2]` |
| `transactionSequence` | positive integer | Allocated control-plane order |

The command uses source kind `github-repository`, immutable source ID
`github.com:1331309458`, source revision kind `git-commit-sha1`, and value
`sha1:<commit>`. Its deterministic idempotency key is
`core-activate:<commit>`, scoped to the database lineage and retained through
`9999-12-31T23:59:59.999Z` in this schema.

Schema and registry version `2` add three authority tables:

| Table | Retained content |
| --- | --- |
| `core_snapshots` | Snapshot/source identities, catalog, import time, and definition/fact/event/transaction lineage |
| `core_snapshot_files` | Every recognized path, mode, Git object ID, byte size, digest, exact bytes, and canonical parsed live repository declaration |
| `core_active_snapshot` | Singleton pointer to the latest accepted activation fact |

The exact definition payload contains snapshot ID, fixed source repository ID,
source URL/ref/commit/tree, catalog digest, file/byte/repository/fixture counts,
the three schema digests, and import time. The active fact and activation event
share the exact payload `{ databaseLineageId, snapshotId, catalogDigest,
sourceCommitId, activatedAt }`.

## Rules

1. Activation MUST rerun the complete verifier against the candidate's retained
   files and compare the full validation report before allocating authority.
2. The production source MUST be the registered `frostyard/core` GitHub
   repository. This version accepts SHA-1 Git commit and tree identities only.
3. A new command MUST reject a stale expected sequence or a clock earlier than
   the target control-time watermark without writing authority.
4. Snapshot subject, definition, active fact, activation event, raw and parsed
   files, singleton pointer, idempotency receipt, metadata watermarks, and
   transaction MUST commit in one SQLite transaction.
5. The pointer MUST move only after every snapshot file and durable occurrence
   is written. Any failure MUST roll back the transaction and SQLite sequence
   allocation, leaving the prior active snapshot unchanged.
6. Every accepted snapshot MUST remain retained after a later activation.
   Activation MUST NOT edit or delete an earlier snapshot.
7. Equivalent retry with the original expected sequence MUST return the exact
   stored result before reevaluating the clock or current sequence. Reusing the
   same commit identity with a different command payload MUST fail.
8. The active predicate is `core.snapshot-active` version `1`, established only
   by `core.activate-snapshot`; latest transaction sequence wins. The singleton
   table is a checked pointer, not independent authority.
9. Startup MUST recompute each retained file digest and catalog digest, verify
   canonical parsed records against raw bytes, validate occurrence/source
   contracts and linkage, and require the pointer to match the latest
   activation fact.
10. Verification or activation MUST NOT interpret a declaration as enrollment,
    reconcile a repository, create a hold, generate work, or execute fetched
    repository code.
11. This version does not accept ref rewinds, define rollback, record rejected
    candidate diagnostics, enforce freshness, or poll. Those operations require
    later typed commands and contracts.
12. A schema/registry version `1` database MUST fail closed. This pre-production
    version defines no in-place upgrade; initialize a fresh target database.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| Retained Core snapshot | Exact candidate bytes plus the independently rerun validation report |
| Current Core authority | Latest accepted `core.snapshot-active` fact and its checked singleton pointer |
| Startup integrity evidence | Recomputed bytes, parsed-record, catalog, occurrence, receipt, and pointer lineage |
| Focused conformance tests | `test/core-source.test.ts` |

## References

- Rationale:
  [ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md),
  [ADR-0039](../adr/0039-use-typed-source-native-subject-identities.md), and
  [ADR-0040](../adr/0040-establish-facts-through-registered-predicate-contracts.md)
- Context: [Core snapshot ingestion](../design/core-snapshot-ingestion.md)
- Substrate: [control-plane kernel](control-plane-kernel.md)
- Delivery: [Core snapshot ingestion plan](../plans/core-snapshot-ingestion.md)
