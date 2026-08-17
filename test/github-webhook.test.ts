import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import {
  GITHUB_WEBHOOK_MAXIMUM_BODY_BYTES,
  GitHubWebhookFailure,
  verifyAndNormalizeGitHubPullRequestWebhook,
  type GitHubWebhookFailureCode,
} from "../src/github/webhook.ts";

const secret = Buffer.from("0123456789abcdef0123456789abcdef");

test("a valid signed pull-request delivery normalizes only the allowlisted source representation", () => {
  const payload = openPullRequestPayload();
  const request = signedRequest(payload);
  const normalized = verifyAndNormalizeGitHubPullRequestWebhook(request);

  assert.deepEqual(normalized, {
    appId: "4567",
    deliveryGuid: "12345678-1234-4234-8234-123456789abc",
    bodyDigest: `sha256:${createHash("sha256").update(request.body).digest("hex")}`,
    requestBytes: request.body.byteLength,
    installationId: "github.com:installation:7654",
    repositoryId: "github.com:9001",
    action: "synchronize",
    pullRequest: {
      number: 42,
      actorId: "github.com:user:31415",
      state: "open",
      draft: false,
      merged: false,
      baseRepositoryId: "github.com:9001",
      baseRef: "main",
      baseCommitId: `sha1:${"b".repeat(40)}`,
      headRepositoryId: "github.com:9001",
      headRef: "feature/test-gap",
      headCommitId: `sha1:${"c".repeat(40)}`,
      observedTestMergeCommitId: `sha1:${"d".repeat(40)}`,
      mergedAt: null,
      mergeCommitId: null,
      sourceUpdatedAt: "2026-08-17T11:59:00.000Z",
    },
  });
  assert.equal((normalized as unknown as { title?: string }).title, undefined);
  assert.equal((normalized.pullRequest as unknown as { body?: string }).body, undefined);
});

test("authentication runs over the exact bytes and fails without parsing attacker content", () => {
  const request = signedRequest(openPullRequestPayload());
  assertFailure(
    () =>
      verifyAndNormalizeGitHubPullRequestWebhook({
        ...request,
        signature: `sha256:${"0".repeat(64)}`,
        body: Buffer.from("not-json"),
      }),
    "authentication-failed",
  );

  const invalidJson = Buffer.from("{invalid");
  assertFailure(
    () =>
      verifyAndNormalizeGitHubPullRequestWebhook({
        ...request,
        body: invalidJson,
        signature: signatureFor(invalidJson),
      }),
    "malformed-payload",
  );
});

test("header, event, body, action, ID, and pull-request shape bounds fail closed", () => {
  const request = signedRequest(openPullRequestPayload());
  assertFailure(
    () => verifyAndNormalizeGitHubPullRequestWebhook({ ...request, contentType: "text/plain" }),
    "invalid-headers",
  );
  assertFailure(
    () => verifyAndNormalizeGitHubPullRequestWebhook({ ...request, event: "issues" }),
    "unsupported-event",
  );
  assertFailure(
    () =>
      verifyAndNormalizeGitHubPullRequestWebhook({
        ...request,
        body: new Uint8Array(GITHUB_WEBHOOK_MAXIMUM_BODY_BYTES + 1),
      }),
    "body-too-large",
  );
  assertSignedPayloadFailure({ ...openPullRequestPayload(), action: "review_requested" }, "unsupported-action");
  assertSignedPayloadFailure(
    { ...openPullRequestPayload(), repository: { id: 9_007_199_254_740_992 } },
    "malformed-payload",
  );
  const fork = openPullRequestPayload();
  fork.pull_request.head.repo.id = 9002;
  assertSignedPayloadFailure(fork, "unsupported-pull-request-shape");
});

test("a closed merged delivery separates resulting commit identity from pre-merge test identity", () => {
  const payload = openPullRequestPayload();
  payload.action = "closed";
  payload.pull_request.state = "closed";
  payload.pull_request.merged = true;
  payload.pull_request.merged_at = "2026-08-17T12:05:00.000Z";
  payload.pull_request.merge_commit_sha = "e".repeat(40);
  const normalized = verifyAndNormalizeGitHubPullRequestWebhook(signedRequest(payload));
  assert.equal(normalized.pullRequest.observedTestMergeCommitId, null);
  assert.equal(normalized.pullRequest.mergeCommitId, `sha1:${"e".repeat(40)}`);
  assert.equal(normalized.pullRequest.mergedAt, "2026-08-17T12:05:00.000Z");
});

function signedRequest(payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload));
  return {
    appId: "4567",
    secret,
    deliveryGuid: "12345678-1234-4234-8234-123456789abc",
    event: "pull_request",
    signature: signatureFor(body),
    contentType: "application/json",
    body,
  };
}

function signatureFor(body: Uint8Array): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function assertSignedPayloadFailure(payload: unknown, code: GitHubWebhookFailureCode): void {
  assertFailure(() => verifyAndNormalizeGitHubPullRequestWebhook(signedRequest(payload)), code);
}

function assertFailure(callback: () => unknown, code: GitHubWebhookFailureCode): void {
  assert.throws(callback, (error) => error instanceof GitHubWebhookFailure && error.code === code);
}

function openPullRequestPayload() {
  return {
    action: "synchronize",
    installation: { id: 7654 },
    repository: { id: 9001, full_name: "frostyard/example" },
    sender: { id: 31415, login: "source-actor" },
    pull_request: {
      number: 42,
      title: "free-form content is discarded",
      body: "never retain this",
      state: "open",
      draft: false,
      merged: false,
      base: { repo: { id: 9001 }, ref: "main", sha: "b".repeat(40) },
      head: { repo: { id: 9001 }, ref: "feature/test-gap", sha: "c".repeat(40) },
      merge_commit_sha: "d".repeat(40),
      merged_at: null as string | null,
      updated_at: "2026-08-17T11:59:00.000Z",
    },
  };
}
