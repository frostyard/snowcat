# Plan: Queue vertical spike

This plan proves one recursively decomposable maintenance item can travel from
deterministic intent through Fluent to a manually started capable client,
without Fluent managing that client or its credentials.

## Phase 1 — Durable contract (completed)

- Implement repository opt-in, leases, events, evidence, and parent-child
  lineage from the [work queue spec](../specs/work-queue.md).
- Seed a read-only testing-gap discovery item without a model call.
- Enforce action and delegation ceilings transactionally.
- **Done when:** automated tests prove opt-in, claim recovery, lineage, and
  permission-escalation rejection against SQLite.

## Phase 2 — Portable worker handoff (completed)

- Expose the [queue execution boundary](../design/queue-execution-boundary.md)
  with stdio MCP tools.
- Add a portable `work-fluent-queue` skill that claims one item, protects its
  lease, reports evidence, and stops.
- Exercise the MCP server with the official client transport in an automated
  integration test.
- **Done when:** an MCP client claims a seed item, completes it with one bounded
  child, and the database shows a completed parent plus queued child.

## Phase 3 — Optional local clerk compatibility (completed)

- Register Lemonade's OpenAI-compatible model with Flue.
- Restrict the clerk prompt and model settings to shallow instruction and
  bookkeeping.
- Confirm the model can produce visible concise output without spending its
  entire response budget on hidden reasoning.
- **Done when:** the application builds and a live clerk request reaches the
  configured Lemonade model and returns a usable response. This proves provider
  compatibility, not model sufficiency.

## Phase 4 — Host-local real repository trial (completed)

- Opt in the current repository or another explicitly selected repository.
- Run Fluent directly on the operator host; containerization and remote worker
  transport are deliberately deferred.
- Have the operator start one capable client on that host and say "work the
  Fluent queue."
- Review the testing-gap evidence before permitting its implementation child.
- Record token use, elapsed time, lease behavior, result quality, and any
  GitHub artifact created.
- **Done when:** one host-local, operator-started client produces a reviewable
  discovery result and a second invocation completes or deliberately blocks
  its child, with full queue lineage and no Fluent-managed client process.

Observed on 2026-08-14 with `bketelsen/fluent`:

- Discovery completed in about 44 seconds and created one bounded child.
- Implementation completed in about 79 seconds, created no grandchildren, and
  independently passed six tests, type checking, and the Flue build.
- Both workers claimed one item and stopped; no GitHub artifact was authorized
  or created.
- One evidence claim relied on `git diff` while the relevant files were
  untracked. The code was correct, but the claimed proof was invalid.

## Phase 5 — Deterministic artifact scope (completed)

- Extend the [work queue contract](../specs/work-queue.md) so GitHub issue,
  pull-request, and commit claims must match the work item's repository and
  declared artifact kind.
- Add adversarial tests for cross-repository URLs, kind/path mismatches,
  credentials, query/fragment ambiguity, invalid identifiers, and transaction
  rollback.
- Retain the distinction between scope validation and external verification.
- **Done when:** valid repository-scoped claims complete successfully, invalid
  claims leave the item leased and unchanged, and the full project check
  passes.

Implemented on 2026-08-14 with adversarial coverage for cross-repository and
kind/path mismatches, invalid identifiers, extra paths, query strings,
fragments, lookalike hosts, URL credentials, atomic rollback, and valid
repository-scoped issue, pull-request, and commit claims. The full check passes
with eight tests.

## Phase 6 — Secret-safe observation (completed)

- Make the successful claim response the only surface that reveals a lease
  token, as required by the [work queue contract](../specs/work-queue.md).
- Redact tokens from heartbeat responses and administrative queue listings.
- Add protocol and CLI regressions proving routine observation cannot copy a
  live capability into logs or shell output.
- **Done when:** a worker can still heartbeat and complete with its retained
  token, while MCP and CLI observation return no token and the full check
  passes.

Implemented on 2026-08-14. The claim response remains the only token-bearing
surface; heartbeat, MCP list/get, and administrative CLI list output are
redacted. The full check passes with nine tests.

## Phase 7 — Dogfood admission gate (completed)

- Put every worker-created child in non-claimable `proposed` state according to
  [ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md).
- Add local operator approve/reject commands and actor-attributed events.
- Bound one completion to ten proposals and root decomposition to four edges.
- Update the portable worker skill so even an explicit loop never consumes or
  approves its own proposals.
- **Done when:** a continuous worker can drain admitted roots but cannot claim
  its output until an operator admits it, rejected proposals remain auditable,
  migrated queue data remains readable, and the full check passes.

Implemented on 2026-08-14. Existing work migrates as admitted, proposals are
not claimable, and the full check passes with eleven tests.

## Phase 8 — Bounded dogfood feeder (completed)

- Add a deterministic four-item catalog for quality, CI, security, and
  architecture discovery.
- Give roots read and follow-up-proposal authority only; implementation actions
  are delegation ceilings, not root authority.
- Skip a specialty while any work in its root lineage is non-terminal.
- **Done when:** re-running the feeder cannot duplicate active work, every root
  is bounded and read-only, resulting children remain proposed, and the full
  project check passes.

Implemented on 2026-08-14. The full check passes with twelve tests.

## Phase 9 — Database-enforced admission (completed)

- Enforce proposal admission in SQLite according to
  [ADR-0006](../adr/0006-enforce-admission-in-the-database.md), independently
  of application claim and child-insertion code.
- Reject claims of non-admitted work and reject admitted child inserts,
  including statements issued by legacy clients that omit the admission
  column.
- Record the code-defined schema version in `PRAGMA user_version`, reject a
  newer database at open, and re-check the version inside every write
  transaction.
- **Done when:** adversarial legacy SQL cannot admit or claim a proposal, a
  newer schema stops both newly opened and already-open stores from mutating,
  and the behavior matches the [queue execution boundary](../design/queue-execution-boundary.md)
  and [work queue rules 20–21](../specs/work-queue.md#rules).

Implemented on 2026-08-15. The database triggers stop pre-guard clients from
bypassing admission; the schema-version check bounds drift only for clients
that implement it. Restarting stale processes remains an operator action.

## Phase 10 — Operational queue hardening (completed)

- Keep scheduling and provenance operator-owned: worker proposals inherit
  priority, and worker identities cannot use Fluent's reserved `operator:`,
  `policy:`, or `system:` principal namespaces.
- Add actor-attributed operator exits for deferred admission and blocked work:
  `defer`, `requeue`, and `cancel` remain outside the worker MCP surface.
- Make dogfood specialty de-duplication and root insertion one uncapped,
  transactional operation so concurrent feeders cannot create duplicate active
  roots and a partial batch cannot survive an error.
- Harden routine operation with SQLite lock waiting, transactional idempotent
  migration, strict CLI status parsing, shell-independent test discovery, and
  a Node 22/24 CI matrix that runs the same `npm run check` gate as local work.
- Fail the optional HTTP agent routes closed without `FLUENT_APP_TOKEN`, require
  bearer authentication when configured, and keep unauthenticated health data
  free of queue counts.
- **Done when:** [work queue rules 22–26](../specs/work-queue.md#rules) and the
  [queue execution boundary operational notes](../design/queue-execution-boundary.md#operational-notes)
  are enforced, concurrent feeder and release/reclaim regressions pass, and CI
  runs the complete local gate on every advertised Node major.

Implemented on 2026-08-15. Positive store and stdio MCP coverage now proves
release, stale-token rejection, and reclaim by another worker. The full Node
22.19 check passes with 33 tests, type checking, and the production build.

## Later / ideas

- Containerization and authenticated Streamable HTTP for remote workers.
- GitHub artifact reconciliation and independent evidence verification after
  deterministic scope validation.
- Capability-aware matching, scheduling, budgets, retry ceilings, and
  dead-letter policy.
- Event streaming for the operator UI; WebSocket is not required by pull
  workers.

## Open questions

- **Remote transport:** choose authentication and client identity before the
  first worker runs outside the Fluent host.
- **Production SQLite binding:** choose a supported Node runtime or database
  binding before treating the spike store as production.
- **Future automatic admission:** dogfood begins with operator admission for
  every proposal. Use trial evidence before deciding whether any narrow class
  can be safely admitted by an approved deterministic policy.

## References

- Product: [maintenance fleet PRD](../prd/agent-fleet.md)
- Rationale:
  [ADR-0003](../adr/0003-separate-work-coordination-from-execution.md) and
  [ADR-0004](../adr/0004-keep-models-outside-the-control-path.md), with
  [ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md) and
  [ADR-0006](../adr/0006-enforce-admission-in-the-database.md)
- Implements: [queue execution boundary](../design/queue-execution-boundary.md)
  and [work queue](../specs/work-queue.md)
- Successor: [control-plane kernel bootstrap](control-plane-kernel-bootstrap.md)
  under [ADR-0044](../adr/0044-replace-the-queue-spike-database.md); spike rows
  are archived rather than imported at target cutover
