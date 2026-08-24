import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.ts";
import { AccessVerifier, accessConfigFromEnvironment } from "../src/auth/access.ts";
import { QueueStore } from "../src/queue/store.ts";

const TEAM = "https://frostyard.cloudflareaccess.com";
const AUD = "a".repeat(64);
const now = () => new Date("2026-08-18T23:30:00.000Z");
const nowSeconds = Math.floor(now().getTime() / 1000);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { privateKey: otherKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
const CERTS = { keys: [{ kty: "RSA", kid: "key-1", alg: "RS256", use: "sig", n: jwk.n, e: jwk.e }] };

function jwt(claims: Record<string, unknown>, options: { kid?: string; key?: typeof privateKey; alg?: string } = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: options.alg ?? "RS256", kid: options.kid ?? "key-1", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: TEAM, aud: [AUD], iat: nowSeconds - 60, exp: nowSeconds + 3600, sub: "user-1", email: "Brian@Frostyard.org", ...claims })).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(options.key ?? privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function certsFetcher(status = 200, body: unknown = CERTS) {
  const calls: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, calls };
}

test("the Access verifier accepts a well-formed assertion from the team's key and refuses everything else", async () => {
  const { fetcher, calls } = certsFetcher();
  const verifier = new AccessVerifier({ teamDomain: TEAM, audience: AUD, fetcher, clock: now });
  const identity = await verifier.verify(jwt({}));
  assert.deepEqual(identity, { email: "brian@frostyard.org", subject: "user-1", issuedAt: nowSeconds - 60, expiresAt: nowSeconds + 3600 });
  assert.deepEqual(calls, [`${TEAM}/cdn-cgi/access/certs`]);
  await verifier.verify(jwt({}));
  assert.equal(calls.length, 1, "keys are cached");

  assert.equal(await verifier.verify(undefined), undefined);
  assert.equal(await verifier.verify("not.a.jwt.at.all"), undefined);
  assert.equal(await verifier.verify(jwt({}, { key: otherKey })), undefined, "wrong key");
  assert.equal(await verifier.verify(jwt({}, { alg: "HS256" })), undefined, "wrong alg");
  assert.equal(await verifier.verify(jwt({ iss: "https://evil.cloudflareaccess.com" })), undefined, "wrong issuer");
  assert.equal(await verifier.verify(jwt({ aud: ["b".repeat(64)] })), undefined, "wrong audience");
  assert.equal(await verifier.verify(jwt({ exp: nowSeconds - 1 })), undefined, "expired");
  assert.equal(await verifier.verify(jwt({ email: undefined })), undefined, "no email");
  assert.equal(await verifier.verify(jwt({}, { kid: "key-2" })), undefined, "unknown kid refreshes once and still fails closed");
  assert.equal(calls.length, 2);

  // Header first, cookie second.
  assert.equal(AccessVerifier.presented(new Headers({ "Cf-Access-Jwt-Assertion": "abc" })), "abc");
  assert.equal(AccessVerifier.presented(new Headers({ Cookie: "x=1; CF_Authorization=def; y=2" })), "def");
  assert.equal(AccessVerifier.presented(new Headers()), undefined);

  // Configuration guards.
  assert.throws(() => new AccessVerifier({ teamDomain: "https://example.com", audience: AUD }), /cloudflareaccess/);
  assert.throws(() => new AccessVerifier({ teamDomain: TEAM, audience: "short" }), /audience/);
  assert.equal(accessConfigFromEnvironment({}), undefined);
  assert.throws(() => accessConfigFromEnvironment({ SNOWCAT_ACCESS_TEAM_DOMAIN: TEAM }), /together/);
  assert.deepEqual(accessConfigFromEnvironment({ SNOWCAT_ACCESS_TEAM_DOMAIN: TEAM, SNOWCAT_ACCESS_AUD: AUD }), { teamDomain: TEAM, audience: AUD });
});

test("behind Access the surface needs an assertion, attributes mutations to member:<email>, and mints tokens for that member", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-access-surface-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/example", true);
  const proposal = queue.enqueueProposedRoots("frostyard/example", [
    { sourceRef: "https://github.com/frostyard/example/issues/1", kind: "issue-resolution", objective: "Resolve #1", instructions: "Do it.", acceptanceCriteria: ["PR open."], allowedActions: ["read", "write", "open-pr"], delegableActions: [], requiredArtifact: "pull-request", executionTarget: "new-pull-request", createdBy: "operator:test" },
  ]).created[0]!;
  const verifier = new AccessVerifier({ teamDomain: TEAM, audience: AUD, fetcher: certsFetcher().fetcher, clock: now });
  const app = createApp({ access: verifier, surfaceStores: () => ({ queue }) });

  // No assertion: 401, and never a token login page; login redirects home; logout goes to Access.
  const anonymous = await app.request("/");
  assert.equal(anonymous.status, 401);
  assert.match(await anonymous.text(), /valid Cloudflare Access assertion/);
  assert.equal((await app.request("/login")).status, 303);
  const logout = await app.request("/logout", { method: "POST" });
  assert.equal(logout.headers.get("Location"), `${TEAM}/cdn-cgi/access/logout`);

  // With an assertion: the inbox renders and the chrome names the member.
  const headers = { "Cf-Access-Jwt-Assertion": jwt({}) };
  const inbox = await app.request("/", { headers });
  assert.equal(inbox.status, 200);
  assert.match(await inbox.text(), /member:brian@frostyard\.org/);

  // A decision is attributed to the member.
  const item = queue.get(proposal.id)!;
  const approve = await app.request(`/items/${proposal.id}/approve`, {
    method: "POST",
    headers: { ...headers, "Sec-Fetch-Site": "same-origin" },
    body: new URLSearchParams({ status: item.status, updatedAt: item.updatedAt, return: "/" }),
  });
  assert.equal(approve.status, 303, await approve.text());
  assert.equal(queue.events(proposal.id).find((event) => event.type === "work.approved")?.actor, "member:brian@frostyard.org");

  // Tokens: mint for the member, plaintext shown once, then listed without it; revoke.
  const minted = await app.request("/tokens/mint", { method: "POST", headers: { ...headers, "Sec-Fetch-Site": "same-origin" }, body: new URLSearchParams({ client: "codex on the laptop" }) });
  assert.equal(minted.status, 200);
  const mintedHtml = await minted.text();
  const token = /snowcat_[0-9a-f]{16}_[A-Za-z0-9_-]+/.exec(mintedHtml)?.[0];
  assert.ok(token, "the plaintext token is shown once");
  assert.equal(queue.verifyMcpToken(token!)?.owner, "member:brian@frostyard.org");
  const list = await (await app.request("/tokens", { headers })).text();
  assert.match(list, /codex on the laptop/);
  assert.doesNotMatch(list, new RegExp(token!.slice(-12)), "the plaintext is not shown again");
  const id = queue.listMcpTokens("member:brian@frostyard.org")[0]!.id;
  const revoke = await app.request(`/tokens/${id}/revoke`, { method: "POST", headers: { ...headers, "Sec-Fetch-Site": "same-origin" } });
  assert.equal(revoke.status, 200);
  assert.equal(queue.verifyMcpToken(token!), undefined);
  assert.equal(queue.listMcpTokens()[0]!.revokedBy, "member:brian@frostyard.org");

  // Another member does not see or revoke this member's tokens.
  const other = { "Cf-Access-Jwt-Assertion": jwt({ email: "someone@frostyard.org", sub: "user-2" }) };
  assert.doesNotMatch(await (await app.request("/tokens", { headers: other })).text(), /codex on the laptop/);
});

test("in local mode the surface still uses the token session, attributes to operator:web, and lists tokens without minting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-local-surface-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.mintMcpToken({ owner: "member:me@frostyard.org", client: "cli-minted" });
  queue.mintMcpToken({ owner: "member:me@frostyard.org", client: "cli-reviewer", kinds: ["pr-review"] });
  const app = createApp({ appToken: "local-token", surfaceStores: () => ({ queue }) });
  const login = await app.request("/login", { method: "POST", body: new URLSearchParams({ token: "local-token" }) });
  const cookie = login.headers.get("Set-Cookie")!.split(";")[0]!;
  const tokens = await (await app.request("/tokens", { headers: { Cookie: cookie } })).text();
  assert.match(tokens, /cli-minted/);
  // The claim restriction (schema rung 9) is visible on the page; a token
  // without one reads "unrestricted", and no hash is ever rendered.
  assert.match(tokens, /<th>may claim<\/th>/);
  assert.match(tokens, /<td>pr-review<\/td>/);
  assert.match(tokens, /<td>unrestricted<\/td>/);
  assert.match(tokens, /operator:web/);
  assert.match(tokens, /minting needs a signed-in member/);
  const mint = await app.request("/tokens/mint", { method: "POST", headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" }, body: new URLSearchParams({ client: "x" }) });
  assert.equal(mint.status, 403);
});
