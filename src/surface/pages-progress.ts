import { html, raw, type SafeHtml } from "./html.ts";
import { clock, document, itemPath, shell, type PageContext } from "./pages.ts";
import { progressStages, type ProgressData, type ProgressRow, type ProgressStage } from "./progress-state.ts";

const LABELS: Record<ProgressStage, string> = {
  "awaiting-import": "Awaiting import",
  proposed: "Proposed",
  queued: "Queued",
  working: "Working",
  "pr-open": "PR open",
  review: "Review",
  "awaiting-merge": "Awaiting merge",
  merged: "Merged",
};

export function progressPage(context: PageContext, data: ProgressData): string {
  const body = html`
    ${raw(`<!--
THESIS: One horizontal lifecycle makes every item’s present state and next wait legible; it refuses a status-card dashboard.
OWN-WORLD: Frostyard Pilothouse ink, ice-blue rails, square state markers, and compact operator typography.
STORY: Scan attention first, then repository lanes; open an item only when its stopped or active stage needs context.
FIRST VIEWPORT: Attention is pinned below the header, followed by repository groups whose strips carry all eight stages.
FORM: An operations timeline extended from the incumbent queue shell; no new visual world or external asset.
-->`)}
    <div class="fl-progress-summary" aria-label="Progress summary">
      <span><strong>${data.attention.length}</strong> need attention</span>
      <span><strong>${data.active}</strong> active now</span>
      <span><strong>${data.total}</strong> visible</span>
    </div>
    ${
      data.truncated.length > 0
        ? html`<div class="fl-error">Showing at most 100 ${data.truncated.join(", ")} items — the most recently updated ones for completed and cancelled. Use the CLI for the full history.</div>`
        : ""
    }
    ${
      data.attention.length > 0
        ? progressGroup("Needs attention", "amber and red stops · newest first", data.attention, "attention")
        : ""
    }
    ${
      data.repositories.length === 0
        ? html`<section class="fl-group"><p class="fl-empty">No current progress to show. Labeled issues appear here after the next successful import.</p></section>`
        : data.repositories.map((group) => progressGroup(group.repository, `${group.rows.length} current`, group.rows))
    }
  `;
  return document(
    "Progress · Snowcat",
    shell(context, { title: "Progress", eyebrow: "snowcat · delivery progress", heading: "Progress", active: "progress", refresh: true }, body),
    { refresh: true },
  );
}

function progressGroup(title: string, caption: string, rows: ProgressRow[], id?: string): SafeHtml {
  return html`<section class="fl-group fl-progress-group"${id ? html` id="${id}"` : ""}>
    <div class="fl-group-head"><h2>${title}</h2><span>${caption}</span></div>
    <div class="fl-progress-rows">${rows.map(progressRow)}</div>
  </section>`;
}

function progressRow(row: ProgressRow): SafeHtml {
  const current = progressStages.indexOf(row.stage);
  const title = row.item
    ? html`<a href="${itemPath(row.item.id)}">${row.title}</a>`
    : html`<a href="${row.observation!.url}">${row.title}</a>`;
  return html`<article class="fl-progress-row" data-progress-key="${row.key}">
    <header>
      <div class="fl-progress-name"><strong>${title}</strong><small>${row.repository} · ${
        row.item ? `${row.item.kind} · updated ${clock(row.updatedAt, true)}` : `labeled issue · seen ${clock(row.updatedAt, true)}`
      }</small></div>
      ${row.badge ? html`<span class="fl-progress-badge ${row.badge.tone}" title="${row.badge.reason}">${row.badge.label}</span>` : ""}
    </header>
    <div class="fl-progress-scroll"><ol class="fl-stage-strip" aria-label="Progress for ${row.title}">
      ${progressStages.map((stage, index) => {
        const isCurrent = index === current;
        const classes = [
          index < current ? "complete" : "",
          isCurrent ? "current" : "",
          isCurrent && row.active ? "active" : "",
          isCurrent && row.badge ? `stop-${row.badge.tone}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        return html`<li class="${classes}"><span class="fl-stage-mark" aria-hidden="true"></span><b>${LABELS[stage]}</b>${
          isCurrent && row.waiting ? html`<small class="fl-waiting-chip">${row.waiting}</small>` : ""
        }</li>`;
      })}
    </ol></div>
  </article>`;
}
