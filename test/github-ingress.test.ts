import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { GitHubDeliveryAcceptanceFailure } from "../src/control/store.ts";
import {
  createGitHubWebhookIngress,
  type GitHubWebhookIngressOptions,
} from "../src/github/ingress.ts";
import { GITHUB_WEBHOOK_MAXIMUM_BODY_BYTES } from "../src/github/webhook.ts";

const secret = Buffer.from("0123456789abcdef0123456789abcdef");

test("the POST-only ingress authenticates exact bytes and submits one allowlisted command", async () => {
  const accepted: unknown[] = [];
  const app = ingress((input) => {
    accepted.push(input);
    return {};
  });
  const body = bodyFor();
  const response = await app.request("/", signedInit(body));
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: "accepted" });
  assert.equal(accepted.length, 1);
  assert.equal((accepted[0] as { repositoryId: string }).repositoryId, "github.com:9001");

  const method = await app.request("/", { method: "GET" });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("Allow"), "POST");
});

test("ingress failures are bounded and never expose payload or persistence detail", async () => {
  let calls = 0;
  const app = ingress(() => {
    calls += 1;
    return {};
  });
  const body = bodyFor();

  const unauthenticated = await app.request("/", {
    ...signedInit(body),
    headers: headersFor(body, { "X-Hub-Signature-256": `sha256=${"0".repeat(64)}` }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { error: "authentication-failed" });
  assert.equal(calls, 0);

  const unsupportedBody = bodyFor({ action: "review_requested" });
  const unsupported = await app.request("/", signedInit(unsupportedBody));
  assert.equal(unsupported.status, 422);
  assert.deepEqual(await unsupported.json(), { error: "unsupported-action" });
  assert.equal(calls, 0);

  const oversized = await app.request("/", {
    method: "POST",
    headers: {
      ...headersFor(body),
      "Content-Length": String(GITHUB_WEBHOOK_MAXIMUM_BODY_BYTES + 1),
    },
    body: requestBody(body),
  });
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: "body-too-large" });
  assert.equal(calls, 0);
});

test("typed acceptance conflicts and unknown persistence failures have closed HTTP responses", async () => {
  const body = bodyFor();
  const conflict = ingress(() => {
    throw new GitHubDeliveryAcceptanceFailure("delivery-conflict");
  });
  const conflictResponse = await conflict.request("/", signedInit(body));
  assert.equal(conflictResponse.status, 409);
  assert.deepEqual(await conflictResponse.json(), { error: "delivery-conflict" });

  const failed = ingress(() => {
    throw new Error("database path and internal details must stay private");
  });
  const failedResponse = await failed.request("/", signedInit(body));
  assert.equal(failedResponse.status, 503);
  assert.deepEqual(await failedResponse.json(), { error: "persistence-unavailable" });
});

function ingress(
  accept: GitHubWebhookIngressOptions["store"]["recordVerifiedGitHubPullRequestDelivery"],
) {
  return createGitHubWebhookIngress({
    appId: "4567",
    secret,
    store: { recordVerifiedGitHubPullRequestDelivery: accept },
  });
}

function signedInit(body: Uint8Array): RequestInit {
  return { method: "POST", headers: headersFor(body), body: requestBody(body) };
}

function requestBody(body: Uint8Array): ArrayBuffer {
  return Uint8Array.from(body).buffer;
}

function headersFor(body: Uint8Array, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-GitHub-Delivery": "12345678-1234-4234-8234-123456789abc",
    "X-GitHub-Event": "pull_request",
    "X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    ...overrides,
  };
}

function bodyFor(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      action: "synchronize",
      installation: { id: 7654 },
      repository: { id: 9001 },
      sender: { id: 31415 },
      pull_request: {
        number: 42,
        state: "open",
        draft: false,
        merged: false,
        base: { repo: { id: 9001 }, ref: "main", sha: "b".repeat(40) },
        head: { repo: { id: 9001 }, ref: "feature/test-gap", sha: "c".repeat(40) },
        merge_commit_sha: "d".repeat(40),
        merged_at: null,
        updated_at: "2026-08-17T11:59:00.000Z",
      },
      ...overrides,
    }),
  );
}
