import assert from "node:assert/strict";
import test from "node:test";

import {
  GITHUB_DELIVERY_AUDIT_MAXIMUM_PAGES,
  auditGitHubAppDeliveries,
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
