import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  githubPullRequestActions,
  type GitHubPullRequestAction,
} from "../control/registry.ts";
import type { GitHubPullRequestDeliveryInput } from "../control/store.ts";

export const GITHUB_WEBHOOK_MAXIMUM_BODY_BYTES = 25 * 1024 * 1024;

export type GitHubWebhookFailureCode =
  | "invalid-configuration"
  | "invalid-headers"
  | "authentication-failed"
  | "body-too-large"
  | "unsupported-event"
  | "unsupported-action"
  | "unsupported-pull-request-shape"
  | "malformed-payload";

export class GitHubWebhookFailure extends Error {
  constructor(readonly code: GitHubWebhookFailureCode) {
    super(`GitHub webhook rejected: ${code}`);
  }
}

export interface GitHubWebhookRequest {
  appId: string;
  secret: Uint8Array;
  deliveryGuid: string;
  event: string;
  signature: string;
  contentType: string;
  body: Uint8Array;
}

export function verifyAndNormalizeGitHubPullRequestWebhook(
  request: GitHubWebhookRequest,
): GitHubPullRequestDeliveryInput {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    typeof request.appId !== "string" ||
    !(request.secret instanceof Uint8Array) ||
    !/^[1-9][0-9]{0,19}$/.test(request.appId) ||
    request.secret.byteLength < 32 ||
    request.secret.byteLength > 1024
  ) {
    throw new GitHubWebhookFailure("invalid-configuration");
  }
  if (
    typeof request.deliveryGuid !== "string" ||
    typeof request.event !== "string" ||
    typeof request.signature !== "string" ||
    typeof request.contentType !== "string" ||
    !(request.body instanceof Uint8Array) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(request.deliveryGuid) ||
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.contentType)
  ) {
    throw new GitHubWebhookFailure("invalid-headers");
  }
  if (request.body.byteLength < 1) throw new GitHubWebhookFailure("malformed-payload");
  if (request.body.byteLength > GITHUB_WEBHOOK_MAXIMUM_BODY_BYTES) {
    throw new GitHubWebhookFailure("body-too-large");
  }

  const body = Buffer.from(request.body);
  const expected = createHmac("sha256", request.secret).update(body).digest();
  const supplied = parseSignature(request.signature);
  if (!supplied || !timingSafeEqual(supplied, expected)) {
    throw new GitHubWebhookFailure("authentication-failed");
  }
  if (request.event !== "pull_request") {
    throw new GitHubWebhookFailure("unsupported-event");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new GitHubWebhookFailure("malformed-payload");
  }
  const payload = objectValue(parsed);
  const action = stringValue(payload?.action);
  if (!action || !githubPullRequestActions.includes(action as GitHubPullRequestAction)) {
    throw new GitHubWebhookFailure("unsupported-action");
  }

  try {
    const installation = requiredObject(payload?.installation);
    const repository = requiredObject(payload?.repository);
    const sender = requiredObject(payload?.sender);
    const pullRequest = requiredObject(payload?.pull_request);
    const base = requiredObject(pullRequest.base);
    const baseRepository = requiredObject(base.repo);
    const head = requiredObject(pullRequest.head);
    const headRepository = requiredObject(head.repo);
    const repositoryId = `github.com:${githubId(repository.id)}`;
    const state = exactState(pullRequest.state);
    const merged = booleanValue(pullRequest.merged);
    const mergeCommitSha = nullableSha(pullRequest.merge_commit_sha);
    const mergedAt = nullableInstant(pullRequest.merged_at);
    const baseRepositoryId = `github.com:${githubId(baseRepository.id)}`;
    const headRepositoryId = `github.com:${githubId(headRepository.id)}`;
    if (
      baseRepositoryId !== repositoryId ||
      headRepositoryId !== repositoryId ||
      (action === "closed" && state !== "closed") ||
      (action !== "closed" && action !== "edited" && state !== "open") ||
      (state === "open" && (merged || mergedAt !== null)) ||
      (state === "closed" && merged && (mergedAt === null || mergeCommitSha === null)) ||
      (state === "closed" && !merged && (mergedAt !== null || mergeCommitSha !== null))
    ) {
      throw new GitHubWebhookFailure("unsupported-pull-request-shape");
    }
    return {
      appId: request.appId,
      deliveryGuid: request.deliveryGuid,
      bodyDigest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      requestBytes: body.byteLength,
      installationId: `github.com:installation:${githubId(installation.id)}`,
      repositoryId,
      action: action as GitHubPullRequestAction,
      pullRequest: {
        number: positiveInteger(pullRequest.number),
        actorId: `github.com:user:${githubId(sender.id)}`,
        state,
        draft: booleanValue(pullRequest.draft),
        merged,
        baseRepositoryId,
        baseRef: requiredString(base.ref),
        baseCommitId: typedSha(requiredSha(base.sha)),
        headRepositoryId,
        headRef: requiredString(head.ref),
        headCommitId: typedSha(requiredSha(head.sha)),
        observedTestMergeCommitId:
          state === "open" && mergeCommitSha !== null ? typedSha(mergeCommitSha) : null,
        mergedAt,
        mergeCommitId:
          state === "closed" && merged && mergeCommitSha !== null ? typedSha(mergeCommitSha) : null,
        sourceUpdatedAt: requiredInstant(pullRequest.updated_at),
      },
    };
  } catch (error) {
    if (error instanceof GitHubWebhookFailure) throw error;
    throw new GitHubWebhookFailure("malformed-payload");
  }
}

function parseSignature(value: string): Buffer | undefined {
  const match = /^sha256=([0-9a-f]{64})$/.exec(value);
  return match ? Buffer.from(match[1]!, "hex") : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredObject(value: unknown): Record<string, unknown> {
  const result = objectValue(value);
  if (!result) throw new Error("object required");
  return result;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new Error("string required");
  return value;
}

function githubId(value: unknown): string {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("safe GitHub ID required");
  return String(value);
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("positive integer required");
  return Number(value);
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("boolean required");
  return value;
}

function exactState(value: unknown): "open" | "closed" {
  if (value !== "open" && value !== "closed") throw new Error("pull-request state required");
  return value;
}

function requiredSha(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) throw new Error("SHA-1 required");
  return value;
}

function nullableSha(value: unknown): string | null {
  if (value === null) return null;
  return requiredSha(value);
}

function typedSha(value: string): string {
  return `sha1:${value}`;
}

function requiredInstant(value: unknown): string {
  if (typeof value !== "string" || !isUtcInstant(value)) throw new Error("UTC instant required");
  return value;
}

function nullableInstant(value: unknown): string | null {
  if (value === null) return null;
  return requiredInstant(value);
}

function isUtcInstant(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}
