# Repository enrollment

Living document. Rationale:
[ADR-0015](../adr/0015-authorize-repository-enrollment-through-core.md) and
[ADR-0050](../adr/0050-reconcile-repository-enrollment-as-separate-facts.md).
Contracts:
[repository authority reconciliation](../specs/repository-authority-reconciliation.md).

## Overview

Repository reconciliation progressively establishes independent authority and
external-evidence facts for one immutable GitHub repository identity. The
current implementation stops after identity reconciliation; canonical-surface
validation is the next enrollment gate and no current result is named
`enrolled`.

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
                       canonical surfaces (next slice)
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

An interrupted pass may leave later repositories visibly `awaiting-authority`.
Rerunning converges through command receipts. A GitHub `unavailable` result is
durable and retryable. Matching identity still does not permit discovery,
admission, claim, or renewal until the canonical-surface and remaining hold
contracts are implemented.

## References

- Rationale:
  [ADR-0015](../adr/0015-authorize-repository-enrollment-through-core.md),
  [ADR-0039](../adr/0039-use-typed-source-native-subject-identities.md),
  [ADR-0040](../adr/0040-establish-facts-through-registered-predicate-contracts.md),
  and [ADR-0050](../adr/0050-reconcile-repository-enrollment-as-separate-facts.md)
- Contracts:
  [repository authority reconciliation](../specs/repository-authority-reconciliation.md)
- Built in:
  [Core snapshot ingestion plan — Phase 4](../plans/core-snapshot-ingestion.md#phase-4-materialize-repository-authority-without-premature-work-large)
