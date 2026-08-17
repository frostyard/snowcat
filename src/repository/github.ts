import type { RepositoryGitHubInspectionInput } from "../control/store.ts";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_048_576;

export interface GitHubRepositoryLocator {
  owner: string;
  name: string;
}

export type GitHubFetch = typeof fetch;

export async function inspectGitHubRepository(
  locator: GitHubRepositoryLocator,
  fetcher: GitHubFetch = fetch,
): Promise<RepositoryGitHubInspectionInput> {
  assertLocator(locator);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "frostyard-fluent",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  const token = process.env.FLUENT_GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const signal = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
    const request = (url: string) =>
      fetcher(url, {
        method: "GET",
        headers,
        redirect: "manual",
        signal,
      });
    let response = await request(
      `${GITHUB_API_URL}/repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.name)}`,
    );
    if (isRedirect(response.status)) {
      const redirected = sameOriginGitHubApiUrl(response.headers.get("location"));
      if (!redirected) return { kind: "unavailable" };
      response = await request(redirected);
      if (isRedirect(response.status)) return { kind: "unavailable" };
    }
    if (response.status === 404) return { kind: "missing" };
    if (!response.ok) return { kind: "unavailable" };
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) return { kind: "unavailable" };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) return { kind: "unavailable" };
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return { kind: "unavailable" };
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "unavailable" };
    const repository = value as Record<string, unknown>;
    const owner = repository.owner;
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) return { kind: "unavailable" };
    const id = repository.id;
    const name = repository.name;
    const login = (owner as Record<string, unknown>).login;
    const archived = repository.archived;
    if (
      !Number.isSafeInteger(id) ||
      Number(id) < 1 ||
      typeof name !== "string" ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(name) ||
      typeof login !== "string" ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login) ||
      typeof archived !== "boolean"
    ) {
      return { kind: "unavailable" };
    }
    return {
      kind: "found",
      repositoryId: String(id),
      owner: login,
      name,
      archived,
    };
  } catch {
    return { kind: "unavailable" };
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function sameOriginGitHubApiUrl(location: string | null): string | null {
  if (!location) return null;
  try {
    const url = new URL(location, GITHUB_API_URL);
    return url.origin === GITHUB_API_URL ? url.href : null;
  } catch {
    return null;
  }
}

function assertLocator(locator: GitHubRepositoryLocator): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(locator.owner)) {
    throw new Error("GitHub repository owner is not canonical");
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(locator.name)) {
    throw new Error("GitHub repository name is not canonical");
  }
}
