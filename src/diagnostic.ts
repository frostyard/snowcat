export function sanitizeDiagnostic(value: string, fallback: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b(token|password|secret|authorization)(\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = Buffer.from(normalized || fallback, "utf8").subarray(0, 512);
  return new TextDecoder("utf-8", { fatal: false }).decode(bounded).replace(/\uFFFD$/u, "");
}
