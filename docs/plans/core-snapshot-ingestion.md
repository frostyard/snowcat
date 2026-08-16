# Plan: Core snapshot ingestion

This plan turns the merged core authoring contract into atomic Fluent snapshots
without allowing branch contents or partial records to become authority. It is
the detailed delivery path spanning the core-authoring and durable-control-plane
phases of the [product foundation roadmap](product-foundation-roadmap.md).

## Phase 1 — Verify one exact candidate (completed)

- Implement the read-only bare-mirror, bounded Git object reader, bundled-schema
  parity, strict JSON and schema validation, cross-record checks, fixture parity,
  and deterministic catalog from the
  [ingestion design](../design/core-snapshot-ingestion.md) and
  [verification contract](../specs/core-snapshot-verification.md).
- Add `npm run --silent core -- verify` without connecting it to the target
  database or enrollment logic.
- Exercise the merged core PR #80 revision and preserve its disabled repository
  declaration as input rather than treating it as enrollment.
- **Done when:** commit `eccf4b144b95aa2dcad596231942dce70b4f36ab`
  verifies as a 17-file catalog with three valid fixtures, eight rejection
  fixtures, and one disabled `frostyard/core` declaration; schema drift,
  duplicate live keys, and Git symlinks fail closed.

## Phase 2 — Persist and atomically activate snapshots (large)

- Extend the code-owned control-plane registries with exact Core snapshot,
  source-repository, import-attempt, activation, and failure contracts; expose
  only typed commands.
- Persist raw bytes, parsed records, per-file digests, validation report,
  source/ref/commit/tree identities, import time, and catalog digest in one
  transaction without manufacturing enrollment facts.
- Make equivalent retry of one candidate idempotent and move the active pointer
  only after every record and event succeeds. Preserve every prior snapshot.
- Record rejected candidate diagnostics without advancing the active pointer.
- **Done when:** a failure injected after any snapshot write rolls back all
  candidate authority and leaves the prior active snapshot byte-for-byte and
  sequence-for-sequence unchanged; retry returns the original snapshot identity.

## Phase 3 — Enforce continuity, freshness, and operator recovery (medium)

- Require an automatically activated commit to descend from the active commit.
  Persist a ref rewind or unrelated history as a failed candidate.
- Add attributed operator rollback to an exact verified commit and reason,
  producing a new activation occurrence without deleting history.
- Record fetch/validation health, last successful source check, the 24-hour
  new-admission freshness boundary, and a conspicuous attributed expiring
  stale-source override.
- Add configurable periodic polling over the same typed sync operation; do not
  add a model or webhook requirement.
- **Done when:** tests distinguish unchanged retry, fast-forward activation,
  force-push refusal, explicit rollback, source outage under and over the
  freshness boundary, and locally advancing exception expiry.

## Phase 4 — Materialize repository authority without premature work (large)

- Derive durable repository workstreams only from activated declarations while
  keeping declaration, enrollment, GitHub observation, hold, and work creation
  distinct.
- Reconcile each slug to its immutable GitHub repository ID and required
  canonical surfaces; local failures create the smallest repository hold and do
  not invalidate the Core snapshot.
- Enforce declaration retention as `disabled`, local suspension as narrowing
  only, and explicit reconciliation before held work can resume.
- **Done when:** an enabled declaration in an activated snapshot plus matching
  GitHub identity and required surfaces creates enrollment without work, while
  disabled, paused, missing, renamed, archived, ID-mismatched, or surface-invalid
  cases create no authority to discover, admit, claim, or renew.

## Later / ideas

- Webhook-triggered synchronization after polling behavior and GitHub App
  delivery idempotency are measured.
- A generated human catalog view derived from retained snapshot bytes.

## Open questions

- **Source repository principal:** settle the exact target-registry subject and
  source identity shapes during Phase 2 alongside their typed command payloads;
  do not reuse a display URL as identity.
- **Retention:** set bounded failed-candidate diagnostic and raw snapshot
  retention before unattended polling begins.

## References

- Implements: [core snapshot ingestion](../design/core-snapshot-ingestion.md)
  and [core snapshot verification](../specs/core-snapshot-verification.md)
- Rationale:
  [ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md) and
  [ADR-0015](../adr/0015-authorize-repository-enrollment-through-core.md)
- Parent delivery order: [product foundation roadmap](product-foundation-roadmap.md)
- Target substrate: [control-plane kernel bootstrap](control-plane-kernel-bootstrap.md)
