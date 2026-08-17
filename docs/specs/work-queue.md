# Spec: Work queue

This contract governs durable maintenance items exchanged between Fluent and
operator-started capable agents. The CLI seeds administrative work; MCP clients
claim, renew, and resolve it.

## Interface

### Work item

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `id` | UUID | yes | Immutable item identity |
| `rootId` | UUID | yes | Root of the decomposition tree |
| `parentId` | UUID | child only | Direct parent item |
| `repository` | string | yes | Must be currently opted in to be seeded or claimed |
| `kind` | string | yes | Worker-selectable maintenance kind |
| `objective` | string | yes | One bounded outcome |
| `instructions` | string | yes | Execution constraints and expected reporting |
| `acceptanceCriteria` | string[] | yes | At least one verifiable criterion |
| `allowedActions` | action[] | yes | Authority for this item |
| `delegableActions` | action[] | yes | Maximum authority for direct children |
| `priority` | integer | yes | Safe integer; higher values claim first, creation time breaks ties. Chosen only by operator or policy seeds; worker-created children inherit the parent's value |
| `status` | enum | yes | `proposed`, `queued`, `claimed`, `completed`, `blocked`, or `cancelled` |
| `createdBy` | string | yes | Operator, policy, or worker provenance |
| `leaseOwner` | string | claimed only | Worker identity supplied at claim |
| `leaseToken` | UUID | claim response only | Secret mutation capability; omitted by every other response |
| `leaseExpiresAt` | timestamp | claimed only | UTC expiry |
| `result` | result | completed, blocked, or cancelled with a reason only | Completed: worker summary, evidence, and artifacts. Blocked: `summary` is the block reason with empty `evidence` and `artifacts`. Cancelled by proposal rejection or blocked-work cancellation: `summary` is the operator reason with empty `evidence` and `artifacts`. Absent on `proposed`, `queued`, and `claimed` items |

The action vocabulary is `read`, `write`, `run-tests`, `open-issue`,
`open-pr`, and `create-followup`. Merge, release, and deploy are absent and
therefore cannot be granted.

An artifact has a `kind` (`issue`, `pull-request`, `commit`, `report`, or
`other`), an HTTPS `url`, and an optional description. GitHub issue, pull
request, and commit artifacts MUST name the work item's repository and use the
path shape for their kind. This validates the claim's scope, not the artifact's
existence. A completion result has a non-empty summary, an evidence string
array, and an artifact array.

### MCP tools

| Tool | Purpose | Required authority |
| --- | --- | --- |
| `list_work` | Filter queue bookkeeping by status/repository | None; never returns lease token |
| `get_work` | Read one item and its lineage fields | None; never returns lease token |
| `claim_work` | Lease the highest-priority eligible item | Worker identity outside the reserved principal namespaces; optional repository/kind filters |
| `heartbeat_work` | Renew an active lease for 30–3600 seconds | Matching item, worker, and lease token |
| `complete_work` | Atomically store a result and up to ten child items | Matching item, worker, and lease token |
| `block_work` | Preserve an item as blocked; the reason is stored as `result.summary` and in the `work.blocked` event payload | Matching item, worker, and lease token |
| `release_work` | Return unstarted or mismatched work to the queue | Matching item, worker, and lease token |

All tool responses expose the value both as JSON text and under structured
content key `value`.

### Administrative CLI

```text
npm run queue -- opt-in <owner/repo>
npm run queue -- opt-out <owner/repo>
npm run queue -- seed-testing-gap <owner/repo>
npm run queue -- seed-dogfood <owner/repo>
npm run queue -- approve <work-item-id>
npm run queue -- reject <work-item-id> <reason>
npm run queue -- defer <work-item-id> <reason>
npm run queue -- requeue <work-item-id> <reason>
npm run queue -- cancel <work-item-id> <reason>
npm run queue -- list [proposed|queued|claimed|completed|blocked|cancelled]
```

`seed-testing-gap` creates exactly one read-only discovery item that may create
a follow-up. It does not call a model.

`seed-dogfood` deterministically creates at most one active read-only root for
each initial maintenance specialty: quality, CI, security, and architecture.
Re-running it skips a specialty while any non-terminal item remains in that
root lineage. It does not call a model.

`approve` changes one worker-created `proposed` item to claimable `queued` work
and records `work.approved`. `reject` changes one proposal to `cancelled`,
stores the reason as `result.summary` (with empty `evidence` and `artifacts`),
and records `work.rejected` with the reason in its event payload. These commands are local
operator surfaces and are not exposed to workers through MCP.

`defer` withdraws admission from queued, unclaimed work without discarding its
definition or history. The item becomes logical `proposed`, is no longer
claimable, records `work.deferred` with the operator reason, and may later pass
through the normal `approve` or `reject` review path. It is not exposed through
MCP.

`requeue` and `cancel` are operator-only exits for `blocked` work. Requeue
clears the block result and returns the admitted item to claimable `queued`
state with a `work.requeued` event. Cancel stores the operator reason in
`result.summary`, moves the item to terminal `cancelled`, and records
`work.cancelled`. Neither operation is exposed through MCP.

## Rules

1. Seeding work for a repository that is not opted in MUST fail.
2. Claiming MUST consider only queued work in currently opted-in repositories.
3. A claim MUST be atomic and return no more than one item.
4. An expired claim MAY be reclaimed. The previous lease token MUST then fail
   all mutations.
5. Heartbeat, complete, block, and release MUST require the matching lease
   token and worker identity.
6. Completion and child proposal creation MUST commit in one transaction or
   not at all.
7. A parent MUST include `create-followup` in `allowedActions` to create a
   child.
8. Every child action in both `allowedActions` and `delegableActions` MUST be a
   member of the parent's `delegableActions`.
9. Child `parentId` MUST name its direct parent and `rootId` MUST equal the
   ancestor root. Worker-created children MUST begin as non-claimable
   `proposed` work.
10. Reporting an issue, pull request, or commit artifact MUST require the
    corresponding `open-issue`, `open-pr`, or `write` action.
11. Only a successful `claim_work` response MAY reveal a lease token. Listing,
    inspection, heartbeat, administrative CLI output, events, logs, completion,
    blocking, and release MUST NOT reveal it.
12. Disabling a repository MUST prevent new claims without erasing its history.
13. Worker evidence and artifact URLs MUST be retained as provenance but MUST
    NOT be treated as independently verified facts.
14. Every queue mutation MUST be accepted or rejected by deterministic code.
    Model output MUST NOT bypass repository, lease, action, delegation, or
    input validation.
15. A reported GitHub issue, pull request, or commit URL MUST use HTTPS on
    `github.com`, MUST match the work item's `owner/repository` slug
    case-insensitively, and MUST use `/issues/<positive integer>`,
    `/pull/<positive integer>`, or `/commit/<7-64 hexadecimal characters>` for
    its declared kind. Query strings, fragments, credentials, and additional
    path segments MUST be rejected.
16. Passing artifact URL validation MUST be described as scope validation, not
    verification that the artifact exists or contains the reported change.
17. Claim selection MUST ignore `proposed` work. Only an explicit operator or
    approved deterministic-policy admission may change a proposal to `queued`.
    Admission and rejection MUST record actor-attributed events.
18. A completion MUST propose at most ten children, and a child MUST NOT be
    created more than four parent-child edges below its root. Violations MUST
    roll back the entire completion.
19. The dogfood feeder MUST create only read-only discovery roots, MUST create
    at most four roots per invocation, and MUST NOT duplicate a specialty while
    that specialty has a non-terminal root or descendant in the repository.
20. The database MUST enforce admission independently of application code:
    any statement that moves a work item to `claimed` while its `admitted`
    flag is `0` before or after the statement MUST fail, and any insert of a
    child item (non-null `parentId`) with `admitted = 1` MUST fail. This holds
    for legacy SQL that omits the `admitted` column entirely. `approve` is the
    only application path that sets `admitted = 1`, and only while the item is
    `queued`.
21. `QueueStore` MUST record its code-defined schema version in SQLite
    `PRAGMA user_version`, MUST refuse to open a database whose version is
    newer than its own, and MUST re-check the version inside each write
    transaction so an already-open store rejects its next mutation after
    another process migrates the database forward. This guard bounds future
    version drift only; processes running code from before the guard existed
    are stopped by rule 20's database constraint, not by this check.
22. Scheduling priority is operator-owned. Only operator-authored or
    approved-policy seed work MAY specify `priority`, and it MUST be a safe
    integer. A worker follow-up MUST NOT carry a `priority` field: the MCP
    schema MUST reject it as an unknown key rather than strip it, and
    `QueueStore` MUST independently reject it and roll back the whole
    completion. An accepted child MUST inherit its parent's exact `priority`.
23. The principal namespaces `operator:`, `policy:`, and `system:` (and the
    bare identity `system`) are reserved for Fluent's own operator, policy,
    and lease-expiry actors. A worker identity supplied to `claim_work`,
    `heartbeat_work`, `complete_work`, `block_work`, or `release_work` MUST be
    rejected, case-insensitively, when it uses a reserved namespace, at both
    the MCP schema and `QueueStore`, so `createdBy` and event actors cannot be
    spoofed to look operator- or system-authored.
24. A `blocked` item MUST leave that state only through an operator-attributed
    requeue or cancellation. Requeue MUST preserve admission, clear the block
    result and lease fields, return the item to claimable `queued`, and record
    `work.requeued`. Cancellation MUST clear lease fields, store the operator
    reason as `result.summary`, move the item to terminal `cancelled`, and
    record `work.cancelled`. Neither operation is a worker MCP tool.
25. An operator MAY withdraw admission only from an admitted, unclaimed
    `queued` item. Deferral MUST preserve the definition and stored `queued`
    status, set `admitted = 0`, record `work.deferred` with actor and reason,
    make the item logically `proposed` and unclaimable, and leave it eligible
    for the existing approval or rejection paths. Deferral MUST NOT be exposed
    through worker MCP.
26. A deterministic feeder that suppresses duplicate active root kinds MUST
    perform its active-lineage check and all root insertions in one SQLite
    write transaction. The check MUST be uncapped, concurrent feeder calls
    MUST create at most one active root per kind, and any validation or insert
    failure MUST roll back the whole batch. Repository opt-in MUST be checked
    under the same write lock as root insertion.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| SQLite schema | Created by `QueueStore` from this work-item model; admission triggers and `user_version` per rules 20–21 |
| MCP worker behavior | Portable `work-fluent-queue` skill constrained by this contract |
| Testing-gap seed | Deterministic CLI instance of this contract |

## References

- Rationale:
  [ADR-0003](../adr/0003-separate-work-coordination-from-execution.md) and
  [ADR-0004](../adr/0004-keep-models-outside-the-control-path.md), with
  admission policy from
  [ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md) and
  database-enforced admission from
  [ADR-0006](../adr/0006-enforce-admission-in-the-database.md)
- Product: [maintenance fleet PRD](../prd/agent-fleet.md)
- Context: [queue execution boundary](../design/queue-execution-boundary.md)
- Delivery: [queue vertical spike](../plans/queue-vertical-spike.md)
- Promotion decision and plan:
  [ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md) and
  [recovery plan](../plans/recover.md), superseding
  [ADR-0044](../adr/0044-replace-the-queue-spike-database.md) and the
  [control-plane kernel bootstrap](../plans/control-plane-kernel-bootstrap.md)
  cutover
