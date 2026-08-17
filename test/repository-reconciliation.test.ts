import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ControlPlaneStore } from "../src/control/store.ts";
import type {
  RepositoryCoreAuthorityPayload,
  RepositoryEnrollmentPayload,
  RepositoryGitHubReconciliationPayload,
  RepositorySurfaceReconciliationPayload,
} from "../src/control/registry.ts";
import type { InspectedCoreCandidate } from "../src/core/git-source.ts";
import {
  CoreValidationError,
  assertRepositoryDeclarationRetention,
  validatedRepositorySurfaceContract,
  validateCoreCatalog,
  type CoreTreeEntry,
  type RepositoryDeclaration,
} from "../src/core/validator.ts";
import { reconcileRepositories } from "../src/repository/controller.ts";
import {
  evaluateRepositoryHeldWorkRecovery,
  repositoryAuthorityContextDigest,
} from "../src/repository/authority-context.ts";
import { inspectGitHubRepository } from "../src/repository/github.ts";
import {
  inspectRepositorySurfaces,
  repositoryGitBlobObjectId,
  repositoryGitTreeObjectId,
  type RepositorySurfaceTreeEntry,
} from "../src/repository/surfaces.ts";
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
      githubDefaultBranch: null,
      surfaceReconciliationRecordId: null,
      surfacePolicyDecisionRecordId: null,
      surfaceResult: null,
      repositoryCommitId: null,
      enrollmentRecordId: null,
      authorityContextDigest: null,
      operatorHold: null,
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
      defaultBranch: "main",
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
      defaultBranch: "main",
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

test("verified GitHub pull-request deliveries are enrollment-bound, replayable, and projection-safe", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-github-delivery-test-"));
  const path = join(directory, "control.db");
  let now = new Date("2026-08-17T12:00:00.000Z");
  const store = new ControlPlaneStore(path, () => now);
  const input = {
    appId: "4567",
    deliveryGuid: "12345678-1234-4234-8234-123456789abc",
    bodyDigest: `sha256:${"a".repeat(64)}`,
    requestBytes: 4096,
    installationId: "github.com:installation:7654",
    repositoryId: "github.com:9001",
    action: "synchronize" as const,
    pullRequest: {
      number: 42,
      actorId: "github.com:user:31415",
      state: "open" as const,
      draft: false,
      merged: false,
      baseRepositoryId: "github.com:9001",
      baseRef: "main",
      baseCommitId: `sha1:${"b".repeat(40)}`,
      headRepositoryId: "github.com:9001",
      headRef: "feature/test-gap",
      headCommitId: `sha1:${"c".repeat(40)}`,
      observedTestMergeCommitId: `sha1:${"d".repeat(40)}`,
      mergedAt: null,
      mergeCommitId: null,
      sourceUpdatedAt: "2026-08-17T11:59:00.000Z",
    },
  };

  assert.throws(
    () => store.recordVerifiedGitHubPullRequestDelivery(input),
    /previously enrolled repository/,
  );
  assert.equal(store.metadata().lastTransactionSequence, 1);

  const candidate = await activationCandidate(enabledDeclaration(), "7".repeat(40), "8".repeat(40));
  const activation = store.activateCoreSnapshot({ candidate, expectedLastTransactionSequence: 1 });
  store.recordCoreSourceCheckEligible({
    checkId: "0198b9fd-6200-7000-8000-000000000001",
    candidate,
    expectedLastTransactionSequence: activation.transactionSequence,
  });
  await reconcileRepositories(
    store,
    async () => ({
      kind: "found",
      repositoryId: "9001",
      owner: "frostyard",
      name: "example",
      archived: false,
      defaultBranch: "main",
    }),
    async () => validSurfaceProbe(),
  );
  assert.equal(store.repositoryStatuses()[0]?.effectiveState, "enrolled");

  now = new Date("2026-08-17T12:10:00.000Z");
  const before = store.metadata().lastTransactionSequence;
  const result = store.recordVerifiedGitHubPullRequestDelivery(input);
  assert.equal(result.transactionSequence, before + 1);
  assert.deepEqual(result.transactionPositions, [0, 1, 2]);
  assert.equal(store.projectionHealth()[0]?.status, "stale");
  const outputs = store.occurrences().slice(-3);
  assert.deepEqual(
    outputs.map((occurrence) => [occurrence.kind, occurrence.recordClass, occurrence.subjectKind]),
    [
      ["github.delivery-receipt-observation", "observation", "github-app-hook"],
      ["github.pull-request-observation", "observation", "github-pull-request"],
      ["github.delivery-recorded", undefined, "github-app-hook"],
    ],
  );
  assert.equal(outputs[0]?.sourceRevisionValue, input.bodyDigest);
  const observedPayload = outputs[1]?.payload as Record<string, unknown>;
  assert.equal(observedPayload.receiptRecordId, result.receiptRecordId);
  assert.equal("title" in observedPayload, false);
  assert.equal("body" in observedPayload, false);

  const replay = store.recordVerifiedGitHubPullRequestDelivery(input);
  assert.deepEqual(replay, result);
  assert.equal(store.metadata().lastTransactionSequence, result.transactionSequence);
  assert.throws(
    () => store.recordVerifiedGitHubPullRequestDelivery({ ...input, requestBytes: input.requestBytes + 1 }),
    /reused with different verified content/,
  );
  assert.equal(store.metadata().lastTransactionSequence, result.transactionSequence);

  store.rebuildProjections();
  const projected = store.projectedSubjects({
    maximumInformationClass: "organization",
    deploymentIds: [store.metadata().databaseLineageId],
  });
  assert.equal(projected.stale, false);
  assert.equal(
    projected.rows.find((subject) => subject.subjectId === "github.com:9001:pull:42")?.creationRecordId,
    result.observationRecordId,
  );
  store.close();

  const reopened = new ControlPlaneStore(path);
  assert.equal(reopened.metadata().lastTransactionSequence, result.transactionSequence);
  reopened.close();

  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE durable_occurrences SET causation_record_id = NULL WHERE record_id = ?").run(
    result.observationRecordId,
  );
  raw.close();
  assert.throws(() => new ControlPlaneStore(path), /GitHub pull-request delivery lineage mismatch/);
});

test("GitHub pull-request delivery rejects forks and closed-state test merge identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-github-delivery-shape-test-"));
  const store = new ControlPlaneStore(
    join(directory, "control.db"),
    () => new Date("2026-08-17T13:00:00.000Z"),
  );
  const base = {
    appId: "4567",
    deliveryGuid: "22345678-1234-4234-8234-123456789abc",
    bodyDigest: `sha256:${"e".repeat(64)}`,
    requestBytes: 512,
    installationId: "github.com:installation:7654",
    repositoryId: "github.com:9001",
    action: "closed" as const,
    pullRequest: {
      number: 7,
      actorId: "github.com:user:31415",
      state: "closed" as const,
      draft: false,
      merged: true,
      baseRepositoryId: "github.com:9001",
      baseRef: "main",
      baseCommitId: `sha1:${"1".repeat(40)}`,
      headRepositoryId: "github.com:9001",
      headRef: "feature/merged",
      headCommitId: `sha1:${"2".repeat(40)}`,
      observedTestMergeCommitId: `sha1:${"3".repeat(40)}`,
      mergedAt: "2026-08-17T12:59:00.000Z",
      mergeCommitId: `sha1:${"4".repeat(40)}`,
      sourceUpdatedAt: "2026-08-17T12:59:00.000Z",
    },
  };
  assert.throws(() => store.recordVerifiedGitHubPullRequestDelivery(base), /inconsistent merge shape/);
  assert.throws(
    () =>
      store.recordVerifiedGitHubPullRequestDelivery({
        ...base,
        pullRequest: {
          ...base.pullRequest,
          observedTestMergeCommitId: null,
          headRepositoryId: "github.com:9002",
        },
      }),
    /invalid identity or state fields/,
  );
  assert.equal(store.metadata().lastTransactionSequence, 1);
  store.close();
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
      { kind: "found" as const, repositoryId: "9002", owner: "other", name: "renamed", archived: true, defaultBranch: "main" },
      "identity-mismatch",
    ],
    [
      { kind: "found" as const, repositoryId: "9001", owner: "frostyard", name: "renamed", archived: true, defaultBranch: "main" },
      "locator-mismatch",
    ],
    [
      { kind: "found" as const, repositoryId: "9001", owner: "frostyard", name: "example", archived: true, defaultBranch: "main" },
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
      defaultBranch: "main",
    };
  };
  const inspectSurfaces = async () => validSurfaceProbe();
  const firstPass = await reconcileRepositories(secondStore, inspect, inspectSurfaces);
  assert.equal(firstPass.materialized.length, 0);
  assert.equal(firstPass.github.length, 1);
  assert.equal(firstPass.surfaces.length, 1);
  assert.equal(firstPass.enrollments.length, 1);
  assert.equal(firstPass.statuses[0]?.effectiveState, "enrolled");
  const initialAuthorityContextDigest = firstPass.statuses[0]?.authorityContextDigest;
  assert.match(initialAuthorityContextDigest ?? "", /^sha256:[0-9a-f]{64}$/);
  const payloadFor = <T>(kind: string): T =>
    firstStore.occurrences().find((occurrence) => occurrence.kind === kind)!.payload as T;
  const changedSurface = structuredClone(
    payloadFor<RepositorySurfaceReconciliationPayload>("repository.canonical-surfaces-reconciled"),
  );
  const changedEnrollment = structuredClone(
    payloadFor<RepositoryEnrollmentPayload>("repository.enrolled"),
  );
  changedSurface.repositoryCommitId = "f".repeat(40);
  changedEnrollment.repositoryCommitId = "f".repeat(40);
  assert.notEqual(
    repositoryAuthorityContextDigest({
      authority: payloadFor<RepositoryCoreAuthorityPayload>("repository.core-authorized"),
      github: payloadFor<RepositoryGitHubReconciliationPayload>("repository.github-identity-reconciled"),
      surfaces: changedSurface,
      enrollment: changedEnrollment,
    }),
    initialAuthorityContextDigest,
  );
  const initialSurfaceDecision = firstStore
    .occurrences()
    .find((occurrence) => occurrence.kind === "repository.enrollment-checkpoint-policy-decision");
  assert.ok(initialSurfaceDecision);
  const initialDecisionPayload = initialSurfaceDecision.payload as {
    checkpoint: string;
    decision: string;
    exceptionRecordIds: unknown[];
    requirementResults: Array<{ result: string; evidenceDigest: string | null }>;
  };
  assert.equal(initialDecisionPayload.checkpoint, "repository-enrollment");
  assert.equal(initialDecisionPayload.decision, "permit");
  assert.deepEqual(initialDecisionPayload.exceptionRecordIds, []);
  assert.deepEqual(
    initialDecisionPayload.requirementResults.map((requirement) => requirement.result),
    ["pass", "pass", "pass", "pass"],
  );
  assert.equal(
    initialDecisionPayload.requirementResults.every((requirement) => requirement.evidenceDigest !== null),
    true,
  );
  const secondPass = await reconcileRepositories(firstStore, inspect, inspectSurfaces);
  assert.equal(secondPass.materialized.length, 0);
  assert.equal(secondPass.github.length, 1);
  assert.equal(secondPass.surfaces.length, 1);
  assert.equal(secondPass.enrollments.length, 1);
  assert.equal(calls, 2);
  assert.equal(firstStore.metadata().lastTransactionSequence, 7);
  assert.equal(
    firstStore.occurrences().filter((occurrence) => occurrence.kind === "repository.core-authorized").length,
    1,
  );
  assert.equal(
    firstStore.occurrences().filter((occurrence) => occurrence.kind === "repository.github-identity-reconciled").length,
    1,
  );
  assert.equal(
    firstStore.occurrences().filter((occurrence) => occurrence.kind === "repository.canonical-surfaces-reconciled").length,
    1,
  );
  assert.equal(
    firstStore.occurrences().filter((occurrence) => occurrence.kind === "repository.enrolled").length,
    1,
  );
  const outage = await reconcileRepositories(firstStore, async () => ({ kind: "unavailable" }), inspectSurfaces);
  assert.equal(outage.statuses[0]?.effectiveState, "github-held");
  assert.equal(outage.statuses[0]?.authorityContextDigest, null);
  assert.deepEqual(
    evaluateRepositoryHeldWorkRecovery({
      cause: "github-unavailable",
      heldAuthorityContextDigest: initialAuthorityContextDigest!,
      currentAuthorityContextDigest: outage.statuses[0]?.authorityContextDigest ?? null,
      currentRepositoryState: outage.statuses[0]!.effectiveState,
    }),
    { decision: "remain-held", reason: "repository-not-enrolled" },
  );
  const recovery = await reconcileRepositories(firstStore, inspect, inspectSurfaces);
  assert.equal(recovery.statuses[0]?.effectiveState, "enrolled");
  assert.equal(recovery.statuses[0]?.authorityContextDigest, initialAuthorityContextDigest);
  assert.deepEqual(
    evaluateRepositoryHeldWorkRecovery({
      cause: "github-unavailable",
      heldAuthorityContextDigest: initialAuthorityContextDigest!,
      currentAuthorityContextDigest: recovery.statuses[0]?.authorityContextDigest ?? null,
      currentRepositoryState: recovery.statuses[0]!.effectiveState,
    }),
    { decision: "resume-automatically", reason: "unchanged-transient-outage" },
  );
  assert.equal(firstStore.metadata().lastTransactionSequence, 11);
  assert.equal(
    firstStore.occurrences().filter((occurrence) => occurrence.kind === "repository.github-identity-reconciled").length,
    3,
  );
  assert.equal(
    firstStore.occurrences().filter((occurrence) => occurrence.kind === "repository.canonical-surfaces-reconciled").length,
    2,
  );
  assert.equal(
    firstStore.occurrences().filter((occurrence) => occurrence.kind === "repository.enrolled").length,
    2,
  );
  const surfaceOutage = await reconcileRepositories(
    firstStore,
    inspect,
    async () => ({ kind: "unavailable" }),
  );
  assert.equal(surfaceOutage.statuses[0]?.effectiveState, "surface-held");
  assert.equal(surfaceOutage.statuses[0]?.surfaceResult, "unavailable");
  assert.equal(surfaceOutage.statuses[0]?.authorityContextDigest, null);
  const outageDecision = firstStore
    .occurrences()
    .filter((occurrence) => occurrence.kind === "repository.enrollment-checkpoint-policy-decision")
    .at(-1)?.payload as { decision: string; requirementResults: Array<{ result: string }> };
  assert.equal(outageDecision.decision, "deny");
  assert.deepEqual(outageDecision.requirementResults.map((requirement) => requirement.result), [
    "unknown",
    "unknown",
    "unknown",
    "unknown",
  ]);
  const missingSurface = await reconcileRepositories(firstStore, inspect, async () => missingSurfaceProbe());
  assert.equal(missingSurface.statuses[0]?.surfaceResult, "missing");
  const wrongTypeSurface = await reconcileRepositories(firstStore, inspect, async () => wrongTypeSurfaceProbe());
  assert.equal(wrongTypeSurface.statuses[0]?.surfaceResult, "wrong-type");
  const invalidSurface = await reconcileRepositories(firstStore, inspect, async () => invalidGovernanceSurfaceProbe());
  assert.equal(invalidSurface.statuses[0]?.surfaceResult, "invalid");
  const invalidDecision = firstStore
    .occurrences()
    .filter((occurrence) => occurrence.kind === "repository.enrollment-checkpoint-policy-decision")
    .at(-1)?.payload as {
      decision: string;
      requirementResults: Array<{ result: string; evidenceDigest: string | null }>;
    };
  assert.equal(invalidDecision.decision, "deny");
  assert.deepEqual(invalidDecision.requirementResults.map((requirement) => requirement.result), [
    "pass",
    "fail",
    "unknown",
    "unknown",
  ]);
  assert.notEqual(invalidDecision.requirementResults[1]?.evidenceDigest, null);
  const surfaceRecovery = await reconcileRepositories(firstStore, inspect, inspectSurfaces);
  assert.equal(surfaceRecovery.statuses[0]?.effectiveState, "enrolled");
  assert.equal(surfaceRecovery.statuses[0]?.authorityContextDigest, initialAuthorityContextDigest);
  assert.equal(firstStore.metadata().lastTransactionSequence, 17);
  assert.equal(
    firstStore.occurrences().filter((occurrence) => occurrence.kind === "repository.canonical-surfaces-reconciled").length,
    7,
  );
  assert.equal(
    firstStore.occurrences().filter((occurrence) => occurrence.kind === "repository.enrolled").length,
    3,
  );
  const hold = firstStore.imposeRepositoryOperatorHold({
    expectedLastTransactionSequence: 17,
    repositoryId: "github.com:9001",
    reason: "Stop new repository activity during incident review",
  });
  assert.equal(hold.transactionSequence, 18);
  assert.equal(hold.choice, "impose");
  assert.deepEqual(
    firstStore.imposeRepositoryOperatorHold({
      expectedLastTransactionSequence: 17,
      repositoryId: "github.com:9001",
      reason: "Stop new repository activity during incident review",
    }),
    hold,
  );
  assert.equal(firstStore.repositoryStatuses()[0]?.effectiveState, "operator-held");
  assert.equal(firstStore.repositoryStatuses()[0]?.authorityContextDigest, null);
  assert.deepEqual(firstStore.repositoryStatuses()[0]?.operatorHold?.affectedGates, [
    "discovery",
    "admission",
    "claim",
    "lease-renewal",
  ]);
  const heldPass = await reconcileRepositories(
    firstStore,
    async () => {
      throw new Error("identity inspection must not run under an operator hold");
    },
    async () => {
      throw new Error("surface inspection must not run under an operator hold");
    },
  );
  assert.equal(heldPass.github.length, 0);
  assert.equal(heldPass.surfaces.length, 0);
  assert.equal(heldPass.enrollments.length, 0);
  assert.equal(firstStore.metadata().lastTransactionSequence, 18);
  assert.throws(
    () =>
      firstStore.imposeRepositoryOperatorHold({
        expectedLastTransactionSequence: 18,
        repositoryId: "github.com:9001",
        reason: "Replace the existing incident hold",
      }),
    /already has active operator hold/,
  );

  const nextCandidate = await activationCandidate(enabledDeclaration(), "1".repeat(40), "2".repeat(40));
  const nextActivation = firstStore.rollbackCoreSnapshot({
    candidate: nextCandidate,
    expectedLastTransactionSequence: 18,
    reason: "Exercise hold continuity across a Core authority transition",
  });
  firstStore.recordCoreSourceCheckEligible({
    checkId: "0198b5cb-9c40-7000-8000-000000000002",
    candidate: nextCandidate,
    expectedLastTransactionSequence: 19,
  });
  assert.equal(firstStore.repositoryStatuses()[0]?.effectiveState, "awaiting-authority");
  assert.equal(firstStore.repositoryStatuses()[0]?.operatorHold?.holdDecisionId, hold.holdDecisionId);
  const heldAfterCoreChange = await reconcileRepositories(
    firstStore,
    async () => {
      throw new Error("identity inspection must remain stopped after a Core change");
    },
    async () => {
      throw new Error("surface inspection must remain stopped after a Core change");
    },
  );
  assert.equal(heldAfterCoreChange.materialized.length, 1);
  assert.equal(heldAfterCoreChange.statuses[0]?.effectiveState, "operator-held");
  assert.equal(firstStore.metadata().lastTransactionSequence, 21);

  const heldAuthority = firstStore.repositoryStatuses()[0]?.coreAuthorizationRecordId;
  assert.ok(heldAuthority);
  const heldIdentity = firstStore.recordRepositoryGitHubIdentity({
    expectedLastTransactionSequence: 21,
    coreAuthorizationRecordId: heldAuthority,
    inspection: await inspect(),
  });
  const heldSurface = firstStore.recordRepositoryCanonicalSurfaces({
    expectedLastTransactionSequence: 22,
    githubReconciliationRecordId: heldIdentity.reconciliationRecordId,
    probe: validSurfaceProbe(),
  });
  assert.throws(
    () =>
      firstStore.establishRepositoryEnrollment({
        expectedLastTransactionSequence: 23,
        surfaceReconciliationRecordId: heldSurface.reconciliationRecordId,
      }),
    /prerequisites are not current/,
  );
  const cleared = firstStore.clearRepositoryOperatorHold({
    expectedLastTransactionSequence: 23,
    repositoryId: "github.com:9001",
    holdDecisionId: hold.holdDecisionId,
    reason: "Incident review completed",
  });
  assert.equal(cleared.choice, "clear");
  assert.deepEqual(
    firstStore.clearRepositoryOperatorHold({
      expectedLastTransactionSequence: 23,
      repositoryId: "github.com:9001",
      holdDecisionId: hold.holdDecisionId,
      reason: "Incident review completed",
    }),
    cleared,
  );
  assert.equal(firstStore.repositoryStatuses()[0]?.operatorHold, null);
  assert.equal(firstStore.repositoryStatuses()[0]?.effectiveState, "awaiting-enrollment");
  assert.throws(
    () =>
      firstStore.clearRepositoryOperatorHold({
        expectedLastTransactionSequence: 24,
        repositoryId: "github.com:9001",
        holdDecisionId: hold.holdDecisionId,
        reason: "Clear the same hold again",
      }),
    /does not name the exact active hold/,
  );
  const afterClear = await reconcileRepositories(firstStore, inspect, inspectSurfaces);
  assert.equal(afterClear.statuses[0]?.effectiveState, "enrolled");
  assert.equal(afterClear.statuses[0]?.coreSnapshotId, nextActivation.snapshotId);
  assert.notEqual(afterClear.statuses[0]?.authorityContextDigest, initialAuthorityContextDigest);
  assert.deepEqual(
    evaluateRepositoryHeldWorkRecovery({
      cause: "operator-hold",
      heldAuthorityContextDigest: initialAuthorityContextDigest!,
      currentAuthorityContextDigest: afterClear.statuses[0]?.authorityContextDigest ?? null,
      currentRepositoryState: afterClear.statuses[0]!.effectiveState,
    }),
    { decision: "require-operator-disposition", reason: "authority-context-changed" },
  );
  assert.equal(firstStore.metadata().lastTransactionSequence, 25);
  secondStore.close();
  firstStore.close();
  const reopened = new ControlPlaneStore(path);
  assert.equal(reopened.repositoryStatuses()[0]?.effectiveState, "enrolled");
  assert.equal(
    reopened.repositoryStatuses()[0]?.authorityContextDigest,
    afterClear.statuses[0]?.authorityContextDigest,
  );
  reopened.close();
});

test("held work never auto-resumes after a non-transient hold even when context is unchanged", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  for (const cause of [
    "core-paused",
    "core-disabled",
    "operator-hold",
    "github-reconciliation-failure",
    "surface-validation-failure",
    "authority-context-changed",
  ] as const) {
    assert.deepEqual(
      evaluateRepositoryHeldWorkRecovery({
        cause,
        heldAuthorityContextDigest: digest,
        currentAuthorityContextDigest: digest,
        currentRepositoryState: "enrolled",
      }),
      { decision: "require-operator-disposition", reason: "non-transient-hold" },
    );
  }
  assert.throws(
    () =>
      evaluateRepositoryHeldWorkRecovery({
        cause: "github-unavailable",
        heldAuthorityContextDigest: "not-a-digest",
        currentAuthorityContextDigest: digest,
        currentRepositoryState: "enrolled",
      }),
    /valid authority-context digest/,
  );
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
          default_branch: "main",
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
    defaultBranch: "main",
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
            default_branch: "main",
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
      defaultBranch: "main",
    },
  );
  assert.deepEqual(sameOriginRequests, [
    "https://api.github.com/repos/frostyard/moved",
    "https://api.github.com/repositories/9001",
  ]);
});

test("the surface adapter pins one commit and loads only canonical Git objects", async () => {
  const coreEntries = await validCoreEntries(enabledDeclaration(), true);
  const contract = validatedRepositorySurfaceContract(coreEntries, 1).contract;
  const requested: string[] = [];
  const bytes = {
    "1": Buffer.from("# Agent instructions\n"),
    "2": json(validGovernance()),
    "4": Buffer.from("# Documentation\n"),
  } as const;
  const blobIds = Object.fromEntries(
    Object.entries(bytes).map(([id, content]) => [id, repositoryGitBlobObjectId(content)]),
  ) as Record<keyof typeof bytes, string>;
  const skillsEntries: RepositorySurfaceTreeEntry[] = [];
  const skillsTreeId = repositoryGitTreeObjectId(skillsEntries);
  const policiesEntries: RepositorySurfaceTreeEntry[] = [
    { path: "agent-governance.json", mode: "100644", type: "blob", objectId: blobIds["2"], size: bytes["2"].byteLength },
  ];
  const policiesTreeId = repositoryGitTreeObjectId(policiesEntries);
  const agentsEntries: RepositorySurfaceTreeEntry[] = [
    { path: "skills", mode: "040000", type: "tree", objectId: skillsTreeId, size: null },
  ];
  const agentsTreeId = repositoryGitTreeObjectId(agentsEntries);
  const docsEntries: RepositorySurfaceTreeEntry[] = [
    { path: "README.md", mode: "100644", type: "blob", objectId: blobIds["4"], size: bytes["4"].byteLength },
  ];
  const docsTreeId = repositoryGitTreeObjectId(docsEntries);
  const rootEntries: RepositorySurfaceTreeEntry[] = [
    { path: "AGENTS.md", mode: "100644", type: "blob", objectId: blobIds["1"], size: bytes["1"].byteLength },
    { path: "policies", mode: "040000", type: "tree", objectId: policiesTreeId, size: null },
    { path: ".agents", mode: "040000", type: "tree", objectId: agentsTreeId, size: null },
    { path: "docs", mode: "040000", type: "tree", objectId: docsTreeId, size: null },
  ];
  const rootTreeId = repositoryGitTreeObjectId(rootEntries);
  const response = await inspectRepositorySurfaces(
    { owner: "frostyard", name: "example", defaultBranch: "main", contract },
    async (input) => {
      const url = String(input);
      requested.push(url);
      const path = new URL(url).pathname;
      if (path.endsWith("/commits/main")) {
        return Response.json({ sha: "d".repeat(40), commit: { tree: { sha: rootTreeId } } });
      }
      const treeId = path.match(/\/git\/trees\/([0-9a-f]{40})$/)?.[1];
      if (treeId) {
        const trees: Record<string, unknown[]> = {
          [rootTreeId]: rootEntries.map(githubTreeEntry),
          [policiesTreeId]: policiesEntries.map(githubTreeEntry),
          [agentsTreeId]: agentsEntries.map(githubTreeEntry),
          [skillsTreeId]: [],
          [docsTreeId]: docsEntries.map(githubTreeEntry),
        };
        return Response.json({ sha: treeId, truncated: false, tree: trees[treeId] });
      }
      const requestedBlobId = path.match(/\/git\/blobs\/([0-9a-f]{40})$/)?.[1];
      const blobId = (Object.keys(blobIds) as Array<keyof typeof bytes>).find((id) => blobIds[id] === requestedBlobId);
      if (blobId) {
        return Response.json({
          sha: blobIds[blobId],
          encoding: "base64",
          size: bytes[blobId].byteLength,
          content: bytes[blobId].toString("base64"),
        });
      }
      return new Response(null, { status: 404 });
    },
  );
  assert.equal(response.kind, "resolved");
  if (response.kind !== "resolved") return;
  assert.equal(response.repositoryCommitId, "d".repeat(40));
  assert.equal(response.repositoryTreeId, rootTreeId);
  assert.deepEqual(response.surfaces.map((surface) => [surface.surfaceId, surface.kind]), [
    ["agent-instructions", "found"],
    ["agent-governance", "found"],
    ["agent-skills", "found"],
    ["documentation-index", "found"],
  ]);
  assert.equal(requested.every((url) => url.startsWith("https://api.github.com/repos/frostyard/example/")), true);
  assert.equal(requested.filter((url) => url.includes("/commits/")).length, 1);
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
    const bundled = await readFile(new URL(`../src/core/schemas/v1/${name}`, import.meta.url));
    entries.push(entryFor(`organization/schemas/v1/${name}`, bundled));
  }
  return entries;
}

function validGovernance() {
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

function validSurfaceProbe() {
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

function missingSurfaceProbe() {
  const probe = validSurfaceProbe();
  return {
    ...probe,
    surfaces: probe.surfaces.map((surface) =>
      surface.surfaceId === "documentation-index"
        ? { surfaceId: "documentation-index", path: "docs/README.md", kind: "missing" as const }
        : surface,
    ),
  };
}

function wrongTypeSurfaceProbe() {
  const probe = validSurfaceProbe();
  return {
    ...probe,
    surfaces: probe.surfaces.map((surface) =>
      surface.surfaceId === "agent-instructions"
        ? {
            ...surface,
            mode: "120000",
            objectType: "blob" as const,
          }
        : surface,
    ),
  };
}

function invalidGovernanceSurfaceProbe() {
  const probe = validSurfaceProbe();
  const invalid = Buffer.from('{"schema_version":1}');
  return {
    ...probe,
    surfaces: probe.surfaces.map((surface) =>
      surface.surfaceId === "agent-governance"
        ? { ...surface, objectId: repositoryGitBlobObjectId(invalid), bytes: invalid }
        : surface,
    ),
  };
}

function githubTreeEntry(entry: RepositorySurfaceTreeEntry) {
  return {
    path: entry.path,
    mode: entry.mode,
    type: entry.type,
    sha: entry.objectId,
    ...(entry.size === null ? {} : { size: entry.size }),
  };
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
