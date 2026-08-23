<!-- Title and commits use Conventional Commits (`type(scope): summary`).
Branch off main; never stack on another PR's branch. -->

## Summary

<!-- What changes and why, in a few sentences. Link the issue(s) this
closes. -->

## Checks

<!-- The gate from AGENTS.md — run before opening the PR. -->

- [ ] `npm run check` green — `check:audit` (high severity), `check:docs`,
      `check:deploy`, `typecheck`, built-in Node test coverage (51% lines,
      71% branches, 45% functions), and `build` (`vite build` plus
      `check-dist.mjs` and `check-boot.mjs`)
- [ ] This PR's title matches Conventional Commits (`type(scope): summary`) —
      check it with `node scripts/check-pr-title.mjs "$TITLE"`
- [ ] `src/queue/**` or `src/mcp/**` changed: the
      [work-queue spec](../docs/specs/work-queue.md) rule touched (added or
      renumbered) is named here:

## Risk classification

<!-- Select the highest applicable tier — highest applicable, never lower —
and give a rationale. -->

Select the highest applicable tier from
[docs/risk-tiers.md](../docs/risk-tiers.md).

- [ ] Tier 1: Low
- [ ] Tier 2: Moderate
- [ ] Tier 3: High
- [ ] Tier 4: Critical

**Rationale:**

-

## Docs housekeeping

<!-- Delete rows that don't apply (no docs touched). -->

- [ ] New docs started from their category's `TEMPLATE.md` and indexed in
      `docs/README.md`
- [ ] New significant decision recorded as an ADR *first*, in this PR
- [ ] `docs/design/*` and `docs/specs/*` updated alongside the code they
      describe
- [ ] Canonical domain language (`docs/domain/ubiquitous-language.md`) kept
      current for any changed term
- [ ] Conformance aliases (ADR-0002) untouched — canonical `AGENTS.md`
      edited instead
