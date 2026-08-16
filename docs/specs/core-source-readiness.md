# Spec: Core source readiness

This contract governs the durable automatic source-check state and the
deterministic precondition for new organization-dependent discovery and
admission. The Core CLI and internal controllers consume it; read-only
verification, worker execution, and existing admitted work do not.

## Interface

The host-local read command is:

```sh
npm run --silent core -- readiness
```

The typed read result is:

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `ready` | boolean | yes | Whether new organization-dependent discovery or admission may proceed |
| `reason` | enum | yes | `ready`, `no-active-snapshot`, `source-stale`, `candidate-invalid`, `continuity-blocked`, or `persistence-failed` |
| `evaluatedAt` | canonical UTC instant | yes | Caller-supplied or server evaluation time |
| `controlPlaneSequence` | positive integer | yes | Exact authoritative sequence evaluated |
| `activeSnapshotId` | UUIDv7 or null | yes | Current Core authority, if one exists |
| `activeSourceCommitId` | 40 lowercase hex or null | yes | Commit retained by that snapshot |
| `latestCheckId` | UUIDv7 or null | yes | Latest automatic configured-ref source check |
| `latestCheckOutcome` | enum or null | yes | `eligible`, `source-unavailable`, `candidate-invalid`, `continuity-blocked`, or `persistence-failed` |
| `latestCheckedAt` | canonical UTC instant or null | yes | Occurrence time of the latest automatic check |
| `lastValidatedAt` | canonical UTC instant or null | yes | Latest successful fetch and validation of the configured ref |
| `maximumStalenessSeconds` | integer | yes | `86400` in v1 |
| `staleAt` | canonical UTC instant or null | yes | `lastValidatedAt + maximumStalenessSeconds` |
| `overrideDecisionId` | null | yes | Reserved; registry version 6 has no override command |
| `overrideExpiresAt` | null | yes | Reserved; registry version 6 has no override command |
| `degraded` | false | yes | Reserved; registry version 6 never relaxes staleness |

The durable automatic source-check outcome binds one configured source URL and
ref, invocation check ID, occurrence time, outcome, resolved candidate commit
and catalog digest when available, active snapshot and source commit observed
for continuity, and bounded diagnostics for a failure. Read-only `core verify`
and exact-commit rollback inspection never create it.

## Rules

1. An automatic configured-ref attempt MUST create exactly one latest-precedence
   source-check outcome, whether it succeeds or fails.
2. A successful fetch and full candidate validation MUST advance
   `lastValidatedAt`, including when continuity or persistence later fails.
3. `source-unavailable` MUST NOT immediately block readiness while a prior
   successful validation remains within 86,400 seconds.
4. `candidate-invalid`, `continuity-blocked`, and `persistence-failed` MUST
   block readiness immediately until a later eligible automatic check or the
   exact rollback resolution defined by ADR-0046.
5. `eligible` MUST mean the checked candidate exactly matches the active commit
   and catalog while the eligible-check transaction holds the writer lock.
   Validation alone is insufficient.
6. A later rollback to a commit other than that eligible candidate MUST make
   readiness `continuity-blocked` unless it resolves the exact continuity
   rejection described by rule 13.
7. An absent active snapshot MUST return `no-active-snapshot` regardless of
   source-check or override state.
8. At `evaluatedAt >= staleAt`, registry version 6 readiness MUST return
   `source-stale`. Its reserved override fields MUST remain null and
   `degraded` MUST remain false until the typed override command lands.
9. Readiness evaluation MUST be a read. Admission and discovery transactions
    MUST bind the exact evaluated sequence and evidence rather than relying on
    a mutable Boolean cache.
10. Existing admitted work and retained-context reads MUST NOT invoke this as
    an authority precondition.
11. A read-only verification or rollback attempt that does not activate its
    exact target MUST NOT refresh source freshness or clear a blocking outcome.
12. Candidate-rejection audit history MAY supply a failed automatic check only
    when its payload identifies `automatic-source-check`; rollback diagnostics
    MUST NOT affect readiness. Rejection history does not substitute for an
    eligible-check record.
13. An attributed rollback that activates the exact commit in the newest
    unresolved continuity rejection MUST resolve that block without changing
    `lastValidatedAt`.
14. This pre-production schema defines no in-place migration; initialize a
    fresh target database when its registered vocabulary changes.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| Source freshness | `evaluatedAt - lastValidatedAt` for the configured ref |
| Admission readiness | Active authority, latest check outcome, and staleness boundary; reserved override fields are inert in registry version 6 |
| Operator diagnostics | Specific readiness reason plus source-check evidence |

## References

- Rationale:
  [ADR-0046](../adr/0046-separate-core-source-freshness-from-admission-readiness.md),
  [ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md), and
  [ADR-0035](../adr/0035-route-human-authority-through-typed-decisions.md)
- Context: [Core snapshot ingestion](../design/core-snapshot-ingestion.md)
- Activation substrate: [Core snapshot activation](core-snapshot-activation.md)
- Delivery: [Core snapshot ingestion plan](../plans/core-snapshot-ingestion.md)
