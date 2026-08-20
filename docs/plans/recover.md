# Plan: Recover a working engine

This plan promotes the queue store and its MCP contract to Snowcat's v1 work
engine under [ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md)
and drives it to the first reviewed pull request on a real, non-Snowcat
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
- Resolve `SNOWCAT_QUEUE_DB` to an absolute path and document the single-host
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
  `SNOWCAT_CONTROL_DB` is configured, the CLI and MCP server wire it to
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
  control plane at `/var/lib/snowcat/control-plane.db` activated Core `main`
  (`ee59e66`) and reconciled `frostyard/updex` as `enrolled` (identity
  matched, surfaces at `ac1d899`), and an admitted updex item was claimed
  with `SNOWCAT_CONTROL_DB` set. The operator queue moved to
  `/var/lib/snowcat/queue.db` through a verified backup, and updex's three
  `testing`-labeled issues are imported as proposed work.
- **Done when:** a held or unenrolled repository's queued items are not
  claimable while the control-plane database is configured, and the same
  items are claimable when it is not. Verified 2026-08-17: the orphaned local
  control-plane database was set aside, a fresh one activated Core `main`
  (`bbf196e`) and reconciled `frostyard/core` as `disabled`; with
  `SNOWCAT_CONTROL_DB` set, a queued `frostyard/core` item was not claimable,
  and the same item was claimed with the variable unset. Enrolled and
  operator-held transitions are covered by tests through the shared Core
  fixtures.

## Phase 5 — Dogfood on one non-Snowcat repository (in progress; two operating days completed)

- Repository chosen 2026-08-17: `frostyard/updex`, enrolled through
  [core#83](https://github.com/frostyard/core/pull/83) and
  [updex#297](https://github.com/frostyard/updex/pull/297). Snowcat enrolled
  itself the same evening ([core#84](https://github.com/frostyard/core/pull/84),
  [snowcat#3](https://github.com/frostyard/snowcat/pull/3)) so its own
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
  - `frostyard/snowcat`: 14 items completed, 14 pull requests merged and
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
  them to Snowcat); a boundary with the Hive scanner, which fixed issues Snowcat
  had already fixed on 2026-08-18 (the `snowcat` label as the queue's claim).

## Phase 6 — Operate it like a product (completed 2026-08-18, first slice)

Everything here was queued as Snowcat issues written to the
[`write-snowcat-issues` skill](../../.agents/skills/write-snowcat-issues/SKILL.md)
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
- Deployment — `deploy/install.sh`, `deploy/upgrade.sh`, `/etc/snowcat/env`,
  the runbook rewritten around them (#13 → PR #15). Decision recorded in the
  runbook's Deployment section: single host, stdio MCP, loopback listeners,
  operator-only credentials; remote workers deferred.
- Operator surface —
  [ADR-0060](../adr/0060-bring-the-operator-surface-forward-as-a-read-first-inbox.md),
  designed on the
  [Snowcat Operator Surface canvas](https://claude.ai/code/artifact/86d7da78-b87d-4df4-a725-2d8a34b29384),
  shipped as inbox + repository board + item page + mutations with
  stale-intent preconditions + live event stream + repository actions
  (#16–#19, #23, #24 → PRs #20, #25–#27, #30, #31); operator/policy actor
  required for every admission and exit (#22 → PR #29).
- Enrolling Snowcat itself (core#84, snowcat#3).
- **Done when:** the operator can run a dogfood day from a browser and the
  timers keep the queue fed, verified, and backed up without a shell.
  Achieved 2026-08-18 for the browser; the timers are installed by
  `deploy/install.sh`, which the operator runs on the host (see Phase 7).

## Phase 7 — Settle in (in progress; steps 1, 3, 4 done, 2 under way)

The next steps, in order; each is a queue item unless it needs the operator's
hands on the host. Status as of 2026-08-19:

1. **Install on the host** — done 2026-08-18 on the operator laptop, then
   the host moved the same night to a dedicated Incus instance
   (`selfie:snowcat`, runbook sections *The host as an Incus instance* and
   *Moving the host to a new machine*, #61) reached over a private mesh in
   local mode (runbook *A private mesh instead of Access*, #62); the laptop
   is retired as a host. On 2026-08-19 the single hourly feeder split into
   four per-command timers (seed daily, import every 15 minutes,
   dependencies daily, settings weekly) and verification moved to every
   10 minutes (#88); `upgrade.sh` re-execs itself when a pull changes it
   (#89).
2. **A week of steady state on the fleet** — under way: updex, snowcat,
   clix, and std run the full program catalog; 2026-08-19 was the first day
   operated mostly by an orchestrating session (four concurrent worker
   agents, model sized by item kind) plus the operator's own worker —
   ~45 items in a day, every discovery one finding, fixes as PRs, cures
   that refused to forge patches and filed `pr-cure-change` instead. The
   daily numbers now come from a command instead of by hand:
   `npm run --silent queue -- metrics` prints accepted-per-attempt, blocked,
   and time-to-merge for a window, per repository and in total (work-queue
   spec rule 56, runbook *What to record for the PRD*); still to do: record
   its reading into the PRD baseline each day.
   (The Hive/Snowcat boundary was decided 2026-08-18:
   Hive retired, ADR-0062.) The first two days also showed worker pull
   requests reaching the human with defects nothing caught, and Copilot's
   *Lite* auto-review plus the fleet's review-apply workflows looping on
   them; 2026-08-19's answer is the per-repository review gate under
   [ADR-0065](../adr/0065-gate-worker-pull-requests-behind-bounded-review.md)
   (drafts, bounded `pr-review` rounds, `pr-review-fix`, `result.model`
   provenance; off by default — `queue -- review-gate <owner/repo> on`,
   snowcat first), with the Copilot effort level and workflow retirement
   handled outside this repository.
3. **Second repository** — done 2026-08-18: `frostyard/clix` and
   `frostyard/std` enrolled after ACMM conformance, governance files, and
   GoReleaser Pro landed there; four repositories run at once.
4. **Maintenance programs** — done 2026-08-18 (all eight catalog programs,
   per-program cadence, PR cure under
   [ADR-0061](../adr/0061-cure-pull-requests-as-bounded-per-head-work.md),
   conformance and triage after ADR-0062, the internal dependency chain and
   the repository-settings sweep against core ADR-0040); the
   [maintenance programs plan](maintenance-programs.md) records each phase.
   A 2026-08-19 finding fixed the sweeps' 100-item window (#77) — verify
   and cure had silently stopped inspecting once a repository passed 100
   completed items.
5. **Surface follow-ups** — the pull-request section and per-repository
   counts landed (#49 → #74, built by the queue). The decision-record view
   and the per-repository event filter landed together as `/events`
   (#100 → #103, built by the queue): one page with a repository filter, a
   `since` window, and a decisions-only toggle over the same `eventsSince`
   read the CLI uses ([operator surface](../design/operator-surface.md#views)).
   Keyboard-first review remains a small queue item, only after (2) shows it
   matters.
6. **Runbook and PRD** — fold the week's numbers into targets and change the
   PRD status from Discovery only through its review path.

## Later / ideas

- Grants and capability profiles from ADR-0032/0034 as additional claim
  filters once one repository shows contention.
- **Per-repository WIP limit (ADR-0034)** — filed 2026-08-19 after the
  first Copilot fleet run: four supervisors drained 23 discovery roots in
  ~20 minutes, the operator admitted 18 proposals in bulk, and 19 draft
  pull requests reached the review gate within 40 minutes; every one
  passed the gate and was merged by hand the same afternoon (~45 minutes
  of operator time for 20+ pull requests across four repositories — judged
  fine today). The gate filters quality; it does not pace volume, and the
  pace is set by admission. When it stops being fine: a per-repository cap
  on pull requests that are ready-for-review-but-unmerged (or on admitted
  change-shaped items), enforced as a claim filter like enrollment
  (rule 36's hook shape) so a worker leases nothing in a repository whose
  inventory is full, with the board showing the cap and the count; admission
  stays the operator's, the cap only stops workers from running ahead of
  merges. Not before the numbers say so (`queue -- metrics`: time-to-merge
  rising, accepted-per-attempt flat).
- Unpark GitHub observation only if on-demand verification demonstrably
  misses state that a maintainer relied on.
- Remote workers: accepted and built 2026-08-18 as
  [ADR-0063](../adr/0063-authenticate-people-through-cloudflare-access-and-mint-mcp-tokens.md)
  (Streamable HTTP `/mcp` with Snowcat-minted member tokens; Cloudflare
  Access for people, kept optional — the operator chose a private mesh in
  local mode instead, runbook *A private mesh instead of Access*); grants
  still deferred.
- The name: accepted 2026-08-18 as
  [ADR-0064](../adr/0064-adopt-the-name-snowcat.md) (Snowcat); the
  repository, host units, and environment variables are renamed, `FLUENT_*`
  is read for one release.
- Tokens per accepted outcome, once a client can report them.
- **Project sequencing — accepted 2026-08-19 as
  [ADR-0066](../adr/0066-sequence-project-slices-on-observed-predecessor-delivery.md)**
  (predecessor references on imported items, satisfied only by observed
  delivery; planning via core's `frostyard-plan-project` skill; release
  URLs as artifacts). Implementation still to schedule: one queue rung for
  the predecessors column, `depends-on:` parsing in `import-issues`, the
  claim-path gate, release-artifact verification, and surface visibility
  for unmet predecessors. Until it lands, the skill's issue format works
  today with hand-paced admission.

## Open questions

- **Second dogfood repository:** resolved 2026-08-18 — clix and std
  (Phase 7 step 3).
- **Hive boundary:** resolved 2026-08-18 by
  [ADR-0062](../adr/0062-retire-hive-fluent-owns-conformance.md) — Hive is
  retired; Snowcat's `conformance` and `triage` programs own what it did.

## References

- Implements: [work queue](../specs/work-queue.md) and
  [queue execution boundary](../design/queue-execution-boundary.md)
- Decision: [ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md)
- Re-sequences: [product foundation roadmap](product-foundation-roadmap.md)
- Eligibility source: [repository enrollment](../design/repository-enrollment.md)
