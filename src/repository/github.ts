import type { RepositoryGitHubInspectionInput } from "../control/store.ts";
import { githubApiJson, type GitHubFetch } from "./github-api.ts";

const GITHUB_TIMEOUT_MS = 30_000;

export interface GitHubRepositoryLocator {
  owner: string;
  name: string;
}

export async function inspectGitHubRepository(
  locator: GitHubRepositoryLocator,
  fetcher: GitHubFetch = fetch,
): Promise<RepositoryGitHubInspectionInput> {
  assertLocator(locator);
  const response = await githubApiJson(
    `/repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.name)}`,
    AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    fetcher,
  );
  if (response.kind === "unavailable") return { kind: "unavailable" };
  if (response.status === 404) return { kind: "missing" };
  if (response.status !== 200) return { kind: "unavailable" };
  try {
    const value = response.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "unavailable" };
    const repository = value as Record<string, unknown>;
    const owner = repository.owner;
    if (!owner || typeof owner !== "object" || Array.isArray(owner)) return { kind: "unavailable" };
    const id = repository.id;
    const name = repository.name;
    const login = (owner as Record<string, unknown>).login;
    const archived = repository.archived;
    const defaultBranch = repository.default_branch;
    if (
      !Number.isSafeInteger(id) ||
      Number(id) < 1 ||
      typeof name !== "string" ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(name) ||
      typeof login !== "string" ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login) ||
      typeof archived !== "boolean" ||
      typeof defaultBranch !== "string" ||
      !isGitHubRefName(defaultBranch)
    ) {
      return { kind: "unavailable" };
    }
    return {
      kind: "found",
      repositoryId: String(id),
      owner: login,
      name,
      archived,
      defaultBranch,
    };
  } catch {
    return { kind: "unavailable" };
  }
}

function isGitHubRefName(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock")
  );
}

function assertLocator(locator: GitHubRepositoryLocator): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(locator.owner)) {
    throw new Error("GitHub repository owner is not canonical");
  }
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(locator.name)) {
    throw new Error("GitHub repository name is not canonical");
  }
}
