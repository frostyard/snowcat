import {
  GITHUB_API_ACCEPT,
  GITHUB_API_ORIGIN,
  GITHUB_API_USER_AGENT,
  GITHUB_API_VERSION,
} from "../github/api-contract.ts";

const MAX_RESPONSE_BYTES = 1_048_576;

export type GitHubFetch = typeof fetch;

export type GitHubJsonResponse =
  | { kind: "response"; status: number; value: unknown }
  | { kind: "unavailable" };

export async function githubApiJson(
  path: string,
  signal: AbortSignal,
  fetcher: GitHubFetch = fetch,
): Promise<GitHubJsonResponse> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("GitHub API path must be root-relative");
  const headers: Record<string, string> = {
    Accept: GITHUB_API_ACCEPT,
    "User-Agent": GITHUB_API_USER_AGENT,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  const token = process.env.FLUENT_GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const request = (url: string) =>
    fetcher(url, { method: "GET", headers, redirect: "manual", signal });
  try {
    let response = await request(`${GITHUB_API_ORIGIN}${path}`);
    if (isRedirect(response.status)) {
      const redirected = sameOriginUrl(response.headers.get("location"));
      if (!redirected) return { kind: "unavailable" };
      response = await request(redirected);
      if (isRedirect(response.status)) return { kind: "unavailable" };
    }
    if (!response.ok) return { kind: "response", status: response.status, value: null };
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) {
      return { kind: "unavailable" };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) return { kind: "unavailable" };
    // A 204 (or any empty success body, e.g. `GET /vulnerability-alerts`) is an
    // answer, not an outage: the status carries the meaning.
    if (bytes.byteLength === 0) return { kind: "response", status: response.status, value: null };
    try {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return { kind: "response", status: response.status, value };
    } catch {
      return { kind: "unavailable" };
    }
  } catch {
    return { kind: "unavailable" };
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function sameOriginUrl(location: string | null): string | null {
  if (!location) return null;
  try {
    const url = new URL(location, GITHUB_API_ORIGIN);
    return url.origin === GITHUB_API_ORIGIN ? url.href : null;
  } catch {
    return null;
  }
}
