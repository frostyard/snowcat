import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};

function coverageCommand(): string {
  const command = manifest.scripts?.["test:coverage"];
  assert.ok(typeof command === "string", "package.json must define scripts.test:coverage");
  return command;
}

function optionValues(command: string, option: string): string[] {
  const pattern = new RegExp(`(?:^|\\s)--${option}=(?:'([^']*)'|"([^"]*)"|(\\S+))`, "g");
  return Array.from(command.matchAll(pattern), (match) => match[1] ?? match[2] ?? match[3]!);
}

test("test:coverage keeps production sources in scope and test sources out", () => {
  const command = coverageCommand();

  assert.deepEqual(optionValues(command, "test-coverage-include"), ["src/**/*.ts"]);
  assert.ok(
    optionValues(command, "test-coverage-exclude").includes("test/**/*.ts"),
    "test:coverage must exclude test/**/*.ts",
  );
});

test("test:coverage does not lower the production coverage floors", () => {
  const command = coverageCommand();
  const minimums = {
    "test-coverage-lines": 51,
    "test-coverage-branches": 71,
    "test-coverage-functions": 45,
  };

  for (const [option, minimum] of Object.entries(minimums)) {
    const values = optionValues(command, option);
    assert.equal(values.length, 1, `test:coverage must set --${option} exactly once`);
    const actual = Number(values[0]);
    assert.ok(Number.isFinite(actual) && actual >= minimum, `--${option} must be at least ${minimum}, got ${values[0]}`);
  }
});
