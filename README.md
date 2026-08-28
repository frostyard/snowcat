# Snowcat

Snowcat is a self-hosted, durable work queue for capable coding agents that
maintain opted-in repositories in a GitHub organization. The operator starts
Codex, Claude, Copilot, or another MCP-capable client and tells it to work the
queue; Snowcat decides what it may claim, records what it reports, verifies
reported issues and pull requests against GitHub under its own credential, and
keeps every operator decision as an attributed event. It is being built for
Frostyard first; the product definition is still a discovery draft. It was
named Fluent until 2026-08-18 (ADR-0064); `FLUENT_*` environment variables
are still read for one release.

The canonical source repository is
[`frostyard/snowcat`](https://github.com/frostyard/snowcat), as recorded in
[ADR-0045](docs/adr/0045-host-fluent-under-frostyard.md). Start with the
[documentation index](docs/README.md), the
[recovery plan](docs/plans/recover.md) for what is built and what is next, and
the [operations runbook](docs/design/queue-operations.md) for how to run it.

## Status (2026-08-18)

- **Work engine:** the queue store and its MCP contract
  ([ADR-0059](docs/adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md)) —
  admission, leases, delegation ceilings, operator notes, artifact
  verification, derived delivery, a forward-only migration ladder, verified
  backups.
- **Sources of work:** labeled GitHub issues (`import-issues`, every 15
  minutes on its own timer for enrolled repositories) and standing read-only
  discovery roots (`seed-dogfood`, daily) whose findings become proposals
  the operator admits.
- **Authority sidecar:** the control-plane store activates `frostyard/core`
  snapshots and reconciles repository enrollment; with `SNOWCAT_CONTROL_DB`
  set, only `enrolled` repositories' work is claimable.
- **Operator surface:** inbox, repository board, item page, and the CLI's
  operator mutations with stale-intent preconditions, live from the event
  ledger, on loopback behind `SNOWCAT_APP_TOKEN`
  ([ADR-0060](docs/adr/0060-bring-the-operator-surface-forward-as-a-read-first-inbox.md)).
- **Deployment:** one operator host — `deploy/install.sh`, `deploy/upgrade.sh`,
  `/etc/snowcat/env`, systemd timers for feeder, verification, and backup.
  [Remote workers](docs/design/queue-operations.md#run-workers) connect to its
  `/mcp` endpoint over Streamable HTTP with Snowcat-minted bearer tokens.
- **Dogfood so far:** `frostyard/updex` and Snowcat itself are enrolled; 27
  items completed by four different client kinds, 22 pull requests merged
  and verified, including every Snowcat feature above being built through
  the queue.

## Quick start

```bash
npm ci
sudo deploy/install.sh --user "$USER"      # dirs, /etc/snowcat/env, timers
app_token="$(node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))')"
sudo sed -i "s/^SNOWCAT_APP_TOKEN=.*/SNOWCAT_APP_TOKEN=$app_token/" /etc/snowcat/env
unset app_token
set -a; . /etc/snowcat/env; set +a
npm run --silent queue -- opt-in frostyard/updex
npm run --silent queue -- import-issues frostyard/updex --label snowcat --priority 10
npm run --silent queue -- list proposed
npm run --silent queue -- approve <id>
npm run build && node scripts/serve.mjs   # operator surface on http://127.0.0.1:3000
```

Open `http://127.0.0.1:3000` and enter the generated
`SNOWCAT_APP_TOKEN` at `/login` (print it from the loaded environment with
`printf '%s\n' "$SNOWCAT_APP_TOKEN"`). Then configure an MCP server named
`snowcat` running `npm run --silent mcp` in your client and say "work the
Snowcat queue." Everything above is spelled out, with enrollment through
`frostyard/core`, in the
[runbook](docs/design/queue-operations.md).

## Work engine

The queue draws hard boundaries between coordination, authorization, and
execution:

- deterministic code owns enrollment, queue state, leases, permissions,
  delegation, and provenance;
- an operator starts Codex, Claude, Copilot, or another capable client and asks
  it to work one item from Snowcat through MCP;
- an optional Flue agent may use local Lemonade for non-authoritative assistance
  without entering the control path.

Snowcat does not launch, supervise, authenticate, refresh credentials for, or
sandbox those worker processes. The worker environment owns those concerns;
Snowcat owns repository opt-in, leases, action limits, lineage, and evidence.

Try it against a scratch database:

```bash
npm install
npm run queue -- opt-in frostyard/updex
npm run queue -- seed-testing-gap frostyard/updex
npm run queue -- list
npm run check
```

For bounded dogfooding, `npm run queue -- seed-dogfood <owner/repo>` creates at
most one active read-only root per program in the maintenance program catalog
([`src/queue/programs.ts`](src/queue/programs.ts)): quality, CI, security,
architecture, conformance, triage, dependencies, and docs. Repeated or
concurrent feeder invocations do not duplicate an active program, and a
program that just completed with no finding is cooled for its own cadence —
daily for quality, CI, security, and triage; weekly for architecture,
conformance, dependencies, and docs (`--cooldown-hours <n>` overrides every
program; `0` disables) — doubling per consecutive empty assessment, up to
14 days (a ceiling that never shortens a longer base), until a root proposes a
child.
`seed-dogfood --enrolled` seeds only the programs each
repository's Core declaration lists. Worker-created children appear under
`list proposed` and require operator admission before any worker can claim
them.

Real work comes from labeled GitHub issues:

```bash
export SNOWCAT_GITHUB_TOKEN=...   # optional; raises the API rate limit and reads private repositories
npm run queue -- import-issues frostyard/updex --label snowcat --priority 10
npm run queue -- list proposed
npm run queue -- approve <work-item-id>
```

Each open issue with the label becomes one proposed `issue-resolution` item
whose `sourceRef` is the issue URL; re-running the import creates nothing new,
and only approved items are claimable.

To gate claims on Core enrollment, point the same processes at the
control-plane database:

```bash
export SNOWCAT_CONTROL_DB=/var/lib/snowcat/control-plane.db
npm run --silent core -- activate <sequence>       # activate frostyard/core main
npm run --silent repository -- reconcile           # resolve identity, surfaces, enrollment
npm run --silent repository -- status              # effectiveState must be "enrolled"
```

With the variable set, `claim_work` only leases items whose repository is
`enrolled` (not disabled, paused, unresolved, or operator-held); unset it and
opt-in alone governs. Restart the MCP server after changing it.

When a worker completes an item citing an issue or pull request, Snowcat checks
it against GitHub before accepting: a wrong repository, number, or kind is
refused and the item stays claimed; a GitHub outage records `unverified`
instead. Re-check later and watch delivery:

```bash
npm run queue -- verify-artifacts --repository frostyard/updex
npm run queue -- list completed     # each item carries delivery: none|unverified|open|closed|merged
```

Operator queue controls are local CLI commands and never expose a lease token:

```bash
npm run queue -- list proposed
npm run queue -- approve <work-item-id>
npm run queue -- reject <work-item-id> <reason>
npm run queue -- defer <work-item-id> <reason>
npm run queue -- requeue <work-item-id> <reason>
npm run queue -- cancel <work-item-id> <reason>
```

`defer` withdraws an admitted, unclaimed item for later review. `requeue` and
`cancel` are the operator-only exits from `blocked`; workers can neither admit
work nor choose those exits through MCP.

Configure an MCP server named `snowcat` to run `npm run mcp`, then tell a capable
client to "work the Snowcat queue." The portable
[worker skill](.agents/skills/work-snowcat-queue/SKILL.md) claims at most one
item per invocation by default.

## Operating the queue

The full operator runbook — enrolling a repository, filling the queue,
admitting work, running workers, watching delivery, backups — is
[docs/design/queue-operations.md](docs/design/queue-operations.md). In brief,
under [ADR-0059](docs/adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md)
the queue is the v1 work engine and its database is durable state; the
[recovery plan](docs/plans/recover.md) is the current delivery order. Run it on
one operator host:

```bash
export SNOWCAT_QUEUE_DB=/var/lib/snowcat/queue.db   # absolute; default is ./data/queue.db
npm run --silent queue -- metadata                 # path, database_id, schema version, counts
npm run --silent queue -- backup /var/backups/snowcat/queue-$(date -u +%Y%m%dT%H%M%SZ).db > manifest.json
npm run --silent queue -- verify-backup /var/backups/snowcat/queue-<stamp>.db
```

Opening an older database upgrades it in place through a forward-only
migration ladder; a newer one is refused. Restart MCP servers after upgrading
Snowcat — an already-open process refuses its next write once the schema moves.
Backups contain lease tokens and are created `0600`; restore is a file copy to
a new path after `verify-backup`, never an overwrite of the live file.

The optional local clerk defaults to `http://localhost:13305/v1` and
`Qwen3.8-27B-GGUF-UD-Q4_K_XL`. Snowcat remains useful when that endpoint is
absent, and subscription credentials never enter Snowcat.
