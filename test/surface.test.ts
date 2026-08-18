import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.ts";
import { ControlPlaneStore } from "../src/control/store.ts";
import { QueueStore } from "../src/queue/store.ts";
import { sessionDigest } from "../src/surface/session.ts";
import { enrollExampleRepository } from "./helpers/core-fixtures.ts";

const TOKEN = "surface-test-token";

/**
 * A queue with one of everything the inbox groups: a proposed child under a
 * completed parent (its finding), a blocked item with a reason, a completed
 * item carrying an unverified pull-request artifact, and a live claimed
 * item whose lease token must never appear in a page.
 */
async function seededQueue() {
  const directory = await mkdtemp(join(tmpdir(), "fluent-surface-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  queue.setRepositoryEnabled("frostyard/example", true);
  queue.setRepositoryEnabled("frostyard/updex", true);

  // Parent completes with a follow-up → the proposed child shows the parent's summary as its finding.
  const parent = queue.enqueueSeed({
    repository: "frostyard/updex",
    kind: "architecture-gap-discovery",
    objective: "Find one architecture gap.",
    instructions: "Read only.",
    acceptanceCriteria: ["One gap."],
    allowedActions: ["read", "create-followup"],
    delegableActions: ["read", "write", "run-tests", "open-pr"],
    createdBy: "operator:test",
  });
  const parentLease = queue.claim({ worker: "claude:updex:one", repository: "frostyard/updex" })!;
  queue.complete({
    id: parent.id,
    leaseToken: parentLease.leaseToken!,
    worker: "claude:updex:one",
    result: { summary: "ADR-0022 requires make ci; updex has no ci target.", evidence: ["Makefile has no ci target."], artifacts: [] },
    followUps: [
      {
        kind: "contract-reconciliation",
        objective: "Reconcile updex with ADR-0022: add the ci target and the reserved-prefix filter.",
        instructions: "Add the target and open a pull request.",
        acceptanceCriteria: ["make ci exists."],
        allowedActions: ["read", "write", "run-tests", "open-pr"],
        delegableActions: [],
      },
    ],
  });

  // Blocked item.
  const blockedSeed = queue.enqueueSeed({
    repository: "frostyard/updex",
    kind: "quality-implementation",
    objective: "Fix the instance-scoped merged state.",
    instructions: "Implement and open a pull request.",
    acceptanceCriteria: ["Tests pass."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const blockedLease = queue.claim({ worker: "copilot-cli:updex:two", repository: "frostyard/updex" })!;
  queue.block(blockedSeed.id, blockedLease.leaseToken!, "copilot-cli:updex:two", "The client environment denied git staging, so no commit or pull request could be created.");

  // Completed item with an unverified pull-request artifact.
  const unverifiedSeed = queue.enqueueSeed({
    repository: "frostyard/example",
    kind: "issue-resolution",
    objective: "Resolve frostyard/example#2: events --since and watch",
    instructions: "Open a pull request.",
    acceptanceCriteria: ["PR open."],
    allowedActions: ["read", "write", "open-pr"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const unverifiedLease = queue.claim({ worker: "claude:example:three", repository: "frostyard/example" })!;
  queue.complete({
    id: unverifiedSeed.id,
    leaseToken: unverifiedLease.leaseToken!,
    worker: "claude:example:three",
    result: {
      summary: "Opened the pull request.",
      evidence: ["npm run check passed."],
      artifacts: [
        {
          kind: "pull-request",
          url: "https://github.com/frostyard/example/pull/5",
          verification: { status: "unverified", attemptedAt: "2026-08-17T20:36:00.000Z", reason: "GitHub returned 404 without FLUENT_GITHUB_TOKEN" },
        },
      ],
    },
    followUps: [],
  });

  // Live claimed item: its lease token must never be rendered.
  const claimedSeed = queue.enqueueSeed({
    repository: "frostyard/example",
    kind: "security-implementation",
    objective: "Harden the thing.",
    instructions: "Do it.",
    acceptanceCriteria: ["Done."],
    allowedActions: ["read", "write"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const claimed = queue.claim({ worker: "copilot-cli:example:four", repository: "frostyard/example" })!;
  assert.equal(claimed.id, claimedSeed.id);
  assert.ok(claimed.leaseToken);
  return { queue, path, directory, leaseToken: claimed.leaseToken!, parent, blockedSeed, unverifiedSeed };
}

test("the operator surface requires a session, sets the cookie on the right token, and renders the read-only inbox without lease tokens", async () => {
  const seeded = await seededQueue();
  test.after(() => seeded.queue.close());
  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue: seeded.queue }) });

  // Unauthenticated: redirected to /login; the login page renders without touching the store.
  const anonymous = await app.request("/");
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get("Location"), "/login");
  const loginForm = await app.request("/login");
  assert.equal(loginForm.status, 200);
  assert.match(await loginForm.text(), /<form class="ph-login-form" method="post" action="\/login">/);

  // Wrong token refused, no cookie.
  const wrong = await app.request("/login", { method: "POST", body: new URLSearchParams({ token: "nope" }) });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("Set-Cookie"), null);
  assert.match(await wrong.text(), /does not match FLUENT_APP_TOKEN/);

  // Right token: HttpOnly SameSite=Strict cookie carrying the HMAC digest, not the token.
  const right = await app.request("/login", { method: "POST", body: new URLSearchParams({ token: TOKEN }) });
  assert.equal(right.status, 303);
  assert.equal(right.headers.get("Location"), "/");
  const setCookie = right.headers.get("Set-Cookie")!;
  assert.match(setCookie, /^fluent_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.equal(setCookie.includes(TOKEN), false);
  const cookie = setCookie.split(";")[0]!;
  assert.equal(cookie, `fluent_session=${sessionDigest(TOKEN)}`);

  // A forged cookie is refused.
  const forged = await app.request("/", { headers: { Cookie: `fluent_session=${"0".repeat(64)}` } });
  assert.equal(forged.status, 303);

  const inbox = await app.request("/", { headers: { Cookie: cookie } });
  assert.equal(inbox.status, 200);
  assert.match(inbox.headers.get("Content-Type") ?? "", /text\/html/);
  const body = await inbox.text();

  // Structure from the artboard: sidebar, header kicker + h1, stat row, three grouped cards, events rail.
  assert.match(body, /<meta http-equiv="refresh" content="30">/);
  assert.match(body, /<aside class="ph-sidebar">/);
  assert.match(body, /class="ph-eyebrow"><i><\/i>fluent · operator inbox<\/div><h1>Needs you<\/h1>/);
  assert.match(body, /<div class="ph-stats">/);
  assert.match(body, /<span>Proposals<\/span><strong>1<\/strong>/);
  assert.match(body, /<span>Blocked<\/span><strong>1<\/strong>/);
  assert.match(body, /<span>Unverified artifacts<\/span><strong>1<\/strong>/);
  assert.match(body, /<span>Leased now<\/span><strong>1<\/strong><small>copilot-cli:example:four · security-implementation<\/small>/);

  // Proposals group: the child's objective and its parent's finding.
  const proposals = section(body, "proposals");
  assert.match(proposals, /<h2>Proposals awaiting admission<\/h2>/);
  assert.match(proposals, /Reconcile updex with ADR-0022: <span>add the ci target and the reserved-prefix filter\.<\/span>/);
  assert.match(proposals, /<div class="fl-finding"><span>Finding<\/span>ADR-0022 requires make ci; updex has no ci target\.<\/div>/);
  assert.match(proposals, /child of architecture-gap-discovery/);
  assert.match(proposals, /<button class="ph-button" disabled[^>]*>Approve<\/button>/);

  // Blocked group with the worker's reason.
  const blocked = section(body, "blocked");
  assert.match(blocked, /<h2>Blocked — needs an operator exit<\/h2>/);
  assert.match(blocked, /<strong><a href="\/items\/[0-9a-f-]+">quality-implementation<\/a><\/strong>/);
  assert.match(blocked, /blocked \d\d:\d\d by copilot-cli:updex:two/);
  assert.match(blocked, /The client environment denied git staging, so no commit or pull request could be created\./);
  assert.match(blocked, /<textarea class="fl-note" disabled/);

  // Unverified artifacts group.
  const unverified = section(body, "unverified");
  assert.match(unverified, /<h2>Unverified artifacts<\/h2>/);
  assert.match(unverified, /Resolve frostyard\/example#2: <span>events --since and watch<\/span>/);
  assert.match(unverified, /<span class="ph-version">PR #5<\/span>/);
  assert.match(unverified, /GitHub returned 404 without FLUENT_GITHUB_TOKEN/);

  // Events rail: newest first, with the "since <sequence>" caption.
  const events = section(body, "events");
  const metadata = seeded.queue.metadata();
  assert.match(events, new RegExp(`<h2>Events</h2><span>since ${Math.max(0, metadata.lastEventSequence - 30)} · all repositories</span>`));
  const newest = seeded.queue.eventsSince(metadata.lastEventSequence - 1)[0]!;
  assert.equal(newest.type, "work.claimed");
  const firstEvent = /<div class="fl-event">.*?<\/div><\/div><\/div>/s.exec(events)![0];
  assert.match(firstEvent, /<b>work\.claimed<\/b><a href="\/items\/[0-9a-f-]+" title="[^"]+">security-implementation<\/a>/);

  // Sidebar without a control plane lists opted-in repositories; footer prints paths.
  assert.match(body, /<div class="ph-nav-group">Opted in<\/div>/);
  assert.match(body, /frostyard\/example/);
  assert.match(body, /frostyard\/updex/);
  assert.match(body, new RegExp(`<footer class="fl-footer"><span>queue ${escapeRegExp(seeded.path)}</span><span>control-plane not configured</span>`));

  // Never a lease token, anywhere.
  assert.equal(body.includes(seeded.leaseToken), false);
  assert.equal(body.includes("leaseToken"), false);

  // Read-only: no enabled mutation control on the page.
  assert.equal(/<button(?![^>]*disabled)[^>]*>(Approve|Reject|Requeue with note|Cancel|Re-verify)</.test(body), false);

  // Logout clears the cookie and the inbox is gated again.
  const logout = await app.request("/logout", { method: "POST", headers: { Cookie: cookie } });
  assert.equal(logout.status, 303);
  assert.match(logout.headers.get("Set-Cookie") ?? "", /^fluent_session=; .*Max-Age=0$/);
  const authenticatedLogin = await app.request("/login", { headers: { Cookie: cookie } });
  assert.equal(authenticatedLogin.status, 303);
  assert.equal(authenticatedLogin.headers.get("Location"), "/");

  // The existing routes are unaffected by mounting the surface at "/".
  const health = await app.request("/health");
  assert.equal(health.status, 200);
  const agents = await app.request("/agents/queue-clerk");
  assert.equal(agents.status, 401);
});

test("the sidebar lists control-plane repositories with their effective states when FLUENT_CONTROL_DB is configured", async () => {
  const seeded = await seededQueue();
  test.after(() => seeded.queue.close());
  const controlPlanePath = join(seeded.directory, "control-plane.db");
  const control = new ControlPlaneStore(controlPlanePath);
  await enrollExampleRepository(control);
  control.close();

  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue: seeded.queue, controlPlanePath }) });
  const cookie = `fluent_session=${sessionDigest(TOKEN)}`;
  const inbox = await app.request("/", { headers: { Cookie: cookie } });
  assert.equal(inbox.status, 200);
  const body = await inbox.text();
  assert.match(body, /<div class="ph-nav-group">Enrolled<\/div>/);
  assert.match(body, /<a class="fl-repo" href="\/repositories\/frostyard\/example" title="enrolled"><span class="ok"><\/span>frostyard\/example<\/a>/);
  assert.match(body, /<td><a href="\/repositories\/frostyard\/updex">frostyard\/updex<\/a><small class="fl-sub">not in control plane<\/small><\/td>/);
  assert.match(body, new RegExp(`<span>control-plane ${escapeRegExp(controlPlanePath)}</span>`));
  assert.equal(body.includes(seeded.leaseToken), false);
});

test("with FLUENT_APP_TOKEN unset every surface route returns 503 and never opens the store", async () => {
  let opened = 0;
  const app = createApp({
    appToken: undefined,
    surfaceStores: () => {
      opened += 1;
      throw new Error("must not be called");
    },
  });
  for (const [path, init] of [
    ["/", undefined],
    ["/login", undefined],
    ["/login", { method: "POST", body: new URLSearchParams({ token: "x" }) }],
    ["/logout", { method: "POST" }],
  ] as Array<[string, RequestInit | undefined]>) {
    const response = await app.request(path, init);
    assert.equal(response.status, 503, path);
    assert.match(await response.text(), /FLUENT_APP_TOKEN is not configured/);
  }
  assert.equal(opened, 0);
});

test("a store that cannot be opened renders 503 after authentication, not a stack trace", async () => {
  const app = createApp({
    appToken: TOKEN,
    surfaceStores: () => {
      throw new Error("SQLITE_CANTOPEN: unable to open database file");
    },
  });
  const inbox = await app.request("/", { headers: { Cookie: `fluent_session=${sessionDigest(TOKEN)}` } });
  assert.equal(inbox.status, 503);
  const body = await inbox.text();
  assert.match(body, /The queue database could not be opened: SQLITE_CANTOPEN/);
  assert.equal(body.includes("    at "), false);
});

function section(body: string, id: string): string {
  const match = new RegExp(`<(?:section|aside) class="fl-group[^"]*" id="${id}">.*?</(?:section|aside)>`, "s").exec(body);
  assert.ok(match, `section ${id} present`);
  return match[0];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("the repository board shows queued, leased, and completed columns with the control-plane enrollment badge; the index lists counts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-surface-board-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/example", true);
  const seed = (kind: string, objective: string, extra: { sourceRef?: string; priority?: number } = {}) =>
    queue.enqueueSeed({
      repository: "frostyard/example",
      kind,
      objective,
      instructions: "Do it.",
      acceptanceCriteria: ["Done."],
      allowedActions: ["read", "write", "open-pr"],
      delegableActions: [],
      createdBy: "operator:test",
      ...extra,
    });

  // Completed with a merged pull request.
  const done = seed("issue-resolution", "Resolve frostyard/example#9: fix the flaky test", { sourceRef: "https://github.com/frostyard/example/issues/9", priority: 3 });
  const doneLease = queue.claim({ worker: "claude:example:done", repository: "frostyard/example" })!;
  queue.complete({
    id: done.id,
    leaseToken: doneLease.leaseToken!,
    worker: "claude:example:done",
    result: {
      summary: "Fixed.",
      evidence: ["tests pass"],
      artifacts: [{ kind: "pull-request", url: "https://github.com/frostyard/example/pull/12", verification: { status: "verified", verifiedAt: "2026-08-18T01:00:00.000Z", number: 12, state: "merged", headSha: "abcdef0123456789", mergedAt: "2026-08-18T00:59:00.000Z" } }],
    },
    followUps: [],
  });
  // Claimed (leased) — highest priority claims first.
  const busy = seed("security-implementation", "Require HTTPS for catalog URLs", { priority: 5 });
  const lease = queue.claim({ worker: "copilot-cli:example:busy", repository: "frostyard/example", leaseSeconds: 3600 })!;
  assert.equal(lease.id, busy.id);
  // Queued with an operator note and an imported source.
  const waiting = seed("issue-resolution", "Resolve frostyard/example#304: make lint swallows failures", { sourceRef: "https://github.com/frostyard/example/issues/304", priority: 5 });
  queue.note(waiting.id, "operator:test", "Reuse the lint branch.");
  const later = seed("contract-reconciliation", "Reconcile with ADR-0022", { priority: 0 });

  const controlPlanePath = join(directory, "control-plane.db");
  const control = new ControlPlaneStore(controlPlanePath);
  await enrollExampleRepository(control);
  const coreCommit = control.activeCoreSnapshot()!.sourceCommitId;
  control.close();

  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue, controlPlanePath }) });
  const cookie = `fluent_session=${sessionDigest(TOKEN)}`;

  const board = await app.request("/repositories/frostyard/example", { headers: { Cookie: cookie } });
  assert.equal(board.status, 200);
  const body = await board.text();
  assert.match(body, /class="ph-eyebrow"><i><\/i>repository · board<\/div><h1>frostyard\/example<\/h1>/);
  assert.match(body, /<span class="ph-badge ok">enrolled<\/span>/);
  assert.match(body, new RegExp(`<span class="fl-facts">Core ${coreCommit.slice(0, 7)} · surfaces [0-9a-f]{7} · id github\\.com:9001</span>`));
  assert.match(body, /<button class="ph-button reject" disabled[^>]*>Hold repository<\/button>/);
  assert.match(body, /<span>Queued<\/span><strong>2<\/strong><small>next: #304 \(p5\)<\/small>/);
  assert.match(body, /<span>Leased<\/span><strong>1<\/strong><small>copilot-cli · \d+m left<\/small>/);
  assert.match(body, /<span>Merged \/ attempts<\/span><strong>1 \/ 1<\/strong>/);

  const queued = section(body, "queued");
  assert.match(queued, /<h2>Queued · claim order<\/h2><span>2<\/span>/);
  const queuedIds = [...queued.matchAll(/href="\/items\/([0-9a-f-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(queuedIds, [waiting.id, later.id]); // claim order: priority 5 before 0
  assert.match(queued, /<span class="ph-badge">p5<\/span><span class="ph-badge warn">note<\/span>/);
  assert.match(queued, /#304 · issue-resolution · 1 operator note/);
  assert.equal(queued.includes(busy.id), false);
  assert.equal(queued.includes(done.id), false);

  const leased = section(body, "leased");
  assert.match(leased, new RegExp(`href="/items/${busy.id}"`));
  assert.match(leased, /<span class="ph-badge ok">claimed<\/span>/);
  assert.match(leased, /security-implementation · copilot-cli:example:busy/);
  assert.match(leased, /<div class="fl-lease-bar"><div style="width:(9\d|100)%"><\/div><\/div>/);
  assert.equal(leased.includes(lease.leaseToken!), false);

  const completed = section(body, "completed");
  assert.match(completed, new RegExp(`href="/items/${done.id}"`));
  assert.match(completed, /<span class="ph-badge ok">merged<\/span>/);
  assert.match(completed, /issue-resolution · PR #12 · \d\d:\d\d · claude/);
  assert.equal(completed.includes(waiting.id), false);

  assert.equal(body.includes(lease.leaseToken!), false);
  assert.equal(body.includes("leaseToken"), false);

  // Index: counts per repository and the enrollment badge.
  const index = await app.request("/repositories", { headers: { Cookie: cookie } });
  assert.equal(index.status, 200);
  const indexBody = await index.text();
  assert.match(indexBody, /<a href="\/repositories\/frostyard\/example">frostyard\/example<\/a>/);
  assert.match(indexBody, /<td><span class="ph-badge ok">enrolled<\/span><\/td>\s*<td class="right">0<\/td><td class="right">2<\/td><td class="right">1<\/td><td class="right">0<\/td><td class="right">1<\/td><td class="right">0<\/td>/);
  assert.equal(indexBody.includes(lease.leaseToken!), false);

  // Unknown repository is a 404 inside the shell; unauthenticated is still redirected.
  const missing = await app.request("/repositories/frostyard/nope", { headers: { Cookie: cookie } });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /neither opted in to the queue nor declared/);
  const anonymous = await app.request("/repositories/frostyard/example");
  assert.equal(anonymous.status, 303);
});

test("the item page renders the definition, artifacts with verification, operator notes, previous results, and the event timeline for a requeued-then-completed item", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-surface-item-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/updex", true);

  const parent = queue.enqueueSeed({
    repository: "frostyard/updex",
    kind: "quality-gap-discovery",
    objective: "Find one quality gap.",
    instructions: "Read only.",
    acceptanceCriteria: ["One gap."],
    allowedActions: ["read", "create-followup"],
    delegableActions: ["read", "write", "run-tests", "open-pr"],
    createdBy: "operator:test",
  });
  const parentLease = queue.claim({ worker: "claude:updex:discover", repository: "frostyard/updex" })!;
  const { followUps } = queue.complete({
    id: parent.id,
    leaseToken: parentLease.leaseToken!,
    worker: "claude:updex:discover",
    result: { summary: "GetActiveVersionAt reads a hard-coded path.", evidence: ["sysext/active.go:12"], artifacts: [] },
    followUps: [
      {
        kind: "quality-implementation",
        objective: "Make the sysext merged-state signal instance-scoped.",
        instructions: "Implement it and open a pull request.\nRun make check.",
        acceptanceCriteria: ["The directory is supplied by the caller.", "Coverage of GetActiveVersionAt is at least 90%."],
        allowedActions: ["read", "write", "run-tests", "open-pr"],
        delegableActions: [],
      },
    ],
  });
  const child = followUps[0]!;
  queue.approve(child.id, "operator:test");
  const first = queue.claim({ worker: "copilot-cli:updex:first", repository: "frostyard/updex" })!;
  assert.equal(first.id, child.id);
  queue.block(child.id, first.leaseToken!, "copilot-cli:updex:first", "The client denied git staging, so no commit could be created.");
  queue.requeue(child.id, "operator:test", "Do NOT reimplement — check out branch fix/instance-scoped and open the PR.");
  const second = queue.claim({ worker: "copilot-cli:updex:second", repository: "frostyard/updex" })!;
  queue.complete({
    id: child.id,
    leaseToken: second.leaseToken!,
    worker: "copilot-cli:updex:second",
    result: {
      summary: "Opened PR #307 from the existing branch.",
      evidence: ["make check green", "coverage 94.1%"],
      artifacts: [
        { kind: "pull-request", url: "https://github.com/frostyard/updex/pull/307", description: "Instance-scoped merged state", verification: { status: "verified", verifiedAt: "2026-08-18T00:40:00.000Z", number: 307, state: "open", headSha: "aefee872deadbeef" } },
        { kind: "commit", url: "https://github.com/frostyard/updex/commit/4b4c3387aaaaaaaa" },
      ],
    },
    followUps: [],
  });
  queue.recordArtifactVerification(
    child.id,
    "https://github.com/frostyard/updex/pull/307",
    { status: "verified", verifiedAt: "2026-08-18T00:57:51.000Z", number: 307, state: "merged", headSha: "aefee872deadbeef", mergedAt: "2026-08-18T00:57:15.000Z" },
    "operator:cli",
  );

  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue }) });
  const cookie = `fluent_session=${sessionDigest(TOKEN)}`;
  const page = await app.request(`/items/${child.id}`, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const body = await page.text();

  // Header: kicker with the id, h1 kind · repository, status and delivery tags, disabled ghost buttons.
  assert.match(body, new RegExp(`<div class="ph-eyebrow"><i></i>item · ${child.id}</div><h1>quality-implementation · frostyard/updex</h1>`));
  assert.match(body, /<span class="ph-badge ok">completed<\/span><span class="ph-badge ok">delivery · merged<\/span><button class="ph-button secondary" disabled[^>]*>Re-verify<\/button>/);

  // Definition.
  const definition = section(body, "definition");
  assert.match(definition, /<p class="fl-objective">Make the sysext merged-state signal instance-scoped\.<\/p>/);
  assert.match(definition, /<span>repository<\/span><span><a href="\/repositories\/frostyard\/updex">frostyard\/updex<\/a> · <span class="ph-badge">opted in<\/span><\/span>/);
  assert.match(definition, /<span>kind<\/span><span>quality-implementation<\/span>/);
  assert.match(definition, new RegExp(`child of <a href="/items/${parent.id}">quality-gap-discovery</a> · root <a href="/items/${parent.id}" title="quality-gap-discovery">${parent.id.slice(0, 8)}</a>`));
  assert.match(definition, /<span>priority<\/span><span>0 \(inherited\)<\/span>/);
  assert.match(definition, /<span>allowed<\/span><span><span class="fl-badges"><span class="ph-badge">read<\/span><span class="ph-badge">write<\/span><span class="ph-badge">run-tests<\/span><span class="ph-badge">open-pr<\/span><\/span><\/span>/);
  assert.match(definition, /<span>created<\/span><span>\d\d:\d\d:\d\d by claude:updex:discover<\/span>/);
  assert.match(definition, /<pre class="fl-pre">Implement it and open a pull request\.\nRun make check\.<\/pre>/);
  assert.match(definition, /<ol class="fl-criteria"><li>The directory is supplied by the caller\.<\/li><li>Coverage of GetActiveVersionAt is at least 90%\.<\/li><\/ol>/);

  // Result with artifacts and verification.
  const result = section(body, "result");
  assert.match(result, /<h2>Result<\/h2><span>completed \d\d:\d\d:\d\d by copilot-cli:updex:second<\/span>/);
  assert.match(result, /<p class="fl-objective">Opened PR #307 from the existing branch\.<\/p>/);
  assert.match(result, /<li>make check green<\/li><li>coverage 94\.1%<\/li>/);
  assert.match(result, /<td>pull-request<\/td><td><a href="https:\/\/github\.com\/frostyard\/updex\/pull\/307" rel="noreferrer noopener">https:\/\/github\.com\/frostyard\/updex\/pull\/307 ↗<\/a><small class="fl-sub">Instance-scoped merged state<\/small><\/td><td><span class="ph-badge ok">verified · merged<\/span><small class="fl-sub">PR #307 · head aefee872 · merged 00:57:15 · verified 00:57:51 by operator:cli<\/small><\/td>/);
  assert.match(result, /<td>commit<\/td><td><a href="https:\/\/github\.com\/frostyard\/updex\/commit\/4b4c3387aaaaaaaa"[^>]*>[^<]+<\/a><\/td><td><span class="ph-badge">provenance<\/span><small class="fl-sub">commits are not verified in v1<\/small><\/td>/);

  // Operator notes and previous results.
  const notes = section(body, "notes");
  assert.match(notes, /<h2>Operator notes<\/h2><span>1<\/span>/);
  assert.match(notes, /<span>\d\d:\d\d:\d\d · requeue<br>operator:test<\/span><span>Do NOT reimplement — check out branch fix\/instance-scoped and open the PR\.<\/span>/);
  const previous = section(body, "previous");
  assert.match(previous, /<h2>Previous results<\/h2><span>1<\/span>/);
  assert.match(previous, /The client denied git staging, so no commit could be created\./);

  // Events timeline: every event of the item in order, with the actors and gists.
  const events = section(body, "events");
  const timeline = queue.events(child.id);
  assert.match(events, new RegExp(`<h2>Events</h2><span>${timeline.length} · sequence ${timeline[0]!.sequence}–${timeline.at(-1)!.sequence}</span>`));
  const types = [...events.matchAll(/<b>([a-z.]+)<\/b>/g)].map((match) => match[1]);
  assert.deepEqual(types, timeline.map((event) => event.type));
  assert.deepEqual(types, ["work.proposed", "work.approved", "work.claimed", "work.blocked", "work.requeued", "work.claimed", "work.completed", "artifact.verified"]);
  assert.match(events, /<b>work\.proposed<\/b><span>claude:updex:discover<em class="fl-muted"> · parent [0-9a-f]{8}<\/em><\/span>/);
  assert.match(events, /<b>work\.completed<\/b><span>copilot-cli:updex:second<em class="fl-muted"> · 0 follow-ups<\/em><\/span>/);
  assert.match(events, /<b>artifact\.verified<\/b><span>operator:cli<em class="fl-muted"> · PR #307 open → merged<\/em><\/span>/);

  // Never a lease token; the parent page lists the child.
  assert.equal(body.includes(first.leaseToken!), false);
  assert.equal(body.includes(second.leaseToken!), false);
  assert.equal(body.includes("leaseToken"), false);
  const parentPage = await (await app.request(`/items/${parent.id}`, { headers: { Cookie: cookie } })).text();
  assert.match(parentPage, new RegExp(`1 child: <a href="/items/${child.id}">quality-implementation</a> <em class="fl-muted">\\(completed\\)</em>`));
  assert.equal(parentPage.includes(parentLease.leaseToken!), false);

  const missing = await app.request("/items/00000000-0000-0000-0000-000000000000", { headers: { Cookie: cookie } });
  assert.equal(missing.status, 404);
  assert.match(await missing.text(), /No work item 00000000-0000-0000-0000-000000000000\./);
});
