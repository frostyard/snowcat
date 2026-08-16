# Fluent (working name)

<!-- One paragraph: what this project is and who it serves. Point at
docs/README.md as the entry point for everything else. Keep this file under
~200 lines — it is loaded into every agent session; long files dilute the
rules that matter. -->

Fluent is a self-hosted coordination service and durable work queue for
operator-started workers maintaining opted-in GitHub repositories. Start at
[docs/README.md](docs/README.md); the product definition remains a discovery
draft and the name is not final.

Use the canonical [Fluent ubiquitous language](docs/domain/ubiquitous-language.md)
for domain terms. Root `CONTEXT.md` is a compatibility symlink to that file;
edit only the canonical path.

This file (`AGENTS.md`) is the CANONICAL agent instructions — `CLAUDE.md`,
`GEMINI.md`, and `.github/copilot-instructions.md` are symlinks to it, and
`.claude/skills` symlinks to `.agents/skills/`
([ADR-0002](docs/adr/0002-agent-portable-instruction-surface.md)). Edit only
the canonical paths; keep content tool-agnostic.

## Skills (follow these for common tasks)

Step-by-step procedures live in [.agents/skills/](.agents/skills/); follow
them rather than improvising, whichever agent you are:

<!-- One bullet per skill: **When to use it** → [.agents/skills/<name>/SKILL.md].
Add a skill whenever you find yourself re-explaining a multi-step procedure.
Start from .agents/skills/TEMPLATE/SKILL.md. -->

- **Claim and resolve one queued repository work item** →
  [.agents/skills/work-fluent-queue/SKILL.md](.agents/skills/work-fluent-queue/SKILL.md).
- **Resolve or review Fluent domain terminology** →
  [.agents/skills/model-fluent-domain/SKILL.md](.agents/skills/model-fluent-domain/SKILL.md).

## Code conventions (live — the code exists)

<!-- The most important section. Rules here must describe the code AS IT IS,
not aspirations — an agent that follows a stale rule produces broken work.
Graduate a rule into this list only when the code enforcing or exemplifying
it has landed; until then it lives in a design doc as intent.

Write rules imperatively and concretely, each with enough mechanism to be
followed without asking ("Storage only via db.Open(slug, migrations)" — not
"use the database layer"). Point at one canonical example in the code for
every structural rule. Rules that remove a degree of freedom are the
valuable ones: every choice an agent doesn't have to make is a failure mode
removed. -->

- Keep native coding-agent processes outside Fluent. They consume work through
  the MCP contract in [`src/mcp/server.ts`](src/mcp/server.ts) and own their
  execution isolation, credentials, and tools.
- Use `npm run --silent control -- …` for host-local target-kernel diagnostics,
  projections, and backup/restore staging. The implementation in
  [`src/control/cli.ts`](src/control/cli.ts) never activates a restore or exposes
  generic domain mutation.
- Use `npm run --silent core -- verify` to fetch and validate the supported
  `frostyard/core` authority candidate through the bare-mirror boundary in
  [`src/core/git-source.ts`](src/core/git-source.ts). Verification is read-only
  with respect to the control plane: it never activates a Core snapshot,
  creates enrollment, or writes `FLUENT_CONTROL_DB`.
- Use `npm run --silent core -- activate <expected-control-plane-sequence>` for
  automatic Core authority mutation. After the first activation it
  verifies Git ancestry from the active source commit, then independently
  revalidates and atomically retains/activates one candidate through the typed handler in
  [`src/control/store.ts`](src/control/store.ts); it still creates no enrollment
  or work.
- Use `npm run --silent core -- rollback <expected-control-plane-sequence>
  <target-commit> <reason>` only for an attributed local-operator rollback
  activation. It creates a resolved typed decision and a new snapshot from
  independently revalidated retained or exact-source bytes; it never deletes
  prior snapshots.
- Use `npm run --silent core -- rejections [limit]` to inspect bounded Core
  candidate rejection observations. `activate` records source, validation,
  continuity, and rolled-back persistence failures through the typed observation/event handler;
  `verify` never does.
- Use `npm run --silent core -- readiness` to inspect the current Core
  admission-readiness reason and its 24-hour source-freshness evidence. The
  read never activates authority or admits work.
- Use `npm run --silent core -- override-staleness
  <expected-control-plane-sequence> <expires-at> <reason>` only for an
  attributed local-operator decision while base readiness is `source-stale`.
  One override expires within 24 hours and cannot relax another readiness
  failure.
- Keep the target control-plane store separate from the disposable queue-spike
  store. Target schema and startup live in
  [`src/control/store.ts`](src/control/store.ts); closed vocabulary lives only
  in [`src/control/registry.ts`](src/control/registry.ts). Do not add a generic
  record or fact mutation surface.
- Run `npm run check` before calling any change done. CI must run the same
  recipe, so a local pass is a CI pass.
- Tests are `*.test.ts` files anywhere under `test/`, discovered recursively by
  Node's test runner (the pattern in `package.json` is quoted so the shell
  never expands it).

## Repository boundary

<!-- What does NOT belong in this repo (secrets, personal data, generated
files that are actually build outputs, apps that belong elsewhere)? How are
releases cut? Delete the section if genuinely not applicable. -->

## Documentation rules (enforced)

Docs live in `docs/` in six categories. **Every new doc starts from its
category's `TEMPLATE.md`** and follows its structure:

- `docs/adr/` — why we decided. Immutable once Accepted; reversals are new
  ADRs that mark the old one Superseded.
- `docs/design/` — how it fits together. Living; updated in place to match
  reality.
- `docs/specs/` — exact contracts. Change only alongside implementing code.
- `docs/plans/` — order of work. Phases with "Done when" outcomes.
- `docs/prd/` — product definition. Living during discovery; status changes to
  Approved only when scope, success measures, and open questions are resolved.
- `docs/domain/` — what domain words mean. Living, lean, and human-reviewed;
  terms are not implementation specifications or decision histories.

### Cross-linking is mandatory

A doc without its required links is incomplete — do not finish a docs change
until they exist, in both directions:

- **ADR** → links every design doc/spec it shapes, and prior ADRs it builds on.
- **Design doc** → links the ADR(s) providing its rationale, the spec(s)
  pinning its contracts, and the roadmap phase that builds it.
- **Spec** → links its motivating ADR(s) and the design doc showing where it
  fits.
- **Plan** → every phase links the design docs/specs it implements; resolved
  open questions become ADRs.
- **PRD** → links the decisions, designs, specs, and plans that realize it.
- **Domain language** → links the Accepted ADR(s) that established each term;
  Accepted ADRs remain immutable and need no glossary-only backlink.

When you touch a doc, verify its links still hold (targets exist, section
anchors valid) and add the back-links on the targets. Use relative paths.

### Housekeeping

- New doc ⇒ add a line to the index in [docs/README.md](docs/README.md).
- New significant decision ⇒ new ADR *first*, then update the affected design
  docs/specs in the same change.
- Convert relative dates ("next weekend") to absolute dates in all docs.
- When domain terms change, update the canonical language during the same
  design conversation and reconcile affected code/docs or record the migration.
