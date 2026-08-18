/**
 * A tiny HTML template helper: `html\`…\`` escapes every interpolated value
 * unless it is already a `SafeHtml` produced by another `html` call (or by
 * `raw`, which callers use only for stylesheet text they own).
 */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type Renderable = SafeHtml | string | number | boolean | null | undefined | Renderable[];

export function html(strings: TemplateStringsArray, ...values: Renderable[]): SafeHtml {
  let out = "";
  strings.forEach((chunk, index) => {
    out += chunk;
    if (index < values.length) out += render(values[index]);
  });
  return new SafeHtml(out);
}

export function raw(value: string): SafeHtml {
  return new SafeHtml(value);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function render(value: Renderable): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  if (value === true) return "";
  return escapeHtml(String(value));
}
