import assert from "node:assert/strict";
import test from "node:test";

import {
  GITHUB_DELIVERY_AUDIT_MAXIMUM_PAGES,
  GITHUB_DELIVERY_AUDIT_MAXIMUM_PAGE_BYTES,
  auditGitHubAppDeliveries,
  fetchGitHubPullRequestDeliveryDetail,
  selectGitHubRepositoryPullRequestDeliveries,
  type GitHubDeliveryFetch,
} from "../src/github/delivery-api.ts";

const jwt = `${"a".repeat(16)}.${"b".repeat(16)}.${"c".repeat(16)}`;
const now = () => new Date("2026-08-17T16:00:00.000Z");

test("the App delivery audit follows cursor links and selects bounded repository pull-request summaries", async () => {
  const requests: Array<{ url: string; authorization: string | null; apiVersion: string | null }> = [];
  let authorizationCount = 0;
  const fetcher: GitHubDeliveryFetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({
      url,
      authorization: headers.get("authorization"),
      apiVersion: headers.get("x-github-api-version"),
    });
    if (url.endsWith("?per_page=100")) {
      return Response.json(
        [
          delivery({ id: 101, guid: "00000000-0000-4000-8000-000000000101", action: "opened" }),
          { id: 102, event: "issues", body: "discard me" },
          delivery({
            id: 103,
            guid: "00000000-0000-4000-8000-000000000103",
            action: "review_requested",
            repository_id: 9001,
          }),
        ],
        {
          headers: {
            link: '<https://api.github.com/app/hook/deliveries?per_page=100&cursor=next_2>; rel="next"',
          },
        },
      );
    }
    assert.equal(url, "https://api.github.com/app/hook/deliveries?per_page=100&cursor=next_2");
    return Response.json([
      delivery({
        id: 104,
        guid: "00000000-0000-4000-8000-000000000104",
        action: "closed",
        repository_id: 9002,
      }),
    ]);
  };

  const result = await auditGitHubAppDeliveries({
    appId: "4567",
    getAppJwt: () => {
      authorizationCount += 1;
      return jwt;
    },
    fetcher,
    now,
  });
  assert.equal(result.kind, "complete");
  if (result.kind !== "complete") return;
  assert.equal(result.coveredThrough, "2026-08-17T16:00:00.000Z");
  assert.equal(result.pageCount, 2);
  assert.equal(result.deliveryCount, 4);
  assert.match(result.pageProofDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.deliveries.length, 3);
  assert.equal(authorizationCount, 2);
  assert.deepEqual(requests, [
    {
      url: "https://api.github.com/app/hook/deliveries?per_page=100",
      authorization: `Bearer ${jwt}`,
      apiVersion: "2026-03-10",
    },
    {
      url: "https://api.github.com/app/hook/deliveries?per_page=100&cursor=next_2",
      authorization: `Bearer ${jwt}`,
      apiVersion: "2026-03-10",
    },
  ]);

  const selection = selectGitHubRepositoryPullRequestDeliveries(
    result,
    "github.com:9001",
    "github.com:installation:7654",
  );
  assert.equal(selection.deliveryCount, 2);
  assert.deepEqual(selection.unsupportedDeliveryIds, ["103"]);
  assert.match(selection.selectedResponseDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(selection.deliveries[0], {
    deliveryId: "101",
    deliveryGuid: "00000000-0000-4000-8000-000000000101",
    deliveredAt: "2026-08-17T15:55:00.000Z",
    redelivery: false,
    statusCode: 200,
    event: "pull_request",
    action: "opened",
    actionSupported: true,
    installationId: "github.com:installation:7654",
    repositoryId: "github.com:9001",
  });
  assert.equal((selection.deliveries[0] as unknown as { body?: string }).body, undefined);
});

test("rate-limit instructions use the later safe retry time and disclose no response body", async () => {
  const resetAt = Math.floor(new Date("2026-08-17T16:02:00.000Z").getTime() / 1000);
  const result = await auditGitHubAppDeliveries({
    appId: "4567",
    getAppJwt: () => jwt,
    now,
    fetcher: async () => new Response("secret upstream detail", {
      status: 429,
      headers: {
        "retry-after": "30",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetAt),
      },
    }),
  });
  assert.deepEqual(result, {
    kind: "incomplete",
    appId: "4567",
    attemptedAt: "2026-08-17T16:00:00.000Z",
    cause: "source-unavailable",
    pageCount: 0,
    deliveryCount: 0,
    retryAt: "2026-08-17T16:02:00.000Z",
    diagnostic: "rate-limited",
  });
});

test("one same-origin redirect refreshes App authorization without widening the endpoint", async () => {
  let authorizationCount = 0;
  let requestCount = 0;
  const result = await auditGitHubAppDeliveries({
    appId: "4567",
    getAppJwt: () => {
      authorizationCount += 1;
      return jwt;
    },
    now,
    fetcher: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response(null, {
          status: 301,
          headers: { location: "/app/hook/deliveries?per_page=100&cursor=redirected" },
        });
      }
      return Response.json([]);
    },
  });
  assert.equal(result.kind, "complete");
  assert.equal(requestCount, 2);
  assert.equal(authorizationCount, 2);
});

test("delivery list and detail abort pending JWT acquisition without issuing requests", { timeout: 1_000 }, async () => {
  let fetchCount = 0;
  const fetcher: GitHubDeliveryFetch = async () => {
    fetchCount += 1;
    return Response.json([]);
  };

  const auditController = new AbortController();
  let rejectAuditJwt!: (error: Error) => void;
  const auditPromise = auditGitHubAppDeliveries({
    appId: "4567",
    getAppJwt: () =>
      new Promise<string>((_resolve, reject) => {
        rejectAuditJwt = reject;
      }),
    fetcher,
    signal: auditController.signal,
    now,
  });
  auditController.abort();
  const audit = await auditPromise;
  assert.equal(audit.kind, "incomplete");
  if (audit.kind === "incomplete") {
    assert.equal(audit.cause, "source-unavailable");
    assert.equal(audit.diagnostic, "authorization-unavailable");
  }

  const detailController = new AbortController();
  let rejectDetailJwt!: (error: Error) => void;
  const detailPromise = fetchGitHubPullRequestDeliveryDetail({
    appId: "4567",
    delivery: {
      deliveryId: "301",
      deliveryGuid: "00000000-0000-4000-8000-000000000301",
      deliveredAt: "2026-08-17T15:55:00.000Z",
      redelivery: false,
      statusCode: 200,
      event: "pull_request",
      action: "synchronize",
      actionSupported: true,
      installationId: "github.com:installation:7654",
      repositoryId: "github.com:9001",
    },
    getAppJwt: () =>
      new Promise<string>((_resolve, reject) => {
        rejectDetailJwt = reject;
      }),
    fetcher,
    signal: detailController.signal,
    now,
  });
  detailController.abort();
  const detail = await detailPromise;
  assert.equal(detail.kind, "incomplete");
  if (detail.kind === "incomplete") {
    assert.equal(detail.cause, "source-unavailable");
    assert.equal(detail.diagnostic, "authorization-unavailable");
  }
  assert.equal(fetchCount, 0);

  rejectAuditJwt(new Error("late audit JWT failure"));
  rejectDetailJwt(new Error("late detail JWT failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("delivery detail produces an API repair input without retaining free-form response content", async () => {
  const summary = {
    deliveryId: "301",
    deliveryGuid: "00000000-0000-4000-8000-000000000301",
    deliveredAt: "2026-08-17T15:55:00.000Z",
    redelivery: false,
    statusCode: 200,
    event: "pull_request" as const,
    action: "synchronize",
    actionSupported: true,
    installationId: "github.com:installation:7654",
    repositoryId: "github.com:9001",
  };
  const detail = await fetchGitHubPullRequestDeliveryDetail({
    appId: "4567",
    delivery: summary,
    getAppJwt: () => jwt,
    now,
    fetcher: async (input) => {
      assert.equal(String(input), "https://api.github.com/app/hook/deliveries/301");
      return Response.json({
        ...delivery({
          id: 301,
          guid: summary.deliveryGuid,
          action: "synchronize",
        }),
        request: { payload: openPullRequestPayload() },
        response: { payload: "free-form upstream response must not survive" },
      });
    },
  });
  assert.equal(detail.kind, "complete");
  if (detail.kind !== "complete") return;
  assert.deepEqual(detail.repair, {
    appId: "4567",
    deliveryId: "301",
    deliveryGuid: summary.deliveryGuid,
    deliveredAt: summary.deliveredAt,
    redelivery: false,
    statusCode: 200,
    responseDigest: detail.repair.responseDigest,
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
      sourceUpdatedAt: "2026-08-17T15:54:00.000Z",
    },
  });
  assert.match(detail.repair.responseDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal((detail.repair as unknown as { response?: unknown }).response, undefined);

  let unsupportedFetchCount = 0;
  const unsupported = await fetchGitHubPullRequestDeliveryDetail({
    appId: "4567",
    delivery: { ...summary, action: "review_requested", actionSupported: false },
    getAppJwt: () => jwt,
    now,
    fetcher: async () => {
      unsupportedFetchCount += 1;
      return Response.json({});
    },
  });
  assert.equal(unsupported.kind, "incomplete");
  if (unsupported.kind === "incomplete") {
    assert.equal(unsupported.cause, "unsupported-relevant-delivery");
  }
  assert.equal(unsupportedFetchCount, 0);
});

test("malformed relevant deliveries and unsafe pagination fail closed without partial results", async () => {
  const malformed = await auditGitHubAppDeliveries({
    appId: "4567",
    getAppJwt: () => jwt,
    now,
    fetcher: async () => Response.json([
      delivery({ id: 201, guid: "00000000-0000-4000-8000-000000000201", installation_id: null }),
    ]),
  });
  assert.equal(malformed.kind, "incomplete");
  if (malformed.kind === "incomplete") {
    assert.equal(malformed.cause, "normalization-failed");
    assert.equal(malformed.pageCount, 0);
  }

  const unsafeLink = await auditGitHubAppDeliveries({
    appId: "4567",
    getAppJwt: () => jwt,
    now,
    fetcher: async () => Response.json([], {
      headers: {
        link: '<https://attacker.example/app/hook/deliveries?per_page=100&cursor=next>; rel="next"',
      },
    }),
  });
  assert.equal(unsafeLink.kind, "incomplete");
  if (unsafeLink.kind === "incomplete") {
    assert.equal(unsafeLink.cause, "pagination-incomplete");
    assert.equal(unsafeLink.diagnostic, "invalid-pagination");
  }

  const oversized = await auditGitHubAppDeliveries({
    appId: "4567",
    getAppJwt: () => jwt,
    now,
    fetcher: async () => new Response(new Uint8Array(GITHUB_DELIVERY_AUDIT_MAXIMUM_PAGE_BYTES + 1)),
  });
  assert.equal(oversized.kind, "incomplete");
  if (oversized.kind === "incomplete") {
    assert.equal(oversized.cause, "request-budget-exhausted");
    assert.equal(oversized.diagnostic, "response-too-large");
  }
});

test("a continuing cursor at the page budget is an incomplete audit", async () => {
  let requestCount = 0;
  const result = await auditGitHubAppDeliveries({
    appId: "4567",
    getAppJwt: () => jwt,
    now,
    fetcher: async () => {
      requestCount += 1;
      return Response.json([{ id: requestCount, event: "issues" }], {
        headers: {
          link: `<https://api.github.com/app/hook/deliveries?per_page=100&cursor=cursor_${requestCount}>; rel="next"`,
        },
      });
    },
  });
  assert.equal(requestCount, GITHUB_DELIVERY_AUDIT_MAXIMUM_PAGES);
  assert.equal(result.kind, "incomplete");
  if (result.kind === "incomplete") {
    assert.equal(result.cause, "request-budget-exhausted");
    assert.equal(result.diagnostic, "page-limit");
    assert.equal(result.pageCount, GITHUB_DELIVERY_AUDIT_MAXIMUM_PAGES);
    assert.equal(result.deliveryCount, GITHUB_DELIVERY_AUDIT_MAXIMUM_PAGES);
  }
});

function delivery(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 100,
    guid: "00000000-0000-4000-8000-000000000100",
    delivered_at: "2026-08-17T15:55:00Z",
    redelivery: false,
    status_code: 200,
    event: "pull_request",
    action: "opened",
    installation_id: 7654,
    repository_id: 9001,
    response: { payload: "must not survive normalization" },
    ...overrides,
  };
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
      merged_at: null,
      updated_at: "2026-08-17T15:54:00.000Z",
    },
  };
}
