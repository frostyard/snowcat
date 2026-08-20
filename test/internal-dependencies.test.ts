import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlPlaneStore } from "../src/control/store.ts";
import {
  compareSemver,
  frostyardRepositoryOf,
  parseGoModRequires,
  parseSemver,
  suggestBump,
  sweepFailureMessage,
  sweepInternalDependencies,
} from "../src/queue/internal-dependencies.ts";
import { QueueStore } from "../src/queue/store.ts";
import { reconcileRepositories } from "../src/repository/controller.ts";
import { enabledDeclaration, enrollExampleRepository, validSurfaceProbe } from "./helpers/core-fixtures.ts";

const clock = () => new Date("2026-08-18T20:00:00.000Z");
process.env.SNOWCAT_GITHUB_TOKEN = "test-token";
const HEAD = "1".repeat(40);
const TAG_SHA = "2".repeat(40);

interface FakeRepo {
  slug: string;
  head?: string;
  tags?: Array<{ name: string; sha: string }>;
  aheadBy?: number;
  commits?: string[];
  goMod?: string;
}

function routesFor(repos: FakeRepo[]): Record<string, unknown> {
  const routes: Record<string, unknown> = {};
  for (const repo of repos) {
    const base = `/repos/${repo.slug}`;
    const head = repo.head ?? HEAD;
    routes[base] = { default_branch: "main" };
    routes[`${base}/commits/main`] = { sha: head };
    routes[`${base}/tags`] = (repo.tags ?? []).map((tag) => ({ name: tag.name, commit: { sha: tag.sha } }));
    for (const tag of repo.tags ?? []) {
      routes[`${base}/compare/${tag.name}...main`] = { ahead_by: repo.aheadBy ?? 0, commits: (repo.commits ?? []).map((message) => ({ commit: { message } })) };
    }
    if (repo.goMod !== undefined) routes[`${base}/contents/go.mod`] = { content: Buffer.from(repo.goMod).toString("base64") };
  }
  return routes;
}

function apiFetcher(routes: Record<string, unknown>) {
  const requests: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url.pathname);
    const body = routes[url.pathname];
    if (body === undefined) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, requests };
}

const CLIX_GO_MOD = "module github.com/frostyard/clix\n\ngo 1.26\n\nrequire (\n\tgithub.com/frostyard/std v0.2.0 // indirect\n\tgithub.com/spf13/cobra v1.9.1\n)\n";
const UPDEX_GO_MOD = "module github.com/frostyard/updex\n\ngo 1.26\n\nrequire (\n\tgithub.com/frostyard/clix v0.3.1\n\tgithub.com/frostyard/std v0.2.0\n)\nrequire golang.org/x/sys v0.30.0\n";

test("go.mod parsing, frostyard module mapping, semver, and the svu-style suggestion", () => {
  const requires = parseGoModRequires(UPDEX_GO_MOD);
  assert.deepEqual([...requires.entries()], [
    ["github.com/frostyard/clix", "v0.3.1"],
    ["github.com/frostyard/std", "v0.2.0"],
    ["golang.org/x/sys", "v0.30.0"],
  ]);
  assert.equal(frostyardRepositoryOf("github.com/frostyard/clix"), "frostyard/clix");
  assert.equal(frostyardRepositoryOf("github.com/frostyard/clix/v2"), "frostyard/clix");
  assert.equal(frostyardRepositoryOf("github.com/spf13/cobra"), undefined);
  assert.deepEqual(parseSemver("v0.3.1"), [0, 3, 1]);
  assert.deepEqual(parseSemver("v0.0.0-20260818120000-abcdef123456"), [0, 0, 0]);
  assert.equal(parseSemver("continuous"), undefined);
  assert.equal(compareSemver([0, 3, 1], [0, 4, 0]), -1);
  assert.equal(compareSemver([1, 0, 0], [0, 9, 9]), 1);
  assert.equal(suggestBump("v0.3.1", ["fix", "chore"]), "v0.3.2 (patch)");
  assert.equal(suggestBump("v0.3.1", ["feat", "fix"]), "v0.4.0 (minor)");
  assert.equal(suggestBump("v0.3.1", ["feat!"]), "v0.4.0 (minor)", "v0: breaking bumps minor");
  assert.equal(suggestBump("v1.5.0", ["breaking"]), "v2.0.0 (major)");
});

test("the sweep proposes a release for an upstream ahead of its tag and a bump for a downstream behind the latest release, once each", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-dependency-sweep-test-"));
  const queue = new QueueStore(join(directory, "queue.db"), clock);
  test.after(() => queue.close());
  for (const slug of ["frostyard/clix", "frostyard/std", "frostyard/updex"]) queue.setRepositoryEnabled(slug, true);

  // clix: 8 commits past v0.3.1 (feat + fixes). std: up to date at v0.2.0. updex: 30 commits past v1.5.0, requires clix v0.3.1 and std v0.2.0.
  const routes = routesFor([
    { slug: "frostyard/clix", tags: [{ name: "v0.3.1", sha: TAG_SHA }, { name: "v0.3.0", sha: "3".repeat(40) }], aheadBy: 8, commits: ["feat(flags): add --json", "fix: typo", "chore: go 1.26.6"], goMod: CLIX_GO_MOD },
    { slug: "frostyard/std", tags: [{ name: "v0.2.0", sha: TAG_SHA }], aheadBy: 0, goMod: "module github.com/frostyard/std\n\ngo 1.26\n" },
    { slug: "frostyard/updex", tags: [{ name: "v1.5.0", sha: TAG_SHA }, { name: "continuous", sha: "4".repeat(40) }], aheadBy: 30, commits: ["fix(catalog)!: require secure catalog transport"], goMod: UPDEX_GO_MOD },
  ]);
  const one = await sweepInternalDependencies(queue, undefined, { fetcher: apiFetcher(routes).fetcher, clock, repository: "frostyard/clix" });
  assert.deepEqual(one.swept, ["frostyard/clix"]);
  assert.equal(one.releaseNeeded.length, 1);
  assert.deepEqual(one.releaseNeeded[0]!.latestTag, "v0.3.1");
  assert.equal(one.releaseNeeded[0]!.aheadBy, 8);
  assert.equal(one.releaseNeeded[0]!.suggestedBump, "v0.4.0 (minor)");
  assert.deepEqual(one.dependencyBumps, [], "clix requires std v0.2.0 and std's latest is v0.2.0");
  const proposal = queue.get(one.releaseNeeded[0]!.id)!;
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.kind, "release-needed");
  assert.equal(proposal.sourceRef, `release-needed:frostyard/clix@v0.3.1+${HEAD}`);
  assert.deepEqual(proposal.allowedActions, ["read", "write", "run-tests", "open-pr"]);
  assert.match(proposal.objective, /^Cut a release of frostyard\/clix: 8 commits on main since v0\.3\.1 \(suggested v0\.4\.0 \(minor\)\)$/);
  assert.match(proposal.instructions, /Do NOT create the tag/);

  // Sweeping everything through the enrolled path (control plane fixture enrolls only frostyard/example; use the per-repository path here).
  const updex = await sweepInternalDependencies(queue, undefined, { fetcher: apiFetcher(routes).fetcher, clock, repository: "frostyard/updex" });
  assert.equal(updex.releaseNeeded.length, 1, "updex is 30 commits past v1.5.0");
  assert.equal(updex.releaseNeeded[0]!.suggestedBump, "v2.0.0 (major)");
  assert.deepEqual(updex.dependencyBumps, [], "updex is on the latest releases of clix and std");
  const std = await sweepInternalDependencies(queue, undefined, { fetcher: apiFetcher(routes).fetcher, clock, repository: "frostyard/std" });
  assert.deepEqual(std.releaseNeeded, []);
  assert.deepEqual(std.skipped, [{ repository: "frostyard/std", reason: "up to date with v0.2.0" }]);

  // Again: the open proposal is not duplicated.
  const again = await sweepInternalDependencies(queue, undefined, { fetcher: apiFetcher(routes).fetcher, clock, repository: "frostyard/clix" });
  assert.deepEqual(again.releaseNeeded, []);
  assert.match(again.skipped[0]!.reason, /already open/);

  // The operator declines; asking again waits a week even after new commits.
  queue.reject(proposal.id, "operator:test", "Not this week.");
  const moved = routesFor([{ slug: "frostyard/clix", head: "5".repeat(40), tags: [{ name: "v0.3.1", sha: TAG_SHA }], aheadBy: 9, commits: ["feat: more"], goMod: CLIX_GO_MOD }, { slug: "frostyard/std", tags: [{ name: "v0.2.0", sha: TAG_SHA }] }]);
  const declined = await sweepInternalDependencies(queue, undefined, { fetcher: apiFetcher(moved).fetcher, clock, repository: "frostyard/clix" });
  assert.deepEqual(declined.releaseNeeded, []);
  assert.match(declined.skipped[0]!.reason, /declined .*asking again after 7 days/);
  const later = () => new Date("2026-08-26T20:00:00.000Z");
  const asked = await sweepInternalDependencies(queue, undefined, { fetcher: apiFetcher(moved).fetcher, clock: later, repository: "frostyard/clix" });
  assert.equal(asked.releaseNeeded.length, 1, "a week later, with a new head, the release is proposed again");

  // clix releases v0.4.0: the downstream bump appears now, and only now; the same target is proposed once.
  const released = routesFor([
    { slug: "frostyard/clix", head: "6".repeat(40), tags: [{ name: "v0.4.0", sha: "6".repeat(40) }, { name: "v0.3.1", sha: TAG_SHA }], aheadBy: 0, goMod: CLIX_GO_MOD },
    { slug: "frostyard/std", tags: [{ name: "v0.2.0", sha: TAG_SHA }], aheadBy: 0 },
    { slug: "frostyard/updex", tags: [{ name: "v1.5.0", sha: TAG_SHA }], aheadBy: 31, commits: ["fix: x"], goMod: UPDEX_GO_MOD },
  ]);
  const bump = await sweepInternalDependencies(queue, undefined, { fetcher: apiFetcher(released).fetcher, clock: later, repository: "frostyard/updex" });
  assert.deepEqual(bump.dependencyBumps.map((entry) => [entry.module, entry.from, entry.to]), [["github.com/frostyard/clix", "v0.3.1", "v0.4.0"]]);
  const bumpItem = queue.get(bump.dependencyBumps[0]!.id)!;
  assert.equal(bumpItem.status, "proposed");
  assert.equal(bumpItem.kind, "dependency-bump");
  assert.equal(bumpItem.sourceRef, "dependency-bump:frostyard/updex:github.com/frostyard/clix@v0.4.0");
  assert.match(bumpItem.instructions, /go get github.com\/frostyard\/clix@v0\.4\.0/);
  const bumpAgain = await sweepInternalDependencies(queue, undefined, { fetcher: apiFetcher(released).fetcher, clock: later, repository: "frostyard/updex" });
  assert.deepEqual(bumpAgain.dependencyBumps, []);
  assert.deepEqual((await sweepInternalDependencies(queue, undefined, { fetcher: apiFetcher(released).fetcher, clock: later, repository: "frostyard/clix" })).skipped, [
    { repository: "frostyard/clix", reason: "up to date with v0.4.0" },
  ]);

  // No tag at all: reported, nothing proposed. A GitHub failure is reported per repository, not thrown.
  queue.setRepositoryEnabled("frostyard/newlib", true);
  const untagged = await sweepInternalDependencies(queue, undefined, { fetcher: apiFetcher(routesFor([{ slug: "frostyard/newlib", goMod: "module github.com/frostyard/newlib\n" }])).fetcher, clock, repository: "frostyard/newlib" });
  assert.deepEqual(untagged.skipped, [{ repository: "frostyard/newlib", reason: "no release tag yet" }]);
  const down = await sweepInternalDependencies(queue, undefined, { fetcher: apiFetcher({}).fetcher, clock, repository: "frostyard/newlib" });
  assert.equal(down.failed.length, 1);
  await assert.rejects(sweepInternalDependencies(queue, undefined, { fetcher: apiFetcher({}).fetcher, clock, repository: "frostyard/nope" }), /not opted in/);
});

test("the enrolled sweep reads the control plane and skips enrolled repositories that are not opted in", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-dependency-enrolled-test-"));
  const controlPath = join(directory, "control-plane.db");
  const store = new ControlPlaneStore(controlPath, clock);
  test.after(() => store.close());
  await enrollExampleRepository(store);
  const queue = new QueueStore(join(directory, "queue.db"), clock);
  test.after(() => queue.close());
  const routes = routesFor([{ slug: "frostyard/example", tags: [{ name: "v1.0.0", sha: TAG_SHA }], aheadBy: 2, commits: ["fix: a", "fix: b"], goMod: "module github.com/frostyard/example\n\nrequire github.com/frostyard/std v0.1.0\n" }, { slug: "frostyard/std", tags: [{ name: "v0.2.0", sha: TAG_SHA }] }]);
  const notOptedIn = await sweepInternalDependencies(queue, controlPath, { fetcher: apiFetcher(routes).fetcher, clock });
  assert.deepEqual(notOptedIn.notOptedIn, ["frostyard/example"]);
  assert.deepEqual(notOptedIn.swept, []);
  queue.setRepositoryEnabled("frostyard/example", true);
  const swept = await sweepInternalDependencies(queue, controlPath, { fetcher: apiFetcher(routes).fetcher, clock });
  assert.deepEqual(swept.swept, ["frostyard/example"]);
  assert.equal(swept.releaseNeeded.length, 1);
  assert.equal(swept.releaseNeeded[0]!.suggestedBump, "v1.0.1 (patch)");
  assert.deepEqual(swept.dependencyBumps.map((entry) => [entry.module, entry.from, entry.to]), [["github.com/frostyard/std", "v0.1.0", "v0.2.0"]]);
  await assert.rejects(sweepInternalDependencies(queue, undefined, { fetcher: apiFetcher(routes).fetcher, clock }), /SNOWCAT_CONTROL_DB/);
});

test("the enrolled sweep reports an unavailable required upstream once and retains successful downstream work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-dependency-upstream-failure-test-"));
  const controlPath = join(directory, "control-plane.db");
  const store = new ControlPlaneStore(controlPath, clock);
  test.after(() => store.close());
  const second = {
    ...enabledDeclaration(),
    repository: { owner: "frostyard", name: "second", repository_id: "9002" },
  };
  await enrollExampleRepository(store, { additionalDeclarations: [second] });
  await reconcileRepositories(
    store,
    async ({ owner, name }) => ({
      kind: "found",
      repositoryId: name === "example" ? "9001" : "9002",
      owner,
      name,
      archived: false,
      defaultBranch: "main",
    }),
    async () => validSurfaceProbe(),
  );

  const queue = new QueueStore(join(directory, "queue.db"), clock);
  test.after(() => queue.close());
  for (const slug of ["frostyard/example", "frostyard/second"]) queue.setRepositoryEnabled(slug, true);
  const goMod = (name: string) =>
    `module github.com/frostyard/${name}\n\ngo 1.26\n\nrequire (\n\tgithub.com/frostyard/missing v0.1.0\n\tgithub.com/frostyard/std v0.1.0\n)\n`;
  const routes = routesFor([
    { slug: "frostyard/example", tags: [{ name: "v1.0.0", sha: TAG_SHA }], goMod: goMod("example") },
    { slug: "frostyard/second", tags: [{ name: "v1.0.0", sha: TAG_SHA }], goMod: goMod("second") },
    { slug: "frostyard/std", tags: [{ name: "v0.2.0", sha: TAG_SHA }] },
  ]);
  const { fetcher, requests } = apiFetcher(routes);

  const result = await sweepInternalDependencies(queue, controlPath, { fetcher, clock });

  assert.deepEqual(result.swept, ["frostyard/example", "frostyard/second"]);
  assert.deepEqual(result.failed, [
    { repository: "frostyard/missing", reason: "GitHub repository read failed for frostyard/missing" },
  ]);
  assert.equal(
    requests.filter((request) => request === "/repos/frostyard/missing").length,
    1,
    "a shared unavailable upstream is acquired only once",
  );
  assert.deepEqual(
    result.dependencyBumps.map((entry) => [entry.repository, entry.module, entry.from, entry.to]),
    [
      ["frostyard/example", "github.com/frostyard/std", "v0.1.0", "v0.2.0"],
      ["frostyard/second", "github.com/frostyard/std", "v0.1.0", "v0.2.0"],
    ],
  );
  assert.equal(sweepFailureMessage(result), undefined, "an upstream acquisition failure remains a reported partial failure");
});

test("the enrolled sweep's exit-code decision fails only when every repository failed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-dependency-exit-test-"));
  const controlPath = join(directory, "control-plane.db");
  const store = new ControlPlaneStore(controlPath, clock);
  test.after(() => store.close());
  await enrollExampleRepository(store);
  const queue = new QueueStore(join(directory, "queue.db"), clock);
  test.after(() => queue.close());
  // Enrolled but not opted in: nothing swept, nothing failed — exit 0.
  const notOptedIn = await sweepInternalDependencies(queue, controlPath, { fetcher: apiFetcher({}).fetcher, clock });
  assert.deepEqual([notOptedIn.swept, notOptedIn.failed, notOptedIn.notOptedIn], [[], [], ["frostyard/example"]]);
  assert.equal(sweepFailureMessage(notOptedIn), undefined);
  // Every GitHub read 404s for the one opted-in enrolled repository: all failed.
  queue.setRepositoryEnabled("frostyard/example", true);
  const allFailed = await sweepInternalDependencies(queue, controlPath, { fetcher: apiFetcher({}).fetcher, clock });
  assert.deepEqual(allFailed.swept, []);
  assert.deepEqual(allFailed.failed.map((entry) => entry.repository), ["frostyard/example"]);
  assert.equal(sweepFailureMessage(allFailed), "sweep-dependencies --enrolled: every repository failed (frostyard/example)");
  // At least one repository swept alongside a failure: partial, exit 0.
  const partial = { ...allFailed, swept: ["frostyard/other"] };
  assert.equal(sweepFailureMessage(partial), undefined);
  // The message names every failed repository when several fail.
  assert.equal(
    sweepFailureMessage({ ...allFailed, failed: [{ repository: "owner/a", reason: "x" }, { repository: "owner/b", reason: "y" }] }),
    "sweep-dependencies --enrolled: every repository failed (owner/a, owner/b)",
  );
});
