import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.ts";

test("the optional Flue app fails closed and does not expose queue counts", async () => {
  const configured = createApp({ appToken: "test-app-token" });

  const missing = await configured.request("/agents/queue-clerk");
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get("WWW-Authenticate"), "Bearer");

  const wrong = await configured.request("/agents/queue-clerk", {
    headers: { Authorization: "Bearer wrong-token" },
  });
  assert.equal(wrong.status, 401);

  const allowed = await configured.request("/agents/queue-clerk", {
    headers: { Authorization: "Bearer test-app-token" },
  });
  assert.notEqual(allowed.status, 401);
  assert.notEqual(allowed.status, 503);

  const disabled = createApp({ appToken: undefined });
  const unavailable = await disabled.request("/agents/queue-clerk", {
    headers: { Authorization: "Bearer test-app-token" },
  });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: "SNOWCAT_APP_TOKEN is not configured" });

  const health = await configured.request("/health");
  assert.equal(health.status, 200);
  const healthBody = (await health.json()) as Record<string, unknown>;
  assert.deepEqual(healthBody, { status: "ok" });
  assert.equal("queue" in healthBody, false);
});
