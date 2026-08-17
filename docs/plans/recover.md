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

## Phase 3 — Verify artifacts, not just record them (completed 2026-08-17)

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
  later `verify-artifacts` records its merge. Verified 2026-08-17 against
  live GitHub in a scratch queue: `complete_work` refused a nonexistent
  `frostyard/updex` pull request and left the item claimed, then accepted the
  same item citing merged PR #293 with `verification.state = merged`, its head
  SHA and merge time, and derived `delivery: merged`; the refresh pass then
  correctly re-checked nothing. Outage handling (accept as `unverified`,
  refresh later) is covered by tests, GitHub having been intermittently
  returning 5xx during the day.

## Phase 4 — Wire Core enrollment as a claim filter (completed 2026-08-17)

- Add an injectable claim-eligibility hook to `QueueStore.claim()`. When
  `FLUENT_CONTROL_DB` is configured, the CLI and MCP server wire it to
  "enrolled per `ControlPlaneStore.repositoryStatuses()` and not under an
  operator hold"; otherwise it is the existing repository opt-in.
- Recreate the orphaned local control-plane database rather than blocking on
  a control-plane migration ladder.
- Land one real repository declaration on `frostyard/core` `main` so
  `repository -- status` reports an enrolled repository; until then the hook
  falls back to opt-in. Status 2026-08-17: `main` (`bbf196e`) declares only
  `frostyard/core` itself with `fleet_state: disabled` and the repository has
  no `policies/agent-governance.json`, so no repository can reach `enrolled`
  yet. The change is on the Core side (enable a declaration and add the
  governance surface to that repository); it is an operator decision which
  repository goes first and is not made from this repository. Resolved
  2026-08-17: [core#83](https://github.com/frostyard/core/pull/83) and
  [updex#297](https://github.com/frostyard/updex/pull/297) merged; a fresh
  control plane at `/var/lib/fluent/control-plane.db` activated Core `main`
  (`ee59e66`) and reconciled `frostyard/updex` as `enrolled` (identity
  matched, surfaces at `ac1d899`), and an admitted updex item was claimed
  with `FLUENT_CONTROL_DB` set. The operator queue moved to
  `/var/lib/fluent/queue.db` through a verified backup, and updex's three
  `testing`-labeled issues are imported as proposed work.
- **Done when:** a held or unenrolled repository's queued items are not
  claimable while the control-plane database is configured, and the same
  items are claimable when it is not. Verified 2026-08-17: the orphaned local
  control-plane database was set aside, a fresh one activated Core `main`
  (`bbf196e`) and reconciled `frostyard/core` as `disabled`; with
  `FLUENT_CONTROL_DB` set, a queued `frostyard/core` item was not claimable,
  and the same item was claimed with the variable unset. Enrolled and
  operator-held transitions are covered by tests through the shared Core
  fixtures.

## Phase 5 — Dogfood on one non-Fluent repository (in progress; first day completed 2026-08-17)

- Repository chosen 2026-08-17: `frostyard/updex`. Enrollment changes are
  open as [core#83](https://github.com/frostyard/core/pull/83) (declaration)
  and [updex#297](https://github.com/frostyard/updex/pull/297) (governance
  surface). Operate it by the
  [queue operations runbook](../design/queue-operations.md): opt in, import
  labeled issues, approve three to five, and run Codex or Claude workers with
  `open-pr`.
- Record accepted pull requests per attempt, tokens per accepted outcome, and
  blocked counts to fill the TBD targets in the
  [agent fleet PRD](../prd/agent-fleet.md).
- **Done when:** an operator enrolls a repository, starts an external worker,
  receives one matched item, and sees its lease, report, verified artifact,
  outcome, and every operator decision on one work item and its events — the
  roadmap Phase 5 outcome, achieved on the queue store. **Achieved
  2026-08-17** on `frostyard/updex`: 7 items completed (4 issue-resolution
  → PRs #298, #300, #302, #303, all merged and verified; 3 read-only
  discovery roots → 3 evidence-backed findings, each proposing one child the
  operator admitted), 0 blocked, 0 refused, 0 lease expiries. Numbers are
  recorded in the [PRD baseline](../prd/agent-fleet.md#first-dogfood-baseline-2026-08-17-frostyardupdex).
  The remaining week continues with the three admitted implementation
  children and the architecture discovery root; a fresh-session run will
  test whether updex's new `AGENTS.md` rule alone yields conventional PR
  titles.

## Phase 6 — Operate it like a product (candidates, unscheduled)

Lessons from the first day, to be worked as queued Fluent items rather than
by hand:

- **Operator-set priority after creation.** Children inherit their parent's
  priority (0 for discovery roots), so an admitted security fix waits behind
  any still-queued discovery root. Add an attributed
  `queue -- prioritize <id> <n>` (operator-only, never a worker tool),
  keeping priority operator-owned per spec rule 22.
- **First-class watching.** The operator loop today is a shell loop around
  `show`. Add `queue -- events [--since <sequence>] [--repository …]` and/or
  `queue -- watch` that streams new events, so lease renewals, completions,
  proposals, and verifications are one command.
- **Deployment story** (held for design discussion): systemd timers for
  `seed-dogfood`, `verify-artifacts`, and `backup`; where the checkout, the
  databases, and worker clients live; how upgrades restart MCP servers.
- **Operator surface**: decided in
  [ADR-0060](../adr/0060-bring-the-operator-surface-forward-as-a-read-first-inbox.md)
  and designed in [operator surface](../design/operator-surface.md) — a
  read-first inbox, repository board, and item page over the same store
  methods, with the CLI's operator mutations carrying stale-intent
  preconditions; local-first behind `FLUENT_APP_TOKEN`; server-rendered per
  the `frostyard-design` skill, which must be synchronized from
  `frostyard/core` into `.agents/skills` before UI code lands.
  [frostyard/fluent#1](https://github.com/frostyard/fluent/issues/1) and
  [#2](https://github.com/frostyard/fluent/issues/2) are its prerequisites.
- **Enrolling Fluent itself** so its own maintenance items are claimable
  under `FLUENT_CONTROL_DB`: open as
  [core#84](https://github.com/frostyard/core/pull/84) (declaration) and
  [fluent#3](https://github.com/frostyard/fluent/pull/3) (governance
  surface).


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
