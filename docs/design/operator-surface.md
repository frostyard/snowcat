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

Shipped 2026-08-18 through Snowcat's own queue (frostyard/snowcat#16–#19, #22–#24)
and running on the operator host; this document describes it as built.

The operator surface is a small server-rendered web application, served by
Snowcat's existing Hono app on the operator host, that shows the queue the way
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
([Snowcat Operator Surface](https://claude.ai/code/artifact/86d7da78-b87d-4df4-a725-2d8a34b29384),
Frostyard Pilothouse admin shell, real dogfood data): the inbox is **grouped
by decision kind** (proposals, blocked, unverified artifacts) rather than one
merged list; the repository board is **three columns** (queued in claim
order, leased, completed) rather than a filtered table; the **events rail
stays on the inbox**; and **requeue-with-note is inline** in the blocked row
as well as on the item page.

| View | Route | Reads | Purpose |
| --- | --- | --- | --- |
| Inbox | `/` | `list({status:"proposed"})`, `list({status:"blocked"})`, `completedItemsWithPendingArtifacts({ unverifiedOnly: true })` — completed items with an `unverified` issue or pull-request artifact, newest first, selected in the store rather than filtered out of the first 100 completions | Everything waiting on the operator, grouped: proposals to admit (children under their parent's finding), blocked items to requeue or cancel, unverified artifacts to re-check |
| Repository board | `/repositories/:owner/:name` | `counts(repository)`, `list({repository, status})` for `queued`/`claimed`/`completed`, `list({repository, kind:"pr-cure", status})` per status, `events(id)` for the completing worker; `ControlPlaneStore.repositoryStatuses()` and `activeCoreSnapshot()` for the enrollment badge (effective state, Core source commit, surface commit, repository id, hold) | Three columns: queued in claim order (priority tag, `note` tag when `operatorNotes` is non-empty), leased (worker identity, lease-time bar from `updatedAt` → `leaseExpiresAt`), completed newest first with the `delivery` tag; four stat tiles (queued, leased, completed today, merged / attempts — the attempts denominator counts only completed items whose `allowedActions` include `open-pr`, see below); under them the [pull requests](#pull-requests) section; the header's Verify artifacts / Import issues / Seed dogfood / Hold (or Clear hold) actions, each one same-origin `POST` (see [Mutations](#mutations) and the operational notes below; [spec rule 40](../specs/work-queue.md)) |
| Progress | `/progress` | `list({status})` for the live statuses and `recentlyUpdatedItems({status})` — the same filters ordered newest first in the store — for `completed` and `cancelled`, so more than 100 old merged completions cannot hide today's work behind claim order; plus `repositoryLabeledIssueObservations(repository)` and each repository's review-gate setting | Read-only lifecycle strips grouped by repository. The eight fixed stages run from awaiting import through merged; review and fix satellites fold into their primary item. Amber and red stops are collected in a pinned needs-attention group, active leases pulse, and merged or cancelled rows age out after seven days |
| Item | `/items/:id` | `get(id)`, `events(id)`, `get(parentId)`, `get(rootId)`, `children(id)` | Exactly what `queue -- show` prints, rendered: header with status and delivery tags; Definition (objective, repository + enrollment, kind, lineage links to parent/root/children, priority, allowed/delegable tags, created/updated, instructions, acceptance criteria); Result (summary, evidence, artifacts table with verification tag, head SHA, merged/verified time and the re-verifying actor from `artifact.verified`); Operator notes; Previous results; the full event timeline |
| Events | `/events` | `eventsSince(since, {repository, limit: 500})` — the store's own repository filter; the decision-type filter is applied over that read in [`src/surface/events.ts`](../../src/surface/events.ts), no new store method | The ledger as a page, newest first: time, sequence, event type, item link, repository link, actor, payload gist. `?repository=<owner/repo>` scopes it to one repository, `?since=<sequence>` moves the window (default: the last 100 events, the last 500 when filtering decisions), and `?decisions=1` keeps only the operator-decision event types (`work.approved`, `work.rejected`, `work.deferred`, `work.requeued`, `work.cancelled`, `work.prioritized`, `work.noted`, `artifact.attached`, `artifact.ready`). The filters are one `GET` form — the page has no `POST` — and when the read fills the 500-event cap short of the ledger cursor the page names the highest sequence it reached, says the newer events are the hidden ones, and links onward from it |

The sidebar links to the progress and events views (Events was a disabled
placeholder until [#100](https://github.com/frostyard/snowcat/issues/100)); the
inbox rail's *Events* heading opens the same page unfiltered, and the
repository board's header opens it as `/events?repository=<owner/repo>`.

The progress view is a projection only: it makes no GitHub request and adds no
queue transition. Primary items are every kind except `pr-review`,
`pr-review-fix`, and `pr-cure`; review satellites join the strip named by their
`review.originItemId`. A labeled-issue observation with no matching item is its
own awaiting-import row. Blocked and third-round review decisions are amber,
cancelled and closed-without-merge are red, and an unverified pull request is
grey while GitHub is unavailable. Attention rows appear once, above repository
groups. Completed merged and cancelled items remain visible for seven days.

A repositories index (`/repositories`) lists opted-in and declared
repositories with per-status counts from `counts(repository)`, their
enrollment badge, and a pull-request summary
(`open N · decayed N · merged today N`, linking to that repository's
[pull requests](#pull-requests) section). Unknown repositories and items are 404 inside the shell.
The board's **merged / attempts** tile reads `merged` as completed items
whose `delivery` is `merged` — a pull request Snowcat verified as merged —
over an *attempts* denominator of only the completed items that could have
delivered one: those whose own `allowedActions` include `open-pr`. That is
the item's authority rather than a list of kinds, because `open-pr` is the
only action under which a `pull-request` artifact may be reported
([spec rule 10](../specs/work-queue.md)), so a read-only discovery root, a
`pr-review` round, a settings-drift sweep, or any proposals-only item is not
a pull request that failed to merge and is left out
([#105](https://github.com/frostyard/snowcat/issues/105)). The tile's caption
(`N open · N unverified · N blocked now`) is unchanged.

Lease tokens are never read into a template; views use `withoutLeaseToken`
like the CLI. `QueueStore.counts(repository?)` and `QueueStore.children(id)`
are the two read-only additions the surface needed; neither is exposed
through MCP.

### Pull requests

Shipped with [#49](https://github.com/frostyard/snowcat/issues/49). The board
carries a *Pull requests* section under the three columns, and the
repositories index the same counts per repository, so the day's open,
decayed, and just-merged pull requests are visible without leaving the
surface.

It is a **read-only projection over the queue** — `readPullRequests(queue,
repository, now)` in [`src/surface/repositories.ts`](../../src/surface/repositories.ts),
beside `readBoard` — with no state, no schema change, no mutation, and **no
GitHub call during render**. Everything it shows is already in the store:

| Shown | Read from |
| --- | --- |
| The pull request (URL, number, title) | A completed item's `pull-request` artifact; the title is the reporting item's objective, the best source without asking GitHub. A `pr-cure` root's `cure.pullRequestUrl` contributes a pull request no item reported (foreign cure), titled by the cure root's objective |
| `state`, `headSha`, `verifiedAt`, `mergedAt` | The artifact's `verification` (`verified` or `unverified`), which `verify-artifacts` refreshes on the host timer; when several completed items report the same URL, the newest `verifiedAt` wins and each reporting item is kept |
| Decay | The `pr-cure` root bound to the current head ([ADR-0061](../adr/0061-cure-pull-requests-as-bounded-per-head-work.md)): its status and `cure.decay`, `decayed` when that root is still proposed, queued, claimed, or blocked |
| `draft` and the review gate | The artifact verification's `draft` flag, and the `pr-review` / `pr-review-fix` items bound to the URL ([ADR-0065](../adr/0065-gate-worker-pull-requests-behind-bounded-review.md)), derived by `deriveReviewState` the way the sweep reads them: `in review` / `fixing` while one is queued or claimed, `passed review` with the `gh pr ready N` hint when the current head passed and is still a draft, `needs human` (third-round block, unable-to-review, a fix that went nowhere, budget spent) with the reason; review and fix items never count as the pull request's reporters |
| Unreported | `QueueStore.repositoryUnreportedPullRequests(repository)` — the review sweep's last observation of the open pull requests GitHub lists in a gated repository that no completed item reported and no `pr-review`, `pr-review-fix`, or `pr-cure` item is bound to ([ADR-0065](../adr/0065-gate-worker-pull-requests-behind-bounded-review.md), [spec rule 53](../specs/work-queue.md)). Rendered as an **Unreported** sub-list under the open heads (number, `draft` badge, "no item reported this pull request — close it or attach it to its item", the `queue -- attach-artifact <id> <url>` hint) and counted as `unreported N` in the summary phrase only when non-zero; the inbox's *Review adjudication* group lists the same rows with the observation time, because an orphan is a human decision exactly like a `needs human` one. Stored by the sweep, read here: rendering never calls GitHub |

Open (and `unverified`) pull requests come first, highest number first, each
linking to GitHub, to the item that reported it, and to its cure item; then
what merged in the last seven days, newest merge first. Closed pull requests
and older merges are left out — the section is the operator's *now*, not a
history. The index summary counts exactly those rows: `open` is the open
list, `decayed` the open rows with an unfinished cure root, `awaiting you`
(shown only when non-zero) the open rows the review gate cannot advance or
that passed and wait to be marked ready, `merged today`
the merges since 00:00 UTC. Source lists are capped at 100 rows like the
board's columns, and the section says so when a cap is hit.

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
| Prioritize | `prioritize(id, actor, priority, reason, precondition)` ([frostyard/snowcat#1](https://github.com/frostyard/snowcat/issues/1)) | `proposed`, `queued`, `blocked` |
| Note | `note(id, actor, reason, precondition)` | any state |
| Re-verify | `refreshArtifactVerifications({repository, actor})` | completed with unverified or open artifacts |

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
against `SNOWCAT_APP_TOKEN`. The surface adds `/login` (form → HttpOnly,
SameSite=Strict cookie holding an HMAC of the token, compared in constant
time) and guards every surface route with it. `/health` stays unauthenticated
and content-free. The server binds to `127.0.0.1` unless `HOST` is set;
exposing it beyond the host is a deployment decision recorded elsewhere, not
a configuration this doc endorses. Single operator: no users, roles, or CSRF
tokens beyond SameSite cookies and same-origin form posts.

Since [ADR-0063](../adr/0063-authenticate-people-through-cloudflare-access-and-mint-mcp-tokens.md)
that is the *local mode*. In *Access mode* (`SNOWCAT_ACCESS_TEAM_DOMAIN` +
`SNOWCAT_ACCESS_AUD`) the surface has no login page: `requireSession` verifies
the Cloudflare Access assertion ([`src/auth/access.ts`](../../src/auth/access.ts):
RS256 against the team's certs, issuer, audience, expiry) and sets the
request's actor to `member:<email>`, which every mutation helper takes as a
parameter (`operator:web` remains the local-mode default); an unverified
request is `401`, never a fallback. The sidebar shows the actor. A *MCP
tokens* page (`/tokens`) lets a member mint tokens owned by their principal
(plaintext once), see last use, and revoke their own; the local mode lists
and revokes all and mints from the CLI. Its **may claim** column shows each
token's claim restriction — the work kinds a token minted with
`token mint … --kinds pr-review` may lease, or `unrestricted` — never the
hash; a restriction is set at mint time from the CLI (see
[Operating the work queue](queue-operations.md#a-review-only-client)). `/mcp` — the Streamable HTTP MCP
endpoint behind minted tokens ([`src/mcp/http.ts`](../../src/mcp/http.ts))
— lives in the same app and is expected to sit behind an Access *bypass*
policy, since the token is its credential.

### Rendering and liveness

Server-rendered HTML through a small template layer (`src/surface/html.ts`),
styled per the `frostyard-design` skill and its assets from
`frostyard/design-system` (tokens, type, components). No client-side
application framework. Liveness comes from `GET /events/stream`
([frostyard/snowcat#23](https://github.com/frostyard/snowcat/issues/23)):
Server-Sent Events, session-guarded like every surface route, that send the
current last sequence as a `cursor` event on connect, then poll
`eventsSince(cursor, {limit: 500})` every 2 seconds and emit one `event` per
ledger event (`sequence`, `type`, `workItemId`, `repository`, `kind`,
`sourceRef`, `status`, `actor`, `occurredAt` — identifying fields only, never
the payload or a lease token), with an optional `?repository=` filter and a
keep-alive comment every 25 seconds; the loop ends when the client goes away.
The inbox and repository board carry one inline script (no framework, nothing
loaded from another host) that subscribes with `EventSource`, prepends events
to the rail (cap 30), and after a `work.*`, `artifact.verified`, or
`artifact.attached` event
refetches the page's groups as fragments (`GET /?partial=stats|proposals|
blocked|unverified`, `GET /repositories/:owner/:name?partial=stats|queued|
leased|completed|pull-requests`) and swaps them in; the 30-second meta refresh survives only
inside `<noscript>`, and a browser with scripts but no `EventSource`
re-inserts it. The progress view uses the same subscriber and queue-affecting
event gate, but schedules a full-page reload no sooner than the stream's
2-second poll interval so every lifecycle strip is derived again together.
Every page prints the queue and control-plane database paths
it is reading, the same way `metadata` does.

### What it does not do

Grants, capability profiles, fleet or relationship views, process health,
restricted findings, decision types beyond admission and blocked exits,
multi-user access, and anything reachable off-host. Those remain roadmap
Phase 10 and later.

## Operational notes

- The surface runs in the same process as the Flue app, reading
  `SNOWCAT_QUEUE_DB`, `SNOWCAT_CONTROL_DB`, `SNOWCAT_ACCESS_TEAM_DOMAIN` +
  `SNOWCAT_ACCESS_AUD` (Access mode) or `SNOWCAT_APP_TOKEN` (token mode),
  `HOST`, and `PORT`. The surface fails closed (503) for every route, login
  included, only when neither Access nor the token is configured:
  `Neither Cloudflare Access (SNOWCAT_ACCESS_TEAM_DOMAIN + SNOWCAT_ACCESS_AUD)
  nor SNOWCAT_APP_TOKEN is configured on this host`. In Access mode a request
  without a valid `Cf-Access-Jwt-Assertion` gets 401 and `SNOWCAT_APP_TOKEN`
  is ignored (see [`deploy/env.example`](../../deploy/env.example)).
- Run it locally with
  `SNOWCAT_APP_TOKEN=… SNOWCAT_QUEUE_DB=/var/lib/snowcat/queue.db npm run build && npm run serve`
  and open `http://127.0.0.1:3000/`. `npm run serve`
  ([`scripts/serve.mjs`](../../scripts/serve.mjs)) starts the built
  `dist/app.mjs` bound to `HOST` (default `127.0.0.1`) and `PORT` (default
  `3000`); Flue's own `dist/server.mjs` entry honours `PORT` only and lets
  Node pick the interface, so use `serve` when the bind address matters. The
  default is loopback: exposing the surface beyond the host (a different
  `HOST`, a reverse proxy) is a deployment decision recorded with the
  deployment, not a default this doc endorses. Set `SNOWCAT_CONTROL_DB` too
  and the sidebar shows control-plane enrollment states instead of queue
  opt-ins.
- Session: `GET /login` renders the token form; `POST /login` compares the
  submitted token to `SNOWCAT_APP_TOKEN` in constant time and sets
  `snowcat_session`, an `HttpOnly; SameSite=Strict` cookie holding an
  HMAC-SHA256 of the token (never the token; `Secure` is added when the
  request itself arrived over HTTPS). Every other surface route redirects to
  `/login` without it; `POST /logout` clears it. Rotating the token
  invalidates every session. The pre-Snowcat `fluent_session` cookie is not
  read; existing local browser sessions must log in once after upgrading.
- Slice status: the shell, login, and the read-only inbox (`/`) shipped with
  [frostyard/snowcat#17](https://github.com/frostyard/snowcat/issues/17):
  stat tiles, the three decision groups, and the events rail (last 30 from
  `eventsSince`, newest first). The repositories index, repository board,
  and item page shipped read-only with
  [#18](https://github.com/frostyard/snowcat/issues/18); inbox rows,
  board rows, and event-rail entries link to `/items/:id`. The mutations
  shipped with [#19](https://github.com/frostyard/snowcat/issues/19): `POST
  /items/:id/{approve,reject,defer,requeue,cancel,prioritize,note}` and
  `POST /repositories/:owner/:name/verify-artifacts`, same-origin forms
  (SameSite=Strict cookie plus a `Sec-Fetch-Site`/`Origin` check) attributed
  `operator:web`, each carrying the rendered `status`/`updatedAt`
  precondition ([spec rule 40](../specs/work-queue.md)); a mismatch renders
  the item's current state with "this item changed since you read it" (409)
  and no mutation; success redirects back with a `?done=<event type>`
  banner. Inline on the inbox: approve/reject, requeue-with-note/cancel,
  re-verify; the item page's *Decide* card offers every action its state
  allows. `POST /items/:id/attach-artifact` joined them with
  [#35](https://github.com/frostyard/snowcat/issues/35): the completed item
  page's *Attach artifact* form calls `attachVerifiedArtifact` — GitHub is
  asked first, a rejected URL re-renders with the banner and writes nothing,
  an outage attaches `unverified` — then `QueueStore.attachArtifact` under
  the same precondition ([spec rule 41](../specs/work-queue.md)); the
  `artifact.attached` event refreshes live pages like `artifact.verified`.
  The board's repository actions shipped with
  [#24](https://github.com/frostyard/snowcat/issues/24): `POST
  /repositories/:owner/:name/{import-issues,seed-dogfood,hold,clear-hold}`
  beside `verify-artifacts` — `importLabeledIssues` (label default `snowcat`,
  optional priority; imported items land in the inbox as proposals),
  `enqueueDogfoodBatch` with the default cooldown, and
  `ControlPlaneStore.imposeRepositoryOperatorHold` /
  `clearRepositoryOperatorHold` against the `lastTransactionSequence` and
  active hold read in the same handler (a concurrent write re-renders the
  board with "the control plane changed; try again", 409); hold and clear
  render only when `SNOWCAT_CONTROL_DB` is set and the repository is declared,
  and the badge flips to `operator-held`, which the claim gate already
  respects. No batch action and nothing runs a worker. The event
  stream and live inbox/board shipped with
  [#23](https://github.com/frostyard/snowcat/issues/23) (see "Rendering and
  liveness"); the board's pull-request section and the index's per-repository
  summary shipped read-only with
  [#49](https://github.com/frostyard/snowcat/issues/49) (see "Pull requests"),
  refreshing live as the `pull-requests` partial; the meta refresh remains only as the `<noscript>` fallback. Pages inline their stylesheet (Frostyard tokens and the
  Pilothouse shell copied into [`src/surface/styles.ts`](../../src/surface/styles.ts));
  nothing is fetched from another host. Every page footer prints the queue
  and control-plane database paths.
- It opens its own store connections like any CLI process; SQLite WAL and the
  busy timeout serialize its writes with MCP servers and the CLI. Restart it
  after upgrading Snowcat for the same schema-guard reason as MCP servers.
- Decisions made in the browser appear in `queue -- show` and `events` as
  `operator:web` events; the CLI and the surface are interchangeable.
- Prerequisite before UI code lands: synchronize `frostyard-design` from
  `frostyard/core` into `.agents/skills/` (portable instruction surface,
  [ADR-0002](../adr/0002-agent-portable-instruction-surface.md)) so agents
  implementing the pages use the organization's design rules and assets.
- The runbook's ["From the browser"](queue-operations.md#from-the-browser)
  section is the operator-facing description of these views.

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
