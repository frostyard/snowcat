import { html, raw, type SafeHtml } from "./html.ts";
import { admissionForm, exitForm } from "./forms.ts";
import { clock, document, itemPath, shell, type PageContext } from "./pages.ts";
import {
  progressPath,
  progressStages,
  progressSummaryBuckets,
  type ProgressData,
  type ProgressRow,
  type ProgressStage,
  type ProgressSummaryBucket,
} from "./progress-state.ts";

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

const SUMMARY_LABELS: Record<ProgressSummaryBucket, string> = {
  "awaiting-import": "awaiting import",
  proposed: "proposed",
  queued: "queued",
  working: "working",
  "in-review": "in review",
  "awaiting-merge": "awaiting merge",
};

export function progressPage(context: PageContext, data: ProgressData): string {
  const filterRepository = data.filter.repository;
  const view = data.filter.view;
  const chipTarget = progressPath({ ...(filterRepository ? { repository: filterRepository } : {}), view: "all" });
  const body = html`
    ${raw(`<!--
THESIS: One horizontal lifecycle makes every item’s present state and next wait legible; it refuses a status-card dashboard.
OWN-WORLD: Frostyard Pilothouse ink, ice-blue rails, square state markers, and compact operator typography.
STORY: Scan attention first, then repository lanes; open an item only when its stopped or active stage needs context.
FIRST VIEWPORT: Attention is pinned below the header, followed by repository groups whose strips carry all eight stages.
FORM: An operations timeline extended from the incumbent queue shell; no new visual world or external asset.
-->`)}
    <div class="fl-progress-summary" aria-label="Progress summary">
      ${progressSummaryBuckets.map(
        (bucket) =>
          html`<a data-progress-summary-bucket="${bucket}" href="${chipTarget}"><strong>${data.summary[bucket]}</strong> ${SUMMARY_LABELS[bucket]}</a>`,
      )}
      <a data-progress-summary-bucket="attention" href="${chipTarget}"><strong>${data.attention.length}</strong> need attention</a>
    </div>
    <div class="fl-progress-filters">
      <nav class="fl-progress-tabs" aria-label="Filter by repository">
        <a class="ph-nav-link${filterRepository === undefined ? " active" : ""}"${filterRepository === undefined ? html` aria-current="page"` : ""} href="${progressPath({ view })}">All</a>
        ${context.repositories.map((repository) => {
          const current = filterRepository !== undefined && repository.slug.toLowerCase() === filterRepository.toLowerCase();
          return html`<a class="ph-nav-link${current ? " active" : ""}"${current ? html` aria-current="page"` : ""} href="${progressPath({ repository: repository.slug, view })}">${repository.slug}</a>`;
        })}
      </nav>
      <nav class="fl-progress-views" aria-label="Choose a view">
        <a class="ph-nav-link${view === "all" ? " active" : ""}"${view === "all" ? html` aria-current="page"` : ""} href="${progressPath({ ...(filterRepository ? { repository: filterRepository } : {}), view: "all" })}">Lanes</a>
        <a class="ph-nav-link${view === "active" ? " active" : ""}"${view === "active" ? html` aria-current="page"` : ""} href="${progressPath({ ...(filterRepository ? { repository: filterRepository } : {}), view: "active" })}">Working now</a>
      </nav>
    </div>
    ${
      data.truncated.length > 0
        ? html`<div class="fl-error">Showing at most 100 ${data.truncated.join(", ")} items — the most recently updated ones for completed and cancelled, and the first 20 claimable for up next. Use the CLI for the full history.</div>`
        : ""
    }
    ${view === "active" ? activeView(data) : lanesView(data)}
  `;
  return document(
    "Progress · Snowcat",
    shell(context, { title: "Progress", eyebrow: "snowcat · delivery progress", heading: "Progress", active: "progress", refresh: true, ...(filterRepository ? { repository: filterRepository } : {}) }, body),
    { refresh: true, live: { page: "/progress", partials: [], reload: true } },
  );
}

/** The full lifecycle: the attention group, then a lane per repository. */
function lanesView(data: ProgressData): SafeHtml {
  return html`
    ${
      data.attention.length > 0
        ? progressGroup("Needs attention", "amber, red, and grey stops · newest first", data.attention, data.asOf, "attention")
        : ""
    }
    ${
      data.repositories.length === 0
        ? html`<section class="fl-group"><p class="fl-empty">No current progress to show. Labeled issues appear here after the next successful import.</p></section>`
        : data.repositories.map((group) => progressGroup(group.repository, `${group.rows.length} current`, group.rows, data.asOf))
    }
  `;
}

/** What is in motion and what is next: two flat groups, no repository lanes. */
function activeView(data: ProgressData): SafeHtml {
  const repositories = new Set(data.workingNow.map((row) => row.repository)).size;
  return html`
    <section class="fl-group fl-active-group" id="working-now">
      <div class="fl-group-head"><h2>Working now</h2><span>${data.workingNow.length} ${data.workingNow.length === 1 ? "worker" : "workers"} active across ${repositories} ${repositories === 1 ? "repository" : "repositories"}</span></div>
      ${
        data.workingNow.length === 0
          ? html`<p class="fl-empty">No workers hold a live lease right now.</p>`
          : html`<div class="fl-active-rows">${data.workingNow.map((row) => activeRow(row, data.asOf))}</div>`
      }
    </section>
    <section class="fl-group fl-active-group" id="up-next">
      <div class="fl-group-head"><h2>Up next</h2><span>next ${data.upNext.length} claimable</span></div>
      ${
        data.upNext.length === 0
          ? html`<p class="fl-empty">Nothing is waiting to be claimed.</p>`
          : html`<div class="fl-active-rows">${data.upNext.map((row) => upNextRow(row))}</div>`
      }
    </section>
  `;
}

/** A flat active row: who holds the lease, where, what kind, which stage, and how long it has been in it. */
function activeRow(row: ProgressRow, asOf: string): SafeHtml {
  const title = row.item ? html`<a href="${itemPath(row.item.id)}">${row.title}</a>` : html`<span>${row.title}</span>`;
  const enteredAt = row.enteredAt[row.stage];
  return html`<article class="fl-active-row" data-progress-key="${row.key}" data-progress-stage="${row.stage}">
    <div class="fl-active-name"><strong>${title}</strong><small>${row.leaseOwner ?? "unknown worker"} · ${row.repository} · ${
      row.item ? row.item.kind : "labeled issue"
    } · ${LABELS[row.stage]}</small></div>
    ${enteredAt ? html`<small class="fl-waiting-chip" title="Entered at ${enteredAt}">in this stage for ${stageDuration(enteredAt, asOf)}</small>` : ""}
  </article>`;
}

/** A flat up-next row: the claimable item, where, and what kind. */
function upNextRow(row: ProgressRow): SafeHtml {
  const title = row.item ? html`<a href="${itemPath(row.item.id)}">${row.title}</a>` : html`<span>${row.title}</span>`;
  return html`<article class="fl-active-row" data-progress-key="${row.key}" data-progress-stage="${row.stage}">
    <div class="fl-active-name"><strong>${title}</strong><small>${row.repository} · ${row.item ? row.item.kind : "labeled issue"}</small></div>
  </article>`;
}

function progressGroup(title: string, caption: string, rows: ProgressRow[], asOf: string, id?: string): SafeHtml {
  return html`<section class="fl-group fl-progress-group"${id ? html` id="${id}"` : ""}>
    <div class="fl-group-head"><h2>${title}</h2><span>${caption}</span></div>
    <div class="fl-progress-rows">${rows.map((row) => progressRow(row, asOf))}</div>
  </section>`;
}

function progressRow(row: ProgressRow, asOf: string): SafeHtml {
  const current = progressStages.indexOf(row.stage);
  const title = row.item
    ? html`<a href="${itemPath(row.item.id)}">${row.title}</a>`
    : html`<a href="${row.observation!.url}">${row.title}</a>`;
  return html`<article class="fl-progress-row" data-progress-key="${row.key}" data-progress-stage="${row.stage}">
    <header>
      <div class="fl-progress-name"><strong>${title}</strong><small>${row.repository} · ${
        row.item ? `${row.item.kind} · updated ${clock(row.updatedAt, true)}` : `labeled issue · seen ${clock(row.updatedAt, true)}`
      }</small></div>
      ${row.badge ? html`<span class="fl-progress-badge ${row.badge.tone}" title="${row.badge.reason}">${row.badge.label}</span>` : ""}
    </header>
    <div class="fl-progress-scroll"><ol class="fl-stage-strip" aria-label="Progress for ${row.title}">
      ${progressStages.map((stage, index) => {
        const isCurrent = index === current;
        const enteredAt = row.enteredAt[stage];
        const classes = [
          index < current ? "complete" : "",
          isCurrent ? "current" : "",
          isCurrent && row.active ? "active" : "",
          isCurrent && row.badge ? `stop-${row.badge.tone}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        return html`<li class="${classes}"${enteredAt ? html` title="Entered at ${enteredAt}"` : ""}><span class="fl-stage-mark" aria-hidden="true"></span><b>${LABELS[stage]}</b>${
          isCurrent && row.waiting
            ? html`<small class="fl-waiting-chip" title="${row.waiting}">${row.waiting}${enteredAt ? ` · in this stage for ${stageDuration(enteredAt, asOf)}` : ""}</small>`
            : ""
        }</li>`;
      })}
    </ol></div>
    ${progressActions(row)}
  </article>`;
}

function progressActions(row: ProgressRow): SafeHtml | string {
  if (row.item?.status === "proposed") return admissionForm(row.item, "/progress", { approveOnly: true });
  if (row.item?.status === "blocked") return exitForm(row.item, "/progress");
  return "";
}

function stageDuration(enteredAt: string, asOf: string): string {
  const elapsed = Math.max(0, Date.parse(asOf) - Date.parse(enteredAt));
  const totalMinutes = Math.floor(elapsed / 60_000);
  if (totalMinutes < 1) return "less than a minute";
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days} ${days === 1 ? "day" : "days"} ${hours} ${hours === 1 ? "hour" : "hours"}` : `${days} ${days === 1 ? "day" : "days"}`;
  if (hours > 0) return minutes > 0 ? `${hours} ${hours === 1 ? "hour" : "hours"} ${minutes} ${minutes === 1 ? "minute" : "minutes"}` : `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}
