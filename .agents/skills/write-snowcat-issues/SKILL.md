---
name: write-snowcat-issues
description: Write a GitHub issue that Snowcat can import as one bounded, verifiable work item — objective, scope, evidence-shaped acceptance criteria, and constraints a worker cannot misread. Use whenever asked to file, refine, or review an issue that will be labeled for the Snowcat queue, or to turn a discovery finding into an implementation item.
---

# Write an issue for the Snowcat queue

Produce an issue that `npm run queue -- import-issues <owner/repo> --label
<label>` turns into one `issue-resolution` item a worker can claim, finish in
one lease, and complete with evidence Snowcat can verify. Done looks like: a
worker reads only the issue, does exactly one thing, opens one conventional
pull request, and `complete_work` is accepted on the first try.

The worker sees the title as the objective and the body as instructions,
quoted as untrusted context ([work queue spec](../../../docs/specs/work-queue.md)
rule 31). It also reads the item's `operatorNotes` and any linked pull
requests before starting. Write for that reader.

## Steps

1. **Title = the commit that will land.** Conventional Commits, imperative,
   scoped: `feat(queue): …`, `fix(sysext): …`, `ci(test): …`, `docs(agents):
   …`. Workers mirror the issue title into the PR title and commit; the
   repository's title lint (where present) checks it. Never `[quality] …`.
2. **Open with the problem, with evidence.** One paragraph: what is wrong,
   where (`path:line`, workflow job, command output), and how you know
   (observed on which date, which PR or commit introduced it). A discovery
   finding's evidence list is the right raw material — paste the relevant
   lines, not the whole report.
3. **State the change as a bounded list**, in the order it should be done.
   Name files, functions, commands, and the exact contract they must satisfy.
   Say what must *not* change: no schema rung, no new MCP tool, no Go source
   in a workflow fix, no production code in a test-coverage item. Point at
   the governing doc (`AGENTS.md`, a spec rule, an ADR) instead of restating
   it. Include the doc, spec, and skill updates the change requires; the
   worker will not infer them.
4. **Write acceptance criteria that can only be satisfied by something
   observable.** At least one criterion must be a fact on GitHub after the
   PR exists — a named check green on the PR head, a specific log line in
   the PR's own job (`=== RUN TestX` appears and passes), a state change,
   a check *failing* on a deliberately bad input then passing — so the
   worker has to watch CI before calling `complete_work`. The rest are
   mechanical: `grep -c … prints 0`, `go tool cover -func … ≥ 90%`, "test
   file X proves Y", `npm run check` / `make check` passes. Avoid criteria
   that need judgment ("cleaner", "reasonable coverage").
5. **Bound the blast radius.** Say what a worker should do when the change
   flips a default or touches a protected boundary (workflows, release
   pipeline, credentials): opt-in flag, review-required note, or "block and
   ask" if the decision is the operator's. If the fix is really an
   organization decision (a core ADR), say so and stop; do not ask a worker
   to choose.
6. **Add the trigger label** (`snowcat`, or the repository's convention) and
   nothing else the queue needs. Set priority at import (`--priority N`),
   not in the issue. One issue = one item; if it is two changes, it is two
   issues.
7. **Verify by import.** `npm run --silent queue -- import-issues <owner/repo>
   --label <label>` creates exactly one `proposed` item whose objective is
   the title; `queue -- show <id>` shows the body intact and under 16,000
   characters. Approve it only when the criteria above hold.

## Pitfalls

- **Criteria satisfiable locally only** → the worker completes the moment
  `make check` is green and never looks at the PR's CI. Put one criterion on
  the PR itself.
- **Two findings, opposite directions** (one item says remove a filter,
  another says restore it) → surface the contradiction to the operator
  before approving either; that is an ADR question, not a queue item.
- **"Also, while you're there…"** → a second PR or scope creep. Split it.
- **Vague scope** ("improve coverage") → the worker picks its own target.
  Name the package, function, and number.
- **Restating a doc instead of linking it** → drift the moment the doc
  changes. Link `AGENTS.md`, the spec rule, or the ADR.
- **Body over 16,000 characters** → truncated in the item; move detail into
  a linked doc or gist.
- **Forgetting the private-repository token** → completions come back
  `unverified`; make sure the MCP server has `SNOWCAT_GITHUB_TOKEN`
  ([runbook](../../../docs/design/queue-operations.md)).

## Worked examples (2026-08-17)

- **Good — observable and self-demonstrating:** "A workflow fails a PR whose
  title is not conventional and passes one that is (demonstrated on the PR
  itself)". The worker retitled its own PR to a bad title, showed the check
  fail, restored it, and the run history became the evidence
  (frostyard/updex#301 → #302).
- **Good — CI-anchored:** "On the PR's own Unit Tests and Race Detection job
  logs, `=== RUN TestCLIIntegration_…` appears and passes; `grep -c 'skip
  "Integration"' .github/workflows/test.yml` prints 0" (frostyard/updex
  ci-implementation → #308).
- **Good — scoped negative constraints:** "No `SCHEMA_VERSION`/rung change;
  do **not** add an MCP tool" kept a queue feature inside the boundary
  (frostyard/snowcat#2 → #5, #1 → #11).
- **Weak, fixed by later items:** a requeue whose reason lived only in an
  event; the next worker never saw it and opened a duplicate PR
  (frostyard/snowcat#2 → #6). Fixed by `operatorNotes` (#7) and the skill
  rule to check for existing work (#8) — but the lesson for issue authors
  stands: assume the reader has *only* the issue and the item.
