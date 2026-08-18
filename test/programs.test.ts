import assert from "node:assert/strict";
import test from "node:test";

import { discoveryRootFor, maintenanceProgram, maintenancePrograms } from "../src/queue/programs.ts";

const coreEnum = ["quality", "ci", "security", "architecture"] as const;

test("the maintenance program catalog has exactly one entry per Core program with a distinct discovery kind", () => {
  assert.deepEqual(
    maintenancePrograms.map((program) => program.id).sort(),
    [...coreEnum].sort(),
  );
  const kinds = maintenancePrograms.map((program) => program.discovery.kind);
  assert.equal(new Set(kinds).size, kinds.length);
  for (const id of coreEnum) assert.equal(maintenanceProgram(id).id, id);
  assert.throws(() => maintenanceProgram("dependencies" as never), /unknown maintenance program/);
});

test("every program is a read-only discovery root with a positive cooldown, a bounded child ceiling, and proposed children", () => {
  for (const program of maintenancePrograms) {
    assert.deepEqual(program.discovery.allowedActions, ["read", "create-followup"], program.id);
    assert.ok(Number.isSafeInteger(program.cooldownSeconds) && program.cooldownSeconds > 0, program.id);
    assert.equal(program.childAdmission, "proposed", program.id);
    assert.ok(program.childCeiling.length > 0 && program.childCeiling.every((action) => ["read", "write", "run-tests", "open-issue", "open-pr", "create-followup"].includes(action)), program.id);
    assert.equal(program.discovery.priority, 0, program.id);
    assert.match(program.discovery.instructions, /Do not edit files or open a GitHub artifact/, program.id);
  }
  // Cadence defaults recorded in the maintenance programs plan.
  const cadence = Object.fromEntries(maintenancePrograms.map((program) => [program.id, program.cooldownSeconds]));
  assert.deepEqual(cadence, { quality: 86_400, ci: 86_400, security: 86_400, architecture: 604_800 });
});

test("discoveryRootFor authors the program's root for a repository with the child ceiling as delegableActions", () => {
  const root = discoveryRootFor(maintenanceProgram("ci"), "frostyard/example");
  assert.equal(root.repository, "frostyard/example");
  assert.equal(root.createdBy, "operator:dogfood");
  assert.equal(root.kind, "ci-gap-discovery");
  assert.deepEqual(root.delegableActions, maintenanceProgram("ci").childCeiling);
  assert.equal(discoveryRootFor(maintenanceProgram("ci"), "frostyard/example", "operator:test").createdBy, "operator:test");
});
