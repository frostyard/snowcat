import { DECISION_EVENT_TYPES, EVENTS_PAGE_MAX, type EventsData } from "./events.ts";
import { html, type SafeHtml } from "./html.ts";
import { clock, document, itemPath, payloadGist, repositoryPath, shell, type PageContext } from "./pages.ts";

/**
 * The event ledger with the two filters the CLI already has: one repository
 * (`queue -- events --repository`) and operator decisions only. Read-only —
 * every row links back to the item and its board, and nothing here mutates.
 */
export function eventsPage(context: PageContext, data: EventsData): string {
  const scope = data.repository ?? "all repositories";
  return document(
    `Events · ${scope} · Snowcat`,
    shell(
      context,
      {
        title: "Events",
        eyebrow: "snowcat · event ledger",
        heading: "Events",
        active: "events",
        ...(data.repository ? { repository: data.repository } : {}),
      },
      html`${filterForm(data)}
      ${
        data.capped
          ? html`<div class="fl-error">This read filled the ${EVENTS_PAGE_MAX}-event cap, so anything older than sequence ${
              data.events.at(-1)?.sequence ?? data.since
            } in this window is not shown. Narrow it with <code>?since=</code>, or use <code>npm run queue -- events</code> for the full ledger.</div>`
          : ""
      }
      <section class="fl-group" id="events">
        <div class="fl-group-head"><h2>${data.decisions ? "Operator decisions" : "Ledger"}</h2><span>${data.events.length} ${
          data.events.length === 1 ? "event" : "events"
        } · since ${data.since} · ${scope}${data.decisions ? " · decisions only" : ""}</span></div>
        ${
          data.events.length === 0
            ? html`<p class="fl-empty">${
                data.decisions
                  ? "No operator decision was recorded in this window."
                  : "No events in this window."
              }</p>`
            : html`<div class="fl-table-wrap"><table class="fl-table"><thead><tr><th>Time</th><th class="right">Seq</th><th>Event</th><th>Item</th><th>Repository</th><th>Actor</th><th>Detail</th></tr></thead><tbody>${data.events.map(
                (event) => html`<tr>
                  <td><time datetime="${event.occurredAt}" title="${event.occurredAt}">${clock(event.occurredAt, true)}</time></td>
                  <td class="right">${event.sequence}</td>
                  <td><b>${event.type}</b></td>
                  <td><a href="${itemPath(event.workItemId)}" title="${event.workItemId}">${event.kind}</a></td>
                  <td><a href="${repositoryPath(event.repository)}">${event.repository}</a></td>
                  <td>${event.actor}</td>
                  <td class="fl-reason">${gist(event.payload)}</td>
                </tr>`,
              )}</tbody></table></div>`
        }
      </section>`,
    ),
  );
}

/**
 * The filters as one same-origin `GET` form: the sidebar's repositories and
 * the decisions toggle. A `GET` form changes nothing; there is no `POST` on
 * this page.
 */
function filterForm(data: EventsData): SafeHtml {
  return html`<form class="fl-action-grid" method="get" action="/events">
    <div class="fl-action">
      <span class="fl-action-label">Repository</span>
      <select class="fl-input" name="repository">
        <option value=""${data.repository === undefined ? " selected" : ""}>all repositories</option>
        ${data.repositories.map((slug) => html`<option value="${slug}"${data.repository === slug ? " selected" : ""}>${slug}</option>`)}
      </select>
    </div>
    <div class="fl-action">
      <span class="fl-action-label">Decisions only</span>
      <label class="fl-sub"><input type="checkbox" name="decisions" value="1"${data.decisions ? " checked" : ""}> ${DECISION_EVENT_TYPES.length} operator decision event types</label>
    </div>
    <div class="fl-action">
      <span class="fl-action-label">Since sequence</span>
      <input class="fl-input" type="number" name="since" min="0" step="1" value="${String(data.since)}" placeholder="0">
    </div>
    <div class="fl-action">
      <span class="fl-action-label">Cursor ${data.lastEventSequence}</span>
      <div class="fl-actions" style="justify-content:flex-start"><button class="ph-button" type="submit">Apply</button><a class="ph-button secondary" href="/events">Reset</a></div>
    </div>
  </form>`;
}

/** `payloadGist` prefixes with " · " for the inbox rail; the table column wants the text alone. */
function gist(payload: Record<string, unknown>): string {
  const text = payloadGist(payload);
  return text.startsWith(" · ") ? text.slice(3) : text;
}
