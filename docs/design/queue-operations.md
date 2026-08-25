# Operating the work queue

Living document. Rationale:
[ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md), with
the execution boundary from
[ADR-0003](../adr/0003-separate-work-coordination-from-execution.md) and
admission from
[ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md).
Contract: [work queue](../specs/work-queue.md). Architecture:
[queue execution boundary](queue-execution-boundary.md).

## Overview

This is the operator runbook for running Snowcat's v1 work engine on one host,
in the order you do it: install the host, onboard a repository, fill the queue,
admit work, run coding agents against it, watch what they produce, and keep
the database safe (upgrade, back up, restore). It
follows the [recovery plan](../plans/recover.md) and is written for the first
dogfood repository, `frostyard/updex`; every command applies to any opted-in
repository.

Snowcat never starts, sandboxes, or authenticates a worker. You start Codex,
Claude, Copilot, or another MCP-capable client yourself and tell it to work the
queue; Snowcat decides what it may claim, records what it reports, and checks
reported GitHub artifacts under its own credential.

```text
GitHub issues ──import-issues──► proposed ──approve──► queued ──claim (MCP)──► claimed
                                                                                 │
seed-dogfood ──────────────────► queued                          complete / block / release
                                                                                 │
                                                        completed (artifacts verified) → delivery
```

## Prerequisites

- A Linux host with systemd, git, Node 24 or newer (any install method; the
  installer finds `npm` on your `PATH`), and `sudo`. `npm run check` — which
  `deploy/upgrade.sh` runs — also needs `shellcheck` and `systemd-analyze`
  on the host, because `check:deploy` lints the units and scripts.
- A GitHub token for `SNOWCAT_GITHUB_TOKEN` (`gh auth token` works). Optional
  for public repositories but strongly recommended: it lifts the API rate limit
  and lets Snowcat verify artifacts on private repositories.
- **Two checkouts.** The operator's checkout (`SNOWCAT_HOME`, e.g.
  `/opt/snowcat`) is the one the timers, the CLI, and `deploy/upgrade.sh` use;
  it stays on `main` and is only ever moved by `git pull --ff-only`. A worker
  that maintains `frostyard/snowcat` itself works in a *different* clone —
  never in `SNOWCAT_HOME`. (On 2026-08-17 a worker left the operator checkout
  on a feature branch; the timers then ran that branch's code.)

State lives in `/var/lib/snowcat/{queue,control-plane}.db`, configuration in
`/etc/snowcat/env`, backups in `/var/backups/snowcat`, all created by the
installer below. Without the installer the defaults are `./data/queue.db` and
`./data/control-plane.db` relative to the process working directory. Every
command below is `npm run --silent queue -- <command>` unless it names
another script; all print JSON.

## Install the host

Run once on a clean host, and again whenever `deploy/` changes (it is
idempotent and reports what it created and what it kept):

```bash
sudo install -d -o "$USER" -g "$(id -gn)" /opt/snowcat
git clone https://github.com/frostyard/snowcat.git /opt/snowcat
cd /opt/snowcat && npm ci
sudo deploy/install.sh --user "$USER"      # dirs, /etc/snowcat/env, units, timers
app_token="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
sudo sed -i "s/^SNOWCAT_APP_TOKEN=.*/SNOWCAT_APP_TOKEN=$app_token/" /etc/snowcat/env
unset app_token
"${EDITOR:-vi}" /etc/snowcat/env            # also set SNOWCAT_GITHUB_TOKEN=<gh auth token>
set -a; . /etc/snowcat/env; set +a          # load it into this shell
npm run --silent queue -- metadata         # databasePath: /var/lib/snowcat/queue.db
systemctl list-timers 'snowcat-*'           # six timers, next run times
```

The generated `SNOWCAT_APP_TOKEN` enables local mode. After building and
starting the surface, open `/login` and enter that same value; retrieve it from
the loaded environment with `printf '%s\n' "$SNOWCAT_APP_TOKEN"`. Access mode
uses its two Access variables instead and ignores this token.

[`deploy/install.sh`](../../deploy/install.sh) creates `/var/lib/snowcat` and
`/var/backups/snowcat` (0750, owned by `--user`, default the sudo caller —
`snowcat-backup.timer` narrows the backup directory to 0700 on its first
daily run; see below);
writes `/etc/snowcat/env` (0600, same owner) from
[`deploy/env.example`](../../deploy/env.example) with `SNOWCAT_HOME` set to
the checkout and the database paths under `/var/lib/snowcat` — **only if the
file is absent**, so your token and edits survive re-runs; installs the six
units from [`deploy/systemd/`](../../deploy/systemd/) into
`/etc/systemd/system/` — six timer/service pairs plus
`snowcat-surface.service`, which is enabled but not started (start it after
`npm run build`, and it stays optional on a laptop that runs `npm run serve`
by hand) — with one drop-in per service (`10-install.conf`:
`User=`, an absolute `ExecStart=` for the `npm` the operator user's login
shell resolves — a plain login shell first, then an interactive one (Homebrew's
`brew shellenv` usually sits in `~/.bashrc` behind an "if not interactive,
return" guard), then the installer's own `PATH`, then the well-known Homebrew
prefixes; `sudo` resets `PATH`, so override with
`sudo env SNOWCAT_NPM=/path/to/npm SNOWCAT_NODE=/path/to/node deploy/install.sh`
if it still picks the wrong one — a `PATH=` that lets that npm find `node`, and
`ReadWritePaths=` for the real `SNOWCAT_HOME`) — systemd's fixed search path
does not include Homebrew, nvm, or similar, so the drop-in is what makes the
timers work on such hosts; then
`daemon-reload` and `enable --now` on the six timers. It never runs
`core -- activate` and never opens or moves a database. Set
`SNOWCAT_INSTALL_ROOT=<dir>` to dry-run it into a directory without root
(`systemctl` is skipped unless `SNOWCAT_SYSTEMCTL` names a substitute); that
is what `npm run check:deploy` does, twice, asserting the second run changes
nothing.

`/etc/snowcat/env` is the single source of the host configuration. Every
shell in which you run the CLI, and every shell from which you start a worker
client, loads it first:

```bash
set -a; . /etc/snowcat/env; set +a
```

Timers get it through `EnvironmentFile=`; nothing else does — a client
started from a shell that did not source it sees no `SNOWCAT_*` variables.

## Onboard a repository

Bringing an existing repository into the fleet touches four surfaces, in
order: a declaration in `frostyard/core`, canonical surfaces and settings on
the repository itself, Core activation and reconciliation on the host, and
the queue's own opt-in. The interactive procedure — an agent drafts every
file and prints every command below for the operator to run, then proves the
loop end to end — is core's
[frostyard-onboard-repo skill](https://github.com/frostyard/core/blob/main/.agents/skills/frostyard-onboard-repo/SKILL.md);
this section is the reference it follows. Two things are out of scope:
de-boarding (a repository leaves the fleet through a `disabled` declaration,
which is retained, never deleted) and host bootstrap (the sections above own
that). Enrollment is optional for the queue itself (repository opt-in is
enough to run) but required if you set `SNOWCAT_CONTROL_DB`, because then
`claim_work` only leases items whose repository is `enrolled` in the control
plane.

1. **Declare it in core.** In `frostyard/core`, declare the repository with
   `fleet_state: enabled` under `organization/repositories/<owner>/<name>.json`
   ([core#83](https://github.com/frostyard/core/pull/83) does this for
   updex): copy an existing declaration, set the numeric GitHub id as a
   string (`gh api repos/<owner>/<name> --jq .id`), the accountable owners,
   and the `maintenance_programs` this repository actually runs — an enabled
   declaration needs at least one program and one ceiling action. In the
   same core change, bump the declaration count in
   `test/organization-validation.test.mjs` and add the repository to
   `.github/skills-sync.json` so it receives the shared skills. Validate
   with core's `npm ci && npm run check`, and before merging:
   `npm run --silent core -- verify` after pointing `SNOWCAT_CORE_REF` at the
   branch reports the catalog, or fails with the exact reason.
2. **Give it the canonical surfaces.** In the repository, make sure the four
   canonical surfaces exist: `AGENTS.md`, `policies/agent-governance.json`,
   `.agents/skills/`, and `docs/README.md`
   ([updex#297](https://github.com/frostyard/updex/pull/297) adds the
   governance file; core's `frostyard-repo-docs` and
   `frostyard-acmm-conformance` skills scaffold the rest). The governance
   file's only per-repository content is its protected-boundary paths —
   everything else is fixed by core's schema; start from core's valid
   fixture. `.agents/skills` must be a real git tree at the default-branch
   head — the surface probe reads the tree API, where a symlink is a blob,
   and the reconcile pass refuses it.
3. **Apply the settings contract.** From a core checkout, dry-run then apply
   the repository-settings contract (ADR-0040) and the merge queue
   (ADR-0042) — these also create the `snowcat` import label the timers
   depend on:

```bash
scripts/apply-repo-settings.sh <owner/repo> --required-checks "<ctx>[,<ctx>…]"
scripts/apply-repo-settings.sh <owner/repo> --required-checks "…" --apply
scripts/rollout-merge-queue.sh <owner/repo> --apply
```

   The rollout script refuses a repository whose CI does not trigger on
   `merge_group`; that one workflow edit is part of onboarding. The apply
   script never writes a LICENSE or description — it prints `NOTE` lines for
   what stays manual.
4. **Activate and reconcile on the host.** After the core and repository
   changes merge:

```bash
npm run --silent control -- metadata            # note lastTransactionSequence
npm run --silent core -- activate <lastTransactionSequence>
npm run --silent repository -- reconcile        # reads GitHub identity and surfaces
npm run --silent repository -- status           # want "effectiveState": "enrolled"
```

   `core -- activate` runs the repository reconciliation pass itself;
   `repository -- reconcile` re-runs it and is safe to repeat — it
   converges. States other than `enrolled` name what is missing
   (`awaiting-surfaces`, `surface-held`, `disabled`, `operator-held`, …),
   and `npm run --silent core -- readiness` explains a refusal to activate.
   For a private repository, `SNOWCAT_GITHUB_TOKEN` in `/etc/snowcat/env`
   must read it (and the cure/review sweeps use GraphQL, which needs the
   token even for public repositories). To stop a repository's work without
   touching Core: `npm run --silent repository -- hold <sequence>
   github.com:<id> "<reason>"` and later `clear-hold`.
5. **Opt it into the queue and choose its gates.** Queue opt-in is separate
   from Core enrollment, and the two per-repository toggles require it
   first:

```bash
npm run --silent queue -- opt-in <owner/repo>
npm run --silent queue -- review-gate <owner/repo> on   # recommended (ADR-0065)
npm run --silent queue -- cure-foreign <owner/repo> on  # optional, off by default
```

   An enrolled repository that is not opted in is skipped by the `--enrolled`
   feeders and reported as `notOptedIn`.
6. **Prove the loop.** Onboarding is done when the engine has demonstrably
   run for this repository, not when the checklist is: seed it
   (`npm run --silent queue -- seed-dogfood --enrolled`, or wait for the
   00:15 UTC timer) and confirm discovery roots appear only for the declared
   programs; watch one item get claimed and completed
   (`npm run --silent queue -- watch --repository <owner/repo>`, or the
   `/progress` page); with the review gate on, see its draft pull request
   pass a review round and the artifact verify. Labeling one issue `snowcat`
   and watching the 15-minute import pick it up proves the issue path the
   same way.

## Fill the queue

Opt the repository into the queue if onboarding has not already (step 5
above; the command is idempotent):

```bash
npm run --silent queue -- opt-in frostyard/updex
```

If a repository is renamed on GitHub, rename its queue slug in one attributed
step after the Core declaration is renamed and activated — the opt-in and
every item move; history keeps the strings it was recorded with. The worked
example is this repository's own rename (ADR-0064), old slug first, new slug
second:

```bash
npm run --silent queue -- rename-repository frostyard/fluent frostyard/snowcat
```

**From GitHub issues** — write them per the
[`write-snowcat-issues` skill](../../.agents/skills/write-snowcat-issues/SKILL.md)
(conventional title, evidence, bounded scope, at least one acceptance
criterion observable on the PR itself), label them (any label; `snowcat` is a
good convention), then:

```bash
npm run --silent queue -- import-issues frostyard/updex --label snowcat --priority 10
```

Each open labeled issue becomes one `proposed` item of kind `issue-resolution`
whose `sourceRef` is the issue URL. Re-running is idempotent; an issue that was
imported once — even if its item was later rejected or completed — is never
imported again. Higher `--priority` claims first (ties by creation time).
Priority is operator-owned; workers cannot change it.

**Sequenced slices** — a line of the form `depends-on: <GitHub issue URL>` in
an issue body becomes a predecessor on the imported item
([ADR-0066](../adr/0066-sequence-project-slices-on-observed-predecessor-delivery.md)):
the import reads the raw body, keeps at most 20 of them, and silently ignores
anything that is not exactly one issue URL on the line — including a link to
the issue itself. The key may be written in any case; the URL may not — write
it exactly as GitHub does (`https://github.com/<owner>/<repo>/issues/<n>`), or
the line is ignored like any other malformed one. The item's instructions name the predecessors Snowcat read,
and `import-issues` reports them under `refreshedSourceRefs` when a re-import
changes them. Editing the `depends-on` lines on GitHub refreshes the edges only
while the item is still `proposed`; **once you admit it, cancel the item and
re-file the issue** (a new issue URL, since an old `sourceRef` never imports
twice) to correct its sequencing.

The label convention is **`snowcat`**: labeling an issue `snowcat` is the
queue's claim on it, and the operator host imports it for you. `snowcat-import-issues.timer`
runs `import-issues --enrolled --label snowcat` every 15 minutes for every
repository that is opted in **and** `enrolled` in the
control-plane store:

```bash
npm run --silent queue -- import-issues --enrolled --label snowcat [--priority <n>]
```

It reads the control-plane store once, runs the same import in one transaction
per repository, and prints `imported` (per repository: `fetched`, `created`,
`skippedSourceRefs`), `failed` (a repository whose GitHub listing returned 5xx
or was unavailable — reported and skipped while the others still run), and
`notOptedIn` (enrolled but not opted in). It exits non-zero only when
`SNOWCAT_CONTROL_DB` is unset or every repository failed, and it needs
`SNOWCAT_GITHUB_TOKEN` to list private repositories. Imported items stay
`proposed` until you admit them; hand-run `import-issues <owner/repo>` still
works for a repository that is opted in but not enrolled, or for a different
label.

**Internal dependency chain** — a mechanical sweep, no model, over the
enrolled repositories' Go manifests
([`src/queue/internal-dependencies.ts`](../../src/queue/internal-dependencies.ts)):

```bash
npm run --silent queue -- sweep-dependencies --enrolled      # every opted-in + enrolled repository
npm run --silent queue -- sweep-dependencies frostyard/updex # one repository
```

For each swept repository it reads the default branch head, the release tags,
the tag→branch comparison, and `go.mod`, then creates proposals only: a
**`release-needed`** root when the branch is ahead of the latest `vX.Y.Z`
tag (objective names the commit count and an svu-style suggested next
version — breaking → major unless v0, `feat` → minor, else patch; the child
prepares changelog/version references in one pull request and never tags;
`make bump` stays yours), and a **`dependency-bump`** root when the
repository requires a `github.com/frostyard/*` module at a version behind
that module's latest release (one per module and target tag; `go get
module@tag`, one pull request, nothing else bumped). A bump is never proposed
before the upstream release exists, so the chain orders itself. Bounds: at
most one non-terminal `release-needed` per repository; a `release-needed`
you rejected is not re-asked for the same tag for seven days; a repository
with no release tag is reported, not asked. `snowcat-sweep-dependencies.timer` runs the
sweep daily (00:45 UTC); it needs `SNOWCAT_GITHUB_TOKEN` for private
repositories and reports `swept`, `releaseNeeded`, `dependencyBumps`,
`skipped`, `failed`, and `notOptedIn`. If several downstream manifests require
the same frostyard upstream, Snowcat reads that upstream once; an unavailable
repository, head, tag, or comparison is recorded once in `failed` with the
concrete GitHub read error while other downstreams and proposals continue.
Like the import, `--enrolled` exits non-zero only when `SNOWCAT_CONTROL_DB` is
unset or every repository failed (`sweepFailureMessage` in the same module
decides; a partial failure is reported and exits 0).

**Repository settings conformance** — a second mechanical sweep
([`src/queue/repository-settings.ts`](../../src/queue/repository-settings.ts),
core [ADR-0040](https://github.com/frostyard/core/blob/main/docs/adr/0040-publish-the-repository-settings-contract.md)):

```bash
npm run --silent queue -- sweep-repository-settings --enrolled       # every opted-in + enrolled repository
npm run --silent queue -- sweep-repository-settings frostyard/updex  # one repository
```

It reads core's repository settings contract from the active Core snapshot
(and says so, doing nothing, if the snapshot predates it), then reads each
repository's live GitHub settings — merge hygiene, features, metadata,
Actions token permissions, security features, active rulesets on the default
branch and on `v*` tags, classic protection, labels — and creates one
**`settings-drift`** proposal per repository per distinct drift set (same
drift again: nothing; drift changed: a new proposal, reject the old one). The
proposal lists every drift as expected/observed. Snowcat never changes a
setting: you apply the contract with core's
`scripts/apply-repo-settings.sh <owner/repo>` (dry-run first; pass the
repository's required-check names) and a worker completing the item only
verifies, read-only, that the settings now match. Settings the token cannot
read (admin-only fields) are reported as `unreadable`, not drift; give the
token admin read on the fleet repositories for full coverage.
`snowcat-sweep-settings.timer` runs it weekly (Mondays 01:15 UTC).

**Standing maintenance** — the maintenance program catalog in
[`src/queue/programs.ts`](../../src/queue/programs.ts): one bounded, read-only
discovery root per program, each of which may propose one implementation
child. Each entry names its Core `maintenance_programs` id, its discovery
template, the widest child ceiling, how children enter (`proposed`), and its
own no-finding cooldown — the cadence at which a repository is asked again
after a program answered "nothing": **quality daily, CI daily, security daily,
architecture weekly, conformance weekly, triage daily, dependencies weekly,
docs weekly** (conformance and triage per
[ADR-0062](../adr/0062-retire-hive-fluent-owns-conformance.md); triage
children are proposals with at most `read, open-issue`; a dependency child is
one human-merged bump). Every discovery root's `allowedActions` is `read,
create-followup` except conformance, which also holds `run-tests` to run the
repository's own verify gate on its detached read-only checkout and report a
dirty tree (ADR-0043's gate triad). Adding a program is one catalog entry
plus its Core enum value.

```bash
npm run --silent queue -- seed-dogfood frostyard/updex                    # each program's own cooldown
npm run --silent queue -- seed-dogfood frostyard/updex --cooldown-hours 0 # ignore every cooldown
npm run --silent queue -- seed-dogfood --enrolled                         # every opted-in + enrolled repository
```

The feeder is idempotent: a program with active lineage is skipped, and one
that just completed with no finding is reported as `cooledKinds` rather than
re-asked until its cadence elapses (`--cooldown-hours <n>` overrides every
program's cadence for that run). `--enrolled` requires `SNOWCAT_CONTROL_DB` (it exits non-zero naming
the variable otherwise), reads the control-plane store once, and runs the
feeder in one transaction per repository that is both opted in and `enrolled`,
printing each repository's result plus any enrolled repository that is not
opted in (`notOptedIn`). **`--enrolled` honors the Core declaration:** each
repository is seeded only for the programs its `maintenance_programs` lists
(a repository declaring `["quality","ci"]` gets two roots, not four), and the
result names the catalog kinds it left out as `undeclaredKinds`. Explicit
`seed-dogfood <owner/repo>` seeds every program regardless — use it only for
a repository outside the enrollment gate. (Before 2026-08-18 the feeder
ignored the list: updex declared `quality, ci` and ran four programs for two
days.) `snowcat-seed-dogfood.timer` runs it daily (00:15 UTC),
followed by the labeled-issue import above (see
[Deployment](#deployment-v1-decided-2026-08-17)). These roots are admitted
immediately (they are read-only); their children are not.

**One-off** — `seed-testing-gap frostyard/updex` seeds a single read-only
testing-gap discovery.

## Admit, defer, and reject

Nothing a worker can claim exists until an operator says so, except the
read-only seeds above:

```bash
npm run --silent queue -- list proposed --repository frostyard/updex
npm run --silent queue -- show <id>                     # full item plus its event history
npm run --silent queue -- approve <id>                  # proposed → queued (claimable)
npm run --silent queue -- reject <id> "<reason>"        # proposed → cancelled
npm run --silent queue -- defer <id> "<reason>"         # queued, unclaimed → proposed again
npm run --silent queue -- prioritize <id> <n> "<reason>" # proposed/queued/blocked; higher claims first
npm run --silent queue -- note <id> "<text>"            # annotate; no state change
```

Children inherit their parent's priority, and dogfood roots seed at 0, so an
admitted implementation child queues behind every older discovery root until
you say otherwise. `prioritize` is how you say otherwise: it works on
`proposed`, `queued`, and `blocked` items (not claimed or terminal), records
`work.prioritized` with the previous and new value, and leaves a `prioritize`
note for the next worker. Approve then prioritize, or prioritize while still
proposed — either order works.

Every command above (and `requeue`/`cancel` below) accepts
`--if-updated-at <iso>`, the item's `updatedAt` as you last saw it in `list`
or `show`; if a worker or another shell moved the item since, the command
exits non-zero with `item changed since it was read: <id> is now <status>
(updated <when>)` and changes nothing, so a decision formed on a stale
listing is never applied ([spec rule 39](../specs/work-queue.md)).

Worker follow-ups land as `proposed` children with `parentId`; approve them the
same way. Their permissions can never exceed the parent's `delegableActions`.

**Every item says what it must deliver** ([spec rule 64](../specs/work-queue.md),
[ADR-0069](../adr/0069-declare-the-required-artifact-on-every-work-item.md)).
`requiredArtifact` is `pull-request` or `none`, shown as `delivers` on the
item page and in `show`. The worker that proposes a follow-up declares it;
imports, sweeps, and the cure and review gates declare it on the roots they
create. The store refuses — at proposal and again at `approve` — any item
whose actions cannot honor its contract: `pull-request` without `open-pr`,
`write` without `open-pr`, or a follow-up that may `write` but promises no
pull request. An item that must deliver a pull request completes only when
one is reported; its worker blocks instead when no change turns out to be
warranted, and cancelling is yours. Items created before the rule read as
`none` and keep behaving as they did; find the ones that can never complete
with

```bash
npm run --silent queue -- audit-contracts [--repository <owner/repo>]   # read-only; exit 1 when anything is listed
```

and clear each with the command the finding names (`reject` a proposal,
`cancel` a queued or blocked item, `note` a claimed one and cancel when the
lease ends). Nothing widens an item after the fact: re-propose or re-import
with the right contract.

Every `defer` and `requeue` reason, and every `note`, is appended to the item's
`operatorNotes` (`{ at, actor, action, reason }`) and travels with the item:
`claim_work`, `get_work`, `list_work`, `list`, and `show` all return it, so
the next worker reads what you said about earlier leases before it starts.
Use `note` when there is nothing to move — an item you are about to approve
that already has a pull request, a claimed item whose worker should know
something — and keep the note about the item's history, not its definition:
notes override nothing in the objective, instructions, or acceptance criteria
(change those by cancelling and re-importing or re-seeding). Only the operator
CLI and approved policy can write notes; workers cannot, and no MCP tool does.

**Every definition binds the policy it runs under** ([spec rule 71](../specs/work-queue.md),
[ADR-0074](../adr/0074-compile-policy-into-work-admission.md)). With
`SNOWCAT_CONTROL_DB` set, defining work reads the enrolled repository's Core
action ceiling and governance policy: denied actions and ceiling overruns
are refused on the spot, your `approve` is recorded as the decision that
satisfied the review-required acts (with the exact policy revision you
judged), and a mechanically admitted root cites the ADR that pre-authorizes
it. A pull request whose diff touches a protected boundary lands in
*Review adjudication* for you instead of being marked ready. Items from
before the rung read as `unbound-policy` in `audit-contracts` and drain on
their own.

**Every definition declares where it executes** ([spec rule 70](../specs/work-queue.md),
[ADR-0073](../adr/0073-declare-the-execution-target-on-every-work-item.md)).
`executionTarget` — `read-only`, `new-pull-request`, or
`existing-pull-request` — is declared by whoever defines the item, exactly
like `requiredArtifact`, and the store refuses a definition whose target,
actions, artifact, and pull-request binding disagree. Items defined before
the rung read as *undeclared*: still claimable, listed by `audit-contracts`,
never guessed at. An executor sets the workspace to the claimed target
before any mutation and releases or blocks when it cannot.

**A lease whose holder is gone** ([spec rule 67](../specs/work-queue.md),
[reality report finding 11](reality.md)). A worker can die — or report
success without ever calling `complete_work` — and leave its item `claimed`
until the lease lapses and someone reclaims it. Nothing releases it on its
own before then. See every current lease, lapsed first:

```bash
npm run --silent queue -- claims [--repository <owner/repo>]
```

Cross-reference the `leaseOwner` and `label` against what is actually
running (the campaign's worker records, your own sessions). When the holder
is provably gone, release the lease with an attributed reason:

```bash
npm run --silent queue -- release-lease <work-item-id> "<why the holder is gone>" [--if-updated-at <iso>]
```

The item returns to claimable `queued` immediately, the dead worker's token
is fenced (every later mutation with it fails, exactly as after an expiry
reclaim), the reason travels to the next lease as a `release-lease` note,
and the attempt closes as `released`, ended by the operator. A worker that
is merely slow is not gone: prefer waiting for the heartbeat window over
cutting a live lease, and never release an item a worker is visibly still
driving — the claim is its authorization to keep pushing.

**An item workers keep releasing** ([spec rule 69](../specs/work-queue.md),
[ADR-0072](../adr/0072-back-off-claim-selection-after-rapid-worker-releases.md)).
A release is a worker saying "not me": a contract mismatch, a missing
capability, a self-authored review. The same mismatch repeats on the next
claim, so three worker releases inside thirty minutes take the item out of
claim selection until the window slides — no status change, no event, just
not a candidate. See who declined and why:

```bash
npm run --silent queue -- churn [--repository <owner/repo>]
```

The recorded reasons are the evidence: fix what they complain about, or
`cancel`, `defer`, or re-propose the item with a contract the fleet can
honor. An operator `release-lease` and a lease expiry never count — those
evidence a gone holder, not a declined contract — and the backoff lifts by
itself, so doing nothing costs at most the window.

**A project's slices wait for each other** ([spec rules 58, 62–63](../specs/work-queue.md),
[ADR-0066](../adr/0066-sequence-project-slices-on-observed-predecessor-delivery.md)).
An imported slice may carry `predecessors` — the issue URLs of the slices it
waits for. Admit the whole plan in one sitting: admission is the plan-review
moment, and the gate, not your pacing, decides what a worker may claim next. A
slice is claimable only once every predecessor URL names a work item that is
`completed` **and** whose artifacts Snowcat observed delivered — every reported
pull request `merged`, every reported release `published`, and completion alone
where it reported neither. Anything else leaves it queued and simply not a
candidate, and the claim takes the next eligible item instead. Nothing here
reads GitHub at claim time: the observations come from `verify-artifacts`, so a
merge lands in the queue on that timer, not instantly.

```bash
npm run --silent queue -- show <id>   # `predecessors`: each edge, satisfied or the reason it is not
```

An unmet edge is not a block: the item keeps its status, its ledger, and its
place, and `show` says which predecessor is waiting and why (`no work item in
this queue carries this source reference` for one you have not imported yet).
Nothing cascades — a cancelled or abandoned predecessor leaves its successors
queued and ineligible forever, on purpose, so a dying project stays
conspicuous; cancel or refile them yourself. Two slices that name each other
are not rejected either: neither ever becomes eligible. The rest of the queue
is unaffected throughout.


## From the browser

The same queue at `http://127.0.0.1:3000/` once the operator host runs the
surface: it renders the same rows the CLI prints, and carries attributed
operator mutations besides
([design](operator-surface.md#operational-notes)):

```bash
SNOWCAT_APP_TOKEN=… SNOWCAT_QUEUE_DB=/var/lib/snowcat/queue.db \
SNOWCAT_CONTROL_DB=/var/lib/snowcat/control-plane.db \
npm run build && npm run serve        # binds 127.0.0.1:3000; HOST/PORT override
```

Sign in with the host's `SNOWCAT_APP_TOKEN`; the inbox shows what needs you —
proposals awaiting admission (children under their parent's finding), blocked
items with the worker's reason, and completed items whose issue or pull-request
artifact is still `unverified` — plus the last 30 ledger events. It reads the
same rows `list`, `show`, and `events` print, never renders a lease token, and
stays live: the page subscribes to `/events/stream` (the ledger tail as
server-sent events, identifying fields only) and, when a worker or another
shell moves an item, refetches just the affected group — the `Live · stream`
pill in the header says it is connected, `Live · reconnecting` that it is not.
Without scripts it falls back to a 30-second refresh. The repository board is
live the same way for its own repository.

Decisions happen where you see them: **Approve** / **Reject** (with a reason)
inline on each proposal, **Requeue with note** / **Cancel** on each blocked
item (the textarea is the note carried to the next lease, or the cancellation
reason), and **Re-verify** on each unverified artifact (re-checks that
repository's pending artifacts). The item page's *Decide* card offers every
action its state allows, plus **Prioritize**, **Note**, and, on a completed
item, **Attach artifact** (`attach-artifact`: a pull request, issue, or
release URL in the item's repository, checked against GitHub before it is
written). Each is a
same-origin form attributed `operator:web` that carries the item's `status`
and `updatedAt` as rendered; if a worker or another shell moved the item
first, the surface refuses with *this item changed since you read it*, shows
the current state, and changes nothing ([spec rule 40](../specs/work-queue.md)).
After a decision you land back where you were with a one-line banner naming
the event recorded (`Recorded work.approved.`), and `queue -- show` and
`events` list it exactly like a CLI decision, actor `operator:web`. There
is no batch action, but the board's *Repository actions* strip is not
CLI-only: it runs from the browser as `operator:web` too, as described below.

Five more views sit behind the same session:

- `/progress` — every live item as one lifecycle strip, grouped by repository
  and preceded by the awaiting-import, proposed, queued, working, in-review,
  awaiting-merge, and needs-attention counts. **Needs attention** is the pinned
  group at the top and collects every stop, in all three tones: a blocked
  item, a claimed item whose lease expired without a reclaim, a queued item
  whose predecessor chain loops back on itself (`predecessor cycle`), a pull
  request closed without merge, a review stuck at round three needing a human
  decision, and an artifact still `unverified` because GitHub was unavailable.
  It is what someone has to act on, so two things are deliberately absent:
  a **cancelled** item leaves the page entirely the moment it is cancelled —
  it is a terminal decision nobody acts on again, and it stays readable on
  `/events` and on its own item page — and a **completed discovery root**
  (the catalog's `*-discovery` kinds, which deliver by proposing children
  rather than by opening a pull request) reads `delivered · proposals filed`
  at the merged stage with no badge, because its proposals are already their
  own rows. Merged, published, and delivered rows age out after seven days.
   The strips are read-only except for Approve on a proposal and Requeue with
   note / Cancel on a blocked item ([design](operator-surface.md)).
   Two query parameters narrow it, both carried in the URL so the live full-page
   refresh preserves them: `?repository=<owner/repo>` filters the lanes and the
   labeled-issue observations to one repository (case-insensitive; a slug that is
   neither opted in nor declared is a 404, the same as `/events`), and `?view=active`
   swaps the repository lanes for two flat groups. **Working now** lists every
   row a worker holds a live lease on — a claimed primary or a review satellite —
   oldest first by the moment it entered that working (or review) stage, naming
   the lease owner (never the lease token), the repository, the kind, and the
   in-stage duration; with no repository filter it spans every repository.
   **Up next** lists the admitted `queued` primaries the claim gate would offer
   next — those with no unmet predecessor edge — in `claim_work`'s own order
   (priority descending, then `createdAt` ascending), capped at 20 rows with the
   cap recorded alongside the status-truncation notice. A repository tab row and
   a Lanes / Working now switch sit under the summary counts; the summary counts
   link back to the lanes view of the current repository filter.

- `/repositories` — every opted-in (and, with `SNOWCAT_CONTROL_DB`, declared)
  repository with its enrollment badge, per-status counts, and its pull
  requests summarized as `open N · decayed N · merged today N` (the link jumps
  to that repository's *Pull requests* section): the browser's
  `list --repository` at a glance.
- `/repositories/<owner>/<name>` — the board: queued work in claim order with
  its priority and a `note` tag when an operator note is carried, leased work
  with the worker identity and how much of the lease is left, and completed
  work with its `delivery` state; the header shows the enrollment state, Core
  and surface commits, and repository id from the control plane. The
  *Repository actions* strip under the header runs the CLI's repository-level
  commands as `operator:web`: **Import issues** (label, default `snowcat`, and
  optional priority — the same import as `queue -- import-issues`, so a second
  run creates nothing), **Seed dogfood** (the catalog's discovery roots for
  the programs the Core declaration lists — the whole catalog only for an
  undeclared opt-in — each with its program's cadence, which the button's
  note spells out), **Verify artifacts** (`verify-artifacts` for that
  repository), and, when `SNOWCAT_CONTROL_DB` is set and the repository is
  declared, **Hold repository** / **Clear hold** with a reason — the same
  attributed local-operator decision as `repository -- hold | clear-hold`,
  recorded against the control plane's current sequence (if it moved
  meanwhile you are asked to try again). The badge flips to `operator-held`
  and workers stop claiming until it is cleared. Each lands you back on the
  board with a banner naming what was recorded.
- The board's *Pull requests* section — under the three columns: every pull
  request the queue knows about for that repository, open ones first with
  their head SHA, when it was last verified, and the decay of the `pr-cure`
  root bound to that head, then what merged in the last seven days. Each row
  links to GitHub and to the item that reported it (and to its cure item).
  It is derived from completed items' `pull-request` artifacts and `pr-cure`
  roots — the same rows `queue -- show` prints — so it is only as fresh as
  the last `verify-artifacts` pass and never calls GitHub while the page
  renders ([design](operator-surface.md#pull-requests)).
- `/events` — the ledger as a page: `queue -- events` in the browser. Newest
  first, one row per event with its sequence, type, the item it belongs to,
  its repository, the actor, and a gist of the payload. The filter strip picks
  one repository (`?repository=<owner/repo>` — the sidebar link, the board
  header's **Events** button, and the rail's *Events* heading all land here),
  moves the window (`?since=<sequence>`; the default is the last 100 events),
  and turns on **Decisions only** (`?decisions=1`), which keeps just the
  operator decisions — `work.approved`, `work.rejected`, `work.deferred`,
  `work.requeued`, `work.cancelled`, `work.prioritized`, `work.noted`,
  `artifact.attached`, `artifact.ready` — so a week's admissions and exits
  read as one list. It reads at most 500 events per request, ascending from
  `since`; when that read stops short of the ledger's cursor the page names
  the highest sequence it reached, says the events *newer* than it are the
  ones not shown, and links onward from that sequence — use `queue -- events
  --since` for anything longer. The page is read-only: nothing on it changes
  the queue.
- `/items/<id>` — `queue -- show <id>` rendered: definition, acceptance
  criteria, result with artifacts and their verification, operator notes,
  previous results, the full event timeline, and the *Decide* card. Every
  row on the inbox and board links here.

## Run workers

Configure an MCP server named `snowcat` in the client you start. Two shapes,
both expanding `${VAR}` / `${VAR:-default}` from the shell that launched
the client (Claude Code reads `.mcp.json`; other clients have the same
fields under other names):

**Remote — the committed `.mcp.json` in this repository.** The host runs
elsewhere (the Incus instance) and the client talks Streamable HTTP to its
`/mcp` with a minted token — over the tailnet of
[A private mesh instead of Access](#a-private-mesh-instead-of-access-tailscale)
or the Access edge; the URL is the only difference. Mint the token once on
the host (`queue -- token mint member:<your email> "<client name>"`; the
browser can do it in Access mode), keep the plaintext in a private file
your login shell exports — for example
`~/.config/snowcat/mcp-token.env` holding
`export SNOWCAT_MCP_TOKEN=snowcat_…`, mode 0600 — and never in the
repository:

```json
{
  "mcpServers": {
    "snowcat": {
      "type": "http",
      "url": "${SNOWCAT_MCP_URL:-https://snowcat.goat-snake.ts.net/mcp}",
      "headers": {
        "Authorization": "Bearer ${SNOWCAT_MCP_TOKEN}"
      }
    }
  }
}
```

The worker then acts as `member:<owner>/<client>` on every event; no
database path, no GitHub token, and no host environment reach the client,
because artifact verification runs on the host.

**Local — stdio on the host itself.** For a worker on the machine that owns
the databases (a laptop still hosting, or a shell inside the instance), let
the server inherit the host configuration: `set -a; . /etc/snowcat/env;
set +a` first, then start the client with

```json
{
  "mcpServers": {
    "snowcat": {
      "type": "stdio",
      "command": "npm",
      "args": ["--prefix", "/opt/snowcat", "run", "--silent", "mcp"],
      "env": {
        "SNOWCAT_QUEUE_DB": "${SNOWCAT_QUEUE_DB:-/var/lib/snowcat/queue.db}",
        "SNOWCAT_CONTROL_DB": "${SNOWCAT_CONTROL_DB:-/var/lib/snowcat/control-plane.db}",
        "SNOWCAT_GITHUB_TOKEN": "${SNOWCAT_GITHUB_TOKEN:-}"
      }
    }
  }
}
```

Codex (`~/.codex/config.toml`) does not expand variables in values; whitelist
them for pass-through instead:

```toml
[mcp_servers.snowcat]
command = "npm"
args = ["--prefix", "/opt/snowcat", "run", "--silent", "mcp"]
env_vars = ["SNOWCAT_QUEUE_DB", "SNOWCAT_CONTROL_DB", "SNOWCAT_GITHUB_TOKEN"]
```

Other clients have equivalents; the rule is the same — the three variables
come from the launching shell, so a token never has to live in a client
config file.

A claim leases the item for 15 minutes: a client that runs several workers at
once must call `heartbeat_work` before and through any long step (tests,
builds) and complete, block, or release what it holds, or a sibling re-claims
the item and the first worker's pull request becomes an
[orphan](#review-gate).

`npm --prefix` lets the client run from any directory — typically a checkout
of the target repository — while the server code comes from the Snowcat
checkout. Start the client with whatever credentials and sandbox you want it
to have — Snowcat grants none — and ask it to work the queue. The portable
[`work-snowcat-queue` skill](../../.agents/skills/work-snowcat-queue/SKILL.md)
tells it to claim one item, do only the item's `allowedActions`, report
evidence and artifacts, and stop. The skill lives in this repository, so a
client started in another checkout needs it installed where that client looks
for skills — for Claude Code, symlink or copy
`.agents/skills/work-snowcat-queue` into `~/.claude/skills/`; other clients
have equivalent user-level skill directories. The MCP server's own
`instructions` carry the four essential rules even without the skill.

Prompts that work:

- "Work the Snowcat queue." — claims the highest-priority eligible item.
- "Work the Snowcat queue for frostyard/updex, issue-resolution items only." —
  the skill passes `repository` and `kinds` to `claim_work`.
- "Keep working the Snowcat queue until it is empty, then stop." — an explicit
  loop; the skill otherwise stops after one item.

Restart every MCP server (i.e. the client) after `deploy/upgrade.sh`: an
already-open process refuses its next write once the schema moves
([work queue](../specs/work-queue.md) rule 21). The upgrade script prints
this reminder; nothing does it for you.

## Watch the work

### Which item is this worker on?

A client that starts several workers on one token (Snowcat Cockpit, the
orchestrator loop) cannot tell them apart by `leaseOwner`: over HTTP every
lease belongs to the token's `member:<owner>/<client>` principal, and the
worker's own name is only the claim's label. `list_work` and `get_work`
therefore carry each item's **attempts** ([spec rule 66](../specs/work-queue.md)):
its newest leases (at most ten, oldest first) with the principal, the exact
label the client supplied as `worker` at claim time, and — once the lease
ended — whether it `completed`, `blocked`, `released`, or `expired`, derived
from the item's own ledger. Nothing in an attempt is a lease token, a bearer,
or worker prose; the block reason stays in `result.summary`.

To find the item a worker labelled `cockpit:worker:aaaa1111` holds, ask for
it exactly — the token's principal as `leaseOwner` and the worker's name as
`label` — and read the attempt that has no `outcome`:

```text
list_work {"status":"claimed","leaseOwner":"member:you@frostyard.org/cockpit fleet","label":"cockpit:worker:aaaa1111"}
→ [{ "id":"…", "leaseOwner":"member:you@frostyard.org/cockpit fleet",
     "attempts":[{ "sequence":3612, "claimedAt":"…", "worker":"member:you@frostyard.org/cockpit fleet",
                   "label":"cockpit:worker:aaaa1111" }] }]
```

The two filters are exact matches on the lease's current holder and on the
label the item's newest claim recorded, so the answer is the same however
many items the repository has in flight; without them, `list_work` returns
at most 100 items (`limit`, default 50) by `status`, `repository`, and
`kind`. Keep the item `id` and the attempt `sequence`. When the worker
disappears from the active list, `get_work {"id":"…"}` tells you what became
of that exact attempt — `"outcome":"completed"` (`blocked`, `released`,
`expired`) with `endedAt` and `endedBy` — even after another worker has
reclaimed the item, because the old attempt stays beside the new one. Match
by `sequence`, never by position or time. A lease that lapsed reads as
`expired` at its own `leaseExpiresAt` the moment it lapses, whether or not
anyone has reclaimed the item yet; a live lease is the only attempt without
an outcome. Each item carries at most ten attempts, so a long-lived item's
oldest leases fall out of the projection (the `events` command still has
them).

A label is one printable line of at most 120 characters — it is published
here, so it is bounded like one — and a claim whose label contains a live
lease token is refused outright. A label is provenance, not authority (rule
48): a client naming someone else's label gains nothing, and an
observation-only token ([an observation-only client](#an-observation-only-client))
is the right credential for this read.

Tail the event ledger instead of looping over `show`. Every claim, lease
renewal, completion, proposal, block, release, operator decision, and artifact
verification is one event with a global, monotonic `sequence`:

```bash
npm run --silent queue -- watch                                 # one JSON line per new event, until Ctrl-C
npm run --silent queue -- watch --repository frostyard/updex --interval 5
npm run --silent queue -- events --since 0 --limit 500          # replay from the start (or any sequence)
npm run --silent queue -- events --repository frostyard/updex   # first/oldest 100 after sequence 0, ascending by sequence
npm run --silent queue -- show <id>                             # one item in full: result, artifacts, verification, events
```

`watch [--repository <owner/repo>] [--interval <seconds>]` starts at the
current last sequence, polls `eventsSince` every 10 seconds by default (a value
of 1 is raised to the 2-second minimum; 0 or a negative value is rejected with
`interval must be at least 1 second`), and prints each new event as one JSON line
on stdout; its startup line on stderr names the starting sequence. Stop it with
Ctrl-C or SIGTERM. `events [--since <sequence>] [--repository <owner/repo>]
[--limit <1-500>]` prints the events strictly after `--since` (default 0),
oldest first, so `metadata`'s `lastEventSequence` or the last printed
`sequence` is the cursor for the next call. Each event carries its item's
`repository`, `kind`, `sourceRef`, and *current* `status` alongside the event
`type`, `actor`, `payload`, and `occurredAt`. Both are read-only and are not
MCP tools; lease tokens never appear in any event or listing.

For a snapshot by status, `list` still answers:

```bash
npm run --silent queue -- list claimed                          # what is leased right now
npm run --silent queue -- list blocked                          # needs you
npm run --silent queue -- list completed --repository frostyard/updex --limit 100
npm run --silent queue -- list --kind issue-resolution          # any status, one kind
```

Filters: `list [status] [--repository <owner/repo>] [--kind <kind>]
[--limit <1-100>]`. Statuses: `proposed`, `queued`, `claimed`, `completed`,
`blocked`, `cancelled`.

Every completed item shows `delivery`: `none` (no pull request reported),
`unverified` (GitHub could not be asked at completion time), `open`, `closed`,
or `merged`. When a worker completes an item citing an issue or pull request,
Snowcat has already checked it exists in that repository; a wrong URL is refused
and the worker is told to fix it. To refresh state after review and merges:

```bash
npm run --silent queue -- verify-artifacts --repository frostyard/updex
```

`snowcat-verify.timer` runs this every 2 minutes with the default limit of 100
pending completed items. The limit bounds completed items that still have a
non-terminal artifact (missing, `unverified`, or `open`), newest first, so a
repository with hundreds of already-merged completions never pushes a fresh
one out of the pass. It
records `artifact.verified` events and leaves anything alone while GitHub is
unavailable.

**Undelivered work waits on a human** ([spec rule 68](../specs/work-queue.md),
[reality report finding 17](reality.md)). The review gate's last automated
act is marking a draft ready; nothing merges. A completed item whose
`delivery` still reads `open` is work somebody finished that nobody
delivered. See what is sitting, ready rows first:

```bash
npm run --silent queue -- deliveries [--repository <owner/repo>]
```

`ready: true` rows are waiting on you: an open non-draft pull request (the
gate passed it, or the repository is not gated) or a draft release whose tag
is unpublished. Draft pull requests in a gated repository are still the
gate's, not yours. From the browser, the inbox's **Ready to merge** rail
([#251](https://github.com/frostyard/snowcat/issues/251)) is the same rows
across every opted-in repository at once — a passed draft to mark ready, an
open non-draft to add to the merge queue — so you rarely need `deliveries` or
a repository board just to find what is sitting.

Every frostyard repository merges through a **merge queue** (core ADR-0042;
CI re-runs on `merge_group` against the queue tip). `gh pr merge` does NOT
work — it calls the auto-merge API, which the contract disables. Enqueue
with GraphQL instead:

```bash
n=<pull request number>
id=$(gh api graphql -f query="{repository(owner:\"frostyard\",name:\"<repo>\"){pullRequest(number:$n){id}}}" --jq .data.repository.pullRequest.id)
gh api graphql -f query="mutation{enqueuePullRequest(input:{pullRequestId:\"$id\"}){mergeQueueEntry{position state}}}"
```

GitHub rebuilds the entry on the queue tip, runs the required checks, and
merges; no update-branch is needed. The merge lands back in the queue's
`delivery` on `snowcat-verify.timer`'s next pass (at most 2 minutes), which
is also what releases any successor slice waiting on it. Publishing a draft
release (`gh release edit <tag> --draft=false`) is the same shape for
`release-needed` work. Snowcat itself never merges or publishes — this is
deliberately the operator's last mile.

**Pull-request cure** ([ADR-0061](../adr/0061-cure-pull-requests-as-bounded-per-head-work.md)).
The same pass then looks at every open pull request a completed item reported
— its `mergeable_state`, the check runs on its head, its reviews, its review
threads (read through GraphQL, so `SNOWCAT_GITHUB_TOKEN` must be set), its
title, and the identity of its patch — and, for each head that has *decayed*
(`dirty` or `behind`, a failing check, a reviewer's latest review requesting
changes, a review thread that is neither resolved nor outdated — decay
`unresolved-threads`, or a title that fails the repository's Conventional
Commits title lint — decay `bad-title`, `scripts/check-pr-title.mjs`),
enqueues one **admitted** root of kind `pr-cure` keyed
by `<pull-request URL>@<head SHA>`. The output's `cure` section lists
`enqueued`, `healthy`, `skipped` (same head already known, draft, closed,
patch identity uncomputable), `unavailable`, and `notes` — when GraphQL could
not answer, the thread signal is left out for that pull request and a note
says why; the REST signals still decide. A cure item tells the worker to do
only a *mechanical* cure — rebase or merge the base when it resolves cleanly,
retitle for the title lint, re-run checks, reply to review threads or resolve
one a later commit already addressed (a thread asking for a code change
becomes the `pr-cure-change` proposal) — and Snowcat enforces that on
`complete_work` by recomputing the pull request's
patch identity (its added and removed lines per file, so a clean rebase keeps
it): a changed patch is refused and the item stays claimed. When curing needs
a code change the worker proposes one `pr-cure-change` child for you to admit,
or blocks. The same head is never enqueued twice; a push is a new head. Cure
never merges, approves, or dismisses — those stay yours. `--no-cure` runs the
refresh alone; the board's **Verify artifacts** button runs both and reports
`N cure items queued`. Pull requests no Snowcat item reported are not cured
unless the repository opts in (next paragraph).

**Foreign pull requests.** Dependabot, other tools, and people open pull
requests Snowcat never reported, and on updex those routinely sit `behind` or
`dirty` until someone notices. Per repository, opt in with
`npm run queue -- cure-foreign <owner/repo> on` (`off` to stop; the
repository must already be opted in, and the flag is off by default). With
it on, the same pass also lists the repository's open pull requests from
GitHub (up to 300; more is reported as skipped), drops drafts and anything a
completed item already reported, and inspects the rest through the same
decay read: one `pr-cure` root per decayed head, priority 0, no originating
item, and an extra instruction telling the worker the pull request was not
opened by a Snowcat worker so it reads the description first. The `cure`
output's `foreign` counter shows how many were `listed` and `inspected`.

### Review gate

**Review gate** ([ADR-0065](../adr/0065-gate-worker-pull-requests-behind-bounded-review.md),
implementing [ADR-0029](../adr/0029-bound-adversarial-review.md)'s
pull-request profile). Off by default; per repository:

```bash
npm run --silent queue -- review-gate frostyard/snowcat on    # off to stop; the repository must be opted in
```

With it on, a worker must open its pull request as a **draft**
(`gh pr create --draft`); `complete_work` refuses an open, non-draft pull
request in a gated repository and tells the worker to `gh pr ready --undo`
and complete again (merged and closed pull requests, `pr-cure` and
`pr-cure-change` items, a pull request the gate already released — one
with a passed round — and anything GitHub could not verify are left alone). The same `verify-artifacts`
pass that refreshes and cures then runs the review sweep over every draft a
completed item reported there — reading nothing at all when no repository is
gated — and, per draft head:

- **No round has judged this head yet** → one admitted root of kind
  `pr-review`, keyed `pr-review:<url>@<head SHA>`, `read` and `run-tests`
  only, nothing delegable, the origin item's priority. The reviewer reads the
  origin item (`get_work`: objective, acceptance criteria, the issue), the
  diff at exactly that head, runs the repository's checks locally, and
  completes with `review: { decision: pass | block | unable-to-review,
  blockers ≤ 5, advisories ≤ 3 }` — a blocker only for a concrete defect, an
  unmet acceptance criterion, out-of-scope behaviour, false evidence, missing
  validation, or a contract break; never style. It touches nothing on GitHub.
  Rounds are counted **per pull request URL**: the item says "round 2 of 3"
  and carries the previous round's blockers, and a push never resets the
  count.
- **The latest round `pass`ed this head** → with `SNOWCAT_REVIEW_GATE_WRITES=1`
  in `/etc/snowcat/env`, the sweep marks the pull request ready for review
  (GraphQL `markPullRequestReadyForReview`, as `policy:review-gate`; the token
  then needs pull-requests write), re-reads the head, converts the pull
  request back to a draft if a push landed in between (reported as
  `needsHuman`), and otherwise records `artifact.ready` on the origin item —
  Snowcat's only GitHub writes. Without the variable it reports
  `readyToMark` and the board and inbox say "passed review — `gh pr ready N`";
  you mark it. Either way the pull request then leaves the draft quiet zone
  and cure, Copilot, and you take over.
- **The latest round `block`ed this head, round 1 or 2** → one admitted root
  of kind `pr-review-fix`, keyed `pr-review-fix:<url>@<head SHA>`, with
  `read, write, run-tests, open-pr` and nothing delegable, carrying exactly
  the fingerprinted **tree** blockers: address those, push, keep it a draft,
  report the pull request. Its push is a new head and the next round. A
  `contract:pr-body:` **description blocker** never enters a fix
  ([ADR-0067](../adr/0067-adjudicate-description-blockers-by-a-human.md)):
  it lands in the **Review adjudication** group for you, and only an edit
  you make to the pull request's body cures it.
- **The latest round blocked only on description blockers a prior round
  already sent you** → the tree is done and nothing remains the gate may act
  on: the pass consequence applies instead (ready, or `readyToMark`), the
  round still counts, and the blockers stay listed in *Review adjudication*
  until you edit the body
  ([ADR-0071](../adr/0071-pass-the-tree-when-only-adjudicated-description-blockers-remain.md)).
- **Blocked at round 3, `unable-to-review`, or a fix that completed without
  a new head** → nothing is created; the output's `needsHuman` names the
  reason and the inbox's **Review adjudication** group lists the pull request
  (beside the `readyToMark` ones). You decide: push a fix, edit the body,
  `gh pr ready`, `note` or `requeue` the item, or close the pull request.

**Orphan pull requests.** The gate only ever sees a pull request an item
reported, so one can escape it: a worker opens its draft, then its lease
expires (or the process dies) before it completes, and the sibling that
re-claims the item reports something else — or nothing. The draft stays open
with no item behind it: never reviewed, never marked ready, invisible to the
board. That is an **unreported** pull request, and after the round pass the
sweep lists each gated repository's open pull requests once and reports every
one the queue cannot account for — no completed item's artifact, no
`pr-review`, `pr-review-fix`, or `pr-cure` binding — as `unreported` in the
`verify-artifacts` output. It creates nothing for them: an orphan is yours to
decide. The finding is stored per repository (overwritten each pass, the empty
list included), so the board's pull-request section shows an **Unreported**
sub-list and the inbox's *Review adjudication* group lists each one with the
time it was observed, both without calling GitHub. Two remedies:

A pull request younger than the longest possible lease is listed as
`unreportedPending`, not unreported.

- the pull request is a duplicate or unwanted → close it on GitHub; the next
  pass drops it from the list;
- the work is real → `attach-artifact` it to the item that should have
  reported it (below). It then becomes an ordinary candidate and the next pass
  opens a review round for it.

Prevention is the lease: the default is 15 minutes and a worker must
`heartbeat_work` through anything longer, or a sibling re-claims the item
under it. A fleet client that does not heartbeat will produce orphans.

The sweep never merges, approves, or dismisses.

**Merging a batch.** Since 2026-08-19 every enrolled repository's default
branch has a **merge queue** (core ADR-0042, applied with core's
`scripts/rollout-merge-queue.sh`; each repository's CI runs on `merge_group`):
enqueue each gate-released pull request and GitHub rebuilds it on the queue
tip, runs the required checks there, and merges in order — no update-branch,
no waiting between merges, and strict up-to-date checks are still what lands.
Enqueue with the **Merge when ready** button, or from a shell with the same
mutation it uses:

```bash
id=$(gh api graphql -f query='{ repository(owner:"frostyard", name:"<repo>") { pullRequest(number:<n>) { id } } }' --jq .data.repository.pullRequest.id)
gh api graphql -f query="mutation { enqueuePullRequest(input:{pullRequestId:\"$id\"}) { mergeQueueEntry { position state } } }"
```

`gh pr merge` does **not** work here: on a queue-protected branch it calls the
auto-merge API, and the contract keeps `allow_auto_merge` off. Pull requests
you have not enqueued still decay like before, and the cure sweep (every 2
minutes) keeps updating `behind` heads mechanically; a pull request in the
queue is GitHub's to rebuild. Because
drafts are never cured, Copilot's automatic review skips drafts unless a
ruleset opts in, and the fleet's review-apply workflows run only on
non-drafts, review/fix and cure never act on one pull request at the same
time. `--no-review` skips the step; the board's **Verify artifacts** button
runs it and reports `N review items queued, N marked ready`; `show <id>` prints an item's
`review` record (head, round, verdict, fingerprints, the models the author
and reviewer reported). Model names are what workers report as
`result.model` — provenance, not proof; the orchestrator uses
`review.authorModel` to pick a different model for the reviewer. Make the
reviewer's *credential* enforce its half of that separation too: mint it a
token that may claim only `pr-review` — see the
[review-only client](#a-review-only-client) recipe.

When you carried a change the last mile yourself — a follow-up whose proposal
said "leave the change on a local branch; do not open a pull request", so the
worker completed it with no artifacts and you opened the pull request by
hand — the item's `delivery` reads `none` for work that shipped. Record the
pull request (or an issue) against the completed item with:

```bash
npm run --silent queue -- attach-artifact <id> https://github.com/frostyard/updex/pull/326 --description "opened by the operator from the local branch"
```

Snowcat checks the URL against GitHub first exactly as it checks a worker's
report: another repository, a wrong number, or a missing pull request is
refused and nothing is written; a GitHub outage attaches it `unverified` and
the next `verify-artifacts` pass promotes it. The kind follows the URL path
(`/pull/` or `/issues/`; `--kind` overrides), the same URL is attached only
once, only `completed` items accept one, and the item's ledger gains one
`artifact.attached` event. Add `--if-updated-at <iso>` to refuse the attach if
the item moved since you read it. The item page's *Decide* card offers the
same form. Workers never attach: `complete_work` is their only way to report,
and this command is not an MCP tool.

**Releases are the same shape** ([spec rules 59–60](../specs/work-queue.md),
[ADR-0066](../adr/0066-sequence-project-slices-on-observed-predecessor-delivery.md)):
a release slice's worker prepares the release and reports
`https://github.com/<owner>/<repo>/releases/tag/<tag>` as a `release`
artifact — or you attach it with the same `attach-artifact` command once you
have the tag — **you** publish it on GitHub, and the next `verify-artifacts`
pass observes the draft become `published`, at which point the item's
`delivery` reads `published` instead of `open`. Snowcat only reads: it never
publishes, tags, or merges anything, and there is no `release` allowed action
for a worker to hold.

**Blocked items** need an operator exit:

```bash
npm run --silent queue -- show <id>                 # read result.summary: why the worker stopped
npm run --silent queue -- requeue <id> "<reason>"   # back to queued, same definition
npm run --silent queue -- cancel <id> "<reason>"    # terminal
```

Write the requeue reason for the next worker, not for yourself: it becomes a
`requeue` entry in `operatorNotes`, and the block reason it clears is kept as
the last entry of `previousResults`, so the next lease sees both ("first lease
blocked: completion refused; operator: PR #5 already exists — re-report it, no
code change needed"). Nothing about earlier leases is erased by a requeue.

A lease that expires (worker died) is not moved anywhere: the item stays
`claimed` with its stale `leaseOwner` until the next claim re-leases it and
records `lease.expired`. Nothing is lost, and nothing is retried behind your
back.

## Deployment (v1, decided 2026-08-17)

Snowcat v1 runs on **one operator host** and stays there deliberately:

- The checkout and `/var/lib/snowcat/{queue,control-plane}.db` live on one
  machine — preferably a dedicated one, see
  [The host as an Incus instance](#the-host-as-an-incus-instance) — and every
  worker client either shares that machine (stdio MCP) or reaches its `/mcp`
  through the edge of ADR-0063 with a minted token.
- Credentials, local mode: the shell that starts a client,
  `SNOWCAT_GITHUB_TOKEN`, and `SNOWCAT_APP_TOKEN` for the operator surface;
  worker identity is self-declared and trusted only as provenance
  ([queue execution boundary](queue-execution-boundary.md)).
- Anything with a listener — the operator surface, the Flue app, `/mcp` —
  binds to loopback. It is reached either over SSH / a private mesh (local
  mode) or, per
  [ADR-0063](../adr/0063-authenticate-people-through-cloudflare-access-and-mint-mcp-tokens.md),
  through a **Cloudflare Tunnel behind Cloudflare Access** — see
  [People and workers from anywhere](#people-and-workers-from-anywhere-adr-0063)
  below — or, the simpler choice for a small organization, over a
  **private mesh in local mode** — see
  [A private mesh instead of Access](#a-private-mesh-instead-of-access-tailscale).
- The feeders, `verify-artifacts`, and `backup` run from six systemd timers
  on the host, one per command so each cadence is adjusted on its own,
  shipped in [`deploy/systemd/`](../../deploy/systemd/) and linted by
  `npm run check:deploy`:

  | Timer | Cadence | Runs |
  | --- | --- | --- |
  | `snowcat-seed-dogfood.timer` | daily, 00:15 UTC (`OnCalendar=*-*-* 00:15:00`, `RandomizedDelaySec=300`, `Persistent=true`) | `queue -- seed-dogfood --enrolled` — each program still re-asks at its own cadence ([`src/queue/programs.ts`](../../src/queue/programs.ts)) |
  | `snowcat-import-issues.timer` | every 15 minutes (`OnCalendar=*:0/15`, `RandomizedDelaySec=60`) | `queue -- import-issues --enrolled --label snowcat` |
  | `snowcat-sweep-dependencies.timer` | daily, 00:45 UTC (`OnCalendar=*-*-* 00:45:00`, `RandomizedDelaySec=300`, `Persistent=true`) | `queue -- sweep-dependencies --enrolled` |
  | `snowcat-sweep-settings.timer` | weekly, Mondays 01:15 UTC (`OnCalendar=Mon *-*-* 01:15:00`, `RandomizedDelaySec=300`, `Persistent=true`) | `queue -- sweep-repository-settings --enrolled` |
  | `snowcat-verify.timer` | every 2 minutes (`OnCalendar=*:0/2`) | `queue -- verify-artifacts` (default limit; includes the pull-request cure sweep and the review gate) |
  | `snowcat-backup.timer` | daily (`OnCalendar=daily`, `Persistent=true`) | [`deploy/bin/snowcat-backup`](../../deploy/bin/snowcat-backup) |

  The four feeders are independent: one failing no longer skips the others
  (the combined `snowcat-feed` unit that chained them is retired; the
  installer removes it). Change a cadence fleet-wide by editing the timer in
  `deploy/systemd/` and re-running `deploy/install.sh`; a host-only override
  is a drop-in (`systemctl edit <timer>`), which upgrades preserve.

  Each service is `Type=oneshot`, reads `EnvironmentFile=/etc/snowcat/env`
  (`SNOWCAT_HOME`, `SNOWCAT_QUEUE_DB`, `SNOWCAT_CONTROL_DB`,
  `SNOWCAT_GITHUB_TOKEN`, `SNOWCAT_BACKUP_RETAIN_DAYS`), and runs
  `npm --prefix ${SNOWCAT_HOME} run --silent …` with `NoNewPrivileges=yes`,
  `PrivateTmp=yes`, and `ProtectSystem=strict`, writable only under
  `/var/lib/snowcat`, `/var/backups/snowcat` (backup only), and the checkout's
  `data/`. [`deploy/install.sh`](../../deploy/install.sh) installs them and
  writes the per-service drop-in (`User=`, absolute `ExecStart=`, `PATH=`,
  `ReadWritePaths=` for the real `SNOWCAT_HOME`) — see
  [Install the host](#install-the-host). Until it has run, run the
  commands by hand as above.
- The timers do not reach worker clients: a stdio MCP client still gets its
  environment from the shell that launches it (`.mcp.json` `env` or the
  operator's login shell), never from `/etc/snowcat/env`, because systemd's
  `EnvironmentFile=` applies only to the units it starts — one of which is
  `snowcat-surface.service`, so `/mcp` *does* run with the host environment.

### People and workers from anywhere (ADR-0063)

Snowcat writes no login page and holds no OAuth client. People authenticate
at the edge; workers hold Snowcat-minted tokens; every event says who.

**Two modes, chosen by the environment.**

| | Local mode (default) | Access mode |
| --- | --- | --- |
| Turned on by | `SNOWCAT_APP_TOKEN` | `SNOWCAT_ACCESS_TEAM_DOMAIN` + `SNOWCAT_ACCESS_AUD` (both; `SNOWCAT_APP_TOKEN` is ignored) |
| Surface session | token login → cookie | a verified `Cf-Access-Jwt-Assertion` (or `CF_Authorization` cookie); no login page, `/logout` sends you to Access's logout |
| Actor on every decision | `operator:web` | `member:<email>` (the email in the assertion) |
| Unauthenticated request | redirect to `/login` | `401` with a note that the surface is reachable only through the Access hostname |
| MCP | stdio (`npm run mcp`), self-declared worker identity | `/mcp` over Streamable HTTP with a minted bearer token; the worker acts as `member:<owner>/<client>` and the payload's `worker` is only a label. Stdio still works locally. |

For local mode, generate and persist `SNOWCAT_APP_TOKEN` during
[host installation](#install-the-host), source `/etc/snowcat/env`, then enter
that value on `/login`. Without either that token or both Access variables, the
surface deliberately returns 503.

**Minted MCP tokens.** Sign in, open *MCP tokens* (sidebar), mint one per
client (name it: "codex on the laptop"); the plaintext appears once — put it in
the client's configuration as `Authorization: Bearer snowcat_…` against
`https://<host>/mcp`. Revoke from the same page (a member their own; the CLI
any: `queue -- token list | revoke <id>`; `token mint member:<email> "<client>"`
mints from the CLI in local mode). Snowcat stores only the token's hash; the
page shows when each was last used.

**Setting up the edge (once, operator).**

1. Cloudflare Zero Trust → Access → *Applications* → add a self-hosted
   application for the surface hostname (say `snowcat.frostyard.org`).
   Identity provider: GitHub. Policy: *Allow* — GitHub organization
   `frostyard`. Copy the application's **Audience (AUD) tag**.
2. Add a second self-hosted application for `snowcat.frostyard.org/mcp*` with a
   *Bypass* policy for everyone: `/mcp` authenticates with the minted token,
   not with Access, so MCP clients need only the bearer header.
3. Create a Tunnel (`cloudflared tunnel create snowcat`), route the hostname
   to `http://127.0.0.1:3100`, and run `cloudflared` as a service on the host
   (its credential is a secret like any other; rotate it if it leaks).
4. In `/etc/snowcat/env` add
   `SNOWCAT_ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com` and
   `SNOWCAT_ACCESS_AUD=<the tag>`; restart the surface (`npm run serve` with
   that environment). From then on `SNOWCAT_APP_TOKEN` is unused.
5. Verify: an incognito visit to the hostname is challenged by Access and,
   after GitHub sign-in, lands on the inbox with `member:<your email>` in the
   sidebar; `curl -i https://<host>/` from outside answers 401 from Snowcat
   only if Access is misconfigured (it should be Access's own 302).

Access verification is `RS256` against the team's published keys
(`/cdn-cgi/access/certs`, cached ten minutes, refreshed once on an unknown
key), issuer = the team domain, audience = the tag, expiry honored. Nothing
that fails to verify falls back to the token session: the two modes never
mix on one host.

#### A review-only client

A reviewer that can only review is a property of its credential, not of its
brief. Mint the token with `--kinds` and the client may claim nothing else,
however it calls `claim_work`:

```bash
npm run --silent queue -- token mint member:you@frostyard.org "codex reviewer" --kinds pr-review
# {"token":"snowcat_…","id":"…","owner":"member:you@frostyard.org",
#  "client":"codex reviewer","kinds":["pr-review"],"createdAt":"…", "note":"The token is shown once; …"}
```

Give the plaintext to that client and nothing else changes in its MCP
configuration — the same bearer header as any other token:

```json
{ "mcpServers": { "snowcat": {
  "type": "http", "url": "https://snowcat.frostyard.org/mcp",
  "headers": { "Authorization": "Bearer snowcat_…" } } } }
```

What the client then sees:

| It calls | It gets |
| --- | --- |
| `claim_work {"worker":"codex:reviewer:1"}` (no `kinds`) | the next queued `pr-review` item — or `null` when none is queued, even if `issue-resolution` work is waiting |
| `claim_work {"worker":"…","kinds":["pr-review"]}` | the same item; the filter and the token agree |
| `claim_work {"worker":"…","kinds":["issue-resolution"]}` | `null` — the intersection is empty. Never an error, never widened |
| `heartbeat_work`, `complete_work`, `block_work`, `release_work` | unaffected: a restricted client still finishes whatever it already holds |

#### An observation-only client

A client that may only *look* — a dashboard, Snowcat Cockpit taking a
snapshot to plan a fleet — is also a property of its credential
([ADR-0070](../adr/0070-grant-mcp-tokens-a-server-enforced-tool-scope.md)).
Mint the token with a **tool grant** and the server registers only those
tools for it: nothing it sends can claim, renew, complete, block, or
release, and it never receives a lease token. Do not rely on a claim
restriction to a never-seeded kind for this — that guards one tool by
accident and fails open the day someone seeds the kind.

```bash
# Mint (the observer profile is get_work + list_work; --tools lists an explicit grant instead):
npm run --silent queue -- token mint member:you@frostyard.org "cockpit observer" --profile observer
# {"token":"snowcat_…","id":"1566fd…","owner":"member:you@frostyard.org","client":"cockpit observer",
#  "kinds":"unrestricted","tools":["get_work","list_work"],"createdAt":"…","note":"The token is shown once; …"}

# Inspect: the grant is in the inventory, the hash and the bearer never are.
npm run --silent queue -- token list member:you@frostyard.org
# [{"id":"1566fd…","owner":"member:you@frostyard.org","client":"cockpit observer",
#   "createdAt":"…","kinds":"unrestricted","tools":["get_work","list_work"]}]

# Revoke when the client is retired; the token verifies as absent at once.
npm run --silent queue -- token revoke 1566fd…
```

The client's MCP configuration is the same bearer header as any other token.
What it then sees:

| It calls | It gets |
| --- | --- |
| `tools/list` | `get_work` and `list_work` only |
| `list_work {"repository":"frostyard/example","status":"claimed"}` | the bookkeeping, `leaseOwner` included, never a `leaseToken` |
| `get_work {"id":"…"}` | the item, never a `leaseToken` |
| `claim_work`, `heartbeat_work`, `complete_work`, `block_work`, `release_work` — any arguments | a protocol error (`unknown tool`); no handler ran, no item changed, no event was written |

A grant that does include `claim_work` (say a worker that claims, works, and
releases but must never complete on its own) is recorded on each lease as
`toolsGrant` in the `work.claimed` payload, beside `kindsRestriction`, so
`events` says what authority the lease was taken under. The same grant shape
works locally: `SNOWCAT_MCP_TOOLS=list_work,get_work npm run mcp` serves a
stdio server with only those tools.

The ledger says so too: a claim bounded this way carries
`kindsRestriction: ["pr-review"]` in its `work.claimed` payload, so
`show <id>` and `events` show that the token, not only the request, chose the
kind.

The stdio equivalent, for a client on the host itself, is an environment
variable on the client's own process — `npm run mcp` reads it at startup and
refuses to start on a malformed kind:

```json
{ "mcpServers": { "snowcat": {
  "command": "npm", "args": ["run", "--silent", "mcp"],
  "cwd": "/opt/snowcat",
  "env": { "SNOWCAT_QUEUE_DB": "/var/lib/snowcat/queue.db", "SNOWCAT_MCP_KINDS": "pr-review" } } } }
```

See and revoke restricted tokens exactly like any other — `token list` prints
each token's `kinds` (or `unrestricted`), and the *MCP tokens* page has a **may
claim** column:

```bash
npm run --silent queue -- token list                      # every token: client, owner, kinds, last use
npm run --silent queue -- token revoke <id>               # idempotent; the token verifies as absent at once
```

Existing tokens are unrestricted and behave exactly as before; a restriction
can only narrow, never widen, and is fixed at mint time — to change it, revoke
and mint again. Give a review-only token to a **different client and model**
than the authors run: [ADR-0029](../adr/0029-bound-adversarial-review.md)'s
reviewer-independence is strongest when the reviewer shares neither the
author's session nor its model, and the token makes the first half of that
enforceable.

### A private mesh instead of Access (Tailscale)

Everything above is optional. If the organization is a handful of people who
all belong on the same private network anyway, skip the tunnel, the Access
applications, and GitHub OAuth entirely: put the host on a mesh, keep the
surface in **local mode**, and let `/mcp` ride the same address. What you
give up is only the `member:<email>` actor on surface decisions (they read
`operator:web`; workers are still `member:<owner>/<client>` through their
minted tokens, so attribution of *work* is unchanged) and browser minting
(the tokens page mints only for a signed-in member; the CLI does it in local
mode). What you avoid is every step of the previous section. Access mode
stays available — same code, two environment lines — if that trade ever
flips.

With Tailscale (installed by the Incus profile; any mesh that gives the host
a private address works the same way, minus the `serve` convenience):

```bash
incus exec <remote>:snowcat -- tailscale up --ssh=false      # prints a login URL once; approve the node in the admin console
incus exec <remote>:snowcat -- tailscale serve --bg 3100     # https://snowcat.<tailnet>.ts.net → 127.0.0.1:3100, tailnet only
incus exec <remote>:snowcat -- tailscale serve status
```

`tailscale serve` needs **MagicDNS** and **HTTPS certificates** enabled once
for the tailnet (admin console → DNS); it terminates TLS with a real
certificate for the node's name and forwards to loopback, so the surface
still binds nothing but `127.0.0.1` and reaches nobody outside the tailnet.
Never use `tailscale funnel` here — that is the public internet again,
without Access in front. Sign-in is the shared `SNOWCAT_APP_TOKEN` from
`/etc/snowcat/env` (`incus exec <remote>:snowcat -- grep APP_TOKEN
/etc/snowcat/env`); mint worker tokens with
`queue -- token mint member:<email> "<client>"` on the host and hand each
client `https://snowcat.<tailnet>.ts.net/mcp` plus its bearer. Members and
their workers join the tailnet on their own machines; a member's laptop off
the mesh sees nothing, which is the whole access policy.

Access control here is the tailnet's membership and ACLs, not Snowcat's:
Snowcat only knows the shared token (surface) and minted tokens (`/mcp`),
exactly as on a laptop. Restrict the node with a Tailscale ACL if the
tailnet carries more than the organization; the default "everyone in the
tailnet reaches everything" is fine for three people who trust each other.

**Upgrade.** In the operator checkout, as the operator user:

```bash
cd /opt/snowcat && deploy/upgrade.sh
```

[`deploy/upgrade.sh`](../../deploy/upgrade.sh) refuses a dirty checkout, then
`git pull --ff-only` — and if that pull changed `upgrade.sh` itself, re-runs
the new version once so every later step is the new commit's — `npm ci`,
`npm run check`, `systemctl daemon-reload`,
and restarts the six timers (via `sudo` when not root; `SNOWCAT_SYSTEMCTL`
overrides); `make ci` runs the same recipe as `npm run check` here (core
ADR-0044). If `check` fails it exits non-zero, does not restart the timers,
and leaves the checkout on the new commit for inspection — roll back with
`git checkout <previous>` and re-run, or fix forward. If the pull changed
`deploy/systemd/`, `deploy/env.example`, or `deploy/install.sh`, it tells you
to re-run `sudo deploy/install.sh` so the installed units match. It ends with
the reminder to restart every MCP client. Back up first
([Keep the database safe](#keep-the-database-safe)).

**What is knowingly deferred, and what un-defers it.** Workers off the
operator host need a network MCP transport (Streamable HTTP over TLS),
operator-issued per-worker grants (scope, kinds, expiry, revocation), and
leases bound to those grants — the server-bound worker sessions and grants of
[ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md)
and [ADR-0032](../adr/0032-route-work-with-operator-issued-grants.md). None
of that is built, and nothing built so far assumes it. The trigger for
building it is the first worker that must run on another machine; when that
happens it gets its own ADR and slice, and the operator surface's shared
token becomes per-operator auth at the same time. Until then, do not expose
`npm run mcp` or the surface off-host.

### The host as an Incus instance

The recommended v1 host is a small, dedicated Incus **container** — not the
operator's daily driver — so a laptop reboot never stalls the feeder, the
tunnel has a stable place to live, and the whole thing can be snapshotted,
moved, or rebuilt from the files in [`deploy/incus/`](../../deploy/incus/).
Anything else with systemd, Node 24, and `cloudflared` works the same way;
the instance is only the reproducible shape.

What the instance is (all of it in
[`snowcat.profile.yaml`](../../deploy/incus/snowcat.profile.yaml), no secret
in it): Debian 13 cloud image, `limits.cpu=2`, `limits.memory=4GiB`,
`boot.autostart`, daily snapshots kept 14 days, and cloud-init user-data that
creates the `snowcat` user (passwordless `sudo`, locked password), installs
`git jq sqlite3 shellcheck curl gnupg unattended-upgrades` (`shellcheck` because `deploy/upgrade.sh` runs `npm run check`), adds the NodeSource
(`node_24.x`), Tailscale, and Cloudflare apt repositories with their signing
keys fetched in `bootcmd` (so cloud-init's own `package_update` already
trusts them), installs `nodejs`, `tailscale`, and `cloudflared` (neither of
the last two configured — that is the mesh-or-Access choice above), and
creates `/opt/snowcat` owned by `snowcat`. Snowcat itself is not in the image: the checkout, `/etc/snowcat/env`,
and the databases arrive in the next steps.

Once, from any machine with the `incus` client (an operator laptop), against
the Incus server that will host it (`<remote>` below; add it with
`incus remote add <remote> https://<server>:8443` and the trust token the
server admin issues with `incus config trust add`):

```bash
git clone https://github.com/frostyard/snowcat.git && cd snowcat
incus profile create <remote>:snowcat
incus profile edit   <remote>:snowcat < deploy/incus/snowcat.profile.yaml
incus launch images:debian/13/cloud <remote>:snowcat --profile default --profile snowcat
incus exec <remote>:snowcat -- cloud-init status --wait --long   # errors: [] / recoverable_errors: {}
incus exec <remote>:snowcat -- bash -s < deploy/incus/bootstrap.sh          # add: -- --ref <branch> to pin a ref
```

The image renders its cloud-init seed at **create** time: edit the profile
before `incus launch`, and if you change it later, re-create the instance
(`incus delete --force`, `incus launch`) rather than restarting it — a
restarted instance keeps the seed it was born with. `cloud-init status` must
end with no errors before bootstrap; `bootstrap` refuses to run until `node`
exists.

[`bootstrap.sh`](../../deploy/incus/bootstrap.sh) runs as root inside the
instance and is idempotent: clone (or fast-forward) `/opt/snowcat` as
`snowcat` (`SNOWCAT_GIT_URL` overrides the URL; `SNOWCAT_GIT_TOKEN` is used
once for a private clone and never stored — pass it with
`incus exec … --env SNOWCAT_GIT_TOKEN=…`), `npm ci`, `deploy/install.sh
--user snowcat` (the same installer as any host: directories,
`/etc/snowcat/env` from the example if absent, units, drop-ins, timers), and
`npm run build`. When `/var/lib/snowcat` holds no queue database yet it stops
the timers again — still enabled — so a fresh host never feeds an
empty queue while the real databases are on their way. It ends by printing
what remains the operator's: the GitHub token, the databases, starting the
surface and (at cutover) the timers, then the mesh login or the tunnel and
Access.

Day two: `incus exec <remote>:snowcat -- sudo -u snowcat -i bash -lc 'cd
/opt/snowcat && deploy/upgrade.sh'` upgrades exactly like any host;
`incus snapshot create <remote>:snowcat pre-upgrade` before it costs nothing
and `incus snapshot restore` undoes everything including the databases;
`incus exec <remote>:snowcat -- journalctl -u snowcat-seed-dogfood -u snowcat-import-issues -u
snowcat-surface --since -1h` reads the logs; `incus file pull
<remote>:snowcat/var/backups/snowcat/queue-<stamp>.db .` fetches a backup
off the machine. The instance binds nothing but loopback; its only ingress
is the mesh of [A private mesh instead of Access](#a-private-mesh-instead-of-access-tailscale)
or the tunnel of [People and workers from anywhere](#people-and-workers-from-anywhere-adr-0063),
and the only way in for the operator is `incus exec` (or the server's SSH).

### Moving the host to a new machine

Moving is a backup, a copy, and a cutover; nothing else changes because the
databases carry all state and `/etc/snowcat/env` all configuration. The
new machine is prepared exactly as above (or with `deploy/install.sh` on any
host) up to and including `bootstrap`, with its timers stopped. Then, in
this order — the order matters because two feeders against two copies of
one queue would each admit their own work:

1. **Freeze the old host.** Disable its timers, stop its surface, and make
   sure no worker holds a lease (`queue -- list`, or the *Watch the work*
   view): `sudo systemctl disable --now snowcat-seed-dogfood.timer snowcat-import-issues.timer snowcat-sweep-dependencies.timer snowcat-sweep-settings.timer
   snowcat-verify.timer snowcat-backup.timer` and stop `npm run serve` /
   `snowcat-surface.service`. From here on the old copy is history.
2. **Back up both databases** on the old host into a scratch directory
   (never over an existing file; both commands verify the copy before they
   print its manifest): `queue -- backup <dir>/queue.db >
   <dir>/queue.manifest.json` and `control -- backup <dir>/control-plane.db >
   <dir>/control-plane.manifest.json`. Note `workItems`,
   `lastEventSequence`, and the control manifest's `databaseLineageId` and
   `lastTransactionSequence` — they are the check on the other side.
3. **Copy them into place** on the new host as the `snowcat` user, mode 0600,
   at the paths its `/etc/snowcat/env` names (for an instance:
   `incus file push <dir>/queue.db <dir>/control-plane.db
   <remote>:snowcat/var/lib/snowcat/ --uid 1000 --gid 1000 --mode 0600`),
   and **verify there**: `queue -- verify-backup /var/lib/snowcat/queue.db`
   must report the same `workItems`, `lastEventSequence`, and
   `schemaVersion`; `control -- verify-backup <manifest.json> <lineage-id>
   <last-sequence>` (push the manifest too, with `backupPath` rewritten to
   the new location) must accept the lineage; `repository -- status` must
   list the same enrolled repositories. Push nothing else — no `-wal`/`-shm`
   files, no manifests into the database directory except for that check.
4. **Complete `/etc/snowcat/env`** on the new host: `SNOWCAT_GITHUB_TOKEN`
   (a token for this host; the old one may be reused, but a dedicated
   fine-grained token is what makes revoking one host possible later),
   `SNOWCAT_APP_TOKEN` for local mode or the two Access variables, and
   anything else the old file had beyond the example. The file stays 0600.
5. **Start the surface** — `systemctl start snowcat-surface.service` — and
   read the inbox through `incus exec` + `curl -s http://127.0.0.1:3100/`
   or the tunnel; the sidebar's repository list is the last proof the copy
   is the one you meant.
6. **Cut over:** `systemctl start snowcat-seed-dogfood.timer snowcat-import-issues.timer snowcat-sweep-dependencies.timer snowcat-sweep-settings.timer snowcat-verify.timer
   snowcat-backup.timer` on the new host. Exactly one host now feeds. Point
   the tunnel (or move it) at the new host — or `tailscale up` there and
   drop the old node from the tailnet — and restart every MCP client with
   the new endpoint or, for stdio clients, on the new host.
7. **Retire the old copy** once the first feed tick and the first
   `verify-artifacts` run land cleanly on the new host: leave the old
   database files as a dated backup or delete them — never start the old
   timers again by habit; `install.sh` on the old machine would re-enable
   them.

Rolling back before step 6 is nothing: start the old timers again. After
it, move back the same way, with the new host as the old one.

## Keep the database safe

```bash
set -a; . /etc/snowcat/env; set +a
npm run --silent queue -- metadata                                     # path, database_id, version, counts
sudo systemctl start snowcat-backup.service                             # a backup right now, same as the daily timer
ls -l /var/backups/snowcat/                                             # queue-<stamp>.db, control-plane-<stamp>.db, *.manifest.json
npm run --silent queue -- verify-backup /var/backups/snowcat/queue-<stamp>.db
```

`snowcat-backup.timer` runs [`deploy/bin/snowcat-backup`](../../deploy/bin/snowcat-backup)
daily: one queue and one control-plane copy under `/var/backups/snowcat` (or
`SNOWCAT_BACKUP_DIR`) as `queue-<UTC stamp>.db` and
`control-plane-<UTC stamp>.db`, each with its manifest as
`<name>.manifest.json` beside it, then it deletes only those backup files older
than `SNOWCAT_BACKUP_RETAIN_DAYS` (default 14, from `/etc/snowcat/env`) and never
touches the live databases. The two databases are backed up independently: a
failure of one does not prevent the other's copy from being written, and the
retention prune is skipped whenever either failed, so a run that could not
write today's copy never deletes older ones (it exits non-zero and names the
failed backups on stderr). Start the service by hand before an upgrade or a
risky operator action. Backups contain lease tokens and are created mode
`0600` in a directory that [`deploy/bin/snowcat-backup`](../../deploy/bin/snowcat-backup)
`chmod`s to `0700` on every run (install.sh creates it 0750, but the timer
narrows it to 0700 within a day); keep them as private as the live files. Do not
open a backup with a queue command before verifying it — opening migrates it
to WAL and changes its digest.

**Restore** is a file copy to a *new* path plus a change to
`/etc/snowcat/env`; no command overwrites a live database:

```bash
sudo systemctl stop snowcat-seed-dogfood.timer snowcat-import-issues.timer snowcat-sweep-dependencies.timer snowcat-sweep-settings.timer snowcat-verify.timer snowcat-backup.timer   # and stop every MCP client
set -a; . /etc/snowcat/env; set +a
npm run --silent queue -- verify-backup /var/backups/snowcat/queue-<stamp>.db      # compare with queue-<stamp>.manifest.json
install -m 0600 /var/backups/snowcat/queue-<stamp>.db /var/lib/snowcat/queue-restored-<stamp>.db
npm run --silent control -- verify-backup /var/backups/snowcat/control-plane-<stamp>.manifest.json <database-lineage-id> <minimum-sequence>
npm run --silent control -- stage-restore /var/backups/snowcat/control-plane-<stamp>.manifest.json /var/lib/snowcat/control-plane-restored-<stamp>.db <database-lineage-id> <minimum-sequence>
"${EDITOR:-vi}" /etc/snowcat/env            # SNOWCAT_QUEUE_DB= and/or SNOWCAT_CONTROL_DB= → the restored paths
set -a; . /etc/snowcat/env; set +a
npm run --silent queue -- metadata         # databasePath is the restored file
sudo systemctl start snowcat-seed-dogfood.timer snowcat-import-issues.timer snowcat-sweep-dependencies.timer snowcat-sweep-settings.timer snowcat-verify.timer snowcat-backup.timer
```

Then restart the MCP clients from a shell that sourced the new
`/etc/snowcat/env`. The previous live files stay where they were; remove them
only after the restored database has been in use and backed up. Restore only
what failed: the queue and control-plane databases are independent, and each
keeps its own lineage identity that the verify commands check.

## What to record for the PRD

The [agent fleet PRD](../prd/agent-fleet.md) needs numbers before it can be
Approved. `metrics` computes the queue's share of them for one window, so a
day of the dogfood week is one command instead of an evening with `list` and
`events`:

```bash
npm run --silent queue -- metrics                                    # the last 24 hours, every repository and the total
npm run --silent queue -- metrics --repository frostyard/updex       # one repository
npm run --silent queue -- metrics --since 2026-08-19T00:00:00Z --until 2026-08-20T00:00:00Z
```

The window is half-open — `--since` inclusive, `--until` exclusive, both ISO
timestamps — and defaults to the last 24 hours ending now, so consecutive days
neither overlap nor gap. The reading prints one JSON object with `all` and one
entry per repository, each carrying, for that window:

- `created` — items *created* in the window, counted by the logical status
  they hold *now* (`proposed`, `queued`, `claimed`, `completed`, `blocked`,
  `cancelled`);
- `attempts` — `work.claimed` events, and `completed` — `work.completed`
  events, with `completedByDelivery` splitting those completions by their
  item's current `delivery`;
- `accepted` — completions whose `delivery` is `merged` — and
  `acceptedPerAttempt`, the headline number (`null` when nothing was claimed);
- `blocked` and `cancelled` — `work.blocked` and `work.cancelled` events;
- `timeToMergeHours` — `{ count, median, p90 }` hours from a completion to its
  pull request's merge.

Run `verify-artifacts` (or let its timer run) before reading a day: delivery
and merge times come from the recorded verifications, so an unverified pull
request counts as `unverified`, not as accepted. The command is read-only and
is not an MCP tool.

Record daily, per repository, `acceptedPerAttempt`, `blocked`, and
`timeToMergeHours` from the reading, plus the two numbers the queue cannot
see: reviewer changes requested and rejected pull requests (from GitHub), and
tokens and wall time per accepted outcome (from the client you ran).

## Troubleshooting

- **`import-issues` says "HTTP 5xx; nothing imported"** — GitHub, not you.
  Nothing was written; run it again. The same holds for `verify-artifacts`
  (`unavailable` entries) and for completions, which are accepted as
  `unverified` and picked up by the next `verify-artifacts`.
- **A worker says `complete_work` was refused** — the message names the
  artifact: wrong repository, wrong number, an issue reported as a pull
  request, or a URL that does not exist. The item is still leased to that
  worker; it should fix the report and complete again.
- **`complete_work` says "must report a pull-request artifact"** — the item's
  `requiredArtifact` is `pull-request` and the worker reported none (a
  commit on a branch does not count). It should open the pull request and
  complete again, or `block_work` with the reason if no change is warranted;
  then you `cancel` or leave it for the next lease.
- **`complete_work` refuses a follow-up "cannot deliver"/"requires open-pr"**
  — the worker proposed a change child without `open-pr`, or without
  `requiredArtifact: "pull-request"`. The whole completion was rolled back
  and the root is still leased; the worker corrects the follow-up and
  completes again. `approve` refuses the same shape with the same message
  for a proposal that predates the rule: `reject` it, and run
  `audit-contracts` to find the rest.
- **A completion on a private repository comes back `unverified` with
  "without SNOWCAT_GITHUB_TOKEN"** — the MCP server was started without the
  token, so GitHub answered 404 for a repository it could not see. Over
  `/mcp` that is the host's `/etc/snowcat/env`; for a stdio server it is the
  shell that started the client (the stdio shape passes it through as
  `${SNOWCAT_GITHUB_TOKEN:-}`; never write a token into an MCP file).
  Fix the environment, restart, and run `verify-artifacts` to record the
  real state.
- **`claim_work` returns `null` but `list queued` shows items** — with
  `SNOWCAT_CONTROL_DB` set, the repository is not `enrolled`; check
  `repository -- status`. Or the items are `proposed` (not admitted), or the
  worker filtered on a repository or kind that has nothing queued.
- **"schema version N is newer than the supported version"** — the database
  was migrated by newer code; restart this process from the current checkout.
- **"control-plane database does not exist"** on claim — `SNOWCAT_CONTROL_DB`
  points at nothing; fix the path or unset the variable to claim on opt-in
  alone.
- **The MCP client cannot see the `snowcat` server** — check the `--prefix`
  path and that `--silent` is present: the server must print nothing but
  protocol on stdout. Test by hand with
  `npm --prefix /path/to/snowcat run --silent mcp` and an `initialize` line on
  stdin.

## Operational notes

- One host, one queue database, any number of clients: every CLI invocation and
  MCP server opens its own connection; SQLite WAL and a busy timeout serialize
  writes.
- Feeder, `verify-artifacts`, and `backup` are idempotent and cheap; the
  six timers in `deploy/systemd/` (daily, every 15 minutes, daily, weekly, every 2 minutes, daily) are the
  intended cadence, and running any of them by hand in between is harmless.
- `SNOWCAT_CONTROL_DB` is the only coupling between the queue and the control
  plane. Leave it unset until `repository -- status` shows the repositories you
  care about as `enrolled`, or workers will find nothing to claim.
  `deploy/install.sh` writes it into `/etc/snowcat/env` from the start;
  comment it out there while enrollment is pending if you want claims to run
  on queue opt-in alone.

## References

- Overview for the team: [how Snowcat works](how-snowcat-works.md)
- Rationale: [ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md),
  [ADR-0003](../adr/0003-separate-work-coordination-from-execution.md),
  [ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md),
  [ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md),
  [ADR-0061](../adr/0061-cure-pull-requests-as-bounded-per-head-work.md),
  [ADR-0065](../adr/0065-gate-worker-pull-requests-behind-bounded-review.md),
  [ADR-0066](../adr/0066-sequence-project-slices-on-observed-predecessor-delivery.md),
  [ADR-0070](../adr/0070-grant-mcp-tokens-a-server-enforced-tool-scope.md)
- Contracts: [work queue](../specs/work-queue.md)
- Architecture: [queue execution boundary](queue-execution-boundary.md),
  [repository enrollment](repository-enrollment.md)
- Built in: [recovery plan](../plans/recover.md) Phases 1–5
- Product: [agent fleet PRD](../prd/agent-fleet.md)
