# Repository enrollment

Living document. Rationale:
[ADR-0015](../adr/0015-authorize-repository-enrollment-through-core.md) and
[ADR-0050](../adr/0050-reconcile-repository-enrollment-as-separate-facts.md),
and [ADR-0051](../adr/0051-pin-surfaces-to-the-observed-default-branch-head.md),
and [ADR-0052](../adr/0052-bind-local-repository-holds-to-explicit-operator-decisions.md).
Contracts:
[repository authority reconciliation](../specs/repository-authority-reconciliation.md)
and [repository surface reconciliation](../specs/repository-surface-reconciliation.md),
and [local repository holds](../specs/repository-local-holds.md).

## Overview

Repository reconciliation progressively establishes independent authority and
external-evidence facts for one immutable GitHub repository identity. The
current implementation carries declarations through identity reconciliation,
canonical-surface validation, and separate enrollment establishment without
creating work.

```text
active Core snapshot
        │
        ▼
repository.core-authorized ──► GitHub metadata lookup
                                      │
                                      ▼
                       repository.github-identity-reconciled
                                      │
                                      ▼
                    effective repository state projection
                                      │
                                      ▼
                       canonical surface validation
                                      │
                                      ▼
                         repository enrollment
```

## Design

The `RepositoryReconciler` is deterministic orchestration, not a worker or
authority source. It reads the active snapshot's canonical parsed repository
declarations, materializes each through one typed command, performs no network
call while SQLite holds a transaction, and for each enabled declaration submits
one bounded GitHub result through a second typed command. Paused and disabled
declarations require no lookup until a later Core revision enables them.

The declaration command creates the source-native `github-repository` subject
on first sight. Every active declaration revision gets an immutable definition,
a `repository.core-authorized` fact, and a past-tense event. Repeating the same
snapshot/repository pair returns its receipt.

The GitHub adapter requests only `api.github.com/repos/<owner>/<name>`, follows
at most one explicitly validated same-origin GitHub API redirect, and selects
the numeric ID, returned owner/name, and archive flag. One 30-second deadline
covers both requests. It classifies timeouts, transport failures, rate limits,
authorization failures, unsafe or repeated redirects, and unexpected responses
as bounded `unavailable` observations. The typed command binds that observation
to the current Core authorization fact; stale results cannot attach to a newer
declaration.

The effective-state read is derived rather than stored as a universal status:

| Core fleet state | Applicable GitHub result | Effective state |
| --- | --- | --- |
| declaration not yet materialized | none | `awaiting-authority` |
| `disabled` | any or none | `disabled` |
| `paused` | any or none | `paused` |
| `enabled` | none | `awaiting-github` |
| `enabled` | anything except `matched` | `github-held` |
| `enabled` | `matched` | `awaiting-surfaces` |

An independently active operator repository hold derives `operator-held` once
the current Core authority is materialized, regardless of identity, surface,
or enrollment history. Status still exposes each underlying fact separately.

After a matched identity, the RepositoryReconciler observes the default branch,
pins its head commit once, and loads each canonical path through bounded GitHub
Git data requests. The active Core snapshot supplies the exact v1 surface
contract and governance schema. The store independently revalidates the probe
and records an enrollment-checkpoint policy decision. Non-valid results derive
`surface-held`; valid evidence derives `awaiting-enrollment` until the separate
enrollment command creates the RepositoryController definition,
`repository.enrolled` fact, and event. That final state is `enrolled` and still
creates no work.

The local hold commands append resolved operator decisions rather than
changing Core or enrollment facts. One non-expiring hold blocks discovery,
admission, claims, and renewal until a clear decision names that exact hold.
RepositoryController skips both GitHub adapters while it applies, and direct
enrollment independently rejects it. A Core revision neither clears nor hides
the hold; clearing restores only the authority that remains applicable.

Core admission readiness gates declaration materialization. Existing facts
remain readable when readiness later becomes false. GitHub reconciliation can
only consume an already-materialized fact from the active snapshot and cannot
broaden the declaration's programs or action ceiling.

## Operational notes

`npm run --silent repository -- reconcile` runs one convergence pass.
`npm run --silent repository -- status` performs no network or authority write.
`FLUENT_GITHUB_TOKEN` is optional for public repositories and is sent only as a
Bearer header; it is never logged or stored. `FLUENT_GITHUB_API_URL` is fixed to
`https://api.github.com` outside explicit test adapters.

An interrupted pass may leave later repositories visibly `awaiting-authority`,
`awaiting-surfaces`, or `awaiting-enrollment`. Rerunning converges through
command receipts. GitHub and surface `unavailable` results are durable and
retryable. Held-work reconciliation remains a subsequent narrowing control.

## References

- Rationale:
  [ADR-0015](../adr/0015-authorize-repository-enrollment-through-core.md),
  [ADR-0039](../adr/0039-use-typed-source-native-subject-identities.md),
  [ADR-0040](../adr/0040-establish-facts-through-registered-predicate-contracts.md),
  [ADR-0050](../adr/0050-reconcile-repository-enrollment-as-separate-facts.md),
  and [ADR-0051](../adr/0051-pin-surfaces-to-the-observed-default-branch-head.md)
  and [ADR-0052](../adr/0052-bind-local-repository-holds-to-explicit-operator-decisions.md)
- Contracts:
  [repository authority reconciliation](../specs/repository-authority-reconciliation.md)
  and [repository surface reconciliation](../specs/repository-surface-reconciliation.md)
  and [local repository holds](../specs/repository-local-holds.md)
- Built in:
  [Core snapshot ingestion plan — Phase 4](../plans/core-snapshot-ingestion.md#phase-4-materialize-repository-authority-without-premature-work-large)
