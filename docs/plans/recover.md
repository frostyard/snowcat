# Plan: Recover a working engine

This plan promotes the queue store and its MCP contract to Fluent's v1 work
engine under [ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md)
and drives it to the first reviewed pull request on a real, non-Fluent
repository. It supersedes the delivery order of the
[product foundation roadmap](product-foundation-roadmap.md) wherever that
roadmap requires the control-plane store to hand out work; the roadmap's later
phases resume behind Phase 5 here. Nothing in the control-plane store is
deleted: it becomes an authority and observation sidecar that filters claims.

Baseline on 2026-08-17: `src/queue/*` and `src/mcp/server.ts` are ~1,000
lines with 45 completed items in the live queue; the control-plane store has no
work-facing command; the local control-plane database is orphaned at an older
schema with no upgrade path.

## Phase 0 — Freeze (completed 2026-08-17)

- Record [ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md)
  and mark [ADR-0044](../adr/0044-replace-the-queue-spike-database.md)
  superseded.
- Park GitHub observation at registry v18 / schema v8: no new control-plane
  registry or schema version lands unless a phase below consumes it.
- Re-point the roadmap: its Phase 5 "done when" is achieved by Phase 5 of this
  plan; roadmap Phases 2–4 stop being prerequisites.
- **Done when:** `npm run check` passes with the ADR, this plan, and the
  design/spec back-links in place, and the roadmap links here.

## Phase 1 — Make the queue deployable (completed 2026-08-17)

- Replace `QueueStore`'s single idempotent migration block with a numbered,
  forward-only migration ladder per the
  [work queue contract](../specs/work-queue.md): an older supported database
  upgrades in place inside one write transaction; a newer database is still
  refused. Rung 2 adds `queue_metadata` with a per-database lineage identity.
- Add `npm run queue -- backup <new-path>` (online `VACUUM INTO`-style copy,
  `quick_check`, manifest with lineage identity, schema version, last event
  sequence, and counts) and `verify-backup <path>`; add `metadata` for the
  host sanity check. Restore is an operator file operation documented in the
  [queue execution boundary](../design/queue-execution-boundary.md); the CLI
  never overwrites a live path.
- Resolve `FLUENT_QUEUE_DB` to an absolute path and document the single-host
  layout: absolute database path, MCP over stdio from the operator host, restart
  MCP servers after upgrade, backup cadence and secret handling.
- **Done when:** the live queue database opens under the new ladder with its
  history intact, a fresh checkout backs it up and verifies the manifest, and
  the README documents the operating layout. Verified 2026-08-17: the operator
  queue (51 items, 170 events) upgraded from version 1 to 2 in place, its
  backup manifest re-derived byte for byte, and `npm run check` passes.

## Phase 2 — Real work sources (completed 2026-08-17)

- Add `npm run queue -- import-issues <owner/repo> --label <label>` using
  `githubApiJson` in `src/repository/github-api.ts`: each labeled open issue
  becomes one `proposed` root with `open-pr` in `allowedActions`, idempotent
  on the issue number through a `source_ref` column (rung 3). Operators admit
  with the existing `approve`.
- Add a repeatable dogfood feeder with a no-finding cooldown per kind, on top
  of `activeRootKinds`, so the four maintenance discovery roots recur without
  duplicating active lineage.
- **Done when:** a labeled issue on an opted-in repository appears as one
  proposed item, re-running the import creates nothing new, and an approved
  item is claimable over MCP. Verified 2026-08-17 against live GitHub in a
  scratch queue: `import-issues frostyard/updex --label testing` proposed
  three `issue-resolution` roots (#294–#296), the re-import fetched three and
  created none, and after `approve` one item was claimed over a stdio MCP
  server while the two still-proposed roots stayed unclaimable.

## Phase 3 — Verify artifacts, not just record them (small)

- On `complete_work` with an `issue` or `pull-request` artifact, resolve the
  URL through `githubApiJson`, confirm it belongs to the item's repository,
  and store `{ verifiedAt, state, headSha }` beside the artifact. A mismatch
  or non-existent artifact rejects the completion atomically.
- Add `npm run queue -- verify-artifacts` to re-poll completed items'
  pull requests and record `merged`, `closed`, or `open` as outcome on the
  item, keeping delivery distinct from outcome.
- Polling on demand only; webhook ingress stays parked.
- **Done when:** a completion citing a pull request in the wrong repository
  is rejected, one citing a real pull request stores verification, and a
  later `verify-artifacts` records its merge.

## Phase 4 — Wire Core enrollment as a claim filter (small)

- Add an injectable claim-eligibility hook to `QueueStore.claim()`. When
  `FLUENT_CONTROL_DB` is configured, the CLI and MCP server wire it to
  "enrolled per `ControlPlaneStore.repositoryStatuses()` and not under an
  operator hold"; otherwise it is the existing repository opt-in.
- Recreate the orphaned local control-plane database rather than blocking on
  a control-plane migration ladder.
- Land one real repository declaration on `frostyard/core` `main` so
  `repository -- status` reports an enrolled repository; until then the hook
  falls back to opt-in.
- **Done when:** a held or unenrolled repository's queued items are not
  claimable while the control-plane database is configured, and the same
  items are claimable when it is not.

## Phase 5 — Dogfood on one non-Fluent repository (one calendar week)

- Choose the smallest Frostyard repository, opt in, import labeled issues,
  approve three to five, and run Codex or Claude workers with `open-pr`.
- Record accepted pull requests per attempt, tokens per accepted outcome, and
  blocked counts to fill the TBD targets in the
  [agent fleet PRD](../prd/agent-fleet.md).
- **Done when:** an operator enrolls a repository, starts an external worker,
  receives one matched item, and sees its lease, report, verified artifact,
  outcome, and every operator decision on one work item and its events — the
  roadmap Phase 5 outcome, achieved on the queue store.

## Later / ideas

- Grants, capability profiles, and WIP limits from ADR-0032/0034 as
  additional claim filters once one repository shows contention.
- Unpark GitHub observation only if on-demand verification demonstrably
  misses state that a maintainer relied on.
- Authenticated Streamable HTTP for MCP when a worker must run off-host.

## Open questions

- **First dogfood repository:** the operator chooses before Phase 5 begins;
  the smallest active Frostyard repository is the default.
- **Restore procedure:** file copy plus `verify-backup` is enough for v1;
  revisit if a restore ever has to preserve in-flight leases.

## References

- Implements: [work queue](../specs/work-queue.md) and
  [queue execution boundary](../design/queue-execution-boundary.md)
- Decision: [ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md)
- Re-sequences: [product foundation roadmap](product-foundation-roadmap.md)
- Eligibility source: [repository enrollment](../design/repository-enrollment.md)
