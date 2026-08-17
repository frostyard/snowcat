import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { ControlPlaneStore } from "../../src/control/store.ts";
import type { InspectedCoreCandidate } from "../../src/core/git-source.ts";
import { validateCoreCatalog, type CoreTreeEntry, type RepositoryDeclaration } from "../../src/core/validator.ts";
import { reconcileRepositories } from "../../src/repository/controller.ts";
import {
  repositoryGitBlobObjectId,
  repositoryGitTreeObjectId,
  type RepositorySurfaceTreeEntry,
} from "../../src/repository/surfaces.ts";

/**
 * Shared Core and repository fixtures: a valid organization slice declaring
 * `frostyard/example` (GitHub id 9001) plus fake GitHub identity and surface
 * probes that let a test drive a fresh control-plane store all the way to an
 * `enrolled` repository without network access.
 */

export function enabledDeclaration(): RepositoryDeclaration {
  return {
    schema_version: 1,
    repository: { owner: "frostyard", name: "example", repository_id: "9001" },
    accountable_owners: [{ kind: "github-user", login: "bketelsen" }],
    fleet_state: "enabled",
    maintenance_programs: ["quality", "ci"],
    action_ceiling: ["read", "write", "run-tests", "open-issue", "open-pr"],
    surface_contract_version: 1,
  };
}


export async function activationCandidate(
  declaration: RepositoryDeclaration,
  commitId: string,
  treeId: string,
): Promise<InspectedCoreCandidate> {
  const files = await validCoreEntries(declaration, true);
  return {
    sourceUrl: "https://github.com/frostyard/core.git",
    ref: "refs/heads/main",
    commitId,
    treeId,
    files,
    ...validateCoreCatalog(files),
  };
}


export async function validCoreEntries(
  declaration: RepositoryDeclaration,
  includeLiveRepository: boolean,
): Promise<CoreTreeEntry[]> {
  const fixtureRepository: RepositoryDeclaration = {
    ...declaration,
    repository: { owner: "frostyard", name: "example", repository_id: "9001" },
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
  const governance = validGovernance();
  const entries = [
    entryFor("organization/README.md", Buffer.from("# Organization authority\n")),
    entryFor("organization/contracts/repository-surfaces/v1.json", json(surfaces)),
    entryFor("organization/fixtures/v1/valid/repository.json", json(fixtureRepository)),
    entryFor("organization/fixtures/v1/valid/repository-surfaces.json", json(surfaces)),
    entryFor("organization/fixtures/v1/valid/repository-agent-governance.json", json(governance)),
    entryFor("organization/fixtures/v1/invalid/repository-unknown-program.json", Buffer.from('{"schema_version":2}')),
  ];
  if (includeLiveRepository) {
    entries.push(
      entryFor(
        `organization/repositories/${declaration.repository.owner}/${declaration.repository.name}.json`,
        json(declaration),
      ),
    );
  }
  for (const name of [
    "repository.schema.json",
    "repository-surfaces.schema.json",
    "repository-agent-governance.schema.json",
  ]) {
    const bundled = await readFile(new URL(`../../src/core/schemas/v1/${name}`, import.meta.url));
    entries.push(entryFor(`organization/schemas/v1/${name}`, bundled));
  }
  return entries;
}


export function validGovernance() {
  return {
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
}


export function validSurfaceProbe() {
  const instructions = Buffer.from("# Agent instructions\n");
  const governance = json(validGovernance());
  const documentation = Buffer.from("# Documentation\n");
  const skillsEntries: RepositorySurfaceTreeEntry[] = [];
  return {
    kind: "resolved" as const,
    defaultBranch: "main",
    repositoryCommitId: "d".repeat(40),
    repositoryTreeId: "e".repeat(40),
    surfaces: [
      {
        surfaceId: "agent-instructions",
        path: "AGENTS.md",
        kind: "found" as const,
        mode: "100644",
        objectType: "blob" as const,
        objectId: repositoryGitBlobObjectId(instructions),
        bytes: instructions,
        treeEntries: null,
      },
      {
        surfaceId: "agent-governance",
        path: "policies/agent-governance.json",
        kind: "found" as const,
        mode: "100644",
        objectType: "blob" as const,
        objectId: repositoryGitBlobObjectId(governance),
        bytes: governance,
        treeEntries: null,
      },
      {
        surfaceId: "agent-skills",
        path: ".agents/skills",
        kind: "found" as const,
        mode: "040000",
        objectType: "tree" as const,
        objectId: repositoryGitTreeObjectId(skillsEntries),
        bytes: null,
        treeEntries: skillsEntries,
      },
      {
        surfaceId: "documentation-index",
        path: "docs/README.md",
        kind: "found" as const,
        mode: "100644",
        objectType: "blob" as const,
        objectId: repositoryGitBlobObjectId(documentation),
        bytes: documentation,
        treeEntries: null,
      },
    ],
  };
}


export function entryFor(path: string, bytes: Uint8Array): CoreTreeEntry {
  return {
    path,
    mode: "100644",
    objectId: createHash("sha1").update(bytes).digest("hex"),
    bytes,
  };
}


export function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

export const EXAMPLE_REPOSITORY_ID = "9001";

/**
 * Activates the fixture Core slice at snapshot commit `7…`/tree `8…`, records
 * source eligibility, and reconciles identity and surfaces with the fake
 * probes so `frostyard/example` reaches `enrolled`. Returns the activation
 * transaction sequence.
 */
export async function enrollExampleRepository(
  store: ControlPlaneStore,
  options: { declaration?: RepositoryDeclaration; expectedLastTransactionSequence?: number } = {},
): Promise<number> {
  const candidate = await activationCandidate(options.declaration ?? enabledDeclaration(), "7".repeat(40), "8".repeat(40));
  const activation = store.activateCoreSnapshot({
    candidate,
    expectedLastTransactionSequence: options.expectedLastTransactionSequence ?? store.metadata().lastTransactionSequence,
  });
  store.recordCoreSourceCheckEligible({
    checkId: "0198b9fd-6200-7000-8000-000000000001",
    candidate,
    expectedLastTransactionSequence: activation.transactionSequence,
  });
  await reconcileRepositories(
    store,
    async () => ({
      kind: "found",
      repositoryId: EXAMPLE_REPOSITORY_ID,
      owner: "frostyard",
      name: "example",
      archived: false,
      defaultBranch: "main",
    }),
    async () => validSurfaceProbe(),
  );
  return activation.transactionSequence;
}
