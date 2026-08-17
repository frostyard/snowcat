# Spec: Core snapshot activation

This contract governs the typed control-plane transactions that either turn one
successfully verified `frostyard/core` candidate into the current retained Core
snapshot or record a bounded rejection observation when activation cannot
begin or commit. It is consumed by the host-local Core CLI and internal Fluent
code; it does not create repository enrollment, reconcile GitHub, or admit work.

## Interface

The host-local command is:

```sh
npm run --silent core -- activate <expected-control-plane-sequence>
npm run --silent core -- rollback <expected-control-plane-sequence> <target-commit> <reason>
npm run --silent core -- rejections [limit]
```

It uses the same `FLUENT_CORE_URL`, `FLUENT_CORE_REF`, and
`FLUENT_CORE_MIRROR` source contract as
[Core snapshot verification](core-snapshot-verification.md), plus
`FLUENT_CONTROL_DB` from the
[control-plane kernel](control-plane-kernel.md). The expected sequence is a
positive canonical safe integer that optimistically binds the new transaction
to the operator's observed target state.

The underlying accepted activation result has this shape:

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

The host-local `activate` command then records the eligible automatic source
check and emits `{ activation, activationResult, activeSnapshot, sourceCheck,
readiness }`. `activation` is `activated` or `unchanged`; `activationResult` is
the result above or null for an unchanged active commit. `sourceCheck` carries
its own later transaction sequence, which is the sequence callers should use
for the next command. The command does not create another snapshot for an
unchanged commit.

The command uses source kind `github-repository`, immutable source ID
`github.com:1331309458`, source revision kind `git-commit-sha1`, and value
`sha1:<commit>`. Its deterministic idempotency key is
`core-activate:<expected-sequence>:<commit>`, scoped to the database lineage and retained through
`9999-12-31T23:59:59.999Z` in this schema.

`rollback` selects an exact target commit through an attributed local-operator
decision. It first reuses retained snapshot bytes for that commit when present;
otherwise the source adapter materializes the exact commit from the secured bare
mirror or configured Core source. The complete candidate is independently
revalidated either way. The command key is
`core-rollback:<expected-sequence>:<target-commit>` and its reason is one
trimmed, control-free line from 1 through 512 UTF-8 bytes.

An accepted rollback emits a result with the snapshot, definition, active-fact,
event, catalog, source, import-time, and transaction fields above, plus the
decision record ID, previous snapshot and source-commit IDs, operator principal
ID, exact reason, and positions `[0, 1, 2, 3]`. The transaction outputs are:

| Position | Kind | Meaning |
| --- | --- | --- |
| `0` | `core.rollback-decision` | Resolved `activate-target-commit` decision bound to the prior sequence, active snapshot, target, operator, and reason |
| `1` | `core.snapshot-definition` | New immutable snapshot definition for the independently revalidated target bytes |
| `2` | `core.snapshot-active` | New latest-precedence authority fact |
| `3` | `core.snapshot-rollback-activated` | Past-tense event linking the decision, previous authority, and new snapshot |

`activate` assigns one server UUIDv7 invocation identity before fetching. A
source, validation, continuity, or persistence failure is recorded idempotently as command
`core.record-candidate-rejection`, with
`core.candidate-rejection-observation` at position `0` and
`core.candidate-rejected` at position `1`. That audit transaction advances
control-plane order but creates no fact and does not change the active pointer.
`rejections` returns the newest 20 observations by default and accepts a limit
from 1 through 100.

The rejection payload has this exact shape:

| Field | Type | Constraint |
| --- | --- | --- |
| `checkId` | UUIDv7 | Server identity for one invocation; also binds idempotent replay and correlation |
| `operation` | enum | `automatic-source-check` or `operator-rollback`; only the former affects source readiness |
| `stage` | enum | `source`, `validation`, `continuity`, or `persistence` |
| `code` | enum | Matching `source-unavailable`, `candidate-invalid`, `candidate-not-descendant`, `continuity-unverifiable`, or `persistence-failed` |
| `summary` | string | Sanitized single line, 1–512 UTF-8 bytes |
| `details` | string array | At most eight sanitized single lines, each 1–512 UTF-8 bytes |
| `sourceUrl`, `sourceRef` | string | Registered Core GitHub source and canonical branch ref |
| `commitId`, `treeId` | string or null | Available canonical SHA-1 identities; validation requires a commit and persistence requires both |
| `catalogDigest` | string or null | Required for continuity and persistence failure |
| `activeCommitId` | string or null | Required for continuity failure; exact active source commit used by the ancestry check |
| `observedAt` | canonical UTC instant | Server evaluation and recorded time |

Schema version `2` and registry version `8` govern three authority tables:

| Table | Retained content |
| --- | --- |
| `core_snapshots` | Snapshot/source identities, catalog, import time, and definition/fact/event/transaction lineage |
| `core_snapshot_files` | Every recognized path, mode, Git object ID, byte size, digest, exact bytes, and canonical parsed live repository declaration |
| `core_active_snapshot` | Singleton pointer to the latest accepted activation fact |

The exact definition payload contains snapshot ID, fixed source repository ID,
source URL/ref/commit/tree, catalog digest, file/byte/repository/fixture counts,
the three schema digests, and import time. The active fact and activation event
share the exact payload `{ databaseLineageId, snapshotId, catalogDigest,
sourceCommitId, activatedAt }` for automatic activation. A rollback keeps that
fact payload but uses its separately registered event payload to retain the
previous snapshot/commit, decision, operator, and reason.

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
   by `core.activate-snapshot` or `core.rollback-snapshot`; latest transaction sequence wins. The singleton
   table is a checked pointer, not independent authority.
9. Startup MUST recompute each retained file digest and catalog digest, verify
   canonical parsed records against raw bytes, validate occurrence/source
   contracts and linkage, and require the pointer to match the latest
   activation fact.
10. Verification or activation MUST NOT interpret a declaration as enrollment,
    reconcile a repository, create a hold, generate work, or execute fetched
    repository code.
11. A new automatic activation after the first MUST bind the active source
    commit under the writer lock and MUST proceed only after the source adapter
    verifies that commit as an ancestor of the different candidate commit.
    Exact idempotent replay is evaluated before this precondition.
12. `core verify` MUST remain read-only even when verification fails. `core
    activate` MUST attempt to record a source or validation rejection after the
    candidate fails, a continuity rejection after a validated candidate fails
    or cannot complete the Git ancestry check, and a persistence rejection only
    after the activation transaction has fully rolled back.
13. Rejection diagnostics MUST use the registered stage/code pairing, fixed
    source identity, bounded sanitized strings, organization information class,
    deployment scope, optional exact source revision, and a receipt governed by
    [Core check-detail retention](core-check-detail-retention.md). They MUST NOT
    copy candidate bytes or create a fact.
14. Rejection recording failure MUST be reported alongside the original error
    and MUST NOT replace or disguise that original failure.
15. Operator rollback MUST require an existing active snapshot, a different
    exact target commit, a bounded rationale, the stored operator principal,
    and an exact expected pre-command sequence. It MUST create a resolved
    decision and a new snapshot/fact/event transaction without deleting or
    editing any prior snapshot.
16. Retained target bytes MUST permit rollback while the source is unavailable.
    A non-retained target MUST pass the same bounded Git-object read and complete
    validator as automatic activation. Neither path grants repository enrollment
    or work.
17. Activation and rollback idempotency MUST bind the observed pre-command
    sequence as well as target commit. This MUST permit a commit to become
    current again after an intervening rollback while preserving exact replay
    of each original transition.
18. This version refuses automatic ref rewinds and unrelated history and feeds
    automatic outcomes to the separate
    [Core source readiness](core-source-readiness.md) contract. Typed pruning is
    implemented under [Core check-detail retention](core-check-detail-retention.md);
    periodic polling remains a later controller operation.
19. A schema version other than `2` or registry version other than `8` MUST fail
    closed. This pre-production version defines no in-place upgrade; initialize
    a fresh target database.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| Retained Core snapshot | Exact candidate bytes plus the independently rerun validation report |
| Current Core authority | Latest accepted `core.snapshot-active` fact and its checked singleton pointer |
| Startup integrity evidence | Recomputed bytes, parsed-record, catalog, occurrence, receipt, and pointer lineage |
| Core candidate rejection history | Registered bounded observations and audit events ordered independently of activation facts |
| Focused conformance tests | `test/core-source.test.ts` |

## References

- Rationale:
  [ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md),
  [ADR-0039](../adr/0039-use-typed-source-native-subject-identities.md), and
  [ADR-0040](../adr/0040-establish-facts-through-registered-predicate-contracts.md),
  [ADR-0046](../adr/0046-separate-core-source-freshness-from-admission-readiness.md),
  and [ADR-0048](../adr/0048-retain-core-check-detail-for-30-days.md)
- Context: [Core snapshot ingestion](../design/core-snapshot-ingestion.md)
- Source gate: [Core source readiness](core-source-readiness.md)
- Diagnostic retention: [Core check-detail retention](core-check-detail-retention.md)
- Substrate: [control-plane kernel](control-plane-kernel.md)
- Delivery: [Core snapshot ingestion plan](../plans/core-snapshot-ingestion.md)
