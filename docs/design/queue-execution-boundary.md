# Queue execution boundary

Living document. Rationale:
[ADR-0003](../adr/0003-separate-work-coordination-from-execution.md) and
[ADR-0004](../adr/0004-keep-models-outside-the-control-path.md),
[ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md), and
[ADR-0006](../adr/0006-enforce-admission-in-the-database.md), with the
per-repository coordinator named by
[ADR-0020](../adr/0020-call-the-repository-coordinator-repositorycontroller.md),
and promotion to the v1 work engine by
[ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md).
Contracts: [work queue](../specs/work-queue.md). Delivery:
[recovery plan](../plans/recover.md).

## Overview

Fluent turns approved maintenance intent into durable, bounded work for an
operator-started coding agent. Each enrolled repository has one logical
RepositoryController: deterministic code and durable repository state, work,
and history—not a model process. Maintenance specialists are work kinds and
portable procedures that capable external agents perform for bounded attempts.

```text
operator / approved policy / capable finding
                     │ proposed work or result
                     ▼
          deterministic validation
                     │ accepted state transition
                     ▼
             Fluent SQLite queue
                     │ MCP claim, lease, result, child work
                     ▼
          operator-started capable client
                     │
                     ▼
            repository and GitHub APIs

optional Flue + Lemonade ──► untrusted text/proposal ──► validation or operator
```

## Design

### Control plane

The application owns a SQLite work database separate from Flue's conversation
database. Deterministic code records repository enrollment, work status, action
limits, delegation limits, leases, results, artifacts, events, and parent/root
lineage.
Only enabled repositories are claimable. An expired lease is reclaimed in
place: the item stays in status `claimed` with its stale owner and expiry until
a later claim selects it, records `lease.expired`, and re-leases it; the old
lease token no longer authorizes mutation.

Seed work is deterministic in the vertical slice. The initial item asks a
capable agent to identify one meaningful testing gap and propose a test. The
finding is returned as evidence and may propose a child implementation item.
Worker children remain non-claimable until an operator or approved policy
admits them. Recursive decomposition uses the same contract at every level and
is capped at ten proposals per completion and four edges below a root.
Scheduling priority is operator-owned: seeds may set it, workers cannot, and
every child inherits its parent's value, so a proposal can never outrank the
lineage that produced it.

Admission is enforced twice. Application code filters claims on the
`admitted` flag and inserts children as proposals; SQLite triggers installed
by the migration independently abort any claim of an unadmitted row and any
admitted child insert, including legacy SQL that never mentions the column.
The database constraint is what stops a client still running pre-admission
code. Separately, `QueueStore` stamps a `SCHEMA_VERSION` into
`PRAGMA user_version`, refuses newer databases at open, and re-checks the
version inside every write transaction, so a process left running across a
future migration fails on its next write. That version check cannot reach
processes older than the check itself; those depend on the triggers and on the
operator restarting them.

The dogfood feeder is a deterministic catalog, not a planning agent. One
invocation offers one read-only discovery root for quality, CI, security, and
architecture and skips any specialty with an active root lineage. A continuous
worker may drain those admitted roots; all resulting children stop as
proposals.

### Optional local assistance

The queue operates without a model endpoint. An optional Flue clerk uses the
OpenAI-compatible Lemonade endpoint and exact model configured in the
environment for bounded experiments in shallow restatement and presentation.
It does not inspect repositories, decide architecture, authorize actions,
originate durable maintenance policy, or perform queue state transitions.

Every model response is untrusted input. Structured output does not make it
authoritative: accepting proposed work still requires deterministic validation
and, when it establishes organization intent, operator approval or an approved
policy. The provider adapter supplies a non-secret local placeholder for
libraries that require an API-key field; `LEMONADE_API_KEY` overrides it if the
endpoint is later protected.

### Worker boundary

The MCP server exposes list, inspect, claim, heartbeat, complete, block, and
release operations. A portable skill tells Codex, Claude, Copilot, and other
clients how to use that contract. The lease token is returned only by a
successful claim and must be treated as a secret capability.

The capable client is started by the operator. Fluent neither knows nor needs
its provider credentials. The client selects its own tools and isolation. It
must obey the item's `allowedActions`; child items must remain within the
parent's `delegableActions`. V1 never permits merge, release, or deploy.

Completion records a structured summary, concrete evidence, artifact URLs, and
zero or more bounded child items. Those reports are provenance, not independent
attestation. Deterministic checks can reject malformed, cross-repository, or
unauthorized artifact claims, but only reconciliation with GitHub or another
source can establish that an artifact exists and has the reported state.

### Trial findings

The first host-local trial used the then-current `bketelsen/fluent` locator.
The same repository identity was transferred to canonical `frostyard/fluent`
on 2026-08-16 under
[ADR-0045](../adr/0045-host-fluent-under-frostyard.md). One Claude invocation
completed a testing-gap discovery in about 44 seconds and created one bounded
implementation child. A second invocation completed the child in about 79
seconds, added artifact-authorization tests, created no grandchildren, and
stopped. Independent execution passed six tests, type checking, and the Flue
build.

The worker's claim that a clean Git diff proved source restoration was not valid
because the source tree was untracked. The implementation was correct when
independently inspected, but this difference between a plausible claim and
verified evidence establishes the need for a separate reconciliation layer.

During the trial the operator reviewed the discovery and manually launched the
second worker, which acted as an informal approval. Worker-created children now
enter `proposed`; a local operator approve/reject command records the admission
decision, and claims ignore proposals. A continuously available worker can
therefore drain admitted roots without recursively consuming its own output.

The first dogfood run then exposed a stale-client gap: an MCP server process
started before the admission change kept serving from the migrated database
and admitted three worker proposals through its old insert path. Nothing in
the database refused those writes. Admission is now a database trigger and the
schema carries a version marker (ADR-0006); the affected items were returned
to `proposed` by operator action, and restarting stale processes remains an
operator step the guard cannot perform.

## Operational notes

- `FLUENT_QUEUE_DB` selects the application queue database. SQLite assumes one
  host and uses WAL mode.
- Each queue connection installs its busy timeout as an SQLite open option,
  before reading or negotiating journal mode. Reopening an existing WAL
  database does not renegotiate the mode, so concurrent CLI, MCP, and feeder
  startup tolerates a connection finishing a write transaction instead of
  failing immediately with `SQLITE_BUSY`.
- Opening a database that is already at the current schema version performs no
  schema writes: `list`, `get`, and server start-up do not take the write lock
  or rebuild indexes. When `user_version` is behind the code, the forward-only
  migration ladder applies every missing rung inside a single write
  transaction; a newer database is refused. Rung 2 gives each database an
  immutable `database_id` that backups carry.
- Host layout for v1: one operator host, `FLUENT_QUEUE_DB` set to an absolute
  path outside the checkout (the default `./data/queue.db` is relative to the
  process working directory), MCP served over stdio from that host, and
  workers started by the operator on the same host. `npm run queue -- metadata`
  is the sanity check that a process is looking at the intended database.
- Backup: `npm run queue -- backup <new-path>` snapshots the live queue with
  `VACUUM INTO`, verifies the copy, and prints a manifest; save the manifest
  beside the file. `verify-backup <path>` re-derives it later. The backup file
  contains lease tokens and is created `0600`; keep it under the same access
  controls as the live database. Restore is a file operation: stop MCP servers
  and feeders, verify the backup, copy it to a new path, point
  `FLUENT_QUEUE_DB` at that path, and restart. Opening the copy migrates it to
  WAL mode; expired leases in it are reclaimed by the next claim. `VACUUM
  INTO` was chosen over `node:sqlite`'s asynchronous `backup()` because the
  latter stalled for ~30 s in-process on Node 26.7 whenever another SQLite
  connection was open and the source had fresh WAL frames; the synchronous
  snapshot has no threadpool hand-off to race.
- Every MCP server process and CLI invocation opens its own connection to the
  queue file, so long-lived processes can outlive a code change. Restart
  Fluent MCP servers after upgrading; the database triggers and schema-version
  guard turn a forgotten restart into a hard write failure rather than silent
  drift, but only the operator can restart the process.
- The spike serves MCP over stdio, so the MCP host and Fluent checkout share a
  machine. Remote Incus clients will need authenticated Streamable HTTP or an
  equivalent bridge before production use.
- The spike uses Node's built-in SQLite API. The production runtime and storage
  support policy remain unresolved.
- The optional Flue HTTP app listens on all interfaces on `PORT` (default
  `3000`). Its `/agents/*` routes fail closed unless `FLUENT_APP_TOKEN` is set
  and require an exact `Authorization: Bearer <token>` header. The unauthenticated
  `/health` response contains only `{ "status": "ok" }`, not queue data.
  Operators must also firewall the port or place it behind an authenticated
  reverse proxy; the shared token is a single-operator v1 boundary, not the
  future named-member authorization model.
- MCP stdout is protocol-only; operational logging goes to stderr.
- A missing heartbeat does not move an item back to the queue. The item keeps
  status `claimed` (and its stale `leaseOwner`/`leaseExpiresAt`), so `list
  queued` and the queued count omit it while `list claimed` and the claimed
  count still include it; it becomes claimable again only when a later claim
  selects it, which records `lease.expired` and re-leases it in place. Side
  effects made before lease loss may still have happened, so workers and later
  reconciliation must use idempotent artifact handling.
- A blocked item is not claimable. Only the operator can resume it with
  `queue requeue <id> <reason>` or retire it with `queue cancel <id> <reason>`.
  Both paths record actor-attributed reason events; neither is exposed through
  MCP.
- An operator can withdraw admission from queued, unclaimed work with `queue
  defer <id> <reason>`. The item remains in history as logical `proposed`,
  records `work.deferred`, and can later be approved or rejected normally.
  Workers cannot defer or approve work through MCP.
- The worker skill stops after one item unless the operator explicitly asks for
  more. This is a token and blast-radius boundary, not a throughput limit.
- The dogfood feeder creates missing specialty roots as one SQLite write
  transaction. Its uncapped active-lineage check and all inserts share that
  lock, so concurrent feeder processes serialize without creating duplicate
  active roots and a partial batch cannot survive an error. Run it on a timer;
  a kind whose last assessment completed within the cooldown (default 24 h)
  without proposing a child is reported as cooled rather than re-asked.
- Work sources: besides operator seeds and worker proposals, `npm run queue --
  import-issues <owner/repo> --label <label>` turns labeled open GitHub issues
  into `proposed` roots of kind `issue-resolution` with `open-pr` authority.
  The issue URL is the item's `sourceRef` and the idempotency key, so the
  command is safe to repeat; nothing is claimable until the operator approves
  it. Fluent reads issues with the optional `FLUENT_GITHUB_TOKEN`; the issue
  body is quoted to the worker as untrusted context. Closure sync is a later
  step in the recovery plan.
- Artifact verification: `complete_work` checks each reported issue and pull
  request against the GitHub API under Fluent's own credential before the
  completion transaction. Wrong repository, wrong number, wrong kind, or
  nonexistent → the completion is refused and the item stays claimed. Confirmed
  → the artifact carries `verification` (state, head SHA, merge time). GitHub
  unavailable → the completion is accepted as `unverified` with the reason;
  `npm run queue -- verify-artifacts` re-checks unverified and still-open
  artifacts later and records `artifact.verified` events, so a GitHub outage
  costs a delayed observation, not a lost completion. Completed items expose a
  derived `delivery` (`none`, `unverified`, `open`, `closed`, `merged`) — the
  merge of the reported pull request, kept distinct from outcome achievement
  ([ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md)).
  This is the bounded on-demand form of
  [ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md);
  webhook observation stays parked under
  [ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md).
- The Lemonade smoke result establishes endpoint compatibility only. It does
  not establish model sufficiency for queue planning or general orchestration.

## References

- Rationale:
  [ADR-0003](../adr/0003-separate-work-coordination-from-execution.md) and
  [ADR-0004](../adr/0004-keep-models-outside-the-control-path.md), plus
  [ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md) and
  [ADR-0006](../adr/0006-enforce-admission-in-the-database.md), with current
  terminology from
  [ADR-0020](../adr/0020-call-the-repository-coordinator-repositorycontroller.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md)
- Contracts: [work queue](../specs/work-queue.md)
- Built in: [queue vertical spike](../plans/queue-vertical-spike.md)
- Promotion decision and plan:
  [ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md) and
  [recovery plan](../plans/recover.md), superseding
  [ADR-0044](../adr/0044-replace-the-queue-spike-database.md) and the
  [control-plane kernel bootstrap](../plans/control-plane-kernel-bootstrap.md)
  cutover
- Source repository ownership:
  [ADR-0045](../adr/0045-host-fluent-under-frostyard.md)
