import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  CoreCandidateInspectionError,
  CoreSourceContinuityError,
  inspectCoreCommit,
  inspectCoreCandidate,
  verifyCoreSourceContinuity,
  type InspectedCoreCandidate,
} from "../src/core/git-source.ts";
import { CoreValidationError, validateCoreCatalog, type CoreTreeEntry } from "../src/core/validator.ts";
import { ControlPlaneStore, CoreSnapshotPersistenceError } from "../src/control/store.ts";
import { uuidV7 } from "../src/control/encoding.ts";

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

  await writeFile(join(source, "organization", "README.md"), "# Updated organization authority\n");
  git(source, ["add", "organization/README.md"]);
  git(source, ["commit", "-m", "valid descendant"]);
  const descendant = await inspectCoreCandidate({
    sourceUrl: source,
    ref: "refs/heads/main",
    mirrorPath: mirror,
    allowFileSource: true,
  });
  await verifyCoreSourceContinuity(
    { sourceUrl: source, ref: "refs/heads/main", mirrorPath: mirror, allowFileSource: true },
    descendant,
    valid.commitId,
  );

  git(source, ["switch", "--orphan", "rewritten"]);
  for (const entry of entries) {
    const path = join(source, entry.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entry.bytes);
  }
  git(source, ["add", "organization"]);
  git(source, ["commit", "-m", "unrelated authority"]);
  const unrelated = await inspectCoreCandidate({
    sourceUrl: source,
    ref: "refs/heads/rewritten",
    mirrorPath: mirror,
    allowFileSource: true,
  });
  await assert.rejects(
    verifyCoreSourceContinuity(
      { sourceUrl: source, ref: "refs/heads/rewritten", mirrorPath: mirror, allowFileSource: true },
      unrelated,
      descendant.commitId,
    ),
    (error) =>
      error instanceof CoreSourceContinuityError &&
      error.stage === "continuity" &&
      error.code === "candidate-not-descendant" &&
      error.activeCommitId === descendant.commitId,
  );

  const exactPrior = await inspectCoreCommit(
    { sourceUrl: source, ref: "refs/heads/rewritten", mirrorPath: mirror, allowFileSource: true },
    valid.commitId,
  );
  assert.equal(exactPrior.commitId, valid.commitId);
  assert.equal(exactPrior.catalogDigest, valid.catalogDigest);

  git(source, ["switch", "main"]);

  await unlink(join(source, "organization", "README.md"));
  await symlink("repositories/frostyard/core.json", join(source, "organization", "README.md"));
  git(source, ["add", "organization/README.md"]);
  git(source, ["commit", "-m", "invalid symlink"]);

  await assert.rejects(
    inspectCoreCandidate({ sourceUrl: source, ref: "refs/heads/main", mirrorPath: mirror, allowFileSource: true }),
    (error) =>
      error instanceof CoreCandidateInspectionError &&
      error.stage === "validation" &&
      error.code === "candidate-invalid" &&
      error.commitId !== undefined &&
      /accepts only regular Git blobs/.test(error.message),
  );
});

test("a Core candidate rejection is bounded, idempotent, queryable, and non-authoritative", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-core-rejection-test-"));
  const path = join(directory, "control-plane.db");
  const observedAt = "2026-08-16T12:30:00.000Z";
  const checkId = uuidV7(new Date(observedAt));
  const store = new ControlPlaneStore(path, () => new Date(observedAt));
  const input = {
    checkId,
    operation: "automatic-source-check" as const,
    stage: "validation" as const,
    code: "candidate-invalid" as const,
    summary: "organization/README.md: required authority file is missing",
    details: ["candidate rejected before snapshot activation"],
    sourceUrl: "https://github.com/frostyard/core.git",
    sourceRef: "refs/heads/main",
    commitId: "1".repeat(40),
    treeId: "2".repeat(40),
  };

  const rejection = store.recordCoreCandidateRejection(input);
  assert.equal(rejection.transactionSequence, 2);
  assert.deepEqual(rejection.transactionPositions, [0, 1]);
  assert.equal(store.metadata().lastTransactionSequence, 2);
  assert.deepEqual(store.recordCoreCandidateRejection(input), rejection);
  assert.equal(store.metadata().lastTransactionSequence, 2);
  const listed = store.coreCandidateRejections();
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.checkId, checkId);
  assert.equal(listed[0]?.stage, "validation");
  assert.equal(listed[0]?.transactionPosition, 0);
  assert.deepEqual(
    store.occurrences().slice(-2).map((occurrence) => [
      occurrence.kind,
      occurrence.recordClass,
      occurrence.transactionPosition,
      occurrence.revisionValue,
      occurrence.sourceRevisionValue,
    ]),
    [
      ["core.candidate-rejection-observation", "observation", 0, "1", `sha1:${"1".repeat(40)}`],
      ["core.candidate-rejected", undefined, 1, "1", `sha1:${"1".repeat(40)}`],
    ],
  );
  assert.throws(
    () => store.recordCoreCandidateRejection({ ...input, summary: "different" }),
    /check ID was already used/,
  );
  assert.throws(
    () => store.recordCoreCandidateRejection({ ...input, checkId: uuidV7(), summary: "x".repeat(513) }),
    /outside the registered diagnostic contract/,
  );
  assert.equal(store.metadata().lastTransactionSequence, 2);
  const continuityCheckId = uuidV7(new Date(observedAt));
  const continuity = store.recordCoreCandidateRejection({
    checkId: continuityCheckId,
    operation: "automatic-source-check",
    stage: "continuity",
    code: "candidate-not-descendant",
    summary: "candidate does not descend from the active Core source commit",
    details: [],
    sourceUrl: input.sourceUrl,
    sourceRef: input.sourceRef,
    commitId: "3".repeat(40),
    treeId: "4".repeat(40),
    catalogDigest: `sha256:${"5".repeat(64)}`,
    activeCommitId: "6".repeat(40),
  });
  assert.equal(continuity.transactionSequence, 3);
  assert.equal(store.coreCandidateRejections(1)[0]?.activeCommitId, "6".repeat(40));
  store.close();

  const output = execFileSync(
    process.execPath,
    ["--import", "tsx", "src/core/cli.ts", "rejections", "1"],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, FLUENT_CONTROL_DB: path } },
  );
  const cliRows = JSON.parse(output) as Array<Record<string, unknown>>;
  assert.equal(cliRows.length, 1);
  assert.equal(cliRows[0]?.checkId, continuityCheckId);
});

test("Core source freshness stays distinct from immediate admission blockers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-core-readiness-test-"));
  let now = new Date("2026-08-16T10:00:00.000Z");
  const store = new ControlPlaneStore(join(directory, "control-plane.db"), () => now);
  const activeCandidate = await activationCandidate("7".repeat(40), "8".repeat(40));
  const activation = store.activateCoreSnapshot({
    candidate: activeCandidate,
    expectedLastTransactionSequence: 1,
  });
  const eligibleCheckId = uuidV7(now);
  const eligible = store.recordCoreSourceCheckEligible({
    checkId: eligibleCheckId,
    candidate: activeCandidate,
    expectedLastTransactionSequence: activation.transactionSequence,
  });
  assert.equal(eligible.transactionSequence, 3);
  assert.deepEqual(store.recordCoreSourceCheckEligible({
    checkId: eligibleCheckId,
    candidate: activeCandidate,
    expectedLastTransactionSequence: activation.transactionSequence,
  }), eligible);
  assert.deepEqual(store.coreAdmissionReadiness(), {
    ready: true,
    reason: "ready",
    evaluatedAt: now.toISOString(),
    controlPlaneSequence: 3,
    activeSnapshotId: activation.snapshotId,
    activeSourceCommitId: activeCandidate.commitId,
    latestCheckId: eligibleCheckId,
    latestCheckOutcome: "eligible",
    latestCheckedAt: now.toISOString(),
    lastValidatedAt: now.toISOString(),
    maximumStalenessSeconds: 86400,
    staleAt: "2026-08-17T10:00:00.000Z",
    overrideDecisionId: null,
    overrideExpiresAt: null,
    degraded: false,
  });

  now = new Date("2026-08-16T10:30:00.000Z");
  store.recordCoreCandidateRejection({
    checkId: uuidV7(now),
    operation: "automatic-source-check",
    stage: "validation",
    code: "candidate-invalid",
    summary: "configured Core candidate failed the bundled contract",
    details: [],
    sourceUrl: activeCandidate.sourceUrl,
    sourceRef: activeCandidate.ref,
    commitId: "b".repeat(40),
    treeId: "c".repeat(40),
  });
  assert.equal(store.coreAdmissionReadiness().reason, "candidate-invalid");
  assert.equal(store.coreAdmissionReadiness().lastValidatedAt, "2026-08-16T10:00:00.000Z");
  store.recordCoreSourceCheckEligible({
    checkId: uuidV7(now),
    candidate: activeCandidate,
    expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
  });
  assert.equal(store.coreAdmissionReadiness().reason, "ready");

  now = new Date("2026-08-16T11:00:00.000Z");
  const rejectedCandidate = await activationCandidate("9".repeat(40), "a".repeat(40));
  const continuity = store.recordCoreCandidateRejection({
    checkId: uuidV7(now),
    operation: "automatic-source-check",
    stage: "continuity",
    code: "candidate-not-descendant",
    summary: "configured Core ref does not descend from active authority",
    details: [],
    sourceUrl: rejectedCandidate.sourceUrl,
    sourceRef: rejectedCandidate.ref,
    commitId: rejectedCandidate.commitId,
    treeId: rejectedCandidate.treeId,
    catalogDigest: rejectedCandidate.catalogDigest,
    activeCommitId: activeCandidate.commitId,
  });
  assert.equal(store.coreAdmissionReadiness().reason, "continuity-blocked");
  assert.equal(store.coreAdmissionReadiness().lastValidatedAt, now.toISOString());

  now = new Date("2026-08-16T12:00:00.000Z");
  const outageCheckId = uuidV7(now);
  store.recordCoreCandidateRejection({
    checkId: outageCheckId,
    operation: "automatic-source-check",
    stage: "source",
    code: "source-unavailable",
    summary: "configured Core ref is temporarily unavailable",
    details: [],
    sourceUrl: activeCandidate.sourceUrl,
    sourceRef: activeCandidate.ref,
  });
  const stillBlocked = store.coreAdmissionReadiness();
  assert.equal(stillBlocked.latestCheckId, outageCheckId);
  assert.equal(stillBlocked.latestCheckOutcome, "source-unavailable");
  assert.equal(stillBlocked.reason, "continuity-blocked");

  now = new Date("2026-08-16T13:00:00.000Z");
  const rollback = store.rollbackCoreSnapshot({
    candidate: rejectedCandidate,
    expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
    reason: "Explicitly accept the reviewed non-descendant Core authority",
  });
  assert.equal(rollback.transactionSequence, continuity.transactionSequence + 2);
  assert.equal(store.coreAdmissionReadiness().reason, "ready");

  now = new Date("2026-08-16T13:30:00.000Z");
  store.recordCoreCandidateRejection({
    checkId: uuidV7(now),
    operation: "operator-rollback",
    stage: "validation",
    code: "candidate-invalid",
    summary: "an unrelated exact rollback target was invalid",
    details: [],
    sourceUrl: activeCandidate.sourceUrl,
    sourceRef: activeCandidate.ref,
    commitId: "d".repeat(40),
    treeId: "e".repeat(40),
  });
  assert.equal(store.coreAdmissionReadiness().reason, "ready");

  now = new Date("2026-08-17T11:00:00.000Z");
  const stale = store.coreAdmissionReadiness();
  assert.equal(stale.reason, "source-stale");
  assert.equal(stale.ready, false);
  store.close();
});

test("activate records a bounded source rejection while verify remains outside the target store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-core-cli-rejection-test-"));
  const controlPath = join(directory, "control-plane.db");
  const invalidMirror = join(directory, "not-a-bare-repository");
  await writeFile(invalidMirror, "not git", "utf8");
  const environment = {
    ...process.env,
    FLUENT_CONTROL_DB: controlPath,
    FLUENT_CORE_MIRROR: invalidMirror,
  };

  const verify = spawnSync(process.execPath, ["--import", "tsx", "src/core/cli.ts", "verify"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: environment,
  });
  assert.notEqual(verify.status, 0);
  assert.equal(verify.stdout, "");
  const untouched = new DatabaseSync(controlPath);
  assert.equal(
    Number((untouched.prepare("PRAGMA application_id").get() as { application_id: number }).application_id),
    0,
  );
  untouched.close();

  const activate = spawnSync(process.execPath, ["--import", "tsx", "src/core/cli.ts", "activate", "1"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: environment,
  });
  assert.notEqual(activate.status, 0);
  assert.equal(activate.stdout, "");
  assert.match(activate.stderr, /Core candidate rejection recorded:/);
  const store = new ControlPlaneStore(controlPath);
  const rejections = store.coreCandidateRejections();
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0]?.stage, "source");
  assert.equal(rejections[0]?.code, "source-unavailable");
  assert.equal(rejections[0]?.commitId, null);
  store.close();
});

test("a validated Core candidate is retained and activated atomically with exact retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-core-activation-test-"));
  const path = join(directory, "control-plane.db");
  const candidate = await activationCandidate("a".repeat(40), "b".repeat(40));
  const store = new ControlPlaneStore(path, () => new Date("2026-08-16T13:00:00.000Z"));

  const before = store.authoritativeDigest();
  const activated = store.activateCoreSnapshot({ candidate, expectedLastTransactionSequence: 1 });
  assert.equal(activated.transactionSequence, 2);
  assert.equal(activated.catalogDigest, candidate.catalogDigest);
  assert.deepEqual(activated.transactionPositions, [0, 1, 2]);
  assert.deepEqual(
    store.occurrences().slice(-3).map((occurrence) => [occurrence.kind, occurrence.transactionPosition]),
    [
      ["core.snapshot-definition", 0],
      ["core.snapshot-active", 1],
      ["core.snapshot-activated", 2],
    ],
  );
  assert.notEqual(store.authoritativeDigest(), before);
  assert.deepEqual(
    store.activateCoreSnapshot({ candidate, expectedLastTransactionSequence: 1 }),
    activated,
  );
  const successor = await activationCandidate("e".repeat(40), "f".repeat(40));
  assert.throws(
    () =>
      store.activateCoreSnapshot({
        candidate: successor,
        expectedLastTransactionSequence: 2,
      }),
    /requires source continuity from active commit/,
  );
  assert.equal(store.metadata().lastTransactionSequence, 2);
  const successorResult = store.activateCoreSnapshot({
    candidate: successor,
    expectedLastTransactionSequence: 2,
    continuityAncestorCommitId: candidate.commitId,
  });
  assert.equal(successorResult.transactionSequence, 3);
  assert.notEqual(successorResult.snapshotId, activated.snapshotId);
  assert.equal(store.occurrences().filter((occurrence) => occurrence.kind === "core.snapshot-definition").length, 2);
  const rejection = store.recordCoreCandidateRejection({
    checkId: uuidV7(new Date("2026-08-16T13:00:00.000Z")),
    operation: "automatic-source-check",
    stage: "persistence",
    code: "persistence-failed",
    summary: "A later candidate could not be persisted",
    details: [],
    sourceUrl: successor.sourceUrl,
    sourceRef: successor.ref,
    commitId: "9".repeat(40),
    treeId: "8".repeat(40),
    catalogDigest: successor.catalogDigest,
  });
  assert.equal(rejection.transactionSequence, 4);
  assert.deepEqual(
    store.activateCoreSnapshot({ candidate: successor, expectedLastTransactionSequence: 2 }),
    successorResult,
  );
  assert.equal(store.metadata().lastTransactionSequence, 4);
  store.close();

  const reopened = new ControlPlaneStore(path);
  assert.equal(reopened.metadata().lastTransactionSequence, 4);
  reopened.close();
});

test("an attributed operator rollback creates a new snapshot and preserves later reactivation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-core-operator-rollback-test-"));
  const path = join(directory, "control-plane.db");
  const first = await activationCandidate("1".repeat(40), "2".repeat(40));
  const second = await activationCandidate("3".repeat(40), "4".repeat(40));
  const store = new ControlPlaneStore(path, () => new Date("2026-08-16T16:00:00.000Z"));
  const firstActivation = store.activateCoreSnapshot({ candidate: first, expectedLastTransactionSequence: 1 });
  const secondActivation = store.activateCoreSnapshot({
    candidate: second,
    expectedLastTransactionSequence: 2,
    continuityAncestorCommitId: first.commitId,
  });

  assert.throws(
    () =>
      store.rollbackCoreSnapshot({
        candidate: first,
        expectedLastTransactionSequence: 2,
        reason: "This decision was rendered against stale authority",
      }),
    /stale control-plane sequence/,
  );
  assert.throws(
    () =>
      store.rollbackCoreSnapshot({
        candidate: second,
        expectedLastTransactionSequence: 3,
        reason: "The requested target is already current",
      }),
    /already the active source commit/,
  );
  assert.equal(store.metadata().lastTransactionSequence, 3);

  const rollback = store.rollbackCoreSnapshot({
    candidate: first,
    expectedLastTransactionSequence: 3,
    reason: "Restore the last reviewed organization authority after the invalid change",
  });
  assert.equal(rollback.transactionSequence, 4);
  assert.deepEqual(rollback.transactionPositions, [0, 1, 2, 3]);
  assert.notEqual(rollback.snapshotId, firstActivation.snapshotId);
  assert.equal(rollback.previousSnapshotId, secondActivation.snapshotId);
  assert.equal(rollback.previousSourceCommitId, second.commitId);
  assert.equal(rollback.operatorPrincipalId, store.metadata().operatorPrincipalId);
  assert.equal(store.activeCoreSnapshot()?.sourceCommitId, first.commitId);
  assert.deepEqual(
    store.occurrences().slice(-4).map((occurrence) => [
      occurrence.kind,
      occurrence.recordClass,
      occurrence.sourceKind,
      occurrence.transactionPosition,
    ]),
    [
      ["core.rollback-decision", "decision", "operator-principal", 0],
      ["core.snapshot-definition", "definition", "github-repository", 1],
      ["core.snapshot-active", "fact", "github-repository", 2],
      ["core.snapshot-rollback-activated", undefined, "github-repository", 3],
    ],
  );
  assert.deepEqual(
    store.rollbackCoreSnapshot({
      candidate: first,
      expectedLastTransactionSequence: 3,
      reason: rollback.reason,
    }),
    rollback,
  );
  assert.throws(
    () =>
      store.rollbackCoreSnapshot({
        candidate: first,
        expectedLastTransactionSequence: 3,
        reason: "A conflicting rationale",
      }),
    /different command payload/,
  );
  assert.throws(
    () =>
      store.rollbackCoreSnapshot({
        candidate: second,
        expectedLastTransactionSequence: 4,
        reason: " invalid surrounding whitespace ",
      }),
    /trimmed single line/,
  );

  const reactivated = store.activateCoreSnapshot({
    candidate: second,
    expectedLastTransactionSequence: 4,
    continuityAncestorCommitId: first.commitId,
  });
  assert.equal(reactivated.transactionSequence, 5);
  assert.notEqual(reactivated.snapshotId, secondActivation.snapshotId);
  assert.equal(store.activeCoreSnapshot()?.sourceCommitId, second.commitId);
  assert.equal(store.retainedCoreCandidate(first.commitId)?.catalogDigest, first.catalogDigest);
  store.close();

  const cliOutput = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/core/cli.ts",
      "rollback",
      "5",
      first.commitId,
      "Restore the retained reviewed authority through the operator CLI",
    ],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, FLUENT_CONTROL_DB: path } },
  );
  const cliRollback = JSON.parse(cliOutput) as Record<string, unknown>;
  assert.equal(cliRollback.sourceCommitId, first.commitId);
  assert.equal(cliRollback.transactionSequence, 6);

  const reopened = new ControlPlaneStore(path);
  assert.equal(reopened.metadata().lastTransactionSequence, 6);
  assert.equal(reopened.activeCoreSnapshot()?.sourceCommitId, first.commitId);
  reopened.close();

  const tampered = new DatabaseSync(path);
  tampered
    .prepare("UPDATE control_transactions SET principal_id = ? WHERE sequence = 6")
    .run(uuidV7(new Date("2026-08-16T17:00:00.000Z")));
  tampered.close();
  assert.throws(() => new ControlPlaneStore(path), /Core snapshot rollback receipt shape is invalid/);
});

test("Core snapshot failure rolls back retained bytes and byte tampering fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-core-rollback-test-"));
  const failedPath = join(directory, "failed.db");
  const candidate = await activationCandidate("c".repeat(40), "d".repeat(40));
  const failed = new ControlPlaneStore(
    failedPath,
    () => new Date("2026-08-16T14:00:00.000Z"),
    (point) => {
      if (point === "after-core-snapshot-files") throw new Error("injected Core persistence failure");
    },
  );
  const digest = failed.authoritativeDigest();
  assert.throws(
    () => failed.activateCoreSnapshot({ candidate, expectedLastTransactionSequence: 1 }),
    (error) =>
      error instanceof CoreSnapshotPersistenceError && /injected Core persistence failure/.test(error.message),
  );
  assert.equal(failed.authoritativeDigest(), digest);
  assert.equal(failed.metadata().lastTransactionSequence, 1);
  failed.close();

  const rollbackFailedPath = join(directory, "rollback-failed.db");
  const successor = await activationCandidate("e".repeat(40), "f".repeat(40));
  let injectRollbackFailure = false;
  const rollbackFailed = new ControlPlaneStore(
    rollbackFailedPath,
    () => new Date("2026-08-16T14:30:00.000Z"),
    (point) => {
      if (injectRollbackFailure && point === "after-core-snapshot-files") {
        throw new Error("injected Core rollback persistence failure");
      }
    },
  );
  rollbackFailed.activateCoreSnapshot({ candidate, expectedLastTransactionSequence: 1 });
  rollbackFailed.activateCoreSnapshot({
    candidate: successor,
    expectedLastTransactionSequence: 2,
    continuityAncestorCommitId: candidate.commitId,
  });
  injectRollbackFailure = true;
  const beforeRollbackFailure = rollbackFailed.authoritativeDigest();
  assert.throws(
    () =>
      rollbackFailed.rollbackCoreSnapshot({
        candidate,
        expectedLastTransactionSequence: 3,
        reason: "Exercise atomic rollback of the operator rollback transition",
      }),
    (error) =>
      error instanceof CoreSnapshotPersistenceError &&
      /injected Core rollback persistence failure/.test(error.message),
  );
  assert.equal(rollbackFailed.authoritativeDigest(), beforeRollbackFailure);
  assert.equal(rollbackFailed.metadata().lastTransactionSequence, 3);
  assert.equal(rollbackFailed.activeCoreSnapshot()?.sourceCommitId, successor.commitId);
  rollbackFailed.close();

  const tamperedPath = join(directory, "tampered.db");
  const stored = new ControlPlaneStore(tamperedPath, () => new Date("2026-08-16T15:00:00.000Z"));
  stored.activateCoreSnapshot({ candidate, expectedLastTransactionSequence: 1 });
  stored.close();
  const raw = new DatabaseSync(tamperedPath);
  raw.prepare("UPDATE core_snapshot_files SET raw_bytes = ? WHERE path = ?").run(
    Buffer.from("tampered"),
    "organization/README.md",
  );
  raw.close();
  assert.throws(() => new ControlPlaneStore(tamperedPath), /Core snapshot file (?:size|digest) mismatch/);
});

async function activationCandidate(commitId: string, treeId: string): Promise<InspectedCoreCandidate> {
  const files = await validCoreEntries();
  return {
    sourceUrl: "https://github.com/frostyard/core.git",
    ref: "refs/heads/main",
    commitId,
    treeId,
    files,
    ...validateCoreCatalog(files),
  };
}

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

function git(directory: string, args: string[]): void {
  execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" });
}
