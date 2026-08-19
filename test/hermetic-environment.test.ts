import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlPlaneStore } from "../src/control/store.ts";
import { childEnvironment } from "./helpers/child-environment.ts";

// The suite must give the same answer on a configured operator host as in
// CI: every child process a test starts goes through childEnvironment(),
// which drops the ambient SNOWCAT_*/FLUENT_*/FLUE_* variables. This test
// keeps it that way. It runs the two suites that spawn the most children
// (the operator CLI and the MCP boundary) as a child test run — an explicit
// file list, never the glob, so it does not recurse — under a poisoned
// environment: a real control-plane database it created itself, a queue
// path, and bogus tokens. If any test leaks the ambient environment into a
// child again, that child sees the poison and this test goes red in CI,
// where no SNOWCAT_* is set at all.
test("the CLI and MCP suites pass under a poisoned ambient SNOWCAT_* environment", { timeout: 300_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-hermetic-env-test-"));
  const controlPath = join(directory, "control-plane.db");
  new ControlPlaneStore(controlPath).close();

  const poison = childEnvironment({
    // Node's test runner marks its own child processes; a nested `--test`
    // that inherits the mark reports to a parent that is not there and prints
    // nothing, so drop it and let the child run as a fresh top-level runner.
    NODE_TEST_CONTEXT: undefined,
    SNOWCAT_CONTROL_DB: controlPath,
    SNOWCAT_QUEUE_DB: join(directory, "queue.db"),
    SNOWCAT_GITHUB_TOKEN: "poisoned-token",
    SNOWCAT_APP_TOKEN: "poisoned-app",
  });
  const child = spawnSync(process.execPath, ["--import", "tsx", "--test", "test/mcp.test.ts", "test/cli.test.ts"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: poison,
    maxBuffer: 64 * 1024 * 1024,
  });

  const summary = child.stdout.split("\n").filter((line) => /^ℹ (tests|pass|fail) /.test(line)).join(" ");
  assert.equal(
    child.status,
    0,
    `child test run failed under the poisoned environment (${summary})\n${child.stdout.split("\n").filter((line) => line.startsWith("✖")).join("\n")}\n${child.stderr}`,
  );
  assert.match(child.stdout, /^ℹ fail 0$/m, `child test run reported failures (${summary})`);
});
