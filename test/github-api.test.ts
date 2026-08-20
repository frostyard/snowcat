import assert from "node:assert/strict";
import test from "node:test";

import { githubApiJson, githubGraphql, type GitHubFetch } from "../src/repository/github-api.ts";

const MAX_RESPONSE_BYTES = 1_048_576;
const signal = new AbortController().signal;

test("GitHub JSON reads cancel an omitted-length response as soon as it exceeds the byte limit", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES));
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetcher = (async () => new Response(body, { status: 200 })) as GitHubFetch;

  const result = await githubApiJson("/repos/frostyard/snowcat", signal, fetcher);

  assert.deepEqual(result, { kind: "unavailable" });
  assert.equal(cancelled, true);
});

test("GitHub JSON reads fail closed on malformed or oversized Content-Length", async () => {
  for (const declaredLength of ["-1", "1.5", "01", "not-a-number", "9007199254740992", "1048577"]) {
    const fetcher = (async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": declaredLength },
      })) as GitHubFetch;

    assert.deepEqual(
      await githubApiJson("/repos/frostyard/snowcat", signal, fetcher),
      { kind: "unavailable" },
      declaredLength,
    );
  }
});

test("GitHub GraphQL accepts valid JSON whose body is exactly at the byte limit", async () => {
  const prefix = '{"data":{"repository":null}}';
  const body = new TextEncoder().encode(prefix + " ".repeat(MAX_RESPONSE_BYTES - Buffer.byteLength(prefix)));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const split = Math.floor(body.byteLength / 2);
      controller.enqueue(body.subarray(0, split));
      controller.enqueue(body.subarray(split));
      controller.close();
    },
  });
  const fetcher = (async () =>
    new Response(stream, {
      status: 200,
      headers: { "content-length": String(MAX_RESPONSE_BYTES) },
    })) as GitHubFetch;

  assert.deepEqual(
    await githubGraphql("query { viewer { login } }", {}, signal, fetcher),
    { kind: "response", status: 200, value: { data: { repository: null } } },
  );
});
