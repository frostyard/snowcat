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

This is the operator runbook for running Fluent's v1 work engine on one host,
in the order you do it: install the host, enroll a repository, fill the queue,
admit work, run coding agents against it, watch what they produce, and keep
the database safe (upgrade, back up, restore). It
follows the [recovery plan](../plans/recover.md) and is written for the first
dogfood repository, `frostyard/updex`; every command applies to any opted-in
repository.

Fluent never starts, sandboxes, or authenticates a worker. You start Codex,
Claude, Copilot, or another MCP-capable client yourself and tell it to work the
queue; Fluent decides what it may claim, records what it reports, and checks
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
- A GitHub token for `FLUENT_GITHUB_TOKEN` (`gh auth token` works). Optional
  for public repositories but strongly recommended: it lifts the API rate limit
  and lets Fluent verify artifacts on private repositories.
- **Two checkouts.** The operator's checkout (`FLUENT_HOME`, e.g.
  `/opt/fluent`) is the one the timers, the CLI, and `deploy/upgrade.sh` use;
  it stays on `main` and is only ever moved by `git pull --ff-only`. A worker
  that maintains `frostyard/fluent` itself works in a *different* clone —
  never in `FLUENT_HOME`. (On 2026-08-17 a worker left the operator checkout
  on a feature branch; the timers then ran that branch's code.)

State lives in `/var/lib/fluent/{queue,control-plane}.db`, configuration in
`/etc/fluent/env`, backups in `/var/backups/fluent`, all created by the
installer below. Without the installer the defaults are `./data/queue.db` and
`./data/control-plane.db` relative to the process working directory. Every
command below is `npm run --silent queue -- <command>` unless it names
another script; all print JSON.

## Install the host

Run once on a clean host, and again whenever `deploy/` changes (it is
idempotent and reports what it created and what it kept):

```bash
sudo install -d -o "$USER" -g "$(id -gn)" /opt/fluent
git clone https://github.com/frostyard/fluent.git /opt/fluent
cd /opt/fluent && npm ci
sudo deploy/install.sh --user "$USER"      # dirs, /etc/fluent/env, units, timers
"${EDITOR:-vi}" /etc/fluent/env            # FLUENT_GITHUB_TOKEN=<gh auth token>
set -a; . /etc/fluent/env; set +a          # load it into this shell
npm run --silent queue -- metadata         # databasePath: /var/lib/fluent/queue.db
systemctl list-timers 'fluent-*'           # three timers, next run times
```

[`deploy/install.sh`](../../deploy/install.sh) creates `/var/lib/fluent` and
`/var/backups/fluent` (0750, owned by `--user`, default the sudo caller);
writes `/etc/fluent/env` (0600, same owner) from
[`deploy/env.example`](../../deploy/env.example) with `FLUENT_HOME` set to
the checkout and the database paths under `/var/lib/fluent` — **only if the
file is absent**, so your token and edits survive re-runs; installs the six
units from [`deploy/systemd/`](../../deploy/systemd/) into
`/etc/systemd/system/` with one drop-in per service (`10-install.conf`:
`User=`, an absolute `ExecStart=` for the `npm` the operator user's login
shell resolves — a plain login shell first, then an interactive one (Homebrew's
`brew shellenv` usually sits in `~/.bashrc` behind an "if not interactive,
return" guard), then the installer's own `PATH`, then the well-known Homebrew
prefixes; `sudo` resets `PATH`, so override with
`sudo env FLUENT_NPM=/path/to/npm FLUENT_NODE=/path/to/node deploy/install.sh`
if it still picks the wrong one — a `PATH=` that lets that npm find `node`, and
`ReadWritePaths=` for the real `FLUENT_HOME`) — systemd's fixed search path
does not include Homebrew, nvm, or similar, so the drop-in is what makes the
timers work on such hosts; then
`daemon-reload` and `enable --now` on the three timers. It never runs
`core -- activate` and never opens or moves a database. Set
`FLUENT_INSTALL_ROOT=<dir>` to dry-run it into a directory without root
(`systemctl` is skipped unless `FLUENT_SYSTEMCTL` names a substitute); that
is what `npm run check:deploy` does, twice, asserting the second run changes
nothing.

`/etc/fluent/env` is the single source of the host configuration. Every
shell in which you run the CLI, and every shell from which you start a worker
client, loads it first:

```bash
set -a; . /etc/fluent/env; set +a
```

Timers get it through `EnvironmentFile=`; nothing else does — a client
started from a shell that did not source it sees no `FLUENT_*` variables.

## One-time: enroll a repository

Enrollment is optional for the queue itself (repository opt-in is enough to
run) but required if you set `FLUENT_CONTROL_DB`, because then `claim_work`
only leases items whose repository is `enrolled` in the control plane.

1. In `frostyard/core`, declare the repository with `fleet_state: enabled`
   under `organization/repositories/<owner>/<name>.json`
   ([core#83](https://github.com/frostyard/core/pull/83) does this for
   updex). Validate before merging:
   `npm run --silent core -- verify` after pointing `FLUENT_CORE_REF` at the
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

**From GitHub issues** — write them per the
[`write-fluent-issues` skill](../../.agents/skills/write-fluent-issues/SKILL.md)
(conventional title, evidence, bounded scope, at least one acceptance
criterion observable on the PR itself), label them (any label; `fluent` is a
good convention), then:

```bash
npm run --silent queue -- import-issues frostyard/updex --label fluent --priority 10
```

Each open labeled issue becomes one `proposed` item of kind `issue-resolution`
whose `sourceRef` is the issue URL. Re-running is idempotent; an issue that was
imported once — even if its item was later rejected or completed — is never
imported again. Higher `--priority` claims first (ties by creation time).
Priority is operator-owned; workers cannot change it.

The label convention is **`fluent`**: labeling an issue `fluent` is the
queue's claim on it, and the operator host imports it for you. `fluent-feed.timer`
runs `import-issues --enrolled --label fluent` hourly, right after the dogfood
feeder, for every repository that is opted in **and** `enrolled` in the
control-plane store:

```bash
npm run --silent queue -- import-issues --enrolled --label fluent [--priority <n>]
```

It reads the control-plane store once, runs the same import in one transaction
per repository, and prints `imported` (per repository: `fetched`, `created`,
`skippedSourceRefs`), `failed` (a repository whose GitHub listing returned 5xx
or was unavailable — reported and skipped while the others still run), and
`notOptedIn` (enrolled but not opted in). It exits non-zero only when
`FLUENT_CONTROL_DB` is unset or every repository failed, and it needs
`FLUENT_GITHUB_TOKEN` to list private repositories. Imported items stay
`proposed` until you admit them; hand-run `import-issues <owner/repo>` still
works for a repository that is opted in but not enrolled, or for a different
label.

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
program's cadence for that run). `--enrolled` requires `FLUENT_CONTROL_DB` (it exits non-zero naming
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
days.) It is the first thing `fluent-feed.timer` runs hourly,
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

The same queue, read-only for now, at `http://127.0.0.1:3000/` once the
operator host runs the surface
([design](operator-surface.md#operational-notes)):

```bash
FLUENT_APP_TOKEN=… FLUENT_QUEUE_DB=/var/lib/fluent/queue.db \
FLUENT_CONTROL_DB=/var/lib/fluent/control-plane.db \
npm run build && npm run serve        # binds 127.0.0.1:3000; HOST/PORT override
```

Sign in with the host's `FLUENT_APP_TOKEN`; the inbox shows what needs you —
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
is no batch action; the board's Hold / Import issues / Seed dogfood buttons
remain CLI-only for now.

Three more views sit behind the same session:

- `/repositories` — every opted-in (and, with `FLUENT_CONTROL_DB`, declared)
  repository with its enrollment badge and per-status counts, the browser's
  `list --repository` at a glance.
- `/repositories/<owner>/<name>` — the board: queued work in claim order with
  its priority and a `note` tag when an operator note is carried, leased work
  with the worker identity and how much of the lease is left, and completed
  work with its `delivery` state; the header shows the enrollment state, Core
  and surface commits, and repository id from the control plane. The
  *Repository actions* strip under the header runs the CLI's repository-level
  commands as `operator:web`: **Import issues** (label, default `fluent`, and
  optional priority — the same import as `queue -- import-issues`, so a second
  run creates nothing), **Seed dogfood** (the catalog's discovery roots for
  the programs the Core declaration lists — the whole catalog only for an
  undeclared opt-in — each with its program's cadence, which the button's
  note spells out), **Verify artifacts** (`verify-artifacts` for that
  repository), and, when `FLUENT_CONTROL_DB` is set and the repository is
  declared, **Hold repository** / **Clear hold** with a reason — the same
  attributed local-operator decision as `repository -- hold | clear-hold`,
  recorded against the control plane's current sequence (if it moved
  meanwhile you are asked to try again). The badge flips to `operator-held`
  and workers stop claiming until it is cleared. Each lands you back on the
  board with a banner naming what was recorded.
- `/items/<id>` — `queue -- show <id>` rendered: definition, acceptance
  criteria, result with artifacts and their verification, operator notes,
  previous results, the full event timeline, and the *Decide* card. Every
  row on the inbox and board links here.

## Run workers

Configure an MCP server named `fluent` in the client you start and let it
inherit the host configuration from the shell that launched it — `set -a; .
/etc/fluent/env; set +a` first, then start the client. Claude Code
(`.mcp.json`; the committed one in this repository has the same shape) expands
`${VAR}` and `${VAR:-default}`:

```json
{
  "mcpServers": {
    "fluent": {
      "type": "stdio",
      "command": "npm",
      "args": ["--prefix", "/opt/fluent", "run", "--silent", "mcp"],
      "env": {
        "FLUENT_QUEUE_DB": "${FLUENT_QUEUE_DB:-/var/lib/fluent/queue.db}",
        "FLUENT_CONTROL_DB": "${FLUENT_CONTROL_DB:-/var/lib/fluent/control-plane.db}",
        "FLUENT_GITHUB_TOKEN": "${FLUENT_GITHUB_TOKEN:-}"
      }
    }
  }
}
```

Codex (`~/.codex/config.toml`) does not expand variables in values; whitelist
them for pass-through instead:

```toml
[mcp_servers.fluent]
command = "npm"
args = ["--prefix", "/opt/fluent", "run", "--silent", "mcp"]
env_vars = ["FLUENT_QUEUE_DB", "FLUENT_CONTROL_DB", "FLUENT_GITHUB_TOKEN"]
```

Other clients have equivalents; the rule is the same — the three variables
come from the launching shell, so a token never has to live in a client
config file.

`npm --prefix` lets the client run from any directory — typically a checkout
of the target repository — while the server code comes from the Fluent
checkout. Start the client with whatever credentials and sandbox you want it
to have — Fluent grants none — and ask it to work the queue. The portable
[`work-fluent-queue` skill](../../.agents/skills/work-fluent-queue/SKILL.md)
tells it to claim one item, do only the item's `allowedActions`, report
evidence and artifacts, and stop. The skill lives in this repository, so a
client started in another checkout needs it installed where that client looks
for skills — for Claude Code, symlink or copy
`.agents/skills/work-fluent-queue` into `~/.claude/skills/`; other clients
have equivalent user-level skill directories. The MCP server's own
`instructions` carry the four essential rules even without the skill.

Prompts that work:

- "Work the Fluent queue." — claims the highest-priority eligible item.
- "Work the Fluent queue for frostyard/updex, issue-resolution items only." —
  the skill passes `repository` and `kinds` to `claim_work`.
- "Keep working the Fluent queue until it is empty, then stop." — an explicit
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
Fluent has already checked it exists in that repository; a wrong URL is refused
and the worker is told to fix it. To refresh state after review and merges:

```bash
npm run --silent queue -- verify-artifacts --repository frostyard/updex
```

`fluent-verify.timer` runs this every 15 minutes with the default limit. It
records `artifact.verified` events and leaves anything alone while GitHub is
unavailable.

**Pull-request cure** ([ADR-0061](../adr/0061-cure-pull-requests-as-bounded-per-head-work.md)).
The same pass then looks at every open pull request a completed item reported
— its `mergeable_state`, the check runs on its head, its reviews, and the
identity of its patch — and, for each head that has *decayed* (`dirty` or
`behind`, a failing check, a reviewer's latest review requesting changes),
enqueues one **admitted** root of kind `pr-cure` keyed by
`<pull-request URL>@<head SHA>`. The output's `cure` section lists
`enqueued`, `healthy`, `skipped` (same head already known, draft, closed,
patch identity uncomputable), and `unavailable`. A cure item tells the worker
to do only a *mechanical* cure — rebase or merge the base when it resolves
cleanly, retitle for the title lint, re-run checks, reply to reviews — and
Fluent enforces that on `complete_work` by recomputing the pull request's
patch identity (its added and removed lines per file, so a clean rebase keeps
it): a changed patch is refused and the item stays claimed. When curing needs
a code change the worker proposes one `pr-cure-change` child for you to admit,
or blocks. The same head is never enqueued twice; a push is a new head. Cure
never merges, approves, or dismisses — those stay yours. `--no-cure` runs the
refresh alone; the board's **Verify artifacts** button runs both and reports
`N cure items queued`. Pull requests no Fluent item reported are not cured
in v1 (a per-repository opt-in is planned).

When you carried a change the last mile yourself — a follow-up whose proposal
said "leave the change on a local branch; do not open a pull request", so the
worker completed it with no artifacts and you opened the pull request by
hand — the item's `delivery` reads `none` for work that shipped. Record the
pull request (or an issue) against the completed item with:

```bash
npm run --silent queue -- attach-artifact <id> https://github.com/frostyard/updex/pull/326 --description "opened by the operator from the local branch"
```

Fluent checks the URL against GitHub first exactly as it checks a worker's
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

Fluent v1 runs on **one operator host** and stays there deliberately:

- The checkout, `/var/lib/fluent/{queue,control-plane}.db`, and every worker
  client live on the same machine. MCP is stdio only; a worker started in an
  Incus or other container *on that host* still works because the client
  and `npm run mcp` share the machine.
- The only credentials in the system are the operator's: the shell that
  starts a client, `FLUENT_GITHUB_TOKEN`, and `FLUENT_APP_TOKEN` for the
  operator surface. Fluent issues no worker credentials and trusts the
  self-declared worker identity only as provenance, never as authorization
  ([queue execution boundary](queue-execution-boundary.md)).
- Anything with a listener — the operator surface, the Flue app — binds to
  loopback and is reached over SSH or a private mesh (Tailscale or
  equivalent), never exposed directly.
- Feeder, `verify-artifacts`, and `backup` run from three systemd timers on
  the host, shipped in [`deploy/systemd/`](../../deploy/systemd/) and linted
  by `npm run check:deploy`:

  | Timer | Cadence | Runs |
  | --- | --- | --- |
  | `fluent-feed.timer` | hourly (`OnCalendar=hourly`, `RandomizedDelaySec=300`) | `queue -- seed-dogfood --enrolled`, then `queue -- import-issues --enrolled --label fluent` (two `ExecStart=` lines; the import runs only if the feeder exits 0) |
  | `fluent-verify.timer` | every 15 minutes (`OnCalendar=*:0/15`) | `queue -- verify-artifacts` (default limit) |
  | `fluent-backup.timer` | daily (`OnCalendar=daily`, `Persistent=true`) | [`deploy/bin/fluent-backup`](../../deploy/bin/fluent-backup) |

  Each service is `Type=oneshot`, reads `EnvironmentFile=/etc/fluent/env`
  (`FLUENT_HOME`, `FLUENT_QUEUE_DB`, `FLUENT_CONTROL_DB`,
  `FLUENT_GITHUB_TOKEN`, `FLUENT_BACKUP_RETAIN_DAYS`), and runs
  `npm --prefix ${FLUENT_HOME} run --silent …` with `NoNewPrivileges=yes`,
  `PrivateTmp=yes`, and `ProtectSystem=strict`, writable only under
  `/var/lib/fluent`, `/var/backups/fluent` (backup only), and the checkout's
  `data/`. [`deploy/install.sh`](../../deploy/install.sh) installs them and
  writes the per-service drop-in (`User=`, absolute `ExecStart=`, `PATH=`,
  `ReadWritePaths=` for the real `FLUENT_HOME`) — see
  [Install the host](#install-the-host). Until it has run, run the three
  commands by hand as above.
- The timers do not reach worker clients: an MCP client still gets its
  environment from the shell that launches it (`.mcp.json` `env` or the
  operator's login shell), never from `/etc/fluent/env`, because systemd's
  `EnvironmentFile=` applies only to the units it starts.

**Upgrade.** In the operator checkout, as the operator user:

```bash
cd /opt/fluent && deploy/upgrade.sh
```

[`deploy/upgrade.sh`](../../deploy/upgrade.sh) refuses a dirty checkout, then
`git pull --ff-only`, `npm ci`, `npm run check`, `systemctl daemon-reload`,
and restarts the three timers (via `sudo` when not root; `FLUENT_SYSTEMCTL`
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

## Keep the database safe

```bash
set -a; . /etc/fluent/env; set +a
npm run --silent queue -- metadata                                     # path, database_id, version, counts
sudo systemctl start fluent-backup.service                             # a backup right now, same as the daily timer
ls -l /var/backups/fluent/                                             # queue-<stamp>.db, control-plane-<stamp>.db, *.manifest.json
npm run --silent queue -- verify-backup /var/backups/fluent/queue-<stamp>.db
```

`fluent-backup.timer` runs [`deploy/bin/fluent-backup`](../../deploy/bin/fluent-backup)
daily: one queue and one control-plane copy under `/var/backups/fluent` (or
`FLUENT_BACKUP_DIR`) as `queue-<UTC stamp>.db` and
`control-plane-<UTC stamp>.db`, each with its manifest as
`<name>.manifest.json` beside it, then it deletes only those backup files older
than `FLUENT_BACKUP_RETAIN_DAYS` (default 14, from `/etc/fluent/env`) and never
touches the live databases. Start the service by hand before an upgrade or a
risky operator action. Backups contain lease tokens and are created mode
`0600` in a `0750` directory; keep them as private as the live files. Do not
open a backup with a queue command before verifying it — opening migrates it
to WAL and changes its digest.

**Restore** is a file copy to a *new* path plus a change to
`/etc/fluent/env`; no command overwrites a live database:

```bash
sudo systemctl stop fluent-feed.timer fluent-verify.timer fluent-backup.timer   # and stop every MCP client
set -a; . /etc/fluent/env; set +a
npm run --silent queue -- verify-backup /var/backups/fluent/queue-<stamp>.db      # compare with queue-<stamp>.manifest.json
install -m 0600 /var/backups/fluent/queue-<stamp>.db /var/lib/fluent/queue-restored-<stamp>.db
npm run --silent control -- verify-backup /var/backups/fluent/control-plane-<stamp>.manifest.json <database-lineage-id> <minimum-sequence>
npm run --silent control -- stage-restore /var/backups/fluent/control-plane-<stamp>.manifest.json /var/lib/fluent/control-plane-restored-<stamp>.db <database-lineage-id> <minimum-sequence>
"${EDITOR:-vi}" /etc/fluent/env            # FLUENT_QUEUE_DB= and/or FLUENT_CONTROL_DB= → the restored paths
set -a; . /etc/fluent/env; set +a
npm run --silent queue -- metadata         # databasePath is the restored file
sudo systemctl start fluent-feed.timer fluent-verify.timer fluent-backup.timer
```

Then restart the MCP clients from a shell that sourced the new
`/etc/fluent/env`. The previous live files stay where they were; remove them
only after the restored database has been in use and backed up. Restore only
what failed: the queue and control-plane databases are independent, and each
keeps its own lineage identity that the verify commands check.

## What to record for the PRD

The [agent fleet PRD](../prd/agent-fleet.md) needs numbers before it can be
Approved. During the dogfood week keep, per repository:

- items admitted, claimed, completed, blocked, cancelled (`list` counts);
- completed items by `delivery` — merged pull requests over attempts is the
  headline;
- reviewer changes requested and rejected pull requests (from GitHub);
- tokens and wall time per accepted outcome (from the client you ran).

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
  "without FLUENT_GITHUB_TOKEN"** — the MCP server was started without the
  token, so GitHub answered 404 for a repository it could not see. Export
  `FLUENT_GITHUB_TOKEN` in the shell that starts the client (the committed
  `.mcp.json` passes it through as `${FLUENT_GITHUB_TOKEN:-}`; never write
  the token into that file), restart the client, and run `verify-artifacts`
  to record the real state.
- **`claim_work` returns `null` but `list queued` shows items** — with
  `FLUENT_CONTROL_DB` set, the repository is not `enrolled`; check
  `repository -- status`. Or the items are `proposed` (not admitted), or the
  worker filtered on a repository or kind that has nothing queued.
- **"schema version N is newer than the supported version"** — the database
  was migrated by newer code; restart this process from the current checkout.
- **"control-plane database does not exist"** on claim — `FLUENT_CONTROL_DB`
  points at nothing; fix the path or unset the variable to claim on opt-in
  alone.
- **The MCP client cannot see the `fluent` server** — check the `--prefix`
  path and that `--silent` is present: the server must print nothing but
  protocol on stdout. Test by hand with
  `npm --prefix /path/to/fluent run --silent mcp` and an `initialize` line on
  stdin.

## Operational notes

- One host, one queue database, any number of clients: every CLI invocation and
  MCP server opens its own connection; SQLite WAL and a busy timeout serialize
  writes.
- Feeder, `verify-artifacts`, and `backup` are idempotent and cheap; the
  three timers in `deploy/systemd/` (hourly, every 15 minutes, daily) are the
  intended cadence, and running any of them by hand in between is harmless.
- `FLUENT_CONTROL_DB` is the only coupling between the queue and the control
  plane. Leave it unset until `repository -- status` shows the repositories you
  care about as `enrolled`, or workers will find nothing to claim.
  `deploy/install.sh` writes it into `/etc/fluent/env` from the start;
  comment it out there while enrollment is pending if you want claims to run
  on queue opt-in alone.

## References

- Rationale: [ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md),
  [ADR-0003](../adr/0003-separate-work-coordination-from-execution.md),
  [ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md),
  [ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md)
- Contracts: [work queue](../specs/work-queue.md)
- Architecture: [queue execution boundary](queue-execution-boundary.md),
  [repository enrollment](repository-enrollment.md)
- Built in: [recovery plan](../plans/recover.md) Phases 1–5
- Product: [agent fleet PRD](../prd/agent-fleet.md)
