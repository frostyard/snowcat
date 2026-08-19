# .memory/ — corrections inbox

The single sanctioned inbox for durable learned corrections in this
repository, per frostyard/core
[ADR-0018](https://github.com/frostyard/core/blob/main/docs/adr/0018-org-wide-agent-instruction-and-knowledge-surfaces.md)
as amended by
[ADR-0025](https://github.com/frostyard/core/blob/main/docs/adr/0025-consolidate-repository-docs-into-docs.md)
(one `.memory/` inbox, drained into `docs/`; no separate `.knowledge/` tree).
Rules live in [AGENTS.md](../AGENTS.md) — the canonical, tool-agnostic
instruction file every per-tool path aliases
([ADR-0002](../docs/adr/0002-agent-portable-instruction-surface.md)); this
inbox holds what was learned the hard way before it becomes a rule or a doc.

Contract:

- `corrections.jsonl` is **append-only** — one JSON object per line, five
  fields, all required, no others:

  ```json
  {"date": "YYYY-MM-DD", "scope": "…", "correction": "…", "evidence": "…", "promoted_to": ""}
  ```

  `date` is the day the correction was learned; `scope` names the area
  (a path, subsystem, or program); `correction` is the rule in one sentence;
  `evidence` cites the pull request, issue, ADR, or run that proved it.
- `promoted_to` starts empty; when a correction graduates into
  [AGENTS.md](../AGENTS.md), a doc under [docs/](../docs/README.md), or a
  skill under [.agents/skills/](../.agents/skills/), set it to that path.
  Promotion is the only sanctioned duplication — the `frostyard-repo-docs`
  maintenance pass drains this inbox.
- Never record credentials, tokens, private URLs, or non-public
  vulnerability details.
- `test/repository-surfaces.test.ts` pins the shape: every non-empty line
  must parse as a JSON object with exactly those five keys.

Agent surfaces are not documentation: this directory has no entry in
`docs/README.md` (core ADR-0029).
