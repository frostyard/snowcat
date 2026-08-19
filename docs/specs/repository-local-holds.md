# Spec: Local repository holds

This contract governs the host-local operator commands that impose and clear
one immediate repository safety hold without changing Core authority.

## Interface

```sh
npm run --silent repository -- hold <expected-control-plane-sequence> <github.com:id> <reason>
npm run --silent repository -- clear-hold <expected-control-plane-sequence> <github.com:id> <hold-decision-id> <reason>
```

Each decision payload contains:

| Field | Type | Constraints |
| --- | --- | --- |
| `decisionRecordId` | UUIDv7 | Current resolved decision |
| `eventRecordId` | UUIDv7 | Past-tense event emitted with the decision |
| `decisionType` | string | `repository-local-hold` |
| `state` | string | `resolved` |
| `choice` | enum | `impose` or `clear` |
| `repositoryId` | string | Immutable `github.com:<numeric ID>` |
| `coreSnapshotId`, `coreAuthorizationRecordId` | UUIDv7 | Current materialized Core authority |
| `declarationDigest` | SHA-256 | Exact declaration being narrowed |
| `operatorPrincipalId` | UUIDv7 | Stored v1 local operator |
| `holdDecisionId` | UUIDv7 | Root `impose` decision; equals `decisionRecordId` on impose |
| `previousDecisionRecordId` | UUIDv7 or null | Null on impose; exact active hold on clear |
| `affectedGates` | array | Exactly `discovery`, `admission`, `claim`, `lease-renewal` in that order |
| `recoveryRule` | string | `operator-clear` |
| `reason` | string | Trimmed, single-line, 1–512 UTF-8 bytes |
| `expectedLastTransactionSequence` | integer | Exact positive pre-command sequence |
| `decidedAt` | UTC instant | Server decision time |

An impose transaction emits `repository.operator-hold-decision` and
`repository.operator-hold-imposed`. A clear transaction emits
`repository.operator-hold-decision` and `repository.operator-hold-cleared`.

Status includes the complete active decision as `operatorHold`, or `null`, and
derives `operator-held` only after current Core authority is materialized.

## Rules

1. Both commands MUST execute as the stored `operator-principal`, use optimistic
   control-plane sequence concurrency, and return an identical receipt for an
   identical retry.
2. Both commands MUST require a materialized repository authorization from the
   active Core snapshot. They MUST NOT create or broaden repository authority.
3. Impose MUST fail when another local operator hold is active. Clear MUST name
   the exact active root hold and MUST fail for a stale, cleared, or different
   repository hold.
4. The hold MUST have all four fixed affected gates, no expiry, and only the
   `operator-clear` recovery rule.
5. A newer Core snapshot MUST NOT clear the hold. Status MUST keep showing it
   while new Core authority awaits materialization.
6. An applicable hold MUST prevent RepositoryController GitHub inspection,
   surface inspection, and enrollment establishment. A direct enrollment
   command MUST reject it independently.
7. Clear MUST remove only the named local hold. It MUST NOT clear another hold,
   Core lifecycle state, external failure, policy denial, or held work.
8. Hold and clear decisions and events MUST be append-only, source-attributed,
   exact-declaration-bound, and verified on startup. No worker surface may
   impose or clear them.
9. Registry version `18` has no in-place migration from the pre-production
   target; initialize a fresh database. Physical schema remains version `8`.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| Active operator hold | Latest valid decision for the repository is `impose` |
| Effective repository state | `operator-held` when current authority exists and the active hold applies |
| Controller eligibility | False whenever an active operator hold applies |

## References

- Rationale:
  [ADR-0015](../adr/0015-authorize-repository-enrollment-through-core.md),
  [ADR-0038](../adr/0038-separate-lifecycle-pause-from-runtime-interventions.md),
  and [ADR-0052](../adr/0052-bind-local-repository-holds-to-explicit-operator-decisions.md)
- Context: [repository enrollment](../design/repository-enrollment.md)
- Delivery: [Core snapshot ingestion plan](../plans/core-snapshot-ingestion.md)
