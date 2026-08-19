# Review a pull request

Review the given frostyard/snowcat pull request. You are reviewing, not
merging: never approve-and-merge in one act, and never merge a pull request
you authored (`policies/agent-governance.json` marks pull requests
review-required; core ADR-0019).

1. Read [AGENTS.md](../../AGENTS.md) — the working conventions, the
   documentation rules, and the repository boundary the diff must satisfy.
   Read the item's ADRs, design docs, and specs it names.
2. Run the gate exactly as CI does — `npm run check` (`check:audit`,
   `check:docs`, `check:deploy`, typecheck, tests with the line, branch, and
   function coverage floors from `package.json`, build with `check-dist` and
   `check-boot`) — and read its output; a local pass is a CI pass, so a local
   failure is a blocking finding.
3. Documentation rules (AGENTS.md "Documentation rules"): a new doc starts
   from its category's `TEMPLATE.md` and is indexed in
   [docs/README.md](../../docs/README.md); a significant decision has a new
   ADR *first*; design docs and specs changed alongside the code that moved;
   cross-links run both ways; the ubiquitous language in
   [docs/domain/ubiquitous-language.md](../../docs/domain/ubiquitous-language.md)
   is used, not paraphrased. `check:docs` catches missing index entries and
   dead links; you catch stale prose.
4. Boundaries: a change under `.github/workflows/`, GitHub-facing code, or
   the MCP/authorization boundary is review-required at high risk — say so
   in the review. Every `uses:` in a workflow is a full 40-character SHA with
   a `# vX.Y.Z` comment, `permissions: {}` at the top with job-scoped grants,
   and `persist-credentials: false` on checkouts (core ADR-0021, bound by
   [docs/org-adrs.md](../../docs/org-adrs.md)). No lease token, MCP token, or
   credential appears in code, tests, fixtures, or the PR body.
5. Queue contract: a change to `src/queue/` or `src/mcp/` keeps
   [docs/specs/work-queue.md](../../docs/specs/work-queue.md) true — name the
   rule number the change touches and confirm the rule text still holds; a
   new schema rung is appended, never edited (AGENTS.md "Code conventions").
6. Tests: new behavior has a focused test that fails without the change;
   the PR body quotes the red/green observation when the item asked for it;
   nothing skipped or weakened.
7. Report findings ordered by severity, citing file and line, and state
   plainly what passes. A pull request with a blocking finding gets "request
   changes", not silence.
