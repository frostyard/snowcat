# Runbook prompts

Task-shaped runbooks for agents, one per file, named `*.prompt.md`
(frostyard/core
[ADR-0018](https://github.com/frostyard/core/blob/main/docs/adr/0018-org-wide-agent-instruction-and-knowledge-surfaces.md)).
Rules live in [AGENTS.md](../../AGENTS.md); a runbook here is the
*procedure* for one recurring task, not policy. Written tool-agnostically
(core ADR-0002): plain markdown, no tool-specific directives. Runbooks are
agent surfaces, not documentation, so they carry no `docs/README.md` entry
(core ADR-0029).

| Prompt | Task |
| --- | --- |
| [review.prompt.md](review.prompt.md) | Review a frostyard/snowcat pull request against AGENTS.md, the docs rules, and the gate |
| [queue-item-review.prompt.md](queue-item-review.prompt.md) | Review a proposed queue item before admitting it |
