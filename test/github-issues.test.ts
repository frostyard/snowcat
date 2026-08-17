import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fetchLabeledOpenIssues, importLabeledIssues, ISSUE_WORK_KIND, issueWorkCandidate } from "../src/queue/github-issues.ts";
import { QueueStore } from "../src/queue/store.ts";

const REPOSITORY = "frostyard/updex";

function issue(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    body: `Body of issue ${number}.`,
    html_url: `https://github.com/frostyard/updex/issues/${number}`,
    state: "open",
    labels: [{ name: "fluent" }],
    ...overrides,
  };
}

/** A fetch double that serves pages by the `page` query parameter and records requests. */
function pagedFetcher(pages: Record<number, unknown[]>, options: { status?: number; body?: string } = {}) {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url.pathname + url.search);
    assert.equal(init?.method, "GET");
    if (options.status !== undefined) {
      return new Response(options.body ?? "{}", { status: options.status, headers: { "content-type": "application/json" } });
    }
    const page = Number(url.searchParams.get("page") ?? "1");
    return new Response(JSON.stringify(pages[page] ?? []), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, requests };
}

test("labeled open issues are listed across pages, pull requests dropped, malformed pages refused", async () => {
  const full = Array.from({ length: 100 }, (_, index) => issue(index + 1));
  const { fetcher, requests } = pagedFetcher({
    1: full,
    2: [issue(101), issue(102, { pull_request: { url: "https://api.github.com/repos/frostyard/updex/pulls/102" } }), issue(103)],
  });
  const result = await fetchLabeledOpenIssues(REPOSITORY, "fluent", fetcher);
  assert.equal(result.kind, "issues");
  if (result.kind !== "issues") return;
  assert.equal(result.pages, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.issues.length, 102);
  assert.equal(result.issues.some((item) => item.number === 102), false);
  assert.equal(requests.length, 2);
  assert.match(requests[0]!, /^\/repos\/frostyard\/updex\/issues\?state=open&labels=fluent&per_page=100&page=1/);

  // Any malformed entry (wrong repository in html_url, closed state, missing number) poisons the whole listing.
  for (const bad of [
    issue(5, { html_url: "https://github.com/evil/updex/issues/5" }),
    issue(6, { state: "closed" }),
    issue(7, { number: "7" }),
    issue(8, { title: "   " }),
  ]) {
    const poisoned = await fetchLabeledOpenIssues(REPOSITORY, "fluent", pagedFetcher({ 1: [issue(1), bad] }).fetcher);
    assert.equal(poisoned.kind, "unavailable");
  }

  assert.equal((await fetchLabeledOpenIssues(REPOSITORY, "fluent", pagedFetcher({}, { status: 404 }).fetcher)).kind, "missing");
  assert.deepEqual(await fetchLabeledOpenIssues(REPOSITORY, "fluent", pagedFetcher({}, { status: 403 }).fetcher), {
    kind: "response",
    status: 403,
  });
  assert.equal(
    (await fetchLabeledOpenIssues(REPOSITORY, "fluent", pagedFetcher({}, { status: 200, body: "not json" }).fetcher)).kind,
    "unavailable",
  );
  await assert.rejects(fetchLabeledOpenIssues("bad repo", "fluent", fetcher), /owner\/name/);
  await assert.rejects(fetchLabeledOpenIssues(REPOSITORY, "a,b", fetcher), /one non-empty GitHub label/);
});

test("an issue becomes one proposed root with the body quoted as untrusted context", () => {
  const candidate = issueWorkCandidate(REPOSITORY, {
    number: 12,
    title: "Retry flaky upload",
    body: "x".repeat(20_000),
    htmlUrl: "https://github.com/frostyard/updex/issues/12",
    labels: ["fluent"],
  }, { priority: 7 });
  assert.equal(candidate.sourceRef, "https://github.com/frostyard/updex/issues/12");
  assert.equal(candidate.kind, ISSUE_WORK_KIND);
  assert.equal(candidate.objective, "Resolve frostyard/updex#12: Retry flaky upload");
  assert.match(candidate.instructions, /untrusted, from GitHub/);
  assert.match(candidate.instructions, /truncated at 16000 characters/);
  assert.ok(candidate.instructions.length < 17_500);
  assert.ok(candidate.allowedActions.includes("open-pr"));
  assert.equal(candidate.priority, 7);
  assert.equal(candidate.createdBy, "operator:import-issues");
  const empty = issueWorkCandidate(REPOSITORY, { number: 1, title: "t", body: "   ", htmlUrl: "https://github.com/frostyard/updex/issues/1", labels: [] });
  assert.match(empty.instructions, /has no body/);
});

test("importing proposes each labeled issue once, needs admission, and never partially imports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-import-issues-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());

  const { fetcher } = pagedFetcher({ 1: [issue(1), issue(2, { body: null })] });
  await assert.rejects(importLabeledIssues(queue, REPOSITORY, "fluent", { fetcher }), /not opted in/);
  queue.setRepositoryEnabled(REPOSITORY, true);

  const first = await importLabeledIssues(queue, REPOSITORY, "fluent", { fetcher, priority: 5 });
  assert.equal(first.fetched, 2);
  assert.equal(first.created.length, 2);
  assert.deepEqual(first.skippedSourceRefs, []);
  for (const item of first.created) {
    assert.equal(item.status, "proposed");
    assert.equal(item.priority, 5);
    assert.equal(item.parentId, undefined);
    assert.equal(item.rootId, item.id);
    assert.equal(queue.events(item.id)[0]?.type, "work.proposed");
    assert.equal(queue.events(item.id)[0]?.payload.sourceRef, item.sourceRef);
  }
  assert.equal(queue.list({ status: "proposed", repository: REPOSITORY }).length, 2);
  assert.equal(queue.claim({ worker: "claude:import-test" }), undefined, "proposed roots are not claimable");

  // Re-running creates nothing, and a second issue on a new page still dedupes against the first.
  const second = await importLabeledIssues(queue, REPOSITORY, "fluent", { fetcher });
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.skippedSourceRefs, first.created.map((item) => item.sourceRef));

  // Admission makes it claimable; the same source is still not re-imported after completion or rejection.
  const admitted = queue.approve(first.created[0]!.id, "operator:test");
  assert.equal(admitted.status, "queued");
  const claimed = queue.claim({ worker: "claude:import-test" });
  assert.equal(claimed?.id, admitted.id);
  assert.equal(claimed?.sourceRef, admitted.sourceRef);
  queue.reject(first.created[1]!.id, "operator:test", "Duplicate.");
  const third = await importLabeledIssues(queue, REPOSITORY, "fluent", { fetcher });
  assert.deepEqual(third.created, []);

  // A failed listing imports nothing.
  await assert.rejects(
    importLabeledIssues(queue, REPOSITORY, "fluent", { fetcher: pagedFetcher({}, { status: 500 }).fetcher }),
    /HTTP 500; nothing imported/,
  );
  await assert.rejects(
    importLabeledIssues(queue, "frostyard/missing", "fluent", { fetcher: pagedFetcher({}, { status: 404 }).fetcher }),
    /not opted in|not found/,
  );
  assert.equal(queue.list({ repository: REPOSITORY, limit: 100 }).length, 2);

  // The unique index backs the store-level dedupe even against a duplicate within one batch.
  const batch = queue.enqueueProposedRoots(REPOSITORY, [
    issueWorkCandidate(REPOSITORY, { number: 9, title: "nine", body: "", htmlUrl: "https://github.com/frostyard/updex/issues/9", labels: [] }),
    issueWorkCandidate(REPOSITORY, { number: 9, title: "nine again", body: "", htmlUrl: "https://github.com/frostyard/updex/issues/9", labels: [] }),
  ]);
  assert.equal(batch.created.length, 1);
  assert.deepEqual(batch.skippedSourceRefs, ["https://github.com/frostyard/updex/issues/9"]);
});
