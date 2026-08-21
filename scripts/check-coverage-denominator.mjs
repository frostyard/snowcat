#!/usr/bin/env node
// Fails when a production module under src/**/*.ts is absent from the coverage
// denominator — neither measured in the coverage report nor in the documented
// exclude list below.
//
// Why this exists: Node's --experimental-test-coverage measures a file only
// when it is loaded during the run. --test-coverage-include='src/**/*.ts' does
// NOT force-include a module that no test ever imports, so such a module drops
// out of the coverage denominator entirely and the aggregate/per-file floors
// are silently computed over an incomplete population. src/db.ts (the Flue
// persistence adapter, loaded in production via the virtual:flue/db convention)
// hit exactly this: it was absent from the report while every other src module
// appeared. A dedicated test now imports it (test/db.test.ts), and this guard
// makes sure a future orphaned module cannot repeat the disappearance unnoticed.
//
// It parses coverage/report.txt (the same Node spec-reporter table
// test:coverage writes and check-coverage-floors.mjs reads), so it adds no
// extra test run and never disagrees with Node's own file list.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPORT = "coverage/report.txt";

// Production src modules that are deliberately NOT in the coverage denominator.
// Every entry needs a reason. Keep this empty unless a module genuinely cannot
// be loaded by a test; prefer a minimal import test (see test/db.test.ts) so
// the AGENTS.md invariant — "a production module that no test imports
// contributes zero coverage rather than disappearing from the denominator" —
// actually holds.
const EXCLUDED = new Map([
  // path -> reason
]);

let report;
try {
  report = readFileSync(REPORT, "utf8");
} catch {
  console.error(
    `check-coverage-denominator: ${REPORT} is missing; run \`npm run test:coverage\` first ` +
      "(it writes the report this check parses).",
  );
  process.exit(1);
}

// Rebuild each measured file's path from the reporter's indent tree, the same
// way check-coverage-floors.mjs does. Directory rows leave the metric columns
// blank; file rows carry "| lines | branches | functions |".
const rowRE = /\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|/;
const measured = new Set(); // "src/<...>/<file>.ts"
const stack = []; // { indent, name }
for (const raw of report.split("\n")) {
  const line = raw.replace(/^\u2139\s/, "");
  const bar = line.indexOf("|");
  if (bar < 0) continue;
  const namePart = line.slice(0, bar);
  const name = namePart.trim();
  if (name === "" || name === "file" || name === "all files") continue;
  const metrics = line.slice(bar).match(rowRE);
  if (!metrics) continue;
  const indent = namePart.length - namePart.trimStart().length;
  while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
  const isFile = metrics[1] !== ""; // directory rows leave the columns blank
  if (isFile) {
    measured.add([...stack.map((s) => s.name), name].join("/"));
  } else {
    stack.push({ indent, name });
  }
}

// Enumerate the production modules the coverage include glob ('src/**/*.ts')
// covers. There are no *.test.ts files under src/ (tests live in test/), so
// every src/**/*.ts is production code.
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(relative(".", full).split(sep).join("/"));
  }
  return out;
}
const srcFiles = walk("src");

const missing = [];
for (const file of srcFiles) {
  if (measured.has(file)) continue;
  if (EXCLUDED.has(file)) continue;
  missing.push(file);
}

if (missing.length > 0) {
  console.error("check-coverage-denominator: production module(s) absent from the coverage denominator:");
  for (const file of missing) console.error(`  - ${file}`);
  console.error(
    "Each src/**/*.ts module must be loaded by at least one test (add a minimal import test, " +
      "as test/db.test.ts does) so it is counted, or be listed with a reason in EXCLUDED in " +
      "scripts/check-coverage-denominator.mjs. A silently absent module makes the coverage floors " +
      "meaningless for that file.",
  );
  process.exit(1);
}

console.log(
  `check-coverage-denominator: all ${srcFiles.length} src module(s) are in the coverage denominator` +
    (EXCLUDED.size > 0 ? ` (${EXCLUDED.size} explicitly excluded)` : ""),
);
