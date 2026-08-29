import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { enqueueTestingGap as seedTestingGap } from "../src/queue/seeds.ts";
import { contractProblem, QueueStore } from "../src/queue/store.ts";
import type { AllowedAction } from "../src/queue/types.ts";
import { childEnvironment } from "./helpers/child-environment.ts";

const REPOSITORY = "frostyard/updex";
const PR_URL = "https://github.com/frostyard/updex/pull/41";
const COMMIT_URL = "https://github.com/frostyard/updex/commit/0123456789abcdef0123456789abcdef01234567";

async function openQueue(label: string): Promise<{ queue: QueueStore; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), `snowcat-${label}-`));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);
  return { queue, path };
}

const implementationChild = {
  kind: "quality-implementation",
  objective: "Fix the gap.",
  instructions: "Patch, test, and open one pull request.",
  acceptanceCriteria: ["The regression test passes on the pull request head."],
  allowedActions: ["read", "write", "run-tests", "open-pr", "create-followup"] as AllowedAction[],
  delegableActions: ["read", "create-followup"] as AllowedAction[],
  requiredArtifact: "pull-request" as const,
  executionTarget: "new-pull-request" as const,
};

/** Writes one proposed child row that bypasses the store's checks, as a row created before ADR-0069 would read. */
function insertLegacyProposal(queue: QueueStore, parentId: string, allowedActions: string[], serial = 1, requiredArtifact = "none"): string {
  const id = `aaaaaaaa-0000-4000-8000-00000000000${serial}`;
  const db = (queue as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): unknown } } }).db;
  db.prepare(
    `INSERT INTO work_items (id, root_id, parent_id, repository, kind, objective, instructions, acceptance_criteria_json,
       allowed_actions_json, delegable_actions_json, required_artifact, priority, status, admitted, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'quality-implementation', 'Legacy change.', 'Edit files.', '["Done."]', ?, '[]', ?, 0, 'queued', 0, 'claude:legacy', ?, ?)`,
  ).run(id, parentId, parentId, REPOSITORY, JSON.stringify(allowedActions), requiredArtifact, "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.000Z");
  return id;
}

test("contractProblem names exactly the three undeliverable shapes and nothing else", () => {
  assert.equal(contractProblem({ allowedActions: ["read"], requiredArtifact: "none" }), undefined);
  assert.equal(contractProblem({ allowedActions: ["read", "write", "run-tests", "open-pr"], requiredArtifact: "none" }), undefined, "a root may write without promising a pull request (release-needed)");
  assert.equal(contractProblem({ allowedActions: ["read", "write", "open-pr"], requiredArtifact: "pull-request", parentId: "p" }), undefined);
  assert.equal(contractProblem({ allowedActions: ["read", "open-pr"], requiredArtifact: "pull-request" }), undefined);
  assert.equal(contractProblem({ allowedActions: ["read"], requiredArtifact: "pull-request" })?.code, "required-pull-request-without-open-pr");
  assert.equal(contractProblem({ allowedActions: ["read", "write", "run-tests"], requiredArtifact: "none" })?.code, "write-without-open-pr");
  assert.equal(contractProblem({ allowedActions: ["read", "write", "open-pr"], requiredArtifact: "none", parentId: "p" })?.code, "child-write-without-required-pull-request");
});

test("a -discovery kind is read-only discovery: it can neither owe a pull request nor grant write or open-pr", () => {
  const change = { allowedActions: ["read", "write", "open-pr"] as AllowedAction[], requiredArtifact: "pull-request" as const, executionTarget: "new-pull-request" as const, parentId: "p" };
  assert.equal(contractProblem({ ...change, kind: "docs-drift-discovery" })?.code, "discovery-kind-with-change-contract", "the follow-up that inherited its parent's kind on 2026-08-24");
  assert.equal(contractProblem({ ...change, kind: "docs-drift-fix" }), undefined, "the same contract under an implementation kind");
  assert.equal(contractProblem({ allowedActions: ["read", "open-pr"], requiredArtifact: "none", kind: "quality-gap-discovery" })?.code, "discovery-kind-with-change-contract", "open-pr alone is a change grant");
  assert.equal(contractProblem({ allowedActions: ["read", "create-followup"], requiredArtifact: "none", executionTarget: "read-only", kind: "quality-gap-discovery" }), undefined, "the catalog's own discovery root");
  assert.equal(contractProblem({ allowedActions: ["read", "write", "open-pr"], requiredArtifact: "pull-request" }), undefined, "no kind, no kind rule (legacy callers)");
});

test("every definition path refuses a contract the item's own authority cannot honor", async () => {
  const { queue } = await openQueue("contract-definition");
  const { repository: _repository, ...rootDefinition } = {
    repository: REPOSITORY,
    kind: "quality-implementation",
    objective: "Fix it.",
    instructions: "Patch it.",
    acceptanceCriteria: ["Fixed."],
    createdBy: "operator:test",
  };
  const base = {
    repository: REPOSITORY,
    kind: "quality-implementation",
    objective: "Fix it.",
    instructions: "Patch it.",
    acceptanceCriteria: ["Fixed."],
    delegableActions: [] as const,
    createdBy: "operator:test",
  };
  assert.throws(
    () => queue.enqueueSeed({ ...base, allowedActions: ["read", "run-tests"], delegableActions: [], requiredArtifact: "pull-request", executionTarget: "read-only" }),
    /must deliver a pull request requires open-pr/,
  );
  assert.throws(
    () => queue.enqueueSeed({ ...base, allowedActions: ["read", "write", "run-tests"], delegableActions: [], executionTarget: "read-only" }),
    /granted write has no way to land its change/,
  );
  assert.throws(
    () => queue.enqueueSeed({ ...base, allowedActions: ["read"], delegableActions: [], requiredArtifact: "release" as never, executionTarget: "read-only" }),
    /unknown required artifact/,
  );
  assert.throws(
    () =>
      queue.enqueueProposedRoots(REPOSITORY, [
        { ...rootDefinition, sourceRef: "https://github.com/frostyard/updex/issues/5", allowedActions: ["read", "write"], delegableActions: [], executionTarget: "read-only" },
      ]),
    /granted write has no way to land its change/,
  );
  const seeded = queue.enqueueSeed({ ...base, allowedActions: ["read", "write", "run-tests", "open-pr"], delegableActions: [], requiredArtifact: "pull-request", executionTarget: "new-pull-request" });
  assert.equal(seeded.requiredArtifact, "pull-request");
  // ADR-0073: a mutating target with an omitted (hence none) artifact is no
  // longer declarable — the release-needed shape now states pull-request.
  assert.throws(
    () => queue.enqueueSeed({ ...base, kind: "release-slice", allowedActions: ["read", "write", "run-tests", "open-pr"], delegableActions: [], executionTarget: "new-pull-request" }),
    /delivers through a pull request: requiredArtifact must be pull-request/,
  );
  const defaulted = queue.enqueueSeed({ ...base, kind: "release-slice", allowedActions: ["read"], delegableActions: [], executionTarget: "read-only" });
  assert.equal(defaulted.requiredArtifact, "none", "an omitted contract is none, never inferred from the actions");
  assert.equal(queue.list({ repository: REPOSITORY }).length, 2, "refused definitions wrote nothing");
});

test("a follow-up must state a deliverable contract, and a wrong one rolls the whole completion back", async () => {
  const { queue } = await openQueue("contract-followup");
  const root = seedTestingGap(queue, REPOSITORY);
  const claimed = queue.claim({ worker: "claude:updex:discovery" })!;
  const completion = (followUp: Record<string, unknown>) => ({
    id: root.id,
    leaseToken: claimed.leaseToken!,
    worker: "claude:updex:discovery",
    result: { summary: "One gap.", evidence: ["src/retry.ts:12"], artifacts: [] },
    followUps: [followUp as never],
  });

  // The live bug: a change child whose actions cannot deliver it.
  assert.throws(
    () => queue.complete(completion({ ...implementationChild, allowedActions: ["read", "write", "run-tests"] })),
    /follow-up "quality-implementation": an item that must deliver a pull request requires open-pr/,
  );
  // A change child that declines to promise the pull request.
  assert.throws(
    () => queue.complete(completion({ ...implementationChild, requiredArtifact: "none" })),
    /follow-up "quality-implementation": a follow-up granting write is a change and must declare requiredArtifact "pull-request"/,
  );
  // Neither a missing legacy contract nor an unknown contract is defaulted.
  assert.throws(
    () => queue.complete(completion({ ...implementationChild, requiredArtifact: undefined })),
    /legacy follow-up without intent must declare requiredArtifact/,
  );
  assert.throws(() => queue.complete(completion({ ...implementationChild, requiredArtifact: "issue" })), /requiredArtifact must be one of none, pull-request/);
  assert.equal(queue.get(root.id)?.status, "claimed", "a refused completion leaves the root claimed");
  assert.equal(queue.list({ repository: REPOSITORY }).length, 1, "and proposes nothing");

  const accepted = queue.complete(completion(implementationChild));
  assert.equal(accepted.followUps[0]?.requiredArtifact, "pull-request");
  assert.equal(accepted.followUps[0]?.status, "proposed");
  const discoveryOnly = queue.get(accepted.followUps[0]!.id)!;
  assert.equal(discoveryOnly.requiredArtifact, "pull-request", "the contract is stored with the item");
});

test("admission re-checks the contract, so a proposal that predates the rule is rejected rather than queued", async () => {
  const { queue } = await openQueue("contract-admission");
  const root = seedTestingGap(queue, REPOSITORY);
  const legacy = insertLegacyProposal(queue, root.id, ["read", "write", "run-tests"]);
  assert.equal(queue.get(legacy)?.status, "proposed");
  assert.equal(queue.get(legacy)?.requiredArtifact, "none");
  assert.throws(() => queue.approve(legacy, "operator:cli"), /cannot be admitted: an item granted write has no way to land its change: it requires open-pr in allowedActions \(write-without-open-pr\); reject it and re-propose/);
  assert.equal(queue.get(legacy)?.status, "proposed", "a refused admission changes nothing");
  assert.equal(queue.events(legacy).some((event) => event.type === "work.approved"), false);
  const rejected = queue.reject(legacy, "operator:cli", "under-authorized; re-proposed with open-pr");
  assert.equal(rejected.status, "cancelled");
});

test("an item that must deliver a pull request completes only with one reported, and stays claimed otherwise", async () => {
  const { queue } = await openQueue("contract-completion");
  const root = seedTestingGap(queue, REPOSITORY);
  const rootClaim = queue.claim({ worker: "claude:updex:discovery" })!;
  const { followUps } = queue.complete({
    id: root.id,
    leaseToken: rootClaim.leaseToken!,
    worker: "claude:updex:discovery",
    result: { summary: "One gap.", evidence: ["src/retry.ts:12"], artifacts: [] },
    followUps: [{ ...implementationChild, allowedActions: [...implementationChild.allowedActions], delegableActions: [...implementationChild.delegableActions] }],
  });
  const child = queue.approve(followUps[0]!.id, "operator:cli");
  assert.equal(child.status, "queued");
  const lease = queue.claim({ worker: "claude:updex:fixer" })!;
  assert.equal(lease.id, child.id);
  const attempt = (artifacts: Array<{ kind: "commit" | "pull-request" | "report"; url: string }>) => ({
    id: child.id,
    leaseToken: lease.leaseToken!,
    worker: "claude:updex:fixer",
    result: { summary: "Fixed.", evidence: ["make check green"], artifacts },
    followUps: [],
  });
  assert.throws(() => queue.complete(attempt([])), /completion must report a pull-request artifact/);
  assert.throws(() => queue.complete(attempt([{ kind: "commit", url: COMMIT_URL }])), /completion must report a pull-request artifact: this item is delivered through one pull request/);
  assert.throws(() => queue.complete(attempt([{ kind: "report", url: "https://example.com/report" }])), /block_work with the reason if no change is warranted/);
  assert.equal(queue.get(child.id)?.status, "claimed");
  assert.equal(queue.get(child.id)?.result, undefined);

  // Blocking remains the way out when no change is warranted.
  const completed = queue.complete(attempt([{ kind: "commit", url: COMMIT_URL }, { kind: "pull-request", url: PR_URL }]));
  assert.equal(completed.completed.status, "completed");
  assert.equal(completed.completed.delivery, "unverified");

  // An item whose contract is none completes on its result alone, exactly as before.
  const noContract = queue.enqueueSeed({
    repository: REPOSITORY,
    kind: "release-needed",
    objective: "Prepare the release.",
    instructions: "Report the release state with evidence.",
    acceptanceCriteria: ["The result names the version."],
    // ADR-0073: an artifact-none item is a read-only reporter; the old
    // write-capable release-needed shape now declares pull-request instead.
    allowedActions: ["read", "run-tests"],
    delegableActions: [],
    requiredArtifact: "none",
    executionTarget: "read-only",
    createdBy: "operator:dependency-sweep",
  });
  const releaseLease = queue.claim({ worker: "claude:updex:release" })!;
  assert.equal(releaseLease.id, noContract.id);
  const released = queue.complete({ ...attempt([]), id: noContract.id, leaseToken: releaseLease.leaseToken!, worker: "claude:updex:release" });
  assert.equal(released.completed.status, "completed");
  assert.equal(released.completed.delivery, "none");
});

test("audit-contracts lists every in-flight item whose contract cannot be completed, names the clearing command, and exits non-zero", async () => {
  const { queue, path } = await openQueue("contract-audit");
  queue.setRepositoryEnabled("frostyard/lodge", true);
  const root = seedTestingGap(queue, REPOSITORY);
  const bugShaped = insertLegacyProposal(queue, root.id, ["read", "write", "run-tests"]);
  const underDeclared = insertLegacyProposal(queue, root.id, ["read", "write", "run-tests", "open-pr"], 2);
  // A completed legacy item with the same shape is history, not a finding.
  const done = insertLegacyProposal(queue, root.id, ["read", "write"], 3);
  const db = (queue as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): unknown } } }).db;
  db.prepare("UPDATE work_items SET status = 'completed', admitted = 1, result_json = '{\"summary\":\"x\",\"evidence\":[],\"artifacts\":[]}' WHERE id = ?").run(done);

  const findings = queue.auditContracts();
  assert.deepEqual(
    findings.map((finding) => [finding.id, finding.problem, finding.status]),
    [
      [bugShaped, "write-without-open-pr", "proposed"],
      [underDeclared, "child-write-without-required-pull-request", "proposed"],
    ],
  );
  assert.equal(findings[0]?.suggestedCommand, `reject ${bugShaped} "<reason>"`);
  assert.equal(findings[0]?.requiredArtifact, "none");
  assert.deepEqual(findings[0]?.allowedActions, ["read", "write", "run-tests"]);
  assert.deepEqual(queue.auditContracts({ repository: "frostyard/lodge" }), []);
  assert.throws(() => queue.auditContracts({ repository: "not a slug" }), /owner\/name slug/);

  // The audit read nothing into the ledger and changed no row.
  assert.equal(queue.events(bugShaped).length, 0);

  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", "audit-contracts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: childEnvironment({ SNOWCAT_QUEUE_DB: path }),
    });
  const failing = run();
  assert.equal(failing.status, 1, failing.stderr);
  const report = JSON.parse(failing.stdout) as { count: number; findings: Array<{ id: string; problem: string }> };
  assert.equal(report.count, 2);
  assert.equal(report.findings[0]?.problem, "write-without-open-pr");
  const filtered = run("--repository", "frostyard/lodge");
  assert.equal(filtered.status, 0, filtered.stderr);
  assert.equal((JSON.parse(filtered.stdout) as { count: number }).count, 0);

  queue.reject(bugShaped, "operator:cli", "cannot deliver");
  queue.reject(underDeclared, "operator:cli", "re-propose with the contract");
  assert.deepEqual(queue.auditContracts(), []);
  assert.equal(run().status, 0);
});

test("a change follow-up must be able to propose what it finds, but only where its parent can delegate that (issue #270)", async () => {
  const { queue } = await openQueue("contract-change-child-propose");
  const root = seedTestingGap(queue, REPOSITORY);
  assert.ok(root.delegableActions.includes("create-followup"), "the catalog's implementation ceiling permits it");
  const claimed = queue.claim({ worker: "claude:updex:discovery" })!;
  const completion = (followUp: Record<string, unknown>) => ({
    id: root.id,
    leaseToken: claimed.leaseToken!,
    worker: "claude:updex:discovery",
    result: { summary: "One gap.", evidence: ["src/retry.ts:12"], artifacts: [] },
    followUps: [followUp as never],
  });

  // The live loss: three findings on 2026-08-27/28 survived only as prose in
  // evidence because the proposer dropped a capability its own ceiling allowed.
  const underAuthorized = { ...implementationChild, allowedActions: ["read", "write", "run-tests", "open-pr"] as AllowedAction[] };
  assert.throws(
    () => queue.complete(completion(underAuthorized)),
    /follow-up "quality-implementation": a follow-up granting write finds adjacent work while it changes the tree, and evidence re-queues nothing: give "quality-implementation" create-followup to its allowedActions, which its parent's delegableActions already permit/,
  );
  assert.equal(queue.get(root.id)?.status, "claimed", "a refused completion rolls back whole and leaves the root claimed");
  assert.equal(queue.list({ repository: REPOSITORY }).length, 1, "and proposes nothing");

  // Holding create-followup is not enough on its own: a child that may propose
  // but delegates nothing has an empty ceiling, so every child it proposes —
  // even a read-only one — would exceed it and the finding is stranded just the
  // same. That was the shape every affected fixture carried.
  assert.throws(
    () => queue.complete(completion({ ...underAuthorized, allowedActions: [...underAuthorized.allowedActions, "create-followup"], delegableActions: [] })),
    /follow-up "quality-implementation": a follow-up granting write finds adjacent work while it changes the tree, and evidence re-queues nothing: give "quality-implementation" a non-empty delegableActions for the children it will propose \(at most its parent's ceiling\)/,
  );
  assert.equal(queue.get(root.id)?.status, "claimed", "that refusal rolls back whole too");
  assert.equal(queue.list({ repository: REPOSITORY }).length, 1);

  // Both halves together are all it takes, and both lists are stored as given.
  const accepted = queue.complete(
    completion({ ...underAuthorized, allowedActions: [...underAuthorized.allowedActions, "create-followup"], delegableActions: ["read", "create-followup"] }),
  );
  const child = queue.get(accepted.followUps[0]!.id)!;
  assert.deepEqual(child.allowedActions, ["read", "write", "run-tests", "open-pr", "create-followup"]);
  assert.deepEqual(child.delegableActions, ["read", "create-followup"]);
  assert.equal(queue.approve(child.id, "operator:cli").status, "queued", "admission re-checks the same predicate and admits it");

  // End to end: the admitted child can actually queue the adjacent finding it
  // discovers, using only the ceiling it was given. This is the loop that was
  // broken — the finding reaches the queue instead of the evidence prose.
  const lease = queue.claim({ worker: "claude:updex:fixer", kinds: ["quality-implementation"] })!;
  assert.equal(lease.id, child.id);
  const adjacent = queue.complete({
    id: child.id,
    leaseToken: lease.leaseToken!,
    worker: "claude:updex:fixer",
    result: { summary: "Fixed the gap; found an adjacent one.", evidence: ["src/retry.ts:12"], artifacts: [{ kind: "pull-request", url: PR_URL }] },
    followUps: [
      {
        kind: "quality-gap-discovery",
        objective: "Assess the adjacent gap this fix uncovered.",
        instructions: "Read only; report what you find.",
        acceptanceCriteria: ["The adjacent gap is described with file-level evidence."],
        allowedActions: ["read"],
        delegableActions: [],
        requiredArtifact: "none",
        executionTarget: "read-only",
      },
    ],
  });
  const grandchild = queue.get(adjacent.followUps[0]!.id)!;
  assert.equal(grandchild.status, "proposed", "the finding is queued as a proposal, not stranded in evidence");
  assert.equal(grandchild.parentId, child.id);
  assert.deepEqual(grandchild.allowedActions, ["read"]);
});

test("the change-child rule never invents authority its parent lacks (issue #270)", async () => {
  const { queue } = await openQueue("contract-change-child-ceiling");
  const root = queue.enqueueSeed({
    repository: REPOSITORY,
    kind: "security-gap-discovery",
    objective: "Find one security gap.",
    instructions: "Read only.",
    acceptanceCriteria: ["One gap is reported."],
    allowedActions: ["read", "create-followup"],
    // A ceiling that cannot delegate create-followup: the child may not have it.
    delegableActions: ["read", "write", "run-tests", "open-pr"],
    requiredArtifact: "none",
    executionTarget: "read-only",
    createdBy: "operator:test",
  });
  const claimed = queue.claim({ worker: "claude:updex:security" })!;
  const completion = (followUp: Record<string, unknown>) => ({
    id: root.id,
    leaseToken: claimed.leaseToken!,
    worker: "claude:updex:security",
    result: { summary: "One gap.", evidence: ["src/auth.ts:9"], artifacts: [] },
    followUps: [followUp as never],
  });

  // The same proposal that was refused above is accepted here, unchanged.
  const underAuthorized = { ...implementationChild, allowedActions: ["read", "write", "run-tests", "open-pr"] as AllowedAction[], delegableActions: [] as AllowedAction[] };
  const accepted = queue.complete(completion({ ...underAuthorized, kind: "security-gap-fix" }));
  const child = queue.get(accepted.followUps[0]!.id)!;
  assert.deepEqual(child.allowedActions, ["read", "write", "run-tests", "open-pr"], "no capability is granted silently");
  assert.equal(queue.approve(child.id, "operator:cli").status, "queued");

  // And the predicate itself keys on the ceiling, nothing else.
  assert.equal(
    contractProblem({
      allowedActions: ["read", "write", "open-pr"],
      requiredArtifact: "pull-request",
      executionTarget: "new-pull-request",
      kind: "security-gap-fix",
      parentId: root.id,
      parentDelegableActions: ["read", "write", "run-tests", "open-pr"],
    }),
    undefined,
    "a parent that cannot delegate create-followup imposes no such requirement",
  );
  assert.equal(
    contractProblem({
      allowedActions: ["read", "write", "open-pr"],
      requiredArtifact: "pull-request",
      executionTarget: "new-pull-request",
      kind: "security-gap-fix",
      parentId: root.id,
      parentDelegableActions: ["read", "write", "run-tests", "open-pr", "create-followup"],
    })?.code,
    "change-child-cannot-propose",
  );
});
