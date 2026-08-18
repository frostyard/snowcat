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

## Phase 2 — Program catalog with cadence (small)

- Move the templates out of `src/queue/seeds.ts` into a catalog
  (`src/queue/programs.ts`): id, discovery template, default child ceiling,
  cadence (no-finding cooldown per program instead of one 24 h value),
  admission policy for children (`proposed` default), and the repository
  types it applies to. The four existing programs are the first entries and
  keep their current text.
- Cadence defaults: security daily, quality and CI daily, architecture
  weekly, dependencies weekly, docs weekly, conformance on Core-ADR change
  (or weekly), triage daily, cure per feed interval.
- Runbook and spec name the catalog and its cadences; the surface's Seed
  dogfood button reads the catalog.
- **Done when:** the feeder seeds from the catalog with per-program cooldown
  and a new program is one catalog entry plus a Core enum value.

## Phase 3 — Widen the Core enum (Core-side, operator)

- Core's `repository.schema.json` `maintenance_programs` enum is exactly
  `quality | ci | security | architecture`, `maxItems: 4`. Extend it (a new
  schema version or a compatible enum widening, per Core's own ADR rules)
  with `conformance`, `triage`, `dependencies`, `docs`, `release`, and raise
  `maxItems`; add fixtures; Fluent's bundled schema copy and digest update
  alongside (the validator pins schema digests).
- **Done when:** a repository declaration listing `conformance` validates in
  Core and in Fluent, and updex's declaration names the programs it actually
  wants.

## Phase 4 — Pull-request cure (ADR-0061)

- Extend `verify-artifacts` to read mergeability and check-runs for each
  reported pull request and enqueue `pr-cure` items per head with a patch
  digest; a `pr-cure` completion is refused when the patch digest changed;
  `pr-cure-change` proposals carry the substantive fix. Repository opt-in for
  foreign pull requests. Skill and issue-writing skill describe the kind.
- **Done when:** a fixture pull request that falls behind its base yields one
  admitted `pr-cure` item, a mechanical rebase completes with an unchanged
  digest, a conflicting one is refused and yields a `pr-cure-change`
  proposal, and the same head is not enqueued twice.

## Phase 5 — Conformance and triage (first new programs)

- **conformance** — does the repository satisfy Core's binding ADRs? Sources:
  `docs/org-adrs.md` versus Core's current ADR set, canonical surfaces
  present and valid, `make ci`, title lint, ACMM criteria (the
  `frostyard-acmm-conformance` skill). Child: one bounded compliance change
  or one Core issue when the ADR is what should move (the ADR-0022 → ADR-0038
  case). Cadence: on Core-ADR change, else weekly.
- **triage** — stale issues, duplicates, needs-repro, missing labels, issues
  resolved by a merged pull request but still open (#299 stayed open until
  #312). Children are proposals only, because closing or labeling issues is
  outward-facing; each proposal names the exact issue and action. Cadence:
  daily.
- **Done when:** both programs produce a valid no-finding or one admitted
  child on updex, and triage's proposals close at least one resolved-but-open
  issue through the operator's admission.

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
  start proposal-only and look at the admission rate.

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
