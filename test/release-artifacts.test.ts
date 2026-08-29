import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { buildQueueMcpServer } from "../src/mcp/server.ts";
import {
  attachVerifiedArtifact,
  artifactKindFromUrl,
  refreshArtifactVerifications,
  verifyGitHubArtifact,
} from "../src/queue/artifact-verification.ts";
import { QueueStore } from "../src/queue/store.ts";
import { deriveDelivery, type DeliveryState, type WorkArtifact, type WorkResult } from "../src/queue/types.ts";

// Release artifacts (ADR-0066 decision 4): a version-boundary slice's work is
// preparing the release; a human publishes the tag; the sweep observes it.
// Snowcat only ever reads — every request below is a GET.
const REPOSITORY = "frostyard/updex";
const TAG = "v1.4.0";
const RELEASE_URL = `https://github.com/frostyard/updex/releases/tag/${TAG}`;
const RELEASE_TAG_PATH = `/repos/frostyard/updex/releases/tags/${TAG}`;
const RELEASE_LIST_PATH = "/repos/frostyard/updex/releases";
const PR_URL = "https://github.com/frostyard/updex/pull/12";
const PR_PATH = "/repos/frostyard/updex/pulls/12";
const PR_TEMPLATE_PATH = "/repos/frostyard/updex/contents/.github/pull_request_template.md";
const clock = () => new Date("2026-08-17T20:00:00.000Z");
const releaseArtifact: WorkArtifact = { kind: "release", url: RELEASE_URL };
// Verification treats 404 as absence only when a credential was presented.
process.env.SNOWCAT_GITHUB_TOKEN = "test-token";

function release(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4242,
    tag_name: TAG,
    draft: false,
    prerelease: false,
    html_url: RELEASE_URL,
    url: "https://api.github.com/repos/frostyard/updex/releases/4242",
    published_at: "2026-08-17T18:00:00Z",
    ...overrides,
  };
}

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    html_url: PR_URL,
    state: "open",
    merged: false,
    head: { sha: "0123456789abcdef0123456789abcdef01234567" },
    base: { repo: { full_name: REPOSITORY } },
    body: "## Summary\n\nResolve the issue.\n\n## Verification\n\nTests passed.\n\n## Risk tier\n\nTier 2",
    ...overrides,
  };
}

/** Serves canned JSON by request path (query strings ignored); `status`/`fail` force one answer. */
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

test("a published release verifies with its tag and id; a draft is observed through the release listing", async () => {
  const published = apiFetcher({ [RELEASE_TAG_PATH]: release() });
  const check = await verifyGitHubArtifact(REPOSITORY, releaseArtifact, { fetcher: published.fetcher, clock });
  assert.deepEqual(check, {
    kind: "verified",
    verification: {
      status: "verified",
      verifiedAt: "2026-08-17T20:00:00.000Z",
      number: 4242,
      state: "published",
      tag: TAG,
      publishedAt: "2026-08-17T18:00:00Z",
    },
  });
  assert.deepEqual(published.requests, [RELEASE_TAG_PATH], "a published release costs one read");

  // A draft has no tag for GitHub to answer by, so the by-tag read 404s and one
  // bounded listing page names it. It verifies — it is not delivered.
  const draft = apiFetcher({
    [RELEASE_LIST_PATH]: [
      release({ id: 7, tag_name: "v1.3.0", url: "https://api.github.com/repos/frostyard/updex/releases/7" }),
      release({ draft: true, published_at: null, html_url: "https://github.com/frostyard/updex/releases/tag/untagged-abc" }),
    ],
  });
  const drafted = await verifyGitHubArtifact(REPOSITORY, releaseArtifact, { fetcher: draft.fetcher, clock });
  assert.equal(drafted.kind, "verified");
  assert.equal(drafted.kind === "verified" && drafted.verification.state, "draft");
  assert.equal(drafted.kind === "verified" && drafted.verification.tag, TAG);
  assert.equal(drafted.kind === "verified" && drafted.verification.publishedAt, undefined);
  assert.deepEqual(draft.requests, [RELEASE_TAG_PATH, RELEASE_LIST_PATH]);
});

test("a release GitHub does not have, or has elsewhere, or has under another tag, is rejected", async () => {
  const missing = await verifyGitHubArtifact(REPOSITORY, releaseArtifact, {
    fetcher: apiFetcher({ [RELEASE_LIST_PATH]: [] }).fetcher,
    clock,
  });
  assert.equal(missing.kind, "rejected");
  assert.match(missing.kind === "rejected" ? missing.reason : "", /does not exist on GitHub/);

  // A release URL naming another repository is refused before GitHub is asked.
  const foreign = apiFetcher({ [RELEASE_TAG_PATH]: release() });
  const elsewhere = await verifyGitHubArtifact(
    REPOSITORY,
    { kind: "release", url: `https://github.com/frostyard/lodge/releases/tag/${TAG}` },
    { fetcher: foreign.fetcher, clock },
  );
  assert.equal(elsewhere.kind, "rejected");
  assert.deepEqual(foreign.requests, [], "a foreign slug is rejected without a request");

  // GitHub's own answer decides the repository binding: a release whose API url
  // is another repository's is rejected even at the right slug.
  const crossed = await verifyGitHubArtifact(REPOSITORY, releaseArtifact, {
    fetcher: apiFetcher({ [RELEASE_TAG_PATH]: release({ url: "https://api.github.com/repos/frostyard/lodge/releases/4242" }) }).fetcher,
    clock,
  });
  assert.equal(crossed.kind, "rejected");
  assert.match(crossed.kind === "rejected" ? crossed.reason : "", /belongs to another repository/);

  const otherTag = await verifyGitHubArtifact(REPOSITORY, releaseArtifact, {
    fetcher: apiFetcher({ [RELEASE_TAG_PATH]: release({ tag_name: "v9.9.9" }) }).fetcher,
    clock,
  });
  assert.equal(otherTag.kind, "rejected");
  assert.match(otherTag.kind === "rejected" ? otherTag.reason : "", /release tag does not match/);

  // A URL that is not a release URL at all never reaches GitHub.
  const malformed = await verifyGitHubArtifact(REPOSITORY, { kind: "release", url: "https://github.com/frostyard/updex/releases" }, { fetcher: apiFetcher({}).fetcher, clock });
  assert.equal(malformed.kind, "rejected");
});

test("an unavailable GitHub leaves a release unverified rather than rejected", async () => {
  for (const options of [{ fail: true }, { status: 503 }, { status: 200, body: "nope" }]) {
    const check = await verifyGitHubArtifact(REPOSITORY, releaseArtifact, { fetcher: apiFetcher({}, options).fetcher, clock });
    assert.equal(check.kind, "unverified", JSON.stringify(options));
  }
  // The draft fallback inherits the same rule: an outage on the listing is not absence.
  const listingDown = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === RELEASE_LIST_PATH) return new Response("{}", { status: 502, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const check = await verifyGitHubArtifact(REPOSITORY, releaseArtifact, { fetcher: listingDown, clock });
  assert.equal(check.kind, "unverified");
  assert.match(check.kind === "unverified" ? check.verification.reason : "", /HTTP 502/);

  // Without a credential a 404 is ambiguous and must not refuse the completion.
  const token = process.env.SNOWCAT_GITHUB_TOKEN;
  delete process.env.SNOWCAT_GITHUB_TOKEN;
  try {
    const ambiguous = await verifyGitHubArtifact(REPOSITORY, releaseArtifact, { fetcher: apiFetcher({}).fetcher, clock });
    assert.equal(ambiguous.kind, "unverified");
    assert.match(ambiguous.kind === "unverified" ? ambiguous.verification.reason : "", /without SNOWCAT_GITHUB_TOKEN/);
  } finally {
    if (token !== undefined) process.env.SNOWCAT_GITHUB_TOKEN = token;
  }
});

async function seedClaimed(queue: QueueStore) {
  queue.setRepositoryEnabled(REPOSITORY, true);
  queue.enqueueSeed({
    repository: REPOSITORY,
    kind: "release-slice",
    objective: "Prepare the updex 1.4.0 release.",
    // Reporting a release needs no action of its own: Snowcat never publishes,
    // so the release the worker reports is one a human published.
    instructions: "Prepare the release notes; a human publishes the tag.",
    acceptanceCriteria: ["Release prepared."],
    allowedActions: ["read", "run-tests"],
    delegableActions: [],
    requiredArtifact: "none",
    executionTarget: "read-only",
    createdBy: "operator:test",
  });
  return queue.claim({ worker: "claude:release-test" })!;
}

async function connect(path: string, fetcher: typeof fetch) {
  const server = buildQueueMcpServer(path, { fetcher, clock });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "release-test", version: "0.1.0" });
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const parse = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, any>;

test("complete_work verifies a reported release: absent is refused, draft is open, published is delivered", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-release-mcp-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  const claimed = await seedClaimed(queue);
  const routes: Record<string, unknown> = { [RELEASE_LIST_PATH]: [] };
  const { fetcher } = apiFetcher(routes);
  const { client, close } = await connect(path, fetcher);
  test.after(async () => { await close(); queue.close(); });
  const complete = (artifacts: unknown[]) =>
    client.callTool({
      name: "complete_work",
      arguments: {
        id: claimed.id,
        leaseToken: claimed.leaseToken,
        worker: "claude:release-test",
        result: { summary: "Release prepared.", evidence: ["npm run check green"], artifacts },
        followUps: [],
      },
    });

  // No such release: refused, the item stays claimed so the worker can correct it.
  const absent = (await complete([{ kind: "release", url: RELEASE_URL }])) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(absent.isError, true);
  assert.match(absent.content[0]!.text, /does not exist on GitHub/);
  assert.equal(queue.get(claimed.id)?.status, "claimed");

  // A release URL in another repository is refused too.
  const foreign = (await complete([{ kind: "release", url: `https://github.com/frostyard/lodge/releases/tag/${TAG}` }])) as { isError?: boolean; content: Array<{ text: string }> };
  assert.equal(foreign.isError, true);
  assert.equal(queue.get(claimed.id)?.status, "claimed");

  // Worker-supplied verification is refused at the schema, release like the rest.
  const forged = (await complete([{ kind: "release", url: RELEASE_URL, verification: { status: "verified" } }])) as { isError?: boolean };
  assert.equal(forged.isError, true);
  assert.equal(queue.get(claimed.id)?.status, "claimed");

  // The human has drafted but not published: verified, and not delivered.
  routes[RELEASE_LIST_PATH] = [release({ draft: true, published_at: null })];
  const drafted = parse(await complete([{ kind: "release", url: RELEASE_URL, description: "1.4.0 notes" }]));
  assert.equal(drafted.completed.status, "completed");
  assert.equal(drafted.completed.delivery, "open", "a draft release is reported, not delivered");
  assert.deepEqual(drafted.completed.result.artifacts[0].verification, {
    status: "verified",
    verifiedAt: "2026-08-17T20:00:00.000Z",
    number: 4242,
    state: "draft",
    tag: TAG,
  });

  // The human publishes; the sweep observes it and delivery becomes published.
  delete routes[RELEASE_LIST_PATH];
  routes[RELEASE_TAG_PATH] = release();
  const refreshed = await refreshArtifactVerifications(queue, { fetcher, clock });
  assert.deepEqual(refreshed.updated, [{ id: claimed.id, url: RELEASE_URL, status: "verified", state: "published" }]);
  assert.equal(queue.get(claimed.id)?.delivery, "published");
  const events = queue.events(claimed.id).filter((event) => event.type === "artifact.verified");
  assert.deepEqual(events.at(-1)?.payload, { url: RELEASE_URL, kind: "release", status: "verified", state: "published", previousState: "draft" });

  // Published is terminal: the sweep does not ask again.
  const terminal = await refreshArtifactVerifications(queue, { fetcher, clock });
  assert.equal(terminal.checked, 0, "a published release is not re-checked");
});

test("complete_work during a GitHub outage records a release unverified", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-release-outage-test-"));
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
        worker: "claude:release-test",
        result: { summary: "Release prepared.", evidence: ["npm run check green"], artifacts: [{ kind: "release", url: RELEASE_URL }] },
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
  // Still unverified: the sweep keeps it in the pending population.
  const stillDown = await refreshArtifactVerifications(queue, { fetcher: outage.fetcher, clock });
  assert.equal(stillDown.checked, 1);
  assert.equal(stillDown.unavailable.length, 1);
  assert.equal(queue.get(claimed.id)?.delivery, "unverified");
});

test("attach-artifact records a release only after GitHub confirms it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-release-attach-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  const claimed = await seedClaimed(queue);
  queue.complete({
    id: claimed.id,
    leaseToken: claimed.leaseToken!,
    worker: "claude:release-test",
    result: { summary: "Release prepared on a branch.", evidence: ["npm run check green"], artifacts: [] },
    followUps: [],
  });
  assert.equal(queue.get(claimed.id)?.delivery, "none");
  assert.equal(artifactKindFromUrl(RELEASE_URL), "release", "the kind defaults from the URL path");

  // Rejected: nothing is written and the item is untouched.
  const before = queue.get(claimed.id)!;
  await assert.rejects(
    attachVerifiedArtifact(queue, claimed.id, "operator:cli", { url: RELEASE_URL }, { fetcher: apiFetcher({ [RELEASE_LIST_PATH]: [] }).fetcher, clock }),
    /artifact rejected: release .* does not exist on GitHub/,
  );
  assert.deepEqual(queue.get(claimed.id), before);

  // Confirmed: attached with GitHub's own observation, and delivery follows.
  const { item } = await attachVerifiedArtifact(
    queue,
    claimed.id,
    "operator:cli",
    { url: RELEASE_URL, description: "published by the operator" },
    { fetcher: apiFetcher({ [RELEASE_TAG_PATH]: release() }).fetcher, clock },
  );
  assert.equal(item.delivery, "published");
  assert.deepEqual(item.result!.artifacts, [
    {
      kind: "release",
      url: RELEASE_URL,
      description: "published by the operator",
      verification: { status: "verified", verifiedAt: "2026-08-17T20:00:00.000Z", number: 4242, state: "published", tag: TAG, publishedAt: "2026-08-17T18:00:00Z" },
    },
  ]);
  const attached = queue.events(claimed.id).filter((event) => event.type === "artifact.attached");
  assert.equal(attached.length, 1);
  assert.deepEqual(attached[0]!.payload, { url: RELEASE_URL, kind: "release", status: "verified", state: "published" });

  // The store still refuses a release URL outside the item's repository.
  assert.throws(
    () =>
      queue.attachArtifact(claimed.id, "operator:cli", {
        kind: "release",
        url: `https://github.com/frostyard/lodge/releases/tag/${TAG}`,
        verification: { status: "verified", verifiedAt: "2026-08-17T20:00:00.000Z", number: 1, state: "published", tag: TAG },
      }),
    /artifact release URL must match https:\/\/github\.com\/frostyard\/updex\/releases\/tag\/<tag>/,
  );
});

/**
 * The pull-request derivation exactly as it stood before release artifacts
 * existed (rule 35). Any item with no release artifact must still derive
 * through it, value for value.
 */
function pullRequestOnlyDelivery(result: WorkResult | undefined): DeliveryState {
  const pullRequests = (result?.artifacts ?? []).filter((artifact) => artifact.kind === "pull-request");
  if (pullRequests.length === 0) return "none";
  const states = pullRequests.map((artifact) =>
    artifact.verification?.status === "verified" ? artifact.verification.state : "unverified",
  );
  if (states.includes("merged")) return "merged";
  if (states.includes("unverified")) return "unverified";
  if (states.includes("open")) return "open";
  return "closed";
}

test("delivery derivation for items with no release artifact is unchanged", () => {
  const verification = (state: "open" | "closed" | "merged"): WorkArtifact["verification"] => ({
    status: "verified",
    verifiedAt: "2026-08-17T20:00:00.000Z",
    number: 12,
    state,
  });
  const candidates: WorkArtifact[] = [
    { kind: "pull-request", url: PR_URL },
    { kind: "pull-request", url: PR_URL, verification: verification("open") },
    { kind: "pull-request", url: PR_URL, verification: verification("closed") },
    { kind: "pull-request", url: PR_URL, verification: verification("merged") },
    { kind: "pull-request", url: PR_URL, verification: { status: "unverified", attemptedAt: "2026-08-17T20:00:00.000Z", reason: "outage" } },
    { kind: "issue", url: "https://github.com/frostyard/updex/issues/7", verification: verification("closed") },
    { kind: "commit", url: "https://github.com/frostyard/updex/commit/0123456789abcdef0123456789abcdef01234567" },
    { kind: "report", url: "https://example.com/r" },
  ];
  // Every set of up to three of those artifacts, in order — 585 results.
  let compared = 0;
  const check = (artifacts: WorkArtifact[]) => {
    const result: WorkResult = { summary: "s", evidence: [], artifacts };
    assert.equal(deriveDelivery(result), pullRequestOnlyDelivery(result), JSON.stringify(artifacts.map((a) => [a.kind, a.verification])));
    compared += 1;
  };
  check([]);
  for (const first of candidates) {
    check([first]);
    for (const second of candidates) {
      check([first, second]);
      for (const third of candidates) check([first, second, third]);
    }
  }
  assert.equal(compared, 1 + candidates.length + candidates.length ** 2 + candidates.length ** 3);
  assert.equal(deriveDelivery(undefined), pullRequestOnlyDelivery(undefined));

  // And a release artifact is what changes it: the same merged pull request now
  // reads by the release it prepared.
  const merged: WorkArtifact = { kind: "pull-request", url: PR_URL, verification: verification("merged") };
  const draftRelease: WorkArtifact = {
    kind: "release",
    url: RELEASE_URL,
    verification: { status: "verified", verifiedAt: "2026-08-17T20:00:00.000Z", number: 4242, state: "draft", tag: TAG },
  };
  assert.equal(deriveDelivery({ summary: "s", evidence: [], artifacts: [merged] }), "merged");
  assert.equal(deriveDelivery({ summary: "s", evidence: [], artifacts: [merged, draftRelease] }), "open");
  assert.equal(
    deriveDelivery({
      summary: "s",
      evidence: [],
      artifacts: [merged, { ...draftRelease, verification: { status: "verified", verifiedAt: "2026-08-17T20:00:00.000Z", number: 4242, state: "published", tag: TAG } }],
    }),
    "published",
  );
  assert.equal(
    deriveDelivery({ summary: "s", evidence: [], artifacts: [{ kind: "release", url: RELEASE_URL, verification: { status: "unverified", attemptedAt: "2026-08-17T20:00:00.000Z", reason: "outage" } }] }),
    "unverified",
  );
});

test("a pull-request completion still verifies and derives exactly as before beside release support", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-release-parity-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  queue.setRepositoryEnabled(REPOSITORY, true);
  queue.enqueueSeed({
    repository: REPOSITORY,
    kind: "issue-resolution",
    objective: "Resolve #7",
    instructions: "Open a PR.",
    acceptanceCriteria: ["PR open."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    requiredArtifact: "pull-request",
    executionTarget: "new-pull-request",
    createdBy: "operator:test",
  });
  const claimed = queue.claim({ worker: "claude:release-test" })!;
  const { fetcher, requests } = apiFetcher({
    [PR_PATH]: pullRequest(),
    [PR_TEMPLATE_PATH]: {
      encoding: "base64",
      content: Buffer.from("## Summary\n\n## Verification\n\n## Risk tier\n").toString("base64"),
    },
  });
  const { client, close } = await connect(path, fetcher);
  test.after(async () => { await close(); queue.close(); });
  const accepted = parse(
    await client.callTool({
      name: "complete_work",
      arguments: {
        id: claimed.id,
        leaseToken: claimed.leaseToken,
        worker: "claude:release-test",
        result: { summary: "Opened the PR.", evidence: ["ran npm test"], artifacts: [{ kind: "pull-request", url: PR_URL }] },
        followUps: [],
      },
    }),
  );
  assert.equal(accepted.completed.delivery, "open");
  assert.deepEqual(accepted.completed.result.artifacts[0].verification, {
    status: "verified",
    verifiedAt: "2026-08-17T20:00:00.000Z",
    number: 12,
    state: "open",
    headSha: "0123456789abcdef0123456789abcdef01234567",
  });
  assert.deepEqual(requests, [PR_PATH, PR_TEMPLATE_PATH], "one bounded template read is made, and no release read");
});
