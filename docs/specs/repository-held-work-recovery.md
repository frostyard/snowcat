# Spec: Repository held-work recovery

This contract governs the stable repository authority-context digest and the
deterministic recovery decision consumed by target-native work coordination.
The current slice implements digest projection and recovery evaluation; target
work persistence and operator decision commands land with the target work
lineage.

## Interface

An enrolled repository status exposes:

| Field | Type | Constraints |
| --- | --- | --- |
| `authorityContextDigest` | SHA-256 or null | Non-null only when effective state is `enrolled`; `sha256:` plus 64 lowercase hexadecimal characters |

Digest schema version 1 canonicalizes these semantic inputs:

| Group | Inputs |
| --- | --- |
| Core | Snapshot ID, source commit, declaration path and digest, owner/name, accountable owners, fleet state, maintenance programs, action ceiling, surface-contract version |
| GitHub | Declared and observed identity, archive flag, default branch, selected metadata response digest |
| Surfaces | Default branch, repository commit and tree, contract/schema versions and digests, surface summaries, governance policy, checkpoint decision, requirement results, exception IDs, probe digest |
| Enrollment | Repository commit, surface-contract version, maintenance programs, action ceiling |

`evaluateRepositoryHeldWorkRecovery` consumes the stored hold cause, the
work-bound digest, current digest or null, and current repository state. It
returns exactly one of:

| Decision | Reason | Meaning |
| --- | --- | --- |
| `remain-held` | `repository-not-enrolled` | Recovery prerequisites do not currently pass |
| `resume-automatically` | `unchanged-transient-outage` | Sole cause was GitHub or surface `unavailable`, repository is enrolled, and digests match |
| `require-operator-disposition` | `authority-context-changed` | Current and work-bound digests differ |
| `require-operator-disposition` | `non-transient-hold` | Context matches but the cause was intentional or substantive |

## Rules

1. The digest MUST use canonical JSON and digest schema version `1`.
2. Record IDs, event IDs, decision IDs, evaluation/check times, and retry
   occurrence order MUST NOT enter the digest.
3. The digest MUST be null unless the current authority, matched GitHub fact,
   valid permitted surface fact, and enrollment fact form one coherent current
   chain and effective repository state is `enrolled`.
4. Equivalent GitHub- or surface-unavailable recovery against the same
   semantic inputs MUST reproduce the prior digest and MAY auto-resume.
5. A Core snapshot change, declaration change, repository commit change,
   contract or checkpoint change, program change, or action-ceiling change MUST
   change the digest.
6. Only causes `github-unavailable` and `surfaces-unavailable` MAY produce
   `resume-automatically`. Core pause/disable, operator hold, substantive
   GitHub/surface failure, and known context change MUST require per-item
   operator disposition even when the digest matches.
7. A null digest or non-enrolled repository MUST keep work held and MUST NOT
   create an operator decision by itself.
8. This contract does not mutate work, clear a repository condition, create an
   enrollment, or implement the future target-work decision record.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| Repository authority-context digest | Canonical semantic projection of one current enrollment chain |
| Held-work recovery classification | Closed deterministic reduction over cause, prior/current digests, and current repository state |

## References

- Rationale: [ADR-0053](../adr/0053-resume-only-unchanged-transient-held-work.md)
- Context: [repository enrollment](../design/repository-enrollment.md)
- Delivery: [control-plane kernel bootstrap](../plans/control-plane-kernel-bootstrap.md)

