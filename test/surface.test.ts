import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.ts";
import { ControlPlaneStore } from "../src/control/store.ts";
import { QueueStore } from "../src/queue/store.ts";
import type { AllowedAction, WorkArtifact } from "../src/queue/types.ts";
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
  const directory = await mkdtemp(join(tmpdir(), "snowcat-surface-test-"));
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
          verification: { status: "unverified", attemptedAt: "2026-08-17T20:36:00.000Z", reason: "GitHub returned 404 without SNOWCAT_GITHUB_TOKEN" },
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
  assert.match(await wrong.text(), /does not match SNOWCAT_APP_TOKEN/);

  // Right token: HttpOnly SameSite=Strict cookie carrying the HMAC digest, not the token.
  const right = await app.request("/login", { method: "POST", body: new URLSearchParams({ token: TOKEN }) });
  assert.equal(right.status, 303);
  assert.equal(right.headers.get("Location"), "/");
  const setCookie = right.headers.get("Set-Cookie")!;
  assert.match(setCookie, /^snowcat_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict$/);
  assert.equal(setCookie.includes(TOKEN), false);
  const cookie = setCookie.split(";")[0]!;
  assert.equal(cookie, `snowcat_session=${sessionDigest(TOKEN)}`);

  // A forged cookie is refused.
  const forged = await app.request("/", { headers: { Cookie: `snowcat_session=${"0".repeat(64)}` } });
  assert.equal(forged.status, 303);

  const inbox = await app.request("/", { headers: { Cookie: cookie } });
  assert.equal(inbox.status, 200);
  assert.match(inbox.headers.get("Content-Type") ?? "", /text\/html/);
  const body = await inbox.text();

  // Structure from the artboard: sidebar, header kicker + h1, stat row, three grouped cards, events rail.
  assert.match(body, /<noscript><meta http-equiv="refresh" content="30"><\/noscript>/);
  assert.match(body, /<script>\(function \(\) \{\s*var cfg = \{"page":"\/","partials":\["stats","proposals","blocked","unverified","adjudication"\],"repository":null,"refresh":30,"reload":false,"reloadDelay":2000,"queueEventPrefix":"work\.","queueEventTypes":\["artifact\.verified","artifact\.attached"\]\};/);
  assert.equal(/<script[^>]*src=/.test(body), false); // nothing loaded from elsewhere

  // The dirty-form guard (issue #155): a due refresh — reload or fragment swap —
  // is deferred while a form is being edited, and resumes on submit/reset/blur.
  // The guard gates BOTH refresh paths, so a page with no forms (formBusy()
  // trivially false over zero fields) keeps plain reload/swap behavior.
  assert.match(body, /function formBusy\(\) \{\s*if \(editable\(document\.activeElement\)\) return true;\s*var fields = document\.querySelectorAll\("form input, form textarea"\);/);
  assert.match(body, /function refetch\(\) \{\s*pending = null;\s*if \(formBusy\(\)\) \{ deferred = true; setPill\("Live · paused while editing", true\); return; \}\s*if \(cfg\.reload\) \{ location\.reload\(\); return; \}/);
  assert.match(body, /document\.addEventListener\("submit", resume\);/);
  assert.match(body, /document\.addEventListener\("focusout", function \(\) \{ setTimeout\(resume, 0\); \}\);/);
  // Hidden inputs (precondition fields) and submit buttons never count as edits.
  assert.match(body, /return t !== "hidden" && t !== "submit" && t !== "button" && t !== "checkbox" && t !== "radio";/);
  assert.match(body, /<aside class="ph-sidebar">/);
  assert.match(body, /class="ph-eyebrow"><i><\/i>snowcat · operator inbox<\/div><h1>Needs you<\/h1>/);
  assert.match(body, /<div class="ph-stats" id="stats">/);
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
  assert.match(proposals, /<form class="fl-decide" method="post" action="\/items\/[0-9a-f-]+\/approve"><input type="hidden" name="status" value="proposed"><input type="hidden" name="updatedAt" value="[^"]+"><input type="hidden" name="return" value="\/">/);
  assert.match(proposals, /<button class="ph-button" type="submit">Approve<\/button><button class="ph-button reject" type="submit" formaction="\/items\/[0-9a-f-]+\/reject">Reject<\/button>/);

  // Blocked group with the worker's reason.
  const blocked = section(body, "blocked");
  assert.match(blocked, /<h2>Blocked — needs an operator exit<\/h2>/);
  assert.match(blocked, /<strong><a href="\/items\/[0-9a-f-]+">quality-implementation<\/a><\/strong>/);
  assert.match(blocked, /blocked \d\d:\d\d by copilot-cli:updex:two/);
  assert.match(blocked, /The client environment denied git staging, so no commit or pull request could be created\./);
  assert.match(blocked, /<form class="fl-exit" method="post" action="\/items\/[0-9a-f-]+\/requeue"><input type="hidden" name="status" value="blocked">/);
  assert.match(blocked, /<textarea class="fl-note" name="reason"/);
  assert.match(unverifiedSectionPlaceholder(body), /<form class="fl-inline" method="post" action="\/repositories\/frostyard\/example\/verify-artifacts">/);

  // Unverified artifacts group.
  const unverified = section(body, "unverified");
  assert.match(unverified, /<h2>Unverified artifacts<\/h2>/);
  assert.match(unverified, /Resolve frostyard\/example#2: <span>events --since and watch<\/span>/);
  assert.match(unverified, /<span class="ph-version">PR #5<\/span>/);
  assert.match(unverified, /GitHub returned 404 without SNOWCAT_GITHUB_TOKEN/);

  // Events rail: newest first, with the "since <sequence>" caption.
  const events = section(body, "events");
  const metadata = seeded.queue.metadata();
  assert.match(events, new RegExp(`<h2><a href="/events">Events</a></h2><span>since ${Math.max(0, metadata.lastEventSequence - 30)} · all repositories</span>`));
  const newest = seeded.queue.eventsSince(metadata.lastEventSequence - 1)[0]!;
  assert.equal(newest.type, "work.claimed");
  const firstEvent = /<div class="fl-event">.*?<\/div><\/div><\/div>/s.exec(events)![0];
  assert.match(firstEvent, /<b>work\.claimed<\/b><a href="\/items\/[0-9a-f-]+" title="[^"]+">security-implementation<\/a>/);

  // Sidebar without a control plane lists opted-in repositories; footer prints paths.
  assert.match(body, /<a class="ph-nav-link" href="\/progress"><span class="ph-nav-num">03<\/span>Progress<\/a>/);
  assert.match(body, /<a class="ph-nav-link" href="\/events"><span class="ph-nav-num">04<\/span>Events<\/a>/);
  assert.match(body, /<div class="ph-nav-group">Opted in<\/div>/);
  assert.match(body, /frostyard\/example/);
  assert.match(body, /frostyard\/updex/);
  assert.match(body, new RegExp(`<footer class="fl-footer"><span>queue ${escapeRegExp(seeded.path)}</span><span>control-plane not configured</span>`));

  // Never a lease token, anywhere.
  assert.equal(body.includes(seeded.leaseToken), false);
  assert.equal(body.includes("leaseToken"), false);

  // Every mutation is a POST form carrying the precondition; nothing mutates on GET.
  assert.equal(/<form(?![^>]*method="post")/.test(body.replace(/<form class="fl-logout" method="post"/g, "")), false);

  // Logout clears the cookie and the inbox is gated again.
  const logout = await app.request("/logout", { method: "POST", headers: { Cookie: cookie } });
  assert.equal(logout.status, 303);
  assert.match(logout.headers.get("Set-Cookie") ?? "", /^snowcat_session=; .*Max-Age=0$/);
  const authenticatedLogin = await app.request("/login", { headers: { Cookie: cookie } });
  assert.equal(authenticatedLogin.status, 303);
  assert.equal(authenticatedLogin.headers.get("Location"), "/");

  // The existing routes are unaffected by mounting the surface at "/".
  const health = await app.request("/health");
  assert.equal(health.status, 200);
  const agents = await app.request("/agents/queue-clerk");
  assert.equal(agents.status, 401);
});

test("the sidebar lists control-plane repositories with their effective states when SNOWCAT_CONTROL_DB is configured", async () => {
  const seeded = await seededQueue();
  test.after(() => seeded.queue.close());
  const controlPlanePath = join(seeded.directory, "control-plane.db");
  const control = new ControlPlaneStore(controlPlanePath);
  await enrollExampleRepository(control);
  control.close();

  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue: seeded.queue, controlPlanePath }) });
  const cookie = `snowcat_session=${sessionDigest(TOKEN)}`;
  const inbox = await app.request("/", { headers: { Cookie: cookie } });
  assert.equal(inbox.status, 200);
  const body = await inbox.text();
  assert.match(body, /<div class="ph-nav-group">Enrolled<\/div>/);
  assert.match(body, /<a class="fl-repo" href="\/repositories\/frostyard\/example" title="enrolled"><span class="ok"><\/span>frostyard\/example<\/a>/);
  assert.match(body, /<td><a href="\/repositories\/frostyard\/updex">frostyard\/updex<\/a><small class="fl-sub">not in control plane<\/small><\/td>/);
  assert.match(body, new RegExp(`<span>control-plane ${escapeRegExp(controlPlanePath)}</span>`));
  assert.equal(body.includes(seeded.leaseToken), false);
});

test("with SNOWCAT_APP_TOKEN unset every surface route returns 503 and never opens the store", async () => {
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
    assert.match(await response.text(), /nor SNOWCAT_APP_TOKEN is configured/);
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
  const inbox = await app.request("/", { headers: { Cookie: `snowcat_session=${sessionDigest(TOKEN)}` } });
  assert.equal(inbox.status, 503);
  const body = await inbox.text();
  assert.match(body, /The queue database could not be opened: SQLITE_CANTOPEN/);
  assert.equal(body.includes("    at "), false);
});

function unverifiedSectionPlaceholder(body: string): string {
  return section(body, "unverified");
}

function section(body: string, id: string): string {
  const match = new RegExp(`<(?:section|aside) class="fl-group[^"]*" id="${id}">.*?</(?:section|aside)>`, "s").exec(body);
  assert.ok(match, `section ${id} present`);
  return match[0];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("the repository board shows queued, leased, and completed columns with the control-plane enrollment badge; the index lists counts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-surface-board-test-"));
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
  const cookie = `snowcat_session=${sessionDigest(TOKEN)}`;

  const board = await app.request("/repositories/frostyard/example", { headers: { Cookie: cookie } });
  assert.equal(board.status, 200);
  const body = await board.text();
  assert.match(body, /class="ph-eyebrow"><i><\/i>repository · board<\/div><h1>frostyard\/example<\/h1>/);
  assert.match(body, /<span class="ph-badge ok">enrolled<\/span>/);
  assert.match(body, new RegExp(`<span class="fl-facts">Core ${coreCommit.slice(0, 7)} · surfaces [0-9a-f]{7} · id github\\.com:9001</span>`));
  assert.match(body, /<form class="fl-action" method="post" action="\/repositories\/frostyard\/example\/hold"><input type="hidden" name="return" value="\/repositories\/frostyard\/example">.*?<button class="ph-button reject" type="submit">Hold repository<\/button><\/form>/s);
  assert.match(body, /<form class="fl-action" method="post" action="\/repositories\/frostyard\/example\/import-issues">/);
  assert.match(body, /<form class="fl-action" method="post" action="\/repositories\/frostyard\/example\/seed-dogfood">.*?Read-only discovery roots for the declared programs \(quality daily, ci daily\); no-finding cooldown per program\./s);
  assert.match(body, /<form class="fl-inline" method="post" action="\/repositories\/frostyard\/example\/verify-artifacts">/);
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

test("the board's pull-request section shows open heads with their cure decay and recent merges; the index summarizes them per repository", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-surface-pulls-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/example", true);
  const now = new Date();
  const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 3600 * 1000).toISOString();
  const openHead = "a".repeat(40);

  /** Completes one seeded item with one verified pull-request artifact. */
  const report = (objective: string, artifact: WorkArtifact) => {
    const seed = queue.enqueueSeed({
      repository: "frostyard/example",
      kind: "issue-resolution",
      objective,
      instructions: "Open a pull request.",
      acceptanceCriteria: ["PR open."],
      allowedActions: ["read", "write", "open-pr"],
      delegableActions: [],
      createdBy: "operator:test",
    });
    const lease = queue.claim({ worker: "claude:example:pulls", repository: "frostyard/example" })!;
    assert.equal(lease.id, seed.id);
    queue.complete({
      id: seed.id,
      leaseToken: lease.leaseToken!,
      worker: "claude:example:pulls",
      result: { summary: "Opened.", evidence: ["npm run check passed."], artifacts: [artifact] },
      followUps: [],
    });
    return seed.id;
  };

  const openItem = report("Resolve frostyard/example#40: stream the ledger tail", {
    kind: "pull-request",
    url: "https://github.com/frostyard/example/pull/41",
    verification: { status: "verified", verifiedAt: now.toISOString(), number: 41, state: "open", headSha: openHead },
  });
  const mergedTodayItem = report("Resolve frostyard/example#30: bound the delivery sweep", {
    kind: "pull-request",
    url: "https://github.com/frostyard/example/pull/31",
    verification: { status: "verified", verifiedAt: now.toISOString(), number: 31, state: "merged", headSha: "b".repeat(40), mergedAt: now.toISOString() },
  });
  report("Resolve frostyard/example#20: retire the old importer", {
    kind: "pull-request",
    url: "https://github.com/frostyard/example/pull/21",
    verification: { status: "verified", verifiedAt: tenDaysAgo, number: 21, state: "merged", headSha: "c".repeat(40), mergedAt: tenDaysAgo },
  });

  // The open head has decayed: one admitted pr-cure root bound to it (ADR-0061).
  const cure = queue.enqueueCureRoot("frostyard/example", {
    kind: "pr-cure",
    objective: "Cure frostyard/example#41 (head aaaaaaa): behind, failing-checks",
    instructions: "Rebase and make the checks pass.",
    acceptanceCriteria: ["Checks green."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    createdBy: "operator:test",
    sourceRef: `https://github.com/frostyard/example/pull/41@${openHead}`,
    cure: {
      pullRequestUrl: "https://github.com/frostyard/example/pull/41",
      headSha: openHead,
      patchDigest: `sha256:${"d".repeat(64)}`,
      decay: ["behind", "failing-checks"],
      originItemId: openItem,
    },
  })!;
  assert.ok(cure);

  // No fetcher is configured anywhere: rendering must not reach GitHub.
  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue }) });
  const cookie = `snowcat_session=${sessionDigest(TOKEN)}`;

  const board = await app.request("/repositories/frostyard/example", { headers: { Cookie: cookie } });
  assert.equal(board.status, 200);
  const body = await board.text();
  const pulls = section(body, "pull-requests");
  assert.match(pulls, /<h2>Pull requests<\/h2><span>open 1 · decayed 1 · merged today 1<\/span>/);

  // Open first, with its cure decay and a link to the cure item and to GitHub.
  const openRow = pulls.indexOf('href="https://github.com/frostyard/example/pull/41"');
  const mergedRow = pulls.indexOf('href="https://github.com/frostyard/example/pull/31"');
  assert.ok(openRow > -1 && mergedRow > -1 && openRow < mergedRow, "the open pull request is listed before the merged one");
  assert.ok(openRow < pulls.indexOf("<h2>Merged · last 7 days</h2>"), "the open pull request is above the merged sub-list");
  assert.ok(mergedRow > pulls.indexOf("<h2>Merged · last 7 days</h2>"), "the merged pull request is under Merged");
  assert.match(pulls, /<span class="ph-badge ">open<\/span><span class="ph-badge warn">decayed<\/span>/);
  assert.match(pulls, new RegExp(`head aaaaaaa · verified \\d\\d:\\d\\d · <a href="/items/${openItem}">reported by issue-resolution</a> · <a href="/items/${cure.id}">cure queued: behind, failing-checks</a>`));
  assert.match(pulls, new RegExp(`<span class="ph-badge ok">merged</span></span></div><small>head bbbbbbb · merged \\d\\d:\\d\\d · <a href="/items/${mergedTodayItem}">`));

  // The ten-day-old merge is out of the window.
  assert.equal(pulls.includes("/pull/21"), false);
  assert.equal(body.includes("leaseToken"), false);

  // The section is a live partial like the columns.
  const fragment = await app.request("/repositories/frostyard/example?partial=pull-requests", { headers: { Cookie: cookie } });
  assert.equal(fragment.status, 200);
  const fragmentBody = await fragment.text();
  assert.match(fragmentBody, /^<section class="fl-group" id="pull-requests">/);
  assert.equal(fragmentBody.includes("ph-sidebar"), false);

  // The index summarizes the same counts and links to the section.
  const index = await app.request("/repositories", { headers: { Cookie: cookie } });
  assert.equal(index.status, 200);
  const indexBody = await index.text();
  assert.match(indexBody, /<td><a class="fl-facts" href="\/repositories\/frostyard\/example#pull-requests">open 1 · decayed 1 · merged today 1<\/a><\/td>/);
  assert.equal(indexBody.includes("leaseToken"), false);
});

test("the board and inbox show the review gate: draft badge, review round, passed-review hint, and the adjudication group (ADR-0065)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-surface-review-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/example", true);
  queue.setRepositoryReviewGate("frostyard/example", true);
  const now = new Date();
  const head = "a".repeat(40);
  const url = "https://github.com/frostyard/example/pull/52";
  const seed = queue.enqueueSeed({
    repository: "frostyard/example",
    kind: "issue-resolution",
    objective: "Resolve frostyard/example#50: gate the importer",
    instructions: "Open a draft pull request.",
    acceptanceCriteria: ["PR open as a draft."],
    allowedActions: ["read", "write", "open-pr"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const lease = queue.claim({ worker: "claude:example:review", repository: "frostyard/example" })!;
  queue.complete({
    id: seed.id,
    leaseToken: lease.leaseToken!,
    worker: "claude:example:review",
    result: {
      summary: "Opened as a draft.",
      evidence: ["npm run check passed."],
      artifacts: [{ kind: "pull-request", url, verification: { status: "verified", verifiedAt: now.toISOString(), number: 52, state: "open", headSha: head, draft: true } }],
      model: "claude-sonnet-5",
    },
    followUps: [],
  });
  // Round 1 passed: the pull request is still a draft, so the gate waits for a human to mark it ready (writes off).
  const review = queue.enqueueReviewRoot("frostyard/example", {
    kind: "pr-review",
    objective: "Review frostyard/example#52 (head aaaaaaa, round 1 of 3)",
    instructions: "Read-only.",
    acceptanceCriteria: ["Verdict supplied."],
    allowedActions: ["read", "run-tests"],
    delegableActions: [],
    createdBy: "policy:review-gate",
    sourceRef: `pr-review:${url}@${head}`,
    review: { pullRequestUrl: url, headSha: head, round: 1, originItemId: seed.id, authorModel: "claude-sonnet-5", priorBlockers: [] },
  })!;
  const reviewer = queue.claim({ worker: "claude:example:reviewer", kinds: ["pr-review"] })!;
  queue.complete({
    id: review.id,
    leaseToken: reviewer.leaseToken!,
    worker: "claude:example:reviewer",
    result: { summary: "Passes.", evidence: [`head ${head}`], artifacts: [], model: "claude-opus-5" },
    followUps: [],
    review: { decision: "pass", blockers: [], advisories: [{ fingerprint: "adv:naming", text: "consider renaming gate()" }] },
  });

  // The last review sweep also found an open pull request no item reported
  // (ADR-0065): it is outside the gate until a human closes it or attaches it.
  const orphan = "https://github.com/frostyard/example/pull/70";
  queue.recordUnreportedPullRequests(
    "frostyard/example",
    { observedAt: "2026-08-19T18:00:00.000Z", pullRequests: [{ url: orphan, number: 70, draft: true, createdAt: "2026-08-19T09:00:00.000Z" }] },
    "policy:review-gate",
  );

  // No fetcher is configured anywhere: rendering must not reach GitHub.
  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue }) });
  const cookie = `snowcat_session=${sessionDigest(TOKEN)}`;

  const board = await app.request("/repositories/frostyard/example", { headers: { Cookie: cookie } });
  assert.equal(board.status, 200);
  const pulls = section(await board.text(), "pull-requests");
  assert.match(pulls, /<h2>Pull requests<\/h2><span>open 1 · decayed 0 · awaiting you 1 · unreported 1 · merged today 0<\/span>/);
  // The Unreported sub-list: the pull request, the draft badge, why it is here, and the way in.
  assert.match(pulls, /<h2>Unreported<\/h2><span>1 · observed /);
  assert.match(pulls, /no item reported this pull request — close it or attach it to its item/);
  assert.match(pulls, /<span class="ph-badge warn">unreported<\/span><span class="ph-badge">draft<\/span>/);
  assert.match(pulls, /<code>npm run queue -- attach-artifact &lt;id&gt; https:\/\/github.com\/frostyard\/example\/pull\/70<\/code>/);
  assert.match(pulls, /<span class="ph-badge ">open<\/span><span class="ph-badge">draft<\/span><span class="ph-badge ok">passed review<\/span>/);
  assert.match(pulls, new RegExp(`<a href="/items/${seed.id}">reported by issue-resolution</a> · <a href="/items/${review.id}">pr-review r1 completed · pass</a> · mark ready: <code>gh pr ready 52</code>`));
  assert.equal(pulls.includes("reported by pr-review"), false, "a review item never becomes the pull request's reporter");

  const inbox = await app.request("/", { headers: { Cookie: cookie } });
  assert.equal(inbox.status, 200);
  const inboxBody = await inbox.text();
  assert.match(inboxBody, /<span>Review adjudication<\/span><strong>2<\/strong>/, "the passed draft and the unreported pull request are both yours to decide");
  const adjudication = section(inboxBody, "adjudication");
  assert.match(adjudication, /Review adjudication — draft pull requests waiting for you/);
  assert.match(adjudication, /<span class="ph-badge ok">passed<\/span> round 1 · mark it ready: <code>gh pr ready 52<\/code>/);
  assert.match(adjudication, new RegExp(`href="/items/${review.id}">Open pr-review</a>`));
  // The unreported one, with the time it was observed and the attach hint.
  assert.match(adjudication, /<span class="ph-badge warn">unreported<\/span> outside the gate — close it, or bring it under the gate: <code>npm run queue -- attach-artifact &lt;id&gt; https:\/\/github.com\/frostyard\/example\/pull\/70<\/code>/);
  assert.match(adjudication, /no item reported this pull request<\/span><\/strong><small>draft · opened /);
  assert.match(adjudication, /observed /);

  // The repositories index carries the same count in its summary phrase.
  const repositories = await app.request("/repositories", { headers: { Cookie: cookie } });
  assert.equal(repositories.status, 200);
  assert.match(await repositories.text(), /awaiting you 1 · unreported 1 · merged today 0<\/a>/);
  const partial = await app.request("/?partial=adjudication", { headers: { Cookie: cookie } });
  assert.equal(partial.status, 200);
  assert.match(await partial.text(), /^<section class="fl-group" id="adjudication">/);

  // The item page shows the review record, the verdict, and the models.
  const item = await app.request(`/items/${review.id}`, { headers: { Cookie: cookie } });
  assert.equal(item.status, 200);
  const itemBody = await item.text();
  assert.match(itemBody, /<span>review<\/span><span><a href="https:\/\/github.com\/frostyard\/example\/pull\/52" rel="noreferrer noopener">PR #52<\/a> · head aaaaaaa · round 1 · <span class="ph-badge ok">pass<\/span> · author model claude-sonnet-5/);
  assert.match(itemBody, /advisories: consider renaming gate\(\)/);
  assert.match(itemBody, /<span>model<\/span><span>claude-opus-5<\/span>/);
  assert.equal(itemBody.includes("leaseToken"), false);
});

test("the item page renders the definition, artifacts with verification, operator notes, previous results, and the event timeline for a requeued-then-completed item", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-surface-item-test-"));
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
  const cookie = `snowcat_session=${sessionDigest(TOKEN)}`;
  const page = await app.request(`/items/${child.id}`, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  const body = await page.text();

  // Header: kicker with the id, h1 kind · repository, status and delivery tags, disabled ghost buttons.
  assert.match(body, new RegExp(`<div class="ph-eyebrow"><i></i>item · ${child.id}</div><h1>quality-implementation · frostyard/updex</h1>`));
  assert.match(body, /<span class="ph-badge ok">completed<\/span><span class="ph-badge ok">delivery · merged<\/span>/);
  const actions = section(body, "actions");
  assert.match(actions, /<h2>Decide<\/h2><span>as operator:web · completed<\/span>/);
  assert.match(actions, /<form class="fl-inline" method="post" action="\/repositories\/frostyard\/updex\/verify-artifacts">/);
  assert.match(actions, new RegExp(`<form class="fl-decide" method="post" action="/items/${child.id}/note"><input type="hidden" name="status" value="completed"><input type="hidden" name="updatedAt" value="[^"]+"><input type="hidden" name="return" value="/items/${child.id}">`));
  assert.equal(actions.includes("/approve"), false);

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

test("browser mutations are the CLI's operator commands as operator:web, refuse stale intent, require the session, and never leak a lease token", async () => {
  const seeded = await seededQueue();
  test.after(() => seeded.queue.close());
  const queue = seeded.queue;
  const proposed = queue.list({ status: "proposed" })[0]!;
  const blocked = queue.list({ status: "blocked" })[0]!;
  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue }) });
  const cookie = `snowcat_session=${sessionDigest(TOKEN)}`;
  const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = { Cookie: cookie }) =>
    app.request(path, { method: "POST", body: new URLSearchParams(fields), headers });
  const stale = { status: proposed.status, updatedAt: proposed.updatedAt, return: "/" };

  // No session: refused (redirected to /login) and nothing changes.
  const anonymous = await post(`/items/${proposed.id}/approve`, stale, {});
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get("Location"), "/login");
  assert.equal(queue.get(proposed.id)!.status, "proposed");

  // A cross-site post is refused before touching the store.
  const crossSite = await post(`/items/${proposed.id}/approve`, stale, { Cookie: cookie, "Sec-Fetch-Site": "cross-site" });
  assert.equal(crossSite.status, 403);
  assert.equal(queue.get(proposed.id)!.status, "proposed");
  const foreignOrigin = await post(`/items/${proposed.id}/approve`, stale, { Cookie: cookie, Origin: "https://evil.example", Host: "127.0.0.1:3000" });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(queue.get(proposed.id)!.status, "proposed");

  // Approve via POST: proposed → queued, work.approved by operator:web, redirect back with a banner.
  const approved = await post(`/items/${proposed.id}/approve`, stale, { Cookie: cookie, "Sec-Fetch-Site": "same-origin" });
  assert.equal(approved.status, 303);
  assert.equal(approved.headers.get("Location"), "/?done=work.approved");
  const afterApprove = queue.get(proposed.id)!;
  assert.equal(afterApprove.status, "queued");
  const approvedEvent = queue.events(proposed.id).at(-1)!;
  assert.equal(approvedEvent.type, "work.approved");
  assert.equal(approvedEvent.actor, "operator:web");
  const banner = await (await app.request("/?done=work.approved", { headers: { Cookie: cookie } })).text();
  assert.match(banner, /<div class="fl-banner" role="status">Recorded work\.approved\.<\/div>/);

  // The same POST replayed with the old updatedAt is refused: 409, item unchanged, no event, page says it changed.
  const eventsBefore = queue.events(proposed.id).length;
  const replay = await post(`/items/${proposed.id}/approve`, stale);
  assert.equal(replay.status, 409);
  const replayBody = await replay.text();
  assert.match(replayBody, new RegExp(`This item changed since you read it: it is now queued \\(updated ${afterApprove.updatedAt}\\)\\. Nothing was changed`));
  assert.deepEqual(queue.get(proposed.id), afterApprove);
  assert.equal(queue.events(proposed.id).length, eventsBefore);
  assert.match(replayBody, /<h1>contract-reconciliation · frostyard\/updex<\/h1>/); // the item's current state is rendered
  assert.equal(replayBody.includes(seeded.leaseToken), false);

  // Wrong-state and missing-input errors render the item page with a banner and change nothing.
  const wrongState = await post(`/items/${proposed.id}/approve`, { status: "queued", updatedAt: afterApprove.updatedAt });
  assert.equal(wrongState.status, 409);
  assert.match(await wrongState.text(), /Approve was not applied: work item is not proposed/);
  const noReason = await post(`/items/${proposed.id}/defer`, { status: "queued", updatedAt: afterApprove.updatedAt });
  assert.equal(noReason.status, 400);
  assert.match(await noReason.text(), /Defer was not applied: Enter a deferral reason\./);
  const noPrecondition = await post(`/items/${proposed.id}/defer`, { reason: "later" });
  assert.equal(noPrecondition.status, 400);
  assert.match(await noPrecondition.text(), /status is required/);
  assert.deepEqual(queue.get(proposed.id), afterApprove);

  // Requeue with note: appends the operator note, moves the block result to previousResults, records work.requeued.
  const requeued = await post(`/items/${blocked.id}/requeue`, {
    status: "blocked",
    updatedAt: blocked.updatedAt,
    reason: "Reuse the branch; the client now allows git.",
    return: `/items/${blocked.id}`,
  });
  assert.equal(requeued.status, 303);
  assert.equal(requeued.headers.get("Location"), `/items/${blocked.id}?done=work.requeued`);
  const afterRequeue = queue.get(blocked.id)!;
  assert.equal(afterRequeue.status, "queued");
  assert.equal(afterRequeue.result, undefined);
  assert.deepEqual(afterRequeue.previousResults.map((result) => result.summary), [blocked.result!.summary]);
  assert.deepEqual(
    afterRequeue.operatorNotes.map((note) => [note.actor, note.action, note.reason]),
    [["operator:web", "requeue", "Reuse the branch; the client now allows git."]],
  );
  assert.equal(queue.events(blocked.id).at(-1)!.type, "work.requeued");
  assert.equal(queue.events(blocked.id).at(-1)!.actor, "operator:web");

  // Prioritize, note, defer, cancel through their forms; each redirects with its event type.
  const prioritized = await post(`/items/${blocked.id}/prioritize`, { status: "queued", updatedAt: afterRequeue.updatedAt, priority: "7", reason: "front of line" });
  assert.equal(prioritized.headers.get("Location"), `/items/${blocked.id}?done=work.prioritized`);
  assert.equal(queue.get(blocked.id)!.priority, 7);
  const noted = await post(`/items/${blocked.id}/note`, { status: "queued", updatedAt: queue.get(blocked.id)!.updatedAt, reason: "watch the branch name" });
  assert.equal(noted.headers.get("Location"), `/items/${blocked.id}?done=work.noted`);
  const deferred = await post(`/items/${blocked.id}/defer`, { status: "queued", updatedAt: queue.get(blocked.id)!.updatedAt, reason: "hold" });
  assert.equal(deferred.headers.get("Location"), `/items/${blocked.id}?done=work.deferred`);
  assert.equal(queue.get(blocked.id)!.status, "proposed");
  const rejected = await post(`/items/${blocked.id}/reject`, { status: "proposed", updatedAt: queue.get(blocked.id)!.updatedAt, reason: "superseded", return: "https://evil.example/x" });
  assert.equal(rejected.headers.get("Location"), `/items/${blocked.id}?done=work.rejected`); // off-host return ignored
  assert.equal(queue.get(blocked.id)!.status, "cancelled");
  assert.equal(queue.events(blocked.id).at(-1)!.actor, "operator:web");

  // Unknown action and unknown item are 404s.
  assert.equal((await post(`/items/${blocked.id}/explode`, { status: "cancelled", updatedAt: "x" })).status, 404);
  assert.equal((await post(`/items/00000000-0000-0000-0000-000000000000/note`, { status: "queued", updatedAt: "2026-01-01T00:00:00.000Z", reason: "x" })).status, 404);

  // GET never mutates: the item pages and inbox are unchanged by reads.
  const snapshot = queue.list({ limit: 100 }).map((item) => [item.id, item.status, item.updatedAt]);
  await app.request(`/items/${blocked.id}`, { headers: { Cookie: cookie } });
  await app.request("/", { headers: { Cookie: cookie } });
  assert.deepEqual(queue.list({ limit: 100 }).map((item) => [item.id, item.status, item.updatedAt]), snapshot);
});

test("re-verify from the browser refreshes a repository's pending artifacts as operator:web and reports counts", async () => {
  const seeded = await seededQueue();
  test.after(() => seeded.queue.close());
  const queue = seeded.queue;
  const requests: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url.pathname);
    if (url.pathname === "/repos/frostyard/example/pulls/5") {
      return new Response(
        JSON.stringify({ number: 5, html_url: "https://github.com/frostyard/example/pull/5", state: "closed", merged: true, merged_at: "2026-08-18T01:00:00Z", closed_at: "2026-08-18T01:00:00Z", head: { sha: "abcdef0123456789abcdef0123456789abcdef01" }, base: { repo: { full_name: "frostyard/example" } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue, verifier: { fetcher, clock: () => new Date("2026-08-18T02:00:00.000Z") } }) });
  const cookie = `snowcat_session=${sessionDigest(TOKEN)}`;

  const anonymous = await app.request("/repositories/frostyard/example/verify-artifacts", { method: "POST", body: new URLSearchParams({ return: "/" }) });
  assert.equal(anonymous.status, 303);
  assert.equal(requests.length, 0);

  const verified = await app.request("/repositories/frostyard/example/verify-artifacts", { method: "POST", body: new URLSearchParams({ return: "/" }), headers: { Cookie: cookie } });
  assert.equal(verified.status, 303);
  assert.equal(verified.headers.get("Location"), "/?done=artifact.verified&detail=1+checked%2C+1+updated%2C+0+rejected%2C+0+unavailable%2C+0+cure+items+queued%2C+0+review+items+queued%2C+0+marked+ready");
  assert.deepEqual(requests, ["/repos/frostyard/example/pulls/5"]);
  const item = queue.get(seeded.unverifiedSeed.id)!;
  assert.equal(item.result!.artifacts[0]!.verification!.status, "verified");
  assert.equal(item.delivery, "merged");
  const event = queue.events(item.id).at(-1)!;
  assert.equal(event.type, "artifact.verified");
  assert.equal(event.actor, "operator:web");
  const inbox = await (await app.request(verified.headers.get("Location")!, { headers: { Cookie: cookie } })).text();
  assert.match(inbox, /Recorded artifact\.verified — 1 checked, 1 updated, 0 rejected, 0 unavailable, 0 cure items queued, 0 review items queued, 0 marked ready\./);
  assert.match(inbox, /<span>Unverified artifacts<\/span><strong>0<\/strong>/);
  assert.equal(inbox.includes(seeded.leaseToken), false);

  const missing = await app.request("/repositories/frostyard/nope/verify-artifacts", { method: "POST", body: new URLSearchParams({}), headers: { Cookie: cookie } });
  assert.equal(missing.status, 404);
});

test("attach artifact from the item page verifies against GitHub and attaches as operator:web, refuses cross-site, and shows the precondition banner when the item moved", async () => {
  const seeded = await seededQueue();
  test.after(() => seeded.queue.close());
  const queue = seeded.queue;
  const completed = queue.get(seeded.parent.id)!; // completed discovery root with no artifacts
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result!.artifacts, []);
  const requests: string[] = [];
  const answers = new Map<string, Response | (() => Response)>();
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url.pathname);
    const answer = answers.get(url.pathname);
    if (!answer) return new Response("{}", { status: 404 });
    return typeof answer === "function" ? answer() : answer;
  }) as typeof fetch;
  const merged = () =>
    new Response(
      JSON.stringify({ number: 326, html_url: "https://github.com/frostyard/updex/pull/326", state: "closed", merged: true, merged_at: "2026-08-18T13:00:00Z", closed_at: "2026-08-18T13:00:00Z", head: { sha: "0123456789abcdef0123456789abcdef01234567" }, base: { repo: { full_name: "frostyard/updex" } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  answers.set("/repos/frostyard/updex/pulls/326", merged);
  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue, verifier: { fetcher, clock: () => new Date("2026-08-18T14:00:00.000Z") } }) });
  const cookie = `snowcat_session=${sessionDigest(TOKEN)}`;
  const post = (fields: Record<string, string>, headers: Record<string, string> = { Cookie: cookie }) =>
    app.request(`/items/${completed.id}/attach-artifact`, { method: "POST", body: new URLSearchParams(fields), headers });
  const fresh = () => ({ status: "completed", updatedAt: queue.get(completed.id)!.updatedAt, return: `/items/${completed.id}` });

  // The item page offers the form only because the item is completed; the queued/proposed pages do not.
  const page = await (await app.request(`/items/${completed.id}`, { headers: { Cookie: cookie } })).text();
  assert.match(section(page, "actions"), new RegExp(`<form class="fl-decide" method="post" action="/items/${completed.id}/attach-artifact"><input type="hidden" name="status" value="completed"><input type="hidden" name="updatedAt" value="${completed.updatedAt}">`));
  assert.match(section(page, "actions"), /<input class="fl-input" type="url" name="url" placeholder="https:\/\/github\.com\/frostyard\/updex\/pull\/N, …\/issues\/N, or …\/releases\/tag\/TAG" maxlength="512" required>/);
  const proposedId = queue.list({ status: "proposed" })[0]!.id;
  const proposedPage = await (await app.request(`/items/${proposedId}`, { headers: { Cookie: cookie } })).text();
  assert.equal(proposedPage.includes("/attach-artifact"), false);

  // No session and cross-site are refused before GitHub or the store is touched.
  const anonymous = await post({ ...fresh(), url: "https://github.com/frostyard/updex/pull/326" }, {});
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get("Location"), "/login");
  const crossSite = await post({ ...fresh(), url: "https://github.com/frostyard/updex/pull/326" }, { Cookie: cookie, "Sec-Fetch-Site": "cross-site" });
  assert.equal(crossSite.status, 403);
  const foreignOrigin = await post({ ...fresh(), url: "https://github.com/frostyard/updex/pull/326" }, { Cookie: cookie, Origin: "https://evil.example", Host: "127.0.0.1:3000" });
  assert.equal(foreignOrigin.status, 403);
  assert.deepEqual(requests, []);
  assert.deepEqual(queue.get(completed.id)!.result!.artifacts, []);

  // Missing URL, a URL outside the repository, and a 404 re-render the item page with a banner and write nothing.
  const noUrl = await post(fresh());
  assert.equal(noUrl.status, 400);
  assert.match(await noUrl.text(), /Attach artifact was not applied: url is required/);
  const foreign = await post({ ...fresh(), url: "https://github.com/frostyard/lodge/pull/1" });
  assert.equal(foreign.status, 409);
  assert.match(await foreign.text(), /Attach artifact was not applied: artifact rejected: artifact pull-request URL is not a frostyard\/updex pull-request URL/);
  // GitHub answers with a different pull request than the URL names (a redirect or renumbering): rejected, nothing written.
  answers.set("/repos/frostyard/updex/pulls/999", () => new Response(JSON.stringify({ number: 998, html_url: "https://github.com/frostyard/updex/pull/998", state: "open", base: { repo: { full_name: "frostyard/updex" } } }), { status: 200 }));
  const mismatch = await post({ ...fresh(), url: "https://github.com/frostyard/updex/pull/999" });
  assert.equal(mismatch.status, 409);
  assert.match(await mismatch.text(), /Attach artifact was not applied: artifact rejected: pull-request number does not match https:\/\/github\.com\/frostyard\/updex\/pull\/999/);
  assert.deepEqual(queue.get(completed.id)!.result!.artifacts, []);
  assert.equal(queue.events(completed.id).some((event) => event.type === "artifact.attached"), false);

  // A stale precondition (the item moved after render) is refused with the "changed since you read it" banner, even though GitHub confirmed the URL.
  const rendered = fresh();
  queue.note(completed.id, "operator:cli", "PR #326 opened by hand.");
  const moved = queue.get(completed.id)!;
  assert.notEqual(moved.updatedAt, rendered.updatedAt);
  const stale = await post({ ...rendered, url: "https://github.com/frostyard/updex/pull/326" });
  assert.equal(stale.status, 409);
  const staleBody = await stale.text();
  assert.match(staleBody, new RegExp(`This item changed since you read it: it is now completed \\(updated ${moved.updatedAt}\\)\\. Nothing was changed`));
  assert.deepEqual(queue.get(completed.id)!.result!.artifacts, []);
  assert.equal(staleBody.includes(seeded.leaseToken), false);

  // The current render attaches: verified · merged, delivery merged, artifact.attached by operator:web, redirect with a banner.
  const attached = await post({ ...fresh(), url: "https://github.com/frostyard/updex/pull/326", description: "Opened by the operator from the local branch" }, { Cookie: cookie, "Sec-Fetch-Site": "same-origin" });
  assert.equal(attached.status, 303);
  assert.equal(attached.headers.get("Location"), `/items/${completed.id}?done=artifact.attached&detail=https%3A%2F%2Fgithub.com%2Ffrostyard%2Fupdex%2Fpull%2F326+merged`);
  const after = queue.get(completed.id)!;
  assert.equal(after.delivery, "merged");
  assert.deepEqual(after.result!.artifacts.map((artifact) => [artifact.kind, artifact.url, artifact.description, artifact.verification?.status]), [["pull-request", "https://github.com/frostyard/updex/pull/326", "Opened by the operator from the local branch", "verified"]]);
  const event = queue.events(completed.id).at(-1)!;
  assert.equal(event.type, "artifact.attached");
  assert.equal(event.actor, "operator:web");
  assert.deepEqual(event.payload, { url: "https://github.com/frostyard/updex/pull/326", kind: "pull-request", status: "verified", state: "merged" });
  const landed = await (await app.request(attached.headers.get("Location")!, { headers: { Cookie: cookie } })).text();
  assert.match(landed, /Recorded artifact\.attached — https:\/\/github\.com\/frostyard\/updex\/pull\/326 merged\./);
  assert.match(landed, /<span class="ph-badge ok">verified · merged<\/span><small class="fl-sub">PR #326 · head 01234567 · merged 13:00:00 · verified 14:00:00 by operator:web<\/small>/);
  assert.match(landed, /<b>artifact\.attached<\/b><span>operator:web<em class="fl-muted"> · PR #326 merged<\/em><\/span>/);
  assert.equal(landed.includes(seeded.leaseToken), false);
  assert.equal(landed.includes("leaseToken"), false);

  // The same URL again is refused; GitHub outage attaches unverified and the inbox lists it for re-verify.
  const twice = await post({ ...fresh(), url: "https://github.com/frostyard/updex/pull/326" });
  assert.equal(twice.status, 409);
  assert.match(await twice.text(), /Attach artifact was not applied: artifact already reported: https:\/\/github\.com\/frostyard\/updex\/pull\/326/);
  answers.set("/repos/frostyard/updex/issues/300", () => new Response("", { status: 503 }));
  const outage = await post({ ...fresh(), url: "https://github.com/frostyard/updex/issues/300", kind: "issue" });
  assert.equal(outage.status, 303);
  assert.equal(outage.headers.get("Location"), `/items/${completed.id}?done=artifact.attached&detail=https%3A%2F%2Fgithub.com%2Ffrostyard%2Fupdex%2Fissues%2F300+unverified`);
  const issue = queue.get(completed.id)!.result!.artifacts.at(-1)!;
  assert.equal(issue.kind, "issue");
  assert.deepEqual(issue.verification, { status: "unverified", attemptedAt: "2026-08-18T14:00:00.000Z", reason: "GitHub API returned HTTP 503" });
  assert.equal(queue.get(completed.id)!.delivery, "merged", "an unverified issue does not change delivery");
});

test("the event stream is session-guarded, starts with the cursor, and delivers new ledger events with identifying fields and no lease token", async () => {
  const seeded = await seededQueue();
  test.after(() => seeded.queue.close());
  const queue = seeded.queue;
  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue }), surfaceStream: { pollMs: 20, heartbeatMs: 60 } });
  const cookie = `snowcat_session=${sessionDigest(TOKEN)}`;

  const anonymous = await app.request("/events/stream");
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get("Location"), "/login");
  const badFilter = await app.request("/events/stream?repository=nope", { headers: { Cookie: cookie } });
  assert.equal(badFilter.status, 400);

  const response = await app.request("/events/stream", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type") ?? "", /text\/event-stream/);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: Array<{ event?: string; id?: string; data: string }> = [];
  const comments: string[] = [];
  const readUntil = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`stream timed out; frames so far: ${JSON.stringify(frames)}`);
      const { value, done } = await reader.read();
      if (done) throw new Error("stream closed early");
      buffer += decoder.decode(value, { stream: true });
      let separator = buffer.indexOf("\n\n");
      while (separator !== -1) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        if (block.startsWith(":")) comments.push(block);
        else {
          const frame: { event?: string; id?: string; data: string } = { data: "" };
          for (const line of block.split("\n")) {
            if (line.startsWith("event: ")) frame.event = line.slice(7);
            else if (line.startsWith("id: ")) frame.id = line.slice(4);
            else if (line.startsWith("data: ")) frame.data += line.slice(6);
          }
          frames.push(frame);
        }
        separator = buffer.indexOf("\n\n");
      }
    }
  };

  await readUntil(() => frames.length >= 1);
  const before = queue.metadata().lastEventSequence;
  assert.deepEqual(frames[0], { event: "cursor", data: JSON.stringify({ sequence: before }) });

  // Seed and claim after the stream is connected: both ledger events arrive, in order, with the item's fields.
  const seed = queue.enqueueSeed({
    repository: "frostyard/updex",
    kind: "ci-implementation",
    objective: "Streamed item.",
    instructions: "Do it.",
    acceptanceCriteria: ["Done."],
    allowedActions: ["read"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  const lease = queue.claim({ worker: "claude:updex:stream", repository: "frostyard/updex" })!;
  assert.equal(lease.id, seed.id);
  await readUntil(() => frames.filter((frame) => frame.event === "event").length >= 2);
  const events = frames
    .filter((frame) => frame.event === "event")
    .map((frame) => ({ id: frame.id, ...(JSON.parse(frame.data) as Record<string, unknown>) }) as Record<string, unknown>);
  // `status` is the item's current logical status when the event is read (as eventsSince reports it), so both say claimed.
  assert.deepEqual(
    events.map((event) => [event.type, event.workItemId, event.repository, event.kind, event.status, event.actor]),
    [
      ["work.queued", seed.id, "frostyard/updex", "ci-implementation", "claimed", "operator:test"],
      ["work.claimed", seed.id, "frostyard/updex", "ci-implementation", "claimed", "claude:updex:stream"],
    ],
  );
  assert.equal(events[0]!.sequence, before + 1);
  assert.equal(events[0]!.id, String(before + 1));
  assert.equal(typeof events[1]!.occurredAt, "string");
  assert.deepEqual(Object.keys(events[1]!).sort(), ["actor", "id", "kind", "occurredAt", "repository", "sequence", "status", "type", "workItemId"]);
  const raw = frames.map((frame) => frame.data).join("\n");
  assert.equal(raw.includes(lease.leaseToken!), false);
  assert.equal(raw.includes(seeded.leaseToken), false);
  assert.equal(raw.includes("leaseToken"), false);
  assert.equal(raw.includes("payload"), false);

  // Heartbeat comments keep flowing while idle; the client closing ends the loop cleanly.
  await readUntil(() => comments.some((comment) => comment.startsWith(": keep-alive")));
  await reader.cancel();

  // Repository filter: an item in another repository never reaches a filtered stream, but the cursor still comes first.
  const filtered = await app.request("/events/stream?repository=frostyard/example", { headers: { Cookie: cookie } });
  const filteredReader = filtered.body!.getReader();
  const first = decoder.decode((await filteredReader.read()).value);
  assert.match(first, /^event: cursor\n/);
  queue.note(seed.id, "operator:test", "updex only");
  const example = queue.list({ repository: "frostyard/example", status: "claimed" })[0]!;
  queue.heartbeat(example.id, seeded.leaseToken, "copilot-cli:example:four");
  let filteredText = "";
  const deadline = Date.now() + 5_000;
  while (!filteredText.includes("lease.renewed") && Date.now() < deadline) {
    filteredText += decoder.decode((await filteredReader.read()).value);
  }
  assert.match(filteredText, /"type":"lease.renewed"[^\n]*"repository":"frostyard\/example"/);
  assert.equal(filteredText.includes("updex only"), false);
  assert.equal(filteredText.includes("work.noted"), false);
  await filteredReader.cancel();
});

test("?partial= returns one inbox group or one board column as a fragment, and rejects unknown names", async () => {
  const seeded = await seededQueue();
  test.after(() => seeded.queue.close());
  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue: seeded.queue }) });
  const cookie = `snowcat_session=${sessionDigest(TOKEN)}`;

  const proposals = await app.request("/?partial=proposals", { headers: { Cookie: cookie } });
  assert.equal(proposals.status, 200);
  const fragment = await proposals.text();
  assert.match(fragment, /^<section class="fl-group" id="proposals">/);
  assert.match(fragment, /<\/section>$/);
  assert.match(fragment, /Reconcile updex with ADR-0022/);
  assert.equal(fragment.includes("<html"), false);
  assert.equal(fragment.includes("ph-sidebar"), false);
  assert.equal(fragment.includes('id="blocked"'), false);
  assert.equal(fragment.includes(seeded.leaseToken), false);
  const stats = await (await app.request("/?partial=stats", { headers: { Cookie: cookie } })).text();
  assert.match(stats, /^<div class="ph-stats" id="stats">/);
  assert.equal((await app.request("/?partial=sidebar", { headers: { Cookie: cookie } })).status, 400);
  assert.equal((await app.request("/?partial=proposals")).status, 303);

  const leased = await app.request("/repositories/frostyard/example?partial=leased", { headers: { Cookie: cookie } });
  assert.equal(leased.status, 200);
  const column = await leased.text();
  assert.match(column, /^<section class="fl-group fl-column" id="leased">/);
  assert.match(column, /security-implementation · copilot-cli:example:four/);
  assert.equal(column.includes("ph-sidebar"), false);
  assert.equal(column.includes(seeded.leaseToken), false);
  assert.equal((await app.request("/repositories/frostyard/example?partial=nope", { headers: { Cookie: cookie } })).status, 400);
});

test("board actions import labeled issues, seed dogfood, verify artifacts, and impose/clear the operator hold as operator:web behind the session", async () => {
  const { controlPlaneClaimEligibility } = await import("../src/queue/eligibility.ts");
  const directory = await mkdtemp(join(tmpdir(), "snowcat-surface-actions-test-"));
  const controlPlanePath = join(directory, "control-plane.db");
  const control = new ControlPlaneStore(controlPlanePath);
  await enrollExampleRepository(control);
  control.close();
  // A gated queue: claims consult the control plane, so a hold must stop them.
  const queue = new QueueStore(join(directory, "queue.db"), undefined, { claimEligibility: controlPlaneClaimEligibility(controlPlanePath) });
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/example", true);

  const github: Record<string, unknown> = {
    "/repos/frostyard/example/issues": [
      { number: 1, title: "First labeled issue", body: "Body one.", html_url: "https://github.com/frostyard/example/issues/1", state: "open", labels: [{ name: "snowcat" }] },
      { number: 2, title: "Second labeled issue", body: "", html_url: "https://github.com/frostyard/example/issues/2", state: "open", labels: [{ name: "snowcat" }] },
    ],
    "/repos/frostyard/example/pulls/12": {
      number: 12,
      html_url: "https://github.com/frostyard/example/pull/12",
      state: "closed",
      merged: true,
      merged_at: "2026-08-18T01:00:00Z",
      closed_at: "2026-08-18T01:00:00Z",
      head: { sha: "abcdef0123456789abcdef0123456789abcdef01" },
      base: { repo: { full_name: "frostyard/example" } },
    },
  };
  const requests: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    requests.push(url.pathname);
    const body = github[url.pathname];
    return new Response(JSON.stringify(body ?? {}), { status: body ? 200 : 404, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue, controlPlanePath, verifier: { fetcher, clock: () => new Date("2026-08-18T02:00:00.000Z") } }) });
  const cookie = `snowcat_session=${sessionDigest(TOKEN)}`;
  const post = (action: string, fields: Record<string, string> = {}, headers: Record<string, string> = { Cookie: cookie }) =>
    app.request(`/repositories/frostyard/example/${action}`, { method: "POST", body: new URLSearchParams(fields), headers });

  // Every action without the cookie is refused before doing anything.
  for (const action of ["import-issues", "seed-dogfood", "verify-artifacts", "hold", "clear-hold"]) {
    const anonymous = await post(action, { reason: "x" }, {});
    assert.equal(anonymous.status, 303, action);
    assert.equal(anonymous.headers.get("Location"), "/login");
  }
  assert.deepEqual(requests, []);
  assert.equal(queue.list({ limit: 100 }).length, 0);

  // Import issues: two proposals, banner with counts; a second import creates nothing.
  const imported = await post("import-issues", { label: "snowcat", priority: "7" });
  assert.equal(imported.status, 303);
  assert.equal(imported.headers.get("Location"), "/repositories/frostyard/example?done=work.proposed&detail=2+fetched%2C+2+created%2C+0+already+imported");
  assert.deepEqual(requests.splice(0), ["/repos/frostyard/example/issues"]);
  const proposals = queue.list({ status: "proposed", repository: "frostyard/example" });
  assert.deepEqual(proposals.map((item) => [item.kind, item.priority, item.sourceRef]).sort(), [
    ["issue-resolution", 7, "https://github.com/frostyard/example/issues/1"],
    ["issue-resolution", 7, "https://github.com/frostyard/example/issues/2"],
  ]);
  const banner = await (await app.request(imported.headers.get("Location")!, { headers: { Cookie: cookie } })).text();
  assert.match(banner, /Recorded work\.proposed — 2 fetched, 2 created, 0 already imported\./);
  const again = await post("import-issues", {});
  assert.equal(again.headers.get("Location"), "/repositories/frostyard/example?done=import.unchanged&detail=2+fetched%2C+0+created%2C+2+already+imported");
  assert.equal(queue.list({ status: "proposed", repository: "frostyard/example" }).length, 2);
  assert.deepEqual(requests.splice(0), ["/repos/frostyard/example/issues"]);
  const badPriority = await post("import-issues", { priority: "high" });
  assert.equal(badPriority.status, 400);
  assert.match(await badPriority.text(), /Import issues was not applied: priority must be an integer/);
  const inboxProposals = await (await app.request("/", { headers: { Cookie: cookie } })).text();
  assert.match(inboxProposals, /Resolve frostyard\/example#1: <span>First labeled issue<\/span>/);

  // Seed dogfood honors the Core declaration (`quality`, `ci`): two roots, then a second seed is all "active".
  const seeded = await post("seed-dogfood");
  assert.equal(seeded.status, 303);
  assert.equal(
    seeded.headers.get("Location"),
    "/repositories/frostyard/example?done=work.queued&detail=2+created+%28quality-gap-discovery%2C+ci-gap-discovery%29%2C+0+active%2C+0+cooling%2C+6+not+declared",
  );
  const roots = queue.list({ status: "queued", repository: "frostyard/example" });
  assert.equal(roots.length, 2);
  assert.deepEqual(roots.map((item) => item.kind).sort(), ["ci-gap-discovery", "quality-gap-discovery"]);
  const reseed = await post("seed-dogfood");
  assert.equal(reseed.headers.get("Location"), "/repositories/frostyard/example?done=seed.unchanged&detail=0+created%2C+2+active%2C+0+cooling%2C+6+not+declared");

  // Verify artifacts: a completed item with an open PR becomes merged and records artifact.verified by operator:web.
  const done = queue.enqueueSeed({
    repository: "frostyard/example",
    kind: "issue-resolution",
    objective: "Ship #12.",
    instructions: "Do it.",
    acceptanceCriteria: ["Done."],
    allowedActions: ["read", "open-pr"],
    delegableActions: [],
    createdBy: "operator:test",
    priority: 100,
  });
  const lease = queue.claim({ worker: "claude:example:ship", repository: "frostyard/example" })!;
  assert.equal(lease.id, done.id, "the enrolled repository is claimable before the hold");
  queue.complete({
    id: done.id,
    leaseToken: lease.leaseToken!,
    worker: "claude:example:ship",
    result: {
      summary: "Opened PR #12.",
      evidence: ["ok"],
      artifacts: [{ kind: "pull-request", url: "https://github.com/frostyard/example/pull/12", verification: { status: "verified", verifiedAt: "2026-08-18T00:00:00.000Z", number: 12, state: "open", headSha: "abcdef0123456789abcdef0123456789abcdef01" } }],
    },
    followUps: [],
  });
  const verified = await post("verify-artifacts");
  assert.equal(verified.status, 303);
  assert.equal(verified.headers.get("Location"), "/repositories/frostyard/example?done=artifact.verified&detail=1+checked%2C+1+updated%2C+0+rejected%2C+0+unavailable%2C+0+cure+items+queued%2C+0+review+items+queued%2C+0+marked+ready");
  assert.deepEqual(requests.splice(0), ["/repos/frostyard/example/pulls/12"]);
  assert.equal(queue.get(done.id)!.delivery, "merged");
  const verifiedEvent = queue.events(done.id).at(-1)!;
  assert.equal(verifiedEvent.type, "artifact.verified");
  assert.equal(verifiedEvent.actor, "operator:web");

  // Hold: the repository becomes operator-held, the badge flips, and a gated claim finds nothing.
  const claimable = queue.enqueueSeed({
    repository: "frostyard/example",
    kind: "ci-implementation",
    objective: "Held behind the hold.",
    instructions: "Do it.",
    acceptanceCriteria: ["Done."],
    allowedActions: ["read"],
    delegableActions: [],
    createdBy: "operator:test",
    priority: 200,
  });
  const noReason = await post("hold", {});
  assert.equal(noReason.status, 400);
  assert.match(await noReason.text(), /Enter a reason to hold frostyard\/example/);
  const held = await post("hold", { reason: "Incident review." });
  assert.equal(held.status, 303);
  assert.equal(held.headers.get("Location"), "/repositories/frostyard/example?done=repository.hold-imposed&detail=frostyard%2Fexample+is+now+operator-held");
  const holdStore = new ControlPlaneStore(controlPlanePath);
  const heldStatus = holdStore.repositoryStatuses()[0]!;
  assert.equal(heldStatus.effectiveState, "operator-held");
  assert.equal(heldStatus.operatorHold?.choice, "impose");
  holdStore.close();
  assert.equal(queue.claim({ worker: "claude:example:blocked", repository: "frostyard/example" }), undefined, "the hold gates claims");
  assert.equal(queue.get(claimable.id)!.status, "queued");
  const heldBoard = await (await app.request(held.headers.get("Location")!, { headers: { Cookie: cookie } })).text();
  assert.match(heldBoard, /<span class="ph-badge warn">operator-held<\/span> <span class="ph-badge danger">held<\/span>/);
  assert.match(heldBoard, /Recorded repository\.hold-imposed — frostyard\/example is now operator-held\./);
  assert.match(heldBoard, /<form class="fl-action" method="post" action="\/repositories\/frostyard\/example\/clear-hold">/);
  assert.equal(heldBoard.includes('action="/repositories/frostyard/example/hold"'), false);
  const doubleHold = await post("hold", { reason: "again" });
  assert.equal(doubleHold.status, 400);
  assert.match(await doubleHold.text(), /Hold was not applied: repository already has active operator hold/);

  // Clear: enrolled again and claimable again.
  const cleared = await post("clear-hold", { reason: "Resolved." });
  assert.equal(cleared.status, 303);
  assert.equal(cleared.headers.get("Location"), "/repositories/frostyard/example?done=repository.hold-cleared&detail=frostyard%2Fexample+is+now+enrolled");
  assert.equal(queue.claim({ worker: "claude:example:after", repository: "frostyard/example" })?.id, claimable.id);
  const clearedBoard = await (await app.request("/repositories/frostyard/example", { headers: { Cookie: cookie } })).text();
  assert.match(clearedBoard, /<span class="ph-badge ok">enrolled<\/span>/);
  assert.equal(clearedBoard.includes("held</span>"), false);
  const clearAgain = await post("clear-hold", { reason: "again" });
  assert.equal(clearAgain.status, 400);
  assert.match(await clearAgain.text(), /has no active operator hold to clear/);

  // Nothing above ever exposed a lease token.
  for (const response of [banner, inboxProposals, heldBoard, clearedBoard]) {
    assert.equal(response.includes(lease.leaseToken!), false);
    assert.equal(response.includes("leaseToken"), false);
  }
  const claimed = queue.get(claimable.id)!;
  assert.equal(clearedBoard.includes(claimed.leaseToken!), false);
});

test("hold from the board needs a control plane, and an unknown repository or action is refused", async () => {
  const seeded = await seededQueue();
  test.after(() => seeded.queue.close());
  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue: seeded.queue }) });
  const cookie = `snowcat_session=${sessionDigest(TOKEN)}`;
  const withoutControlPlane = await app.request("/repositories/frostyard/example/hold", { method: "POST", body: new URLSearchParams({ reason: "x" }), headers: { Cookie: cookie } });
  assert.equal(withoutControlPlane.status, 503);
  assert.match(await withoutControlPlane.text(), /Hold is unavailable: SNOWCAT_CONTROL_DB is not configured/);
  const board = await (await app.request("/repositories/frostyard/example", { headers: { Cookie: cookie } })).text();
  assert.match(board, /<span class="fl-action-label">Hold<\/span><small class="fl-sub">Needs SNOWCAT_CONTROL_DB\.<\/small>/);
  const unknownRepository = await app.request("/repositories/frostyard/nope/seed-dogfood", { method: "POST", body: new URLSearchParams({}), headers: { Cookie: cookie } });
  assert.equal(unknownRepository.status, 404);
  const unknownAction = await app.request("/repositories/frostyard/example/explode", { method: "POST", body: new URLSearchParams({}), headers: { Cookie: cookie } });
  assert.equal(unknownAction.status, 404);
  const crossSite = await app.request("/repositories/frostyard/example/seed-dogfood", { method: "POST", body: new URLSearchParams({}), headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" } });
  assert.equal(crossSite.status, 403);
  assert.equal(seeded.queue.list({ repository: "frostyard/example", kind: "ci-gap-discovery" }).length, 0);
});

test("the board's attempts denominator counts only completed items that could have opened a pull request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-surface-attempts-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/example", true);

  /** Seed one item, claim it, and complete it with the given artifacts, so each claim is unambiguous. */
  const seedAndComplete = (kind: string, objective: string, allowedActions: AllowedAction[], artifacts: WorkArtifact[]) => {
    const item = queue.enqueueSeed({
      repository: "frostyard/example",
      kind,
      objective,
      instructions: "Do it.",
      acceptanceCriteria: ["Done."],
      allowedActions,
      delegableActions: [],
      createdBy: "operator:test",
    });
    const lease = queue.claim({ worker: `claude:example:${kind}`, repository: "frostyard/example" })!;
    assert.equal(lease.id, item.id);
    queue.complete({
      id: item.id,
      leaseToken: lease.leaseToken!,
      worker: `claude:example:${kind}`,
      result: { summary: "Done.", evidence: ["observed"], artifacts },
      followUps: [],
    });
    return item;
  };

  // Could never merge a pull request: read-only discovery, a read/run-tests review, a proposals-only sweep.
  const discovery = seedAndComplete("quality-discovery", "Find one quality gap.", ["read", "create-followup"], []);
  seedAndComplete("ci-discovery", "Read the workflow runs.", ["read", "run-tests"], []);
  seedAndComplete("settings-drift", "Report repository settings drift.", ["read", "create-followup"], []);

  // Could deliver a pull request: one merged, one that reported none.
  const merged = seedAndComplete("issue-resolution", "Resolve frostyard/example#9.", ["read", "write", "open-pr"], [
    {
      kind: "pull-request",
      url: "https://github.com/frostyard/example/pull/12",
      verification: { status: "verified", verifiedAt: "2026-08-18T01:00:00.000Z", number: 12, state: "merged", headSha: "abcdef0123456789", mergedAt: "2026-08-18T00:59:00.000Z" },
    },
  ]);
  seedAndComplete("docs-drift-fix", "Fix the drifted doc.", ["read", "write", "open-pr"], []);

  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue }) });
  const cookie = `snowcat_session=${sessionDigest(TOKEN)}`;
  const board = await app.request("/repositories/frostyard/example", { headers: { Cookie: cookie } });
  assert.equal(board.status, 200);
  const body = await board.text();

  // Five completed items, but only the two `open-pr` items are attempts.
  assert.match(body, /<span>Completed today<\/span><strong>5<\/strong>/);
  assert.match(body, /<span>Merged \/ attempts<\/span><strong>1 \/ 2<\/strong>/);

  // The excluded items are still completed work on the board — they are only out of the denominator.
  const completed = section(body, "completed");
  assert.equal(completed.includes(discovery.id), true);
  assert.equal(completed.includes(merged.id), true);
});

test("the events page filters by repository and by operator decision, 404s an unknown repository, and never renders a lease token", async () => {
  const seeded = await seededQueue();
  test.after(() => seeded.queue.close());
  // One operator decision in the ledger: the proposed follow-up, approved.
  const proposal = seeded.queue.list({ status: "proposed" })[0]!;
  assert.equal(proposal.repository, "frostyard/updex");
  seeded.queue.approve(proposal.id, "operator:test");
  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue: seeded.queue }) });
  const cookie = `snowcat_session=${sessionDigest(TOKEN)}`;
  const read = async (path: string) => {
    const response = await app.request(path, { headers: { Cookie: cookie } });
    return { status: response.status, body: await response.text() };
  };

  // Gated like every other route.
  const anonymous = await app.request("/events");
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get("Location"), "/login");

  // Every repository, newest first, with the sidebar entry now active.
  const all = await read("/events");
  assert.equal(all.status, 200);
  assert.match(all.body, /<a class="ph-nav-link active" href="\/events"><span class="ph-nav-num">04<\/span>Events<\/a>/);
  assert.match(all.body, /<h1>Events<\/h1>/);
  const ledger = section(all.body, "events");
  const metadata = seeded.queue.metadata();
  assert.match(ledger, new RegExp(`<h2>Ledger</h2><span>\\d+ events? · since ${Math.max(0, metadata.lastEventSequence - 100)} · all repositories</span>`));
  const newest = seeded.queue.eventsSince(metadata.lastEventSequence - 1)[0]!;
  assert.equal(newest.type, "work.approved");
  const sequences = [...ledger.matchAll(/<td class="right">(\d+)<\/td>/g)].map((match) => Number(match[1]));
  assert.equal(sequences[0], newest.sequence, "newest first");
  assert.deepEqual(sequences, [...sequences].sort((left, right) => right - left));
  assert.ok(ledger.includes("frostyard/example") && ledger.includes("frostyard/updex"), "all repositories");
  assert.match(ledger, /<b>work\.claimed<\/b>/);

  // One repository: only its events, and the header names it.
  const example = await read("/events?repository=frostyard/example");
  assert.equal(example.status, 200);
  const exampleLedger = section(example.body, "events");
  assert.match(exampleLedger, /<h2>Ledger<\/h2><span>\d+ events? · since \d+ · frostyard\/example<\/span>/);
  assert.ok(exampleLedger.includes("frostyard/example"));
  assert.equal(exampleLedger.includes("frostyard/updex"), false, "the other repository's events are filtered out");
  assert.match(example.body, /<option value="frostyard\/example" selected>frostyard\/example<\/option>/);

  // Decisions only: work.approved stays, work.claimed goes.
  const decisions = await read("/events?decisions=1");
  assert.equal(decisions.status, 200);
  const decisionLedger = section(decisions.body, "events");
  assert.match(decisionLedger, /<h2>Operator decisions<\/h2><span>\d+ events? · since \d+ · all repositories · decisions only<\/span>/);
  assert.match(decisionLedger, /<b>work\.approved<\/b>/);
  assert.equal(/<b>work\.claimed<\/b>/.test(decisionLedger), false);
  assert.equal(/<b>work\.completed<\/b>/.test(decisionLedger), false);
  assert.match(decisions.body, /<input type="checkbox" name="decisions" value="1" checked>/);

  // Both filters at once, and the combination the board header links to.
  const combined = await read("/events?repository=frostyard/updex&decisions=1");
  assert.equal(combined.status, 200);
  assert.match(section(combined.body, "events"), /<b>work\.approved<\/b>/);
  const board = await read("/repositories/frostyard/updex");
  assert.match(board.body, /<a class="ph-button secondary" href="\/events\?repository=frostyard%2Fupdex">Events<\/a>/);

  // An unknown or malformed repository is the 404-in-shell page, not a 500.
  for (const path of ["/events?repository=frostyard/nope", "/events?repository=not-a-slug", "/events?repository=a%2Fb%2Fc"]) {
    const missing = await read(path);
    assert.equal(missing.status, 404, path);
    assert.match(missing.body, /<aside class="ph-sidebar">/, path);
    assert.match(missing.body, /<h1>Not found<\/h1>/, path);
  }

  // `since` narrows the window; a junk value falls back to the default.
  const narrowed = await read(`/events?since=${metadata.lastEventSequence - 2}`);
  assert.equal(narrowed.status, 200);
  assert.equal([...section(narrowed.body, "events").matchAll(/<td class="right">(\d+)<\/td>/g)].length, 2);
  const junk = await read("/events?since=banana");
  assert.equal(junk.status, 200);
  assert.match(section(junk.body, "events"), new RegExp(`since ${Math.max(0, metadata.lastEventSequence - 100)} ·`));

  // Read-only: no POST form, no lease token, nothing loaded from elsewhere.
  for (const body of [all.body, example.body, decisions.body, combined.body]) {
    assert.equal(/method="post"/.test(body.replace(/<form class="fl-logout" method="post"/g, "")), false);
    assert.equal(body.includes(seeded.leaseToken), false);
    assert.equal(body.includes("leaseToken"), false);
    assert.equal(/<script[^>]*src=/.test(body), false);
  }
});

test("the events page names the highest sequence a capped read reached, calls the hidden events newer, and drops the notice when the window is read whole", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-surface-cap-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/example", true);
  // A ledger well past the 500-event cap: one `work.queued` event per seed.
  let newest: { id: string } | undefined;
  for (let index = 0; index < 700; index += 1) {
    newest = queue.enqueueSeed({
      repository: "frostyard/example",
      kind: "issue-resolution",
      objective: `Resolve frostyard/example#${index + 1}: seeded for the cap test.`,
      instructions: "Read only.",
      acceptanceCriteria: ["Done."],
      allowedActions: ["read"],
      delegableActions: [],
      createdBy: "operator:test",
    });
  }
  // One operator decision inside the newest 500 sequences, so the decisions view has a row.
  queue.note(newest!.id, "operator:test", "Seen by the operator.");
  const metadata = queue.metadata();
  assert.equal(metadata.lastEventSequence, 701);

  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue }) });
  const cookie = `snowcat_session=${sessionDigest(TOKEN)}`;
  const read = async (path: string) => {
    const response = await app.request(path, { headers: { Cookie: cookie } });
    return { status: response.status, body: await response.text() };
  };

  // `?since=0` fills the cap 201 events short of the cursor: the read is
  // ascending, so what is hidden is the NEWER end of the window. The notice
  // names the highest sequence actually read and links onward from it.
  const widened = await read("/events?since=0");
  assert.equal(widened.status, 200);
  const sequences = [...section(widened.body, "events").matchAll(/<td class="right">(\d+)<\/td>/g)].map((match) => Number(match[1]));
  assert.equal(sequences.length, 500);
  assert.equal(sequences[0], 500, "newest first within the read");
  assert.equal(sequences.at(-1), 1);
  assert.match(
    widened.body,
    /This read filled the 500-event cap at sequence 500, so events <b>newer<\/b> than sequence 500 — up to the cursor at 701 — are not shown\./,
  );
  assert.match(widened.body, /<a href="\/events\?since=500">Continue from sequence 500<\/a>/);
  assert.equal(/older than sequence/.test(widened.body), false, "the hidden events are newer, not older");

  // Following that link reaches the events the first read hid.
  const continued = await read("/events?since=500");
  assert.equal(continued.status, 200);
  const continuedSequences = [...section(continued.body, "events").matchAll(/<td class="right">(\d+)<\/td>/g)].map((match) => Number(match[1]));
  assert.equal(continuedSequences[0], 701);
  assert.equal(continuedSequences.at(-1), 501);
  assert.equal(continued.body.includes("-event cap"), false, "the rest of the ledger fits under the cap");

  // The decisions default window is the last 500 events: the read fills the cap
  // exactly at the cursor, so nothing of the window is hidden and there is no
  // cap notice at all.
  const decisionsOnly = await read("/events?decisions=1");
  assert.equal(decisionsOnly.status, 200);
  const decisionLedger = section(decisionsOnly.body, "events");
  assert.match(decisionLedger, new RegExp(`since ${metadata.lastEventSequence - 500} ·`));
  assert.match(decisionLedger, /<b>work\.noted<\/b>/);
  assert.equal(decisionsOnly.body.includes("-event cap"), false, "the whole window was read, so it is not capped");
});
