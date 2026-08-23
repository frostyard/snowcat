import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const checker = fileURLToPath(new URL("../scripts/check-coverage-floors.mjs", import.meta.url));
const nodeMajor = Number(process.versions.node.split(".")[0]);

const profiles: Record<number, { control: { lines: number; functions: number }; queue: { lines: number; functions: number } }> = {
  24: { control: { lines: 30, functions: 18 }, queue: { lines: 52, functions: 17 } },
  26: { control: { lines: 27, functions: 2 }, queue: { lines: 52, functions: 17 } },
};

function report(control: { lines: number; functions: number }, queue: { lines: number; functions: number }): string {
  return [
    "ℹ file       | line % | branch % | funcs % | uncovered lines",
    "ℹ src        |        |          |         |",
    "ℹ  control   |        |          |         |",
    `ℹ   store.ts | ${control.lines.toFixed(2)} | 0.00 | ${control.functions.toFixed(2)} |`,
    "ℹ  queue     |        |          |         |",
    `ℹ   store.ts | ${queue.lines.toFixed(2)} | 0.00 | ${queue.functions.toFixed(2)} |`,
    "",
  ].join("\n");
}

function runChecker(contents: string) {
  const directory = mkdtempSync(join(tmpdir(), "snowcat-coverage-floors-"));
  mkdirSync(join(directory, "coverage"));
  writeFileSync(join(directory, "coverage", "report.txt"), contents);
  const result = spawnSync(process.execPath, [checker], { cwd: directory, encoding: "utf8" });
  rmSync(directory, { recursive: true, force: true });
  return result;
}

test("the coverage checker applies the current Node major's ratchet", () => {
  const profile = profiles[nodeMajor];
  assert.ok(profile, `test needs a coverage-floor profile for Node ${nodeMajor}`);

  const result = runChecker(report(profile.control, profile.queue));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Node ${nodeMajor} per-file floor`));
});

test("the current Node major's ratchet fails a below-floor store report", () => {
  const profile = profiles[nodeMajor];
  assert.ok(profile, `test needs a coverage-floor profile for Node ${nodeMajor}`);

  const result = runChecker(
    report({ lines: profile.control.lines - 0.01, functions: profile.control.functions }, profile.queue),
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /src\/control\/store\.ts: line coverage .* is below the floor/);
});
