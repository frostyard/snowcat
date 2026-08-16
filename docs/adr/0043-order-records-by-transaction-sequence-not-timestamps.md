# 0043 — Order records by transaction sequence, not timestamps

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

Fluent receives time claims from the local host, GitHub, Git commits, imported
core records, repository tools, capable workers, and future remote clients.
Those clocks can disagree, repeat values, arrive late, move backward, have
different precision, or describe different things. A GitHub creation time is an
external source assertion; a Git commit author date is caller-controlled; an
effective policy date is domain intent; and the time Fluent persisted a record
is an operational observation.

ADR-0037 separates recorded and effective time but leaves ordering and late
data open. ADR-0040 prohibits implicit last-write-wins reduction, and ADR-0042
requires projection source watermarks. Without one deterministic persisted
order, event cursors, idempotent replay, projection rebuild, audit queries, and
ProcessObserver funnels can disagree when timestamps collide or arrive out of
order.

Ordering accepted records by timestamp would also smuggle clock trust into the
authority path. A late observation with an old source time might be ignored; a
future-dated worker assertion might appear newest; or a clock rollback might
resurrect an expired grant. Conversely, one database order cannot claim to be
the true order in which external events happened.

The v1 control plane is one SQLite writer domain on one host. It can provide a
deterministic commit-visible ordering without solving distributed consensus.

## Decision

Every committed write transaction that creates durable records receives one
monotonically increasing **transaction sequence**. Every durable record created
within that transaction receives a deterministic **transaction position**.
The ordered pair `(transaction_sequence, transaction_position)` is Fluent's
canonical total order of accepted record occurrences.

The sequence means only that one transaction became durable in Fluent's
single-writer history after another. It does not mean the described external
event occurred later, one record caused another, one fact supersedes another,
or a later record has greater authority. Gaps are permitted and consumers never
assume sequences are contiguous.

SQLite allocates the next sequence inside the same write transaction as the
records and events. Rollback exposes neither the records nor the sequence.
The persisted sequence watermark is restored and validated against the maximum
stored sequence before new writes; restore or migration cannot reuse a sequence
already visible in that database lineage.

Transaction position follows the typed command handler's registered output
order. It is stable for idempotent replay and does not depend on UUID sort,
table row order, trigger accident, or timestamp precision. Exact allocation and
encoding belong in the storage specification.

### Time fields

Fluent distinguishes these concepts:

- **recorded time** — server UTC time captured for the accepted transaction,
  shared by its records and used for audit and operational durations;
- **effective time** — optional domain time or interval at which a definition,
  fact, decision, or source statement claims applicability;
- **observation time** — server UTC time at which an adapter obtained one
  external reading; and
- **source occurrence time** — an optional value reported by the external
  source about when its event occurred.

The later schemas own exact field names, precision, and encoding. All persisted
instants use an unambiguous UTC representation. Original source text and
precision may be retained as provenance when needed, but they do not replace
the normalized value or transaction order.

Recorded time, observation time, and command evaluation time are assigned by
Fluent. Effective and source occurrence times remain typed source data with
their provenance and trust. A worker, model, client, repository file, commit,
or external timestamp cannot set recorded time or move a record earlier in the
transaction sequence.

Effective time never silently determines conflict precedence. A predicate,
decision, policy, or lifecycle contract must explicitly declare whether and
how effective intervals affect applicability. Record time is likewise not a
default newest-wins rule.

### Command evaluation and expiry

A mutating command acquires the SQLite writer transaction, reads the persisted
control-time watermark, then captures one server **evaluation time** for all
authority and deadline checks in that transaction. The transaction records that
time with its result. External I/O and model work do not occur while the writer
transaction is held.

Time-bounded authority is valid only when `evaluation_time < expires_at`; it is
expired at equality. Lease, grant, exception, decision, hold, drain,
idempotency, and other deadline contracts store absolute UTC deadlines and
apply the same half-open boundary unless their accepted contract explicitly
defines a narrower rule.

The writer transaction has a bounded duration. If it cannot validate and commit
within that bound, it aborts rather than relying on an old evaluation time. A
retry is a new command evaluation unless the original idempotency receipt
already records an accepted result.

A monotonic process clock may measure local durations while one process runs,
but it cannot provide durable authority across restart. The persisted control-
time watermark prevents unnoticed backward movement. If the host wall clock is
behind the last committed control time beyond the accepted tolerance, Fluent
raises clock-health evidence and fails closed for new claims, renewals, grants,
exceptions, timed decisions, and other mutations that rely on proving current
non-expiry. Reports may still be retained as non-authoritative or stale
provenance under their normal contracts.

A forward clock jump may expire authority early and reduce availability, but
does not extend it. Material skew in either direction is visible to the
operator and ProcessObserver. Exact tolerance, health checks, and recovery
procedure belong in the operations specification; recovery cannot edit prior
recorded times or sequences.

### Late and retroactive information

A late observation, imported source record, decision, or fact appends at the
current transaction sequence even when its effective or source occurrence time
is earlier. Fluent never inserts it into an earlier sequence, rewrites a prior
transaction, or changes the recorded time of existing records.

Predicate reducers evaluate late information according to their explicit
effective-time, supersession, invalidation, and conflict rules. A late input
may change a current reduced result and trigger new projection generations,
holds, reconciliation, or review. It cannot retroactively make a previously
rejected command authorized or erase the authority snapshot under which an
earlier command was accepted.

Historical queries distinguish:

- **as known at sequence** — records Fluent had accepted through one transaction
  sequence; and
- **effective at time, as known at sequence** — the domain-effective result at
  a named time using only information accepted through that sequence.

An effective-time query without an as-known boundary is allowed for current
analysis but may change when late information arrives. Audit, decision,
ProcessObserver, experiment, and authority explanations bind both the relevant
effective time where applicable and the as-known transaction sequence.

### Events, causation, and cursors

Event-ledger order and incremental projection cursors use transaction sequence
and position, not timestamp, UUIDv7 lexical order, or source event order. All
events produced by one command share its sequence and have registered positions
relative to the command's other durable outputs.

Correlation identity groups related work; causation identity cites the exact
record or command result that caused another accepted action. Neither is
inferred from temporal proximity. Causal graphs may cross transaction order
only when an imported assertion reports external causality; that report remains
provenance until an accepted contract establishes it.

ProcessObserver uses sequence watermarks for complete ingestion and recorded
server time for control-plane durations. Source occurrence and effective time
may support separately labeled domain metrics only when the profile declares
their source quality, missing values, precision, and late-arrival treatment.

### Idempotency

An idempotency receipt binds the authenticated principal or command scope,
command contract and payload digest, idempotency key, accepted or retained
rejection result, transaction sequence and positions, evaluation and recorded
time, and its retention deadline.

Equivalent replay while the receipt is retained returns the original result,
record identities, sequence, positions, and times without evaluating the
command under newer authority. Reuse with a different payload, subject,
principal scope, or command version fails. Replaying an originally rejected
command returns that recorded rejection only when its command contract retains
rejections; otherwise it is a new evaluation and is labeled accordingly.

Idempotency retention is versioned per command family and cannot be shorter
than the period in which duplicate external effect or authority mutation would
be unsafe. Purging a receipt never permits reuse of a domain identity or
rewriting prior history. Exact retention and archival rules belong in command
specifications.

### Migration

Existing queue IDs, event IDs, and timestamps retain their original meanings.
Migration records receive the transaction sequence at which migration becomes
durable and cite legacy IDs, timestamps, and reliable local ordering as
provenance. They do not fabricate a target transaction sequence representing
an order the spike never recorded.

Where the legacy database proves an internal order, a typed legacy-order field
may preserve it for diagnostics and migration comparison. It does not compete
with the target transaction sequence. Projection migration binds the new source
sequence watermark and keeps legacy event cursors separate.

## Consequences

- Event cursors, projection watermarks, audit queries, and idempotent results
  share one deterministic persisted order.
- Clock collisions, client clock manipulation, and late source data cannot
  reorder Fluent's accepted history.
- Transaction order remains honest about its limitation: it is ingestion order,
  not external occurrence, causality, or semantic precedence.
- Historical answers can distinguish what is now known from what Fluent knew
  when an earlier decision was made.
- One evaluation time and half-open expiry rule remove boundary ambiguity for
  leases, grants, and decisions.
- Clock rollback fails closed instead of silently extending time-bounded
  authority.
- Sequence allocation, time normalization, control-time health, late-data
  queries, idempotency receipts, and restore validation add implementation and
  operations surface.
- A global sequence fits the v1 single-writer SQLite architecture but would
  constrain future active-active operation.
- Exact timestamp encoding, transaction-duration bounds, skew tolerance,
  idempotency retention, and historical-query APIs remain implementing choices.

## Alternatives considered

- **Order by recorded timestamp:** rejected because equal precision, clock
  rollback, and platform differences prevent deterministic total order.
- **Order by effective or source occurrence time:** rejected because those
  values are source claims that can arrive late or be untrusted.
- **Order by UUIDv7:** rejected because UUID time components are identity aids,
  not committed database order, and remain clock-dependent.
- **Use SQLite row IDs implicitly:** rejected because table-local allocation,
  triggers, migrations, and implementation details do not provide one explicit
  cross-record contract.
- **Rewrite late data into historical order:** rejected because it would alter
  what Fluent knew when prior commands and decisions occurred.
- **Use causal IDs as a total order:** rejected because partial causal
  relationships do not order unrelated transactions and imported causality may
  be unverified.
- **Use only a monotonic process clock:** rejected because its epoch and state do
  not survive restart or backup restoration.
- **Continue operating normally after clock rollback:** rejected because expiry
  checks could extend revoked or expired authority.
- **Introduce vector clocks for v1:** rejected because the accepted deployment
  is one SQLite writer domain; distributed ordering is unnecessary complexity.

## References

- Preserves exact source revision and historical assessment truth from
  [ADR-0012](0012-version-criteria-and-preserve-assessment-truth.md), atomic
  source snapshots from
  [ADR-0014](0014-import-core-as-atomic-validated-snapshots.md), and external
  observation provenance from
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md)
- Supports ProcessObserver event ingestion from
  [ADR-0033](0033-observe-processes-and-pull-scoped-andons.md)
- Refines record time, effective time, transactions, events, and idempotency
  from [ADR-0037](0037-store-facts-with-a-separate-event-ledger.md)
- Applies record identity, predicate reduction, and projection watermarks from
  [ADR-0039](0039-use-typed-source-native-subject-identities.md),
  [ADR-0040](0040-establish-facts-through-registered-predicate-contracts.md),
  and [ADR-0042](0042-use-rebuildable-projections-only-as-read-models.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [control-plane records and event ledger](../prd/agent-fleet.md#control-plane-records-and-event-ledger)
- Current implementation context:
  [queue execution boundary](../design/queue-execution-boundary.md),
  [work queue contract](../specs/work-queue.md), and
  [queue vertical spike](../plans/queue-vertical-spike.md)
- Delivery: [product foundation roadmap](../plans/product-foundation-roadmap.md)
