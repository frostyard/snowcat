import type { ObservableWorkItem, ObservedWorkEvent } from "../queue/types.ts";
import { html, raw, type SafeHtml } from "./html.ts";
import type { BlockedRow, InboxData, ProposalRow, SidebarRepository, UnverifiedRow } from "./inbox.ts";
import { surfaceStylesheet } from "./styles.ts";

const REFRESH_SECONDS = 30;

/** Per-request facts every page's chrome shows: host box, sidebar, footer. */
export interface PageContext {
  queuePath: string;
  controlPlanePath?: string;
  schemaVersion: number;
  lastEventSequence: number;
  repositories: SidebarRepository[];
}

interface View {
  title: string;
  eyebrow: string;
  heading: string;
  active: "inbox" | "repositories" | "none";
  /** Header-right content before Refresh / Sign out (badges, ghost buttons). */
  actions?: SafeHtml;
  refresh?: boolean;
  /** Highlight this repository in the sidebar. */
  repository?: string;
}

/** The whole document; `body` is already-safe markup produced by `html`. */
export function document(title: string, body: SafeHtml, options: { refresh?: boolean } = {}): string {
  return (
    "<!doctype html>" +
    html`<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer">${
      options.refresh ? html`<meta http-equiv="refresh" content="${REFRESH_SECONDS}">` : ""
    }<title>${title}</title><style>${raw(surfaceStylesheet)}</style></head><body>${body}</body></html>`.value
  );
}

export function loginPage(options: { error?: string }): string {
  return document(
    "Sign in · Fluent",
    html`<div class="ph-login-body"><div class="ph-login"><div class="ph-login-panel">
      ${brand()}
      <div class="ph-login-copy">
        <h1>Sign in to the <em>operator inbox.</em></h1>
        <p>This is the single-operator surface over Fluent's queue on this host. It shows what needs you and, once mutations land, lets you decide exactly what the CLI can. Enter the host's <code>FLUENT_APP_TOKEN</code>.</p>
        ${options.error ? html`<div class="fl-error" role="alert">${options.error}</div>` : ""}
        <form class="ph-login-form" method="post" action="/login">
          <label>Operator token<input type="password" name="token" autocomplete="current-password" required autofocus></label>
          <button class="ph-button" type="submit" style="justify-content:center;min-height:43px;width:100%">Sign in</button>
        </form>
      </div>
      <p class="ph-login-foot">Loopback-only by default. Same store as the CLI. No lease token is ever rendered.</p>
    </div><div class="ph-login-art"><div><span>fluent · operator surface</span><strong>What needs you, and nothing else.</strong></div></div></div></div>`,
  );
}

export function unavailablePage(message: string): string {
  return document(
    "Unavailable · Fluent",
    html`<div class="ph-login-body"><div class="ph-card" style="max-width:520px"><div class="ph-eyebrow"><i></i>fluent · operator surface</div><h1 style="font-size:20px;letter-spacing:-.04em;margin:0 0 8px">Unavailable</h1><p class="fl-reason" style="font-size:12px">${message}</p></div></div>`,
  );
}

export function inboxPage(context: PageContext, data: InboxData): string {
  return document(
    "Inbox · Fluent",
    shell(
      context,
      { title: "Inbox", eyebrow: "fluent · operator inbox", heading: "Needs you", active: "inbox", refresh: true },
      html`${statRow(data)}
      ${data.truncated.length > 0 ? html`<div class="fl-error">Showing the first 100 rows of: ${data.truncated.join(", ")}. Use the CLI for the full list.</div>` : ""}
      <div class="fl-columns"><div class="fl-stack">
        ${proposalsGroup(data.proposals)}
        ${blockedGroup(data.blocked)}
        ${unverifiedGroup(data.unverified)}
      </div>${eventsRail(data.events, data.eventsSince)}</div>`,
    ),
    { refresh: true },
  );
}

/** A 404 for an unknown item or repository, inside the shell so navigation stays available. */
export function notFoundPage(context: PageContext, what: string): string {
  return document(
    "Not found · Fluent",
    shell(
      context,
      { title: "Not found", eyebrow: "fluent · operator surface", heading: "Not found", active: "none" },
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
        <span class="ph-nav-link disabled" title="Events page — later slice"><span class="ph-nav-num">03</span>Events</span>
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
      <div class="fl-side-foot">operator:web<br>events cursor ${context.lastEventSequence}</div>
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
  return html`<a class="ph-brand" href="/"><span class="flake">❄</span><span><strong>fluent</strong><small>operator surface</small></span></a>`;
}

function statRow(data: InboxData): SafeHtml {
  const tile = (label: string, value: number, caption: string) =>
    html`<div class="ph-stat"><span>${label}</span><strong>${value}</strong><small>${caption}</small></div>`;
  return html`<div class="ph-stats">
    ${tile("Proposals", data.stats.proposals, "awaiting admission")}
    ${tile("Blocked", data.stats.blocked, "needs an operator exit")}
    ${tile("Unverified artifacts", data.stats.unverified, "GitHub could not be asked")}
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
        <td class="right"><div class="fl-actions"><button class="ph-button" disabled title="Mutations land in the next slice">Approve</button><button class="ph-button reject" disabled title="Mutations land in the next slice">Reject</button><a class="ph-button secondary" href="${itemPath(row.item.id)}">Open</a></div><small class="fl-sub">Approve will carry status=proposed · updatedAt ${clock(row.item.updatedAt, true)} — refused if the item moved</small></td>
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
        <td class="right"><div class="fl-exit"><div class="fl-actions"><button class="ph-button" disabled title="Mutations land in the next slice">Requeue with note</button><button class="ph-button reject" disabled title="Mutations land in the next slice">Cancel</button><a class="ph-button secondary" href="${itemPath(row.item.id)}">Open</a></div><textarea class="fl-note" disabled placeholder="Note for the next lease (carried on the item)"></textarea></div></td>
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
        <td class="right"><div class="fl-actions"><button class="ph-button secondary" disabled title="Re-verify lands in the next slice">Re-verify</button><a class="ph-button secondary" href="${itemPath(row.item.id)}">Open</a></div></td>
      </tr>`,
    )}</tbody></table>`,
    "Every issue and pull-request artifact has been verified against GitHub.",
    "unverified",
  );
}

function eventsRail(events: ObservedWorkEvent[], since: number): SafeHtml {
  return html`<aside class="fl-group" id="events"><div class="fl-group-head"><h2>Events</h2><span>since ${since} · all repositories</span></div><div class="fl-events">${
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
