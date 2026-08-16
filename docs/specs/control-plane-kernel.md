# Spec: Control-plane kernel

This contract governs initialization, validation, typed Core snapshot storage,
and the first rebuildable read models of the clean target SQLite database. It
is consumed only by internal Fluent code and host-local diagnostics; it exposes
no generic record-writing, fact-writing, administrative, or worker interface.

## Interface

### Database selection and identity

| Item | Value | Constraint |
| --- | --- | --- |
| Environment variable | `FLUENT_CONTROL_DB` | Optional; target database path |
| Default path | `./data/control-plane.db` | Distinct from the queue-spike default |
| SQLite application ID | `1179405908` | Decimal encoding of `FLNT` |
| Schema version | `2` | Stored in both `PRAGMA user_version` and metadata |
| Registry version | `3` | Stored in metadata and both initialization payloads |
| Node runtime | `>=24.0.0` | Required for the stable `node:sqlite` surface and online backup API |
| Database lineage ID | UUIDv7 | Generated once by the server; never reused or inferred from path |
| Operator principal ID | UUIDv7 | Generated once and stored separately from database, session, worker, or provider identity |

`ControlPlaneStore.metadata()` returns application, schema, registry, database
lineage, operator principal, creation time, control-time watermark, and last
transaction sequence.
`ControlPlaneStore.occurrences()` returns occurrences ordered by transaction
sequence and position. Neither method mutates the database or returns a secret.

### Closed registry version 4

| Registry | Name | Version or ID rule | Contract |
| --- | --- | --- | --- |
| Subject | `control-plane-database` | UUIDv7 | Fluent authority; accepts `sha256` and `transaction-sequence` revisions |
| Subject | `operator-principal` | UUIDv7 | Fluent authority; accepts `sha256` revision |
| Subject | `core-snapshot` | UUIDv7 | Fluent authority; accepts `core-catalog-sha256` revision |
| Revision | `sha256` | `sha256:` plus 64 lowercase hexadecimal characters | Exact payload digest |
| Revision | `transaction-sequence` | Positive safe integer encoded as canonical decimal | Exact database state checked through that sequence |
| Revision | `core-catalog-sha256` | `sha256:` plus 64 lowercase hexadecimal characters | Exact retained Core catalog |
| Revision | `git-commit-sha1` | `sha1:` plus 40 lowercase hexadecimal characters | Exact Git source commit |
| Source | `fluent-system` | Only source ID `kernel` | Internal deterministic bootstrap source |
| Source | `github-repository` | `github.com:` plus immutable positive numeric repository ID | Source revision must be `git-commit-sha1` |
| Record | `control-plane.database-definition` | Schema 1 | Class `definition`; subject `control-plane-database`; minimum class `organization` |
| Record | `principal.definition` | Schema 1 | Class `definition`; subject `operator-principal`; minimum class `organization` |
| Record | `control-plane.integrity-observation` | Schema 1 | Class `observation`; subject `control-plane-database`; minimum class `organization` |
| Record | `core.snapshot-definition` | Schema 1 | Class `definition`; subject `core-snapshot`; minimum class `organization` |
| Record | `core.snapshot-active` | Schema 1 | Class `fact`; subject `control-plane-database`; minimum class `organization` |
| Record | `core.candidate-rejection-observation` | Schema 1 | Class `observation`; subject `control-plane-database`; minimum class `organization` |
| Event | `control-plane.initialized` | Schema 1 | Subject `control-plane-database`; minimum class `organization` |
| Event | `control-plane.integrity-checked` | Schema 1 | Subject `control-plane-database`; minimum class `organization` |
| Event | `core.snapshot-activated` | Schema 1 | Subject `core-snapshot`; minimum class `organization` |
| Event | `core.candidate-rejected` | Schema 1 | Subject `control-plane-database`; minimum class `organization` |
| Command | `control-plane.initialize` | Schema 1 | Outputs database definition, principal definition, then initialization event |
| Command | `control-plane.check-integrity` | Schema 1 | Outputs the integrity observation, then integrity-checked event |
| Command | `core.activate-snapshot` | Schema 1 | Outputs snapshot definition, active fact, then activation event |
| Command | `core.record-candidate-rejection` | Schema 1 | Outputs rejection observation, then rejection event |
| Predicate | `core.snapshot-active` | Contract 1 | Established by `core.activate-snapshot`; latest transaction sequence wins |
| Projection | `control-plane.subject-lookup` | Contract, transformation, and information-handling version 1 | Stable subjects and creation definitions for internal diagnostics |
| Projection | `control-plane.event-cursor` | Contract, transformation, and information-handling version 1 | Payload-free event cursor for internal diagnostics and ProcessObserver |

The two registered payloads have the same exact shape; additional keys are
invalid:

```json
{
  "databaseLineageId": "0198b0a6-c200-7abc-8def-0123456789ab",
  "operatorPrincipalId": "0198b0a6-c200-7abc-8def-0123456789ac",
  "registryVersion": 4,
  "schemaVersion": 2
}
```

The example UUID illustrates the encoding only. Runtime values are generated by
the server.

The operator definition payload is exactly:

```json
{
  "binding": "local-stdio-implicit",
  "principalKind": "operator"
}
```

The integrity observation and event payload have this exact shape:

```json
{
  "checkedThroughSequence": 1,
  "databaseLineageId": "0198b0a6-c200-7abc-8def-0123456789ab",
  "registryVersion": 4,
  "result": "ok",
  "schemaVersion": 2
}
```

### Integrity command

`ControlPlaneStore.checkIntegrity(input)` accepts:

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `expectedLastTransactionSequence` | integer | yes | Positive safe integer; optimistic binding to pre-command state |
| `idempotencyKey` | string | yes | 1–128 ASCII letters, digits, `.`, `_`, `:`, or `-`; first character alphanumeric |

An accepted result contains `result: "ok"`, the checked-through sequence,
observation and event UUIDv7 record IDs, transaction sequence, fixed positions
`[0, 1]`, and its evaluation and recorded UTC time. Equivalent replay returns
the exact stored result. A key already bound to another input digest fails.

### Core snapshot commands

`ControlPlaneStore.activateCoreSnapshot(input)` is the only implemented fact-
establishment path. It accepts a verified materialized candidate, the exact
positive current sequence expected by the caller, and after initial activation
the exact active commit whose Git ancestry the source adapter verified. Its source, payloads, ordered
outputs, retained catalog, idempotency, pointer, integrity, and excluded
behavior are specified by
[Core snapshot activation](core-snapshot-activation.md). No other predicate or
caller-selected fact kind is writable.

`recordCoreCandidateRejection(input)` accepts one server UUIDv7 check identity,
the registered source/validation/continuity/persistence stage and matching code, bounded
sanitized diagnostic text, configured source URL/ref, and the commit/tree/
catalog identities available at that stage. It atomically writes an observation,
event, receipt, transaction, and metadata watermarks. It accepts no authority
expectation because it observes a rejected candidate rather than mutating the
active predicate. `coreCandidateRejections(limit)` returns newest observations
only, with a limit from 1 through 100. Exact payload constraints live in
[Core snapshot activation](core-snapshot-activation.md).

### Projection interface

Initialization publishes one immutable generation for each registered
projection at source sequence `1`. `ControlPlaneStore.rebuildProjections()`
builds shadow generations through the current authoritative transaction
sequence, validates their digests and invariants, and atomically activates both
heads. It allocates no control transaction, record, event, or authority fact.
`repairProjections()` explicitly discards all disposable generations and
reconstructs both projections from retained source records.

Every generation stores its registered projection name, server-generated
UUIDv7 identity, contract/transformation/information-handling versions, source
sequence and digest, output digest, row count, invariant result `ok`, and one
explicit canonical UTC evaluation/build instant.

`projectionHealth()` reports each active head as `current`, `stale`,
`unavailable`, or `invalid`, including source/current sequence and lag.
`projectedSubjects(access)` and `projectedEvents(access, after, limit)` require
an internal access context containing a maximum information class and explicit
deployment IDs. They filter before returning rows and join each candidate back
to its current authoritative definition or event. The event cursor is the pair
`(transactionSequence, transactionPosition)` and `limit` is 1–1000.

Subject rows contain subject kind and ID, creation sequence, creation-definition
record ID, and current information class/scope. Event rows contain event record
ID, kind/version, subject, correlation ID, current information class/scope,
transaction coordinates, and recorded time. Event payloads and payload digests
are deliberately absent from the cursor projection.

### Backup and restore staging

`await ControlPlaneStore.createBackup(path)` uses SQLite's online backup API
through a dedicated read-only source connection for filesystem databases. The
destination is create-only: it must differ from the live database and queue-
spike paths and must not exist. The completed artifact is reopened through the
normal target validator, passes `PRAGMA quick_check`, has usable projection
heads, and must still match the live authoritative digest and sequence before a
manifest is returned.

The manifest has this exact shape:

| Field | Constraint |
| --- | --- |
| `formatVersion` | Literal `1` |
| `backupPath` | Absolute filesystem path to the created artifact |
| `databaseLineageId` | Preserved target UUIDv7 lineage |
| `schemaVersion`, `registryVersion` | Exact supported versions |
| `lastTransactionSequence` | Highest durable source transaction in the artifact |
| `nextTransactionSequence` | Exactly `lastTransactionSequence + 1` |
| `controlTimeWatermark` | Preserved canonical UTC watermark |
| `authoritativeDigest` | SHA-256 over canonical rows from metadata, transactions, subjects, occurrences, record/event subtypes, receipts, Core snapshot metadata/file identities/parsed records, the active pointer, and SQLite's transaction allocation; raw bytes are transitively bound by startup-verified file digests and projections are excluded |
| `createdAt` | Server UTC time at which backup creation began; not a control transaction time |

`ControlPlaneStore.verifyBackup(manifest, expectation)` requires the caller's
expected database lineage and highest transaction sequence previously visible
for that lineage. It reopens and validates the artifact, compares every manifest
content field, and refuses an artifact below the supplied sequence fence.

`await ControlPlaneStore.stageRestore(manifest, targetPath, expectation)` first
performs that verification, copies the backup through SQLite into a new
nonexistent target path, and validates the staged artifact again. It never
overwrites or switches the live database. Activation remains an operator
procedure after the live store is closed.

### Local operator CLI

`npm run --silent control -- <command>` is a host-local JSON interface over only the
kernel operations above:

| Command | Effect |
| --- | --- |
| `metadata` | Prints target metadata plus the authoritative digest |
| `check-integrity <expected-sequence> <idempotency-key>` | Executes the registered integrity command |
| `projection-health` | Prints current/stale/unavailable/invalid state for each registered projection |
| `rebuild-projections` | Builds and atomically publishes ordinary shadow generations |
| `repair-projections` | Opens through the narrow projection-repair validation path, discards disposable generations, and rebuilds them |
| `backup <new-backup.db>` | Creates a verified backup and prints its manifest JSON |
| `verify-backup <manifest.json> <lineage-id> <minimum-sequence>` | Validates a saved manifest and artifact without opening the configured live database |
| `stage-restore <manifest.json> <new-target.db> <lineage-id> <minimum-sequence>` | Verifies and stages a create-only restore without opening or replacing the configured live database |

Every successful command prints exactly one JSON value to stdout. Usage and
failure messages go to stderr with a nonzero exit status. The CLI is local
operator tooling, not an authenticated remote API or worker surface. Projection
rebuild/repair and backup staging remain non-authoritative operations; invoking
the integrity check does not change its registered `fluent-system/kernel`
source identity.

### Tables

| Table | Purpose | Primary invariants |
| --- | --- | --- |
| `control_plane_metadata` | One row describing the target lineage | Singleton key `1`; application/schema/registry versions; UUIDv7 lineage; persisted time and sequence watermarks |
| `control_transactions` | Accepted command transactions | Monotonic `AUTOINCREMENT` sequence; unique UUIDv7 transaction ID; command, principal/source, optional session/idempotency, digest, evaluation and recorded time |
| `subjects` | Stable typed subjects | Composite key `(subject_kind, subject_id)`; creation transaction reference |
| `durable_occurrences` | Common record/event envelope | Unique UUIDv7 record ID; record/event subtype; registered kind/version/subject/source; typed revisions; class/scope; canonical payload/digest; causal fields; unique `(transaction_sequence, transaction_position)` |
| `durable_records` | Record subtype | Exactly one accepted non-event record class for each referenced occurrence |
| `event_ledger` | Event subtype | Event occurrence reference; no record class |
| `idempotency_receipts` | Registered command replay results | Composite command-scope key; payload digest, canonical retained result, transaction reference, and retention deadline |
| `core_snapshots` | Retained snapshot lineage | Snapshot/source/catalog identities and definition/fact/event/transaction references |
| `core_snapshot_files` | Exact snapshot contents | Path, mode, Git object, size, content digest, optional canonical parsed live declaration, and raw bytes |
| `core_active_snapshot` | Checked current-authority pointer | Singleton reference to the latest snapshot activation fact and transaction |
| `projection_generations` | Immutable read-model build metadata | Registered versions, source/output digests, source watermark, evaluation/build time, row count, and invariant result |
| `projection_heads` | Active-generation pointers | One head per registered projection; atomically references one validated generation |
| `projection_subject_lookup` | Subject lookup rows | Generation-scoped stable subject and creation-definition identity plus information class/scope |
| `projection_event_cursor` | Event cursor rows | Generation-scoped payload-free event metadata ordered by transaction sequence and position |

Record classes are exactly `definition`, `assertion`, `observation`,
`evidence-reference`, `fact`, and `decision`. Information classes are exactly
`public`, `organization`, and `restricted`. Only the kinds listed in the closed
registry are accepted by current kernel code.

### Initialization outputs

The first accepted transaction has sequence `1`, command
`control-plane.initialize` schema `1`, principal/source
`fluent-system` / `kernel`, no session or idempotency key, and one captured UTC
evaluation/recorded time. Its outputs are:

| Position | Subtype | Kind | Class | Information |
| --- | --- | --- | --- | --- |
| `0` | record | `control-plane.database-definition` | `definition` | `organization`, scoped to the database lineage deployment |
| `1` | record | `principal.definition` | `definition` | `organization`, scoped to the database lineage deployment |
| `2` | event | `control-plane.initialized` | none | `organization`, scoped to the database lineage deployment |

Each output has an independent UUIDv7 record identity. Database and principal
subjects remain distinct; the database definition and event share their
database payload and revision. All outputs share correlation, transaction, and
recorded time. Event is not a record class.

An accepted `control-plane.check-integrity` transaction uses the same two output
positions. Its record is `control-plane.integrity-observation` class
`observation`; its event is `control-plane.integrity-checked`. Both use revision
kind `transaction-sequence` and the pre-command sequence as the revision value.

## Rules

1. The store MUST initialize only a SQLite database with application ID `0` and
   no application tables.
2. The target path MUST differ from the resolved queue-spike path. A file with
   spike tables MUST be refused before target schema or application metadata is
   written.
3. Initialization schema, metadata, transaction, subject, outputs, watermarks,
   application ID, and user version MUST commit atomically under
   `BEGIN IMMEDIATE`.
4. A current target database MUST reopen without schema writes or another
   initialization transaction.
5. Older, newer, incomplete, unexpected, or differently identified schemas
   MUST fail closed. Unregistered indexes, triggers, and views are unexpected.
   Schema version 2 and registry version 4 define no upgrade path from earlier
   pre-production target stores.
6. Subject, record, event, command, source, revision, record-class, and
   information-class names MUST come from the code-owned versioned registries.
   Payload validity alone MUST NOT create a kind.
7. Every record and event occurrence MUST have a server-generated UUIDv7 record
   identity independent of subject, transaction, correlation, and idempotency
   identity.
8. The pair `(transaction_sequence, transaction_position)` MUST be unique
   across records and events. UUID or time order MUST NOT substitute for it.
9. Payload and information-scope JSON MUST use deterministic key-sorted compact
   encoding. Payload digest MUST be SHA-256 over those exact UTF-8 payload bytes.
10. The initialization payload MUST have exactly the four documented fields,
    and its subject ID MUST equal its `databaseLineageId`. Its
    `operatorPrincipalId` MUST equal the separately stored operator subject and
    metadata identity.
11. Startup MUST validate the metadata sequence watermark against both the
    maximum stored transaction sequence and SQLite's allocated sequence. Any
    mismatch MUST fail closed.
12. Startup MUST validate persisted registry references, subtype coverage,
    UUIDv7 subject identity, revision syntax, source identity, information
    minimum, payload digest, payload contract, each command's exact ordered
    outputs, and every receipt's transaction and returned-record lineage.
13. A durable record MUST have exactly one `durable_records` subtype and an
    event exactly one `event_ledger` subtype. An event MUST NOT receive a record
    class.
14. Initialization MUST assign one server UTC instant after acquiring the write
    transaction and use it as evaluation time, recorded time, creation time, and
    initial control-time watermark.
15. The target store MUST NOT inspect spike rows, import spike records, attach a
    spike database, or create a legacy establishment path.
16. The store MUST expose no generic record, event, assertion, or fact mutation
    method. Later mutations require registered typed command handlers.
17. The target database, WAL, temporary files, exports, and backups MUST be
    operated as `restricted` assets even when a particular occurrence has a
    lower information class.
18. Initialization MUST create exactly one operator-principal subject with a
    server-generated UUIDv7 and `principal.definition` payload binding it
    implicitly to the local-stdio deployment. It MUST NOT derive that identity
    from an OS name, provider, model, GitHub actor, or caller-supplied worker
    string.
19. Integrity execution MUST first bind an expected current sequence and run
    SQLite `PRAGMA quick_check`. A stale expectation or non-`ok` check MUST
    create no transaction, occurrence, receipt, or watermark change.
20. Equivalent idempotent replay MUST return the original result, identities,
    sequence, positions, and times without evaluating the current clock or
    expected sequence. Reusing its key with a different input digest MUST fail.
21. New command execution MUST fail when evaluation time is earlier than the
    persisted control-time watermark. Version 1 applies zero backward-clock
    tolerance and defines no recovery command.
22. The integrity observation, event, receipt, metadata watermarks, and command
    transaction MUST commit or roll back together. A rolled-back allocation
    MUST leave both the stored maximum and SQLite allocation watermark at their
    prior value.
23. Integrity receipts MUST use command scope `database:<lineage-id>` and the
    explicit retention deadline `9999-12-31T23:59:59.999Z`. Version 1 has no
    purge path, so a key remains bound for the database lineage.
24. Projection names and all three projection versions MUST come from the
    code-owned projection-contract registry. Unknown names or versions MUST
    fail closed; callers cannot supply transformations or SQL.
25. A full rebuild MUST read source rows only through its explicit transaction-
    sequence watermark, compute deterministic source and output digests, write
    immutable shadow rows, verify row count and contract invariants, and change
    active heads only in the same successful SQLite transaction.
26. Projection build, activation, failure, repair, or deletion MUST NOT create,
    edit, or remove a control transaction, subject, durable occurrence,
    idempotency receipt, metadata watermark, or SQLite transaction allocation.
27. Subject lookup MUST derive each subject from exactly one definition in its
    creation transaction. Event cursor MUST derive from `event_ledger` joined
    to the common occurrence envelope and MUST NOT copy event payloads.
28. A stale generation MAY return its bounded older rows with `stale: true` but
    MUST recheck every returned identity, information class, and scope against
    current authoritative rows. It MUST NOT return newer source data by guessing
    or authorize a mutation.
29. Projection reads MUST enforce both maximum information class and exact
    deployment scope before result formation. A lower class ceiling, wrong
    deployment, malformed access context, invalid active generation, or failed
    digest/invariant check MUST disclose no row.
30. `repairProjections()` MUST be an explicit projection-only recovery path.
    Deleting every projection row and rebuilding at the same authoritative
    watermark MUST reproduce the same output digests without changing source
    history or order.
31. Version 1 retains inactive generations for diagnostics during ordinary
    rebuilds. Explicit repair may discard them all; no projection generation is
    a backup, authority snapshot, subject revision, or domain concurrency token.
32. Backup and restore targets MUST be filesystem paths and create-only. Backup
    MUST refuse the live and queue-spike paths; staged restore MUST refuse the
    backup and queue-spike paths. Neither operation may overwrite a file.
33. A backup MUST use SQLite's online backup mechanism, then reopen the artifact
    through current schema/registry validation, run `PRAGMA quick_check`, and
    verify its projection heads before returning success.
34. The authoritative backup digest MUST exclude all disposable projection
    tables and include SQLite's allocated control-transaction sequence. Equal
    digests therefore prove equal target authority and allocation state, not
    physical SQLite byte equality.
35. Backup verification and restore staging MUST require an expected lineage
    and a positive highest previously visible sequence. A different lineage,
    manifest/content mismatch, damaged database, or artifact sequence below the
    fence MUST fail before a restore artifact is created.
36. Restore staging MUST preserve database lineage, control-time watermark,
    authoritative digest, last sequence, and next sequence. The first later
    command MUST allocate exactly the manifest's `nextTransactionSequence`.
37. Backup creation, verification, and restore staging MUST NOT allocate a
    control transaction or modify source metadata, records, receipts, events,
    projections, or sequence. Stage creation is not live activation.
38. The local control CLI MUST accept exactly the documented positional
    arguments, require canonical positive safe-integer sequence values, emit no
    stack trace, and write no successful JSON to stdout after a failure.
39. `verify-backup` and `stage-restore` MUST dispatch without constructing a
    store at `FLUENT_CONTROL_DB`; inspecting a backup must never initialize an
    absent live database as a side effect.
40. Normal startup MUST continue to reject missing or unknown projection heads.
    The projection-repair opener MAY skip only projection-catalog startup
    validation; it MUST still validate application/schema identity, transaction
    lineage, subjects, occurrences, receipts, and authoritative registries
    before deleting projection rows.
41. The CLI MUST NOT expose generic SQL, record/fact mutation, live restore
    replacement, worker execution, provider credentials, lease tokens, or a way
    to reinterpret projection output as authority.
42. `core.activate-snapshot` MUST be the only establishment path for predicate
    `core.snapshot-active`; the latest accepted transaction sequence MUST define
    precedence, and the singleton pointer MUST be validated against that fact.
43. Startup MUST validate retained Core raw bytes, content and catalog digests,
    canonical parsed live declarations, source revisions, ordered outputs,
    idempotency receipts, and all snapshot/pointer occurrence lineage.
44. Core activation MUST leave projections stale rather than synchronously
    rebuilding them inside the authority transaction.
45. A Core candidate rejection MUST create exactly one registered observation
    and one matching past-tense event in its own idempotent transaction. It MUST
    NOT create a subject, fact, snapshot, enrollment, hold, or active-pointer
    change.
46. Rejection payloads MUST enforce the stage/code relationship, optional
    source revision sufficiency, single-line 512-byte text fields, at most eight
    detail fields, canonical source identity, deployment scope, organization
    information class, server time, and check-ID correlation.
47. Reusing a rejection check ID with equivalent input MUST return the original
    record identities and order; reuse with different diagnostic input MUST
    fail. Rejection receipts remain retained until a later version defines
    count/time history retention before polling.
48. Every new automatic activation after the first MUST require the source
    adapter's ancestry binding to equal the source commit of the active snapshot
    under the same writer lock. Missing or stale bindings MUST allocate no
    transaction, snapshot, fact, event, receipt, or pointer change.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| SQLite v2 target schema | Created transactionally by `ControlPlaneStore` |
| Registry validation | Code-owned constants and validators in `src/control/registry.ts` |
| Initialization definition and event | Fixed outputs of `control-plane.initialize` v1 |
| Implicit operator identity | Fixed `operator-principal` subject and `principal.definition` initialization output |
| Integrity observation, event, and receipt | Fixed outputs of `control-plane.check-integrity` v1 |
| Core snapshot definition, fact, event, retained files, and receipt | Fixed outputs and source material of `core.activate-snapshot` v1 |
| Core candidate rejection observation, event, and receipt | Bounded fixed outputs of `core.record-candidate-rejection` v1 |
| Subject lookup generations | Full deterministic rebuild from subjects and their creation definitions |
| Event cursor generations | Full deterministic rebuild from event occurrences without payload copies |
| Backup manifest | Verified metadata and canonical authoritative digest of one online SQLite backup artifact |
| Staged restore | Create-only SQLite copy revalidated against the manifest and caller's lineage/sequence fence |
| Focused conformance fixtures | `test/control-store.test.ts` |

## References

- Rationale:
  [ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md),
  [ADR-0039](../adr/0039-use-typed-source-native-subject-identities.md),
  [ADR-0040](../adr/0040-establish-facts-through-registered-predicate-contracts.md),
  [ADR-0041](../adr/0041-enforce-three-information-classes-and-scoped-access.md),
  [ADR-0042](../adr/0042-use-rebuildable-projections-only-as-read-models.md),
  [ADR-0043](../adr/0043-order-records-by-transaction-sequence-not-timestamps.md),
  and [ADR-0044](../adr/0044-replace-the-queue-spike-database.md)
- Context: [control-plane kernel](../design/control-plane-kernel.md)
- Core authority contract: [Core snapshot activation](core-snapshot-activation.md)
- Delivery: [control-plane kernel bootstrap](../plans/control-plane-kernel-bootstrap.md)
- Product: [GitHub organization agent fleet](../prd/agent-fleet.md)
