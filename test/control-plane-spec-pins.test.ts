import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CONTROL_PLANE_REGISTRY_VERSION, CONTROL_PLANE_SCHEMA_VERSION } from "../src/control/registry.ts";

const specDir = fileURLToPath(new URL("../docs/specs/", import.meta.url));

test("control-plane-kernel.md's Schema/Registry version table row names the code-owned versions", () => {
  const kernel = readFileSync(`${specDir}control-plane-kernel.md`, "utf8");
  const schemaRow = kernel.match(/^\|\s*Schema version\s*\|\s*`(\d+)`\s*\|/m);
  const registryRow = kernel.match(/^\|\s*Registry version\s*\|\s*`(\d+)`\s*\|/m);
  assert.ok(schemaRow, "expected a 'Schema version' table row in control-plane-kernel.md");
  assert.ok(registryRow, "expected a 'Registry version' table row in control-plane-kernel.md");
  assert.equal(
    Number(schemaRow![1]),
    CONTROL_PLANE_SCHEMA_VERSION,
    "control-plane-kernel.md's Schema version row is behind src/control/registry.ts CONTROL_PLANE_SCHEMA_VERSION",
  );
  assert.equal(
    Number(registryRow![1]),
    CONTROL_PLANE_REGISTRY_VERSION,
    "control-plane-kernel.md's Registry version row is behind src/control/registry.ts CONTROL_PLANE_REGISTRY_VERSION",
  );
});

test("core-snapshot-activation.md rule 19 names the code-owned schema and registry versions", () => {
  const activation = readFileSync(`${specDir}core-snapshot-activation.md`, "utf8");
  const rule19 = activation.match(
    /19\.\s*A schema version other than `(\d+)` or registry version other than `(\d+)` MUST fail/,
  );
  assert.ok(rule19, "expected rule 19 in core-snapshot-activation.md to name a schema and registry version");
  assert.equal(
    Number(rule19![1]),
    CONTROL_PLANE_SCHEMA_VERSION,
    "core-snapshot-activation.md rule 19 schema version is behind src/control/registry.ts CONTROL_PLANE_SCHEMA_VERSION",
  );
  assert.equal(
    Number(rule19![2]),
    CONTROL_PLANE_REGISTRY_VERSION,
    "core-snapshot-activation.md rule 19 registry version is behind src/control/registry.ts CONTROL_PLANE_REGISTRY_VERSION",
  );
});
