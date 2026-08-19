import { createHash } from "node:crypto";

import { canonicalJson, sha256, type JsonValue } from "../control/encoding.ts";
import {
  githubPullRequestActions,
  type GitHubPullRequestAction,
} from "../control/registry.ts";
import type { GitHubPullRequestDeliveryRepairInput } from "../control/store.ts";
import { awaitWithAbort } from "./abort.ts";
import {
  GITHUB_API_ACCEPT,
  GITHUB_API_ORIGIN,
  GITHUB_API_USER_AGENT,
  GITHUB_API_VERSION,
} from "./api-contract.ts";
import {
  GitHubWebhookFailure,
  normalizeGitHubPullRequestPayload,
} from "./webhook.ts";

const DELIVERY_PATH = "/app/hook/deliveries";

export const GITHUB_DELIVERY_AUDIT_MAXIMUM_PAGES = 100;
export const GITHUB_DELIVERY_AUDIT_MAXIMUM_DELIVERIES = 10_000;
export const GITHUB_DELIVERY_AUDIT_MAXIMUM_PAGE_BYTES = 1_048_576;
export const GITHUB_DELIVERY_AUDIT_REQUEST_TIMEOUT_MS = 30_000;
export const GITHUB_DELIVERY_DETAIL_MAXIMUM_BYTES = 25 * 1024 * 1024;

export type GitHubDeliveryFetch = typeof fetch;
export type GitHubAppJwtProvider = () => Promise<string> | string;

export interface GitHubPullRequestDeliverySummary extends Record<string, JsonValue> {
  deliveryId: string;
  deliveryGuid: string;
  deliveredAt: string;
  redelivery: boolean;
  statusCode: number;
  event: "pull_request";
  action: string;
  actionSupported: boolean;
  installationId: string;
  repositoryId: string;
}

export interface GitHubRepositoryDeliverySelection {
  repositoryId: string;
  installationId: string;
  deliveryCount: number;
  selectedResponseDigest: string;
  deliveries: readonly GitHubPullRequestDeliverySummary[];
  unsupportedDeliveryIds: readonly string[];
}

export type GitHubDeliveryAuditResult =
  | {
      kind: "complete";
      appId: string;
      coveredThrough: string;
      pageCount: number;
      deliveryCount: number;
      pageProofDigest: string;
      deliveries: readonly GitHubPullRequestDeliverySummary[];
    }
  | {
      kind: "incomplete";
      appId: string;
      attemptedAt: string;
      cause:
        | "source-unavailable"
        | "pagination-incomplete"
        | "request-budget-exhausted"
        | "unsupported-relevant-delivery"
        | "normalization-failed";
      pageCount: number;
      deliveryCount: number;
      retryAt: string | null;
      diagnostic:
        | "authorization-unavailable"
        | "request-failed"
        | "response-status"
        | "rate-limited"
        | "response-too-large"
        | "invalid-json"
        | "invalid-page"
        | "invalid-pagination"
        | "page-limit"
        | "unsupported-action"
        | "delivery-mismatch";
    };

export interface GitHubDeliveryAuditInput {
  appId: string;
  getAppJwt: GitHubAppJwtProvider;
  fetcher?: GitHubDeliveryFetch;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface GitHubDeliveryDetailInput {
  appId: string;
  delivery: GitHubPullRequestDeliverySummary;
  getAppJwt: GitHubAppJwtProvider;
  fetcher?: GitHubDeliveryFetch;
  signal?: AbortSignal;
  now?: () => Date;
}

export type GitHubDeliveryDetailResult =
  | {
      kind: "complete";
      repair: Omit<GitHubPullRequestDeliveryRepairInput, "expectedLastTransactionSequence">;
    }
  | {
      kind: "incomplete";
      appId: string;
      deliveryId: string;
      attemptedAt: string;
      cause:
        | "source-unavailable"
        | "request-budget-exhausted"
        | "unsupported-relevant-delivery"
        | "normalization-failed";
      retryAt: string | null;
      diagnostic:
        | "authorization-unavailable"
        | "request-failed"
        | "response-status"
        | "rate-limited"
        | "response-too-large"
        | "invalid-json"
        | "invalid-page"
        | "unsupported-action"
        | "delivery-mismatch";
    };

interface PageProof extends Record<string, JsonValue> {
  requestUrl: string;
  responseDigest: string;
  itemCount: number;
  nextUrl: string | null;
}

interface PageResult {
  response: Response;
  bytes: Uint8Array;
}

class AuditFailure extends Error {
  constructor(
    readonly cause: Extract<GitHubDeliveryAuditResult, { kind: "incomplete" }>["cause"],
    readonly diagnostic: Extract<GitHubDeliveryAuditResult, { kind: "incomplete" }>["diagnostic"],
    readonly retryAt: string | null = null,
  ) {
    super(diagnostic);
  }
}

export async function auditGitHubAppDeliveries(
  input: GitHubDeliveryAuditInput,
): Promise<GitHubDeliveryAuditResult> {
  assertAuditConfiguration(input);
  const attemptedAt = canonicalInstant((input.now ?? (() => new Date()))());
  const fetcher = input.fetcher ?? fetch;
  const deliveries: GitHubPullRequestDeliverySummary[] = [];
  const pageProofs: PageProof[] = [];
  const deliveryIds = new Set<string>();
  const visitedUrls = new Set<string>();
  let nextUrl: string | null = `${GITHUB_API_ORIGIN}${DELIVERY_PATH}?per_page=100`;

  try {
    while (nextUrl !== null) {
      if (pageProofs.length >= GITHUB_DELIVERY_AUDIT_MAXIMUM_PAGES) {
        throw new AuditFailure("request-budget-exhausted", "page-limit");
      }
      if (visitedUrls.has(nextUrl)) {
        throw new AuditFailure("pagination-incomplete", "invalid-pagination");
      }
      visitedUrls.add(nextUrl);

      const page = await fetchPage(nextUrl, input.getAppJwt, fetcher, input.signal, attemptedAt);
      if (page.response.status !== 200) {
        const retryAt = safeRetryAt(page.response.headers, attemptedAt);
        throw new AuditFailure(
          "source-unavailable",
          retryAt === null ? "response-status" : "rate-limited",
          retryAt,
        );
      }

      const value = parseJson(page.bytes);
      if (!Array.isArray(value) || value.length > 100) {
        throw new AuditFailure("normalization-failed", "invalid-page");
      }
      if (pageProofs.length * 100 + value.length > GITHUB_DELIVERY_AUDIT_MAXIMUM_DELIVERIES) {
        throw new AuditFailure("request-budget-exhausted", "page-limit");
      }

      for (const raw of value) {
        const normalized = normalizeDeliverySummary(raw);
        if (deliveryIds.has(normalized.deliveryId)) {
          throw new AuditFailure("pagination-incomplete", "invalid-pagination");
        }
        deliveryIds.add(normalized.deliveryId);
        if (normalized.pullRequest !== null) deliveries.push(normalized.pullRequest);
      }

      const parsedNextUrl = nextDeliveryLink(page.response.headers.get("link"));
      pageProofs.push({
        requestUrl: nextUrl,
        responseDigest: `sha256:${createHash("sha256").update(page.bytes).digest("hex")}`,
        itemCount: value.length,
        nextUrl: parsedNextUrl,
      });
      nextUrl = parsedNextUrl;
    }
  } catch (error) {
    const failure = error instanceof AuditFailure
      ? error
      : new AuditFailure("source-unavailable", "request-failed");
    return {
      kind: "incomplete",
      appId: input.appId,
      attemptedAt,
      cause: failure.cause,
      pageCount: pageProofs.length,
      deliveryCount: deliveryIds.size,
      retryAt: failure.retryAt,
      diagnostic: failure.diagnostic,
    };
  }

  return {
    kind: "complete",
    appId: input.appId,
    coveredThrough: attemptedAt,
    pageCount: pageProofs.length,
    deliveryCount: deliveryIds.size,
    pageProofDigest: sha256(canonicalJson(pageProofs)),
    deliveries,
  };
}

export function selectGitHubRepositoryPullRequestDeliveries(
  audit: Extract<GitHubDeliveryAuditResult, { kind: "complete" }>,
  repositoryId: string,
  installationId: string,
): GitHubRepositoryDeliverySelection {
  if (!/^github\.com:[1-9][0-9]{0,19}$/.test(repositoryId)) {
    throw new Error("GitHub repository selection requires a source-native repository ID");
  }
  if (!/^github\.com:installation:[1-9][0-9]{0,19}$/.test(installationId)) {
    throw new Error("GitHub repository selection requires a source-native installation ID");
  }
  const deliveries = audit.deliveries.filter(
    (delivery) => delivery.repositoryId === repositoryId && delivery.installationId === installationId,
  );
  return {
    repositoryId,
    installationId,
    deliveryCount: deliveries.length,
    selectedResponseDigest: sha256(canonicalJson(deliveries)),
    deliveries,
    unsupportedDeliveryIds: deliveries
      .filter((delivery) => !delivery.actionSupported)
      .map((delivery) => delivery.deliveryId),
  };
}

export async function fetchGitHubPullRequestDeliveryDetail(
  input: GitHubDeliveryDetailInput,
): Promise<GitHubDeliveryDetailResult> {
  assertAuditConfiguration(input);
  const attemptedAt = canonicalInstant((input.now ?? (() => new Date()))());
  assertDeliverySummary(input.delivery);
  if (!githubPullRequestActions.includes(input.delivery.action as GitHubPullRequestAction)) {
    return {
      kind: "incomplete",
      appId: input.appId,
      deliveryId: input.delivery.deliveryId,
      attemptedAt,
      cause: "unsupported-relevant-delivery",
      retryAt: null,
      diagnostic: "unsupported-action",
    };
  }

  try {
    const response = await fetchDeliveryDetail(
      input.delivery.deliveryId,
      input.getAppJwt,
      input.fetcher ?? fetch,
      input.signal,
      attemptedAt,
    );
    if (response.response.status !== 200) {
      const retryAt = safeRetryAt(response.response.headers, attemptedAt);
      throw new AuditFailure(
        "source-unavailable",
        retryAt === null ? "response-status" : "rate-limited",
        retryAt,
      );
    }
    const value = parseJson(response.bytes);
    const detailSummary = normalizeDeliverySummary(value).pullRequest;
    if (
      detailSummary === null ||
      canonicalJson(detailSummary) !== canonicalJson(input.delivery)
    ) {
      throw new AuditFailure("normalization-failed", "delivery-mismatch");
    }
    const detail = objectValue(value);
    const request = objectValue(detail?.request);
    const payload = objectValue(request?.payload);
    if (!payload || payload.action !== input.delivery.action) {
      throw new AuditFailure("normalization-failed", "delivery-mismatch");
    }
    let selected: ReturnType<typeof normalizeGitHubPullRequestPayload>;
    try {
      selected = normalizeGitHubPullRequestPayload(
        payload,
        input.delivery.action as GitHubPullRequestAction,
      );
    } catch (error) {
      if (error instanceof GitHubWebhookFailure && error.code === "unsupported-pull-request-shape") {
        throw new AuditFailure("normalization-failed", "delivery-mismatch");
      }
      throw new AuditFailure("normalization-failed", "invalid-page");
    }
    if (
      selected.repositoryId !== input.delivery.repositoryId ||
      selected.installationId !== input.delivery.installationId
    ) {
      throw new AuditFailure("normalization-failed", "delivery-mismatch");
    }
    return {
      kind: "complete",
      repair: {
        appId: input.appId,
        deliveryId: input.delivery.deliveryId,
        deliveryGuid: input.delivery.deliveryGuid,
        deliveredAt: input.delivery.deliveredAt,
        redelivery: input.delivery.redelivery,
        statusCode: input.delivery.statusCode,
        responseDigest: `sha256:${createHash("sha256").update(response.bytes).digest("hex")}`,
        installationId: selected.installationId,
        repositoryId: selected.repositoryId,
        action: selected.action,
        pullRequest: selected.pullRequest,
      },
    };
  } catch (error) {
    const failure = error instanceof AuditFailure
      ? error
      : new AuditFailure("source-unavailable", "request-failed");
    return {
      kind: "incomplete",
      appId: input.appId,
      deliveryId: input.delivery.deliveryId,
      attemptedAt,
      cause:
        failure.cause === "pagination-incomplete"
          ? "normalization-failed"
          : failure.cause,
      retryAt: failure.retryAt,
      diagnostic:
        failure.diagnostic === "invalid-pagination" || failure.diagnostic === "page-limit"
          ? "invalid-page"
          : failure.diagnostic,
    };
  }
}

async function fetchPage(
  url: string,
  getAppJwt: GitHubAppJwtProvider,
  fetcher: GitHubDeliveryFetch,
  callerSignal: AbortSignal | undefined,
  attemptedAt: string,
): Promise<PageResult> {
  let currentUrl = url;
  for (let redirectCount = 0; redirectCount <= 1; redirectCount += 1) {
    const timeout = AbortSignal.timeout(GITHUB_DELIVERY_AUDIT_REQUEST_TIMEOUT_MS);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let jwt: string;
    try {
      jwt = await awaitWithAbort(getAppJwt, signal);
    } catch {
      throw new AuditFailure("source-unavailable", "authorization-unavailable");
    }
    if (!isAppJwt(jwt)) {
      throw new AuditFailure("source-unavailable", "authorization-unavailable");
    }
    let response: Response;
    try {
      response = await fetcher(currentUrl, {
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
    } catch {
      throw new AuditFailure("source-unavailable", "request-failed");
    }
    if (isRedirect(response.status)) {
      if (redirectCount === 1) {
        throw new AuditFailure("source-unavailable", "response-status", safeRetryAt(response.headers, attemptedAt));
      }
      currentUrl = validatedDeliveryUrl(response.headers.get("location"), currentUrl);
      continue;
    }
    if (response.status !== 200) return { response, bytes: new Uint8Array() };
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && !validDeclaredLength(declaredLength)) {
      throw new AuditFailure("request-budget-exhausted", "response-too-large");
    }
    const bytes = await readBoundedResponse(response, GITHUB_DELIVERY_AUDIT_MAXIMUM_PAGE_BYTES);
    return { response, bytes };
  }
  throw new AuditFailure("source-unavailable", "request-failed");
}

async function fetchDeliveryDetail(
  deliveryId: string,
  getAppJwt: GitHubAppJwtProvider,
  fetcher: GitHubDeliveryFetch,
  callerSignal: AbortSignal | undefined,
  attemptedAt: string,
): Promise<PageResult> {
  if (!/^[1-9][0-9]{0,19}$/.test(deliveryId)) {
    throw new AuditFailure("normalization-failed", "invalid-page");
  }
  let currentUrl = `${GITHUB_API_ORIGIN}${DELIVERY_PATH}/${deliveryId}`;
  for (let redirectCount = 0; redirectCount <= 1; redirectCount += 1) {
    const timeout = AbortSignal.timeout(GITHUB_DELIVERY_AUDIT_REQUEST_TIMEOUT_MS);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let jwt: string;
    try {
      jwt = await awaitWithAbort(getAppJwt, signal);
    } catch {
      throw new AuditFailure("source-unavailable", "authorization-unavailable");
    }
    if (!isAppJwt(jwt)) throw new AuditFailure("source-unavailable", "authorization-unavailable");
    let response: Response;
    try {
      response = await fetcher(currentUrl, {
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
    } catch {
      throw new AuditFailure("source-unavailable", "request-failed");
    }
    if (isRedirect(response.status)) {
      if (redirectCount === 1) throw new AuditFailure("source-unavailable", "response-status");
      currentUrl = validatedDeliveryDetailUrl(response.headers.get("location"), currentUrl, deliveryId);
      continue;
    }
    if (response.status !== 200) return { response, bytes: new Uint8Array() };
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && !validDeclaredLength(declaredLength, GITHUB_DELIVERY_DETAIL_MAXIMUM_BYTES)) {
      throw new AuditFailure("request-budget-exhausted", "response-too-large");
    }
    const bytes = await readBoundedResponse(response, GITHUB_DELIVERY_DETAIL_MAXIMUM_BYTES);
    return { response, bytes };
  }
  throw new AuditFailure("source-unavailable", "request-failed");
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new AuditFailure("request-budget-exhausted", "response-too-large");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof AuditFailure) throw error;
    throw new AuditFailure("source-unavailable", "request-failed");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function normalizeDeliverySummary(value: unknown): {
  deliveryId: string;
  pullRequest: GitHubPullRequestDeliverySummary | null;
} {
  const item = objectValue(value);
  if (!item || typeof item.event !== "string" || item.event.length < 1 || item.event.length > 100) {
    throw new AuditFailure("normalization-failed", "invalid-page");
  }
  const deliveryId = githubId(item.id);
  if (item.event !== "pull_request") {
    return {
      deliveryId,
      pullRequest: null,
    };
  }
  const action = boundedAction(item.action);
  return {
    deliveryId,
    pullRequest: {
      deliveryId,
      deliveryGuid: deliveryGuid(item.guid),
      deliveredAt: sourceInstant(item.delivered_at),
      redelivery: booleanValue(item.redelivery),
      statusCode: statusCode(item.status_code),
      event: "pull_request",
      action,
      actionSupported: githubPullRequestActions.includes(action as GitHubPullRequestAction),
      installationId: `github.com:installation:${githubId(item.installation_id)}`,
      repositoryId: `github.com:${githubId(item.repository_id)}`,
    },
  };
}

function nextDeliveryLink(value: string | null): string | null {
  if (value === null) return null;
  let nextUrl: string | null = null;
  for (const part of splitLinkHeader(value)) {
    const match = /^<([^>]+)>\s*;\s*rel="([^"]+)"(?:\s*;.*)?$/i.exec(part.trim());
    if (!match) throw new AuditFailure("pagination-incomplete", "invalid-pagination");
    const relations = match[2]!.trim().toLowerCase().split(/\s+/);
    if (!relations.includes("next")) continue;
    if (nextUrl !== null) throw new AuditFailure("pagination-incomplete", "invalid-pagination");
    nextUrl = validatedDeliveryUrl(match[1]!, `${GITHUB_API_ORIGIN}${DELIVERY_PATH}`);
  }
  return nextUrl;
}

function validatedDeliveryUrl(value: string | null, base: string): string {
  if (value === null || value.length > 4096) {
    throw new AuditFailure("pagination-incomplete", "invalid-pagination");
  }
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new AuditFailure("pagination-incomplete", "invalid-pagination");
  }
  if (
    url.origin !== GITHUB_API_ORIGIN ||
    url.pathname !== DELIVERY_PATH ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    [...url.searchParams.keys()].some((key) => key !== "cursor" && key !== "per_page") ||
    url.searchParams.getAll("per_page").length !== 1 ||
    url.searchParams.getAll("cursor").length > 1 ||
    url.searchParams.get("per_page") !== "100" ||
    (url.searchParams.has("cursor") && !validCursor(url.searchParams.get("cursor") ?? ""))
  ) {
    throw new AuditFailure("pagination-incomplete", "invalid-pagination");
  }
  return url.href;
}

function validatedDeliveryDetailUrl(
  value: string | null,
  base: string,
  deliveryId: string,
): string {
  if (value === null || value.length > 4096) {
    throw new AuditFailure("source-unavailable", "response-status");
  }
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    throw new AuditFailure("source-unavailable", "response-status");
  }
  if (
    url.origin !== GITHUB_API_ORIGIN ||
    url.pathname !== `${DELIVERY_PATH}/${deliveryId}` ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new AuditFailure("source-unavailable", "response-status");
  }
  return url.href;
}

function splitLinkHeader(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let insideUrl = false;
  let insideQuote = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "<" && !insideQuote) insideUrl = true;
    else if (character === ">" && !insideQuote) insideUrl = false;
    else if (character === '"' && !insideUrl) insideQuote = !insideQuote;
    else if (character === "," && !insideUrl && !insideQuote) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  if (insideUrl || insideQuote) throw new AuditFailure("pagination-incomplete", "invalid-pagination");
  parts.push(value.slice(start));
  return parts;
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AuditFailure("normalization-failed", "invalid-json");
  }
}

function safeRetryAt(headers: Headers, attemptedAt: string): string | null {
  const candidates: number[] = [];
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null && /^[0-9]{1,8}$/.test(retryAfter)) {
    candidates.push(new Date(attemptedAt).getTime() + Number(retryAfter) * 1000);
  }
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = headers.get("x-ratelimit-reset");
    if (reset !== null && /^[0-9]{1,12}$/.test(reset)) candidates.push(Number(reset) * 1000);
  }
  return candidates.length === 0 ? null : new Date(Math.max(...candidates)).toISOString();
}

function assertAuditConfiguration(input: GitHubDeliveryAuditInput): void {
  if (
    !input ||
    typeof input !== "object" ||
    !/^[1-9][0-9]{0,19}$/.test(input.appId) ||
    typeof input.getAppJwt !== "function" ||
    (input.fetcher !== undefined && typeof input.fetcher !== "function") ||
    (input.now !== undefined && typeof input.now !== "function")
  ) {
    throw new Error("invalid GitHub delivery-audit configuration");
  }
}

function assertDeliverySummary(value: GitHubPullRequestDeliverySummary): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "action,actionSupported,deliveredAt,deliveryGuid,deliveryId,event,installationId,redelivery,repositoryId,statusCode" ||
    !/^[1-9][0-9]{0,19}$/.test(value.deliveryId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.deliveryGuid) ||
    !isCanonicalInstant(value.deliveredAt) ||
    typeof value.redelivery !== "boolean" ||
    !Number.isSafeInteger(value.statusCode) ||
    value.statusCode < 0 ||
    value.statusCode > 599 ||
    value.event !== "pull_request" ||
    !/^[a-z][a-z0-9_]{0,99}$/.test(value.action) ||
    typeof value.actionSupported !== "boolean" ||
    value.actionSupported !== githubPullRequestActions.includes(value.action as GitHubPullRequestAction) ||
    !/^github\.com:installation:[1-9][0-9]{0,19}$/.test(value.installationId) ||
    !/^github\.com:[1-9][0-9]{0,19}$/.test(value.repositoryId)
  ) {
    throw new Error("invalid GitHub delivery-detail configuration");
  }
}

function isAppJwt(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length >= 32 &&
    value.length <= 4096 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  );
}

function validCursor(value: string): boolean {
  return value.length >= 1 && value.length <= 2048 && !/[\u0000-\u0020\u007f]/.test(value);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function githubId(value: unknown): string {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new AuditFailure("normalization-failed", "invalid-page");
  return String(value);
}

function deliveryGuid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new AuditFailure("normalization-failed", "invalid-page");
  }
  return value.toLowerCase();
}

function sourceInstant(value: unknown): string {
  if (typeof value !== "string" || !/(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value)) {
    throw new AuditFailure("normalization-failed", "invalid-page");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new AuditFailure("normalization-failed", "invalid-page");
  return parsed.toISOString();
}

function isCanonicalInstant(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function canonicalInstant(value: Date): string {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("GitHub delivery-audit clock returned an invalid time");
  }
  return value.toISOString();
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") throw new AuditFailure("normalization-failed", "invalid-page");
  return value;
}

function statusCode(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 599) {
    throw new AuditFailure("normalization-failed", "invalid-page");
  }
  return Number(value);
}

function boundedAction(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,99}$/.test(value)) {
    throw new AuditFailure("normalization-failed", "invalid-page");
  }
  return value;
}

function validDeclaredLength(
  value: string,
  maximumBytes = GITHUB_DELIVERY_AUDIT_MAXIMUM_PAGE_BYTES,
): boolean {
  if (!/^(?:0|[1-9][0-9]{0,9})$/.test(value)) return false;
  return Number(value) <= maximumBytes;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
