# Spec: Verification-profile ingestion

This contract governs Fluent's independent validation and retention of the
versioned verification-profile definitions published in a Core authority
snapshot. It covers import compatibility and profile immutability, not goal
activation or execution of verification mechanisms.

## Interface

The optional profile-capable authority extension consists of:

| Path | Cardinality | Constraint |
| --- | --- | --- |
| `organization/schemas/v1/verification-profile.schema.json` | zero or one | when present, exact bytes and canonical JSON MUST match Fluent's bundled schema |
| `organization/contracts/verification-profiles/<id>/v<version>.json` | zero or more | forbidden unless the profile schema is present |
| `organization/fixtures/v1/valid/verification-profile*.json` | one or more when schema present | every fixture MUST pass the live validation path |
| `organization/fixtures/v1/invalid/verification-profile*.json` | one or more when schema present | every fixture MUST fail the live validation path |

Each validated profile contributes this candidate-report entry:

```json
{
  "path": "organization/contracts/verification-profiles/required-check-reliability/v1.json",
  "contentDigest": "sha256:<64-lowercase-hex>",
  "profile": {}
}
```

The candidate report adds `verificationProfileCount`,
`verificationProfiles`, and, when the extension exists,
`schemaDigests.verificationProfile`. A new `core.snapshot-definition` payload
adds `verificationProfileCount`; startup continues to accept exact historical
payloads without that field and with the original three schema digests.

## Rules

1. A catalog without the profile schema, profile paths, or profile fixtures
   MUST remain valid when it satisfies the legacy Core snapshot contract.
2. A profile or profile fixture without the exact supported profile schema MUST
   reject the candidate.
3. The supported schema byte digest MUST be
   `sha256:5562df1740d133ff32a7bcfc488907b3783a3eda9ba8e8e1d9559a07f44a4507`.
   Parsed fetched content MUST also canonically equal the bundled schema.
4. A profile MUST be no larger than 65,536 bytes and MUST pass strict UTF-8
   JSON parsing, duplicate-key rejection, the bundled schema, and the
   cross-field invariants below.
5. Profile ID and positive integer version MUST match the canonical path. The
   mode MUST match its mechanism kind as enforced by the bundled schema.
6. `parameter_schema` MUST declare Draft 2020-12, its exact canonical profile-
   specific `$id`, `type: "object"`, and `additionalProperties: false`.
7. `$ref`, `$dynamicRef`, and `$recursiveRef` values MUST be document-local.
   Nested `$id` and `$schema` are forbidden. The schema MUST compile under the
   pinned strict Ajv 2020 implementation without loading another resource.
8. A profile-capable catalog MUST contain at least one accepted and one
   rejected verification-profile fixture. Fixtures use the same schema, size,
   and invariant checks as live profiles.
9. Every live `(profile.id, profile.version)` MUST be unique. The report MUST
   retain its path, raw-byte digest, and parsed value, while the Core snapshot
   retains its exact raw bytes with the rest of the catalog.
10. Every automatic activation MUST compare the candidate with all retained
    profile-capable snapshot history. It MUST retain the profile schema and
    every historically activated profile identity with the same content digest,
    including after rollback. Removal or mutation is a candidate validation
    rejection.
11. An attributed operator rollback MAY activate a retained older snapshot
    without the extension. Reapplying a later descendant still requires normal
    validation and continuity.
12. Profile validation MUST NOT execute a mechanism, claim that Fluent supports
    a binding, collect evidence, establish a result, activate a goal, admit
    work, or change enrollment.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| Candidate profile catalog | Canonical live paths plus strict parsed profiles and raw-byte digests |
| Snapshot profile material | Existing raw-file retention for the activated Core catalog |
| Snapshot definition profile count | Number of validated live profile definitions |
| Automatic retention check | Active profile schema and `(id, version, digest)` compared with the candidate |
| Focused conformance tests | Legacy, extension, live-profile, schema-retention, and profile-retention cases in `test/core-source.test.ts` |

## References

- Rationale:
  [ADR-0054](../adr/0054-bind-success-measures-to-versioned-verification-profiles.md)
- Context:
  [success-measure verification](../design/success-measure-verification.md) and
  [Core snapshot ingestion](../design/core-snapshot-ingestion.md)
- Producer contract:
  [Core organization verification profiles](https://github.com/frostyard/core/blob/main/docs/specs/organization-verification-profiles.md)
- Delivery: [product foundation roadmap](../plans/product-foundation-roadmap.md)
- Consumer: [Goal ingestion](goal-ingestion.md)
