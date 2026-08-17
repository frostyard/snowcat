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

## Phase 2 — Persist and atomically activate snapshots (completed)

- The implemented [activation contract](../specs/core-snapshot-activation.md)
  adds exact Core snapshot, immutable GitHub source, activation predicate,
  occurrence, command, and storage vocabulary without a generic mutation path.
- The typed command independently revalidates and atomically retains raw bytes,
  canonical parsed live repository declarations, per-file digests, validation
  report, source/ref/commit/tree identities, import time, catalog digest,
  definition, active fact, event, receipt, and active pointer without
  manufacturing enrollment facts.
- Equivalent retry returns the original result; failure after retained file
  writes rolls back authority and sequence allocation; every accepted prior
  snapshot remains retained.
- The same [activation contract](../specs/core-snapshot-activation.md) now
  records source, validation, and post-rollback persistence rejection as a
  bounded observation plus audit event. `core verify` stays read-only;
  `core rejections` exposes the newest bounded result set; rejection creates no
  fact and never advances the active pointer.
- **Done when:** rejected fetch/validation/storage attempts have mechanically
  bounded durable diagnostics; a failure injected after any snapshot write
  rolls back all candidate authority and allocation before its separate audit
  transaction; the prior snapshot remains current; and retry returns the
  original snapshot identity.

## Phase 3 — Enforce continuity, freshness, and operator recovery (in progress)

- Automatic activation now requires the Git source adapter to verify that a
  different candidate descends from the active source commit and rebinds that
  exact ancestor under the store writer lock. Rewound, unrelated, and
  unverifiable histories create bounded continuity rejection evidence.
- Attributed operator rollback now creates a resolved typed decision and a new
  snapshot/fact/event transaction for an exact independently revalidated target
  commit and bounded reason. It prefers retained bytes for outage recovery,
  can materialize an unretained exact commit, and never deletes history.
- Automatic configured-ref checks now record eligible outcomes distinctly from
  rollback diagnostics, and the
  [Core source readiness contract](../specs/core-source-readiness.md) derives
  last successful validation, the 24-hour boundary, and immediate invalidity,
  continuity, and persistence blocks at an exact control-plane sequence.
- The implemented attributed stale-source override binds the exact stale
  evidence and active snapshot, lasts at most 24 hours per decision, and
  relaxes only elapsed staleness—never candidate validity, continuity,
  persistence, or the requirement for active authority.
- The implemented leased `CoreSourceController` polls over the same typed sync
  operation at a configurable 15-minute default, applies 30/60-minute source
  outage backoff, suppresses only consecutive equivalent hard-failure detail,
  and requires no model or webhook.
- Retain raw snapshots and their authority history indefinitely; bound ordinary
  eligible-check and candidate-rejection detail before periodic polling can
  create unattended volume.
- The accepted [check-detail retention contract](../specs/core-check-detail-retention.md)
  retains ordinary eligible/rejection detail for 30 days and at most 10,000
  unprotected checks while preserving current-readiness and decision evidence.
- **Done when:** tests distinguish unchanged retry, fast-forward activation,
  force-push refusal, explicit rollback, source outage under and over the
  freshness boundary, and locally advancing exception expiry.

## Phase 4 — Materialize repository authority without premature work (large)

- The implemented first slice materializes each active declaration through one
  idempotent registered transaction, creates a source-native GitHub repository
  subject on first sight, and retains declaration definition and
  `repository.core-authorized` facts without creating work.
- The implemented bounded GitHub metadata adapter and second registered
  transaction classify matching identity, missing locator, changed locator,
  immutable-ID mismatch, archive, and unavailability independently for each
  enabled declaration. Paused and disabled declarations spend no lookup.
- Active-candidate validation now rejects removal of a prior repository ID;
  intentional departure remains an explicit `disabled` declaration, including
  across operator rollback.
- The current read derives `awaiting-authority`, `disabled`, `paused`,
  `awaiting-github`, `github-held`, `awaiting-surfaces`, `surface-held`,
  `awaiting-enrollment`, or `enrolled` from separate current facts.
- Reconcile each slug to its immutable GitHub repository ID and required
  canonical surfaces. Identity is implemented; exact-commit default-branch
  surface loading, policy validation, and separate enrollment establishment are
  implemented. Local failures create the smallest repository result and do not
  invalidate the Core snapshot.
- Enforce declaration retention as `disabled`, local operator hold as narrowing
  only, and explicit reconciliation before held work can resume. Declaration
  retention and the non-expiring attributed local hold are implemented;
  held-work disposition remains.
- **Done when:** an enabled declaration in an activated snapshot plus matching
  GitHub identity and required surfaces creates enrollment without work, while
  disabled, paused, missing, renamed, archived, ID-mismatched, or surface-invalid
  cases create no authority to discover, admit, claim, or renew.

## Later / ideas

- Webhook-triggered synchronization after polling behavior and GitHub App
  delivery idempotency are measured.
- A generated human catalog view derived from retained snapshot bytes.

## Open questions

- None for the implemented source, declaration-authority, and GitHub-identity
  slices. Canonical surfaces follow the already accepted v1 Core contract.

## References

- Implements: [core snapshot ingestion](../design/core-snapshot-ingestion.md),
  [core snapshot verification](../specs/core-snapshot-verification.md), and
  [Core snapshot activation](../specs/core-snapshot-activation.md), and
  [Core source readiness](../specs/core-source-readiness.md), and
  [Core check-detail retention](../specs/core-check-detail-retention.md), and
  [Core source polling](../specs/core-source-polling.md), and
  [repository authority reconciliation](../specs/repository-authority-reconciliation.md), and
  [repository surface reconciliation](../specs/repository-surface-reconciliation.md), and
  [local repository holds](../specs/repository-local-holds.md)
- Rationale:
  [ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md) and
  [ADR-0015](../adr/0015-authorize-repository-enrollment-through-core.md), and
  [ADR-0046](../adr/0046-separate-core-source-freshness-from-admission-readiness.md),
  and [ADR-0047](../adr/0047-cap-stale-source-overrides-at-24-hours.md)
  and [ADR-0048](../adr/0048-retain-core-check-detail-for-30-days.md)
  and [ADR-0049](../adr/0049-poll-core-through-one-leased-controller.md)
  and [ADR-0050](../adr/0050-reconcile-repository-enrollment-as-separate-facts.md)
  and [ADR-0051](../adr/0051-pin-surfaces-to-the-observed-default-branch-head.md)
  and [ADR-0052](../adr/0052-bind-local-repository-holds-to-explicit-operator-decisions.md)
- Parent delivery order: [product foundation roadmap](product-foundation-roadmap.md)
- Target substrate: [control-plane kernel bootstrap](control-plane-kernel-bootstrap.md)
