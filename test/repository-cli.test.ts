import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { childEnvironment } from "./helpers/child-environment.ts";

// src/repository/cli.ts is an executable entrypoint that dispatches on
// process.argv at module top level, so it cannot be imported in-process safely.
// Its sibling CLIs (control/cli.ts, queue/cli.ts, core/cli.ts) are measured for
// coverage by being spawned as subprocesses (node --test propagates coverage to
// children); this test does the same for repository/cli.ts so it is not absent
// from the coverage denominator. It runs read-only against a throwaway control
// database.
function repositoryRunner(controlDbPath: string) {
  const env = childEnvironment({ SNOWCAT_CONTROL_DB: controlDbPath });
  return (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/repository/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env,
    });
}

test("the local repository CLI reports statuses and rejects unknown commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-repository-cli-test-"));
  const run = repositoryRunner(join(directory, "control-plane.db"));

  const status = run("status");
  assert.equal(status.status, 0, `status stderr: ${status.stderr}`);
  const statuses = JSON.parse(status.stdout);
  assert.ok(Array.isArray(statuses));

  const unknown = run("frobnicate");
  assert.notEqual(unknown.status, 0);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /Usage: /);
});
