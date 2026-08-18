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
  assert.match(blocked, /<strong>quality-implementation<\/strong>/);
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
  assert.match(firstEvent, /<b>work\.claimed<\/b><span title="[^"]+">security-implementation<\/span>/);

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
  assert.match(body, /<span class="fl-repo" title="enrolled"><span class="ok"><\/span>frostyard\/example<\/span>/);
  assert.match(body, /<td>frostyard\/updex<small class="fl-sub">not in control plane<\/small><\/td>/);
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
  const match = new RegExp(`<(?:section|aside) class="fl-group" id="${id}">.*?</(?:section|aside)>`, "s").exec(body);
  assert.ok(match, `section ${id} present`);
  return match[0];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
