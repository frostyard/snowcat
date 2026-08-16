# Fluent (working name)

Fluent is a self-hosted, durable work queue for capable coding agents that
maintain opted-in repositories in a GitHub organization. It is being designed
for Frostyard first, with repository-scoped workstreams, shared maintenance
specialties, organization-level direction, and portable agent instructions.

The canonical source repository is
[`frostyard/fluent`](https://github.com/frostyard/fluent), as recorded in
[ADR-0045](docs/adr/0045-host-fluent-under-frostyard.md).

The product definition is still being refined. Start with the
[documentation index](docs/README.md) and the
[discovery PRD](docs/prd/agent-fleet.md).

The clean target control-plane substrate now initializes separately at
`FLUENT_CONTROL_DB` (default `./data/control-plane.db`) with closed bootstrap
registries, ordered record/event envelopes, and registered rebuildable subject
and event-cursor projections. It can create verified online backups and stage a
restore without overwriting a live path. It is not yet the worker-facing runtime
and never imports the queue-spike database; see the
[kernel design](docs/design/control-plane-kernel.md).

Host-local kernel operations use the JSON control CLI:

```bash
npm run --silent control -- metadata
npm run --silent control -- projection-health
npm run --silent control -- check-integrity 1 integrity:operator:example
npm run --silent control -- backup /absolute/new/path/control-plane-backup.db
```

The backup command prints its manifest to stdout. Save that JSON separately for
`verify-backup` or `stage-restore`; restore staging only creates and verifies a
new path and never replaces the live database.

Verify the currently supported `frostyard/core` authority slice without
activating it or changing the control-plane database:

```bash
npm run --silent core -- verify
```

This uses a host-local bare mirror and emits the exact commit, tree, catalog,
schema, fixture, and repository-declaration identities. A valid report is a
candidate inspection, not enrollment.

## Queue spike

The first vertical slice draws hard boundaries between coordination,
authorization, and execution:

- deterministic code owns enrollment, queue state, leases, permissions,
  delegation, and provenance;
- an operator starts Codex, Claude, Copilot, or another capable client and asks
  it to work one item from Fluent through MCP;
- an optional Flue agent may use local Lemonade for non-authoritative assistance
  without entering the control path.

Fluent does not launch, supervise, authenticate, refresh credentials for, or
sandbox those worker processes. The worker environment owns those concerns;
Fluent owns repository opt-in, leases, action limits, lineage, and evidence.

Try the deterministic testing-gap slice:

```bash
npm install
npm run queue -- opt-in frostyard/updex
npm run queue -- seed-testing-gap frostyard/updex
npm run queue -- list
npm run check
```

For bounded dogfooding, `npm run queue -- seed-dogfood <owner/repo>` creates at
most one active read-only root for quality, CI, security, and architecture.
Repeated or concurrent feeder invocations do not duplicate an active specialty.
Worker-created children appear under `list proposed` and require operator
admission before any worker can claim them.

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

Configure an MCP server named `fluent` to run `npm run mcp`, then tell a capable
client to "work the Fluent queue." The portable
[worker skill](.agents/skills/work-fluent-queue/SKILL.md) claims at most one
item per invocation by default.

The optional local clerk defaults to `http://10.0.1.200:13305/v1` and
`Qwen3.8-27B-GGUF-UD-Q4_K_XL`. Fluent remains useful when that endpoint is
absent, and subscription credentials never enter Fluent.
