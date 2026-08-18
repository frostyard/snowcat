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
- **Write or review a GitHub issue destined for the Fluent queue** →
  [.agents/skills/write-fluent-issues/SKILL.md](.agents/skills/write-fluent-issues/SKILL.md).
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
- Keep GitHub webhook ingress disabled by default until a hosting lifecycle
  explicitly mounts [`src/github/ingress.ts`](src/github/ingress.ts) with a
  lifecycle-owned control store, App ID, and host-injected secret. Never route
  webhook bytes through the Flue agent surface or log rejected source content.
- Use [`auditGitHubAppDeliveries`](src/github/delivery-api.ts) for App-wide
  delivery-list acquisition. Supply a fresh App JWT through its per-request
  provider, follow only its validated cursor links, and treat an incomplete
  result as non-authoritative. Keep shared GitHub wire constants only in
  [`src/github/api-contract.ts`](src/github/api-contract.ts).
- Use `fetchGitHubPullRequestDeliveryDetail` followed by
  `recordAuditedGitHubPullRequestDelivery` only for a supported selected
  delivery whose direct receipt is absent. The API repair creates a delivery-
  audit observation, never a reconstructed webhook receipt, and does not close
  a source gap by itself.
- Use `recordGitHubSourceCheckpoint`, `openGitHubSourceGap`, and
  `repairGitHubSourceGap` only for the fixed
  `github.pull-request-deliveries:v1` post-acquisition coverage loop. The first
  checkpoint is a point boundary; never create a gap without the latest
  checkpoint or bypass an open gap with an ordinary checkpoint.
- Use `npm run --silent control -- …` for host-local target-kernel diagnostics,
  projections, and backup/restore staging. The implementation in
  [`src/control/cli.ts`](src/control/cli.ts) never activates a restore or exposes
  generic domain mutation.
- Use `npm run --silent core -- verify` to fetch and validate the supported
  `frostyard/core` authority candidate through the bare-mirror boundary in
  [`src/core/git-source.ts`](src/core/git-source.ts). Verification is read-only
  with respect to the control plane: it never activates a Core snapshot,
  creates enrollment, or writes `FLUENT_CONTROL_DB`.
- Keep live Core Goals behind the closed verification-mechanism registry in
  [`src/core/validator.ts`](src/core/validator.ts). Goal fixtures validate
  without implementations; a live Goal fails activation until every referenced
  adapter, evaluator, or attestation policy has a real versioned registry entry.
- Register verification mechanisms only through callable implementations in
  [`src/verification/registry.ts`](src/verification/registry.ts). The current
  registry supports `conclusive-run-rate:v1` but deliberately not
  `github-required-checks:v1`; source incompleteness must never shrink an
  evaluator's evidence population. Call a check required only when an active
  observed GitHub ruleset enforces it for the exact branch and integration.
- Use `npm run --silent core -- activate <expected-control-plane-sequence>` for
  automatic Core authority mutation. After the first activation it
  verifies Git ancestry from the active source commit, then independently
  revalidates and atomically retains/activates one candidate through the typed handler in
  [`src/control/store.ts`](src/control/store.ts). The Core transaction creates
  no enrollment or work; after its eligible source check the CLI runs the
  separately typed repository reconciliation pass.
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
- Use `npm run --silent repository -- hold` and `clear-hold` only for the
  attributed local-operator repository safety decision in
  [`src/control/store.ts`](src/control/store.ts). It blocks four fixed gates,
  never expires, and cannot change Core authority or release held work.
- Use `npm run --silent core -- prune-check-history
  <expected-control-plane-sequence>` to enforce the 30-day and 10,000-item Core
  check-detail bounds. It preserves current-readiness anchors and evidence
  cited by retained decisions, then atomically rebuilds projections.
- Use `npm run --silent core -- poll` for the leased long-running
  `CoreSourceController`, `poll-once` for one due attempt, and `poll-state` for
  its read-only operational state. The healthy interval defaults to 15 minutes;
  configure only through `FLUENT_CORE_POLL_INTERVAL_SECONDS`.
- Use `npm run --silent repository -- reconcile` to resume one bounded
  declaration/identity/surface/enrollment convergence pass and `repository --
  status` for its read-only effective states. Identity match is only
  `awaiting-surfaces`; enrollment requires a valid exact-commit surface fact.
  The implementation lives in
  [`src/repository/controller.ts`](src/repository/controller.ts).
- Keep App delivery-audit scheduling in the single leased operational state
  owned by [`src/github/delivery-controller.ts`](src/github/delivery-controller.ts).
  Its completion records acquisition outcome and retry timing only; repository
  coverage still requires the separate typed checkpoint/gap commands.
- Keep GitHub content-gap closure evidence-bound. Gap schema v3 distinguishes
  `interval-coverage` from `delivery-content` independently of failure cause.
  A content gap names sorted affected delivery GUIDs;
  `github.repair-source-gap` may close it only with
  exact matching, post-gap `github.delivery-audit-observation` citations plus
  a complete interval audit. Never fabricate a webhook receipt or close from a
  digest alone.
- Use `inspectGitHubRepositoryInstallation` in
  [`src/github/installation.ts`](src/github/installation.ts) for App-JWT
  repository-access acquisition. Treat only its `active` result as a healthy
  observer installation binding; suspension, absence, overprivilege, and
  unavailability remain distinct from repository enrollment.
- Persist that result only through
  `ControlPlaneStore.recordGitHubInstallationReconciliation`. Source-backed
  outcomes retain the exact response revision; `unavailable` is a Fluent
  acquisition outcome with no invented GitHub revision. The command never
  changes repository enrollment.
- The queue store in [`src/queue/store.ts`](src/queue/store.ts) and the MCP
  contract are the v1 work engine
  ([ADR-0059](docs/adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md));
  the [recovery plan](docs/plans/recover.md) is the current delivery order
  and [docs/design/queue-operations.md](docs/design/queue-operations.md) the
  operator runbook. Change the queue schema only by appending an idempotent rung to its
  migration ladder and bumping `SCHEMA_VERSION`; never edit or reorder a rung.
  Use `npm run --silent queue -- metadata | backup <new-path> | verify-backup
  <path>` for host operations; no queue command overwrites a live database.
  Import work with `queue -- import-issues <owner/repo> --label <label>`
  (proposed roots keyed by issue URL `sourceRef`; operator approval admits
  them) and repeat `seed-dogfood` freely — its no-finding cooldown suppresses
  re-asking. `complete_work` verifies issue and pull-request artifacts against
  GitHub (refuse on mismatch, `unverified` on outage); run `queue --
  verify-artifacts` to refresh and to derive `delivery`. When
  `FLUENT_CONTROL_DB` is set, `claim_work` also requires the repository to be
  `enrolled` in the control-plane store
  ([`src/queue/eligibility.ts`](src/queue/eligibility.ts)); the hook is the
  only coupling between the two databases.
- Keep the target control-plane store separate from the queue store. It is an
  authority and observation sidecar: target schema and startup live in
  [`src/control/store.ts`](src/control/store.ts); closed vocabulary lives only
  in [`src/control/registry.ts`](src/control/registry.ts). Do not add a generic
  record or fact mutation surface, and do not add control-plane registry or
  schema versions that no recovery-plan phase consumes.
- Keep host scheduling in [`deploy/`](deploy/): three systemd timer/service
  pairs plus `deploy/bin/fluent-backup` call the existing idempotent `queue`
  and `control` commands (`seed-dogfood --enrolled`, `verify-artifacts`,
  `backup`); never add a scheduler, daemon, or MCP tool inside Fluent for
  them. `npm run check:deploy` (part of `check`; needs `shellcheck` and
  `systemd-analyze` locally) runs `systemd-analyze verify` against a stub
  root, `shellcheck` on `deploy/bin/*` and `deploy/*.sh`, and a double
  `install.sh` dry run, so a broken unit or a non-idempotent installer fails
  the PR; the operator runbook is
  [docs/design/queue-operations.md](docs/design/queue-operations.md).
- Install and upgrade the single operator host only through
  [`deploy/install.sh`](deploy/install.sh) (idempotent: directories,
  `/etc/fluent/env` from `deploy/env.example` only if absent, units plus a
  per-service drop-in with `User=`, absolute npm `ExecStart=`, and
  `ReadWritePaths=`, then enable the timers) and
  [`deploy/upgrade.sh`](deploy/upgrade.sh) (`git pull --ff-only`, `npm ci`,
  `npm run check`, restart timers, remind to restart MCP clients). Neither
  activates Core or opens a database. `/etc/fluent/env` is host state — never
  commit one — and the operator's `FLUENT_HOME` checkout is not a worker's
  checkout.
- Run `npm run check` before calling any change done. CI must run the same
  recipe, so a local pass is a CI pass.
- Tests are `*.test.ts` files anywhere under `test/`, discovered recursively by
  Node's test runner (the pattern in `package.json` is quoted so the shell
  never expands it).

## Repository boundary

`policies/agent-governance.json` is this repository's canonical
agent-governance surface under the frostyard/core repository-surfaces
contract v1; Fluent reads it (from GitHub, at the observed default-branch
head) when enrolling this repository in its own fleet. Deny by default; read,
write, and run-tests allowed; issues, pull requests, and follow-ups
review-required; workflows, GitHub-facing code, and the MCP/authorization
boundary are review-required at high risk. Change it only alongside the
matching ADR or design change.

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
