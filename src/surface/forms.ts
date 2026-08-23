import type { ObservableWorkItem } from "../queue/types.ts";
import { html, type SafeHtml } from "./html.ts";
import { itemPath, repositoryPath } from "./pages.ts";

/**
 * Hidden fields every mutation form carries: the item's `status` and
 * `updatedAt` exactly as rendered (the stale-intent precondition, spec rule
 * 39) and where to send the operator back afterwards.
 */
export function preconditionFields(item: ObservableWorkItem, returnTo: string): SafeHtml {
  return html`<input type="hidden" name="status" value="${item.status}"><input type="hidden" name="updatedAt" value="${item.updatedAt}"><input type="hidden" name="return" value="${returnTo}">`;
}

/** Approve / Reject for a proposal; one form, two submit targets, one optional reason. */
export function admissionForm(
  item: ObservableWorkItem,
  returnTo: string,
  options: { open?: boolean; approveOnly?: boolean } = {},
): SafeHtml {
  return html`<form class="fl-decide" method="post" action="${itemPath(item.id)}/approve">${preconditionFields(item, returnTo)}<div class="fl-actions"><button class="ph-button" type="submit">Approve</button>${
    options.approveOnly
      ? ""
      : html`<button class="ph-button reject" type="submit" formaction="${itemPath(item.id)}/reject">Reject</button>`
  }${
    options.open ? html`<a class="ph-button secondary" href="${itemPath(item.id)}">Open</a>` : ""
  }</div>${
    options.approveOnly
      ? ""
      : html`<input class="fl-input" name="reason" placeholder="Reason (required to reject)" maxlength="4000">`
  }<small class="fl-sub">Approve carries status=${item.status} · updatedAt ${item.updatedAt.slice(11, 19)} — refused if the item moved</small></form>`;
}

/** Requeue-with-note / Cancel for a blocked item; the textarea is the reason for either. */
export function exitForm(item: ObservableWorkItem, returnTo: string, options: { open?: boolean } = {}): SafeHtml {
  return html`<form class="fl-exit" method="post" action="${itemPath(item.id)}/requeue">${preconditionFields(item, returnTo)}<div class="fl-actions"><button class="ph-button" type="submit">Requeue with note</button><button class="ph-button reject" type="submit" formaction="${itemPath(item.id)}/cancel">Cancel</button>${
    options.open ? html`<a class="ph-button secondary" href="${itemPath(item.id)}">Open</a>` : ""
  }</div><textarea class="fl-note" name="reason" placeholder="Note for the next lease (carried on the item)" maxlength="4000"></textarea></form>`;
}

/**
 * Release a claimed item's lease when its holder is gone (`queue --
 * release-lease`, spec rule 67). The outstanding token is fenced; the reason
 * travels to the next lease as a `release-lease` note.
 */
export function releaseLeaseForm(item: ObservableWorkItem, returnTo: string): SafeHtml {
  return html`<form class="fl-decide" method="post" action="${itemPath(item.id)}/release-lease">${preconditionFields(item, returnTo)}<div class="fl-actions"><button class="ph-button reject" type="submit">Release lease</button></div><input class="fl-input" name="reason" placeholder="Why the holder is gone (carried to the next lease)" maxlength="4000" required><small class="fl-sub">Returns the item to queued without waiting for expiry; the worker's token stops working immediately.</small></form>`;
}

/** Defer an admitted, unclaimed item back to proposed. */
export function deferForm(item: ObservableWorkItem, returnTo: string): SafeHtml {
  return html`<form class="fl-decide" method="post" action="${itemPath(item.id)}/defer">${preconditionFields(item, returnTo)}<div class="fl-actions"><button class="ph-button secondary" type="submit">Defer</button></div><input class="fl-input" name="reason" placeholder="Deferral reason" maxlength="4000" required></form>`;
}

/** Change priority (proposed, queued, blocked). */
export function prioritizeForm(item: ObservableWorkItem, returnTo: string): SafeHtml {
  return html`<form class="fl-decide" method="post" action="${itemPath(item.id)}/prioritize">${preconditionFields(item, returnTo)}<div class="fl-actions"><input class="fl-input fl-input-num" type="number" name="priority" value="${item.priority}" step="1" required><button class="ph-button secondary" type="submit">Prioritize</button></div><input class="fl-input" name="reason" placeholder="Prioritize reason" maxlength="4000" required></form>`;
}

/** Append an operator note (any state). */
export function noteForm(item: ObservableWorkItem, returnTo: string): SafeHtml {
  return html`<form class="fl-decide" method="post" action="${itemPath(item.id)}/note">${preconditionFields(item, returnTo)}<div class="fl-actions"><button class="ph-button secondary" type="submit">Note</button></div><textarea class="fl-note" name="reason" placeholder="Note for the next lease (carried on the item)" maxlength="4000" required></textarea></form>`;
}

/**
 * Attach one pull-request, issue, or release URL the worker did not report to
 * a completed item (`queue -- attach-artifact`). GitHub is asked first; the
 * kind follows the URL path.
 */
export function attachArtifactForm(item: ObservableWorkItem, returnTo: string): SafeHtml {
  return html`<form class="fl-decide" method="post" action="${itemPath(item.id)}/attach-artifact">${preconditionFields(item, returnTo)}<div class="fl-actions"><input class="fl-input" type="url" name="url" placeholder="https://github.com/${item.repository}/pull/N, …/issues/N, or …/releases/tag/TAG" maxlength="512" required><button class="ph-button secondary" type="submit">Attach artifact</button></div><input class="fl-input" name="description" placeholder="Description (optional)" maxlength="4000"><small class="fl-sub">Records a pull request, issue, or release the operator carried the last mile — verified against GitHub before it is written; refused outside ${item.repository}.</small></form>`;
}

/** Re-verify a repository's pending issue and pull-request artifacts. */
export function verifyForm(repository: string, returnTo: string, options: { label?: string } = {}): SafeHtml {
  return html`<form class="fl-inline" method="post" action="${repositoryPath(repository)}/verify-artifacts"><input type="hidden" name="return" value="${returnTo}"><button class="ph-button secondary" type="submit">${options.label ?? "Re-verify"}</button></form>`;
}
