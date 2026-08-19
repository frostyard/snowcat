import type { ObservableWorkItem, ObservedWorkEvent } from "../queue/types.ts";
import { html, raw, type SafeHtml } from "./html.ts";
import type { AdjudicationRow, BlockedRow, InboxData, ProposalRow, SidebarRepository, UnverifiedRow } from "./inbox.ts";
import { admissionForm, exitForm, verifyForm } from "./forms.ts";
import { surfaceStylesheet } from "./styles.ts";

const REFRESH_SECONDS = 30;

/** Per-request facts every page's chrome shows: host box, sidebar, footer. */
export interface PageContext {
  queuePath: string;
  controlPlanePath?: string;
  schemaVersion: number;
  lastEventSequence: number;
  repositories: SidebarRepository[];
  /** One-line result or error banner shown under the header. */
  banner?: { tone: "ok" | "error"; text: string };
  /** The principal every mutation on this request is attributed to: `member:<email>` behind Access, `operator:web` in local mode. */
  actor: string;
}

interface View {
  title: string;
  eyebrow: string;
  heading: string;
  active: "inbox" | "repositories" | "events" | "tokens" | "none";
  /** Header-right content before Refresh / Sign out (badges, ghost buttons). */
  actions?: SafeHtml;
  refresh?: boolean;
  /** Highlight this repository in the sidebar. */
  repository?: string;
}

/** The whole document; `body` is already-safe markup produced by `html`. */
/**
 * The whole document; `body` is already-safe markup produced by `html`.
 * `refresh` pages carry the interval reload inside `<noscript>` and, when
 * `live` names a stream, the inline subscriber below; a browser with scripts
 * but no `EventSource` re-inserts the meta refresh itself.
 */
export function document(title: string, body: SafeHtml, options: { refresh?: boolean; live?: LiveOptions } = {}): string {
  return (
    "<!doctype html>" +
    html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">${
      options.refresh ? html`<noscript><meta http-equiv="refresh" content="${REFRESH_SECONDS}"></noscript>` : ""
    }<title>${title}</title><style>${raw(surfaceStylesheet)}</style></head><body>${body}${
      options.refresh ? liveScript(options.live) : ""
    }</body></html>`.value
  );
}

/** What the inline subscriber refreshes: the stream URL, the page's partial names, and an optional repository filter. */
export interface LiveOptions {
  /** Base path of the page whose `?partial=` fragments to refetch, e.g. `/` or `/repositories/o/n`. */
  page: string;
  partials: readonly string[];
  /** Only events for this repository refresh the page (the stream is filtered too). */
  repository?: string;
}

/**
 * The only script the surface ships: subscribe to `/events/stream`, prepend
 * ledger events to the rail (cap 30), and after a `work.*`,
 * `artifact.verified`, or `artifact.attached` event refetch this page's groups as HTML fragments and
 * swap them in. No framework, nothing loaded from anywhere else. Without
 * `EventSource` it re-inserts the 30-second meta refresh and stops.
 */
function liveScript(live: LiveOptions | undefined): SafeHtml {
  if (!live) return html``;
  const config = JSON.stringify({ page: live.page, partials: live.partials, repository: live.repository ?? null, refresh: REFRESH_SECONDS });
  return html`<script>${raw(LIVE_SCRIPT.replace("__CONFIG__", config.replaceAll("<", "\\u003c")))}</script>`;
}

const LIVE_SCRIPT = String.raw`(function () {
  var cfg = __CONFIG__;
  function fallback() {
    var meta = document.createElement("meta");
    meta.httpEquiv = "refresh";
    meta.content = String(cfg.refresh);
    document.head.appendChild(meta);
  }
  if (!("EventSource" in window) || !("fetch" in window)) { fallback(); return; }
  var pill = document.querySelector(".ph-live");
  var rail = document.querySelector("#events .fl-events");
  var url = "/events/stream" + (cfg.repository ? "?repository=" + encodeURIComponent(cfg.repository) : "");
  var source = new EventSource(url);
  var pending = null;
  function setPill(text, ok) {
    if (!pill) return;
    pill.lastChild.nodeValue = text;
    pill.classList.toggle("stale", !ok);
  }
  function refetch() {
    pending = null;
    cfg.partials.forEach(function (name) {
      var target = document.getElementById(name);
      if (!target) return;
      fetch(cfg.page + "?partial=" + name, { credentials: "same-origin", headers: { Accept: "text/html" } })
        .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
        .then(function (fragment) { var current = document.getElementById(name); if (current) current.outerHTML = fragment; })
        .catch(function () { setPill("Live · retrying", false); });
    });
  }
  function scheduleRefetch() { if (pending === null) pending = setTimeout(refetch, 250); }
  function prepend(ev) {
    if (!rail) return;
    var empty = rail.querySelector(".fl-empty"); if (empty) empty.remove();
    var row = document.createElement("div"); row.className = "fl-event";
    var time = document.createElement("time"); time.dateTime = ev.occurredAt; time.title = ev.occurredAt; time.textContent = ev.occurredAt.slice(11, 19);
    var body = document.createElement("div");
    var head = document.createElement("div"); head.className = "fl-event-head";
    var type = document.createElement("b"); type.textContent = ev.type;
    var link = document.createElement("a"); link.href = "/items/" + encodeURIComponent(ev.workItemId); link.title = ev.workItemId; link.textContent = ev.kind;
    head.appendChild(type); head.appendChild(link);
    var small = document.createElement("small"); small.title = ev.repository; small.textContent = ev.actor;
    body.appendChild(head); body.appendChild(small);
    row.appendChild(time); row.appendChild(body);
    rail.insertBefore(row, rail.firstChild);
    while (rail.children.length > 30) rail.removeChild(rail.lastChild);
    var caption = document.querySelector("#events .fl-group-head span");
    if (caption) caption.textContent = "live · sequence " + ev.sequence + (cfg.repository ? " · " + cfg.repository : " · all repositories");
  }
  source.addEventListener("cursor", function () { setPill("Live · stream", true); });
  source.addEventListener("event", function (message) {
    var ev;
    try { ev = JSON.parse(message.data); } catch (e) { return; }
    if (cfg.repository && ev.repository !== cfg.repository) return;
    prepend(ev);
    if (/^work\./.test(ev.type) || /^artifact\.(verified|attached)$/.test(ev.type)) scheduleRefetch();
  });
  source.onerror = function () { setPill("Live · reconnecting", false); };
})();`;

export function loginPage(options: { error?: string }): string {
  return document(
    "Sign in · Snowcat",
    html`<div class="ph-login-body"><div class="ph-login"><div class="ph-login-panel">
      ${brand()}
      <div class="ph-login-copy">
        <h1>Sign in to the <em>operator inbox.</em></h1>
        <p>This is the single-operator surface over Snowcat's queue on this host. It shows what needs you and, once mutations land, lets you decide exactly what the CLI can. Enter the host's <code>SNOWCAT_APP_TOKEN</code>.</p>
        ${options.error ? html`<div class="fl-error" role="alert">${options.error}</div>` : ""}
        <form class="ph-login-form" method="post" action="/login">
          <label>Operator token<input type="password" name="token" autocomplete="current-password" required autofocus></label>
          <button class="ph-button" type="submit" style="justify-content:center;min-height:43px;width:100%">Sign in</button>
        </form>
      </div>
      <p class="ph-login-foot">Loopback-only by default. Same store as the CLI. No lease token is ever rendered.</p>
    </div><div class="ph-login-art"><div><span>snowcat · operator surface</span><strong>What needs you, and nothing else.</strong></div></div></div></div>`,
  );
}

export interface TokensView {
  /** The signed-in principal's own tokens (a member) or every token (local operator mode). */
  tokens: Array<{ id: string; owner: string; client: string; kinds?: string[]; createdAt: string; lastUsedAt?: string; revokedAt?: string; revokedBy?: string }>;
  /** Minting needs a member identity; the local `operator:web` mode lists and revokes only (mint from the CLI). */
  canMint: boolean;
  /** Shown exactly once, right after minting. */
  minted?: { token: string; client: string };
}

/**
 * MCP tokens (ADR-0063): mint one per client, see when each was last used and
 * which work kinds it may claim, revoke. The plaintext appears once, on the
 * response to the mint, and is never stored or shown again. A restriction is
 * minted from the CLI (`token mint … --kinds pr-review`); the page shows it.
 */
export function tokensPage(context: PageContext, view: TokensView): string {
  const rows = view.tokens.map(
    (token) => html`<tr class="${token.revokedAt ? "fl-muted" : ""}">
      <td><code>${token.id}</code></td>
      <td>${token.client}</td>
      <td>${token.owner}</td>
      <td>${token.kinds ? token.kinds.join(", ") : "unrestricted"}</td>
      <td>${token.createdAt.slice(0, 16).replace("T", " ")}</td>
      <td>${token.lastUsedAt ? token.lastUsedAt.slice(0, 16).replace("T", " ") : "never"}</td>
      <td>${
        token.revokedAt
          ? html`revoked ${token.revokedAt.slice(0, 16).replace("T", " ")} by ${token.revokedBy ?? "?"}`
          : html`<form class="fl-inline" method="post" action="/tokens/${token.id}/revoke"><button class="ph-button reject" type="submit">Revoke</button></form>`
      }</td>
    </tr>`,
  );
  const minted = view.minted
    ? html`<div class="fl-banner" role="status"><strong>Token for ${view.minted.client} — shown once, copy it now:</strong><br><code class="fl-token">${view.minted.token}</code><br><small class="fl-sub">Put it in the client's MCP configuration as <code>Authorization: Bearer …</code> against <code>/mcp</code>. Snowcat stores only its hash.</small></div>`
    : "";
  const mint = view.canMint
    ? html`<form class="fl-action" method="post" action="/tokens/mint"><span class="fl-action-label">Mint a token</span><input class="fl-input" name="client" placeholder="client name, e.g. codex-laptop" maxlength="100" required><button class="ph-button" type="submit">Mint</button></form>`
    : html`<p class="fl-sub">You are ${context.actor}; minting needs a signed-in member. Mint from the CLI: <code>npm run queue -- token mint member:&lt;email&gt; "&lt;client&gt;"</code>.</p>`;
  return document(
    "MCP tokens · Snowcat",
    shell(
      context,
      { title: "MCP tokens", eyebrow: "snowcat · identity", heading: "MCP tokens", active: "tokens" },
      html`<section class="fl-group" id="tokens"><div class="fl-group-head"><h2>Tokens</h2><span>each identifies one client of one member; a token grants nothing by itself</span></div>
        ${minted}
        ${mint}
        <div class="fl-table-wrap"><table class="fl-table"><thead><tr><th>id</th><th>client</th><th>owner</th><th>may claim</th><th>minted</th><th>last used</th><th></th></tr></thead><tbody>${
          rows.length === 0 ? html`<tr><td colspan="7" class="fl-empty">No tokens yet.</td></tr>` : rows
        }</tbody></table></div>
      </section>`,
    ),
  );
}

export function unavailablePage(message: string): string {
  return document(
    "Unavailable · Snowcat",
    html`<div class="ph-login-body"><div class="ph-card" style="max-width:520px"><div class="ph-eyebrow"><i></i>snowcat · operator surface</div><h1 style="font-size:20px;letter-spacing:-.04em;margin:0 0 8px">Unavailable</h1><p class="fl-reason" style="font-size:12px">${message}</p></div></div>`,
  );
}

/** The inbox fragments the live script refetches; each renders one element with that id. */
export const inboxPartials = ["stats", "proposals", "blocked", "unverified", "adjudication"] as const;
export type InboxPartial = (typeof inboxPartials)[number];

export function inboxPartial(data: InboxData, partial: InboxPartial): string {
  switch (partial) {
    case "stats":
      return statRow(data).value;
    case "proposals":
      return proposalsGroup(data.proposals).value;
    case "blocked":
      return blockedGroup(data.blocked).value;
    case "unverified":
      return unverifiedGroup(data.unverified).value;
    case "adjudication":
      return adjudicationGroup(data.adjudication).value;
  }
}

export function inboxPage(context: PageContext, data: InboxData): string {
  return document(
    "Inbox · Snowcat",
    shell(
      context,
      { title: "Inbox", eyebrow: "snowcat · operator inbox", heading: "Needs you", active: "inbox", refresh: true },
      html`${statRow(data)}
      ${data.truncated.length > 0 ? html`<div class="fl-error">Showing the first 100 rows of: ${data.truncated.join(", ")}. Use the CLI for the full list.</div>` : ""}
      <div class="fl-columns"><div class="fl-stack">
        ${proposalsGroup(data.proposals)}
        ${blockedGroup(data.blocked)}
        ${unverifiedGroup(data.unverified)}
        ${adjudicationGroup(data.adjudication)}
      </div>${eventsRail(data.events, data.eventsSince)}</div>`,
    ),
    { refresh: true, live: { page: "/", partials: inboxPartials } },
  );
}

/** A 404 for an unknown item or repository, inside the shell so navigation stays available. */
export function notFoundPage(context: PageContext, what: string): string {
  return document(
    "Not found · Snowcat",
    shell(
      context,
      { title: "Not found", eyebrow: "snowcat · operator surface", heading: "Not found", active: "none" },
      html`<div class="ph-card"><p class="fl-reason" style="font-size:12px;max-width:none">${what}</p></div>`,
    ),
  );
}

export function shell(context: PageContext, view: View, main: SafeHtml): SafeHtml {
  return html`<div class="ph-shell">
    <aside class="ph-sidebar">
      ${brand()}
      <div class="fl-host"><span>Host</span><code title="${context.queuePath}">${directoryOf(context.queuePath)} · schema v${context.schemaVersion}</code></div>
      <nav class="ph-nav">
        <div class="ph-nav-group">Queue</div>
        <a class="ph-nav-link${view.active === "inbox" ? " active" : ""}" href="/"><span class="ph-nav-num">01</span>Inbox</a>
        <a class="ph-nav-link${view.active === "repositories" ? " active" : ""}" href="/repositories"><span class="ph-nav-num">02</span>Repositories</a>
        <a class="ph-nav-link${view.active === "events" ? " active" : ""}" href="/events"><span class="ph-nav-num">03</span>Events</a>
        <a class="ph-nav-link${view.active === "tokens" ? " active" : ""}" href="/tokens"><span class="ph-nav-num">04</span>MCP tokens</a>
        <div class="ph-nav-group">${context.controlPlanePath ? "Enrolled" : "Opted in"}</div>
        ${
          context.repositories.length === 0
            ? html`<span class="fl-repo"><span></span>none</span>`
            : context.repositories.map(
                (repository) =>
                  html`<a class="fl-repo${view.repository?.toLowerCase() === repository.slug.toLowerCase() ? " active" : ""}" href="${repositoryPath(repository.slug)}" title="${repository.state}"><span class="${repository.enrolled ? "ok" : ""}"></span>${repository.slug}${
                    repository.enrolled || repository.state === "opted-in" ? "" : html`<em>${repository.state}</em>`
                  }</a>`,
              )
        }
      </nav>
      <div class="fl-side-foot">${context.actor}<br>events cursor ${context.lastEventSequence}</div>
    </aside>
    <main class="ph-main">
      <div class="ph-topbar">
        <div><div class="ph-eyebrow"><i></i>${view.eyebrow}</div><h1>${view.heading}</h1></div>
        <div class="ph-topbar-actions">
          ${view.actions ?? ""}
          ${view.refresh ? html`<span class="ph-live"><span></span>Live · ${REFRESH_SECONDS}s</span>` : ""}
          <a class="ph-button secondary" href="">Refresh</a>
          <form class="fl-logout" method="post" action="/logout"><button class="ph-button secondary" type="submit">Sign out</button></form>
        </div>
      </div>
      ${context.banner ? html`<div class="${context.banner.tone === "ok" ? "fl-banner" : "fl-error"}" role="status">${context.banner.text}</div>` : ""}
      ${main}
      <footer class="fl-footer"><span>queue ${context.queuePath}</span><span>control-plane ${context.controlPlanePath ?? "not configured"}</span><span>times UTC</span></footer>
    </main>
  </div>`;
}

export function repositoryPath(slug: string): string {
  return `/repositories/${slug.split("/").map(encodeURIComponent).join("/")}`;
}

export function itemPath(id: string): string {
  return `/items/${encodeURIComponent(id)}`;
}

function brand(): SafeHtml {
  return html`<a class="ph-brand" href="/"><span class="flake">❄</span><span><strong>snowcat</strong><small>operator surface</small></span></a>`;
}

function statRow(data: InboxData): SafeHtml {
  const tile = (label: string, value: number, caption: string) =>
    html`<div class="ph-stat"><span>${label}</span><strong>${value}</strong><small>${caption}</small></div>`;
  return html`<div class="ph-stats" id="stats">
    ${tile("Proposals", data.stats.proposals, "awaiting admission")}
    ${tile("Blocked", data.stats.blocked, "needs an operator exit")}
    ${tile("Unverified artifacts", data.stats.unverified, "GitHub could not be asked")}
    ${tile("Review adjudication", data.stats.adjudication, "PRs the gate cannot advance or never saw")}
    ${tile("Leased now", data.stats.leased, data.stats.leasedCaption)}
  </div>`;
}

export function group(title: string, count: number, table: SafeHtml, empty: string, extraId?: string): SafeHtml {
  return html`<section class="fl-group"${extraId ? html` id="${extraId}"` : ""}><div class="fl-group-head"><h2>${title}</h2><span>${count} ${count === 1 ? "item" : "items"}</span></div>${
    count === 0 ? html`<p class="fl-empty">${empty}</p>` : table
  }</section>`;
}

function proposalsGroup(rows: ProposalRow[]): SafeHtml {
  return group(
    "Proposals awaiting admission",
    rows.length,
    html`<table class="fl-table"><thead><tr><th>Proposal</th><th>Repository</th><th>Authority</th><th class="right">Decide</th></tr></thead><tbody>${rows.map(
      (row) => html`<tr>
        <td style="max-width:520px"><div class="fl-name">${objective(row.item)}<small>${row.item.kind}${row.parent ? ` · child of ${row.parent.kind}` : " · root"} · proposed ${clock(row.item.createdAt)} by ${row.item.createdBy}</small></div>${
          row.finding ? html`<div class="fl-finding"><span>Finding</span>${row.finding}</div>` : ""
        }</td>
        <td><a href="${repositoryPath(row.item.repository)}">${row.item.repository}</a><small class="fl-sub">${row.repositoryState ?? "not in control plane"}</small></td>
        <td><div class="fl-badges">${row.item.allowedActions.map((action) => html`<span class="ph-badge">${action}</span>`)}</div><small class="fl-sub">${
          row.parent ? "inside parent ceiling" : `delegable: ${row.item.delegableActions.length}`
        }</small></td>
        <td class="right">${admissionForm(row.item, "/", { open: true })}</td>
      </tr>`,
    )}</tbody></table>`,
    "Nothing is waiting for admission.",
    "proposals",
  );
}

function blockedGroup(rows: BlockedRow[]): SafeHtml {
  return group(
    "Blocked — needs an operator exit",
    rows.length,
    html`<table class="fl-table"><thead><tr><th>Item</th><th>Reason from the worker</th><th class="right">Exit</th></tr></thead><tbody>${rows.map(
      (row) => html`<tr>
        <td style="width:260px"><div class="fl-name"><strong><a href="${itemPath(row.item.id)}">${row.item.kind}</a></strong><small>${row.item.repository}${row.parent ? ` · child of ${row.parent.kind}` : ""}${
          row.blockedAt ? ` · blocked ${clock(row.blockedAt)}` : ""
        }${row.blockedBy ? ` by ${row.blockedBy}` : ""}</small></div><small class="fl-sub">${row.item.objective}</small></td>
        <td class="fl-reason">${row.reason}</td>
        <td class="right">${exitForm(row.item, "/", { open: true })}</td>
      </tr>`,
    )}</tbody></table>`,
    "No blocked work.",
    "blocked",
  );
}

function unverifiedGroup(rows: UnverifiedRow[]): SafeHtml {
  return group(
    "Unverified artifacts",
    rows.length,
    html`<table class="fl-table"><thead><tr><th>Item</th><th>Artifact</th><th>Why</th><th class="right"></th></tr></thead><tbody>${rows.map(
      (row) => html`<tr>
        <td><div class="fl-name">${objective(row.item)}<small>${row.item.kind} · completed ${clock(row.item.updatedAt)}${row.completedBy ? ` · ${row.completedBy}` : ""}</small></div></td>
        <td><span class="ph-version">${artifactLabel(row.artifact.kind, row.artifact.url)}</span><small class="fl-sub"><a href="${row.artifact.url}" rel="noreferrer noopener">${row.artifact.url}</a></small></td>
        <td class="fl-reason"><span class="ph-badge warn">unverified</span> ${row.artifact.verification.reason}<small class="fl-sub">attempted ${clock(row.artifact.verification.attemptedAt, true)}</small></td>
        <td class="right"><div class="fl-actions">${verifyForm(row.item.repository, "/")}<a class="ph-button secondary" href="${itemPath(row.item.id)}">Open</a></div></td>
      </tr>`,
    )}</tbody></table>`,
    "Every issue and pull-request artifact has been verified against GitHub.",
    "unverified",
  );
}

/**
 * Pull requests in review-gated repositories that only you can move on
 * (ADR-0065): the gate's own dead ends and passed-but-still-draft heads, and
 * the ones the last sweep found that no item reported — outside the gate
 * until you close them or attach them to their item.
 */
function adjudicationGroup(rows: AdjudicationRow[]): SafeHtml {
  return group(
    "Review adjudication — draft pull requests waiting for you",
    rows.length,
    html`<table class="fl-table"><thead><tr><th>Pull request</th><th>Repository</th><th>Review gate</th><th class="right"></th></tr></thead><tbody>${rows.map((row) => {
      if (row.kind === "unreported") {
        return html`<tr>
        <td><div class="fl-name"><strong><a href="${row.pullRequest.url}" rel="noreferrer noopener">#${row.pullRequest.number}</a> <span>no item reported this pull request</span></strong><small>${
          row.pullRequest.draft ? "draft · " : ""
        }${row.pullRequest.createdAt ? `opened ${clock(row.pullRequest.createdAt)} · ` : ""}observed ${clock(row.observedAt, true)}</small></div></td>
        <td><a href="${repositoryPath(row.repository)}">${row.repository}</a></td>
        <td class="fl-reason"><span class="ph-badge warn">unreported</span> outside the gate — close it, or bring it under the gate: <code>npm run queue -- attach-artifact &lt;id&gt; ${row.pullRequest.url}</code></td>
        <td class="right"><a class="ph-button secondary" href="${row.pullRequest.url}" rel="noreferrer noopener">Open on GitHub</a></td>
      </tr>`;
      }
      const review = row.pullRequest.review!;
      return html`<tr>
        <td><div class="fl-name"><strong><a href="${row.pullRequest.url}" rel="noreferrer noopener">${row.pullRequest.number === undefined ? "pull request" : `#${row.pullRequest.number}`}</a> <span>${row.pullRequest.title}</span></strong><small>head ${row.pullRequest.headSha ? row.pullRequest.headSha.slice(0, 7) : "?"}${row.pullRequest.draft ? " · draft" : ""}</small></div></td>
        <td><a href="${repositoryPath(row.repository)}">${row.repository}</a></td>
        <td class="fl-reason">${
          review.readyToMark
            ? html`<span class="ph-badge ok">passed</span> round ${review.round} · mark it ready: <code>gh pr ready ${row.pullRequest.number ?? ""}</code>`
            : html`<span class="ph-badge danger">needs human</span> round ${review.round}${review.decision ? ` · ${review.decision}` : ""}${review.reason ? ` · ${review.reason}` : ""}`
        }</td>
        <td class="right"><a class="ph-button secondary" href="${itemPath(review.itemId)}">Open ${review.kind}</a></td>
      </tr>`;
    })}</tbody></table>`,
    "No review-gated pull request is waiting for you.",
    "adjudication",
  );
}

function eventsRail(events: ObservedWorkEvent[], since: number): SafeHtml {
  return html`<aside class="fl-group" id="events"><div class="fl-group-head"><h2><a href="/events">Events</a></h2><span>since ${since} · all repositories</span></div><div class="fl-events">${
    events.length === 0
      ? html`<p class="fl-empty">No events yet.</p>`
      : events.map(
          (event) => html`<div class="fl-event"><time datetime="${event.occurredAt}" title="${event.occurredAt}">${clock(event.occurredAt, true)}</time><div><div class="fl-event-head"><b>${event.type}</b><a href="${itemPath(event.workItemId)}" title="${event.workItemId}">${event.kind}</a></div><small title="${event.repository}">${event.actor}${payloadGist(event.payload)}</small></div></div>`,
        )
  }</div></aside>`;
}

/** Objective split at its first ": " like the artboard: the subject bold, the rest muted. */
export function objective(item: ObservableWorkItem): SafeHtml {
  const text = item.objective;
  const split = text.indexOf(": ");
  if (split === -1 || split > 80) return html`<strong>${text}</strong>`;
  return html`<strong>${text.slice(0, split + 1)} <span>${text.slice(split + 2)}</span></strong>`;
}

export function payloadGist(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof payload.reason === "string") parts.push(payload.reason);
  if (typeof payload.summary === "string") parts.push(payload.summary);
  if (typeof payload.priority === "number") {
    parts.push(typeof payload.previous === "number" ? `priority ${payload.previous} → ${payload.priority}` : `priority ${payload.priority}`);
  }
  if (typeof payload.leaseExpiresAt === "string") parts.push(`lease until ${clock(payload.leaseExpiresAt, true)}`);
  if (typeof payload.sourceRef === "string") parts.push(payload.sourceRef);
  if (typeof payload.parentId === "string") parts.push(`parent ${payload.parentId.slice(0, 8)}`);
  if (Array.isArray(payload.artifacts)) parts.push(`${payload.artifacts.length} artifacts`);
  if (Array.isArray(payload.followUpIds)) parts.push(`${payload.followUpIds.length} follow-ups`);
  if (typeof payload.url === "string" && typeof payload.status === "string") {
    const label = artifactLabel(typeof payload.kind === "string" ? payload.kind : "artifact", payload.url);
    const state = typeof payload.state === "string" ? payload.state : payload.status;
    parts.push(typeof payload.previousState === "string" && payload.previousState !== state ? `${label} ${payload.previousState} → ${state}` : `${label} ${state}`);
  }
  if (parts.length === 0) return "";
  const gist = parts.join(" · ");
  return ` · ${gist.length > 90 ? `${gist.slice(0, 89)}…` : gist}`;
}

export function artifactLabel(kind: string, url: string): string {
  const match = /\/(pull|issues)\/(\d+)(?:[/?#]|$)/.exec(url);
  if (match) return `${match[1] === "pull" ? "PR" : "issue"} #${match[2]}`;
  return kind;
}

/** UTC wall clock from an ISO timestamp: `HH:MM` or `HH:MM:SS`. */
export function clock(iso: string, seconds = false): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().slice(11, seconds ? 19 : 16);
}

function directoryOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? path : path.slice(0, cut);
}
