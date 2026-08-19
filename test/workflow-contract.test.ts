import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const WORKFLOW_DIRECTORY = join(process.cwd(), ".github", "workflows");
const FULL_SHA = /@[0-9a-f]{40}$/i;
const VERSION_COMMENT = /^v?\d+(?:\.\d+){0,2}(?:[-+][A-Za-z0-9.-]+)?$/;

test("every workflow pins actions and declares least privilege", () => {
  const workflows = readdirSync(WORKFLOW_DIRECTORY)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  assert.ok(workflows.length > 0, "no workflow files found");

  for (const name of workflows) {
    const errors = workflowContractErrors(readFileSync(join(WORKFLOW_DIRECTORY, name), "utf8"));
    assert.deepEqual(errors, [], `${name}:\n${errors.join("\n")}`);
  }
});

test("the workflow contract rejects mutable pins, missing version comments, and persistent checkout credentials", () => {
  const valid = `permissions: {}
jobs:
  check:
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@${"a".repeat(40)} # v4.2.2
        with:
          persist-credentials: false
      - uses: actions/setup-node@${"b".repeat(40)} # v4.4.0
`;
  assert.deepEqual(workflowContractErrors(valid), []);

  assert.match(
    workflowContractErrors(valid.replace(`@${"b".repeat(40)}`, "@v4")).join("\n"),
    /full 40-character commit SHA/,
  );
  assert.match(
    workflowContractErrors(valid.replace(` # v4.4.0`, "")).join("\n"),
    /human-readable version comment/,
  );
  assert.match(
    workflowContractErrors(valid.replace("persist-credentials: false", "persist-credentials: true")).join("\n"),
    /persist-credentials: false/,
  );
  assert.match(
    workflowContractErrors(valid.replace("permissions: {}", "permissions: write-all")).join("\n"),
    /top-level permissions/,
  );

  const pushingCheckout = valid
    .replace(" # v4.2.2", " # v4.2.2; pushes: generated release metadata")
    .replace("        with:\n          persist-credentials: false\n", "");
  assert.deepEqual(workflowContractErrors(pushingCheckout), []);
});

function workflowContractErrors(source: string): string[] {
  const lines = source.split(/\r?\n/);
  const errors = topLevelPermissionErrors(lines);

  for (const [index, line] of lines.entries()) {
    const uses = /^(\s*)(-\s+)?uses:\s*([^\s#]+)(?:\s+#\s*(.+?))?\s*$/.exec(line);
    if (!uses) continue;
    const indent = uses[1]!.length;
    const rawTarget = uses[3]!;
    const target = /^(['"])(.*)\1$/.exec(rawTarget)?.[2] ?? rawTarget;
    const comment = uses[4]?.trim() ?? "";

    if (!target.startsWith("./")) {
      if (!FULL_SHA.test(target)) {
        errors.push(`line ${index + 1}: external uses must end in a full 40-character commit SHA`);
      }
      const version = comment.split(";")[0]!.trim();
      if (!VERSION_COMMENT.test(version)) {
        errors.push(`line ${index + 1}: external uses must carry a human-readable version comment`);
      }
    }

    if (!uses[2] || !/^actions\/checkout@/i.test(target)) continue;
    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      const followingStep = /^(\s*)-\s+/.exec(lines[next]!);
      if (followingStep && followingStep[1]!.length <= indent) {
        end = next;
        break;
      }
    }
    const step = lines.slice(index + 1, end);
    const disablesPersistence = step.some((entry) => /^\s+persist-credentials:\s*false\s*(?:#.*)?$/.test(entry));
    const pushes = /(?:^|;)\s*pushes:\s*\S/i.test(comment);
    if (!disablesPersistence && !pushes) {
      errors.push(
        `line ${index + 1}: checkout must set persist-credentials: false or declare '; pushes: <reason>'`,
      );
    }
  }

  return errors;
}

function topLevelPermissionErrors(lines: readonly string[]): string[] {
  const declarations = lines
    .map((line, index) => ({ index, match: /^permissions:\s*([^#]*?)(?:\s+#.*)?$/.exec(line) }))
    .filter((entry) => entry.match !== null);
  if (declarations.length !== 1) return ["workflow must declare exactly one top-level permissions policy"];

  const declaration = declarations[0]!;
  const inline = declaration.match![1]!.trim();
  if (inline === "{}") return [];
  if (inline !== "") {
    if (!/^\{\s*(?:[a-z-]+:\s*(?:read|none)\s*,?\s*)+\}$/.test(inline)) {
      return ["top-level permissions must be {} or explicit read/none grants"];
    }
    return [];
  }

  const grants: string[] = [];
  for (let index = declaration.index + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;
    grants.push(line.trim());
  }
  if (
    grants.length === 0 ||
    grants.some((grant) => !/^[a-z-]+:\s*(?:read|none)\s*(?:#.*)?$/.test(grant))
  ) {
    return ["top-level permissions must be {} or explicit read/none grants"];
  }
  return [];
}
