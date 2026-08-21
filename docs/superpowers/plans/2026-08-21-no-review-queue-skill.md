# No-Review Snowcat Queue Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a discoverable Snowcat worker skill that claims every observed eligible kind except exact `pr-review`, without changing queue runtime behavior.

**Architecture:** A thin companion skill owns only pre-claim kind selection, then delegates the claimed item's lifecycle to `work-snowcat-queue`. A repository contract test pins the skill's discovery metadata, canonical link, exclusion boundary, live-kind filtering, one filtered claim, and delegation.

**Tech Stack:** Markdown agent skills, Node.js 24+, TypeScript, `node:test`, `node:assert/strict`.

## Global Constraints

- Exclude only exact `pr-review`; `pr-review-fix`, `pr-cure`, discovery, `issue-resolution`, and future non-review kinds remain eligible.
- Derive the positive `kinds` filter from live queued items; do not maintain a fixed whitelist.
- Call `claim_work` at most once per selection pass and never claim-then-release review work.
- Do not change queue runtime code, schemas, MCP tools, credential behavior, or `.agents/skills/work-snowcat-queue/SKILL.md`.
- Keep the pull request draft and close frostyard/snowcat#185.

---

### Task 1: Establish the no-guidance baseline

**Files:**
- Record results in the implementation evidence; no repository file changes.

**Interfaces:**
- Consumes: hypothetical queued item kinds and the current general queue-worker guidance.
- Produces: concrete baseline failure/rationalization evidence that the companion guidance must address.

- [ ] **Step 1: Run five fresh-context no-guidance pressure samples**

Use five fresh general agents with no new skill content. Tell each agent not to call tools and to return the exact Snowcat calls it would make. Combine at least three pressures in the prompt: an urgent `pr-review` is first, a non-review implementation item is also queued, the operator says the worker must not review, time is limited, and `claim_work` has only a positive `kinds` filter.

The core hypothetical queue is:

```text
queued kinds, in order: pr-review, pr-review-fix, quality-gap-discovery, future-maintenance-kind
worker boundary: do everything except pr-review
```

- [ ] **Step 2: Record the baseline behavior verbatim**

For each of the five responses, record whether it makes an unrestricted claim, uses a fixed whitelist that drops the future kind, claims then releases `pr-review`, or correctly derives a live positive filter. Identify the exact rationalizations behind every failure. If all controls already comply, stop and reassess whether a new skill is justified rather than authoring redundant guidance.

---

### Task 2: Pin the companion contract

**Files:**
- Create: `test/work-snowcat-without-reviews-skill.test.ts`
- Read: `.agents/skills/work-snowcat-queue/SKILL.md`
- Read: `AGENTS.md`

**Interfaces:**
- Consumes: repository root from `process.cwd()`.
- Produces: a test that fails until the skill and AGENTS link exist and carry the approved boundary.

- [ ] **Step 1: Write the failing repository contract test**

Create `test/work-snowcat-without-reviews-skill.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const skillPath = join(root, ".agents", "skills", "work-snowcat-without-reviews", "SKILL.md");

test("the no-review queue skill filters before one claim and delegates the lifecycle", () => {
  const skill = readFileSync(skillPath, "utf8");
  const normalized = skill.replace(/\s+/g, " ");
  assert.match(skill, /^---\nname: work-snowcat-without-reviews\ndescription: Use when /);
  assert.match(normalized, /`list_work` with `status: "queued"`, `limit: 100`/);
  assert.match(normalized, /excluding only the exact kind `pr-review`/);
  assert.match(normalized, /Do not use a fixed kind whitelist/);
  assert.match(normalized, /Call `claim_work` exactly once with `kinds` set to that array/);
  assert.match(normalized, /`pr-review-fix`/);
  assert.match(normalized, /future non-review kind/);
  assert.match(normalized, /\*\*REQUIRED SUB-SKILL:\*\* Use `work-snowcat-queue`/);
  assert.doesNotMatch(skill, /## Review a pull request/);
});

test("AGENTS.md advertises the no-review queue skill", () => {
  const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /\.agents\/skills\/work-snowcat-without-reviews\/SKILL\.md/);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
node --import tsx --test test/work-snowcat-without-reviews-skill.test.ts
```

Expected: FAIL because `.agents/skills/work-snowcat-without-reviews/SKILL.md` does not exist.

---

### Task 3: Add the minimal companion skill

**Files:**
- Create: `.agents/skills/work-snowcat-without-reviews/SKILL.md`
- Modify: `AGENTS.md:39-42`
- Test: `test/work-snowcat-without-reviews-skill.test.ts`

**Interfaces:**
- Consumes: queued work returned by Snowcat `list_work` and the canonical `work-snowcat-queue` lifecycle.
- Produces: one filtered `claim_work` call whose `kinds` array contains every observed allowed kind except exact `pr-review`.

- [ ] **Step 1: Create the skill**

Create `.agents/skills/work-snowcat-without-reviews/SKILL.md` with this initial content, then refine only in response to pressure-test failures:

```markdown
---
name: work-snowcat-without-reviews
description: Use when working the Snowcat queue as a worker that may perform discovery, implementation, fixes, and cures but must not claim pull-request review work.
---

# Work the Snowcat queue without reviews

Claim non-review work without duplicating Snowcat's canonical worker lifecycle.

**REQUIRED SUB-SKILL:** Use `work-snowcat-queue` for every rule except the `claim_work` call in step 2 of its claim section. The selection gate below replaces that call; after a claim, follow the canonical skill exactly.

## Selection gate

1. Call `list_work` with `status: "queued"`, `limit: 100`, and any repository restriction the operator supplied.
2. Build a deduplicated array of the observed queued kinds, excluding only the exact kind `pr-review`. Intersect it with any kinds the operator named. Do not use a fixed kind whitelist: a future non-review kind remains eligible.
3. If the array is empty, stop cleanly: the bounded listing exposed no eligible kind. Do not claim a review merely because it is urgent, first, or the only visible queued item.
4. Call `claim_work` exactly once with `kinds` set to that array and the same repository restriction. If it returns `null`, stop; do not retry with widened or omitted kinds.
5. Inspect and complete the claimed item through `work-snowcat-queue`. In an explicitly requested loop, repeat this selection gate before every claim.

## Boundary

| Kind | Action |
| --- | --- |
| `pr-review` | Never claim |
| `pr-review-fix` | Eligible implementation work |
| `pr-cure` / `pr-cure-change` | Eligible |
| `*-discovery`, `issue-resolution`, fixes | Eligible |
| A future non-review kind | Eligible when observed queued |

## Example

Queued kinds are `pr-review`, `quality-gap-discovery`, and `new-fix-kind`. Call `claim_work` once with `kinds: ["quality-gap-discovery", "new-fix-kind"]`.

## Common mistakes

- Unrestricted claim then release a review: filter before claiming to avoid lease churn.
- Static implementation whitelist: derive kinds from the live queue so new non-review work is not hidden.
- Reimplement the worker lifecycle here: defer duplicate detection, permissions, leases, evidence, artifacts, follow-ups, and completion to `work-snowcat-queue`.
```

- [ ] **Step 2: Register the skill in AGENTS.md**

Add immediately after the canonical queue-worker bullet:

```markdown
- **Claim and resolve queued work without pull-request reviews** →
  [.agents/skills/work-snowcat-without-reviews/SKILL.md](.agents/skills/work-snowcat-without-reviews/SKILL.md).
```

- [ ] **Step 3: Run the focused contract test**

Run:

```bash
node --import tsx --test test/work-snowcat-without-reviews-skill.test.ts
```

Expected: PASS, 2 tests and 0 failures.

---

### Task 4: Pressure-test and refine the skill

**Files:**
- Modify only if a demonstrated failure requires it: `.agents/skills/work-snowcat-without-reviews/SKILL.md`
- Test: `test/work-snowcat-without-reviews-skill.test.ts`

**Interfaces:**
- Consumes: the baseline scenarios from Task 1 plus the new skill text.
- Produces: convergent agent behavior under pressure and explicit counters for observed loopholes.

- [ ] **Step 1: Run five fresh-context samples with the full skill text**

Each fresh agent must return one filtered claim containing `pr-review-fix`, `quality-gap-discovery`, and `future-maintenance-kind`, but not `pr-review`. Include all edge cases from Step 2 in the same prompt so each condition receives five independent samples.

- [ ] **Step 2: Test edge cases in fresh contexts**

Run at least these variants:

```text
operator restricts kinds to [pr-review, pr-review-fix] -> claim only pr-review-fix
queue contains only pr-review -> stop without claim or release
queue contains unknown-future-kind -> include it in the single filtered claim
claim returns null -> stop without an unrestricted retry
```

- [ ] **Step 3: Close only demonstrated loopholes**

If an agent violates the boundary, add its exact rationalization to `Common mistakes` or an explicit stop condition, then rerun the failed scenario. Do not copy the canonical lifecycle into this skill.

- [ ] **Step 4: Re-run the focused contract test after refinement**

Run:

```bash
node --import tsx --test test/work-snowcat-without-reviews-skill.test.ts
```

Expected: PASS, 2 tests and 0 failures.

---

### Task 5: Verify and publish

**Files:**
- Verify all changed files from Tasks 2-4 plus the committed design and this plan.

**Interfaces:**
- Consumes: completed skill, tests, AGENTS link, design, and plan.
- Produces: draft PR closing issue #185 with verified repository evidence.

- [ ] **Step 1: Run the full repository gate**

Run:

```bash
npm run check
```

Expected: audit, docs/deploy checks, typecheck, all tests and coverage floors, denominator check, and build pass.

- [ ] **Step 2: Inspect the final diff and request independent review**

Confirm no runtime, schema, MCP, credential, or canonical queue-skill file changed. Review against issue #185 and this plan; fix every blocker and rerun affected checks.

- [ ] **Step 3: Commit the implementation**

```bash
git add .agents/skills/work-snowcat-without-reviews/SKILL.md AGENTS.md test/work-snowcat-without-reviews-skill.test.ts docs/superpowers/plans/2026-08-21-no-review-queue-skill.md
git commit -m "feat(skills): add no-review queue worker"
```

- [ ] **Step 4: Open the draft pull request**

Push the branch and open a draft PR titled `feat(skills): add no-review queue worker`. The body must include `Closes #185`, summarize the exact `pr-review` exclusion, and list pressure tests plus `npm run check` verification.

- [ ] **Step 5: Watch PR checks and complete Snowcat work**

Leave the PR draft. Report the exact PR URL and head SHA, local checks, pressure-test evidence, independent review, and GitHub checks in `complete_work` using model `openai/gpt-5.6-sol`.
