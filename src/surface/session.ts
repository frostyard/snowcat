import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "fluent_session";
const SESSION_PURPOSE = "fluent.operator-surface.session.v1";

/**
 * The cookie value for a valid session: an HMAC-SHA256 keyed by the operator
 * token over a fixed purpose string. The browser holds a one-way digest, never
 * the token; rotating `FLUENT_APP_TOKEN` invalidates every cookie at once.
 */
export function sessionDigest(appToken: string): string {
  return createHmac("sha256", appToken).update(SESSION_PURPOSE).digest("hex");
}

/** Constant-time string comparison; unequal lengths compare false without leaking where. */
export function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/** Whether the submitted login token matches the configured one, in constant time. */
export function tokenMatches(submitted: string, appToken: string): boolean {
  return safeEqual(submitted, appToken);
}

/** Whether a Cookie header carries a valid session for `appToken`. */
export function hasValidSession(cookieHeader: string | undefined, appToken: string): boolean {
  const presented = readCookie(cookieHeader, SESSION_COOKIE);
  return presented !== undefined && safeEqual(presented, sessionDigest(appToken));
}

export function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return undefined;
}

/**
 * Set-Cookie value for a fresh session. HttpOnly and SameSite=Strict always;
 * Secure only when the request itself arrived over HTTPS, because the
 * default deployment is plain HTTP on loopback.
 */
export function sessionCookie(appToken: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${sessionDigest(appToken)}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
