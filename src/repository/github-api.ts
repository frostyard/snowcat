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
  return githubJson(`${GITHUB_API_ORIGIN}${path}`, { method: "GET" }, signal, fetcher);
}

/**
 * One bounded GraphQL read (`POST /graphql`) with the same headers, token,
 * size cap, and redirect handling as `githubApiJson`. The `value` of a
 * `response` is GitHub's raw envelope (`{ data, errors }`); callers decide
 * what a partial answer means. GitHub's GraphQL endpoint requires a token:
 * without `SNOWCAT_GITHUB_TOKEN` it answers 401, a `response`, not a throw.
 */
export async function githubGraphql(
  query: string,
  variables: Record<string, unknown>,
  signal: AbortSignal,
  fetcher: GitHubFetch = fetch,
): Promise<GitHubJsonResponse> {
  return githubJson(
    `${GITHUB_API_ORIGIN}/graphql`,
    { method: "POST", body: JSON.stringify({ query, variables }), contentType: "application/json" },
    signal,
    fetcher,
  );
}

async function githubJson(
  initialUrl: string,
  options: { method: "GET" | "POST"; body?: string; contentType?: string },
  signal: AbortSignal,
  fetcher: GitHubFetch,
): Promise<GitHubJsonResponse> {
  const headers: Record<string, string> = {
    Accept: GITHUB_API_ACCEPT,
    "User-Agent": GITHUB_API_USER_AGENT,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  if (options.contentType) headers["Content-Type"] = options.contentType;
  const token = process.env.SNOWCAT_GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  const request = (url: string) =>
    fetcher(url, { method: options.method, headers, redirect: "manual", signal, ...(options.body === undefined ? {} : { body: options.body }) });
  try {
    let response = await request(initialUrl);
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
