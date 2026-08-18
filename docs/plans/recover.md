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

## Phase 5 — Dogfood on one non-Fluent repository (in progress; two operating days completed)

- Repository chosen 2026-08-17: `frostyard/updex`, enrolled through
  [core#83](https://github.com/frostyard/core/pull/83) and
  [updex#297](https://github.com/frostyard/updex/pull/297). Fluent enrolled
  itself the same evening ([core#84](https://github.com/frostyard/core/pull/84),
  [fluent#3](https://github.com/frostyard/fluent/pull/3)) so its own
  maintenance runs through the same queue under the same gate.
- Operate by the [queue operations runbook](../design/queue-operations.md) and,
  since 2026-08-18, from the [operator surface](../design/operator-surface.md).
- **Done when:** an operator enrolls a repository, starts an external worker,
  receives one matched item, and sees its lease, report, verified artifact,
  outcome, and every operator decision on one work item and its events — the
  roadmap Phase 5 outcome, achieved on the queue store. **Achieved
  2026-08-17** and repeated across two days and four client kinds
  (Claude Code, Codex, Copilot CLI, and a Claude session on a loop):
  - `frostyard/updex`: 13 items completed (5 issue-resolution, 4 read-only
    discovery roots, 4 admitted children); 9 pull requests opened, 8 merged
    and verified, 1 closed unmerged after an external tool landed an
    overlapping change; 0 refused completions; 1 block (a client permission
    limit) recovered through a requeue note.
  - `frostyard/fluent`: 14 items completed, 14 pull requests merged and
    verified — every Phase 6 item below was built by the queue itself,
    eight of them overnight on 2026-08-18 with the operator asleep and a
    merge gate merging on green CI.
  - Numbers are recorded in the
    [PRD baseline](../prd/agent-fleet.md#first-dogfood-baseline-2026-08-17-frostyardupdex).
  - Lessons landed as code the same day: unauthenticated 404 is
    `unverified` not absence; requeue carries operator notes and prior
    results; workers check for existing pull requests before starting;
    conventional-commit titles are enforced in updex; core ADR-0038 scoped
    the test-name filter to chairlift after two findings contradicted.
- Still open in this phase: tokens per accepted outcome (clients do not report
  them to Fluent); a boundary with the Hive scanner, which fixed issues Fluent
  had already fixed on 2026-08-18 (the `fluent` label as the queue's claim).

## Phase 6 — Operate it like a product (completed 2026-08-18, first slice)

Everything here was queued as Fluent issues written to the
[`write-fluent-issues` skill](../../.agents/skills/write-fluent-issues/SKILL.md)
and merged through the queue:

- Operator-set priority after creation — `queue -- prioritize` (#1 → PR #11).
- First-class watching — `queue -- events --since` and `queue -- watch`
  (#2 → PR #5).
- Operator notes and prior results carried to the next lease; `queue -- note`
  (#7 → PR #9); workers check for existing work before starting (#8 → PR
  #10).
- Scheduling — systemd timers for feeder, `verify-artifacts`, and backup with
  `seed-dogfood --enrolled` and `import-issues --enrolled` (#12 → PR #14,
  #21 → PR #28); `npm run check:deploy` verifies units and scripts in CI.
- Deployment — `deploy/install.sh`, `deploy/upgrade.sh`, `/etc/fluent/env`,
  the runbook rewritten around them (#13 → PR #15). Decision recorded in the
  runbook's Deployment section: single host, stdio MCP, loopback listeners,
  operator-only credentials; remote workers deferred.
- Operator surface —
  [ADR-0060](../adr/0060-bring-the-operator-surface-forward-as-a-read-first-inbox.md),
  designed on the
  [Fluent Operator Surface canvas](https://claude.ai/code/artifact/86d7da78-b87d-4df4-a725-2d8a34b29384),
  shipped as inbox + repository board + item page + mutations with
  stale-intent preconditions + live event stream + repository actions
  (#16–#19, #23, #24 → PRs #20, #25–#27, #30, #31); operator/policy actor
  required for every admission and exit (#22 → PR #29).
- Enrolling Fluent itself (core#84, fluent#3).
- **Done when:** the operator can run a dogfood day from a browser and the
  timers keep the queue fed, verified, and backed up without a shell.
  Achieved 2026-08-18 for the browser; the timers are installed by
  `deploy/install.sh`, which the operator runs on the host (see Phase 7).

## Phase 7 — Settle in (next)

The next steps, in order; each is a queue item unless it needs the operator's
hands on the host.

1. **Install on the host** — `sudo deploy/install.sh --user bjk`, first real
   `systemctl start` of each timer, read the journal; if `npm` cannot write
   its cache under `ProtectSystem=strict`, fix the unit (likely a
   `ReadWritePaths` or `npm_config_cache` line) as a queue item. Operator's
   hands.
2. **A week of steady state on updex and fluent** — feeder and import on
   timers, admission from the browser, workers started by the operator or
   on a loop; record accepted-per-attempt, blocked, and time-to-merge daily
   into the PRD baseline. Decide the Hive/Fluent boundary (skip `fluent`-
   labeled issues in Hive) before running both again.
3. **Second repository** — enroll one more Frostyard Go repository (the
   `frostyard-go-repo` skill makes it uniform: `policies/agent-governance.json`
   plus the core declaration) and confirm the surface, timers, and gate work
   for two repositories at once.
4. **Maintenance programs** — honor Core's `maintenance_programs`, move the
   discovery kinds into a catalog with per-program cadence, cure pull
   requests per head under
   [ADR-0061](../adr/0061-cure-pull-requests-as-bounded-per-head-work.md),
   then add conformance and triage; the full list and order live in the
   [maintenance programs plan](maintenance-programs.md).
5. **Surface follow-ups** — decision-record view once ADR-0035 typed
   decisions exist beyond admission; per-repository event filter on the rail;
   keyboard-first inbox review. Small queue items, only after (2) shows they
   matter.
6. **Runbook and PRD** — fold the week's numbers into targets and change the
   PRD status from Discovery only through its review path.

## Later / ideas

- Grants, capability profiles, and WIP limits from ADR-0032/0034 as
  additional claim filters once one repository shows contention.
- Unpark GitHub observation only if on-demand verification demonstrably
  misses state that a maintainer relied on.
- Remote workers: authenticated Streamable HTTP for MCP, per-worker grants,
  and per-operator surface auth — the deferred set named in the runbook's
  Deployment section; their trigger is the first worker that must run
  off-host, and they get their own ADR.
- Tokens per accepted outcome, once a client can report them.

## Open questions

- **Second dogfood repository:** the operator chooses in Phase 7 step 3;
  a Go repository already carrying the `frostyard-go-repo` skill is the
  default.
- **Hive boundary:** whether Hive skips `fluent`-labeled issues or Fluent
  imports only issues Hive will not take; decided before both run on one
  repository again.

## References

- Implements: [work queue](../specs/work-queue.md) and
  [queue execution boundary](../design/queue-execution-boundary.md)
- Decision: [ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md)
- Re-sequences: [product foundation roadmap](product-foundation-roadmap.md)
- Eligibility source: [repository enrollment](../design/repository-enrollment.md)
