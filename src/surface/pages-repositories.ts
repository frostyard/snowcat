import type { ObservableWorkItem } from "../queue/types.ts";
import { html, raw, type SafeHtml } from "./html.ts";
import { clock, document, itemPath, objective, repositoryPath, shell, type PageContext } from "./pages.ts";
import type { BoardData, CompletedRow, LeasedRow, RepositoryEnrollment, RepositoryIndexData } from "./repositories.ts";
import { shortLabel, workerFamily } from "./repositories.ts";
import { verifyForm } from "./forms.ts";

export function repositoriesPage(context: PageContext, data: RepositoryIndexData): string {
  return document(
    "Repositories · Fluent",
    shell(
      context,
      { title: "Repositories", eyebrow: "fluent · repositories", heading: "Repositories", active: "repositories" },
      html`<section class="fl-group"><div class="fl-group-head"><h2>Opted in${data.controlPlaneConfigured ? " and declared" : ""}</h2><span>${data.rows.length} ${data.rows.length === 1 ? "repository" : "repositories"}</span></div>${
        data.rows.length === 0
          ? html`<p class="fl-empty">No repository is opted in. <code>npm run queue -- opt-in &lt;owner/repo&gt;</code> adds one.</p>`
          : html`<table class="fl-table"><thead><tr><th>Repository</th><th>Enrollment</th><th class="right">Proposed</th><th class="right">Queued</th><th class="right">Leased</th><th class="right">Blocked</th><th class="right">Completed</th><th class="right">Cancelled</th></tr></thead><tbody>${data.rows.map(
              (row) => html`<tr>
                <td><div class="fl-name"><strong><a href="${repositoryPath(row.slug)}">${row.slug}</a></strong></div></td>
                <td>${enrollmentBadge(row.enrollment, data.controlPlaneConfigured)}</td>
                <td class="right">${row.counts.proposed}</td><td class="right">${row.counts.queued}</td><td class="right">${row.counts.claimed}</td><td class="right">${row.counts.blocked}</td><td class="right">${row.counts.completed}</td><td class="right">${row.counts.cancelled}</td>
              </tr>`,
            )}</tbody></table>`
      }</section>`,
    ),
  );
}

/** The board fragments the live script refetches; each renders one element with that id. */
export const boardPartials = ["stats", "queued", "leased", "completed"] as const;
export type BoardPartial = (typeof boardPartials)[number];

export function boardPartial(data: BoardData, partial: BoardPartial): string {
  switch (partial) {
    case "stats":
      return boardStats(data).value;
    case "queued":
      return column("Queued · claim order", `${data.queued.length}`, data.queued.map(queuedRow), "Nothing queued.", "queued").value;
    case "leased":
      return column("Leased", `${data.leased.length}`, data.leased.map(leasedRow), "No active leases.", "leased").value;
    case "completed":
      return column("Completed", `${data.stats.completedToday} today`, data.completed.map(completedRow), "Nothing completed yet.", "completed").value;
  }
}

function boardStats(data: BoardData): SafeHtml {
  const tile = (label: string, value: string | number, caption: string) =>
    html`<div class="ph-stat"><span>${label}</span><strong>${value}</strong><small>${caption}</small></div>`;
  return html`<div class="ph-stats" id="stats">
        ${tile("Queued", data.stats.queued, data.stats.queuedCaption)}
        ${tile("Leased", data.stats.leased, data.stats.leasedCaption)}
        ${tile("Completed today", data.stats.completedToday, data.stats.completedTodayCaption)}
        ${tile("Merged / attempts", `${data.stats.merged} / ${data.stats.attempts}`, data.stats.mergedCaption)}
      </div>`;
}

export function boardPage(context: PageContext, data: BoardData): string {
  const enrollment = data.enrollment;
  const facts = enrollment
    ? [
        enrollment.coreCommit ? `Core ${short(enrollment.coreCommit)}` : undefined,
        enrollment.surfaceCommit ? `surfaces ${short(enrollment.surfaceCommit)}` : undefined,
        enrollment.repositoryId ? `id ${enrollment.repositoryId}` : undefined,
      ].filter((fact): fact is string => fact !== undefined)
    : [];
  const actions = html`${enrollmentBadge(enrollment, context.controlPlanePath !== undefined)}${enrollment?.held ? html` <span class="ph-badge danger">held</span>` : ""}${
    facts.length > 0 ? html`<span class="fl-facts">${facts.join(" · ")}</span>` : ""
  }`;
  return document(
    `${data.repository} · Fluent`,
    shell(
      context,
      { title: data.repository, eyebrow: "repository · board", heading: data.repository, active: "repositories", actions, refresh: true, repository: data.repository },
      html`${repositoryActions(data, context.controlPlanePath !== undefined)}
      ${boardStats(data)}
      ${data.truncated.length > 0 ? html`<div class="fl-error">Showing the first 100 rows of: ${data.truncated.join(", ")}. Use the CLI for the full list.</div>` : ""}
      ${
        !data.optedIn
          ? html`<div class="fl-error">This repository is declared in the control plane but not opted in to the queue; workers cannot claim its work.</div>`
          : ""
      }
      <div class="fl-board">
        ${raw(boardPartial(data, "queued"))}
        ${raw(boardPartial(data, "leased"))}
        ${raw(boardPartial(data, "completed"))}
      </div>`,
    ),
    { refresh: true, live: { page: repositoryPath(data.repository), partials: boardPartials, repository: data.repository } },
  );
}

/**
 * The board's repository-level actions — the CLI's `import-issues`,
 * `seed-dogfood`, `verify-artifacts`, and `repository -- hold | clear-hold`
 * — as same-origin forms under the header. Hold and clear appear only when a
 * control plane is configured and the repository is declared there.
 */
function repositoryActions(data: BoardData, controlPlaneConfigured: boolean): SafeHtml {
  const here = repositoryPath(data.repository);
  const base = repositoryPath(data.repository);
  const disabledNote = data.optedIn ? "" : html`<small class="fl-sub">Not opted in to the queue: import and seed are unavailable until <code>queue -- opt-in ${data.repository}</code>.</small>`;
  const holdForm = !controlPlaneConfigured
    ? html`<div class="fl-action"><span class="fl-action-label">Hold</span><small class="fl-sub">Needs FLUENT_CONTROL_DB.</small></div>`
    : !data.enrollment
      ? html`<div class="fl-action"><span class="fl-action-label">Hold</span><small class="fl-sub">Not declared in the active Core snapshot.</small></div>`
      : data.enrollment.held
        ? html`<form class="fl-action" method="post" action="${base}/clear-hold"><input type="hidden" name="return" value="${here}"><span class="fl-action-label">Hold <span class="ph-badge danger">held</span></span><input class="fl-input" name="reason" placeholder="Reason to clear the hold" maxlength="4000" required><button class="ph-button secondary" type="submit">Clear hold</button></form>`
        : html`<form class="fl-action" method="post" action="${base}/hold"><input type="hidden" name="return" value="${here}"><span class="fl-action-label">Hold</span><input class="fl-input" name="reason" placeholder="Reason for the hold" maxlength="4000" required><button class="ph-button reject" type="submit">Hold repository</button></form>`;
  return html`<section class="fl-group fl-repo-actions" id="repository-actions"><div class="fl-group-head"><h2>Repository actions</h2><span>as operator:web · same as the CLI</span></div><div class="fl-action-grid">
    <form class="fl-action" method="post" action="${base}/import-issues"><input type="hidden" name="return" value="${here}"><span class="fl-action-label">Import issues</span><div class="fl-action-fields"><input class="fl-input" name="label" value="fluent" placeholder="label" maxlength="100"><input class="fl-input fl-input-num" type="number" name="priority" placeholder="priority" step="1"></div><button class="ph-button secondary" type="submit"${data.optedIn ? "" : " disabled"}>Import issues</button></form>
    <form class="fl-action" method="post" action="${base}/seed-dogfood"><input type="hidden" name="return" value="${here}"><span class="fl-action-label">Seed dogfood</span><small class="fl-sub">${seedDogfoodNote(data)}</small><button class="ph-button secondary" type="submit"${data.optedIn ? "" : " disabled"}>Seed dogfood</button></form>
    <div class="fl-action"><span class="fl-action-label">Verify artifacts</span><small class="fl-sub">Re-check pending issue and pull-request artifacts against GitHub.</small>${verifyForm(data.repository, here, { label: "Verify artifacts" })}</div>
    ${holdForm}
  </div>${disabledNote}</section>`;
}

/** What Seed dogfood will offer: the declared programs when Core declares the repository, else the whole catalog. */
function seedDogfoodNote(data: BoardData): string {
  const programs = data.enrollment?.maintenancePrograms;
  if (programs === undefined) return "Read-only discovery roots for every program; 24 h no-finding cooldown.";
  if (programs.length === 0) return "No maintenance programs declared, so nothing to seed.";
  return `Read-only discovery roots for the declared programs (${programs.join(", ")}); 24 h no-finding cooldown.`;
}

function column(title: string, caption: string, rows: SafeHtml[], empty: string, id: string): SafeHtml {
  return html`<section class="fl-group fl-column" id="${id}"><div class="fl-group-head"><h2>${title}</h2><span>${caption}</span></div><div class="fl-rows">${
    rows.length === 0 ? html`<p class="fl-empty">${empty}</p>` : rows
  }</div></section>`;
}

function queuedRow(item: ObservableWorkItem): SafeHtml {
  const notes = item.operatorNotes.length;
  return html`<a class="fl-row" href="${itemPath(item.id)}"><div class="fl-row-head">${objective(item)}<span class="fl-tags"><span class="ph-badge">p${item.priority}</span>${
    notes > 0 ? html`<span class="ph-badge warn">note</span>` : ""
  }</span></div><small>${item.sourceRef ? `${shortLabel(item)} · ` : ""}${item.kind}${item.parentId ? " · child" : ""}${
    notes > 0 ? ` · ${notes} operator ${notes === 1 ? "note" : "notes"}` : ""
  } · updated ${clock(item.updatedAt)}</small></a>`;
}

function leasedRow(row: LeasedRow): SafeHtml {
  const width = Math.round(row.remainingFraction * 100);
  return html`<a class="fl-row" href="${itemPath(row.item.id)}"><div class="fl-row-head">${objective(row.item)}<span class="fl-tags"><span class="ph-badge ok">claimed</span></span></div><small>${row.item.kind} · ${row.item.leaseOwner ?? "unknown worker"}</small><div class="fl-lease"><div class="fl-lease-head"><span>lease</span><span>${row.remainingLabel} · renewed ${clock(row.item.updatedAt, true)}</span></div><div class="fl-lease-bar"><div style="width:${width}%"></div></div></div></a>`;
}

function completedRow(row: CompletedRow): SafeHtml {
  const item = row.item;
  const pulls = (item.result?.artifacts ?? [])
    .filter((artifact) => artifact.kind === "pull-request")
    .map((artifact) => {
      const match = /\/pull\/(\d+)(?:[/?#]|$)/.exec(artifact.url);
      return match ? `#${match[1]}` : undefined;
    })
    .filter((label): label is string => label !== undefined);
  const delivery = item.delivery ?? "none";
  const tone = delivery === "merged" ? "ok" : delivery === "unverified" ? "warn" : delivery === "closed" ? "danger" : "";
  return html`<a class="fl-row" href="${itemPath(item.id)}"><div class="fl-row-head">${objective(item)}<span class="fl-tags"><span class="ph-badge ${tone}">${delivery}</span></span></div><small>${item.kind}${pulls.length > 0 ? ` · PR ${pulls.join(", ")}` : ""} · ${clock(item.updatedAt)}${
    row.completedBy ? ` · ${workerFamily(row.completedBy)}` : ""
  }</small></a>`;
}

export function enrollmentBadge(enrollment: RepositoryEnrollment | undefined, controlPlaneConfigured: boolean): SafeHtml {
  if (!controlPlaneConfigured) return html`<span class="ph-badge">opted in</span>`;
  if (!enrollment) return html`<span class="ph-badge">not declared</span>`;
  const tone = enrollment.enrolled ? "ok" : enrollment.effectiveState === "disabled" ? "" : "warn";
  return html`<span class="ph-badge ${tone}">${enrollment.effectiveState}</span>`;
}

function short(commit: string): string {
  return commit.slice(0, 7);
}
