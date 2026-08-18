# Plan: Maintenance programs

This plan takes Fluent's standing maintenance from the four hard-coded
discovery kinds (quality, CI, security, architecture) to a catalog of programs
that Core declares per repository, that run on their own cadences, and that
include curing pull requests. It is the record of every program discussed on
2026-08-18 so none is dropped, and the order in which to build them. It
follows the [recovery plan](recover.md) Phase 7 and is governed by
[ADR-0021](../adr/0021-run-bounded-maintenance-assessments.md) (bounded
assessments), [ADR-0009](../adr/0009-apply-goals-through-discovery-and-admission.md)
(discovery and admission), and
[ADR-0061](../adr/0061-cure-pull-requests-as-bounded-per-head-work.md)
(pull-request cure).

Every program keeps the shape that worked: a read-only discovery root finds
exactly one evidence-backed thing and proposes at most one bounded child; the
operator admits; a worker lands it through one pull request; Fluent verifies
the artifact. Programs differ in what they look at, how often, and whether
their children may be admitted on creation.

## Phase 1 — Honor the declaration (small) — done 2026-08-18

- `seed-dogfood --enrolled` (and the board's Seed dogfood for a declared
  repository) seed only the programs the repository's Core declaration lists
  in `maintenance_programs` (`enrolledRepositoryPrograms` in
  `src/queue/eligibility.ts`, read from
  `ControlPlaneStore.repositoryStatuses().maintenancePrograms`); a
  repository declaring `["quality","ci"]` gets two roots, not four, and the
  result names the omitted kinds as `undeclaredKinds`. Explicit
  `seed-dogfood <owner/repo>` still seeds all four for a repository not under
  the gate; the runbook says so.
- Observation recorded in the runbook: updex declared `quality, ci` and ran
  four programs for two days (2026-08-16 to 2026-08-18) because the feeder
  ignored the list.
- **Done when:** a fixture-enrolled repository declaring two programs receives
  exactly those two roots from `--enrolled`, and the runbook says which
  command honors the declaration. — Met: `test/seeds.test.ts`,
  `test/cli.test.ts`, and `test/surface.test.ts` assert the two-root result;
  the [runbook](../design/queue-operations.md) names `--enrolled`.

## Phase 2 — Program catalog with cadence (small) — done 2026-08-18

- The templates moved out of `src/queue/seeds.ts` into the catalog
  [`src/queue/programs.ts`](../../src/queue/programs.ts): id (the Core enum
  value), discovery template, child ceiling (`delegableActions`), cadence
  (`cooldownSeconds`, a no-finding cooldown per program instead of one 24 h
  value), and children's admission policy (`proposed`). The four existing
  programs are the first entries and keep their text. Repository types are
  deliberately absent: Core declares none yet, and the catalog will not
  invent a classification Core does not have (revisit with Phase 3).
- Cadence defaults in the catalog: quality, CI, and security daily,
  architecture weekly. Reserved for later entries: dependencies weekly, docs
  weekly, conformance on Core-ADR change (or weekly), triage daily, cure per
  feed interval.
- `QueueStore.enqueueInactiveRootBatch` takes a cooldown per candidate;
  `--cooldown-hours <n>` overrides every program's for one run. The runbook
  and spec rule 32 name the catalog and its cadences; the board's Seed dogfood
  note spells out each declared program's cadence.
- **Done when:** the feeder seeds from the catalog with per-program cooldown
  and a new program is one catalog entry plus a Core enum value. — Met:
  `test/programs.test.ts` pins the catalog shape and cadences,
  `test/seeds.test.ts` shows a daily program re-offered while a weekly one is
  still cooling.

## Phase 3 — Widen the Core enum (Core-side, operator) — in flight 2026-08-18

- Decided 2026-08-18: compatible enum widening **within v1** (core ADR-0039,
  core PR #87), not a v2 schema; all five values at once (`conformance`,
  `triage`, `dependencies`, `docs`, `release`), `maxItems: 9`; no cadence
  field in the declaration (catalog stays the cadence source of truth until
  a repository shows a need); Fluent ships the new bundled schema bytes and
  digest and keeps the superseded revision bundled (so retained snapshots,
  rollback, and either merge order keep working — the first attempt without
  it locked the control-plane store on the operator host for a few minutes on
  2026-08-18). Fluent's `REPOSITORY_MAINTENANCE_PROGRAMS`
  (`src/control/registry.ts`) is the widened closed vocabulary; the feeder
  reports declared programs the catalog does not implement yet as
  `unsupportedPrograms` and seeds nothing for them.
- Still the operator's: merge order (Fluent PR, then core PR #87, then
  `core -- activate`), and which repositories declare which programs (updex
  ran `security` and `architecture` productively for two days; `conformance`
  waits on the Hive/Fluent boundary decision).
- **Done when:** a repository declaration listing `conformance` validates in
  Core and in Fluent (met by `test/core-source.test.ts` on the bundled schema;
  live once #87 merges and activates), and updex's declaration names the
  programs it actually wants (operator).

## Phase 4 — Pull-request cure (ADR-0061) — done 2026-08-18 (v1)

- `verify-artifacts` runs the cure sweep (`src/queue/pull-request-cure.ts`)
  after the refresh: for every open reported pull request it reads
  `mergeable_state`, check runs, reviews, and the patch identity, and
  enqueues one admitted `pr-cure` root per decayed head (`sourceRef =
  <url>@<head>`, `cure` record in schema rung 5's `cure_json`); the same head
  is never enqueued twice; drafts, closed, and uncomputable patches are
  skipped and reported. `complete_work` refuses a `pr-cure` whose patch
  identity (added/removed lines per file, hunk headers and context excluded)
  changed, or that does not report the pull request, or that GitHub cannot
  confirm; `pr-cure-change` proposals carry substantive fixes. Spec rules
  42–44, runbook, AGENTS.md, and the `work-fluent-queue` skill describe the
  kind.
- Deliberately deferred: foreign pull requests (per-repository opt-in), title
  lint as its own signal (on updex it is a check run), age threshold,
  unresolved review threads (GraphQL). Each is a follow-up issue when a week
  of curing Fluent's own pull requests says it matters.
- **Done when:** a fixture pull request that falls behind its base yields one
  admitted `pr-cure` item, a mechanical rebase completes with an unchanged
  digest, a conflicting one is refused and yields a `pr-cure-change`
  proposal, and the same head is not enqueued twice. — Met by
  `test/pull-request-cure.test.ts` (behind → one root; rebased head with the
  same identity completes; edited patch refused through MCP with the item
  left claimed; same head skipped, push is a new head).

## Phase 5 — Conformance and triage (first new programs) — catalog entries landed 2026-08-18

Decided by [ADR-0062](../adr/0062-retire-hive-fluent-owns-conformance.md):
Hive is retired and Fluent owns conformance and triage.

- **conformance** — does the repository satisfy Core's binding ADRs? Sources:
  `docs/org-adrs.md` versus Core's current ADR set, canonical surfaces
  present and valid, `make ci`, title lint, ACMM criteria (the
  `frostyard-acmm-conformance` skill). Child: one bounded compliance change
  or one Core issue when the ADR is what should move (the ADR-0022 → ADR-0038
  case). Cadence: weekly in the catalog (`conformance-gap-discovery`);
  seeding on Core-ADR change is a later refinement — the Core poll already
  knows when the active snapshot changes.
- **triage** — stale issues, duplicates, needs-repro, missing labels, issues
  resolved by a merged pull request but still open (#299 stayed open until
  #312). Children are proposals only, because closing or labeling issues is
  outward-facing; each proposal names the exact issue and action, and its
  ceiling is `read, open-issue` — never a pull request. Cadence: daily
  (`triage-discovery`).
- A repository opts in by declaring the program in Core; the feeder seeds it
  from the catalog on the next run.
- **Done when:** both programs produce a valid no-finding or one admitted
  child on updex, and triage's proposals close at least one resolved-but-open
  issue through the operator's admission. — Catalog entries, tests, and docs
  are in; the operational half waits on the first week of runs.

## Phase 6 — Dependencies and docs drift

- **dependencies** — outdated or vulnerable modules (Go, npm), Dependabot
  noise consolidation, license drift. Proposal-only: the supply-chain
  boundary is `review-required` in every governance file. Cadence: weekly.
- **docs** — user-facing docs, README, runbooks, and examples that no longer
  match code (architecture covers contracts versus code; this covers what a
  reader runs). The `frostyard-repo-docs` skill is the procedure. Cadence:
  weekly.
- **Done when:** each produces a valid no-finding or one admitted child on
  two enrolled repositories.

## Later / ideas

- **release** — merged-but-unreleased changes older than a threshold,
  changelog gaps, version drift, failing nightlies (updex's
  `nightly-compliance`).
- **UI / accessibility** — for Pilothouse and ChairLift: contrast, focus,
  keyboard paths, design-system drift against `frostyard-design`.
- **performance** — only where benchmarks exist; regression against a
  recorded baseline.
- **restricted security findings** — high/critical findings need the
  restricted storage, embargo, and disclosure path from
  [ADR-0024](../adr/0024-restrict-security-findings-before-disclosure.md)
  before the security program may report them; today's security program is
  hardening-gap discovery only.
- **Programs as Core records** — once the catalog is stable, publish it from
  Core so program text, cadence, and ceilings are organization authority
  rather than Fluent code.

## Open questions

- **Cure for foreign pull requests by default?** Off by default, per
  repository; revisit after a week of curing Fluent's own.
- **Cadence source of truth:** catalog default in Fluent now; per-repository
  override in the Core declaration later — decide with Phase 3's schema
  change.
- **Triage authority:** whether triage children may ever be admitted on
  creation (for example, closing an issue whose fixing pull request merged);
  start proposal-only (ADR-0062) and look at the admission rate.

## References

- Implements: [queue execution boundary](../design/queue-execution-boundary.md),
  [work queue](../specs/work-queue.md),
  [queue operations runbook](../design/queue-operations.md)
- Decisions: [ADR-0061](../adr/0061-cure-pull-requests-as-bounded-per-head-work.md),
  [ADR-0021](../adr/0021-run-bounded-maintenance-assessments.md),
  [ADR-0009](../adr/0009-apply-goals-through-discovery-and-admission.md),
  [ADR-0024](../adr/0024-restrict-security-findings-before-disclosure.md)
- Preceded by: [recovery plan](recover.md) Phase 7
- Core contract: [core snapshot ingestion](../design/core-snapshot-ingestion.md)
