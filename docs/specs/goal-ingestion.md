# Spec: Goal ingestion

This contract governs Fluent's independent validation and retention of the
version-one Goal records published in a Core authority snapshot. It covers the
import boundary and automatic lifecycle safety. It does not make Goals eligible
for discovery, derive queue priority, execute measures, or admit work.

## Interface

The optional Goal-capable authority extension consists of:

| Path | Cardinality | Constraint |
| --- | --- | --- |
| `organization/schemas/v1/envelope.schema.json` | zero or one | present exactly with the Goal schema |
| `organization/schemas/v1/goal.schema.json` | zero or one | present exactly with the envelope and verification-profile schemas |
| `organization/goals/<id>.json` | zero or more | forbidden unless the complete extension is present |
| `organization/fixtures/v1/valid/goal*.json` | one or more when schemas are present | every fixture passes structural and cross-record validation |
| `organization/fixtures/v1/invalid/goal*.json` | one or more when schemas are present | every fixture fails structural or cross-record validation |

Each structurally validated live Goal contributes its canonical path, raw-byte
digest, and parsed Goal to `goals`; `goalCount` is the array length. A
Goal-capable candidate also reports `schemaDigests.envelope` and
`schemaDigests.goal`. Snapshot definitions add `goalCount` only for this
extension, so historical legacy and profile-only definition payloads retain
their exact prior shapes.

## Rules

1. A legacy or profile-only catalog MUST remain valid when it contains none of
   the Goal schemas, paths, or fixtures.
2. Goal support MUST contain the envelope and Goal schemas together and MUST
   also contain the supported verification-profile schema. Their exact
   supported SHA-256 digests are
   `sha256:07eb4ca0d97de3668e3d71227c675562f69c451647ab5e6fa33e6fe9de80eb5f`
   and
   `sha256:76341409e4dc33fbc50d1432d2488e1ecec767263733939f0abe9bf173aada0b`.
   Parsed fetched content MUST canonically equal the bundled schemas.
3. A Goal MUST be no larger than 65,536 bytes and MUST pass strict UTF-8 JSON,
   duplicate-key rejection, the bundled common envelope, and the Goal schema.
4. The Goal ID MUST match its canonical path. Owner IDs and measure IDs MUST be
   unique. Selected applicability IDs and every measure subject MUST resolve
   to repository declarations in the same live catalog.
5. Goal dates MUST be real UTC calendar dates with start on or before end.
   Observation bounds MUST be canonical UTC millisecond instants with start
   before end. A Goal MUST have at least one required success measure.
6. Every measure MUST resolve one exact live verification profile. Its repeated
   evidence mode MUST match, and its parameters MUST satisfy the profile's
   retained embedded schema.
7. Valid Goal fixtures resolve only fixture repositories and fixture profiles;
   they do not create live authority and do not require executable Fluent
   mechanisms. Live Goals resolve only the live catalog.
8. Before a live Goal can enter a candidate report, every adapter, evaluator,
   or attestation policy named by its profiles MUST have a real versioned entry
   in Fluent's closed implementation registry. The registry currently contains
   `conclusive-run-rate:v1` but no source adapter, so Goal-capable snapshots
   with fixtures and zero live Goals are accepted while the representative live
   Goal is rejected with bounded `github-check-runs:v1` detail.
9. Once implementations permit live Goals, later automatic activation MUST
   retain the envelope and Goal schemas and every historically activated Goal
   path, including after rollback. Goal content may change, but transition from
   the active snapshot MUST follow `planned → active|paused|cancelled`,
   `active → paused|completed|cancelled`, or
   `paused → active|completed|cancelled`; an unchanged status is allowed and
   `completed` and `cancelled` are terminal.
10. An attributed operator rollback MAY select an exact retained older snapshot
    without the Goal extension or with an earlier Goal state. The next automatic
    activation still restores every historically seen Goal and its schemas and
    evaluates lifecycle relative to the currently active rollback snapshot.
11. Successful validation or activation MUST NOT mark a Goal active for work,
    evaluate dates, create discovery, derive priority, collect evidence, change
    lifecycle, admit work, or grant actions.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| Candidate Goal catalog | Canonical live paths plus strict parsed Goals and raw-byte digests |
| Snapshot Goal material | Exact raw files retained with the activated Core catalog |
| Snapshot definition Goal count | Number of executable live Goal records in that snapshot |
| Automatic lifecycle check | Active Goal states plus historical path/schema retention compared with the candidate |
| Focused conformance tests | Legacy, profile-only, Goal fixtures, unsupported live Goal, and transition cases in `test/core-source.test.ts` |

## References

- Rationale:
  [ADR-0009](../adr/0009-apply-goals-through-discovery-and-admission.md),
  [ADR-0013](../adr/0013-author-organization-records-as-strict-json.md), and
  [ADR-0054](../adr/0054-bind-success-measures-to-versioned-verification-profiles.md)
- Context:
  [Core snapshot ingestion](../design/core-snapshot-ingestion.md) and
  [success-measure verification](../design/success-measure-verification.md)
- Supporting contract:
  [verification-profile ingestion](verification-profile-ingestion.md) and the
  [conclusive-run-rate evaluator](conclusive-run-rate-evaluator.md)
- Producer contract:
  [Core organization goals](https://github.com/frostyard/core/blob/main/docs/specs/organization-goals.md)
- Delivery: [Core snapshot ingestion plan](../plans/core-snapshot-ingestion.md)
