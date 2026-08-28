import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { LineCounter, isMap, isScalar, isSeq, parseDocument, visit, type Pair, type YAMLMap } from "yaml";

const WORKFLOW_DIRECTORY = join(process.cwd(), ".github", "workflows");
const FULL_SHA = /@[0-9a-f]{40}$/i;
const VERSION_COMMENT = /^v?\d+(?:\.\d+){0,2}(?:[-+][A-Za-z0-9.-]+)?$/;
const CANONICAL_FULL_GATE = "npm run check";
const MAKE_CI_TARGET = "ci";

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
    timeout-minutes: 30
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
  assert.match(
    workflowContractErrors(
      valid.replace(
        "        with:\n          persist-credentials: false\n",
        "        env:\n          persist-credentials: false\n",
      ),
    ).join("\n"),
    /persist-credentials: false/,
  );
  assert.match(
    workflowContractErrors(valid.replace("    timeout-minutes: 30\n", "")).join("\n"),
    /timeout-minutes/,
  );
  assert.match(
    workflowContractErrors(valid.replace("timeout-minutes: 30", "timeout-minutes: 0")).join("\n"),
    /between 1 and 30/,
  );
  assert.match(
    workflowContractErrors(valid.replace("timeout-minutes: 30", "timeout-minutes: 31")).join("\n"),
    /between 1 and 30/,
  );

  const pushingCheckout = valid
    .replace(" # v4.2.2", " # v4.2.2; pushes: generated release metadata")
    .replace("        with:\n          persist-credentials: false\n", "");
  assert.deepEqual(workflowContractErrors(pushingCheckout), []);

  const validFlowMapping = `permissions: {}
jobs:
  check:
    timeout-minutes: 30
    steps:
      - { uses: actions/checkout@${"a".repeat(40)}, with: { persist-credentials: false } } # v4.2.2
`;
  assert.deepEqual(workflowContractErrors(validFlowMapping), []);
  assert.match(
    workflowContractErrors(validFlowMapping.replace(`@${"a".repeat(40)}`, "@v4")).join("\n"),
    /full 40-character commit SHA/,
  );
});

test("every link of the CI signal chain reaches the canonical full gate", () => {
  const makefile = readMakefile();
  const workflowCommand = canonicalFullGateCommand(makefile);
  const source = readFileSync(join(WORKFLOW_DIRECTORY, "check.yml"), "utf8");
  const document = parseDocument(source);
  assert.ok(isMap(document.contents), "workflow must contain a top-level mapping");

  const workflowErrors = fullGateErrors(document.contents, workflowCommand);
  assert.deepEqual(workflowErrors, [], workflowErrors.join("\n"));

  if (workflowCommand === CANONICAL_FULL_GATE) return;
  assert.equal(workflowCommand, `make ${MAKE_CI_TARGET}`);
  assert.ok(makefile !== undefined);
  const makefileErrors = makefileGateErrors(makefile, MAKE_CI_TARGET, CANONICAL_FULL_GATE);
  assert.deepEqual(makefileErrors, [], makefileErrors.join("\n"));
});

test("the full-gate check rejects a weaker command such as npm test", () => {
  const weakened = `jobs:
  check:
    steps:
      - run: npm ci
      - run: npm test
`;
  const document = parseDocument(weakened);
  assert.ok(isMap(document.contents));
  const errors = fullGateErrors(document.contents, "npm run check");
  assert.match(errors.join("\n"), /canonical full gate/);

  const missing = `jobs:
  check:
    steps:
      - run: npm ci
`;
  const missingDocument = parseDocument(missing);
  assert.ok(isMap(missingDocument.contents));
  assert.match(fullGateErrors(missingDocument.contents, "npm run check").join("\n"), /canonical full gate/);

  const duplicated = `jobs:
  check:
    steps:
      - run: npm run check
      - run: npm run check
`;
  const duplicatedDocument = parseDocument(duplicated);
  assert.ok(isMap(duplicatedDocument.contents));
  assert.match(fullGateErrors(duplicatedDocument.contents, "npm run check").join("\n"), /canonical full gate/);
});

test("the full-gate contract rejects a Makefile `ci` recipe weakened to npm test", () => {
  const weakened = `.PHONY: verify check ci

verify:
\tnpm run verify

check:
\tnpm run check

ci:
\tnpm test
`;
  // The workflow link is untouched: check.yml still invokes `make ci`.
  const workflow = parseDocument(`jobs:
  check:
    steps:
      - run: npm ci
      - run: make ci
`);
  assert.ok(isMap(workflow.contents));
  assert.equal(canonicalFullGateCommand(weakened), "make ci");
  assert.deepEqual(fullGateErrors(workflow.contents, "make ci"), []);

  // The Makefile link is not, so the contract must still fail.
  assert.match(
    makefileGateErrors(weakened, "ci", "npm run check").join("\n"),
    /canonical full gate/,
  );

  const canonical = weakened.replace("ci:\n\tnpm test", "ci:\n\tnpm run check");
  assert.deepEqual(makefileGateErrors(canonical, "ci", "npm run check"), []);
});

test("the Makefile full-gate check rejects a missing, duplicated, or wrapped recipe", () => {
  assert.match(
    makefileGateErrors("check:\n\tnpm run check\n", "ci", "npm run check").join("\n"),
    /must declare a `ci` target/,
  );
  assert.match(
    makefileGateErrors("ci:\n", "ci", "npm run check").join("\n"),
    /canonical full gate/,
  );
  assert.match(
    makefileGateErrors("ci:\n\tnpm run check\n\tnpm run check\n", "ci", "npm run check").join("\n"),
    /found 2/,
  );
  // A silenced or ignore-errors prefix still counts as the canonical invocation.
  assert.deepEqual(makefileGateErrors("ci:\n\t@npm run check\n", "ci", "npm run check"), []);
  // A following target's recipe is not read as part of this one.
  assert.match(
    makefileGateErrors("ci:\n\tnpm test\n\ncheck:\n\tnpm run check\n", "ci", "npm run check").join("\n"),
    /found 0 in \[npm test\]/,
  );
});

function readMakefile(): string | undefined {
  try {
    return readFileSync(join(process.cwd(), "Makefile"), "utf8");
  } catch {
    // no root Makefile: the workflow must invoke the npm entry point directly
    return undefined;
  }
}

function canonicalFullGateCommand(makefile: string | undefined): string {
  if (makefile !== undefined && makefileRecipe(makefile, MAKE_CI_TARGET) !== undefined) {
    return `make ${MAKE_CI_TARGET}`;
  }
  return CANONICAL_FULL_GATE;
}

/**
 * The recipe lines of one Makefile target, or undefined when it declares none.
 * Recipe lines are tab-indented; comments, blank lines, and the `-@+` command
 * prefixes are dropped, and the first other unindented line ends the target.
 */
function makefileRecipe(source: string, target: string): string[] | undefined {
  const lines = source.split(/\r?\n/);
  const header = new RegExp(`^${target}\\s*:(?!=)`);
  let index = lines.findIndex((line) => header.test(line));
  if (index === -1) return undefined;

  const recipe: string[] = [];
  for (index += 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("\t")) {
      const command = line.slice(1).replace(/^[-@+]+/, "").trim();
      if (command !== "" && !command.startsWith("#")) recipe.push(command);
      continue;
    }
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    break;
  }
  return recipe;
}

function makefileGateErrors(source: string, target: string, expectedCommand: string): string[] {
  const recipe = makefileRecipe(source, target);
  if (recipe === undefined) return [`Makefile must declare a \`${target}\` target`];

  const matches = recipe.filter((command) => command === expectedCommand);
  if (matches.length !== 1) {
    return [
      `Makefile \`${target}\` target must invoke the canonical full gate ` +
        `(\`${expectedCommand}\`) exactly once; found ${matches.length} in [${recipe.join("; ")}]`,
    ];
  }
  return [];
}

function fullGateErrors(root: YAMLMap, expectedCommand: string): string[] {
  const jobs = root.get("jobs", true);
  if (!isMap(jobs)) return ["workflow must contain a jobs mapping"];
  const checkJob = jobs.get("check", true);
  if (!isMap(checkJob)) return ["workflow must declare a check job"];
  const steps = checkJob.get("steps", true);
  if (!isSeq(steps)) return ["check job must declare a steps sequence"];

  const matches = steps.items.filter((step) => {
    if (!isMap(step)) return false;
    const run = step.get("run");
    return typeof run === "string" && run.trim() === expectedCommand;
  });
  if (matches.length !== 1) {
    return [
      `check job must invoke the canonical full gate (\`${expectedCommand}\`) exactly once; found ${matches.length}`,
    ];
  }
  return [];
}

function workflowContractErrors(source: string): string[] {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, { lineCounter });
  if (document.errors.length > 0) {
    return document.errors.map((error) => `workflow must be valid YAML: ${error.message}`);
  }
  if (!isMap(document.contents)) return ["workflow must contain a top-level mapping"];

  const errors = [
    ...topLevelPermissionErrors(document.contents),
    ...jobTimeoutErrors(document.contents),
  ];
  visit(document, {
    Pair(_key, pair, path) {
      if (!isScalar(pair.key) || pair.key.value !== "uses") return;
      const line = lineCounter.linePos(pair.key.range?.[0] ?? 0).line;
      if (!isScalar(pair.value) || typeof pair.value.value !== "string") {
        errors.push(`line ${line}: uses must be a string`);
        return;
      }

      const target = pair.value.value;
      const owner = path.at(-1);
      const comment = usesComment(pair, owner);
      if (!target.startsWith("./")) {
        if (!FULL_SHA.test(target)) {
          errors.push(`line ${line}: external uses must end in a full 40-character commit SHA`);
        }
        const version = comment.split(";")[0]!.trim();
        if (!VERSION_COMMENT.test(version)) {
          errors.push(`line ${line}: external uses must carry a human-readable version comment`);
        }
      }

      if (!/^actions\/checkout@/i.test(target)) return;
      const withNode = isMap(owner) ? owner.get("with", true) : undefined;
      const persistCredentials = isMap(withNode) ? withNode.get("persist-credentials") : undefined;
      const disablesPersistence = persistCredentials === false || persistCredentials === "false";
      const pushes = /(?:^|;)\s*pushes:\s*\S/i.test(comment);
      if (!disablesPersistence && !pushes) {
        errors.push(`line ${line}: checkout must set persist-credentials: false or declare '; pushes: <reason>'`);
      }
    },
  });
  return errors;
}

function jobTimeoutErrors(root: YAMLMap): string[] {
  const jobs = root.get("jobs", true);
  if (!isMap(jobs)) return ["workflow must contain a jobs mapping"];

  const errors: string[] = [];
  for (const pair of jobs.items) {
    const jobName = isScalar(pair.key) ? String(pair.key.value) : "<unknown>";
    if (!isMap(pair.value)) {
      errors.push(`job ${jobName}: job must be a mapping`);
      continue;
    }
    const timeout = pair.value.get("timeout-minutes");
    if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > 30) {
      errors.push(`job ${jobName}: timeout-minutes must be an integer between 1 and 30`);
    }
  }
  return errors;
}

function usesComment(pair: Pair, owner: unknown): string {
  if (isScalar(pair.value) && pair.value.comment) return pair.value.comment.trim();
  if (isMap(owner) && owner.flow && owner.comment) return owner.comment.trim();
  return "";
}

function topLevelPermissionErrors(root: YAMLMap): string[] {
  const declarations = root.items.filter(
    (pair) => isScalar(pair.key) && pair.key.value === "permissions",
  );
  if (declarations.length !== 1) return ["workflow must declare exactly one top-level permissions policy"];

  const permissions = declarations[0]!.value;
  if (!isMap(permissions)) return ["top-level permissions must be {} or explicit read/none grants"];
  if (permissions.items.length === 0) return [];
  if (
    permissions.items.some(
      (pair) =>
        !isScalar(pair.key) ||
        typeof pair.key.value !== "string" ||
        !isScalar(pair.value) ||
        (pair.value.value !== "read" && pair.value.value !== "none"),
    )
  ) {
    return ["top-level permissions must be {} or explicit read/none grants"];
  }
  return [];
}
