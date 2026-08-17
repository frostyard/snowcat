import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlPlaneStore } from "../src/control/store.ts";
import type { InspectedCoreCandidate } from "../src/core/git-source.ts";
import {
  CoreValidationError,
  assertRepositoryDeclarationRetention,
  validateCoreCatalog,
  type CoreTreeEntry,
  type RepositoryDeclaration,
} from "../src/core/validator.ts";
import { reconcileRepositories } from "../src/repository/controller.ts";
import { inspectGitHubRepository } from "../src/repository/github.ts";
import { synchronizeCoreSource } from "../src/core/synchronize.ts";

test("active Core authority materializes separately from GitHub identity and enrollment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-repository-authority-test-"));
  let now = new Date("2026-08-16T18:00:00.000Z");
  const store = new ControlPlaneStore(join(directory, "control.db"), () => now);
  const candidate = await activationCandidate(enabledDeclaration(), "1".repeat(40), "2".repeat(40));
  const activation = store.activateCoreSnapshot({ candidate, expectedLastTransactionSequence: 1 });
  now = new Date("2026-08-16T18:01:00.000Z");
  store.recordCoreSourceCheckEligible({
    checkId: "0198b543-8200-7000-8000-000000000001",
    candidate,
    expectedLastTransactionSequence: activation.transactionSequence,
  });
  assert.equal(store.repositoryStatuses()[0]?.effectiveState, "awaiting-authority");
  assert.equal(store.repositoryStatuses()[0]?.coreAuthorizationRecordId, null);

  now = new Date("2026-08-16T18:02:00.000Z");
  const authority = store.materializeRepositoryCoreAuthority({
    expectedLastTransactionSequence: 3,
    coreSnapshotId: activation.snapshotId,
    repositoryId: "github.com:9001",
  });
  assert.equal(authority.transactionSequence, 4);
  assert.deepEqual(store.repositoryStatuses(), [
    {
      repositoryId: "github.com:9001",
      owner: "frostyard",
      name: "example",
      coreSnapshotId: activation.snapshotId,
      coreAuthorizationRecordId: authority.coreAuthorizationRecordId,
      fleetState: "enabled",
      maintenancePrograms: ["quality", "ci"],
      actionCeiling: ["read", "write", "run-tests", "open-issue", "open-pr"],
      accountableOwners: [{ kind: "github-user", login: "bketelsen" }],
      surfaceContractVersion: 1,
      githubReconciliationRecordId: null,
      githubResult: null,
      effectiveState: "awaiting-github",
    },
  ]);

  now = new Date("2026-08-16T18:03:00.000Z");
  const reconciled = store.recordRepositoryGitHubIdentity({
    expectedLastTransactionSequence: 4,
    coreAuthorizationRecordId: authority.coreAuthorizationRecordId,
    inspection: {
      kind: "found",
      repositoryId: "9001",
      owner: "Frostyard",
      name: "Example",
      archived: false,
    },
  });
  assert.equal(reconciled.result, "matched");
  assert.equal(reconciled.effectiveState, "awaiting-surfaces");
  assert.equal(store.repositoryStatuses()[0]?.effectiveState, "awaiting-surfaces");
  assert.equal(store.repositoryStatuses()[0]?.githubReconciliationRecordId, reconciled.reconciliationRecordId);

  const replay = store.recordRepositoryGitHubIdentity({
    expectedLastTransactionSequence: 5,
    coreAuthorizationRecordId: authority.coreAuthorizationRecordId,
    inspection: {
      kind: "found",
      repositoryId: "9001",
      owner: "Frostyard",
      name: "Example",
      archived: false,
    },
  });
  assert.deepEqual(replay, reconciled);
  assert.equal(store.metadata().lastTransactionSequence, 5);
  assert.deepEqual(
    store.occurrences().slice(-6).map((occurrence) => [occurrence.kind, occurrence.recordClass]),
    [
      ["repository.declaration-definition", "definition"],
      ["repository.core-authorized", "fact"],
      ["repository.core-authority-reconciled", undefined],
      ["repository.github-identity-observation", "observation"],
      ["repository.github-identity-reconciled", "fact"],
      ["repository.github-identity-reconciliation-recorded", undefined],
    ],
  );
  store.close();

  const reopened = new ControlPlaneStore(join(directory, "control.db"));
  assert.equal(reopened.repositoryStatuses()[0]?.effectiveState, "awaiting-surfaces");
  reopened.close();
});

test("GitHub reconciliation classifies mismatch precedence and preserves declaration authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-repository-mismatch-test-"));
  let now = new Date("2026-08-16T19:00:00.000Z");
  const store = new ControlPlaneStore(join(directory, "control.db"), () => now);
  const candidate = await activationCandidate(enabledDeclaration(), "3".repeat(40), "4".repeat(40));
  const activation = store.activateCoreSnapshot({ candidate, expectedLastTransactionSequence: 1 });
  store.recordCoreSourceCheckEligible({
    checkId: "0198b57a-7080-7000-8000-000000000001",
    candidate,
    expectedLastTransactionSequence: 2,
  });
  const authority = store.materializeRepositoryCoreAuthority({
    expectedLastTransactionSequence: 3,
    coreSnapshotId: activation.snapshotId,
    repositoryId: "github.com:9001",
  });

  const cases = [
    [{ kind: "missing" as const }, "missing"],
    [{ kind: "unavailable" as const }, "unavailable"],
    [
      { kind: "found" as const, repositoryId: "9002", owner: "other", name: "renamed", archived: true },
      "identity-mismatch",
    ],
    [
      { kind: "found" as const, repositoryId: "9001", owner: "frostyard", name: "renamed", archived: true },
      "locator-mismatch",
    ],
    [
      { kind: "found" as const, repositoryId: "9001", owner: "frostyard", name: "example", archived: true },
      "archived",
    ],
  ] as const;
  for (const [inspection, expected] of cases) {
    now = new Date(now.getTime() + 60_000);
    const result = store.recordRepositoryGitHubIdentity({
      expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
      coreAuthorizationRecordId: authority.coreAuthorizationRecordId,
      inspection,
    });
    assert.equal(result.result, expected);
    assert.equal(result.effectiveState, "github-held");
  }
  assert.equal(store.repositoryStatuses()[0]?.githubResult, "archived");
  assert.equal(store.repositoryStatuses()[0]?.fleetState, "enabled");
  store.close();
});

test("the RepositoryReconciler skips external lookup for narrowed declarations and converges", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-repository-controller-test-"));
  let now = new Date("2026-08-16T20:00:00.000Z");
  const store = new ControlPlaneStore(join(directory, "control.db"), () => now);
  const disabled = await activationCandidate(
    { ...enabledDeclaration(), fleet_state: "disabled", maintenance_programs: [], action_ceiling: [] },
    "5".repeat(40),
    "6".repeat(40),
  );
  const activation = store.activateCoreSnapshot({ candidate: disabled, expectedLastTransactionSequence: 1 });
  store.recordCoreSourceCheckEligible({
    checkId: "0198b5b1-5f00-7000-8000-000000000001",
    candidate: disabled,
    expectedLastTransactionSequence: 2,
  });
  let calls = 0;
  const first = await reconcileRepositories(store, async () => {
    calls += 1;
    return { kind: "unavailable" };
  });
  assert.equal(first.materialized.length, 1);
  assert.equal(first.github.length, 0);
  assert.equal(first.statuses[0]?.effectiveState, "disabled");
  assert.equal(calls, 0);
  const second = await reconcileRepositories(store, async () => {
    calls += 1;
    return { kind: "unavailable" };
  });
  assert.equal(second.materialized.length, 0);
  assert.equal(second.github.length, 0);
  assert.equal(calls, 0);
  assert.equal(store.activeCoreSnapshot()?.snapshotId, activation.snapshotId);
  store.close();
});

test("enabled repository reconciliation converges across store handles without duplicate facts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-repository-convergence-test-"));
  const path = join(directory, "control.db");
  const now = new Date("2026-08-16T20:30:00.000Z");
  const firstStore = new ControlPlaneStore(path, () => now);
  const candidate = await activationCandidate(enabledDeclaration(), "b".repeat(40), "c".repeat(40));
  const activation = firstStore.activateCoreSnapshot({ candidate, expectedLastTransactionSequence: 1 });
  firstStore.recordCoreSourceCheckEligible({
    checkId: "0198b5cb-9c40-7000-8000-000000000001",
    candidate,
    expectedLastTransactionSequence: 2,
  });
  const secondStore = new ControlPlaneStore(path, () => now);
  const authority = firstStore.materializeRepositoryCoreAuthority({
    expectedLastTransactionSequence: 3,
    coreSnapshotId: activation.snapshotId,
    repositoryId: "github.com:9001",
  });
  const replay = secondStore.materializeRepositoryCoreAuthority({
    expectedLastTransactionSequence: 3,
    coreSnapshotId: activation.snapshotId,
    repositoryId: "github.com:9001",
  });
  assert.deepEqual(replay, authority);

  let calls = 0;
  const inspect = async () => {
    calls += 1;
    return {
      kind: "found" as const,
      repositoryId: "9001",
      owner: "frostyard",
      name: "example",
      archived: false,
    };
  };
  const firstPass = await reconcileRepositories(secondStore, inspect);
  assert.equal(firstPass.materialized.length, 0);
  assert.equal(firstPass.github.length, 1);
  assert.equal(firstPass.statuses[0]?.effectiveState, "awaiting-surfaces");
  const secondPass = await reconcileRepositories(firstStore, inspect);
  assert.equal(secondPass.materialized.length, 0);
  assert.equal(secondPass.github.length, 0);
  assert.equal(calls, 1);
  assert.equal(firstStore.metadata().lastTransactionSequence, 5);
  assert.equal(
    firstStore.occurrences().filter((occurrence) => occurrence.kind === "repository.core-authorized").length,
    1,
  );
  assert.equal(
    firstStore.occurrences().filter((occurrence) => occurrence.kind === "repository.github-identity-reconciled").length,
    1,
  );
  secondStore.close();
  firstStore.close();
});

test("repository declaration removal fails validation while disabled retention remains valid", async () => {
  const active = validateCoreCatalog(await validCoreEntries(enabledDeclaration(), true));
  const removed = validateCoreCatalog(await validCoreEntries(enabledDeclaration(), false));
  assert.throws(
    () => assertRepositoryDeclarationRetention(active, removed),
    (error) =>
      error instanceof CoreValidationError &&
      /changed to disabled rather than removed/.test(error.message) &&
      error.details[0]?.includes("github.com") === false,
  );
  const disabled = validateCoreCatalog(
    await validCoreEntries(
      { ...enabledDeclaration(), fleet_state: "disabled", maintenance_programs: [], action_ceiling: [] },
      true,
    ),
  );
  assert.doesNotThrow(() => assertRepositoryDeclarationRetention(active, disabled));
});

test("automatic Core synchronization records declaration removal as candidate-invalid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-repository-retention-sync-test-"));
  const store = new ControlPlaneStore(
    join(directory, "control.db"),
    () => new Date("2026-08-16T21:00:00.000Z"),
  );
  const active = await activationCandidate(enabledDeclaration(), "7".repeat(40), "8".repeat(40));
  store.activateCoreSnapshot({ candidate: active, expectedLastTransactionSequence: 1 });
  const removedFiles = await validCoreEntries(enabledDeclaration(), false);
  const removed: InspectedCoreCandidate = {
    sourceUrl: active.sourceUrl,
    ref: active.ref,
    commitId: "9".repeat(40),
    treeId: "a".repeat(40),
    files: removedFiles,
    ...validateCoreCatalog(removedFiles),
  };
  const result = await synchronizeCoreSource(
    { sourceUrl: active.sourceUrl, ref: active.ref, mirrorPath: join(directory, "unused.git") },
    store,
    2,
    { inspectCandidate: async () => removed },
  );
  assert.equal(result.status, "rejected");
  assert.equal(result.outcome, "candidate-invalid");
  assert.equal(result.checkDisposition, "recorded");
  assert.equal(store.activeCoreSnapshot()?.sourceCommitId, active.commitId);
  assert.equal(store.coreCandidateRejections(1)[0]?.stage, "validation");
  store.close();
});

test("the GitHub adapter retains only selected metadata and bounds failures", async () => {
  const found = await inspectGitHubRepository(
    { owner: "frostyard", name: "example" },
    async (input, init) => {
      assert.equal(input, "https://api.github.com/repos/frostyard/example");
      assert.equal((init?.headers as Record<string, string>)["User-Agent"], "frostyard-fluent");
      assert.equal(init?.redirect, "manual");
      return new Response(
        JSON.stringify({
          id: 9001,
          name: "Example",
          owner: { login: "Frostyard", ignored: "not-retained" },
          archived: false,
          secret_noise: "not-retained",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );
  assert.deepEqual(found, {
    kind: "found",
    repositoryId: "9001",
    owner: "Frostyard",
    name: "Example",
    archived: false,
  });
  assert.deepEqual(
    await inspectGitHubRepository(
      { owner: "frostyard", name: "missing" },
      async () => new Response("not found", { status: 404 }),
    ),
    { kind: "missing" },
  );
  assert.deepEqual(
    await inspectGitHubRepository(
      { owner: "frostyard", name: "broken" },
      async () => new Response("upstream secret body", { status: 500 }),
    ),
    { kind: "unavailable" },
  );
  let externalRedirectRequests = 0;
  assert.deepEqual(
    await inspectGitHubRepository(
      { owner: "frostyard", name: "redirected" },
      async () => {
        externalRedirectRequests += 1;
        return new Response(null, {
          status: 301,
          headers: { location: "https://example.com/credential-sink" },
        });
      },
    ),
    { kind: "unavailable" },
  );
  assert.equal(externalRedirectRequests, 1);
  const sameOriginRequests: string[] = [];
  assert.deepEqual(
    await inspectGitHubRepository(
      { owner: "frostyard", name: "moved" },
      async (input) => {
        sameOriginRequests.push(String(input));
        if (sameOriginRequests.length === 1) {
          return new Response(null, {
            status: 301,
            headers: { location: "/repositories/9001" },
          });
        }
        return new Response(
          JSON.stringify({
            id: 9001,
            name: "moved",
            owner: { login: "frostyard" },
            archived: false,
          }),
          { status: 200 },
        );
      },
    ),
    {
      kind: "found",
      repositoryId: "9001",
      owner: "frostyard",
      name: "moved",
      archived: false,
    },
  );
  assert.deepEqual(sameOriginRequests, [
    "https://api.github.com/repos/frostyard/moved",
    "https://api.github.com/repositories/9001",
  ]);
});

function enabledDeclaration(): RepositoryDeclaration {
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

async function activationCandidate(
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

async function validCoreEntries(
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
    const bundled = await readFile(new URL(`../src/core/schemas/v1/${name}`, import.meta.url));
    entries.push(entryFor(`organization/schemas/v1/${name}`, bundled));
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
