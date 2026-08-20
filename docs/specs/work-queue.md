# Spec: Work queue

This contract governs durable maintenance items exchanged between Snowcat and
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
| `priority` | integer | yes | Safe integer; higher values claim first, creation time breaks ties. Chosen only by operator or policy seeds; worker-created children inherit the parent's value; changed afterwards only by the operator `prioritize` command (rule 38) |
| `status` | enum | yes | `proposed`, `queued`, `claimed`, `completed`, `blocked`, or `cancelled` |
| `createdBy` | string | yes | Operator, policy, or worker provenance |
| `sourceRef` | string | imported roots only | Stable external origin (for example the GitHub issue URL); unique per repository, at most 512 characters, never changes |
| `predecessors` | string[] | optional | Source references this item waits for (rule 58); at most 20 GitHub issue URLs of at most 512 characters each, deduplicated and sorted. Declared only on an imported proposed root, absent when none |
| `leaseOwner` | string | claimed only | Worker identity supplied at claim |
| `leaseToken` | UUID | claim response only | Secret mutation capability; omitted by every other response |
| `leaseExpiresAt` | timestamp | claimed only | UTC expiry |
| `delivery` | enum | completed only | Derived from pull-request artifact verifications: `none` (no pull request reported), `unverified`, `open`, `closed`, or `merged`. Delivery is the merge of the reported pull request, not outcome achievement |
| `result` | result | completed, blocked, or cancelled with a reason only | Completed: worker summary, evidence, and artifacts. Blocked: `summary` is the block reason with empty `evidence` and `artifacts`. Cancelled by proposal rejection or blocked-work cancellation: `summary` is the operator reason with empty `evidence` and `artifacts`. Absent on `proposed`, `queued`, and `claimed` items |
| `operatorNotes` | note[] | yes | Operator and policy annotations carried on the item, oldest first, each `{ at, actor, action, reason }` with `action` one of `requeue`, `defer`, `prioritize`, or `note`. Appended by `requeue`, `defer`, `prioritize`, and `note`; empty on creation; never written by a worker or through MCP |
| `previousResults` | result[] | yes | Results superseded by an operator requeue, oldest first: each is the block `result` that requeue cleared. Empty until the first requeue; never trimmed |

The action vocabulary is `read`, `write`, `run-tests`, `open-issue`,
`open-pr`, and `create-followup`. Merge, release, and deploy are absent and
therefore cannot be granted.

An artifact has a `kind` (`issue`, `pull-request`, `commit`, `report`, or
`other`), an HTTPS `url`, and an optional description. GitHub issue, pull
request, and commit artifacts MUST name the work item's repository and use the
path shape for their kind. A completion result MAY carry `model`, the model
the worker says it ran (a short identifier such as `claude-opus-5`): it is
descriptive provenance under rule 13 — retained, never verified, granting
nothing — that the review gate (rules 52–55) copies into later rounds so a
reviewer can prefer a different model. This validates the claim's scope, not the artifact's
existence. Issue and pull-request artifacts additionally carry a
`verification`, Snowcat's own observation of the artifact through the GitHub
API: `{ status: "verified", verifiedAt, number, state: open | closed | merged,
headSha?, mergedAt?, closedAt? }` or `{ status: "unverified", attemptedAt,
reason }`. Workers never supply it. A completion result has a non-empty
summary, an evidence string array, and an artifact array.

### MCP tools

| Tool | Purpose | Required authority |
| --- | --- | --- |
| `list_work` | Filter queue bookkeeping by status/repository | None; never returns lease token |
| `get_work` | Read one item and its lineage fields | None; never returns lease token |
| `claim_work` | Lease the highest-priority eligible item | Worker identity outside the reserved principal namespaces; optional repository/kind filters, intersected with the credential's own kind restriction (rule 50) |
| `heartbeat_work` | Renew an active lease for 30–3600 seconds | Matching item, worker, and lease token |
| `complete_work` | Verify reported issues and pull requests against GitHub, then atomically store a result and up to ten child items | Matching item, worker, and lease token |
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
npm run queue -- prioritize <work-item-id> <priority> <reason>
npm run queue -- note <work-item-id> <text>
npm run queue -- attach-artifact <work-item-id> <url> [--kind pull-request|issue] [--description <text>]
npm run queue -- list [proposed|queued|claimed|completed|blocked|cancelled]
npm run queue -- show <work-item-id>
npm run queue -- events [--since <sequence>] [--repository <owner/repo>] [--limit <1-500>]
npm run queue -- watch [--repository <owner/repo>] [--interval <seconds>]
npm run queue -- metrics [--repository <owner/repo>] [--since <iso>] [--until <iso>]
```

`seed-testing-gap` creates exactly one read-only discovery item that may create
a follow-up. It does not call a model.

`seed-dogfood` deterministically creates at most one active read-only root for
each maintenance program in the catalog (`src/queue/programs.ts`: quality, CI,
security, architecture, conformance, triage, dependencies, and docs, each with
its own no-finding cooldown).
`seed-dogfood --enrolled` offers a repository only the programs
its Core declaration lists in `maintenance_programs` and reports the rest as
`undeclaredKinds`; `seed-dogfood <owner/repo>` offers the whole catalog.
Re-running either skips a program while any non-terminal item remains in that
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

`events` and `watch` are the read-only observation surface over the event
ledger. `events` prints the events strictly after a global sequence, oldest
first, each joined with its item's repository, kind, source reference, and
current status; `watch` polls the same read from the current last sequence and
prints one JSON line per new event until interrupted. Neither mutates the queue
and neither is exposed through MCP.

`metrics` is the PRD baseline reading over one window (rule 56): how much work
the window created and where it stands now, how often workers attempted it,
what they completed and how much of that GitHub merged, and how long the merges
took. It aggregates the ledger and the current items, mutates nothing, and is
not exposed through MCP.

`requeue` and `cancel` are operator-only exits for `blocked` work. Requeue
moves the block result to the end of `previousResults`, appends a `requeue`
note with the operator reason to `operatorNotes`, and returns the admitted item
to claimable `queued` state with a `work.requeued` event. Cancel stores the
operator reason in `result.summary`, moves the item to terminal `cancelled`,
and records `work.cancelled`. Neither operation is exposed through MCP.

`prioritize` changes the scheduling priority of one `proposed`, `queued`, or
`blocked` item to a safe integer, appends a `prioritize` note with the operator
reason to `operatorNotes`, and records `work.prioritized` with the previous
and new priority and the reason. It refuses `claimed`, `completed`, and
`cancelled` items and any actor outside the operator and policy namespaces.
It is the only way priority changes after creation: children still inherit
their parent's value when they are created, and workers still cannot supply a
priority anywhere. It is not exposed through MCP.

`note` appends one operator annotation to `operatorNotes` without changing the
item's status, admission, lease, or result, and records `work.noted` with the
text as its `reason`. It is how an operator tells the next lease what happened
on earlier ones ("PR #5 already exists — re-report it, no code change needed")
when no state change is due. Notes are advice, not definition: they override
nothing in the objective, instructions, acceptance criteria, or actions. The
command is not exposed through MCP.

`attach-artifact` records one pull request or issue the worker did not report
against a `completed` item — typically a follow-up that stayed on a local
branch whose pull request the operator opened by hand — so `delivery` and
later `verify-artifacts` passes see it. The URL is checked against GitHub
first, exactly as `complete_work` checks a worker's report; the kind defaults
from the URL path. It is an operator command only and is not exposed through
MCP (rule 41).

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
    at most one root per catalog program per invocation, MUST NOT duplicate a
    program while that program has a non-terminal root or descendant in the
    repository, and, when run for enrolled repositories, MUST offer a
    repository only the programs its Core declaration lists.
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
    another process migrates the database forward. A database at an older
    supported version MUST be upgraded in place through a forward-only,
    numbered migration ladder inside one write transaction: rung N upgrades
    version N-1 to N, rungs are appended and never edited or reordered, every
    rung is idempotent, and `SCHEMA_VERSION` equals the ladder length. Rung 1
    is the baseline schema with admission triggers; rung 2 adds
    `queue_metadata` carrying an immutable per-database `database_id` and
    `created_at`; rung 3 adds `source_ref`; rung 4 adds `operator_notes_json`
    and `previous_results_json` (rule 37); rung 5 adds `cure_json` (rule 44);
    rung 6 adds `repositories.cure_foreign` (rule 42); rung 7 adds
    `mcp_tokens` (rule 49); rung 8 adds `review_json` and
    `repositories.review_gate` (rules 52–53); rung 9 adds
    `mcp_tokens.kinds_json`, the claim restriction of rule 49, `NULL` for
    every token that existed before it; rung 10 adds
    `repositories.unreported_pull_requests_json`, the unreported
    pull-request observation of rule 53, `NULL` for every repository that
    existed before it; rung 11 adds
    `repositories.labeled_issue_observations_json`, the latest successful
    labeled-issue import observation of rule 57, `NULL` for every repository
    that existed before it; rung 12 adds `work_items.predecessors_json`, the
    predecessor source references of rule 58, `NULL` for every item that
    existed before it. Processes running code from before
    the version guard existed are stopped by rule 20's database constraint,
    not by this check.
22. Scheduling priority is operator-owned. Only operator-authored or
    approved-policy seed work MAY specify `priority`, and it MUST be a safe
    integer. A worker follow-up MUST NOT carry a `priority` field: the MCP
    schema MUST reject it as an unknown key rather than strip it, and
    `QueueStore` MUST independently reject it and roll back the whole
    completion. An accepted child MUST inherit its parent's exact `priority`
    at creation; an operator MAY change it afterwards only through rule 38.
23. The principal namespaces `operator:`, `policy:`, and `system:` (and the
    bare identity `system`) are reserved for Snowcat's own operator, policy,
    and lease-expiry actors. A worker identity supplied to `claim_work`,
    `heartbeat_work`, `complete_work`, `block_work`, or `release_work` MUST be
    rejected, case-insensitively, when it uses a reserved namespace, at both
    the MCP schema and `QueueStore`, so `createdBy` and event actors cannot be
    spoofed to look operator- or system-authored.
24. A `blocked` item MUST leave that state only through an operator-attributed
    requeue or cancellation. Requeue MUST preserve admission, clear the lease
    fields, move the block `result` to the end of `previousResults` rather than
    discard it, append a `requeue` note carrying the operator reason to
    `operatorNotes` (rule 37), return the item to claimable `queued`, and
    record `work.requeued`. Cancellation MUST clear lease fields, store the
    operator reason as `result.summary`, move the item to terminal
    `cancelled`, and record `work.cancelled`. Neither operation is a worker
    MCP tool.
25. An operator MAY withdraw admission only from an admitted, unclaimed
    `queued` item. Deferral MUST preserve the definition and stored `queued`
    status, set `admitted = 0`, record `work.deferred` with actor and reason,
    append a `defer` note carrying that reason to `operatorNotes` (rule 37),
    make the item logically `proposed` and unclaimable, and leave it eligible
    for the existing approval or rejection paths. Deferral MUST NOT be exposed
    through worker MCP.
26. A deterministic feeder that suppresses duplicate active root kinds MUST
    perform its active-lineage check and all root insertions in one SQLite
    write transaction. The check MUST be uncapped, concurrent feeder calls
    MUST create at most one active root per kind, and any validation or insert
    failure MUST roll back the whole batch. Repository opt-in MUST be checked
    under the same write lock as root insertion.
27. `list [status] [--repository <owner/repo>] [--kind <kind>] [--limit
    <1-100>]` MUST filter on any combination and `show <id>` MUST print one
    item with its complete event history; neither MAY reveal a lease token.
    `metadata` MUST report the resolved database path, `database_id`,
    schema version, creation time, item and event counts, and the last event
    sequence, without exposing any lease token. `QueueStore.eventsSince
    (sequence, { repository?, limit? })` and the `events [--since <sequence>]
    [--repository <owner/repo>] [--limit <1-500>]` command over it MUST
    return only events whose global `sequence` is strictly greater than the
    cursor, in ascending sequence order across all items, each joined with its
    item's `repository`, `kind`, `sourceRef`, and current logical status;
    `watch [--repository <owner/repo>] [--interval <seconds>]` MUST poll that
    read from the last sequence at startup (default every 10 seconds, never
    more often than every 2 seconds), print one JSON line per new event, and
    stop on SIGINT or SIGTERM. Both are read-only, MUST NOT reveal a lease
    token in any event, and MUST NOT be exposed through MCP.
28. `backup <path>` MUST refuse `:memory:`, the live database path, and any
    existing path; MUST reserve the new file with mode `0600` before writing;
    MUST copy a consistent snapshot with `VACUUM INTO` on the live connection;
    and MUST then re-open the copy read-only, pass `PRAGMA quick_check`,
    and confirm the copy carries the live `database_id`, the supported schema
    version, and an event sequence no older than the live ledger at the start
    of the backup, before printing a manifest containing the backup path,
    `database_id`, schema version, counts, last event sequence, SHA-256 of the
    file, and creation time. The manifest MUST NOT contain lease tokens; the
    backup file does, and MUST be stored with the same access controls as the
    live database.
29. `verify-backup <path>` MUST re-derive the manifest from the file alone
    and MUST fail for a missing file, a failed `quick_check`, a schema version
    other than the supported one, or a missing `database_id`. Verification
    MUST precede restore: opening a backup with `QueueStore` switches it to
    WAL mode and changes its digest. Restore is an operator file operation into
    a new path; no queue command overwrites a live database.
30. An imported root MUST be created as `proposed` (`admitted = 0`) with a
    `sourceRef`, in one transaction with every other root of the same import,
    on an opted-in repository. A candidate whose `sourceRef` already exists for
    the repository — in any status, including `completed` and `cancelled` —
    MUST be skipped and reported, so repeating an import creates nothing new;
    the database MUST enforce that uniqueness. Import MUST record
    `work.proposed` with the `sourceRef`, and MUST NOT create anything when the
    source listing is missing, unavailable, non-200, or contains a malformed
    entry.
31. `import-issues <owner/repo> --label <label> [--priority <n>]` MUST list
    only open issues carrying exactly that label through the GitHub REST API,
    following page-size pagination up to a bounded page count and reporting
    truncation, MUST drop pull requests from the listing, and MUST accept an
    entry only when its `html_url` is that repository's canonical issue URL,
    which becomes the `sourceRef`. Each issue becomes one root of kind
    `issue-resolution` whose `allowedActions` include `open-pr`, whose
    instructions quote the issue body as untrusted GitHub-authored context
    (bounded to 16,000 characters), and whose priority is operator-supplied.
32. The dogfood feeder MUST apply a no-finding cooldown per program: by
    default each program's catalog cadence (quality, CI, security, and triage
    24 hours; architecture, conformance, dependencies, and docs 7 days), or
    one `--cooldown-hours <n>` value for every
    program in that run (`0` disables it). A kind whose most recent root in
    the repository is `completed` within its window and proposed no child MUST
    be skipped and reported as cooled; a kind whose latest root proposed a
    child or is older than its window is offered again once its lineage is
    inactive.
33. `complete_work` MUST verify every `issue` and `pull-request` artifact
    against the GitHub API before the completion transaction, using the item's
    repository. When GitHub answers that the artifact does not exist, resolves
    to another location or number, targets or belongs to another repository,
    or is an issue reported as a pull request or the reverse, the completion
    MUST be refused and the item MUST stay `claimed` so the worker can correct
    the report. When GitHub confirms it, the stored artifact MUST carry
    `verification.status = "verified"` with the observed state (`merged` when
    a pull request is merged) and, for pull requests, the head SHA. When
    GitHub is unavailable, returns a non-200 answer other than not-found, or
    an unreadable body, the completion MUST be accepted with
    `verification.status = "unverified"` and the reason, never refused for
    that cause. A not-found answer MUST count as absence only when Snowcat
    presented `SNOWCAT_GITHUB_TOKEN`; unauthenticated, GitHub answers 404 for
    private repositories exactly as for missing ones, so the completion MUST
    be accepted as `unverified` naming the missing token. The MCP artifact
    schema MUST reject a worker-supplied `verification` as an unknown key
    rather than strip it.
34. `verify-artifacts [--repository <owner/repo>] [--limit <1-100>]` MUST
    re-check completed items' issue and pull-request artifacts that are
    `unverified` or verified but still `open`, MUST record each changed
    observation through `recordArtifactVerification` with an
    `artifact.verified` event naming the URL, kind, status, state, and prior
    state, MUST record a now-rejected artifact as `unverified` with a
    `rejected:` reason rather than delete it, and MUST leave the previous
    verification in place when GitHub is unavailable. Merged and closed
    artifacts are terminal and are not re-checked. Selection MUST consider
    only completed items that still have a non-terminal issue or pull-request
    artifact, newest first by `updated_at`
    (`QueueStore.completedItemsWithPendingArtifacts`), so `--limit` bounds
    the items that need checking rather than arbitrary completions and a
    repository with more than 100 terminal completions cannot starve a newer
    one; the pull-request cure sweep (rules 42–43) MUST use the same selection.
    An artifact URL whose `owner/repository` slug is not the item's — an
    artifact recorded under the repository's **former name**, before
    `rename-repository` (rule 47) carried the item to the new slug without
    rewriting history — MUST NOT be rejected before GitHub is asked: the
    check MUST query GitHub with the URL's own slug (the API follows renames)
    and MUST record `verified` only when GitHub's own answer names the item's
    repository case-insensitively (`base.repo.full_name` for a pull request,
    `repository_url` for an issue) at the same number and kind, so that only
    GitHub attests the rename. Every other slug mismatch — another
    repository, another number, another kind, an absent artifact — MUST stay
    rejected exactly as before, and 404-without-credential and unavailable
    handling (rule 33) are unchanged. Only this refresh path MUST learn
    renames: every other caller of the same check — `complete_work` (rule 33)
    and `attach-artifact` (rule 41) — MUST keep rejecting a slug that is not
    the item's before GitHub is asked anything, and artifact scope validation
    (rule 15) still refuses such a URL at the store, so a newly reported
    artifact MUST use the item's current slug.
35. `delivery` MUST be derived on read from a completed item's pull-request
    artifacts, never stored separately: `merged` if any is merged, otherwise
    `unverified` if any lacks a verified state, otherwise `open` if any is
    open, otherwise `closed`; `none` when no pull request was reported. Issues,
    commits, and reports do not constitute delivery; release artifacts extend
    this derivation under rule 60.

36. `QueueStore` MUST accept an optional claim-eligibility hook
    `(repository) => boolean` applied on top of repository opt-in. With a
    hook, a claim MUST consider only candidate repositories the hook accepts
    (asked once per claim, per candidate repository), MUST keep the single-row
    atomic selection among them, and MUST fail closed — leasing nothing — when
    the hook throws. Host processes MUST wire the control-plane hook only when
    `SNOWCAT_CONTROL_DB` is explicitly configured; that hook MUST accept a
    repository only while the control-plane store reports its effective state
    as `enrolled` (which excludes disabled, paused, unresolved, and
    operator-held repositories), MUST open the store per decision without
    creating it, and MUST throw when the configured database does not exist.
    Without the variable, opt-in alone governs.
37. `operatorNotes` and `previousResults` are carried on the item so the next
    lease sees what happened on earlier ones. Every note MUST record `at`,
    `actor`, `action`, and a non-empty `reason` of at most 4,000 characters,
    and MUST be appended, never edited, reordered, or removed. Only an actor in
    the `operator:` or `policy:` namespace MAY decide about work: `QueueStore`
    MUST reject every other actor (worker namespaces and `system:` alike) for
    all seven operator mutations — `approve`, `reject`, `defer`, `requeue`,
    `cancel`, `prioritize`, and `note` — leaving the item unchanged with no
    event, and no MCP tool MAY perform any of them or write a note. `note <id> <text>` MUST append an `action = "note"`
    entry and record `work.noted` without changing status, admission, lease,
    or result. `claim_work`, `get_work`, `list_work`, `list`, and `show` MUST
    return both arrays (empty on a fresh item) and MUST NOT reveal a lease
    token through them. Notes are advice about earlier leases: they MUST NOT
    change the objective, instructions, acceptance criteria, `allowedActions`,
    or `delegableActions`. Rung 4 of the migration ladder adds both columns
    with an empty-array default so pre-rung items read as note-free.
38. `prioritize <id> <priority> <reason>` MUST change the priority of one
    `proposed`, `queued`, or `blocked` item to a safe integer and MUST refuse
    a `claimed`, `completed`, or `cancelled` item, leaving its priority
    unchanged. Only an actor in the `operator:` or `policy:` namespace MAY
    prioritize; a worker identity MUST be rejected. Each prioritization MUST
    record `work.prioritized` with `previous`, `priority`, and `reason` and
    append a `prioritize` note (rule 37). It MUST NOT change status,
    admission, lease, or result, MUST NOT be exposed through MCP, and MUST
    NOT alter rule 22: children inherit at creation and workers never supply
    a priority.
39. `approve`, `reject`, `defer`, `requeue`, `cancel`, `prioritize`, and
    `note` MUST accept an optional precondition `{ status, updatedAt }`
    naming the item as the operator observed it. Inside the mutation's
    transaction, before any write, `QueueStore` MUST compare the item's
    logical `status` (rule 25's `proposed` view included) and `updatedAt`
    with the precondition and, on any mismatch, MUST throw
    `PreconditionMismatchError` (message
    `item changed since it was read: <id> is now <status> (updated <updatedAt>)`,
    carrying the current `id`, `status`, and `updatedAt`) and change
    nothing: no row write and no event. The check MUST run before the
    mutation's own state check (rules 24, 25, 37, 38) so a stale operator
    learns that the item moved rather than which rule it now breaks. Without
    a precondition every mutation MUST behave exactly as before. The CLI
    MUST accept `--if-updated-at <iso>` on those seven commands, off by
    default, deriving `status` from the command's required state (`approve`,
    `reject`: `proposed`; `defer`: `queued`; `requeue`, `cancel`: `blocked`)
    and, for `prioritize` and `note`, from the item's current status so
    `updatedAt` alone carries the check; a mismatch MUST exit non-zero with
    the store's message. No MCP tool MAY carry a precondition and no schema
    change is required.
40. The operator surface's mutations MUST be exactly the CLI's operator
    commands, invoked through the same functions and attributed to the
    session's actor (`operator:web`, or `member:<email>` per rule 51). The
    item-scoped mutations MUST be exactly `approve`, `reject`, `defer`,
    `requeue`, `cancel`, `prioritize`, `note`, and `attach-artifact` (`POST
    /items/:id/:mutation`; the `QueueStore` methods and
    `attachVerifiedArtifact`), and MUST NOT introduce a state transition or
    a batch action — a decision applied to more than one existing item in
    one request. The repository-scoped mutations MUST be exactly
    `verify-artifacts` (`refreshArtifactVerifications` then
    `curePullRequests`, as the CLI's `verify-artifacts` runs them),
    `import-issues` (`importLabeledIssues`), `seed-dogfood`
    (`enqueueDogfoodBatch`), `hold`
    (`ControlPlaneStore.imposeRepositoryOperatorHold`), and `clear-hold`
    (`ControlPlaneStore.clearRepositoryOperatorHold`) (`POST
    /repositories/:owner/:name/<action>`); `hold` and `clear-hold` MUST
    render only when `SNOWCAT_CONTROL_DB` is set and the repository is
    declared. A repository-scoped action is one operator decision that MAY
    create many roots in one `POST` — `seed-dogfood` at most one per catalog
    program, `import-issues` one per labeled open issue — and that is not a
    batch action. The surface MUST NOT expose a worker-facing endpoint.
    Every mutation, item- or repository-scoped, MUST be a same-origin `POST`
    behind the session cookie. An item-scoped mutation MUST carry the item's
    rendered `status` and `updatedAt` as the rule 39 precondition and on a
    mismatch MUST change nothing and show the item's current state with the
    message that it changed since it was read; `hold` and `clear-hold` are
    guarded instead by the control plane's `lastTransactionSequence` read in
    the same handler, and on a concurrent write MUST change nothing and
    re-render the board with a `409` banner saying the control plane changed;
    `verify-artifacts`, `import-issues`, and `seed-dogfood` are idempotent
    over their inputs and carry no precondition. The token routes `POST
    /tokens/mint` and `POST /tokens/:id/revoke` are the surface-identity
    mutations of rule 51, not operator commands. Its events MUST be
    indistinguishable in shape from the CLI's, differing only in actor, so
    `show`, `events`, and `watch` report browser and CLI decisions alike.
41. `attach-artifact <id> <url> [--kind pull-request|issue] [--description
    <text>]` MUST append one `issue` or `pull-request` artifact to a
    `completed` item's `result.artifacts` and MUST refuse every other status,
    leaving the item unchanged with no event. Only an actor in the
    `operator:` or `policy:` namespace MAY attach; a worker identity MUST be
    rejected and no MCP tool MAY attach. Before the write, the caller MUST
    check the URL against GitHub exactly as rule 33 checks a worker's report,
    using the item's own repository: a rejected answer (another repository,
    wrong number or kind, absent) MUST refuse the attach with the reason and
    write nothing; an unavailable answer MUST attach the artifact with
    `verification.status = "unverified"` and the reason; a confirmed answer
    MUST attach it `verified` with the observed state. The stored
    `verification` MUST be GitHub's answer — `QueueStore.attachArtifact`
    MUST refuse an artifact without one and MUST NOT invent one — and the
    same URL MUST be attached at most once per item (`artifact already
    reported: <url>`). Attaching MUST NOT require the item's `allowedActions`
    to include `open-pr` or `open-issue` (the operator, not the worker,
    produced the artifact), MUST NOT change the result's summary or evidence,
    and MUST record one `artifact.attached` event naming `url`, `kind`,
    `status`, and `state`; from then on the artifact is subject to rules
    34–35 like any reported one. The command MUST honor the rule 39
    precondition (`--if-updated-at`, status derived from the item's current
    status) and MUST print the item without a lease token. It requires no
    schema change: `result_json` already holds artifacts.
42. **Pull-request cure (ADR-0061).** `verify-artifacts` MUST, after the rule
    34 refresh and unless `--no-cure` is given, inspect every pull request
    that a completed item reported and that is verified `open`
    (deduplicated by URL), reading its `mergeable_state`, the check runs on
    its head, its reviews, its review threads, and the identity of its patch.
    A head is *decayed* when `mergeable_state` is `dirty` or `behind`, a
    completed check run's conclusion is `failure`, `timed_out`,
    `startup_failure`, or `action_required`, a reviewer's latest non-comment
    review is `CHANGES_REQUESTED`, or at least one review thread is neither
    resolved nor outdated (`unresolved-threads`); a draft or non-open pull
    request is never decayed. Review threads are read only through GraphQL
    (`POST /graphql`, `pullRequest.reviewThreads(first: 100) { isResolved
    isOutdated }`, same token, headers, and size cap as the REST reads); that
    one signal fails open — a GraphQL failure or unavailability leaves the
    health's `unresolvedThreads` undefined, adds no decay, and is recorded as
    a note the sweep output carries (`notes`) while the REST signals still
    apply. The sweep itself never replies to or resolves a thread.
    For each decayed head whose patch identity is computable, the pass MUST
    create exactly one admitted root of kind `pr-cure` with `sourceRef =
    <pull-request URL>@<head SHA>`, priority inherited from the highest
    priority item that reported the pull request, `allowedActions` `read,
    write, run-tests, open-pr, create-followup`, `delegableActions` `read,
    write, run-tests, open-pr`, and a `cure` record (`pullRequestUrl`,
    `headSha`, `patchDigest`, `decay`, `originItemId`) recording one
    `work.queued` event whose payload names the head and decay. The same
    `sourceRef` MUST never be enqueued twice, whatever the earlier item's
    status; a pushed head is a new `sourceRef`. A pull request whose patch
    identity cannot be computed (a text file GitHub serves without a patch,
    more than 300 files) MUST be reported as skipped, not enqueued. **Foreign
    pull requests** (ones no completed item reported) are eligible only for
    a repository whose `cure_foreign` setting is on (schema rung 6, off by
    default; `cure-foreign <owner/repo> on|off` sets it for an opted-in
    repository and is a repository-level command like `opt-in`, not an item
    mutation under rule 40). For each such repository (only the named one
    when `--repository` is given) the pass MUST list open pull requests with
    `GET /repos/{owner}/{name}/pulls?state=open&per_page=100`, reading at
    most 3 pages and reporting a full third page as skipped (truncated),
    drop drafts (skipped with a reason) and URLs already among the reported
    candidates, and inspect the rest through the same health read and
    enqueue path with priority 0, no `originItemId`, and one added
    instruction sentence saying the pull request was not opened by a Snowcat
    worker. The result's `foreign` counter reports `listed` and `inspected`.
43. The **patch identity** of a pull request is `sha256:` over the
    canonical JSON of its changed files sorted by path, each as its path,
    status, rename source when present, and the sequence of its added and
    removed lines from GitHub's per-file patch — hunk headers and context
    lines excluded — or, for a file GitHub serves without a text patch and
    with no line changes (binary), its blob SHA. A rebase or merge of the
    base that leaves the pull request's added and removed lines the same
    keeps the identity; any edit to them changes it.
44. `complete_work` on a `pr-cure` item MUST, after rule 33, refuse the
    completion — leaving the item claimed — unless the reported artifacts
    include the cure's pull request as a `pull-request` artifact and the pull
    request's current patch identity equals the cure's `patchDigest`; a pull
    request merged meanwhile is accepted on the artifact alone. An
    unavailable or uncomputable answer MUST refuse, never accept: mechanical
    is a fact Snowcat computes, not a claim the worker makes. A `pr-cure`
    worker that finds curing requires changing the patch MUST propose one
    `pr-cure-change` child (the substantive fix, admitted by the operator
    like any proposal, carrying no digest constraint) or block; cure MUST
    never merge, approve, or dismiss a review. `cure` is stored in one
    nullable column added by schema rung 5.
45. **Internal dependency chain.** `sweep-dependencies <owner/repo>` and
    `sweep-dependencies --enrolled` MUST read, from GitHub, each swept
    repository's default-branch head, its release tags, the comparison of
    its latest `vX.Y.Z` tag with the branch, and its root `go.mod`, and MUST
    create only `proposed` roots: one `release-needed` (`sourceRef =
    release-needed:<owner/repo>@<latest tag>+<head SHA>`) when the branch is
    ahead of the latest tag, unless a non-terminal `release-needed` exists
    for the repository or one for the same tag was cancelled within seven
    days; and one `dependency-bump` (`sourceRef =
    dependency-bump:<owner/repo>:<module>@<target tag>`) per
    `github.com/frostyard/*` requirement whose version is behind that
    module's latest release tag. A repository with no release tag MUST be
    reported, not asked. Both kinds carry `read, write, run-tests, open-pr`
    and empty `delegableActions`; a `release-needed` child MUST NOT create a
    tag, run `make bump`, publish a release, or push the default branch, and
    a `dependency-bump` MUST NOT target an unreleased commit. Failures MUST
    be reported per repository, never abort the sweep. `--enrolled` requires
    `SNOWCAT_CONTROL_DB` and skips enrolled repositories not opted in.
46. **Repository settings conformance (core ADR-0040).** `sweep-repository-
    settings <owner/repo> | --enrolled` MUST read the repository settings
    contract from the active Core snapshot's retained files (and MUST report
    and do nothing when the snapshot carries none), then, for each swept
    repository, read only — the repository object (merge hygiene, features,
    metadata, `security_and_analysis`), Actions workflow permissions,
    vulnerability alerts, private vulnerability reporting, active rulesets
    and their rules, classic branch protection, and labels — and diff each
    contract value against the live one. A setting the token cannot read
    MUST be reported as `unreadable`, never counted as drift; a private
    repository's private-vulnerability-reporting is not applicable. Every
    non-empty drift set MUST become one `proposed` root of kind
    `settings-drift` with `sourceRef = settings-drift:<owner/repo>@<sha256 of
    the sorted drifts>`, `allowedActions` `read` only, instructions listing
    every drift as expected/observed and naming core's
    `scripts/apply-repo-settings.sh` as the way to apply; a repeat of the
    same drift set MUST create nothing and a changed set MUST create a new
    proposal. Snowcat MUST NOT change any repository setting.

47. `rename-repository <old owner/repo> <new owner/repo>` MUST, in one
    transaction attributed to an `operator:` or `policy:` actor, carry the
    opt-in row (enabled, cure-foreign, and review-gate flags, creation time) and every work
    item from the old slug to the new one and remove the old row; it MUST
    refuse an unknown old slug, an existing new slug, and a rename to the same
    slug; and it MUST NOT rewrite history — `sourceRef`s, results, and events
    keep the strings they were recorded with. Used after a GitHub repository
    rename (ADR-0064), whose immutable repository ID keeps enrollment
    continuous once the Core declaration is renamed. Because history is kept
    verbatim, an artifact reported before the rename keeps the former name's
    URL; `verify-artifacts` (rule 34) still re-checks such a URL and verifies
    it when GitHub's own answer names the current repository at the same
    number, while `complete_work` (rule 15) still requires the current slug.

48. **Principals (ADR-0063).** `member:<email-or-login>` is the identity of
    a verified person, set only by a transport — an Access session or a
    Snowcat-minted MCP token — never accepted from a request payload: the
    MCP `worker` field MUST reject it like `operator:`, `policy:`, and
    `system:`, while the store MUST accept it as a worker principal for
    leases and as an operator actor for decisions (a member is an
    operator). A claim MAY carry the client's self-declared name as `label`
    in its `work.claimed` payload beside the transport identity; the label is
    provenance, never authority.
49. **Minted MCP tokens (ADR-0063).** `token mint <member:…> <client>`
    MUST create one token `snowcat_<id>_<secret>`, print the plaintext exactly
    once, and store only `sha256(secret)` with the owner and client name in
    the `mcp_tokens` table (schema rung 7). Verification MUST compare hashes
    in constant time, MUST answer nothing distinguishable for a malformed,
    unknown, revoked, or mismatched token, and MAY touch `last_used_at` at
    most once a minute. `token revoke <id>` MUST be idempotent, MUST let a
    member revoke only their own tokens and an `operator:` any, and MUST
    make the token verify as absent immediately. `token list` MUST never
    return a hash. A token grants no action by itself: it identifies the
    member and client, and the repository's governance and the item's
    `allowedActions` bound what that identity may do.

    A token MAY additionally carry a **claim restriction**: `token mint …
    [--kinds <kind>[,<kind>…]]` MUST validate every entry against the work-kind
    shape `^[a-z][a-z0-9-]{1,63}$`, MUST refuse an empty list and a malformed
    kind by naming it, and MUST store the sorted, de-duplicated list in
    `mcp_tokens.kinds_json` (schema rung 9) — or `NULL` for an unrestricted
    token, which is what every token minted before the rung is. Verification
    MUST return the restriction with the record, and `token list` and the
    surface's `/tokens` page MUST show it (`unrestricted` when absent) and
    still never a hash. The restriction narrows claiming only; `revoke` is
    unchanged.

50. **HTTP MCP endpoint (ADR-0063).** The app MUST serve the same MCP tools
    as stdio at `/mcp` over Streamable HTTP, and MUST require a Snowcat-minted
    token as a bearer header: absent, malformed, unknown, revoked, or
    mismatched tokens MUST all answer `401` with a `WWW-Authenticate: Bearer`
    challenge and no distinguishing reason. A verified token MUST make every
    tool act as `member:<owner>/<client>` — the payload's `worker` becomes the
    claim's `label` and can never set or widen the identity — and MUST record
    the token's last use. Stdio remains the local mode with the payload's
    worker as the principal. Cloudflare Access is expected to bypass `/mcp`
    (the minted token is the credential there) and to gate every other route.

    When the credential carries a claim restriction — a token's `kinds` (rule
    49) over HTTP, or `SNOWCAT_MCP_KINDS` (a comma-separated list, validated
    and refused the same way) on the stdio server — `claim_work`'s effective
    kind filter MUST be the **intersection** of the caller's `kinds` and the
    credential's. The restriction MUST NOT be settable or widenable from a
    request payload, an empty intersection MUST claim nothing (`null`, never
    an error), and the store MUST apply the intersection itself so a non-MCP
    caller cannot bypass it. `list_work`, `get_work`, `heartbeat_work`,
    `complete_work`, `block_work`, and `release_work` MUST be unaffected: a
    restricted client still finishes what it already holds. A claim bounded by
    a restriction MUST record it as `kindsRestriction` in the `work.claimed`
    event payload. No MCP tool is added and no tool's schema changes.

51. **Surface identity (ADR-0063).** With `SNOWCAT_ACCESS_TEAM_DOMAIN` and
    `SNOWCAT_ACCESS_AUD` set, the operator surface MUST treat a request as a
    session only when its `Cf-Access-Jwt-Assertion` header (or
    `CF_Authorization` cookie) verifies — `RS256` against the team's published
    keys, issuer equal to the team domain, audience containing the tag, not
    expired, an `email` claim present — and MUST attribute every mutation to
    `member:<email>`; an unverified request MUST answer `401` and MUST NOT
    fall back to the token session. Without those variables the token
    session and `operator:web` apply as before. `/tokens` MUST let a member
    mint tokens owned by their own principal (plaintext shown once) and see
    and revoke only their own; the local `operator:web` mode lists and
    revokes all and mints none.

52. **Review gate (ADR-0065).** `review-gate <owner/repo> on|off` MUST set a
    per-repository flag (schema rung 8, off by default, a repository-level
    command like `opt-in`, not an item mutation under rule 40) for an
    opted-in repository only. While it is on, `complete_work` on any item
    other than `pr-cure` or `pr-cure-change` MUST, after rule 33, refuse a
    completion — leaving the item claimed — that reports a `pull-request`
    artifact verified `open` and not a draft and whose URL has no completed
    `pr-review` round with decision `pass` (a pull request the gate released
    is cure's and the human's thereafter), with the message `review gate: pull request <url> is
    open and not a draft in <owner/repo>; convert it with \`gh pr ready --undo
    <n>\` and complete again, or block`; merged and closed pull requests MUST
    be accepted and an `unverified` answer MUST be accepted, never refused on
    a guess. `verifyGitHubArtifact` MUST record `draft: true` on a verified
    open pull request GitHub reports as a draft and MUST omit the key
    otherwise, so older records read as not-draft; `verify-artifacts` MUST
    treat a draft change as a new observation (rule 34). Snowcat MUST NOT
    itself convert a pull request to a draft.
53. **Review rounds (ADR-0029, ADR-0065).** `verify-artifacts` MUST, after
    rules 34 and 42 and unless `--no-review` is given, read nothing when no
    repository has the gate on, and otherwise, for every pull request that a
    completed item other than a `pr-review` or `pr-review-fix` reported in a
    gated repository and whose latest verification is `open` and draft, read
    the pull request's head (one `GET /pulls/N`) and: skip it when it is not
    open, not a draft, or when a `pr-review` or `pr-review-fix` for its URL is
    `queued` or `claimed`; otherwise, when no completed `pr-review` round has
    judged that head, compute `round` = one more than the completed
    `pr-review` rounds for that URL (a `blocked` or `cancelled` review does
    not count), and when `round` exceeds three report the pull request as
    `needsHuman` (`review budget exhausted`) and create nothing, else create
    exactly one admitted root of kind `pr-review` with `sourceRef =
    pr-review:<pull-request URL>@<head SHA>`, priority inherited from the
    highest-priority reporting item, `allowedActions` at most `read,
    run-tests`, `delegableActions` empty, `createdBy policy:review-gate`, and
    a `review` record (`pullRequestUrl`, `headSha`, `patchDigest` when
    computable per rule 43, `round`, `originItemId`, `authorModel` from the
    origin's `result.model`, `priorReviewerModel` from the previous round's
    `result.model`, `priorBlockers` = the previous round's blockers
    verbatim), recording `work.queued` whose payload names kind, URL, head,
    and round. The same `sourceRef` MUST never be enqueued twice, whatever the
    earlier item's status; a pushed head is a new `sourceRef`; rounds are
    counted per pull request URL and a new head never resets them. The
    `sourceRef` prefixes `pr-review:` and `pr-review-fix:` keep these roots
    distinct from rule 42's `<url>@<sha>` under the per-repository uniqueness
    of rule 30. `QueueStore.pullRequestReviewItems(repository, url)` MUST
    return every `pr-review` and `pr-review-fix` item bound to the URL,
    oldest first, case-insensitively, uncapped. A completed `pr-review` or
    `pr-review-fix` is never a candidate origin and the surface MUST NOT
    count it among a pull request's reporters.

    After that pass, and only for the same gated repositories, the sweep MUST
    list each one's open pull requests once (`GET /pulls?state=open`, at most
    three pages of 100, the same bounded listing rule 42 uses; a full last
    page MUST be reported as truncated and MUST NOT shrink what is reported),
    MUST drop every URL `QueueStore.knownPullRequestUrls(repository)` returns
    — one a completed item reported as a `pull-request` artifact, whatever its
    kind and whatever its verification state, and one a `pr-review`,
    `pr-review-fix`, or `pr-cure` item is bound to, whatever its status — and
    MUST report each remaining pull request whose `createdAt` is younger than
    `MAX_LEASE_SECONDS` once, in listing order, as `unreportedPending: [{ url,
    number, createdAt }]` in the sweep result and so in `verify-artifacts`
    output, without persisting it. Every other remaining pull request MUST be
    reported once as `unreported: [{ url, number, draft, createdAt? }]`. Such a
    pull request is **unreported**:
    the gate never saw it, so it was never reviewed and never marked ready.
    The sweep MUST NOT create any work item, event, or artifact for one — an
    unreported pull request is a human decision (close it, or
    `attach-artifact` it to the item that should have reported it, after which
    the next pass reviews it as an ordinary candidate). It MUST persist the
    whole finding for the repository through
    `QueueStore.recordUnreportedPullRequests(repository, { observedAt,
    pullRequests }, actor)` — an opted-in repository, a `policy:`,
    `operator:`, or `member:` actor, no event — overwriting the previous
    observation, the empty list included, so a closed or attached orphan
    disappears on the next pass; a listing GitHub could not serve MUST be
    reported in `unavailable` and MUST leave the previous observation
    standing. `QueueStore.repositoryUnreportedPullRequests(repository)` MUST
    return the last observation, or `undefined` for a repository no sweep has
    observed (schema rung 10's column is nullable). The surface MUST read that
    stored observation and MUST NOT call GitHub to render it.
54. **Verdict (ADR-0029, ADR-0065).** `complete_work` MUST accept an
    optional strict `review: { decision: pass | block | unable-to-review,
    blockers: [{ fingerprint, location, contract, impact, resolution,
    verification }], advisories: [{ fingerprint, text }] }` with at most five
    blockers with distinct fingerprints and at most three advisories,
    required on a `pr-review` item (`pr-review completion requires a review
    result (decision, blockers, advisories)`) and refused on every other kind
    (`review results are accepted only on pr-review items`), at the MCP
    schema and in `QueueStore` alike. A `block` MUST carry at least one
    blocker and a `pass` none. Before the completion transaction the server
    MUST read the pull request's head and refuse the completion — leaving the
    item claimed — when GitHub is unavailable (`pr-review completion cannot
    be verified: <reason>`), when the pull request is rejected (`pr-review
    completion refused: <reason>`), or when it is open and its head is not
    the round's (`pr-review completion refused: the pull request's head moved
    (reviewed <7>, now <7>); block this item instead`); a merged or closed
    pull request is accepted on the verdict alone. A `pr-review` MUST NOT be
    required to report the pull request as an artifact (it has no `open-pr`;
    the subject is its `review.pullRequestUrl`). On acceptance the store MUST
    merge the verdict and `reviewedAt` into the item's `review` record and
    record `work.reviewed` naming decision, round, head, URL, and blocker
    fingerprints. A `pr-review-fix` completion MUST report its pull request
    as a `pull-request` artifact and is subject to rule 52's draft refusal.
55. **Consequences (ADR-0065).** On a later pass, for a draft head whose
    latest completed `pr-review` round names that head: a `pass` MUST, when
    `SNOWCAT_REVIEW_GATE_WRITES=1`, mark the pull request ready for review
    through GraphQL `markPullRequestReadyForReview` as `policy:review-gate`
    and then record `artifact.ready` on the origin item (URL, head, review
    item), rewriting its verification without `draft`; a refused or
    unavailable mutation MUST be reported as `unavailable` and record
    nothing. Because the mutation binds to the pull request and not to a
    head, the sweep MUST re-read the head after marking and, when it is no
    longer the passed head or cannot be re-read, MUST convert the pull request
    back to a draft (`convertPullRequestToDraft`), record nothing, and report
    the pull request as `needsHuman`; a failed conversion MUST be reported as
    `unavailable` naming the unreviewed ready head. Without the variable the
    pass MUST be reported as `readyToMark`
    and the surface MUST show it with the `gh pr ready <n>` command. A
    `block` at a round below three MUST create exactly one admitted root of
    kind `pr-review-fix` with `sourceRef = pr-review-fix:<url>@<head SHA>`,
    exactly `read, write, run-tests, open-pr`, nothing delegable, the
    origin's priority, and a `review` record carrying the round, the
    blockers, `reviewItemId`, `reviewerModel`, `originItemId`, and
    `authorModel`, instructed to address exactly those blockers on the same
    branch, keep the pull request a draft, and report it; this is the only
    admitted root with write authority and no digest guard, bounded instead
    by rule 52, the fingerprinted scope, the empty ceiling, and the round
    budget. A `block` at round three, an `unable-to-review`, and a
    `pr-review-fix` that completed without a new head MUST create nothing and
    be reported as `needsHuman` with the reason; the operator inbox MUST
    list those pull requests and the `readyToMark` ones in one "Review
    adjudication" group. The sweep MUST never merge, approve, or dismiss;
    its only writes are the ready-for-review mark and its compensating
    conversion back to draft, and with the variable unset it MUST perform no
    GitHub write at all.
56. **Baseline metrics.** `metrics [--repository <owner/repo>] [--since
    <iso>] [--until <iso>]` MUST print exactly one JSON object for the
    half-open window `[since, until)` — `since` inclusive, `until` exclusive,
    both ISO-8601 timestamps normalized to UTC, defaulting to the last 24
    hours ending now (`--since` alone runs from it to now; `--until` alone
    starts 24 hours before it) — carrying the window, one entry per repository
    that appears in it, and an `all` entry totalling the same scope, each
    entry with exactly: `created`, the items *created* in the window counted
    by the logical status they hold *now* (`proposed`, `queued`, `claimed`,
    `completed`, `blocked`, `cancelled`); `attempts`, the `work.claimed`
    events in the window; `completed`, the `work.completed` events in it, and
    `completedByDelivery`, those completions by their item's current
    `delivery` (`none`, `unverified`, `open`, `closed`, `merged`);
    `accepted`, the completions whose item's `delivery` is `merged`;
    `acceptedPerAttempt`, `accepted / attempts` rounded to three decimals and
    `null` when `attempts` is 0; `blocked` and `cancelled`, the
    `work.blocked` and `work.cancelled` events in the window; and
    `timeToMergeHours` as `{ count, median, p90 }` over the merged
    pull-request artifacts of those completions — hours from the item's
    `work.completed` event to the artifact's `verification.mergedAt`, each
    rounded to three decimals, `p90` by nearest rank, with `median` and `p90`
    `null` exactly when `count` is 0. An unparseable bound and a window whose
    `since` is not before its `until` MUST be refused naming the bound. The
    command MUST be read-only — no write, no schema rung, no GitHub call —
    MUST refuse a window carrying more than 100,000 events instead of
    aggregating it, and MUST NOT be exposed as an MCP tool.
57. **Labeled-issue observations.** At the end of every successful
    `import-issues` listing, `QueueStore.recordLabeledIssueObservations` MUST
    replace, in one write transaction, that opted-in repository's complete
    latest-run observation. Each entry MUST carry the issue's canonical GitHub
    HTML URL, title, one `seenAt` timestamp for the transaction, and outcome
    `created` when this run proposed its sourceRef or `existing` when any item
    already carried it. Storage MUST preserve listing order, retain at most the
    first 500 entries, and set `truncated` when more were observed; an empty
    successful listing MUST replace the prior observation with an empty list.
    A missing, unavailable, non-200, or malformed listing MUST leave the prior
    observation standing. `QueueStore.repositoryLabeledIssueObservations`
    MUST return the last observation or `undefined` before the first successful
    import, and CLI import output MUST include the full observed issue count.
    This observation creates no work, event, artifact, MCP tool, or GitHub
    write and does not change rules 30–31's admission semantics.
58. **Predecessor references (ADR-0066).** A work item MAY carry
    `predecessors`: the source references of the items it waits for, stored in
    schema rung 12's nullable `work_items.predecessors_json`. Each entry MUST
    be a verbatim absolute GitHub issue URL over HTTPS of at most 512
    characters, an item MUST NOT declare more than 20 of them, and storage MUST
    deduplicate and sort them; an item declaring none MUST store `NULL`.
    Predecessors MUST be accepted only on the proposed-root creation path of
    rule 30 — a seed, a `pr-cure`, `pr-review`, or `pr-review-fix` root, and a
    worker follow-up MUST be refused when they carry the field — and MUST be
    recorded in that root's `work.proposed` event.
    `QueueStore.replaceProposedPredecessors` MUST replace them for one item
    that is still
    `proposed` (`admitted = 0` and status `queued`), in one write transaction
    recording `work.predecessors-updated` with the new and previous lists,
    under an operator or policy actor; it MUST refuse an admitted, claimed,
    completed, blocked, or cancelled item, and MUST change nothing else.
    A predecessor resolves nothing by itself: it names a source reference that
    may have no imported item, grants no authority, and reorders no other item.
    Predecessors MUST NOT affect admission, priority, lineage, or any schema
    beyond rung 12; their only effect is rule 62's claim gate, which withholds
    the item that declares them and nothing else.
59. **Release artifacts ([ADR-0066](../adr/0066-sequence-project-slices-on-observed-predecessor-delivery.md)).**
    A reported `release` artifact URL MUST be
    `https://github.com/<owner>/<repository>/releases/tag/<tag>` on the item's
    own repository — rule 15's scope validation with one more path segment,
    the tag percent-decoded and at most 128 characters of
    `A-Za-z0-9._+/-`, never beginning with `-` and never containing a `..`
    component — and MUST require no `allowedActions` entry, because Snowcat
    never publishes, tags, or merges anything: the release a worker reports is
    one a human published. `complete_work` MUST verify it exactly as rule 33
    verifies a pull request, through GET reads only. `GET
    /repos/<owner>/<name>/releases/tags/<tag>` names a published release; a
    credentialed not-found MUST fall back to one bounded page of `GET
    /repos/<owner>/<name>/releases` and MAY verify a **draft** whose
    `tag_name` is the reported tag, because a release nobody has published yet
    has no tag for GitHub to answer by. The repository binding MUST be the
    release's own API `url` rather than its `html_url`, because a draft's
    `html_url` names an `untagged-…` placeholder and because the API follows
    repository renames. A confirmed release MUST be stored with
    `verification.state` `published` or `draft`, `number` = GitHub's release
    id, `tag` = the observed `tag_name`, and `publishedAt` when GitHub reports
    one. An answer naming another repository, another tag, or no release at
    all MUST be refused with the item left `claimed`; an unavailable or
    unreadable answer MUST record `unverified` with the reason, and rule 33's
    404-without-credential rule is unchanged. `verify-artifacts` (rule 34)
    MUST treat `draft` as non-terminal and `published` as terminal, so the
    sweep observes the human's publication and then stops asking, and
    `attach-artifact` (rule 41) MUST accept a release URL under the same
    verify-then-write rule, never fabricating a verification. This requires no
    schema rung: `result_json` already holds artifacts and their
    verifications.
60. **Release delivery ([ADR-0066](../adr/0066-sequence-project-slices-on-observed-predecessor-delivery.md); extends rule 35).**
    Where a completed item reported at least one `release` artifact, that
    artifact — not a pull request that merely prepared it — is the item's
    delivery boundary: `delivery` MUST be `published` if any release is
    verified `published`, otherwise `unverified` if any release lacks a
    verified state, otherwise `open` (every release observed as a draft). An
    item that reported no release artifact MUST derive exactly rule 35's
    pull-request result, value for value.
61. **`depends-on` import parsing ([ADR-0066](../adr/0066-sequence-project-slices-on-observed-predecessor-delivery.md); extends rules 30–31 and 58).**
    `import-issues` MUST parse each issue's **raw** body — before rule 31's
    16,000-character quoting bound, so an edge sitting past the cut still
    counts — for lines of the form `depends-on: <url>`: optional surrounding
    whitespace, the key in any letter case, and exactly one absolute GitHub
    issue URL, which becomes one predecessor of rule 58 on the created root.
    Only the key is case-insensitive: the URL MUST match rule 58's predecessor
    shape exactly, case included (`https://github.com/<owner>/<repo>/issues/<n>`
    over a lower-case scheme and host), so that every parsed entry is a value
    the store accepts and no body can turn into a rejected write.
    The body is untrusted GitHub-authored text, so parsing MUST never fail an
    import: a line that does not match that shape, an entry longer than 512
    characters, and a URL naming the issue's own canonical HTML URL — a
    self-edge, which an item can never wait on — MUST all be dropped silently,
    duplicates MUST collapse, and at most the first 20 surviving entries MUST
    be kept. An issue declaring none MUST import with no predecessors. The
    root's instructions MUST state, above the quoted body, which predecessors
    Snowcat read. Where rule 30 skips an existing `sourceRef` whose item is
    still `proposed`, the import MUST re-parse that issue's body and, when the
    parsed set differs from the stored one, replace it through rule 58's
    `replaceProposedPredecessors` as `operator:import-issues` and report the
    refreshed source references; an unchanged set MUST write no event, and an
    item that is admitted, claimed, completed, blocked, or cancelled MUST NOT
    be touched — correcting its edges is cancel-and-refile. Parsing MUST make
    no GitHub read of its own, MUST create nothing beyond rule 30's proposed
    roots, MUST leave rule 57's observation semantics unchanged, and MUST NOT
    affect claim selection or admission.
62. **Predecessor gate ([ADR-0066](../adr/0066-sequence-project-slices-on-observed-predecessor-delivery.md)
    decision 3; narrows rules 2–3 and 17).** Claim selection MUST exclude an
    admitted item whose rule 58 `predecessors` are not all satisfied, and MUST
    change nothing else about selection: an item declaring none MUST be
    selected exactly as before, ordering stays priority then age, and a
    withheld item is simply not a candidate — so the claim MUST take the next
    eligible item, however much lower its priority. One predecessor is
    satisfied only when a work item in the same database carries that source
    reference as its `sourceRef`, is `completed`, and every pull-request
    artifact it reported is stored `verification.state` `merged` and every
    release artifact `published` (rules 33–35, 59–60); an item that reported
    neither MUST satisfy on completion alone, and where several items carry
    one source reference a single satisfying item MUST satisfy the edge.
    Everything else MUST leave the successor ineligible: no item carrying the
    reference, an item that is `proposed`, `queued`, `claimed`, `blocked`, or
    `cancelled`, and an artifact whose verification is absent, `unverified`,
    or observed `open`, `closed`, or `draft`. The check MUST run inside the
    claim transaction beside admission (rules 20–21) and repository
    eligibility, and MUST read stored state only: the claim path MUST perform
    no GitHub read, because the observation that satisfies an edge is the one
    `verify-artifacts` already wrote — never one taken at claim time, and
    never a worker's assertion. Satisfaction MUST NOT propagate to any item
    that did not declare the edge, and withholding MUST leave the item's
    status, result, priority, notes, and event ledger untouched: the gate
    withholds, it never blocks, cancels, or annotates, and a cancelled
    predecessor therefore withholds its successors until an operator cancels
    or refiles them (ADR-0066 decision 6). A cycle MUST NOT be rejected — the
    gate evaluates one item's edges and never the graph — so its members
    simply never become eligible and stay visibly queued.
63. **Predecessor visibility ([ADR-0066](../adr/0066-sequence-project-slices-on-observed-predecessor-delivery.md)).**
    Every read that returns a work item — `list`, `show`, `list_work`,
    `get_work`, `claim_work` — MUST carry `predecessors` as read-only
    bookkeeping, and no MCP tool may create, change, or satisfy one. For an
    item that declares them, `show <id>` MUST additionally print one entry per
    declared source reference, in stored order, naming the reference, whether
    it is satisfied now, and — when it is not — the reason and the work item
    that reason was read from; an item declaring none MUST print no such
    block. `QueueStore.predecessorStatuses` MUST derive those entries by rule
    62's evaluation, so what an operator reads is what the gate decides, and
    MUST, like the gate, read stored state without a GitHub request.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| SQLite schema | Created and upgraded by `QueueStore`'s migration ladder from this work-item model; admission triggers and `user_version` per rules 20–21 |
| Backup manifest | Derived by `backup` and re-derived by `verify-backup` per rules 28–29 |
| Issue import | `import-issues` maps labeled open GitHub issues to proposed `issue-resolution` roots per rules 30–31, reads their `depends-on` lines into rule 58's predecessors per rule 61, and records the latest bounded labeled-issue observation per rule 57 |
| Artifact verification | Completion-time, `attach-artifact`, and `verify-artifacts` observations per rules 33–35, 41, and 59; `delivery` derived per rules 35 and 60 |
| Pull-request cure | `verify-artifacts` enqueues `pr-cure` roots per decayed head per rules 42–43; `complete_work` enforces patch identity per rule 44 |
| Review gate | `review-gate` flag and draft refusal per rule 52; `verify-artifacts` enqueues `pr-review` rounds and `pr-review-fix` roots and marks passed drafts ready per rules 53 and 55; `complete_work` accepts the bound verdict per rule 54 |
| Internal dependency chain | `sweep-dependencies` maps tags, branch comparison, and `go.mod` to `release-needed` and `dependency-bump` proposals per rule 45 |
| Repository settings drift | `sweep-repository-settings` diffs live GitHub settings against core's contract into `settings-drift` proposals per rule 46 |
| Predecessor gate | Claim selection excludes items whose rule 58 predecessors are not observed delivered per rule 62; `show` prints each one's satisfaction per rule 63 |
| MCP tokens | `token mint [--kinds …] | list | revoke` over the `mcp_tokens` table per rule 49; identities per rule 48; claim restriction per rule 50 |
| PRD baseline metrics | `metrics` aggregates items created in a window with its `work.claimed`, `work.completed`, `work.blocked`, and `work.cancelled` events and the completed items' current `delivery` per rule 56 |
| MCP worker behavior | Portable `work-snowcat-queue` skill constrained by this contract |
| Testing-gap seed | Deterministic CLI instance of this contract |

## References

- Rationale:
  [ADR-0003](../adr/0003-separate-work-coordination-from-execution.md) and
  [ADR-0004](../adr/0004-keep-models-outside-the-control-path.md), with
  admission policy from
  [ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md) and
  database-enforced admission from
  [ADR-0006](../adr/0006-enforce-admission-in-the-database.md), and release
  artifacts from
  [ADR-0066](../adr/0066-sequence-project-slices-on-observed-predecessor-delivery.md)
- Product: [maintenance fleet PRD](../prd/agent-fleet.md)
- Context: [queue execution boundary](../design/queue-execution-boundary.md),
  the [operations runbook](../design/queue-operations.md), and the planned
  [operator surface](../design/operator-surface.md)
- Delivery: [queue vertical spike](../plans/queue-vertical-spike.md)
- Review gate: [ADR-0065](../adr/0065-gate-worker-pull-requests-behind-bounded-review.md)
  implementing [ADR-0029](../adr/0029-bound-adversarial-review.md)
- Project sequencing:
  [ADR-0066](../adr/0066-sequence-project-slices-on-observed-predecessor-delivery.md)
  (rule 58 and schema rung 12 carry its predecessor references; rules 62–63
  gate claims on them and make each edge's satisfaction readable)
- Promotion decision and plan:
  [ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md) and
  [recovery plan](../plans/recover.md), superseding
  [ADR-0044](../adr/0044-replace-the-queue-spike-database.md) and the
  [control-plane kernel bootstrap](../plans/control-plane-kernel-bootstrap.md)
  cutover
