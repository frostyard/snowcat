# Plan: Control-plane kernel bootstrap

This plan replaces the disposable queue-spike database with a clean
fact-oriented control-plane kernel under
[ADR-0044](../adr/0044-replace-the-queue-spike-database.md). It is the detailed
delivery plan for Phases 1 and 3 of the
[product foundation roadmap](product-foundation-roadmap.md); the implemented
[queue execution boundary](../design/queue-execution-boundary.md) and
[work-queue contract](../specs/work-queue.md) remain the live prototype until
the bounded cutover in Phase 5 below.

## Phase 1 — Specify the clean kernel boundary (medium)

- The first executable substrate slice is documented by the current
  [control-plane kernel design](../design/control-plane-kernel.md) and
  [kernel specification](../specs/control-plane-kernel.md). It implements
  database identity, a distinct stable implicit operator principal, current
  registry version 6, ordered initialization occurrences, and fail-closed startup; later
  Phase 1 fields and registries remain open.
- Define the smallest v1 registries and exact envelopes required by
  [ADRs 0037–0043](../adr/0037-store-facts-with-a-separate-event-ledger.md):
  subject and revision kinds, record classes, predicates and establishment
  paths, decisions, events, information classes, transaction sequence and
  position, idempotency receipts, and projection contracts.
- Classify each target concept as definition, assertion, observation, evidence
  reference, fact, decision, operational state, projection, or event. Use the
  current queue only as a source of behavioral lessons; do not write a legacy
  field mapping or import contract.
- Define a new database identity and configuration boundary. Opening a target
  database must never discover, migrate, attach, or write a spike database.
- Begin the target design and implementing specs in the first code change so
  those living documents describe code that actually exists. Keep the current
  queue design and spec unchanged until its runtime behavior changes.
- **Done when:** every field in the first target schema has one canonical class,
  registry owner, authority rule, information class, and time/order meaning;
  an empty database is the only accepted initialization input.

## Phase 2 — Build the authoritative record spine (large)

- Extend the initialized relational spine in the
  [control-plane kernel specification](../specs/control-plane-kernel.md); do not
  replace its closed registries with a generic record-writing surface.
- The first registered post-bootstrap command now records a sequence-bound
  SQLite integrity observation and event, with optimistic concurrency,
  idempotent replay, strict backward-clock refusal, and atomic rollback. General
  authenticated command binding and fact establishment remain open.
- The first bounded predicate path now retains and activates verified Core
  snapshots through the
  [Core snapshot activation contract](../specs/core-snapshot-activation.md).
  It exercises source-native identity, exact byte retention, fact precedence,
  and rollback without exposing a generic fact writer or creating enrollment.
- Implement fresh SQLite tables and transactional command primitives for
  database lineage, transaction sequence, subjects, typed durable records,
  facts, operational history events, and idempotency receipts.
- Allocate one transaction sequence after acquiring the writer transaction and
  deterministic positions within it. Capture one evaluation time, assign
  server-controlled recorded time, and enforce the half-open expiry rule.
- Reject unknown subject, revision, record, schema, predicate, event, and
  information-class kinds at their authority boundaries.
- Make accepted commands atomic and equivalent idempotent replays return their
  original record identities, transaction coordinates, and result without
  re-evaluation.
- Test clock rollback, sequence gaps, process restart, concurrent writers,
  newer-schema refusal, failed transactions, and secret-safe logging.
- **Done when:** two concurrent processes can execute the registered fixture
  commands without duplicate effects or reused order, and a rejected or rolled-
  back command leaves no partial durable record or event.

## Phase 3 — Add rebuildable read models and recovery (medium)

- The first Phase 3 slice now implements registered immutable projection
  generations with source sequence and content digests, atomic shadow
  publication, explicit health, class/scope filtering, current-source recheck,
  and projection-only repair. It has no operational-state source yet because no
  target operational state exists.
- The implemented subject lookup and payload-free event cursor rebuild from
  authoritative subjects, definitions, and events. Tests prove staleness is
  conservative, access is filtered, corruption fails the read closed, failed
  publication preserves old heads, and deleting all disposable rows followed
  by repair leaves source history unchanged.
- Target-native online backup, integrity verification, authoritative content
  manifests, and create-only restore staging now preserve lineage and reject a
  backup below the caller's highest previously visible transaction sequence.
  The staged artifact proves its next allocation without overwriting or
  activating a live path.
- Define the offline operator activation, rollback, encryption, retention, and
  location procedures before deployment. Activation must consume a verified
  staged artifact and cannot weaken the sequence fence.
- Extend current-source recheck to authenticated principals, sessions, grants,
  and repository scopes when those authoritative inputs exist. Current internal
  projection reads accept only an already-derived class ceiling and deployment
  scope and cannot authorize a mutation.
- The host-local `npm run --silent control` interface now exposes metadata, the registered
  integrity command, projection health/rebuild/repair, online backup, manifest
  verification, and create-only restore staging as JSON. It deliberately does
  not activate a restore or expose worker/domain mutation.
- **Done when:** deleting all projection rows and rebuilding them produces the
  same versioned outputs at the same source watermark, and a verified backup
  restores the same authoritative records and next transaction sequence.

## Phase 4 — Reimplement one target-native work lineage (large)

- Implement one bounded lineage from an immutable work definition through
  source authorization, admission, ready-inventory candidacy, transactional
  claim recheck, bound worker attempt and lease, attempt report, and a proposed
  child. Keep completion evidence distinct from outcome facts.
- Use explicit fixture identities for automated tests. Production claimability
  must wait for the roadmap's core enrollment, immutable GitHub repository
  reconciliation, authenticated session, and worker-grant prerequisites; a slug
  or caller-supplied worker string cannot substitute for them.
- Reimplement only worker-facing behavior that remains valid under the target
  model. Any MCP contract change lands with code, updates the current design and
  spec, and updates the portable
  [`work-fluent-queue`](../../.agents/skills/work-fluent-queue/SKILL.md) skill in
  the same change.
- Exercise duplicate claims, lease expiry and renewal, action ceilings,
  information access, bounded follow-up creation, cancellation, and failed
  authority rechecks under concurrent writers.
- **Done when:** a test worker with a bound session and grant can complete one
  target-native lineage while an otherwise identical stale, unauthorized,
  over-capacity, held, or information-ineligible claim creates no attempt or
  lease.

## Phase 5 — Cut over without importing spike records (medium)

- Do not begin until the target work path and the roadmap prerequisites used by
  its authority checks are production-ready.
- Run the [ADR-0044](../adr/0044-replace-the-queue-spike-database.md) cutover:
  freeze spike mutation, resolve or abandon active leases, verify a read-only
  backup, initialize an empty target database, switch configuration, and smoke
  test one operator-authored item through the real worker interface.
- Re-author any still-useful objective through current target authority. Never
  copy a spike row, identifier, timestamp, event sequence, actor string, result,
  lease, or admission flag into a target record.
- Keep the archived spike database outside the live runtime and provide an
  operator-visible way to distinguish the archive from the active target
  database.
- **Done when:** production workers use only the target database, the runtime
  has no code path that reads or writes the archive, one real target lineage
  succeeds, and restoring either pre-cutover state is documented and tested.

## Phase 6 — Retire the prototype implementation (small)

- Remove the spike store and prototype-only commands after the observation
  window, while retaining any still-applicable behavioral tests against the
  target contract.
- Remove transitional configuration and make startup fail clearly when pointed
  at a spike database rather than attempting conversion.
- Remove the archived database only through the approved retention procedure;
  report what was removed and whether another verified backup remains.
- Update the live design, spec, PRD inventory, roadmap, operator documentation,
  and domain implementation notes to describe only the target runtime.
- **Done when:** no shipped code depends on the spike schema, the full check
  passes from a clean target database, and documentation no longer presents the
  prototype as the live implementation.

## Later / ideas

- A standalone archaeology tool may render a secret-safe spike archive for
  debugging if real demand appears. It must not share code paths or identities
  with target ingestion.

## Open questions

- **Target database binding:** decide whether Node's built-in SQLite API is
  acceptable before Phase 2 production code; this does not change the accepted
  single-host SQLite boundary.
- **Archive retention:** choose the encrypted backup location and deletion date
  before Phase 5. Retention must be finite and the archive must never be mounted
  by the live runtime.
- **MCP compatibility:** identify which current response fields are genuinely
  useful to workers during Phase 4. Compatibility is selected field by field,
  not inferred from the spike schema.

## References

- Product: [GitHub organization agent fleet](../prd/agent-fleet.md)
- Decisions:
  [ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md),
  [ADR-0039](../adr/0039-use-typed-source-native-subject-identities.md),
  [ADR-0040](../adr/0040-establish-facts-through-registered-predicate-contracts.md),
  [ADR-0041](../adr/0041-enforce-three-information-classes-and-scoped-access.md),
  [ADR-0042](../adr/0042-use-rebuildable-projections-only-as-read-models.md),
  [ADR-0043](../adr/0043-order-records-by-transaction-sequence-not-timestamps.md),
  and [ADR-0044](../adr/0044-replace-the-queue-spike-database.md)
- Replaces the persistence implementation behind:
  [queue execution boundary](../design/queue-execution-boundary.md) and
  [work queue](../specs/work-queue.md)
- Current target substrate:
  [control-plane kernel](../design/control-plane-kernel.md) and
  [control-plane kernel specification](../specs/control-plane-kernel.md)
- Delivery order: [product foundation roadmap](product-foundation-roadmap.md)
- Completed predecessor: [queue vertical spike](queue-vertical-spike.md)
