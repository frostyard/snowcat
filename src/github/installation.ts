import { createHash } from "node:crypto";

import { awaitWithAbort } from "./abort.ts";
import {
  GITHUB_API_ACCEPT,
  GITHUB_API_ORIGIN,
  GITHUB_API_USER_AGENT,
  GITHUB_API_VERSION,
} from "./api-contract.ts";
import type { GitHubAppJwtProvider, GitHubDeliveryFetch } from "./delivery-api.ts";
import type { GitHubInstallationInspection } from "../control/store.ts";

const MAXIMUM_RESPONSE_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 30_000;
const REQUIRED_PERMISSIONS = {
  administration: "read",
  checks: "read",
  contents: "read",
  metadata: "read",
  pull_requests: "read",
  statuses: "read",
} as const;
const REQUIRED_EVENTS = [
  "branch_protection_rule",
  "check_run",
  "check_suite",
  "installation",
  "installation_repositories",
  "pull_request",
  "push",
  "repository_ruleset",
  "status",
] as const;

export interface GitHubInstallationInspectionInput {
  appId: string;
  repositoryId: string;
  owner: string;
  name: string;
  getAppJwt: GitHubAppJwtProvider;
  fetcher?: GitHubDeliveryFetch;
  signal?: AbortSignal;
  now?: () => Date;
}

export type GitHubInstallationInspectionResult = GitHubInstallationInspection;

export async function inspectGitHubRepositoryInstallation(
  input: GitHubInstallationInspectionInput,
): Promise<GitHubInstallationInspectionResult> {
  assertInput(input);
  const observedAt = canonicalInstant((input.now ?? (() => new Date()))());
  const path = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.name)}/installation`;
  const fetcher = input.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  input.signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    let response = await request(`${GITHUB_API_ORIGIN}${path}`, input.getAppJwt, fetcher, controller.signal);
    if (isRedirect(response.status)) {
      const location = safeInstallationUrl(response.headers.get("location"));
      if (!location) return unavailable(input, observedAt);
      response = await request(location, input.getAppJwt, fetcher, controller.signal);
      if (isRedirect(response.status)) return unavailable(input, observedAt);
    }
    if (response.status === 404) {
      const bytes = await boundedBody(response, MAXIMUM_RESPONSE_BYTES);
      return {
        kind: "not-installed",
        appId: input.appId,
        repositoryId: input.repositoryId,
        responseDigest: responseDigest(response.status, bytes),
        observedAt,
      };
    }
    if (response.status !== 200) return unavailable(input, observedAt);
    const bytes = await boundedBody(response, MAXIMUM_RESPONSE_BYTES);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    const selected = normalizeInstallation(value, input.appId);
    if (!selected) return unavailable(input, observedAt);
    return {
      kind: "observed",
      appId: input.appId,
      repositoryId: input.repositoryId,
      installationId: `github.com:installation:${selected.installationId}`,
      access: selected.access,
      targetType: selected.targetType,
      repositorySelection: selected.repositorySelection,
      responseDigest: responseDigest(response.status, bytes),
      observedAt,
    };
  } catch {
    return unavailable(input, observedAt);
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", forwardAbort);
  }
}

async function request(
  url: string,
  getAppJwt: GitHubAppJwtProvider,
  fetcher: GitHubDeliveryFetch,
  signal: AbortSignal,
): Promise<Response> {
  const jwt = await awaitWithAbort(getAppJwt, signal);
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) {
    throw new Error("GitHub App JWT is unavailable");
  }
  return fetcher(url, {
    method: "GET",
    redirect: "manual",
    signal,
    headers: {
      Accept: GITHUB_API_ACCEPT,
      Authorization: `Bearer ${jwt}`,
      "User-Agent": GITHUB_API_USER_AGENT,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
  });
}

function normalizeInstallation(value: unknown, appId: string): {
  installationId: string;
  access: "active" | "suspended" | "permission-mismatch";
  targetType: "Organization" | "User";
  repositorySelection: "all" | "selected";
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const installation = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(installation.id) || Number(installation.id) < 1 ||
    !Number.isSafeInteger(installation.app_id) || String(installation.app_id) !== appId ||
    !(installation.target_type === "Organization" || installation.target_type === "User") ||
    !(installation.repository_selection === "all" || installation.repository_selection === "selected") ||
    !(installation.suspended_at === null || typeof installation.suspended_at === "string")
  ) return null;
  const permissionsMatch = exactStringMap(installation.permissions, REQUIRED_PERMISSIONS);
  const eventsMatch = Array.isArray(installation.events) &&
    installation.events.every((entry) => typeof entry === "string") &&
    JSON.stringify([...installation.events].sort()) === JSON.stringify(REQUIRED_EVENTS);
  return {
    installationId: String(installation.id),
    access: installation.suspended_at !== null
      ? "suspended"
      : permissionsMatch && eventsMatch
        ? "active"
        : "permission-mismatch",
    targetType: installation.target_type,
    repositorySelection: installation.repository_selection,
  };
}

function exactStringMap(value: unknown, expected: Readonly<Record<string, string>>): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = value as Record<string, unknown>;
  const keys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return JSON.stringify(keys) === JSON.stringify(expectedKeys) &&
    keys.every((key) => actual[key] === expected[key]);
}

async function boundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new Error("GitHub installation response is too large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw new Error("GitHub installation response is too large");
    }
    chunks.push(chunk.value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function safeInstallationUrl(location: string | null): string | null {
  if (!location) return null;
  try {
    const url = new URL(location, GITHUB_API_ORIGIN);
    if (
      url.origin !== GITHUB_API_ORIGIN ||
      url.search !== "" ||
      !/^\/repos\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/installation$/.test(url.pathname)
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

function assertInput(input: GitHubInstallationInspectionInput): void {
  if (!/^[1-9][0-9]{0,19}$/.test(input.appId)) throw new Error("GitHub App ID is invalid");
  if (!/^github\.com:[1-9][0-9]{0,19}$/.test(input.repositoryId)) throw new Error("GitHub repository ID is invalid");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(input.owner)) throw new Error("GitHub owner is invalid");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(input.name)) throw new Error("GitHub repository name is invalid");
}

function canonicalInstant(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new Error("GitHub installation observation time is invalid");
  return value.toISOString();
}

function unavailable(input: GitHubInstallationInspectionInput, observedAt: string): GitHubInstallationInspectionResult {
  return { kind: "unavailable", appId: input.appId, repositoryId: input.repositoryId, observedAt };
}

function responseDigest(status: number, bytes: Uint8Array): string {
  const bodyDigest = createHash("sha256").update(bytes).digest("hex");
  return `sha256:${createHash("sha256").update(`${status}:${bodyDigest}`).digest("hex")}`;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
