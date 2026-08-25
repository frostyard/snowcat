import assert from "node:assert/strict";
import test from "node:test";

import { REPOSITORY_MAINTENANCE_PROGRAMS } from "../src/control/registry.ts";
import { discoveryRootFor, maintenanceProgram, maintenancePrograms } from "../src/queue/programs.ts";

test("every catalog entry is a Core program with a distinct discovery kind; Core's enum may be wider than the catalog", () => {
  const ids = maintenancePrograms.map((program) => program.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.ok((REPOSITORY_MAINTENANCE_PROGRAMS as readonly string[]).includes(id), id);
  assert.deepEqual(ids.sort(), ["architecture", "ci", "conformance", "dependencies", "docs", "quality", "security", "triage"]);
  const kinds = maintenancePrograms.map((program) => program.discovery.kind);
  assert.equal(new Set(kinds).size, kinds.length);
  for (const id of ids) assert.equal(maintenanceProgram(id).id, id);
  // Declared in Core (ADR-0039) but not yet in the catalog: known to the registry, unknown to the catalog.
  assert.deepEqual([...REPOSITORY_MAINTENANCE_PROGRAMS], ["quality", "ci", "security", "architecture", "conformance", "triage", "dependencies", "docs", "release"]);
  assert.throws(() => maintenanceProgram("release"), /unknown maintenance program/);
  // Triage children are proposals with issue-mutation authority at most, never a pull request (ADR-0062).
  assert.deepEqual(maintenanceProgram("triage").childCeiling, ["read", "open-issue"]);
  assert.equal(maintenanceProgram("triage").childAdmission, "proposed");
});

test("every program is a read-only discovery root with a positive cooldown, a bounded child ceiling, and proposed children", () => {
  for (const program of maintenancePrograms) {
    // Conformance discovery alone also runs the repository's read-only verify gate (ADR-0043's gate triad).
    const expectedActions = program.id === "conformance" ? ["read", "run-tests", "create-followup"] : ["read", "create-followup"];
    assert.deepEqual(program.discovery.allowedActions, expectedActions, program.id);
    assert.ok(Number.isSafeInteger(program.cooldownSeconds) && program.cooldownSeconds > 0, program.id);
    assert.equal(program.childAdmission, "proposed", program.id);
    assert.ok(program.childCeiling.length > 0 && program.childCeiling.every((action) => ["read", "write", "run-tests", "open-issue", "open-pr", "create-followup"].includes(action)), program.id);
    assert.ok(program.discovery.kind.endsWith("-discovery"), program.id);
    assert.equal(program.discovery.priority, 0, program.id);
    assert.match(program.discovery.instructions, /Do not edit files or open a GitHub artifact/, program.id);
    if (program.id === "conformance") {
      // ADR-0044: every enrolled repository exposes `make verify` unconditionally — no `npm run verify` fallback.
      assert.match(program.discovery.instructions, /make verify/);
      assert.doesNotMatch(program.discovery.instructions, /npm run verify/);
      assert.doesNotMatch(program.discovery.instructions, /where a `Makefile` declares/);
      assert.match(program.discovery.acceptanceCriteria.join("\n"), /make verify/);
    }
  }
  // Cadence defaults recorded in the maintenance programs plan.
  const cadence = Object.fromEntries(maintenancePrograms.map((program) => [program.id, program.cooldownSeconds]));
  assert.deepEqual(cadence, { quality: 86_400, ci: 86_400, security: 86_400, architecture: 604_800, conformance: 604_800, triage: 86_400, dependencies: 604_800, docs: 604_800 });
});

test("discoveryRootFor authors the program's root for a repository with the child ceiling as delegableActions", () => {
  const root = discoveryRootFor(maintenanceProgram("ci"), "frostyard/example");
  assert.equal(root.repository, "frostyard/example");
  assert.equal(root.createdBy, "operator:dogfood");
  assert.equal(root.kind, "ci-gap-discovery");
  assert.deepEqual(root.delegableActions, maintenanceProgram("ci").childCeiling);
  assert.equal(discoveryRootFor(maintenanceProgram("ci"), "frostyard/example", "operator:test").createdBy, "operator:test");
});
