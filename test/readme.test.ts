import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { maintenancePrograms } from "../src/queue/programs.ts";

// The README's "Try the queue" paragraph describes seed-dogfood from the
// catalog, not from a snapshot of it: it must name every program and must not
// restate one cooldown for all of them (each program has its own cadence).
test("README's seed-dogfood paragraph names every catalog program and no single cooldown", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const program of maintenancePrograms) {
    // Whole word, case-insensitive: "CI" counts for `ci`; "decision" does not.
    assert.match(readme, new RegExp(`\\b${program.id}\\b`, "i"), `README.md does not name the ${program.id} program`);
  }
  assert.doesNotMatch(readme, /cooled for 24 hours/i, "README.md restates a single 24-hour cooldown; programs have their own cadence");
});
