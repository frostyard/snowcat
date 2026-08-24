import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ControlPlaneStore } from "../src/control/store.ts";
import { controlPlanePolicyAuthority } from "../src/queue/policy-authority.ts";
import { QueueStore, SCHEMA_VERSION, type PolicyAuthority } from "../src/queue/store.ts";
import { enrollExampleRepository } from "./helpers/core-fixtures.ts";

const REPOSITORY = "frostyard/updex";

function authority(overrides: Partial<PolicyAuthority> = {}): PolicyAuthority {
  return {
    coreSnapshotId: "sha256:" + "a".repeat(64),
    repositoryCommitId: "b".repeat(40),
    actionCeiling: ["read", "write", "run-tests", "open-issue", "open-pr", "create-followup"],
    defaultDecision: "deny",
    actionDecisions: {
      read: "allow",
      write: "allow",
      "run-tests": "allow",
      "open-issue": "review-required",
      "open-pr": "review-required",
      "create-followup": "review-required",
    },
    protectedBoundaries: [{ id: "workflow-and-permissions", decision: "review-required", minimumRiskTier: "high", paths: [".github/workflows/**"] }],
    ...overrides,
  };
}

function seedInput(overrides: Record<string, unknown> = {}) {
  return {
    repository: REPOSITORY,
    kind: "issue-resolution",
    objective: "Resolve it.",
    instructions: "Do it.",
    acceptanceCriteria: ["Done."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    requiredArtifact: "pull-request",
    executionTarget: "new-pull-request",
    createdBy: "operator:test",
    ...overrides,
  } as never;
}

test("definitions bind to the policy authority: ceiling and deny enforced, review-required recorded, operator admission is its own evidence (ADR-0074)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-policy-admission-test-"));
  const queue = new QueueStore(join(directory, "queue.db"), undefined, { policyAuthority: () => authority() });
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);

  // The binding is stamped, with the admitted-on-creation operator evidence.
  const seeded = queue.enqueueSeed(seedInput());
  assert.equal(seeded.policy?.coreSnapshotId, "sha256:" + "a".repeat(64));
  assert.equal(seeded.policy?.repositoryCommitId, "b".repeat(40));
  assert.deepEqual(seeded.policy?.reviewRequired, ["open-pr"]);
  assert.equal(seeded.policy?.authorization?.kind, "operator");
  assert.equal(seeded.policy?.authorization?.actor, "operator:test");
  assert.deepEqual(seeded.policy?.authorization?.coveredActions, ["open-pr"]);

  // Deny refuses; the ceiling refuses; delegable actions count too.
  const denying = new QueueStore(join(directory, "deny.db"), undefined, {
    policyAuthority: () => authority({ actionDecisions: { ...authority().actionDecisions, write: "deny" } }),
  });
  test.after(() => denying.close());
  denying.setRepositoryEnabled(REPOSITORY, true);
  assert.throws(() => denying.enqueueSeed(seedInput()), /action write is denied by frostyard\/updex's governance policy/);

  const ceiled = new QueueStore(join(directory, "ceiling.db"), undefined, {
    policyAuthority: () => authority({ actionCeiling: ["read", "run-tests"] }),
  });
  test.after(() => ceiled.close());
  ceiled.setRepositoryEnabled(REPOSITORY, true);
  assert.throws(() => ceiled.enqueueSeed(seedInput()), /action write exceeds frostyard\/updex's Core action ceiling/);
  assert.throws(
    () =>
      ceiled.enqueueSeed(
        seedInput({ allowedActions: ["read"], delegableActions: ["read", "open-pr"], requiredArtifact: "none", executionTarget: "read-only" }),
      ),
    /action open-pr exceeds/,
    "delegable actions sit inside the ceiling too",
  );

  // A configured hook that cannot vouch fails the definition closed.
  const unvouched = new QueueStore(join(directory, "unvouched.db"), undefined, { policyAuthority: () => undefined });
  test.after(() => unvouched.close());
  unvouched.setRepositoryEnabled(REPOSITORY, true);
  assert.throws(() => unvouched.enqueueSeed(seedInput()), /no policy authority for frostyard\/updex/);
});

test("admission re-binds against the current authority, records the satisfier, and fails closed when the authority is gone", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-policy-approve-test-"));
  let current: PolicyAuthority | undefined = authority();
  const queue = new QueueStore(join(directory, "queue.db"), undefined, { policyAuthority: () => current });
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);

  const { created } = queue.enqueueProposedRoots(REPOSITORY, [
    {
      sourceRef: `https://github.com/${REPOSITORY}/issues/5`,
      kind: "issue-resolution",
      objective: "Resolve #5.",
      instructions: "Do it.",
      acceptanceCriteria: ["Done."],
      allowedActions: ["read", "write", "run-tests", "open-pr"],
      delegableActions: [],
      requiredArtifact: "pull-request",
      executionTarget: "new-pull-request",
      createdBy: "operator:import-issues",
    } as never,
  ]);
  const proposal = created[0]!;
  assert.equal(proposal.policy?.authorization, undefined, "a proposal has a binding but no admission evidence yet");

  // The authority moved between definition and admission: admission re-binds.
  current = authority({ repositoryCommitId: "c".repeat(40) });
  const approved = queue.approve(proposal.id, "operator:bjk");
  assert.equal(approved.policy?.repositoryCommitId, "c".repeat(40), "admission binds what was actually judged");
  assert.equal(approved.policy?.authorization?.kind, "operator");
  assert.equal(approved.policy?.authorization?.actor, "operator:bjk");
  assert.deepEqual(approved.policy?.authorization?.coveredActions, ["open-pr"]);
  const approvedEvent = queue.events(proposal.id).find((event) => event.type === "work.approved")!;
  assert.deepEqual(approvedEvent.payload.policy, {
    coreSnapshotId: authority().coreSnapshotId,
    repositoryCommitId: "c".repeat(40),
    coveredActions: ["open-pr"],
  });

  // Authority unavailable at admission: the item stays proposed.
  const { created: again } = queue.enqueueProposedRoots(REPOSITORY, [
    {
      sourceRef: `https://github.com/${REPOSITORY}/issues/6`,
      kind: "issue-resolution",
      objective: "Resolve #6.",
      instructions: "Do it.",
      acceptanceCriteria: ["Done."],
      allowedActions: ["read", "write", "run-tests", "open-pr"],
      delegableActions: [],
      requiredArtifact: "pull-request",
      executionTarget: "new-pull-request",
      createdBy: "operator:import-issues",
    } as never,
  ]);
  current = undefined;
  assert.throws(() => queue.approve(again[0]!.id, "operator:bjk"), /no policy authority/);
  assert.equal(queue.get(again[0]!.id)?.status, "proposed", "fail closed: still proposed");

  // A policy that tightened to deny between definition and admission refuses admission.
  current = authority({ actionDecisions: { ...authority().actionDecisions, write: "deny" } });
  assert.throws(() => queue.approve(again[0]!.id, "operator:bjk"), /denied by/);
  assert.equal(queue.get(again[0]!.id)?.status, "proposed");
});

test("a policy-attributed creator needs a standing authorization: registered kinds record it, everything else cannot mint admitted work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-policy-standing-test-"));
  const queue = new QueueStore(join(directory, "queue.db"), undefined, { policyAuthority: () => authority() });
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);

  const head = "d".repeat(40);
  const review = queue.enqueueReviewRoot(REPOSITORY, {
    sourceRef: `pr-review:https://github.com/${REPOSITORY}/pull/9@${head}`,
    kind: "pr-review",
    objective: "Review #9.",
    instructions: "Judge it.",
    acceptanceCriteria: ["Verdict supplied."],
    allowedActions: ["read", "run-tests"],
    delegableActions: [],
    requiredArtifact: "none",
    executionTarget: "read-only",
    createdBy: "policy:review-gate",
    review: { pullRequestUrl: `https://github.com/${REPOSITORY}/pull/9`, headSha: head, round: 1, priorBlockers: [] },
  } as never)!;
  assert.equal(review.policy?.authorization?.kind, "standing");
  assert.equal(review.policy?.authorization?.standingId, "pr-review:v1");
  assert.equal(review.policy?.authorization?.adr, "ADR-0065");

  // An unregistered mechanically admitted kind is refused outright.
  assert.throws(
    () =>
      queue.enqueueSeed(
        seedInput({ kind: "self-authorized-sweep", createdBy: "policy:new-sweep", allowedActions: ["read"], delegableActions: [], requiredArtifact: "none", executionTarget: "read-only" }),
      ),
    /no standing authorization covers mechanically admitted kind self-authorized-sweep/,
  );
});

test("a version-16 database gains the nullable rung-17 column; unbound legacy is audited only when a control plane is configured", async () => {
  assert.equal(SCHEMA_VERSION, 17, "this test pins the ladder at rung 17; extend it when a rung is added");
  const directory = await mkdtemp(join(tmpdir(), "snowcat-policy-ladder-test-"));
  const path = join(directory, "queue.db");
  const unhooked = new QueueStore(path);
  unhooked.setRepositoryEnabled(REPOSITORY, true);
  const legacy = unhooked.enqueueSeed(seedInput());
  assert.equal(legacy.policy, undefined, "no hook: defined unbound, exactly as before ADR-0074");
  // Without a control plane the audit stays quiet about policy.
  assert.deepEqual(unhooked.auditContracts({ repository: REPOSITORY }), []);
  unhooked.close();

  const raw = new DatabaseSync(path);
  raw.exec("ALTER TABLE work_items DROP COLUMN policy_json; PRAGMA user_version = 16;");
  raw.close();

  const migrated = new QueueStore(path, undefined, { policyAuthority: () => authority() });
  test.after(() => migrated.close());
  assert.equal(migrated.schemaVersion(), SCHEMA_VERSION);
  assert.equal(migrated.get(legacy.id)?.policy, undefined, "the pre-rung row reads as unbound, never back-filled");
  const findings = migrated.auditContracts({ repository: REPOSITORY });
  assert.deepEqual(
    findings.map((finding) => [finding.id, finding.problem]),
    [[legacy.id, "unbound-policy"]],
  );
  // Unbound legacy is still claimable.
  assert.equal(migrated.claim({ worker: "claude:updex:legacy" })?.id, legacy.id);
});

test("the control-plane-backed hook answers for an enrolled repository and fails closed otherwise", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-policy-control-test-"));
  const controlPath = join(directory, "control.db");
  const control = new ControlPlaneStore(controlPath, () => new Date("2026-08-24T03:00:00.000Z"));
  await enrollExampleRepository(control);
  control.close();

  const hook = controlPlanePolicyAuthority(controlPath);
  const answer = hook("frostyard/example");
  assert.ok(answer, "the enrolled repository has an authority");
  assert.deepEqual(answer!.actionCeiling, ["read", "write", "run-tests", "open-issue", "open-pr", "create-followup"]);
  assert.equal(answer!.defaultDecision, "deny");
  assert.equal(answer!.actionDecisions.read, "allow");
  assert.equal(answer!.actionDecisions["open-pr"], "review-required");
  assert.deepEqual(answer!.protectedBoundaries, [
    { id: "workflow-and-permissions", decision: "review-required", minimumRiskTier: "high", paths: [".github/workflows/**"] },
  ]);
  assert.ok(answer!.coreSnapshotId.length > 0);
  assert.equal(typeof answer!.repositoryCommitId, "string");

  assert.equal(hook("frostyard/unknown"), undefined, "an unenrolled repository has no authority");
  assert.equal(controlPlanePolicyAuthority(join(directory, "missing.db"))("frostyard/example"), undefined, "a missing database fails closed");
});
