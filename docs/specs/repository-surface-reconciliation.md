# Spec: Repository surface reconciliation

This contract governs exact-commit loading and validation of canonical
repository surfaces and the separate establishment of repository enrollment.

## Interface

The existing host-local commands remain:

```sh
npm run --silent repository -- reconcile
npm run --silent repository -- status
```

One surface reconciliation result binds:

| Field | Type | Constraints |
| --- | --- | --- |
| `repositoryId` | string | Immutable `github.com:<numeric ID>` |
| `coreAuthorizationRecordId` | UUIDv7 | Current active declaration fact |
| `githubReconciliationRecordId` | UUIDv7 | Current matched identity fact |
| `repositoryCommitId`, `repositoryTreeId` | SHA-1 or null | Both present for a resolved revision |
| `defaultBranch` | string or null | Observed branch locator |
| `surfaceContractVersion`, `governanceSchemaVersion` | integer | Both `1` in v1 |
| `surfaces` | array | Four summaries on `valid`; bounded partial summaries otherwise |
| `governancePolicy` | strict JSON or null | Present only when schema-valid |
| `checkpoint` | string | `repository-enrollment` |
| `decision` | enum | `permit` only for `valid`; otherwise `deny` |
| `requirementResults` | array | Four ordered `pass`, `fail`, or `unknown` results with bounded digest evidence |
| `exceptionRecordIds` | array | Empty in v1; this gate has no exception path |
| `result` | enum | `valid`, `unavailable`, `missing`, `wrong-type`, `invalid`, or `digest-incompatible` |
| `failedSurfaceId` | string or null | First canonical path failure in contract order |
| `checkedAt` | RFC 3339 timestamp | Server evaluation time |

Each summary contains its stable ID, canonical path, artifact type, Git object
ID, SHA-256 content digest, and byte size or immediate tree-entry count. Status
adds surface reconciliation and enrollment record IDs and derives
`awaiting-surfaces`, `surface-held`, `awaiting-enrollment`, or `enrolled` after
the identity states.

## Rules

1. The adapter MUST resolve the observed default branch once, pin one exact
   commit/root tree, and read all surfaces from that commit.
2. Requests MUST use HTTPS `api.github.com`, one shared 30-second deadline, at
   most one validated same-origin redirect per request, bounded response bytes,
   and no repository code execution.
3. The selected contract and governance schema MUST come from retained bytes of
   the active Core snapshot and remain digest-compatible with Fluent's bundled
   v1 contracts.
4. `AGENTS.md`, `policies/agent-governance.json`, and `docs/README.md` MUST be
   regular Git blobs. `.agents/skills` MUST be a Git tree. A symlink, submodule,
   alias, missing object, or wrong type MUST fail the affected repository.
5. Governance MUST be strict UTF-8 JSON without comments, trailing commas, or
   duplicate keys and MUST pass the bundled v1 schema and invariants.
6. The surface command MUST independently revalidate adapter output, bind the
   current matched identity and active authorization facts, and append exactly
   an observation, enrollment-checkpoint policy decision, reconciliation fact,
   and event. It MUST be idempotent for the identity fact and probe digest.
7. `valid` MUST retain four summaries and parsed governance. Other results MUST
   retain only bounded selected evidence; raw GitHub responses, headers,
   credentials, arbitrary error bodies, and unrelated repository content MUST
   never be stored.
8. The policy decision MUST identify the enrollment checkpoint and retain four
   requirements in contract order. Requirements before the first failed
   surface are `pass`, that surface is `fail`, and later requirements are
   `unknown`. An unavailable or digest-incompatible inspection makes all four
   requirements `unknown`. Evidence is limited to validated content digests;
   exceptions are not supported in v1.
9. The enrollment command MUST require Core admission readiness, active
   `fleetState=enabled`, current `matched` identity, and current `valid`
   surfaces. It MUST append a RepositoryController definition, enrollment fact,
   and enrollment event in one idempotent transaction.
10. Enrollment MUST NOT create, admit, claim, lease, renew, or complete work.
11. A newer Core authorization, identity result, default-branch head, or
    surface result MUST make older evidence inapplicable without deleting it.
12. Schema version `5` has no in-place migration from the pre-production target;
    initialize a fresh database. Registry version is `10`.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| Surface hold | Current enabled/matched repository plus non-`valid` surface result |
| Enrollment eligibility | Active authorization plus current matched identity and current valid surfaces |
| Enrolled repository | Enrollment fact bound to all three current prerequisite facts |

## References

- Rationale:
  [ADR-0016](../adr/0016-read-only-canonical-repository-surfaces.md),
  [ADR-0050](../adr/0050-reconcile-repository-enrollment-as-separate-facts.md),
  and [ADR-0051](../adr/0051-pin-surfaces-to-the-observed-default-branch-head.md)
- Context: [repository enrollment](../design/repository-enrollment.md)
- Prior gate: [repository authority reconciliation](repository-authority-reconciliation.md)
- Delivery: [Core snapshot ingestion plan](../plans/core-snapshot-ingestion.md)
