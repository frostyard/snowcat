# No-Review Snowcat Queue Skill Design

**Date:** 2026-08-21
**Issue:** [frostyard/snowcat#185](https://github.com/frostyard/snowcat/issues/185)
**Status:** Approved

## Problem

The canonical `work-snowcat-queue` skill can claim every eligible kind,
including `pr-review`. Some workers should perform discovery and implementation
work but must not independently review pull requests. Snowcat's MCP claim API
accepts a positive kind filter, not a negative filter, so an unrestricted claim
cannot enforce that boundary.

## Design

Add a thin companion skill named `work-snowcat-without-reviews`. It owns only
the claim-selection boundary and requires the canonical `work-snowcat-queue`
skill for the rest of the lifecycle.

The companion will:

1. Call `list_work` for queued items.
2. Collect the distinct observed kinds except the exact kind `pr-review`.
3. Stop cleanly when that set is empty.
4. Call `claim_work` once with the collected kinds.
5. Follow `work-snowcat-queue` for inspection, duplicate detection, execution,
   evidence, completion, blocking, release, and explicit continuous-work loops.

Only `pr-review` is excluded. `pr-review-fix`, `pr-cure`, discovery,
`issue-resolution`, and other non-review kinds remain eligible. Deriving the
positive filter from the live queued kinds avoids a fixed whitelist that would
silently reject future non-review kinds.

The skill must never claim an item and then release it merely because it is a
review. Filtering before the single claim avoids lease churn and preserves the
canonical at-most-one-item rule.

## Repository Changes

- Add `.agents/skills/work-snowcat-without-reviews/SKILL.md`.
- Add the skill to the canonical skills list in `AGENTS.md`.
- Add a contract test under `test/` that pins discovery metadata, the AGENTS
  link, exact `pr-review` exclusion, live-kind filtering, one filtered claim,
  and delegation to `work-snowcat-queue`.
- Do not change queue runtime code, schemas, MCP tools, credential behavior, or
  the canonical queue skill.

## Skill Verification

Skill behavior will use documentation TDD:

1. Run a fresh-agent pressure scenario without the new skill where a review is
   first in a mixed queue, and record whether the agent makes an unrestricted
   claim or otherwise permits `pr-review`.
2. Add the minimal companion guidance addressing the observed failure.
3. Re-run the same scenario with the skill and require one claim filtered to
   the observed non-review kinds.
4. Test edge cases: review-only queue stops without claiming; mixed queue keeps
   `pr-review-fix`; future unknown non-review kinds remain eligible.

The repository gate is `npm run check`. The pull request must remain draft
under Snowcat's review gate and close issue #185.
