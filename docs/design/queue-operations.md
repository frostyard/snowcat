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

This is the operator runbook for running Fluent's v1 work engine on one host:
enrolling a repository, filling the queue, admitting work, pointing coding
agents at it, watching what they produce, and keeping the database safe. It
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

- Node 24 or newer, a checkout of `frostyard/fluent`, and `npm ci`.
- A GitHub token in `FLUENT_GITHUB_TOKEN` (`gh auth token` works). Optional
  for public repositories but strongly recommended: it lifts the API rate limit
  and lets Fluent verify artifacts on private repositories.
- Decide where state lives and export it in every shell and in the MCP
  configuration:

```bash
export FLUENT_QUEUE_DB=/var/lib/fluent/queue.db          # the work engine; absolute path
export FLUENT_CONTROL_DB=/var/lib/fluent/control-plane.db # optional: gates claims on Core enrollment
export FLUENT_GITHUB_TOKEN="$(gh auth token)"
```

Defaults are `./data/queue.db` and `./data/control-plane.db` relative to the
process working directory. Every command below is `npm run --silent queue --
<command>` unless it names another script; all print JSON.

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

**From GitHub issues** — label the issues you want done (any label; `fluent`
is a good convention), then:

```bash
npm run --silent queue -- import-issues frostyard/updex --label fluent --priority 10
```

Each open labeled issue becomes one `proposed` item of kind `issue-resolution`
whose `sourceRef` is the issue URL. Re-running is idempotent; an issue that was
imported once — even if its item was later rejected or completed — is never
imported again. Higher `--priority` claims first (ties by creation time).
Priority is operator-owned; workers cannot change it.

**Standing maintenance** — one bounded, read-only discovery root per specialty
(quality, CI, security, architecture), each of which may propose one
implementation child:

```bash
npm run --silent queue -- seed-dogfood frostyard/updex                    # cooldown 24 h
npm run --silent queue -- seed-dogfood frostyard/updex --cooldown-hours 0 # ignore cooldown
```

Run it on a timer (hourly is fine): a specialty with active lineage is skipped,
and one that just completed with no finding is reported as `cooledKinds`
rather than re-asked. These roots are admitted immediately (they are read-only);
their children are not.

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
```

Worker follow-ups land as `proposed` children with `parentId`; approve them the
same way. Their permissions can never exceed the parent's `delegableActions`.

## Run workers

Configure an MCP server named `fluent` in the client you start (Claude Code
uses `.mcp.json`; Codex and others have equivalents). Give it the same
environment as your shell:

```json
{
  "mcpServers": {
    "fluent": {
      "type": "stdio",
      "command": "npm",
      "args": ["--prefix", "/path/to/fluent", "run", "--silent", "mcp"],
      "env": {
        "FLUENT_QUEUE_DB": "/var/lib/fluent/queue.db",
        "FLUENT_CONTROL_DB": "/var/lib/fluent/control-plane.db",
        "FLUENT_GITHUB_TOKEN": "ghp_…"
      }
    }
  }
}
```

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

Restart every MCP server (i.e. the client) after you `git pull` Fluent: an
already-open process refuses its next write once the schema moves.

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

Run this on the same timer as the feeder. It records `artifact.verified`
events and leaves anything alone while GitHub is unavailable.

**Blocked items** need an operator exit:

```bash
npm run --silent queue -- requeue <id> "<reason>"   # back to queued, same definition
npm run --silent queue -- cancel <id> "<reason>"    # terminal
```

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
- Feeder, `verify-artifacts`, and `backup` run from timers on the host
  (units to follow; until then, run them by hand as above).

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
npm run --silent queue -- metadata                                     # path, database_id, version, counts
npm run --silent queue -- backup /var/backups/fluent/queue-$(date -u +%Y%m%dT%H%M%SZ).db > manifest.json
npm run --silent queue -- verify-backup /var/backups/fluent/queue-<stamp>.db
```

Back up before upgrading and daily. The backup contains lease tokens and is
created mode `0600`; keep it as private as the live file. Restore is a file
copy to a new path after `verify-backup`, then point `FLUENT_QUEUE_DB` at it
and restart clients; no command overwrites a live database. Do not open a
backup with a queue command before verifying it — opening migrates it to WAL
and changes its digest.

The control-plane database has its own `npm run --silent control -- backup`,
`verify-backup`, and `stage-restore`.

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
- Feeder, `verify-artifacts`, and `backup` are idempotent and cheap; a
  systemd timer or cron running them hourly and daily respectively is the
  intended cadence.
- `FLUENT_CONTROL_DB` is the only coupling between the queue and the control
  plane. Leave it unset until `repository -- status` shows the repositories you
  care about as `enrolled`, or workers will find nothing to claim.

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
