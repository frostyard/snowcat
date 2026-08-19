# Spec: Repository authority reconciliation

This contract governs materializing active Core repository declarations,
recording bounded GitHub identity results, and deriving the current repository
state before canonical-surface validation.

## Interface

The host-local commands are:

```sh
npm run --silent repository -- reconcile
npm run --silent repository -- status
```

`reconcile` performs one bounded pass over declarations in path order and emits
the per-repository results. `status` is a read-only projection.

One status row has this logical shape:

| Field | Type | Constraints |
| --- | --- | --- |
| `repositoryId` | string | `github.com:<immutable numeric ID>` |
| `owner`, `name` | string | Active declared locator |
| `coreSnapshotId` | UUIDv7 | Exact active Core snapshot input |
| `coreAuthorizationRecordId` | UUIDv7 or null | Null only while declaration materialization is pending |
| `fleetState` | enum | `enabled`, `paused`, or `disabled` |
| `maintenancePrograms`, `actionCeiling`, `accountableOwners` | arrays | Exact declaration values |
| `surfaceContractVersion` | integer | Currently `1` |
| `authorityContextDigest` | SHA-256 or null | Current semantic enrollment context; non-null only for `enrolled` |
| `githubReconciliationRecordId` | UUIDv7 or null | Applicable result bound to the authority fact |
| `githubResult` | enum or null | `matched`, `missing`, `locator-mismatch`, `identity-mismatch`, `archived`, or `unavailable` |
| `effectiveState` | enum | `awaiting-authority`, `disabled`, `paused`, `awaiting-github`, `github-held`, or `awaiting-surfaces` |

The GitHub adapter output contains only the declared locator and ID, selected
observed locator and ID or null, archive flag or null, one closed result,
`checkedAt`, and a SHA-256 digest of the selected response material.

## Rules

1. Materialization MUST require Core admission readiness and bind the active
   snapshot plus exact expected control-plane transaction sequence.
2. One declaration command MUST append exactly a declaration definition,
   `repository.core-authorized` fact, and reconciliation event. It MUST create
   the source-native subject only on first sight and MUST be idempotent for the
   same snapshot and immutable repository ID.
3. The declaration path, declared ID, and canonical parsed bytes MUST agree
   with the retained active snapshot. Callers cannot supply a declaration.
4. A new Core candidate MUST retain every repository ID in the active snapshot.
   Missing IDs MUST fail candidate validation before activation; changing to
   `disabled` is the removal mechanism.
5. GitHub lookup MUST occur outside SQLite transactions, use one 30-second
   deadline, accept only HTTPS `api.github.com`, follow at most one explicitly
   validated same-origin redirect, and never persist raw responses,
   credentials, headers, or arbitrary error bodies.
6. Matching requires the returned numeric ID to equal the declaration, the
   returned owner/name to equal it case-insensitively, and `archived=false`.
   Failure classification precedence is unavailable, missing, identity
   mismatch, locator mismatch, archived, then matched.
7. One GitHub command MUST append exactly an identity observation,
   `repository.github-identity-reconciled` fact, and reconciliation event. It
   MUST bind the current authorization record, active snapshot, exact expected
   sequence, and selected response digest.
8. A GitHub command for a stale Core authorization fact MUST fail without a
   transaction or observation. A GitHub result MUST NOT change fleet state,
   programs, ceilings, owners, or surface-contract version.
9. Status MUST include every declaration from the active snapshot. Before its
   authority fact exists, it MUST use `awaiting-authority` and a null authority
   record ID; otherwise it MUST derive effective state using the table in the
   design document. `matched` MUST derive `awaiting-surfaces`, never `enrolled`.
   A current `enrolled` chain MUST expose its versioned semantic digest under
   the [held-work recovery contract](repository-held-work-recovery.md); every
   other effective state MUST expose null.
10. No command in this contract may create work, admission, a claim, a lease, a
    worker session, a local hold, or canonical-surface authority.
11. This prior gate now participates in schema version `8` and registry version
    `18`; there is no in-place migration from the pre-production target.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| Effective repository state | Active declaration, latest applicable Core authorization, and an identity result bound to that exact fact |
| GitHub hold explanation | Non-`matched` applicable GitHub result and its selected fields |
| Next reconciliation candidates | Enabled authority facts with no `matched` result for that exact fact |

## References

- Rationale:
  [ADR-0015](../adr/0015-authorize-repository-enrollment-through-core.md),
  [ADR-0050](../adr/0050-reconcile-repository-enrollment-as-separate-facts.md),
  and [ADR-0053](../adr/0053-resume-only-unchanged-transient-held-work.md)
- Context: [repository enrollment](../design/repository-enrollment.md)
- Source authority: [Core snapshot activation](core-snapshot-activation.md)
- Admission gate: [Core source readiness](core-source-readiness.md)
- Next gate: [repository surface reconciliation](repository-surface-reconciliation.md)
- Recovery: [repository held-work recovery](repository-held-work-recovery.md)
- Delivery: [Core snapshot ingestion plan](../plans/core-snapshot-ingestion.md)
