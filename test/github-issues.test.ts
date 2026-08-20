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
    labels: [{ name: "snowcat" }],
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
  const result = await fetchLabeledOpenIssues(REPOSITORY, "snowcat", fetcher);
  assert.equal(result.kind, "issues");
  if (result.kind !== "issues") return;
  assert.equal(result.pages, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.issues.length, 102);
  assert.equal(result.issues.some((item) => item.number === 102), false);
  assert.equal(requests.length, 2);
  assert.match(requests[0]!, /^\/repos\/frostyard\/updex\/issues\?state=open&labels=snowcat&per_page=100&page=1/);

  // Any malformed entry (wrong repository in html_url, closed state, missing number) poisons the whole listing.
  for (const bad of [
    issue(5, { html_url: "https://github.com/evil/updex/issues/5" }),
    issue(6, { state: "closed" }),
    issue(7, { number: "7" }),
    issue(8, { title: "   " }),
  ]) {
    const poisoned = await fetchLabeledOpenIssues(REPOSITORY, "snowcat", pagedFetcher({ 1: [issue(1), bad] }).fetcher);
    assert.equal(poisoned.kind, "unavailable");
  }

  assert.equal((await fetchLabeledOpenIssues(REPOSITORY, "snowcat", pagedFetcher({}, { status: 404 }).fetcher)).kind, "missing");
  assert.deepEqual(await fetchLabeledOpenIssues(REPOSITORY, "snowcat", pagedFetcher({}, { status: 403 }).fetcher), {
    kind: "response",
    status: 403,
  });
  assert.equal(
    (await fetchLabeledOpenIssues(REPOSITORY, "snowcat", pagedFetcher({}, { status: 200, body: "not json" }).fetcher)).kind,
    "unavailable",
  );
  await assert.rejects(fetchLabeledOpenIssues("bad repo", "snowcat", fetcher), /owner\/name/);
  await assert.rejects(fetchLabeledOpenIssues(REPOSITORY, "a,b", fetcher), /one non-empty GitHub label/);
});

test("an issue becomes one proposed root with the body quoted as untrusted context", () => {
  const candidate = issueWorkCandidate(REPOSITORY, {
    number: 12,
    title: "Retry flaky upload",
    body: "x".repeat(20_000),
    htmlUrl: "https://github.com/frostyard/updex/issues/12",
    labels: ["snowcat"],
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
  const directory = await mkdtemp(join(tmpdir(), "snowcat-import-issues-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());

  const pages = { 1: [issue(1), issue(2, { body: null })] };
  const { fetcher } = pagedFetcher(pages);
  await assert.rejects(importLabeledIssues(queue, REPOSITORY, "snowcat", { fetcher }), /not opted in/);
  queue.setRepositoryEnabled(REPOSITORY, true);

  const first = await importLabeledIssues(queue, REPOSITORY, "snowcat", { fetcher, priority: 5 });
  assert.equal(first.fetched, 2);
  assert.equal(first.observed, 2, "the CLI result includes the observed-issue count");
  assert.equal(first.created.length, 2);
  assert.deepEqual(first.skippedSourceRefs, []);
  const firstObservation = queue.repositoryLabeledIssueObservations(REPOSITORY)!;
  assert.equal(firstObservation.truncated, false);
  assert.deepEqual(
    firstObservation.issues.map(({ url, title, outcome }) => ({ url, title, outcome })),
    [
      { url: "https://github.com/frostyard/updex/issues/1", title: "Issue 1", outcome: "created" },
      { url: "https://github.com/frostyard/updex/issues/2", title: "Issue 2", outcome: "created" },
    ],
  );
  assert.ok(firstObservation.issues.every((entry) => !Number.isNaN(Date.parse(entry.seenAt))));
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

  // Re-running after issue 1 lost the label replaces the observation wholesale;
  // issue 2 remains and is recorded as an existing sourceRef.
  pages[1] = [issue(2, { body: null })];
  const second = await importLabeledIssues(queue, REPOSITORY, "snowcat", { fetcher });
  assert.deepEqual(second.created, []);
  assert.equal(second.observed, 1);
  assert.deepEqual(second.skippedSourceRefs, ["https://github.com/frostyard/updex/issues/2"]);
  assert.deepEqual(
    queue.repositoryLabeledIssueObservations(REPOSITORY)!.issues.map(({ url, title, outcome }) => ({ url, title, outcome })),
    [{ url: "https://github.com/frostyard/updex/issues/2", title: "Issue 2", outcome: "existing" }],
  );

  // Admission makes it claimable; the same source is still not re-imported after completion or rejection.
  const admitted = queue.approve(first.created[0]!.id, "operator:test");
  assert.equal(admitted.status, "queued");
  const claimed = queue.claim({ worker: "claude:import-test" });
  assert.equal(claimed?.id, admitted.id);
  assert.equal(claimed?.sourceRef, admitted.sourceRef);
  queue.reject(first.created[1]!.id, "operator:test", "Duplicate.");
  const third = await importLabeledIssues(queue, REPOSITORY, "snowcat", { fetcher });
  assert.deepEqual(third.created, []);

  // A failed listing imports nothing.
  await assert.rejects(
    importLabeledIssues(queue, REPOSITORY, "snowcat", { fetcher: pagedFetcher({}, { status: 500 }).fetcher }),
    /HTTP 500; nothing imported/,
  );
  await assert.rejects(
    importLabeledIssues(queue, "frostyard/missing", "snowcat", { fetcher: pagedFetcher({}, { status: 404 }).fetcher }),
    /not opted in|not found/,
  );
  assert.equal(queue.repositoryLabeledIssueObservations(REPOSITORY)!.issues.length, 1, "failed listings leave the last successful observation standing");
  assert.equal(queue.list({ repository: REPOSITORY, limit: 100 }).length, 2);

  // The unique index backs the store-level dedupe even against a duplicate within one batch.
  const batch = queue.enqueueProposedRoots(REPOSITORY, [
    issueWorkCandidate(REPOSITORY, { number: 9, title: "nine", body: "", htmlUrl: "https://github.com/frostyard/updex/issues/9", labels: [] }),
    issueWorkCandidate(REPOSITORY, { number: 9, title: "nine again", body: "", htmlUrl: "https://github.com/frostyard/updex/issues/9", labels: [] }),
  ]);
  assert.equal(batch.created.length, 1);
  assert.deepEqual(batch.skippedSourceRefs, ["https://github.com/frostyard/updex/issues/9"]);
});

test("labeled issue observations are bounded to the latest 500 entries", () => {
  const queue = new QueueStore(":memory:", () => new Date("2026-08-20T02:00:00.000Z"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);

  const observation = queue.recordLabeledIssueObservations(
    REPOSITORY,
    Array.from({ length: 501 }, (_, index) => ({
      url: `https://github.com/frostyard/updex/issues/${index + 1}`,
      title: `Issue ${index + 1}`,
      outcome: "existing" as const,
    })),
    "operator:import-issues",
  );
  assert.equal(observation.issues.length, 500);
  assert.equal(observation.truncated, true);
  assert.ok(observation.issues.every((entry) => entry.seenAt === "2026-08-20T02:00:00.000Z"));
  assert.deepEqual(queue.repositoryLabeledIssueObservations(REPOSITORY), observation);
});

test("import-issues --enrolled imports only opted-in enrolled repositories, is idempotent, and reports a failed listing without stopping the rest", async () => {
  const { ControlPlaneStore } = await import("../src/control/store.ts");
  const { importLabeledIssuesForEnrolled } = await import("../src/queue/github-issues.ts");
  const { reconcileRepositories } = await import("../src/repository/controller.ts");
  const { activationCandidate, disabledDeclaration, enabledDeclaration, validSurfaceProbe } = await import("./helpers/core-fixtures.ts");
  const directory = await mkdtemp(join(tmpdir(), "snowcat-import-enrolled-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  const controlPath = join(directory, "control-plane.db");
  const control = new ControlPlaneStore(controlPath, () => new Date("2026-08-18T04:00:00.000Z"));
  // Two enabled declarations (frostyard/example 9001, frostyard/second 9003) reach `enrolled`; frostyard/retired stays disabled.
  const secondDeclaration = { ...enabledDeclaration(), repository: { owner: "frostyard", name: "second", repository_id: "9003" } };
  const candidate = await activationCandidate(enabledDeclaration(), "7".repeat(40), "8".repeat(40), [secondDeclaration, disabledDeclaration()]);
  const activation = control.activateCoreSnapshot({ candidate, expectedLastTransactionSequence: control.metadata().lastTransactionSequence });
  control.recordCoreSourceCheckEligible({ checkId: "0198b9fd-6200-7000-8000-000000000021", candidate, expectedLastTransactionSequence: activation.transactionSequence });
  await reconcileRepositories(
    control,
    async (locator) => ({
      kind: "found",
      repositoryId: locator.name === "second" ? "9003" : "9001",
      owner: locator.owner,
      name: locator.name,
      archived: false,
      defaultBranch: "main",
    }),
    async () => validSurfaceProbe(),
  );
  assert.deepEqual(
    control.repositoryStatuses().map((status) => [status.name, status.effectiveState]).sort(),
    [["example", "enrolled"], ["retired", "disabled"], ["second", "enrolled"]],
  );
  control.close();
  queue.setRepositoryEnabled("frostyard/example", true);
  queue.setRepositoryEnabled("frostyard/second", true);
  queue.setRepositoryEnabled("frostyard/retired", true); // opted in but disabled in the control plane → never imported
  queue.setRepositoryEnabled("frostyard/updex", true); // opted in but not declared → never imported

  const served: Record<string, unknown[]> = {
    "/repos/frostyard/example/issues": [
      { ...issue(1), html_url: "https://github.com/frostyard/example/issues/1" },
      { ...issue(2), html_url: "https://github.com/frostyard/example/issues/2" },
    ],
    "/repos/frostyard/second/issues": [{ ...issue(7), html_url: "https://github.com/frostyard/second/issues/7" }],
  };
  const requests: string[] = [];
  let failPath: string | undefined;
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url.pathname);
    if (url.pathname === failPath) return new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(served[url.pathname] ?? []), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const first = await importLabeledIssuesForEnrolled(queue, controlPath, "snowcat", { priority: 4, fetcher });
  assert.deepEqual(requests, ["/repos/frostyard/example/issues", "/repos/frostyard/second/issues"]); // only the enrolled repositories, in slug order
  assert.equal(first.label, "snowcat");
  assert.deepEqual(first.failed, []);
  assert.deepEqual(first.notOptedIn, []);
  assert.deepEqual(
    first.imported.map((entry) => [entry.repository, entry.fetched, entry.created.length, entry.skippedSourceRefs.length]),
    [["frostyard/example", 2, 2, 0], ["frostyard/second", 1, 1, 0]],
  );
  assert.deepEqual(queue.list({ status: "proposed" }).map((item) => [item.repository, item.priority]).sort(), [
    ["frostyard/example", 4],
    ["frostyard/example", 4],
    ["frostyard/second", 4],
  ]);
  assert.equal(queue.list({ repository: "frostyard/retired" }).length, 0);
  assert.equal(queue.list({ repository: "frostyard/updex" }).length, 0);

  // A second run creates nothing: every source ref is skipped.
  const second = await importLabeledIssuesForEnrolled(queue, controlPath, "snowcat", { fetcher });
  assert.deepEqual(second.imported.map((entry) => entry.created.length), [0, 0]);
  assert.deepEqual(second.imported[0]!.skippedSourceRefs.sort(), [
    "https://github.com/frostyard/example/issues/1",
    "https://github.com/frostyard/example/issues/2",
  ]);
  assert.equal(queue.list({ status: "proposed" }).length, 3);

  // A 503 listing for one repository is reported under failed while the other still runs; the call itself does not throw.
  failPath = "/repos/frostyard/example/issues";
  served["/repos/frostyard/second/issues"]!.push({ ...issue(8), html_url: "https://github.com/frostyard/second/issues/8" });
  const failed = await importLabeledIssuesForEnrolled(queue, controlPath, "snowcat", { fetcher });
  assert.deepEqual(failed.failed.map((entry) => entry.repository), ["frostyard/example"]);
  assert.match(failed.failed[0]!.reason, /returned HTTP 503; nothing imported/);
  assert.deepEqual(failed.imported.map((entry) => [entry.repository, entry.created.length]), [["frostyard/second", 1]]);
  assert.equal(queue.list({ status: "proposed" }).length, 4);
  failPath = undefined;

  // An enrolled repository that is not opted in is reported, not imported.
  queue.setRepositoryEnabled("frostyard/example", false);
  const skipped = await importLabeledIssuesForEnrolled(queue, controlPath, "snowcat", { fetcher });
  assert.deepEqual(skipped.notOptedIn, ["frostyard/example"]);
  assert.deepEqual(skipped.imported.map((entry) => entry.repository), ["frostyard/second"]);

  // The label is validated once, before any store or GitHub read.
  const before = requests.length;
  await assert.rejects(importLabeledIssuesForEnrolled(queue, controlPath, "a,b", { fetcher }), /label must be one non-empty GitHub label name/);
  assert.equal(requests.length, before);
});
