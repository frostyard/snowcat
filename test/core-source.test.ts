import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { inspectCoreCandidate } from "../src/core/git-source.ts";
import { CoreValidationError, validateCoreCatalog, type CoreTreeEntry } from "../src/core/validator.ts";

test("the bundled validator accepts the current core repository-authority shape without enrolling it", async () => {
  const entries = await validCoreEntries();
  const first = validateCoreCatalog(entries);
  const second = validateCoreCatalog([...entries].reverse());

  assert.equal(first.catalogDigest, second.catalogDigest);
  assert.equal(first.repositoryCount, 1);
  assert.equal(first.validFixtureCount, 3);
  assert.equal(first.invalidFixtureCount, 1);
  assert.equal(first.repositories[0]?.declaration.repository.repository_id, "1331309458");
  assert.equal(first.repositories[0]?.declaration.fleet_state, "disabled");
});

test("schema byte drift and duplicate live keys fail the candidate", async () => {
  const entries = await validCoreEntries();
  const schema = entries.find((entry) => entry.path.endsWith("repository.schema.json"))!;
  const drifted = entries.map((entry) =>
    entry === schema ? entryFor(entry.path, Buffer.concat([Buffer.from(entry.bytes), Buffer.from("\n")])) : entry,
  );
  assert.throws(() => validateCoreCatalog(drifted), /schema bytes do not match Fluent's bundled v1 contract/);

  const repository = entries.find((entry) => entry.path === "organization/repositories/frostyard/core.json")!;
  const duplicate = Buffer.from(
    '{"schema_version":1,"schema_version":1,"repository":{"owner":"frostyard","name":"core","repository_id":"1331309458"},"accountable_owners":[{"kind":"github-user","login":"bketelsen"}],"fleet_state":"disabled","maintenance_programs":[],"action_ceiling":[],"surface_contract_version":1}',
  );
  assert.throws(
    () => validateCoreCatalog(entries.map((entry) => (entry === repository ? entryFor(entry.path, duplicate) : entry))),
    (error) => error instanceof CoreValidationError && /duplicate JSON object key/.test(error.message),
  );
});

test("the Git source reads an exact commit through a bare mirror and rejects a symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-core-source-test-"));
  const source = join(directory, "source");
  const mirror = join(directory, "mirror.git");
  const entries = await validCoreEntries();
  for (const entry of entries) {
    const path = join(source, entry.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entry.bytes);
  }
  git(source, ["init", "-b", "main"]);
  git(source, ["config", "user.name", "Fluent Test"]);
  git(source, ["config", "user.email", "fluent-test@example.invalid"]);
  git(source, ["add", "organization"]);
  git(source, ["commit", "-m", "valid authority"]);

  const valid = await inspectCoreCandidate({
    sourceUrl: source,
    ref: "refs/heads/main",
    mirrorPath: mirror,
    allowFileSource: true,
  });
  assert.equal(valid.repositoryCount, 1);
  assert.match(valid.commitId, /^[0-9a-f]{40}$/);
  assert.match(valid.treeId, /^[0-9a-f]{40}$/);

  await unlink(join(source, "organization", "README.md"));
  await symlink("repositories/frostyard/core.json", join(source, "organization", "README.md"));
  git(source, ["add", "organization/README.md"]);
  git(source, ["commit", "-m", "invalid symlink"]);

  await assert.rejects(
    inspectCoreCandidate({ sourceUrl: source, ref: "refs/heads/main", mirrorPath: mirror, allowFileSource: true }),
    /accepts only regular Git blobs/,
  );
});

async function validCoreEntries(): Promise<CoreTreeEntry[]> {
  const repository = {
    schema_version: 1,
    repository: { owner: "frostyard", name: "core", repository_id: "1331309458" },
    accountable_owners: [{ kind: "github-user", login: "bketelsen" }],
    fleet_state: "disabled",
    maintenance_programs: ["quality", "ci", "security", "architecture"],
    action_ceiling: ["read", "write", "run-tests", "open-issue", "open-pr", "create-followup"],
    surface_contract_version: 1,
  };
  const surfaces = {
    schema_version: 1,
    contract: { id: "repository-surfaces", version: 1 },
    surfaces: [
      { id: "agent-instructions", path: "AGENTS.md", artifact_type: "file", media_type: "text/markdown" },
      {
        id: "agent-governance",
        path: "policies/agent-governance.json",
        artifact_type: "file",
        media_type: "application/json",
        schema_path: "organization/schemas/v1/repository-agent-governance.schema.json",
      },
      { id: "agent-skills", path: ".agents/skills", artifact_type: "directory" },
      { id: "documentation-index", path: "docs/README.md", artifact_type: "file", media_type: "text/markdown" },
    ],
  };
  const governance = {
    schema_version: 1,
    default_decision: "deny",
    actions: {},
    protected_boundaries: [],
    change_controls: {
      pull_requests_required: true,
      human_review_before_merge: true,
      highest_applicable_risk: true,
      validation_evidence_required: true,
      least_privilege: true,
      untrusted_content_is_data: true,
      never_relax: [
        "required-checks",
        "security-checks",
        "review-requirements",
        "coverage-checks",
        "provenance-verification",
      ],
    },
    exception_controls: {
      independent_authorized_approver: true,
      self_approval: false,
      required_fields: [
        "rationale",
        "target",
        "compensating-controls",
        "expires-at",
        "restoration-or-closure-plan",
      ],
    },
    risk_classification: {
      tiers: ["low", "moderate", "high", "critical"],
      classification_rule: "highest-applicable",
      uncertainty_rule: "higher-plausible",
    },
  };

  const entries = [
    entryFor("organization/README.md", Buffer.from("# Organization authority\n")),
    entryFor("organization/contracts/repository-surfaces/v1.json", json(surfaces)),
    entryFor("organization/repositories/frostyard/core.json", json(repository)),
    entryFor("organization/fixtures/v1/valid/repository.json", json(repository)),
    entryFor("organization/fixtures/v1/valid/repository-surfaces.json", json(surfaces)),
    entryFor("organization/fixtures/v1/valid/repository-agent-governance.json", json(governance)),
    entryFor("organization/fixtures/v1/invalid/repository-unknown-program.json", Buffer.from('{"schema_version":2}')),
  ];
  for (const name of [
    "repository.schema.json",
    "repository-surfaces.schema.json",
    "repository-agent-governance.schema.json",
  ]) {
    const bundled = await readFile(new URL(`../src/core/schemas/v1/${name}`, import.meta.url));
    const exactCoreBytes = bundled.at(-1) === 0x0a ? bundled.subarray(0, -1) : bundled;
    entries.push(entryFor(`organization/schemas/v1/${name}`, exactCoreBytes));
  }
  return entries;
}

function entryFor(path: string, bytes: Uint8Array): CoreTreeEntry {
  return {
    path,
    mode: "100644",
    objectId: createHash("sha1").update(bytes).digest("hex"),
    bytes,
  };
}

function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function git(directory: string, args: string[]): void {
  execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" });
}
