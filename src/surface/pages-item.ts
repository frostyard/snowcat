import type { ObservableWorkItem, WorkArtifact, WorkEvent, WorkResult } from "../queue/types.ts";
import { html, type SafeHtml } from "./html.ts";
import type { ItemData } from "./item.ts";
import { artifactLabel, clock, document, itemPath, payloadGist, repositoryPath, shell, type PageContext } from "./pages.ts";
import { enrollmentBadge } from "./pages-repositories.ts";
import { admissionForm, deferForm, exitForm, noteForm, prioritizeForm, verifyForm } from "./forms.ts";

export function itemPage(context: PageContext, data: ItemData): string {
  const item = data.item;
  const statusTone = item.status === "completed" ? "ok" : item.status === "blocked" ? "warn" : item.status === "cancelled" ? "danger" : "";
  const deliveryTone = item.delivery === "merged" ? "ok" : item.delivery === "unverified" ? "warn" : "";
  const actions = html`<span class="ph-badge ${statusTone}">${item.status}</span>${
    item.status === "completed" ? html`<span class="ph-badge ${deliveryTone}">delivery · ${item.delivery ?? "none"}</span>` : ""
  }`;
  return document(
    `${item.kind} · ${item.repository} · Fluent`,
    shell(
      context,
      {
        title: item.kind,
        eyebrow: `item · ${item.id}`,
        heading: `${item.kind} · ${item.repository}`,
        active: "none",
        actions,
        repository: item.repository,
      },
      html`<div class="fl-item"><div class="fl-stack">
        ${definitionCard(data)}
        ${item.result ? resultCard(item.result, data) : ""}
        ${notesCard(item)}
        ${previousResultsCard(item)}
      </div><div class="fl-stack">${actionsCard(item)}${eventsCard(data.events)}</div></div>`,
    ),
  );
}

/**
 * The decisions this item's state allows, as same-origin forms carrying the
 * rendered precondition — the CLI's operator commands and nothing else. A
 * mutation redirects back here with a result banner.
 */
function actionsCard(item: ObservableWorkItem): SafeHtml {
  const here = itemPath(item.id);
  const forms: SafeHtml[] = [];
  if (item.status === "proposed") forms.push(admissionForm(item, here));
  if (item.status === "queued") forms.push(deferForm(item, here));
  if (item.status === "blocked") forms.push(exitForm(item, here));
  if (item.status === "proposed" || item.status === "queued" || item.status === "blocked") forms.push(prioritizeForm(item, here));
  if (item.status === "completed" && (item.result?.artifacts ?? []).some((artifact) => artifact.kind === "issue" || artifact.kind === "pull-request")) {
    forms.push(html`<div class="fl-decide"><div class="fl-actions">${verifyForm(item.repository, here, { label: "Re-verify repository artifacts" })}</div><small class="fl-sub">Re-checks every pending issue and pull-request artifact in ${item.repository} against GitHub.</small></div>`);
  }
  forms.push(noteForm(item, here));
  return html`<section class="fl-group" id="actions"><div class="fl-group-head"><h2>Decide</h2><span>as operator:web · ${item.status}</span></div><div class="fl-def fl-stack-sm">${forms}</div></section>`;
}

function definitionCard(data: ItemData): SafeHtml {
  const item = data.item;
  const row = (label: string, value: SafeHtml | string) => html`<div class="fl-def-row"><span>${label}</span><span>${value}</span></div>`;
  const lineage: SafeHtml[] = [];
  if (data.parent) lineage.push(html`child of <a href="${itemPath(data.parent.id)}">${data.parent.kind}</a>`);
  if (data.root) lineage.push(html`root <a href="${itemPath(data.root.id)}" title="${data.root.kind}">${data.root.id.slice(0, 8)}</a>`);
  if (!data.parent && !data.root) lineage.push(html`root`);
  if (data.children.length > 0) {
    lineage.push(
      html`${data.children.length} ${data.children.length === 1 ? "child" : "children"}: ${data.children.map(
        (child, index) => html`${index > 0 ? ", " : ""}<a href="${itemPath(child.id)}">${child.kind}</a> <em class="fl-muted">(${child.status})</em>`,
      )}`,
    );
  }
  return html`<section class="fl-group" id="definition"><div class="fl-group-head"><h2>Definition</h2><span>${item.sourceRef ? html`<a href="${item.sourceRef}" rel="noreferrer noopener">source ↗</a>` : ""}</span></div><div class="fl-def">
    <p class="fl-objective">${item.objective}</p>
    ${row("repository", html`<a href="${repositoryPath(item.repository)}">${item.repository}</a> · ${enrollmentBadge(data.enrollment, data.enrollment !== undefined)}`)}
    ${row("kind", item.kind)}
    ${row("lineage", html`${lineage.map((part, index) => html`${index > 0 ? " · " : ""}${part}`)}`)}
    ${row("priority", `${item.priority}${item.parentId ? " (inherited)" : ""}`)}
    ${row("allowed", badges(item.allowedActions))}
    ${row("delegable", item.delegableActions.length > 0 ? badges(item.delegableActions) : html`<em class="fl-muted">none</em>`)}
    ${row("created", `${clock(item.createdAt, true)} by ${item.createdBy}`)}
    ${row("updated", clock(item.updatedAt, true))}
    ${item.status === "claimed" ? row("lease", `${item.leaseOwner ?? "unknown worker"} · expires ${item.leaseExpiresAt ? clock(item.leaseExpiresAt, true) : "?"}`) : ""}
    <div class="fl-def-label">Instructions</div>
    <pre class="fl-pre">${item.instructions}</pre>
    <div class="fl-def-label">Acceptance criteria</div>
    <ol class="fl-criteria">${item.acceptanceCriteria.map((criterion) => html`<li>${criterion}</li>`)}</ol>
  </div></section>`;
}

function resultCard(result: WorkResult, data: ItemData): SafeHtml {
  const caption = data.resultEvent ? `${data.resultEvent.type === "work.blocked" ? "blocked" : "completed"} ${clock(data.resultEvent.at, true)} by ${data.resultEvent.actor}` : "";
  return html`<section class="fl-group" id="result"><div class="fl-group-head"><h2>Result</h2><span>${caption}</span></div><div class="fl-def">
    <p class="fl-objective">${result.summary}</p>
    ${
      result.evidence.length > 0
        ? html`<div class="fl-def-label">Evidence</div><ul class="fl-criteria">${result.evidence.map((line) => html`<li>${line}</li>`)}</ul>`
        : ""
    }
    <div class="fl-def-label">Artifacts</div>
    ${
      result.artifacts.length === 0
        ? html`<p class="fl-muted" style="margin:0">None reported.</p>`
        : html`<table class="fl-table fl-table-flush"><thead><tr><th>Kind</th><th>URL</th><th>Verification</th></tr></thead><tbody>${result.artifacts.map((artifact) => artifactRow(artifact, data))}</tbody></table>`
    }
  </div></section>`;
}

function artifactRow(artifact: WorkArtifact, data: ItemData): SafeHtml {
  const verification = artifact.verification;
  let badge: SafeHtml;
  let detail: string;
  if (!verification) {
    badge = html`<span class="ph-badge">${artifact.kind === "issue" || artifact.kind === "pull-request" ? "unchecked" : "provenance"}</span>`;
    detail = artifact.kind === "issue" || artifact.kind === "pull-request" ? "not yet verified" : `${artifact.kind}s are not verified in v1`;
  } else if (verification.status === "verified") {
    badge = html`<span class="ph-badge ${verification.state === "merged" || verification.state === "closed" ? "ok" : ""}">verified · ${verification.state}</span>`;
    const parts = [
      verification.headSha ? `head ${verification.headSha.slice(0, 8)}` : undefined,
      verification.mergedAt ? `merged ${clock(verification.mergedAt, true)}` : undefined,
      verification.closedAt && !verification.mergedAt ? `closed ${clock(verification.closedAt, true)}` : undefined,
      `verified ${clock(verification.verifiedAt, true)}${data.provenance.get(artifact.url)?.verifiedBy ? ` by ${data.provenance.get(artifact.url)!.verifiedBy}` : " at completion"}`,
    ].filter((part): part is string => part !== undefined);
    detail = parts.join(" · ");
  } else {
    badge = html`<span class="ph-badge warn">unverified</span>`;
    detail = `${verification.reason} · attempted ${clock(verification.attemptedAt, true)}`;
  }
  return html`<tr><td>${artifact.kind}</td><td><a href="${artifact.url}" rel="noreferrer noopener">${artifact.url} ↗</a>${
    artifact.description ? html`<small class="fl-sub">${artifact.description}</small>` : ""
  }</td><td>${badge}<small class="fl-sub">${artifactLabel(artifact.kind, artifact.url) !== artifact.kind ? `${artifactLabel(artifact.kind, artifact.url)} · ` : ""}${detail}</small></td></tr>`;
}

function notesCard(item: ObservableWorkItem): SafeHtml {
  return html`<section class="fl-group" id="notes"><div class="fl-group-head"><h2>Operator notes</h2><span>${item.operatorNotes.length}</span></div>${
    item.operatorNotes.length === 0
      ? html`<p class="fl-empty">No operator or policy notes.</p>`
      : html`<div class="fl-def fl-stack-sm">${item.operatorNotes.map(
          (note) => html`<div class="fl-note-row"><span>${clock(note.at, true)} · ${note.action}<br>${note.actor}</span><span>${note.reason}</span></div>`,
        )}</div>`
  }</section>`;
}

function previousResultsCard(item: ObservableWorkItem): SafeHtml {
  return html`<section class="fl-group" id="previous"><div class="fl-group-head"><h2>Previous results</h2><span>${item.previousResults.length}</span></div>${
    item.previousResults.length === 0
      ? html`<p class="fl-empty">No earlier lease left a result behind.</p>`
      : html`<div class="fl-def fl-stack-sm">${item.previousResults.map(
          (result, index) => html`<div class="fl-note-row"><span>result ${index + 1}<br>${result.artifacts.length} ${result.artifacts.length === 1 ? "artifact" : "artifacts"}</span><span>${result.summary}${
            result.evidence.length > 0 ? html`<ul class="fl-criteria fl-criteria-tight">${result.evidence.map((line) => html`<li>${line}</li>`)}</ul>` : ""
          }</span></div>`,
        )}</div>`
  }</section>`;
}

function eventsCard(events: WorkEvent[]): SafeHtml {
  const first = events[0]?.sequence;
  const last = events.at(-1)?.sequence;
  return html`<aside class="fl-group" id="events"><div class="fl-group-head"><h2>Events</h2><span>${events.length}${first !== undefined ? ` · sequence ${first}${last !== first ? `–${last}` : ""}` : ""}</span></div><div class="fl-events">${
    events.length === 0
      ? html`<p class="fl-empty">No events.</p>`
      : events.map(
          (event) => html`<div class="fl-timeline-row"><time datetime="${event.occurredAt}" title="${event.occurredAt}">${clock(event.occurredAt, true)}</time><b>${event.type}</b><span>${event.actor}<em class="fl-muted">${payloadGist(event.payload)}</em></span></div>`,
        )
  }</div></aside>`;
}

function badges(actions: readonly string[]): SafeHtml {
  return html`<span class="fl-badges">${actions.map((action) => html`<span class="ph-badge">${action}</span>`)}</span>`;
}
