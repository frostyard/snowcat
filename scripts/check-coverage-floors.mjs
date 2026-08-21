#!/usr/bin/env node
// Enforces a per-file coverage floor for the SQLite persistence modules on top
// of the aggregate floors in `test:coverage`.
//
// Node's --experimental-test-coverage thresholds
// (--test-coverage-lines/-branches/-functions) are AGGREGATE-only: a green
// "all files" number lets a large, weakly covered file hide behind many small,
// well-covered ones. The two store modules are the most safety-critical code
// in the repo (the control-plane and queue SQLite state) yet the least
// covered, so a regression in them would not move the aggregate enough to trip
// the gate. This check pins a line/function floor for each of them.
//
// It parses the machine-readable coverage report that `test:coverage` writes to
// coverage/report.txt (Node's own spec-reporter table — the same numbers the
// aggregate floor enforces), so it adds no extra test run and never disagrees
// with Node's computation. Floors are a ratchet at (just below) current
// coverage; raise them when coverage improves, never lower them.
import { readFileSync } from "node:fs";

const REPORT = "coverage/report.txt";

// Node's experimental coverage engine produces materially different per-file
// measurements across supported major versions. Ratchet each CI runtime to its
// own observed main baseline rather than making one runtime fail unchanged code
// or weakening the stronger runtime's floor.
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
const FLOOR_PROFILES = {
  // Node 24: control 27.15%/2.37%, queue 52.66%/17.14%.
  24: {
    "src/control/store.ts": { lines: 27, functions: 2 },
    "src/queue/store.ts": { lines: 52, functions: 17 },
  },
  // Node 26: control varies by environment from 27.15%/2.37% to
  // 32.50%/20.81%; ratchet to the lower unchanged-code baseline. Queue is
  // stable at 52.66%/17.14%.
  26: {
    "src/control/store.ts": { lines: 27, functions: 2 },
    "src/queue/store.ts": { lines: 52, functions: 17 },
  },
};
const FLOORS = FLOOR_PROFILES[NODE_MAJOR];
if (!FLOORS) {
  console.error(`check-coverage-floors: no per-file coverage profile for Node ${NODE_MAJOR}`);
  process.exit(1);
}

let report;
try {
  report = readFileSync(REPORT, "utf8");
} catch {
  console.error(
    `check-coverage-floors: ${REPORT} is missing; run \`npm run test:coverage\` first ` +
      "(it writes the report the check parses).",
  );
  process.exit(1);
}

// Node prints the coverage summary as an indented tree: a directory row carries
// blank metric columns, a file row carries "| lines | branches | functions |".
// Rebuild each file's full path from an indent stack so the two store.ts rows
// (control/ and queue/) are told apart.
const rowRE = /\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|/;
const measured = new Map(); // "src/<dir>/<file>" -> { lines, functions }
const stack = []; // { indent, name }

for (const raw of report.split("\n")) {
  const line = raw.replace(/^\u2139\s/, ""); // strip the "ℹ " reporter prefix
  const bar = line.indexOf("|");
  if (bar < 0) continue;
  const namePart = line.slice(0, bar);
  const name = namePart.trim();
  if (name === "" || name === "file" || name === "all files") continue;
  const metrics = line.slice(bar).match(rowRE);
  if (!metrics) continue;

  const indent = namePart.length - namePart.trimStart().length;
  while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();

  const [, linesPct, , functionsPct] = metrics;
  const isFile = linesPct !== ""; // directory rows leave the columns blank
  if (isFile) {
    // The tree root is the include base (src/), shown as the outermost node, so
    // the stack already carries "src"; join it with the file name directly.
    const path = [...stack.map((s) => s.name), name].join("/");
    measured.set(path, { lines: Number(linesPct), functions: Number(functionsPct) });
  } else {
    stack.push({ indent, name });
  }
}

const failures = [];
for (const [path, floor] of Object.entries(FLOORS)) {
  const got = measured.get(path);
  if (!got) {
    failures.push(`${path}: no coverage row found in ${REPORT} (did the file move or leave the include set?)`);
    continue;
  }
  if (got.lines < floor.lines) {
    failures.push(`${path}: line coverage ${got.lines}% is below the floor ${floor.lines}%`);
  }
  if (got.functions < floor.functions) {
    failures.push(`${path}: function coverage ${got.functions}% is below the floor ${floor.functions}%`);
  }
}

if (failures.length > 0) {
  console.error("check-coverage-floors: per-file coverage floor(s) not met:");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "Add tests for the affected store module, or — only if the floor is genuinely wrong — adjust it in scripts/check-coverage-floors.mjs.",
  );
  process.exit(1);
}

const summary = Object.entries(FLOORS)
  .map(([path, floor]) => {
    const got = measured.get(path);
    return `${path} lines ${got.lines}%≥${floor.lines}% funcs ${got.functions}%≥${floor.functions}%`;
  })
  .join("; ");
console.log(
  `check-coverage-floors: Node ${NODE_MAJOR} per-file floor(s) met — ${summary}`,
);
