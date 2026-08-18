# Operator surface

Living document. Rationale:
[ADR-0060](../adr/0060-bring-the-operator-surface-forward-as-a-read-first-inbox.md),
with the decision model from
[ADR-0035](../adr/0035-route-human-authority-through-typed-decisions.md) and
the work engine from
[ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md).
Contract: [work queue](../specs/work-queue.md). Operating context:
[queue operations runbook](queue-operations.md).

## Overview

The operator surface is a small server-rendered web application, served by
Fluent's existing Hono app on the operator host, that shows the queue the way
the operator thinks about it — *what needs me*, *what is each repository
doing*, *what happened to this item* — and lets the operator make exactly the
decisions the CLI already offers. It is a view and an input over the same
`QueueStore` and `ControlPlaneStore` methods; it owns no state, no authority,
and no new transitions.

```text
browser ──cookie session──► Hono app (loopback) ──► QueueStore reads/mutations
                                             └──► ControlPlaneStore.repositoryStatuses()
                    same methods, same events ◄──── queue CLI / MCP server
```

The first slice is deliberately small: three views, six mutations, one
operator, one host. It is the ADR-0035 `OperatorInbox` restricted to the
decision kinds that exist today.

## Design

### Views

Layout decisions settled 2026-08-17 on the design canvas
([Fluent Operator Surface](https://claude.ai/code/artifact/86d7da78-b87d-4df4-a725-2d8a34b29384),
Frostyard Pilothouse admin shell, real dogfood data): the inbox is **grouped
by decision kind** (proposals, blocked, unverified artifacts) rather than one
merged list; the repository board is **three columns** (queued in claim
order, leased, completed) rather than a filtered table; the **events rail
stays on the inbox**; and **requeue-with-note is inline** in the blocked row
as well as on the item page.

| View | Route | Reads | Purpose |
| --- | --- | --- | --- |
| Inbox | `/` | `list({status:"proposed"})`, `list({status:"blocked"})`, completed items with any `unverified` artifact | Everything waiting on the operator, grouped: proposals to admit (children under their parent's finding), blocked items to requeue or cancel, unverified artifacts to re-check |
| Repository board | `/repositories/:owner/:name` | `list({repository})` per status; `ControlPlaneStore.repositoryStatuses()` for the enrollment badge; `activeRootKinds` | Queued in claim order with priority; claimed with lease owner and age; completed with `delivery`; the repository's enrollment state and hold |
| Item | `/items/:id` | `get(id)`, `events(id)`, parent and children via `rootId`/`parentId` | Exactly what `queue -- show` prints, rendered: objective, instructions, criteria, actions, result summary and evidence, artifacts with verification, lineage, event timeline |

A repositories index (`/repositories`) lists opted-in repositories with counts
from `counts()` and their enrollment state. Lease tokens are never read into a
template; views use `withoutLeaseToken` like the CLI.

### Mutations

Exactly the operator commands the CLI has, as `POST` forms on the item page
and inline on the inbox, all attributed `operator:web`:

| Action | Store method | Allowed from |
| --- | --- | --- |
| Approve | `approve(id, actor, precondition)` | `proposed` |
| Reject | `reject(id, actor, reason, precondition)` | `proposed` |
| Defer | `defer(id, actor, reason, precondition)` | `queued`, unclaimed |
| Requeue | `requeue(id, actor, reason, precondition)` | `blocked` |
| Cancel | `cancel(id, actor, reason, precondition)` | `blocked` |
| Prioritize | `prioritize(id, actor, priority, reason, precondition)` ([frostyard/fluent#1](https://github.com/frostyard/fluent/issues/1)) | `proposed`, `queued`, `blocked` |
| Re-verify | `refreshArtifactVerifications({repository})` | completed with unverified or open artifacts |

Every mutation form carries the item's `status` and `updatedAt` as rendered;
the store methods take an optional `precondition: { status, updatedAt }`
([spec rule 39](../specs/work-queue.md)) and throw `PreconditionMismatchError`
(`item changed since it was read: <id> is now <status> (updated <when>)`)
when it no longer matches, so a stale tab cannot approve something a worker
or another shell already moved; the error carries the current state for the
surface to render. The CLI passes the same precondition through
`--if-updated-at`; without it, behavior is unchanged. There is no batch
action and no worker-facing endpoint.

### Session and binding

The app already guards `/agents/*` with a constant-time `Bearer` comparison
against `FLUENT_APP_TOKEN`. The surface adds `/login` (form → HttpOnly,
SameSite=Strict cookie holding an HMAC of the token, compared in constant
time) and guards every surface route with it. `/health` stays unauthenticated
and content-free. The server binds to `127.0.0.1` unless `HOST` is set;
exposing it beyond the host is a deployment decision recorded elsewhere, not
a configuration this doc endorses. Single operator: no users, roles, or CSRF
tokens beyond SameSite cookies and same-origin form posts.

### Rendering and liveness

Server-rendered HTML through Hono's JSX or a small template layer, styled per
the `frostyard-design` skill and its assets from `frostyard/design-system`
(tokens, type, components). No client-side application framework. First
slice: pages refresh on an interval; second: an event stream from
`eventsSince` ([frostyard/fluent#2](https://github.com/frostyard/fluent/issues/2))
drives the inbox and board without reloads. Every page prints the queue and
control-plane database paths it is reading, the same way `metadata` does.

### What it does not do

Grants, capability profiles, fleet or relationship views, process health,
restricted findings, decision types beyond admission and blocked exits,
multi-user access, and anything reachable off-host. Those remain roadmap
Phase 10 and later.

## Operational notes

- The surface runs in the same process as the Flue app, reading
  `FLUENT_QUEUE_DB`, `FLUENT_CONTROL_DB`, `FLUENT_APP_TOKEN`, `HOST`, and
  `PORT`. Missing `FLUENT_APP_TOKEN` fails closed (503) for every surface
  route, login included, as it does for `/agents/*` today.
- Run it locally with
  `FLUENT_APP_TOKEN=… FLUENT_QUEUE_DB=/var/lib/fluent/queue.db npm run build && npm run serve`
  and open `http://127.0.0.1:3000/`. `npm run serve`
  ([`scripts/serve.mjs`](../../scripts/serve.mjs)) starts the built
  `dist/app.mjs` bound to `HOST` (default `127.0.0.1`) and `PORT` (default
  `3000`); Flue's own `dist/server.mjs` entry honours `PORT` only and lets
  Node pick the interface, so use `serve` when the bind address matters. The
  default is loopback: exposing the surface beyond the host (a different
  `HOST`, a reverse proxy) is a deployment decision recorded with the
  deployment, not a default this doc endorses. Set `FLUENT_CONTROL_DB` too
  and the sidebar shows control-plane enrollment states instead of queue
  opt-ins.
- Session: `GET /login` renders the token form; `POST /login` compares the
  submitted token to `FLUENT_APP_TOKEN` in constant time and sets
  `fluent_session`, an `HttpOnly; SameSite=Strict` cookie holding an
  HMAC-SHA256 of the token (never the token; `Secure` is added when the
  request itself arrived over HTTPS). Every other surface route redirects to
  `/login` without it; `POST /logout` clears it. Rotating the token
  invalidates every session.
- Slice status: the shell, login, and the read-only inbox (`/`) shipped with
  [frostyard/fluent#17](https://github.com/frostyard/fluent/issues/17):
  stat tiles, the three decision groups, and the events rail (last 30 from
  `eventsSince`, newest first). Mutation controls render disabled; the
  repository board and item page
  ([#18](https://github.com/frostyard/fluent/issues/18)) and the mutations
  ([#19](https://github.com/frostyard/fluent/issues/19)) follow. The inbox
  refreshes with `<meta http-equiv="refresh" content="30">` until the event
  stream lands. Pages inline their stylesheet (Frostyard tokens and the
  Pilothouse shell copied into [`src/surface/styles.ts`](../../src/surface/styles.ts));
  nothing is fetched from another host. Every page footer prints the queue
  and control-plane database paths.
- It opens its own store connections like any CLI process; SQLite WAL and the
  busy timeout serialize its writes with MCP servers and the CLI. Restart it
  after upgrading Fluent for the same schema-guard reason as MCP servers.
- Decisions made in the browser appear in `queue -- show` and `events` as
  `operator:web` events; the CLI and the surface are interchangeable.
- Prerequisite before UI code lands: synchronize `frostyard-design` from
  `frostyard/core` into `.agents/skills/` (portable instruction surface,
  [ADR-0002](../adr/0002-agent-portable-instruction-surface.md)) so agents
  implementing the pages use the organization's design rules and assets.
- The runbook keeps its CLI instructions; a "From the browser" section is
  added when the surface ships.

## References

- Rationale:
  [ADR-0060](../adr/0060-bring-the-operator-surface-forward-as-a-read-first-inbox.md),
  [ADR-0035](../adr/0035-route-human-authority-through-typed-decisions.md),
  [ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md),
  [ADR-0002](../adr/0002-agent-portable-instruction-surface.md)
- Contracts: [work queue](../specs/work-queue.md)
- Built in: [recovery plan](../plans/recover.md) Phase 6;
  long-range: [product foundation roadmap](../plans/product-foundation-roadmap.md) Phase 10
- Adjacent: [queue execution boundary](queue-execution-boundary.md),
  [queue operations runbook](queue-operations.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md#typed-human-decisions-and-operatorinbox)
