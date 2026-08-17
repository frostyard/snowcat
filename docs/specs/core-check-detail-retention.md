# Spec: Core check-detail retention

This contract governs deterministic pruning of detailed eligible Core source
checks and candidate rejections before periodic polling can create unattended
volume. The host-local Core CLI and internal polling controller consume it; it
does not remove snapshots, decisions, current-readiness anchors, or referenced
evidence.

## Interface

The host-local command is:

```sh
npm run --silent core -- prune-check-history <expected-control-plane-sequence>
```

The result has this exact shape:

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `observationRecordId`, `eventRecordId` | UUIDv7 | yes | Ordered retained audit outputs |
| `cutoffAt`, `evaluatedAt` | canonical UTC instant | yes | Evaluation time minus 30 days, and server evaluation time |
| `maximumEligibleChecks` | integer | yes | Exactly `10000` |
| `deletedTransactionCount` | integer | yes | Non-negative complete check transactions removed |
| `deletedOccurrenceCount` | integer | yes | Exactly twice the deleted transaction count |
| `deletedFirstSequence`, `deletedLastSequence` | positive integer or null | yes | Null together when nothing was removed |
| `deletedDigest` | SHA-256 string | yes | Digest of ordered deleted transaction, occurrence, and payload-digest identities |
| `remainingDetailedCheckCount` | integer | yes | All retained eligible/rejection detail, including protected checks |
| `transactionPositions` | tuple | yes | Exactly `[0, 1]` |
| `transactionSequence` | positive integer | yes | New retained prune transaction |

The observation/event payload repeats the evaluation, threshold, deletion,
digest, and remaining-count fields and adds the database lineage ID. Its record
kind is `core.check-detail-prune-observation`; its event kind is
`core.check-detail-pruned`.

## Rules

1. Only transactions created by `core.record-source-check-eligible` or
   `core.record-candidate-rejection` are candidates.
2. The command MUST protect the latest automatic check, latest successful
   validation, latest substantive readiness outcome, and every check ID cited
   by a retained decision.
3. Among unprotected candidates, it MUST remove every transaction recorded
   before `evaluatedAt - 30 days` and then the oldest additional transactions
   needed to retain at most 10,000 unprotected candidates.
4. Each deletion MUST remove the complete two-occurrence transaction, its
   record/event subtype rows, and its idempotency receipt. Partial deletion is
   forbidden.
5. Snapshots, snapshot files, activation/rollback transactions, decisions,
   protected checks, and any other command kind MUST NOT be deleted.
6. The deleted digest MUST cover candidates in ascending transaction order and
   include each transaction sequence, command kind, record IDs, occurrence
   kinds, and payload digests using canonical JSON and SHA-256.
7. The prune observation and event MUST be retained at positions `[0, 1]` in a
   new typed transaction. Its receipt is retained indefinitely.
8. Sequence allocation MUST remain monotonic. Deleted historical sequences
   MUST remain gaps and MUST NOT be reused.
9. Every registered projection MUST be replaced atomically from the post-prune
   source through the new prune sequence. A failure MUST roll back all effects.
10. Equivalent replay MUST return the original result. A stale expected
    sequence or changed payload under the same key MUST fail.
11. An empty prune MUST still emit one result with zero counts, null sequence
    bounds, and the SHA-256 digest of an empty canonical array.
12. A pre-production registry change has no in-place migration; initialize a
    fresh target database.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| Live detailed Core check history | Protected checks plus unprotected checks inside both retention bounds |
| Prune audit history | Retained prune observations/events and deleted-detail digests |
| Current projections | Full rebuild from post-prune occurrences through the prune sequence |

## References

- Rationale: [ADR-0048](../adr/0048-retain-core-check-detail-for-30-days.md)
- Context: [Core snapshot ingestion](../design/core-snapshot-ingestion.md)
- Source-state contract: [Core source readiness](core-source-readiness.md)
- Substrate: [control-plane kernel](control-plane-kernel.md)
- Delivery: [Core snapshot ingestion plan](../plans/core-snapshot-ingestion.md)
