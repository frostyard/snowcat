/**
 * Preload for CLI tests (`node --import tsx --import ./test/helpers/fake-github-fetch.ts …`):
 * replaces the global `fetch` with one that answers from the JSON fixture named
 * by `FLUENT_TEST_FAKE_GITHUB` — a map from request pathname to
 * `{ status, body }` — and appends every requested pathname to the file named
 * by `FLUENT_TEST_FAKE_GITHUB_LOG`. Unlisted paths answer 404. Test-only: the
 * production CLI never loads this module.
 */
import { appendFileSync, readFileSync } from "node:fs";

interface FakeAnswer {
  status: number;
  body?: unknown;
}

const fixturePath = process.env.FLUENT_TEST_FAKE_GITHUB;
if (!fixturePath) throw new Error("FLUENT_TEST_FAKE_GITHUB must name the fixture file");
const answers = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, FakeAnswer>;
const logPath = process.env.FLUENT_TEST_FAKE_GITHUB_LOG;

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (logPath) appendFileSync(logPath, `${url.pathname}\n`);
  const answer = answers[url.pathname];
  if (!answer) return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
  return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), {
    status: answer.status,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;
