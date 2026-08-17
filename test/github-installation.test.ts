import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  inspectGitHubRepositoryInstallation,
} from "../src/github/installation.ts";
import type { GitHubDeliveryFetch } from "../src/github/delivery-api.ts";

const jwt = `${"a".repeat(16)}.${"b".repeat(16)}.${"c".repeat(16)}`;
const now = () => new Date("2026-08-17T18:00:00.000Z");

test("repository installation inspection binds the configured App without retaining broad response content", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const result = await inspectGitHubRepositoryInstallation({
    appId: "4567",
    repositoryId: "github.com:9001",
    owner: "frostyard",
    name: "fluent",
    getAppJwt: () => jwt,
    now,
    fetcher: async (input, init) => {
      const headers = new Headers(init?.headers);
      requests.push({ url: String(input), authorization: headers.get("authorization") });
      return Response.json(installation());
    },
  });
  assert.deepEqual(requests, [{
    url: "https://api.github.com/repos/frostyard/fluent/installation",
    authorization: `Bearer ${jwt}`,
  }]);
  assert.equal(result.kind, "observed");
  if (result.kind !== "observed") return;
  assert.equal(result.installationId, "github.com:installation:7654");
  assert.equal(result.access, "active");
  assert.equal(result.repositoryId, "github.com:9001");
  assert.equal(result.targetType, "Organization");
  assert.equal(result.repositorySelection, "selected");
  assert.match(result.responseDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal((result as unknown as { account?: unknown }).account, undefined);
  assert.equal((result as unknown as { permissions?: unknown }).permissions, undefined);
});

test("installation inspection distinguishes absence, suspension, and permission mismatch", async () => {
  const base = {
    appId: "4567",
    repositoryId: "github.com:9001",
    owner: "frostyard",
    name: "fluent",
    getAppJwt: () => jwt,
    now,
  };
  const missing = await inspectGitHubRepositoryInstallation({
    ...base,
    fetcher: async () => new Response(null, { status: 404 }),
  });
  assert.equal(missing.kind, "not-installed");
  if (missing.kind === "not-installed") {
    const emptyBodyDigest = createHash("sha256").update(new Uint8Array()).digest("hex");
    assert.equal(
      missing.responseDigest,
      `sha256:${createHash("sha256").update(`404:${emptyBodyDigest}`).digest("hex")}`,
    );
  }

  const suspended = await inspectGitHubRepositoryInstallation({
    ...base,
    fetcher: async () => Response.json(installation({ suspended_at: "2026-08-17T17:00:00Z" })),
  });
  assert.equal(suspended.kind, "observed");
  if (suspended.kind === "observed") assert.equal(suspended.access, "suspended");

  const overprivileged = await inspectGitHubRepositoryInstallation({
    ...base,
    fetcher: async () => Response.json(installation({
      permissions: { ...permissions(), issues: "write" },
    })),
  });
  assert.equal(overprivileged.kind, "observed");
  if (overprivileged.kind === "observed") assert.equal(overprivileged.access, "permission-mismatch");

  const wrongApp = await inspectGitHubRepositoryInstallation({
    ...base,
    fetcher: async () => Response.json(installation({ app_id: 9999 })),
  });
  assert.equal(wrongApp.kind, "unavailable");
});

test("installation inspection bounds redirects, bodies, and JWT refresh", async () => {
  let jwtCount = 0;
  let requestCount = 0;
  const fetcher: GitHubDeliveryFetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return new Response(null, {
        status: 301,
        headers: { location: "/repos/frostyard/fluent-renamed/installation" },
      });
    }
    return Response.json(installation());
  };
  const redirected = await inspectGitHubRepositoryInstallation({
    appId: "4567",
    repositoryId: "github.com:9001",
    owner: "frostyard",
    name: "fluent",
    getAppJwt: () => {
      jwtCount += 1;
      return jwt;
    },
    fetcher,
    now,
  });
  assert.equal(redirected.kind, "observed");
  assert.equal(requestCount, 2);
  assert.equal(jwtCount, 2);

  const unsafeRedirect = await inspectGitHubRepositoryInstallation({
    appId: "4567",
    repositoryId: "github.com:9001",
    owner: "frostyard",
    name: "fluent",
    getAppJwt: () => jwt,
    fetcher: async () => new Response(null, {
      status: 301,
      headers: { location: "https://attacker.example/repos/frostyard/fluent/installation" },
    }),
    now,
  });
  assert.equal(unsafeRedirect.kind, "unavailable");

  const oversized = await inspectGitHubRepositoryInstallation({
    appId: "4567",
    repositoryId: "github.com:9001",
    owner: "frostyard",
    name: "fluent",
    getAppJwt: () => jwt,
    fetcher: async () => new Response("{}", { headers: { "content-length": "1048577" } }),
    now,
  });
  assert.equal(oversized.kind, "unavailable");
});

function installation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7654,
    app_id: 4567,
    target_type: "Organization",
    repository_selection: "selected",
    suspended_at: null,
    permissions: permissions(),
    events: [
      "branch_protection_rule",
      "check_run",
      "check_suite",
      "installation",
      "installation_repositories",
      "pull_request",
      "push",
      "repository_ruleset",
      "status",
    ],
    account: { login: "discard-me" },
    ...overrides,
  };
}

function permissions(): Record<string, string> {
  return {
    administration: "read",
    checks: "read",
    contents: "read",
    metadata: "read",
    pull_requests: "read",
    statuses: "read",
  };
}
