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
in the order you do it: install the host, enroll a repository, fill the queue,
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
sed -i "s/^SNOWCAT_APP_TOKEN=.*/SNOWCAT_APP_TOKEN=$app_token/" /etc/snowcat/env
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
`/var/backups/snowcat` (0750, owned by `--user`, default the sudo caller);
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

## One-time: enroll a repository

Enrollment is optional for the queue itself (repository opt-in is enough to
run) but required if you set `SNOWCAT_CONTROL_DB`, because then `claim_work`
only leases items whose repository is `enrolled` in the control plane.

1. In `frostyard/core`, declare the repository with `fleet_state: enabled`
   under `organization/repositories/<owner>/<name>.json`
   ([core#83](https://github.com/frostyard/core/pull/83) does this for
   updex). Validate before merging:
   `npm run --silent core -- verify` after pointing `SNOWCAT_CORE_REF` at the
   branch reports the catalog, or fails with the exact reason.
2. In the repository, make sure the four canonical surfaces exist:
   `AGENTS.md`, `policies/agent-governance.json`, `.agents/skills/`, and
   `docs/README.md` ([updex#297](https://github.com/frostyard/updex/pull/297)
   adds the governance file).
3. After both merge, activate and reconcile:

```bash
npm run --silent control -- metadata            # note lastTransactionSequence
npm run --silent core -- activate <lastTransactionSequence>
npm run --silent repository -- reconcile        # reads GitHub identity and surfaces
npm run --silent repository -- status           # want "effectiveState": "enrolled"
```

`repository -- reconcile` is safe to repeat; it converges. States other than
`enrolled` name what is missing (`awaiting-surfaces`, `surface-held`,
`disabled`, `operator-held`, …). To stop a repository's work without touching
Core: `npm run --silent repository -- hold <sequence> github.com:<id> "<reason>"`
and later `clear-hold`.

## Fill the queue

Opt the repository into the queue (this is separate from Core enrollment):

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
`skipped`, `failed`, and `notOptedIn`. Like the import, `--enrolled` exits
non-zero only when `SNOWCAT_CONTROL_DB` is unset or every repository failed
(`sweepFailureMessage` in the same module decides; a partial failure is
reported and exits 0).

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
one human-merged bump). Adding a program is one catalog entry plus its Core
enum value.

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
item, **Attach artifact** (`attach-artifact`: a pull request or issue URL in
the item's repository, checked against GitHub before it is written). Each is a
same-origin form attributed `operator:web` that carries the item's `status`
and `updatedAt` as rendered; if a worker or another shell moved the item
first, the surface refuses with *this item changed since you read it*, shows
the current state, and changes nothing ([spec rule 40](../specs/work-queue.md)).
After a decision you land back where you were with a one-line banner naming
the event recorded (`Recorded work.approved.`), and `queue -- show` and
`events` list it exactly like a CLI decision, actor `operator:web`. There
is no batch action, but the board's *Repository actions* strip is not
CLI-only: it runs from the browser as `operator:web` too, as described below.

Four more views sit behind the same session:

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

Tail the event ledger instead of looping over `show`. Every claim, lease
renewal, completion, proposal, block, release, operator decision, and artifact
verification is one event with a global, monotonic `sequence`:

```bash
npm run --silent queue -- watch                                 # one JSON line per new event, until Ctrl-C
npm run --silent queue -- watch --repository frostyard/updex --interval 5
npm run --silent queue -- events --since 0 --limit 500          # replay from the start (or any sequence)
npm run --silent queue -- events --repository frostyard/updex   # newest 100 after sequence 0, oldest first
npm run --silent queue -- show <id>                             # one item in full: result, artifacts, verification, events
```

`watch [--repository <owner/repo>] [--interval <seconds>]` starts at the
current last sequence, polls `eventsSince` every 10 seconds by default (values
below 2 are raised to 2), and prints each new event as one JSON line on
stdout; its startup line on stderr names the starting sequence. Stop it with
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

**Pull-request cure** ([ADR-0061](../adr/0061-cure-pull-requests-as-bounded-per-head-work.md)).
The same pass then looks at every open pull request a completed item reported
— its `mergeable_state`, the check runs on its head, its reviews, its review
threads (read through GraphQL, so `SNOWCAT_GITHUB_TOKEN` must be set), and the
identity of its patch — and, for each head that has *decayed* (`dirty` or
`behind`, a failing check, a reviewer's latest review requesting changes, a
review thread that is neither resolved nor outdated — decay
`unresolved-threads`), enqueues one **admitted** root of kind `pr-cure` keyed
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
  the fingerprinted blockers: address those, push, keep it a draft, report the
  pull request. Its push is a new head and the next round.
- **Blocked at round 3, `unable-to-review`, or a fix that completed without
  a new head** → nothing is created; the output's `needsHuman` names the
  reason and the inbox's **Review adjudication** group lists the pull request
  (beside the `readyToMark` ones). You decide: push a fix, `gh pr ready`,
  `note` or `requeue` the item, or close the pull request.

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
overrides). If `check` fails it exits non-zero, does not restart the timers,
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
moved, or rebuilt from three files in [`deploy/incus/`](../../deploy/incus/).
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
`0600` in a `0750` directory; keep them as private as the live files. Do not
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
  [ADR-0065](../adr/0065-gate-worker-pull-requests-behind-bounded-review.md)
- Contracts: [work queue](../specs/work-queue.md)
- Architecture: [queue execution boundary](queue-execution-boundary.md),
  [repository enrollment](repository-enrollment.md)
- Built in: [recovery plan](../plans/recover.md) Phases 1–5
- Product: [agent fleet PRD](../prd/agent-fleet.md)
