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
      // The redirect response's body is never read; release it before
      // rejecting or following the redirect so the stream is not abandoned.
      await response.body?.cancel();
      if (!redirected) return { kind: "unavailable" };
      response = await request(redirected);
      if (isRedirect(response.status)) return unavailable(response);
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { kind: "response", status: response.status, value: null };
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) return unavailable(response);
      const length = Number(declaredLength);
      if (!Number.isSafeInteger(length) || length > MAX_RESPONSE_BYTES) return unavailable(response);
    }
    const bytes = await boundedBody(response, MAX_RESPONSE_BYTES);
    if (bytes === null) return { kind: "unavailable" };
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

// Release an unread response body before reporting the read unavailable.
// Undici/Node responses whose bodies are neither consumed nor cancelled
// retain stream and connection resources and block connection reuse.
async function unavailable(response: Response): Promise<GitHubJsonResponse> {
  await response.body?.cancel();
  return { kind: "unavailable" };
}

async function boundedBody(response: Response, maximumBytes: number): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const result = new Uint8Array(maximumBytes);
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > maximumBytes - size) {
        await reader.cancel();
        return null;
      }
      result.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return result.subarray(0, size);
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
