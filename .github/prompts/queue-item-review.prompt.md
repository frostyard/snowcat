# Review a proposed queue item before admitting it

A worker or feeder proposed a work item; the operator decides whether to
admit it (`npm run queue -- approve <id>` or the inbox). Review the
proposal so a bad definition is rejected before a worker spends a lease on
it. You are advising the operator, not admitting: proposals are admitted by a
person — `approve` is the only path that sets `admitted = 1`
([docs/specs/work-queue.md](../../docs/specs/work-queue.md) rule 20; rule 25
for withdrawing admission).

1. Read the item: `npm run queue -- show <id>` (or the inbox item page).
   Read its parent's result if it is a follow-up — the finding it came from
   is the evidence the child rests on.
2. Objective and acceptance criteria: one bounded objective; every
   criterion mechanically verifiable (a command, a grep, a test name, a
   file that must or must not change) — reject "improve", "consider",
   "as appropriate".
3. Actions and delivery: `allowedActions` are within the parent's
   `delegableActions` (the store enforces this) and match the deliverable —
   an item that ends in a pull request carries `open-pr`; an item without
   `open-pr` says in its instructions that it ends on a pushed branch and
   its criteria do not reference the PR or its CI
   (`.memory/corrections.jsonl`, 2026-08-18; issues #67 and #70).
4. Repository and scope: the repository is opted in and (with
   `SNOWCAT_CONTROL_DB`) enrolled — `npm run queue -- list` shows it; the
   instructions name files and commands that exist at the repository's
   current default branch; the item does not ask the worker to merge,
   release, deploy, tag, or touch another repository.
5. Duplicates and prior art: no open or merged pull request already does
   this (`gh pr list --state all --search "<key words>"`); no active root of
   the same kind for the repository (`list queued`, `list claimed`).
6. Sensitive kinds: `dependency-bump`, `release-needed`, `settings-drift`,
   and anything under `.github/workflows/` are review-required boundaries —
   the item must say the PR is human-merged and must not widen its actions
   to do the merge itself.
7. Report: admit, admit with a note (`npm run queue -- note <id> "…"`), or
   reject with the reason the operator should record. Quote the failing
   criterion or missing action; do not rewrite the item yourself.
