# 0060 — Bring the operator surface forward as a read-first inbox

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

The first dogfood day on `frostyard/updex` (recorded in the
[recovery plan](../plans/recover.md) and the
[PRD baseline](../prd/agent-fleet.md#first-dogfood-baseline-2026-08-17-frostyardupdex))
was operated entirely from the command line: `list`, `show`, `approve`,
`import-issues`, `seed-dogfood`, `verify-artifacts`, and a shell loop around
`show` to watch leases and completions. The loop worked — seven items, four
merged pull requests, three admitted findings — but every operator action
required knowing a command, an item id, and which of two databases to point
at. The operator has said plainly that this is not usable day to day.

The [product foundation roadmap](../plans/product-foundation-roadmap.md)
already places an operator surface in Phase 10, after grants, process
observation, fleet coordination, and feature delivery, and
[ADR-0035](0035-route-human-authority-through-typed-decisions.md) defines
`OperatorInbox` as the deterministic derived view of pending typed decision
records — never a work queue, controller, or separate source of authority —
served through the same authenticated API as the CLI. Under
[ADR-0059](0059-adopt-the-queue-store-as-the-v1-work-engine.md) the queue
store is the v1 work engine, and today its only human decisions are
admission (`approve`, `reject`, `defer`) and blocked-work exits (`requeue`,
`cancel`), each recorded as an attributed event.

Two facts constrain the shape. First, everything the operator needed to see
today already exists as store reads: `list` with filters, `show` (item plus
events), the derived `delivery`, and control-plane `repositoryStatuses`; the
one missing read, a cross-item event feed, is queued as
[frostyard/fluent#2](https://github.com/frostyard/fluent/issues/2). Second,
the deployment story — where the host, databases, and worker clients live and
how anything is reached remotely — is deliberately unsettled, so any surface
built now must be safe on a single operator host without remote exposure.

The Frostyard organization keeps its visual language in the
`frostyard/design-system` repository, consumed through the `frostyard-design`
skill in `frostyard/core`. That skill is not yet synchronized into this
repository's portable skill directory.

## Decision

Fluent brings the operator surface forward from roadmap Phase 10 to the next
delivery phase, as a **read-first inbox** over the queue store, and stops
treating the CLI as the only operator interface.

1. **Scope.** Three views and nothing else in the first slice: an *inbox* of
   items awaiting the operator (`proposed` children and roots, `blocked`
   items, and completed items whose artifacts are `unverified`); a
   *repository board* of queued, claimed, and completed items with priority,
   lease owner and age, `delivery`, and control-plane enrollment state; and
   an *item page* rendering exactly what `show` prints — definition, result,
   verified artifacts, lineage, and the event timeline.
2. **Same store, same commands.** Every read is an existing `QueueStore` or
   `ControlPlaneStore` read method (plus the queued `eventsSince`). Every
   mutation is one of the operator commands the CLI already has — approve,
   reject, defer, requeue, cancel, and the queued `prioritize` — invoked
   through the same store methods, attributed as `operator:web`. The surface
   introduces no new state transition, no batch "approve all", no worker
   tool, and never renders or transmits a lease token.
3. **Stale intent is rejected.** Each mutation carries the item's observed
   `status` and `updatedAt`; the store refuses the command when the item has
   changed since it was rendered. This is the first concrete instance of
   ADR-0035's stale-decision rule and applies equally to the CLI, which may
   pass the same precondition.
4. **This is `OperatorInbox`.** The inbox view is the ADR-0035 view
   restricted to the decision kinds that exist today (admission and blocked
   exits) plus verification attention. It presents authority; it does not
   own or broaden it. As typed decision records arrive, they appear in the
   same inbox rather than in a parallel one.
5. **Local first, single operator.** The surface is served by the existing
   Hono application on the operator host, bound to loopback by default,
   behind the existing shared `FLUENT_APP_TOKEN` boundary via a login form
   that sets an HttpOnly cookie compared in constant time. Remote reachability
   waits for the deployment decision; nothing here presumes it. Named-member
   roles remain post-v1.
6. **Server-rendered, design-system styled.** Pages are server-rendered HTML
   with progressive enhancement (auto-refresh first, event streaming from
   `eventsSince` later); no client-side application framework and no
   additional build pipeline. Visual implementation follows the
   `frostyard-design` skill and its assets from `frostyard/design-system`;
   that skill is synchronized into `.agents/skills` under
   [ADR-0002](0002-agent-portable-instruction-surface.md) before UI code
   lands, so every agent working the UI applies the same rules.

## Consequences

- The operator can run a dogfood day from a browser: see what needs a
  decision, decide it, and watch work move — without ids or environment
  variables. The CLI stays complete and remains the acceptance surface for
  behavior; the UI is a view and an input, not a second implementation.
- Because mutations reuse the store methods, the UI cannot do anything the
  CLI cannot, and the event ledger records web and CLI decisions identically.
  Tests for the store cover both.
- Preconditions add an optional parameter to the operator mutation methods
  and a new failure ("item changed") that the CLI may also surface; the spec
  changes alongside the code.
- The Hono app takes on HTML rendering and a cookie session; its loopback
  default and token guard become load-bearing and must be documented in the
  runbook. Exposing it beyond the host is out of scope until the deployment
  story is decided.
- Roadmap Phase 10's operator surface shrinks to what this slice does not
  cover (fleet views, grants, capacity, process health, restricted views);
  the roadmap is annotated, not rewritten.
- The `frostyard-design` skill becomes a dependency of this repository's
  portable instructions; keeping it synchronized is a maintenance duty.

## Alternatives considered

- **Wait for roadmap Phase 10:** rejected; the CLI is already the bottleneck
  for the one operator, and every later phase adds decisions that need this
  view.
- **A client-side application (React or similar) against a JSON API:**
  rejected for the first slice; it doubles the surface to maintain and adds a
  build pipeline before the deployment story exists. Server-rendered pages
  over the same store are enough for one operator and can grow an API later.
- **A terminal UI:** rejected; it is still the command line, and the
  operator's objection is to operating from a shell.
- **A separate service reading the SQLite files:** rejected; two processes
  with mutation authority over one queue is exactly the shape the store's
  single-host design avoids, and it would duplicate the store's rules.
- **Building on the control-plane store first:** rejected under ADR-0059;
  the queue is where the work and the decisions are.

## References

- Shapes: [operator surface](../design/operator-surface.md) and
  [work queue](../specs/work-queue.md)
- Delivery: [recovery plan](../plans/recover.md) Phase 6 and
  [product foundation roadmap](../plans/product-foundation-roadmap.md) Phase 10
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [typed human decisions and OperatorInbox](../prd/agent-fleet.md#typed-human-decisions-and-operatorinbox)
- Builds on:
  [ADR-0002](0002-agent-portable-instruction-surface.md),
  [ADR-0005](0005-admit-worker-created-work-before-claiming.md),
  [ADR-0035](0035-route-human-authority-through-typed-decisions.md), and
  [ADR-0059](0059-adopt-the-queue-store-as-the-v1-work-engine.md)
