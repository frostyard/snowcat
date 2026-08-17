import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import {
  refreshArtifactVerifications,
  verifyCompletionArtifacts,
  verifyGitHubArtifact,
} from "../src/queue/artifact-verification.ts";
import { buildQueueMcpServer } from "../src/mcp/server.ts";
import { QueueStore } from "../src/queue/store.ts";
import type { WorkArtifact } from "../src/queue/types.ts";

const REPOSITORY = "frostyard/updex";
const PR_URL = "https://github.com/frostyard/updex/pull/12";
const ISSUE_URL = "https://github.com/frostyard/updex/issues/7";
const clock = () => new Date("2026-08-17T20:00:00.000Z");
// Verification treats 404 as absence only when a credential was presented.
process.env.FLUENT_GITHUB_TOKEN ??= "test-token";

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    html_url: PR_URL,
    state: "open",
    merged: false,
    merged_at: null,
    closed_at: null,
    head: { sha: "0123456789abcdef0123456789abcdef01234567" },
    base: { repo: { full_name: "frostyard/updex" } },
    ...overrides,
  };
}

function issue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    html_url: ISSUE_URL,
    state: "open",
    closed_at: null,
    repository_url: "https://api.github.com/repos/frostyard/updex",
    ...overrides,
  };
}

/** Serves canned JSON by request path; `status` forces one status for every request. */
function apiFetcher(routes: Record<string, unknown>, options: { status?: number; body?: string; fail?: boolean } = {}) {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url.pathname);
    if (options.fail) throw new Error("connection reset");
    if (options.status !== undefined) {
      return new Response(options.body ?? "{}", { status: options.status, headers: { "content-type": "application/json" } });
    }
    const body = routes[url.pathname];
    if (body === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, requests };
}

const PR_PATH = "/repos/frostyard/updex/pulls/12";
const ISSUE_PATH = "/repos/frostyard/updex/issues/7";
const prArtifact: WorkArtifact = { kind: "pull-request", url: PR_URL };
const issueArtifact: WorkArtifact = { kind: "issue", url: ISSUE_URL };

test("a pull request is verified with its state and head, and mismatches are rejected", async () => {
  const open = await verifyGitHubArtifact(REPOSITORY, prArtifact, { fetcher: apiFetcher({ [PR_PATH]: pullRequest() }).fetcher, clock });
  assert.deepEqual(open, {
    kind: "verified",
    verification: {
      status: "verified",
      verifiedAt: "2026-08-17T20:00:00.000Z",
      number: 12,
      state: "open",
      headSha: "0123456789abcdef0123456789abcdef01234567",
    },
  });

  const merged = await verifyGitHubArtifact(REPOSITORY, prArtifact, {
    fetcher: apiFetcher({ [PR_PATH]: pullRequest({ state: "closed", merged: true, merged_at: "2026-08-17T19:00:00Z", closed_at: "2026-08-17T19:00:00Z" }) }).fetcher,
    clock,
  });
  assert.equal(merged.kind, "verified");
  if (merged.kind === "verified") {
    assert.equal(merged.verification.state, "merged");
    assert.equal(merged.verification.mergedAt, "2026-08-17T19:00:00Z");
  }

  const closed = await verifyGitHubArtifact(REPOSITORY, prArtifact, {
    fetcher: apiFetcher({ [PR_PATH]: pullRequest({ state: "closed", closed_at: "2026-08-17T19:00:00Z" }) }).fetcher,
    clock,
  });
  assert.equal(closed.kind === "verified" && closed.verification.state, "closed");

  for (const [label, body] of Object.entries({
    "other base repository": pullRequest({ base: { repo: { full_name: "frostyard/lodge" } } }),
    "different number": pullRequest({ number: 13 }),
    "different location": pullRequest({ html_url: "https://github.com/frostyard/updex/pull/13" }),
  })) {
    const check = await verifyGitHubArtifact(REPOSITORY, prArtifact, { fetcher: apiFetcher({ [PR_PATH]: body }).fetcher, clock });
    assert.equal(check.kind, "rejected", label);
  }
  const missing = await verifyGitHubArtifact(REPOSITORY, prArtifact, { fetcher: apiFetcher({}).fetcher, clock });
  assert.equal(missing.kind, "rejected");
  assert.match(missing.kind === "rejected" ? missing.reason : "", /does not exist/);

  // Without a credential, 404 is ambiguous (private repository or missing) and must not refuse the completion.
  const token = process.env.FLUENT_GITHUB_TOKEN;
  delete process.env.FLUENT_GITHUB_TOKEN;
  try {
    const ambiguous = await verifyGitHubArtifact(REPOSITORY, prArtifact, { fetcher: apiFetcher({}).fetcher, clock });
    assert.equal(ambiguous.kind, "unverified");
    assert.match(ambiguous.kind === "unverified" ? ambiguous.verification.reason : "", /without FLUENT_GITHUB_TOKEN/);
  } finally {
    if (token !== undefined) process.env.FLUENT_GITHUB_TOKEN = token;
  }
  const wrongRepoUrl = await verifyGitHubArtifact(REPOSITORY, { kind: "pull-request", url: "https://github.com/frostyard/lodge/pull/12" }, { fetcher: apiFetcher({}).fetcher, clock });
  assert.equal(wrongRepoUrl.kind, "rejected");
});

test("an issue is verified by repository, and a pull request reported as an issue is rejected", async () => {
  const ok = await verifyGitHubArtifact(REPOSITORY, issueArtifact, { fetcher: apiFetcher({ [ISSUE_PATH]: issue() }).fetcher, clock });
  assert.equal(ok.kind, "verified");
  assert.equal(ok.kind === "verified" && ok.verification.state, "open");
  const asPr = await verifyGitHubArtifact(REPOSITORY, issueArtifact, {
    fetcher: apiFetcher({ [ISSUE_PATH]: issue({ pull_request: { url: "x" } }) }).fetcher,
    clock,
  });
  assert.equal(asPr.kind, "rejected");
  const elsewhere = await verifyGitHubArtifact(REPOSITORY, issueArtifact, {
    fetcher: apiFetcher({ [ISSUE_PATH]: issue({ repository_url: "https://api.github.com/repos/frostyard/lodge" }) }).fetcher,
    clock,
  });
  assert.equal(elsewhere.kind, "rejected");
});

test("an unavailable or unreadable GitHub answer records unverified instead of rejecting", async () => {
  for (const options of [{ fail: true }, { status: 503 }, { status: 403 }, { status: 200, body: "[]" }, { status: 200, body: "nope" }]) {
    const check = await verifyGitHubArtifact(REPOSITORY, prArtifact, { fetcher: apiFetcher({}, options).fetcher, clock });
    assert.equal(check.kind, "unverified", JSON.stringify(options));
    if (check.kind === "unverified") {
      assert.equal(check.verification.attemptedAt, "2026-08-17T20:00:00.000Z");
      assert.ok(check.verification.reason.length > 0);
    }
  }
  const verified = await verifyCompletionArtifacts(
    REPOSITORY,
    [prArtifact, { kind: "report", url: "https://example.com/r" }, issueArtifact],
    { fetcher: apiFetcher({ [PR_PATH]: pullRequest() }, { status: 502 }).fetcher, clock },
  );
  assert.equal(verified[0]?.verification?.status, "unverified");
  assert.equal(verified[1]?.verification, undefined, "non-GitHub artifacts pass through untouched");
  assert.equal(verified[2]?.verification?.status, "unverified");
  await assert.rejects(
    verifyCompletionArtifacts(REPOSITORY, [prArtifact], { fetcher: apiFetcher({}).fetcher, clock }),
    /artifact rejected: pull-request .* does not exist/,
  );
});

async function seedClaimed(queue: QueueStore) {
  queue.setRepositoryEnabled(REPOSITORY, true);
  queue.enqueueSeed({
    repository: REPOSITORY,
    kind: "issue-resolution",
    objective: "Resolve #7",
    instructions: "Open a PR.",
    acceptanceCriteria: ["PR open."],
    allowedActions: ["read", "write", "run-tests", "open-issue", "open-pr"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  return queue.claim({ worker: "claude:verify-test" })!;
}

async function connect(path: string, fetcher: typeof fetch) {
  const server = buildQueueMcpServer(path, { fetcher, clock });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "verify-test", version: "0.1.0" });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const parse = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, any>;

test("MCP completion verifies reported pull requests: rejected stays claimed, verified is stored, worker cannot supply verification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-verify-mcp-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  const claimed = await seedClaimed(queue);
  const routes: Record<string, unknown> = { [PR_PATH]: pullRequest({ base: { repo: { full_name: "frostyard/lodge" } } }) };
  const { fetcher } = apiFetcher(routes);
  const { client, close } = await connect(path, fetcher);
  test.after(async () => { await close(); queue.close(); });
  const complete = (artifacts: unknown[]) =>
    client.callTool({
      name: "complete_work",
      arguments: {
        id: claimed.id,
        leaseToken: claimed.leaseToken,
        worker: "claude:verify-test",
        result: { summary: "Opened the PR.", evidence: ["ran npm test"], artifacts },
        followUps: [],
      },
    });

  // Worker-supplied verification is refused at the schema.
  const forged = (await complete([{ kind: "pull-request", url: PR_URL, verification: { status: "verified" } }])) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(forged.isError, true);
  assert.match(forged.content[0]!.text, /verification|Unrecognized/);
  assert.equal(queue.get(claimed.id)?.status, "claimed");

  // A pull request that targets another repository is rejected; the item stays claimed.
  const rejected = (await complete([{ kind: "pull-request", url: PR_URL }])) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0]!.text, /targets frostyard\/lodge, not frostyard\/updex/);
  assert.equal(queue.get(claimed.id)?.status, "claimed");

  // The corrected report is verified and stored with Fluent's own observation.
  routes[PR_PATH] = pullRequest();
  const accepted = parse(await complete([{ kind: "pull-request", url: PR_URL, description: "Fix" }]));
  assert.equal(accepted.completed.status, "completed");
  assert.equal(accepted.completed.delivery, "open");
  assert.deepEqual(accepted.completed.result.artifacts[0].verification, {
    status: "verified",
    verifiedAt: "2026-08-17T20:00:00.000Z",
    number: 12,
    state: "open",
    headSha: "0123456789abcdef0123456789abcdef01234567",
  });
  const stored = queue.get(claimed.id)!;
  assert.equal(stored.delivery, "open");
  assert.equal(stored.result?.artifacts[0]?.verification?.status, "verified");
});

test("MCP completion during a GitHub outage records unverified, and verify-artifacts closes the loop later", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-verify-outage-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  const claimed = await seedClaimed(queue);
  const outage = apiFetcher({}, { status: 504 });
  const { client, close } = await connect(path, outage.fetcher);
  test.after(async () => { await close(); queue.close(); });

  const accepted = parse(
    await client.callTool({
      name: "complete_work",
      arguments: {
        id: claimed.id,
        leaseToken: claimed.leaseToken,
        worker: "claude:verify-test",
        result: { summary: "Opened the PR.", evidence: ["ran npm test"], artifacts: [{ kind: "pull-request", url: PR_URL }] },
        followUps: [],
      },
    }),
  );
  assert.equal(accepted.completed.status, "completed");
  assert.equal(accepted.completed.delivery, "unverified");
  assert.deepEqual(accepted.completed.result.artifacts[0].verification, {
    status: "unverified",
    attemptedAt: "2026-08-17T20:00:00.000Z",
    reason: "GitHub API returned HTTP 504",
  });

  // Still down: the refresh leaves it alone and reports it.
  const stillDown = await refreshArtifactVerifications(queue, { fetcher: outage.fetcher, clock });
  assert.equal(stillDown.checked, 1);
  assert.deepEqual(stillDown.updated, []);
  assert.equal(stillDown.unavailable.length, 1);
  assert.equal(queue.get(claimed.id)?.delivery, "unverified");

  // Back up and open: verified, delivery open, event recorded.
  const routes: Record<string, unknown> = { [PR_PATH]: pullRequest() };
  const live = apiFetcher(routes);
  const first = await refreshArtifactVerifications(queue, { fetcher: live.fetcher, clock });
  assert.deepEqual(first.updated, [{ id: claimed.id, url: PR_URL, status: "verified", state: "open" }]);
  assert.equal(queue.get(claimed.id)?.delivery, "open");
  const events = queue.events(claimed.id).filter((event) => event.type === "artifact.verified");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.actor, "operator:cli");
  assert.deepEqual(events[0]?.payload, { url: PR_URL, kind: "pull-request", status: "verified", state: "open" });

  // Unchanged state records nothing; merge is recorded once and then the item is terminal.
  const same = await refreshArtifactVerifications(queue, { fetcher: live.fetcher, clock });
  assert.deepEqual(same.updated, []);
  routes[PR_PATH] = pullRequest({ state: "closed", merged: true, merged_at: "2026-08-17T21:00:00Z" });
  const merged = await refreshArtifactVerifications(queue, { fetcher: live.fetcher, clock });
  assert.deepEqual(merged.updated.map((entry) => entry.state), ["merged"]);
  assert.equal(queue.get(claimed.id)?.delivery, "merged");
  const terminal = await refreshArtifactVerifications(queue, { fetcher: live.fetcher, clock });
  assert.equal(terminal.checked, 0, "merged artifacts are not re-checked");
  assert.equal(queue.events(claimed.id).filter((event) => event.type === "artifact.verified").at(-1)?.payload.previousState, "open");

  // A later rejection (the pull request vanished) is recorded as unverified with the reason, never deleted.
  const other = new QueueStore(join(directory, "other.db"));
  const otherClaim = await seedClaimed(other);
  other.complete({
    id: otherClaim.id,
    leaseToken: otherClaim.leaseToken!,
    worker: "claude:verify-test",
    result: { summary: "s", evidence: [], artifacts: [{ kind: "pull-request", url: PR_URL }] },
    followUps: [],
  });
  const gone = await refreshArtifactVerifications(other, { fetcher: apiFetcher({}).fetcher, clock });
  assert.equal(gone.rejected.length, 1);
  const recorded = other.get(otherClaim.id)!;
  assert.equal(recorded.result?.artifacts[0]?.url, PR_URL);
  assert.equal(recorded.result?.artifacts[0]?.verification?.status, "unverified");
  assert.match((recorded.result?.artifacts[0]?.verification as { reason: string }).reason, /^rejected: /);
  assert.equal(recorded.delivery, "unverified");
  other.close();
});

test("delivery derives from pull-request artifacts only, and recordArtifactVerification guards its inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-delivery-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  const claimed = await seedClaimed(queue);
  assert.equal(queue.get(claimed.id)?.delivery, undefined, "only completed items carry delivery");
  assert.throws(() => queue.recordArtifactVerification(claimed.id, PR_URL, { status: "verified", verifiedAt: "t", number: 1, state: "open" }, "operator:test"), /not completed/);
  queue.complete({
    id: claimed.id,
    leaseToken: claimed.leaseToken!,
    worker: "claude:verify-test",
    result: {
      summary: "s",
      evidence: [],
      artifacts: [
        { kind: "issue", url: ISSUE_URL, verification: { status: "verified", verifiedAt: "t", number: 7, state: "closed" } },
        { kind: "report", url: "https://example.com/report" },
      ],
    },
    followUps: [],
  });
  assert.equal(queue.get(claimed.id)?.delivery, "none", "issues and reports do not constitute delivery");
  assert.throws(() => queue.recordArtifactVerification(claimed.id, "https://example.com/report", { status: "verified", verifiedAt: "t", number: 1, state: "open" }, "operator:test"), /not verifiable/);
  assert.throws(() => queue.recordArtifactVerification(claimed.id, PR_URL, { status: "verified", verifiedAt: "t", number: 1, state: "open" }, "operator:test"), /has no artifact/);
  assert.throws(() => queue.recordArtifactVerification(claimed.id, ISSUE_URL, { status: "verified", verifiedAt: "t", number: 0, state: "open" }, "operator:test"), /number is invalid/);
  assert.throws(() => queue.recordArtifactVerification(claimed.id, ISSUE_URL, { status: "bogus" } as never, "operator:test"), /status is invalid/);
  const updated = queue.recordArtifactVerification(claimed.id, ISSUE_URL, { status: "unverified", attemptedAt: "t", reason: "later" }, "operator:test");
  assert.equal(updated.result?.artifacts[0]?.verification?.status, "unverified");
  assert.equal(updated.result?.artifacts[1]?.verification, undefined);
});
