# Control-plane kernel

Living document. Rationale:
[ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md) through
[ADR-0044](../adr/0044-replace-the-queue-spike-database.md) and
[ADR-0046](../adr/0046-separate-core-source-freshness-from-admission-readiness.md),
[ADR-0047](../adr/0047-cap-stale-source-overrides-at-24-hours.md), and
[ADR-0048](../adr/0048-retain-core-check-detail-for-30-days.md), plus
[ADR-0049](../adr/0049-poll-core-through-one-leased-controller.md), and
[ADR-0050](../adr/0050-reconcile-repository-enrollment-as-separate-facts.md),
[ADR-0051](../adr/0051-pin-surfaces-to-the-observed-default-branch-head.md),
and [ADR-0052](../adr/0052-bind-local-repository-holds-to-explicit-operator-decisions.md),
and [ADR-0053](../adr/0053-resume-only-unchanged-transient-held-work.md).
Contracts: [control-plane kernel](../specs/control-plane-kernel.md) and
[Core source readiness](../specs/core-source-readiness.md), plus
[Core check-detail retention](../specs/core-check-detail-retention.md) and
[Core source polling](../specs/core-source-polling.md), plus
[repository authority reconciliation](../specs/repository-authority-reconciliation.md),
[repository surface reconciliation](../specs/repository-surface-reconciliation.md),
and [local repository holds](../specs/repository-local-holds.md), and
[held-work recovery](../specs/repository-held-work-recovery.md).

## Overview

The control-plane kernel is the separately identified SQLite store that will
hold Fluent's typed authoritative records, operational history, and rebuildable
read models. The implemented slices initialize the kernel and one stable
implicit local-operator principal, execute one system integrity command, and
publish subject-lookup and event-cursor projection generations. The current
kernel also retains and activates verified Core snapshots through one
registered fact predicate and separately materializes Core repository authority
and bounded GitHub identity facts, canonical-surface decisions, enrollment,
local repository holds, and semantic authority-context digests. It does not yet
expose target work admission, sessions, grants, or worker operations.
The GitHub-source slice now accepts verified webhook deliveries, bounded App
delivery-list/detail acquisitions, receipt-free API repair observations, and
checkpoint/gap/repair transactions. Content gaps close only when exact affected
delivery identities match retained API audits and a complete audit restores
interval continuity. A single App-wide operational schedule now leases and runs
the bounded acquisition without holding the SQLite writer; applying its result
to repository checkpoints and gaps remains a separate controller step.
Production listener lifecycle remains outside the implemented slice.

```text
empty target file
      │
      ▼
ControlPlaneStore ──► code-owned closed registries
      │
      ├──► database definition (record, position 0)
      ├──► operator definition (record, position 1)
      └──► initialization event (event, position 2)
                 one committed transaction sequence
      │
      └──► immutable projection shadows ──► atomic active heads
```

The queue database — the v1 work engine under
[ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md) — stays
independent. The kernel uses another path, SQLite application ID, schema
lineage, and table set, and refuses a queue file before changing it. The
kernel is the authority and observation sidecar; its only coupling to the
queue is the claim-eligibility hook.

## Design

### Database boundary

[`ControlPlaneStore`](../../src/control/store.ts) owns the target database.
`FLUENT_CONTROL_DB` selects its path and defaults to
`./data/control-plane.db`; `FLUENT_QUEUE_DB` selects the queue. The path
helper rejects equal resolved paths, while store startup also recognizes the
queue tables and refuses to initialize over them.

The target file identifies itself with SQLite application ID `1179405908`
(`FLNT`), `PRAGMA user_version = 8`, a server-generated UUIDv7 database-lineage
ID, a separately generated UUIDv7 operator-principal ID, schema version,
registry version, control-time watermark, and last committed transaction
sequence. Opening a current database validates those values and performs no
schema write. Older, newer, incomplete, augmented, or differently identified
schemas fail rather than being guessed or upgraded by this slice.

### Closed registries

[`registry.ts`](../../src/control/registry.ts) is the only owner of the current
kernel vocabulary. Registry version 18 contains the bootstrap, Core snapshot,
source-check, rollback, repository-reconciliation, enrollment, local
repository-hold, and initial GitHub-observation identity contracts:

| Registry | Initial member | Meaning |
| --- | --- | --- |
| Subject kind | `control-plane-database` | One Fluent-native database lineage with UUIDv7 identity |
| Subject kind | `operator-principal` | The stable human-authority identity implicitly bound by local stdio |
| Subject kind | `core-snapshot` | One Fluent-native retained catalog identity with UUIDv7 identity |
| Subject kind | `github-repository` | One immutable source-native GitHub repository identity |
| Subject kinds | `github-app-hook`, `github-pull-request`, `github-check-run`, `github-commit-status` | Exact source-native GitHub observation identities qualified by App or immutable repository identity |
| Revision kind | `sha256`, `transaction-sequence`, `core-catalog-sha256`, `git-commit-sha1` | Exact payload, database-state, catalog, or source-commit identity |
| Source kind | `fluent-system` / `kernel` or `github-observer` | The deterministic kernel bootstrap or GitHub reconciliation source; neither impersonates GitHub acquisition |
| Source kind | `github-repository` | Immutable GitHub repository ID plus typed Git commit revision |
| Source kind | `operator-principal` | Stored UUIDv7 human authority with no caller-selected revision |
| Source kind | `github-api` | Bounded selected metadata from `api.github.com` |
| Source kind | `github-app-webhook` | Direct authenticated App-hook delivery bytes, mechanically separate from API repair |
| Record kind | `control-plane.database-definition` v1 | An `organization`-class definition of the database lineage and schema/registry versions |
| Record kind | `principal.definition` v1 | The `organization`-class definition of the implicit local operator |
| Record kind | `control-plane.integrity-observation` v1 | The system's SQLite quick-check observation bound to the checked sequence |
| Record kind | `core.snapshot-definition` v1 | Definition of one retained validated catalog and its source/report |
| Record kind | `core.snapshot-active` v1 | Current-snapshot fact on the database subject |
| Record kind | `core.candidate-rejection-observation` v1 | Bounded non-authoritative source/validation/continuity/persistence diagnostic |
| Record kind | `core.source-check-eligible-observation` v1 | Configured-ref check that exactly matches active authority |
| Record kind | `core.stale-source-override-decision` v1 | Resolved operator choice bound to stale evidence, active snapshot, and expiry |
| Record kind | `core.rollback-decision` v1 | Resolved operator choice bound to exact prior Core authority, target commit, and reason |
| Record kinds | `repository.*` v1 | Exact authority, identity, surface, enrollment, and operator-hold records |
| Record kinds | `github.delivery-receipt-observation` v1 / `github.delivery-audit-observation` v1 / `github.pull-request-observation` v2 | Direct receipt or API-audit acquisition provenance kept distinct from allowlisted pull-request state |
| Record kinds | `github.source-checkpoint-observation` v1 / `github.source-gap-observation` / `github.source-gap-repair-observation` v3 | Point/continuation boundaries, explicit interval or delivery-content uncertainty, and terminal evidence-bound repair |
| Record kinds | `github.installation-repository-observation` / `github.installation-repository-reconciled` v1 | Enrollment-rooted observer App access observation and reconciliation outcome |
| Event kind | `control-plane.initialized` v1 | The past-tense account of successful initialization |
| Event kind | `control-plane.integrity-checked` v1 | The past-tense account of the accepted integrity observation |
| Event kind | `core.snapshot-activated` v1 | The past-tense account of selecting one snapshot |
| Event kind | `core.candidate-rejected` v1 | The past-tense audit account of one rejected candidate check |
| Event kind | `core.source-check-eligible` v1 | The past-tense audit account of one eligible configured-ref check |
| Event kind | `core.stale-source-override-issued` v1 | The past-tense account causally linked to the override decision |
| Event kind | `core.snapshot-rollback-activated` v1 | The past-tense account linking an operator decision, prior authority, and new snapshot |
| Event kinds | `repository.*` v1 | Past-tense repository reconciliation, enrollment, and local-hold outcomes |
| Event kind | `github.delivery-recorded` v1 | Past-tense acceptance linked to the direct-delivery receipt |
| Event kind | `github.delivery-repair-recorded` v1 | Past-tense API repair linked to the delivery-audit observation |
| Event kinds | `github.source-checkpoint-recorded` v1 / `github.source-gap-opened` / `github.source-gap-repaired` v3 | Past-tense coverage transitions without rewriting source history |
| Event kind | `github.installation-repository-reconciliation-recorded` v1 | Past-tense installation access reconciliation without enrollment mutation |
| Command kind | `control-plane.initialize` v1 | The fixed bootstrap transaction and its ordered outputs |
| Command kind | `control-plane.check-integrity` v1 | An optimistic, idempotent system integrity check |
| Command kind | `core.activate-snapshot` v1 | Atomic retention and activation of one independently revalidated candidate |
| Command kinds | `repository.*` v1 | Per-repository optimistic authority, reconciliation, enrollment, and operator-hold transactions |
| Command kind | `github.record-pull-request-delivery` v1 | Enrollment-bound atomic receipt, pull-request observation, and event; caller has already verified the body |
| Command kind | `github.record-pull-request-delivery-repair` v1 | Enrollment-bound API audit, pull-request observation, and event without a fabricated receipt |
| Command kinds | `github.record-source-checkpoint` v1 / `github.open-source-gap` / `github.repair-source-gap` v3 | Optimistic post-acquisition coverage loop with explicit failure kind and exact API-repair citations for delivery-content gaps |
| Command kind | `github.record-installation-reconciliation` v1 | Enrollment-bound source/result persistence with unavailable acquisition kept source-distinct |
| Command kind | `core.record-candidate-rejection` v1 | Idempotent bounded rejection observation and event |
| Command kind | `core.record-source-check-eligible` v1 | Idempotent eligible-check observation and event |
| Command kind | `core.issue-stale-source-override` v1 | Optimistic attributed decision capped at 24 hours |
| Command kind | `core.rollback-snapshot` v1 | Atomic resolved decision and exact-target snapshot activation |
| Predicate contract | `core.snapshot-active` v1 | Established by automatic activation or operator rollback; latest transaction sequence wins |
| Projection contract | `control-plane.subject-lookup` v2 | Stable subject identity and first durable creation-record lookup |
| Projection contract | `control-plane.event-cursor` v1 | Payload-free sequence/position cursor for accepted events |

Information classes are closed to `public`, `organization`, and `restricted`;
record classes are closed to definition, assertion, observation, evidence
reference, fact, and decision. Event remains an occurrence subtype, not a
record class. These larger enums reserve accepted vocabulary; only the concrete
bootstrap record and event kinds can currently be persisted through kernel
code.

### Relational spine

`control_transactions` allocates the canonical transaction sequence with an
SQLite `AUTOINCREMENT` primary key. `durable_occurrences` holds the common
envelope and enforces one unique position across both record and event outputs
within that transaction. `durable_records` adds the record class;
`event_ledger` identifies events without pretending that event is a record
class. `subjects` keeps typed identity separate from occurrence identity.

`control_plane_metadata` holds the database lineage and persisted sequence and
control-time watermarks. `idempotency_receipts` stores the retained result of
the registered integrity and Core activation commands; initialization is naturally idempotent
because an existing target database is validated and returned, not initialized
again. No generic record, fact, or event insertion API is exposed.

`core_snapshots` and `core_snapshot_files` retain every accepted catalog,
source identity, exact raw bytes, canonical parsed repository declaration, and
durable occurrence lineage. `core_active_snapshot` is a checked singleton
pointer to the latest accepted active fact; it is not independent authority.

Payload and information-scope JSON use a deterministic canonical encoder.
Their SHA-256 digest is verified when a database opens. Record IDs, transaction
IDs, correlation IDs, and the database subject ID are independently generated
UUIDv7 values; none provides transaction order.

### Initialization transaction

After acquiring `BEGIN IMMEDIATE`, initialization captures one evaluation and
recorded time, creates the schema, allocates transaction sequence `1`, creates
the database subject, and writes two outputs in registered order:

1. `control-plane.database-definition` at position `0`; and
2. `principal.definition` at position `1`; and
3. `control-plane.initialized` at position `2`.

The database definition and event bind the database subject; the principal
definition binds the distinct operator subject. The operator definition records
only `principalKind: operator` and `binding: local-stdio-implicit`: it does not
derive identity from an OS username, provider, model, or caller-supplied worker
text. All three outputs bind SHA-256 revisions, the system kernel source,
deployment-scoped `organization` information, one correlation ID, and one
recorded time. Metadata watermarks, SQLite identifiers, both subjects, outputs,
and transaction commit atomically.

### Registered integrity command

`checkIntegrity` is the first post-bootstrap typed command. Its input is an
idempotency key and the exact last transaction sequence the caller expects.
After acquiring the writer transaction, the handler validates the current
schema and registries, checks for an existing receipt, then captures one
evaluation time. Equivalent replay returns the original result without checking
the newer sequence or clock; the same key with another expected sequence fails.

A new execution rejects a stale expected sequence or a wall clock earlier than
the persisted control-time watermark. It runs SQLite `PRAGMA quick_check`, then
writes `control-plane.integrity-observation` at position `0` and
`control-plane.integrity-checked` at position `1`. Both bind the database subject
at revision kind `transaction-sequence` using the pre-command sequence that was
checked. The receipt, occurrences, transaction, and advanced watermarks commit
atomically. The receipt is retained for the database lineage in this slice with
an explicit maximum UTC deadline; no purge operation exists.

### Registered Core snapshot activation

`activateCoreSnapshot` is the first registered fact-establishment path. It
accepts the expected control-plane sequence and one materialized candidate from
the independent Core verifier. Before writing, it reruns validation over the
candidate bytes and compares the complete report. Equivalent retry is keyed by
the exact Git commit and returns its original result before current-sequence or
clock evaluation.

A new execution creates a `core-snapshot` subject and emits
`core.snapshot-definition`, `core.snapshot-active`, and
`core.snapshot-activated` at positions `0`, `1`, and `2`. The definition and
event bind the new snapshot; the fact binds the database deployment whose
authority changed. All outputs identify the immutable GitHub source repository
and exact commit. The registered active predicate uses latest transaction
sequence, while the relational pointer is verified against that fact on every
open.

Exact source bytes, per-file metadata and digests, canonical parsed live
repository declarations, source/ref/commit/tree identities, validation summary,
three occurrences, receipt, pointer, and watermarks commit together. Startup
recomputes the file and catalog digests and checks all cross-table lineage. The
exact activation contract and excluded enrollment behavior live in
[Core snapshot activation](../specs/core-snapshot-activation.md).

After initial activation, the Git source adapter proves that a different
candidate descends from the active source commit. The store binds that same
commit to the still-active snapshot under its writer lock; a missing or stale
binding allocates no authority.

When activation cannot fetch, validate, establish continuity, or persist a candidate, the Core CLI
uses a separate registered command to append a bounded rejection observation
and matching audit event on the database subject. The source repository and
available commit revision remain provenance, not a new subject or fact. This
diagnostic transaction advances audit order and may make projections stale, but
it neither enters the active predicate family nor moves the checked pointer.
Exact replay is keyed by the server check identity. The typed retention command
deletes only complete unprotected check transactions beyond 30 days or the
10,000-item eligible limit, retains a digest-bearing audit result, and rebuilds
all projections atomically. Current-readiness anchors and evidence cited by
retained decisions remain protected.

`CoreSourceController` stores schedule and lease state in the validated
`core_poll_state` singleton. Claim and completion are short `BEGIN IMMEDIATE`
operational transactions around, never across, Git work. They do not allocate
control-plane sequence or become authority. The controller schedules healthy
runs 15 minutes from completion, backs consecutive source outages off to 30
then 60 minutes, suppresses only consecutive equivalent validation/continuity
detail, and invokes typed retention once daily. The exact behavior lives in
[Core source polling](../specs/core-source-polling.md).

After an eligible source check, repository reconciliation reads canonical
declarations from the active retained snapshot. One transaction per declaration
creates or revises the source-native GitHub repository subject and establishes
`repository.core-authorized`. Enabled declarations then receive a bounded
GitHub metadata lookup outside SQLite and a second transaction establishing
`repository.github-identity-reconciled`. A matched identity drives bounded
exact-commit Git data inspection, a four-output canonical-surface transaction,
and—only for a valid result—a separate three-output enrollment transaction.
Paused and disabled declarations are materialized without external lookup. The
current read distinguishes GitHub and surface holds, `awaiting-enrollment`, and
`enrolled`. Exact behavior lives in
[repository authority reconciliation](../specs/repository-authority-reconciliation.md)
and [repository surface reconciliation](../specs/repository-surface-reconciliation.md).

An automatic check that matches the active commit appends an eligible-check
observation and event without creating another snapshot. Rejection observations
identify automatic configured-ref checks separately from exact-commit rollback
attempts. The kernel derives Core admission readiness at a caller evaluation
time from the active snapshot and this ordered history: invalidity, unresolved
continuity, and persistence failure block immediately; source unavailability
only advances the 24-hour clock from the last successful validation. The read
allocates no transaction. A typed operator command may issue a stale-source
override only against the exact `source-stale` base result. The decision binds
the active snapshot and evidence, expires within 24 hours of server issuance,
and makes the read visibly degraded while applicable; it cannot alter any hard
failure or transfer to a later snapshot.

Operator rollback is a separate typed authority path, never a bypass flag on
automatic activation. The local CLI binds the stored operator principal, exact
pre-command sequence, active snapshot, target commit, and bounded rationale in
a resolved decision record. The same transaction creates a new immutable
snapshot, active fact, and rollback event whose causation points to that
decision. A retained target is reconstructed from verified raw bytes so outage
recovery does not depend on Git; an unretained target must pass the secured
exact-commit reader. Prior snapshots are never updated or deleted.

### Rebuildable read models

[`ControlPlaneStore`](../../src/control/store.ts) materializes two registered
read models. Subject lookup derives only from stable subjects and exactly one
definition in each subject's creation transaction. Event cursor derives from
the event ledger and common occurrence envelope, omitting payloads and payload
digests. Neither transformation calls a model, network, external source, or
implicit clock.

Each full build writes a new immutable shadow generation with a UUIDv7
generation identity, exact source transaction-sequence watermark, source and
output digests, contract/transformation/information-handling versions, explicit
evaluation time, row count, and invariant result. Initialization builds at
sequence `1`. Later authoritative commands may leave active generations stale;
an explicit rebuild constructs both shadows and switches both head pointers in
one SQLite transaction. Injected failure before publication rolls the shadows
back and preserves the old heads.

Projection health distinguishes current, stale, unavailable, and invalid. A
stale generation may conservatively return its older identities but is labeled
stale. Reads filter by the internal caller's class ceiling and exact deployment
scope, then join every candidate back to its current authoritative definition
or event before returning it. A wrong scope, lower class, invalid digest, or
failed invariant yields no projection result rather than broader disclosure.
Projection output never authorizes a mutation.

Ordinary rebuilds retain inactive generations for diagnostics. Explicit repair
deletes only the disposable projection tables and rebuilds them from source; it
cannot allocate a control transaction or alter metadata, subjects, records,
events, receipts, or transaction order.

### Backup and restore staging

Online backup reads the live file through a dedicated read-only SQLite
connection and writes only to a new path. Fluent never uses filesystem copy on
an open WAL database and never overwrites an existing backup. It then opens the
artifact through the same target validator, runs SQLite quick-check, and
requires usable projection heads.

The returned manifest binds the absolute artifact path, database lineage,
schema and registry versions, last and next transaction sequences, control-time
watermark, backup creation time, and a canonical authoritative digest. That
digest covers all authority tables and SQLite's transaction allocation but
excludes disposable projection generations, so it compares logical authority
rather than physical file bytes.

Verification requires the operator's expected lineage and highest sequence ever
visible for it. A backup below that fence is unsafe even if otherwise valid:
continuing from it could allocate a sequence already observed before the
restore. V1 refuses that restore rather than manufacturing a sequence gap or
rewriting history.

Restore copies a verified backup through SQLite into another new path and
validates the staged artifact again. It does not replace the live file or change
runtime configuration. This separation makes destructive activation an
explicit offline operator procedure while giving that procedure a fully checked
candidate.

### Local operator surface

[`src/control/cli.ts`](../../src/control/cli.ts) exposes the implemented kernel
diagnostics, integrity execution, projection rebuild/repair, and backup
verification through `npm run --silent control`. It emits JSON for scripting but is a
host-local operator surface, not a worker protocol or authenticated remote API.
Backup verification and restore staging dispatch without opening the configured
live database, preventing an absent `FLUENT_CONTROL_DB` from being initialized
as an inspection side effect.

Normal store construction validates the complete projection catalog. The
explicit projection-repair opener skips only that startup check so a missing or
damaged disposable catalog can be replaced; it still validates every
authoritative schema, transaction, registry reference, occurrence, and receipt
before deletion. Authority commands run their normal full validation even on
that connection, so repair mode is not a general fail-open switch.

### Validation boundary

Startup checks schema identity, the exact target table set and absence of
unregistered indexes, triggers, or views, metadata versions,
UUIDv7 lineage, transaction maximum and SQLite allocation watermark, control
time, subject and revision kinds, source, information class, payload digest,
payload contract, occurrence subtype coverage, ordered command-output contracts,
and receipt-to-transaction/output lineage. Projection catalog identity and
versions are checked at startup. Active row digests and source equivalence are
checked by health and read operations, so projection corruption fails that read
closed without disabling unrelated authoritative commands; explicit repair
replaces the disposable generations.

The public class currently offers secret-safe metadata and occurrence
inspection plus the system-only integrity, Core activation, and typed repository
reconciliation commands. There is no administrative, worker, or generic
mutation surface. Authentication,
principal/session command binding, general predicates and reducers,
operational state, authority-sensitive
projections, bounded clock-rollback recovery, backup activation operations, and
work lineage are later slices in the
[kernel bootstrap plan](../plans/control-plane-kernel-bootstrap.md).

## Operational notes

- Do not point `FLUENT_CONTROL_DB` at `FLUENT_QUEUE_DB`. The queue database is
  the work engine's own store, never a control-plane initialization input.
- The target file, WAL, and backups must be handled as `restricted` assets even
  though the three initialization occurrences are `organization` class.
- Node's built-in SQLite binding is used here as in the queue store; the
  single-host deployment is settled in the runbook, and PostgreSQL waits for
  measured need.
- A prior schema or registry mismatch is not repaired automatically. Preserve the file for
  diagnosis and use a new empty database during this pre-production slice.
- Projection repair is narrower than schema repair: it discards only registered
  read-model generations after authoritative schema and records validate.
- Backup and staged-restore artifacts contain restricted deployment state. The
  API verifies content but does not encrypt, relocate, retain, or delete them.

## References

- Rationale:
  [ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md),
  [ADR-0039](../adr/0039-use-typed-source-native-subject-identities.md),
  [ADR-0040](../adr/0040-establish-facts-through-registered-predicate-contracts.md),
  [ADR-0041](../adr/0041-enforce-three-information-classes-and-scoped-access.md),
  [ADR-0042](../adr/0042-use-rebuildable-projections-only-as-read-models.md),
  [ADR-0043](../adr/0043-order-records-by-transaction-sequence-not-timestamps.md),
  [ADR-0044](../adr/0044-replace-the-queue-spike-database.md), and
  [ADR-0046](../adr/0046-separate-core-source-freshness-from-admission-readiness.md),
  [ADR-0047](../adr/0047-cap-stale-source-overrides-at-24-hours.md), and
  [ADR-0048](../adr/0048-retain-core-check-detail-for-30-days.md), and
  [ADR-0049](../adr/0049-poll-core-through-one-leased-controller.md), and
  [ADR-0050](../adr/0050-reconcile-repository-enrollment-as-separate-facts.md), and
  [ADR-0051](../adr/0051-pin-surfaces-to-the-observed-default-branch-head.md),
  [ADR-0052](../adr/0052-bind-local-repository-holds-to-explicit-operator-decisions.md), and
  [ADR-0057](../adr/0057-require-webhook-ingress-for-github-observation.md)
- Contracts: [control-plane kernel](../specs/control-plane-kernel.md) and
  [Core snapshot activation](../specs/core-snapshot-activation.md), and
  [Core source readiness](../specs/core-source-readiness.md), and
  [Core check-detail retention](../specs/core-check-detail-retention.md), and
  [Core source polling](../specs/core-source-polling.md), and
  [repository authority reconciliation](../specs/repository-authority-reconciliation.md), and
  [repository surface reconciliation](../specs/repository-surface-reconciliation.md), and
  [local repository holds](../specs/repository-local-holds.md), and
  [GitHub observation registry](../specs/control-plane-kernel.md#closed-registry-version-18)
- Built in: [control-plane kernel bootstrap — Phases 1–3](../plans/control-plane-kernel-bootstrap.md)
- Product: [GitHub organization agent fleet](../prd/agent-fleet.md)
