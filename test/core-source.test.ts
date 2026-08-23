import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
import {
  assertGoalRetention,
  assertVerificationProfileRetention,
  CoreValidationError,
  validateCoreCatalog,
  type CoreTreeEntry,
  type OrganizationGoal,
} from "../src/core/validator.ts";
import { synchronizeCoreSource } from "../src/core/synchronize.ts";
import { ControlPlaneStore, CoreSnapshotPersistenceError } from "../src/control/store.ts";
import { uuidV7 } from "../src/control/encoding.ts";
import { childEnvironment } from "./helpers/child-environment.ts";

test("the bundled validator accepts the current core repository-authority shape without enrolling it", async () => {
  const entries = await validCoreEntries();
  const first = validateCoreCatalog(entries);
  const second = validateCoreCatalog([...entries].reverse());

  assert.equal(first.catalogDigest, second.catalogDigest);
  assert.equal(first.repositoryCount, 1);
  assert.equal(first.verificationProfileCount, 0);
  assert.deepEqual(first.verificationProfiles, []);
  assert.equal(first.schemaDigests.verificationProfile, undefined);
  assert.equal(first.validFixtureCount, 3);
  assert.equal(first.invalidFixtureCount, 1);
  assert.equal(first.repositories[0]?.declaration.repository.repository_id, "1331309458");
  assert.equal(first.repositories[0]?.declaration.fleet_state, "disabled");
});

test("the bundled validator accepts profile-capable Core while preserving legacy rollback", async () => {
  const legacyEntries = await validCoreEntries();
  const profileContractEntries = await verificationProfileContractEntries();
  const capableEntries = [...legacyEntries, ...profileContractEntries];
  const capable = validateCoreCatalog(capableEntries);

  assert.equal(capable.verificationProfileCount, 0);
  assert.equal(
    capable.schemaDigests.verificationProfile,
    "sha256:5562df1740d133ff32a7bcfc488907b3783a3eda9ba8e8e1d9559a07f44a4507",
  );
  assert.equal(capable.validFixtureCount, 4);
  assert.equal(capable.invalidFixtureCount, 3);

  const liveEntry = entryFor(
    "organization/contracts/verification-profiles/required-check-reliability/v1.json",
    json(validVerificationProfile()),
  );
  const withLiveProfile = validateCoreCatalog([...capableEntries, liveEntry]);
  assert.equal(withLiveProfile.verificationProfileCount, 1);
  assert.equal(withLiveProfile.verificationProfiles[0]?.profile.profile.id, "required-check-reliability");

  const legacy = validateCoreCatalog(legacyEntries);
  assert.doesNotThrow(() => assertVerificationProfileRetention(legacy, capable));
  assert.throws(
    () => assertVerificationProfileRetention(capable, legacy),
    /verification profile schema must be retained/,
  );
  assert.throws(
    () => assertVerificationProfileRetention(withLiveProfile, capable),
    /verification profile versions are immutable and retained/,
  );
});

test("the bundled validator accepts Goal-capable Core and enforces retained lifecycle", async () => {
  const legacyEntries = await validCoreEntries();
  const contractEntries = [
    ...legacyEntries,
    ...(await verificationProfileContractEntries()),
    ...(await goalContractEntries()),
  ];
  const capable = validateCoreCatalog(contractEntries);

  assert.equal(capable.goalCount, 0);
  assert.deepEqual(capable.goals, []);
  assert.equal(
    capable.schemaDigests.envelope,
    "sha256:07eb4ca0d97de3668e3d71227c675562f69c451647ab5e6fa33e6fe9de80eb5f",
  );
  assert.equal(
    capable.schemaDigests.goal,
    "sha256:76341409e4dc33fbc50d1432d2488e1ecec767263733939f0abe9bf173aada0b",
  );
  assert.equal(capable.validFixtureCount, 5);
  assert.equal(capable.invalidFixtureCount, 4);

  const liveProfile = entryFor(
    "organization/contracts/verification-profiles/required-check-reliability/v1.json",
    json(validVerificationProfile()),
  );
  const liveGoalPath = "organization/goals/improve-ci-reliability-2026-q4.json";
  assert.throws(
    () =>
      validateCoreCatalog([
        ...contractEntries,
        liveProfile,
        entryFor(liveGoalPath, json(validGoal("active"))),
      ]),
    (error) =>
      error instanceof CoreValidationError &&
      /references unsupported verification mechanisms/.test(error.message) &&
      error.details.length === 1 &&
      error.details[0] === "source adapter github-required-checks:v1",
  );

  const catalogWithGoal = (status: Parameters<typeof validGoal>[0]) => ({
    ...capable,
    goalCount: 1,
    goals: [
      {
        path: liveGoalPath,
        contentDigest: `sha256:${"0".repeat(64)}`,
        goal: validGoal(status),
      },
    ],
  });
  const active = catalogWithGoal("active");
  const paused = catalogWithGoal("paused");
  const completed = catalogWithGoal("completed");

  assert.doesNotThrow(() => assertGoalRetention(active, paused));
  assert.doesNotThrow(() => assertGoalRetention(paused, completed));
  assert.throws(
    () => assertGoalRetention(completed, active),
    /Goals must be retained with valid lifecycle transitions/,
  );
  assert.throws(
    () => assertGoalRetention(active, capable),
    /Goals must be retained with valid lifecycle transitions/,
  );
  assert.doesNotThrow(() => assertGoalRetention(validateCoreCatalog(legacyEntries), capable));
});

test("the widened v1 program enum (core ADR-0039) validates and the enum stays closed", async () => {
  const entries = await validCoreEntries();
  const repository = entries.find((entry) => entry.path === "organization/repositories/frostyard/core.json")!;
  const declare = (programs: string[]) =>
    entryFor(
      repository.path,
      json({
        schema_version: 1,
        repository: { owner: "frostyard", name: "core", repository_id: "1331309458" },
        accountable_owners: [{ kind: "github-user", login: "bketelsen" }],
        fleet_state: "enabled",
        maintenance_programs: programs,
        action_ceiling: ["read"],
        surface_contract_version: 1,
      }),
    );
  const swap = (replacement: CoreTreeEntry) => entries.map((entry) => (entry === repository ? replacement : entry));

  const widened = validateCoreCatalog(swap(declare(["quality", "conformance", "triage", "dependencies", "docs", "release"])));
  assert.deepEqual(widened.repositories[0]?.declaration.maintenance_programs, ["quality", "conformance", "triage", "dependencies", "docs", "release"]);
  const all = validateCoreCatalog(swap(declare(["quality", "ci", "security", "architecture", "conformance", "triage", "dependencies", "docs", "release"])));
  assert.equal(all.repositories[0]?.declaration.maintenance_programs.length, 9);
  assert.throws(() => validateCoreCatalog(swap(declare(["quality", "feature"]))), CoreValidationError);
  assert.throws(() => validateCoreCatalog(swap(declare(["quality", "quality"]))), CoreValidationError);
});

test("a superseded, bundled schema revision is still accepted and reported by its own digest", async () => {
  const entries = await validCoreEntries();
  const schema = entries.find((entry) => entry.path.endsWith("repository.schema.json"))!;
  const supersededBytes = readFileSync(new URL("../src/core/schemas/v1/superseded/repository.schema.2419d096.json", import.meta.url));
  const withSuperseded = entries.map((entry) => (entry === schema ? entryFor(entry.path, supersededBytes) : entry));
  const validated = validateCoreCatalog(withSuperseded);
  assert.equal(validated.schemaDigests.repository, "sha256:2419d096faac298b8c4a75a3a83b617f4797e4e5f190ccd918ead73ba604bead");
  assert.notEqual(validated.schemaDigests.repository, validateCoreCatalog(entries).schemaDigests.repository);
  // The superseded revision validates with its own (narrower) enum: a widened value is unknown to it.
  const repository = withSuperseded.find((entry) => entry.path === "organization/repositories/frostyard/core.json")!;
  const widened = entryFor(
    repository.path,
    json({
      schema_version: 1,
      repository: { owner: "frostyard", name: "core", repository_id: "1331309458" },
      accountable_owners: [{ kind: "github-user", login: "bketelsen" }],
      fleet_state: "enabled",
      maintenance_programs: ["conformance"],
      action_ceiling: ["read"],
      surface_contract_version: 1,
    }),
  );
  assert.throws(() => validateCoreCatalog(withSuperseded.map((entry) => (entry === repository ? widened : entry))), CoreValidationError);
});

test("schema byte drift and duplicate live keys fail the candidate", async () => {
  const entries = await validCoreEntries();
  const schema = entries.find((entry) => entry.path.endsWith("repository.schema.json"))!;
  const drifted = entries.map((entry) =>
    entry === schema ? entryFor(entry.path, Buffer.concat([Buffer.from(entry.bytes), Buffer.from("\n")])) : entry,
  );
  assert.throws(() => validateCoreCatalog(drifted), /schema bytes do not match Snowcat's bundled v1 contract/);

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
  const directory = await mkdtemp(join(tmpdir(), "snowcat-core-source-test-"));
  const source = join(directory, "source");
  const mirror = join(directory, "mirror.git");
  const entries = await validCoreEntries();
  for (const entry of entries) {
    const path = join(source, entry.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entry.bytes);
  }
  git(source, ["init", "-b", "main"]);
  git(source, ["config", "user.name", "Snowcat Test"]);
  git(source, ["config", "user.email", "snowcat-test@example.invalid"]);
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
  const directory = await mkdtemp(join(tmpdir(), "snowcat-core-rejection-test-"));
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
    { cwd: process.cwd(), encoding: "utf8", env: childEnvironment({ SNOWCAT_CONTROL_DB: path }) },
  );
  const cliRows = JSON.parse(output) as Array<Record<string, unknown>>;
  assert.equal(cliRows.length, 1);
  assert.equal(cliRows[0]?.checkId, continuityCheckId);
});

test("Core source freshness stays distinct from immediate admission blockers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-core-readiness-test-"));
  const path = join(directory, "control-plane.db");
  let now = new Date("2026-08-16T10:00:00.000Z");
  const store = new ControlPlaneStore(path, () => now);
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
  assert.throws(
    () =>
      store.issueCoreStaleSourceOverride({
        expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
        expiresAt: "2026-08-16T11:00:00.000Z",
        reason: "A fresh source does not need degraded operation",
      }),
    /requires source-stale readiness; found ready/,
  );

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
  assert.throws(
    () =>
      store.issueCoreStaleSourceOverride({
        expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
        expiresAt: "2026-08-16T12:00:00.000Z",
        reason: "A stale override must not bypass divergent authority",
      }),
    /requires source-stale readiness; found continuity-blocked/,
  );

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
  const sequenceBeforeOverride = store.metadata().lastTransactionSequence;
  assert.throws(
    () =>
      store.issueCoreStaleSourceOverride({
        expectedLastTransactionSequence: sequenceBeforeOverride,
        expiresAt: "2026-08-18T11:00:00.001Z",
        reason: "This attempted decision exceeds the bounded window",
      }),
    /cannot exceed 24 hours/,
  );
  assert.equal(store.metadata().lastTransactionSequence, sequenceBeforeOverride);
  const override = store.issueCoreStaleSourceOverride({
    expectedLastTransactionSequence: sequenceBeforeOverride,
    expiresAt: "2026-08-18T11:00:00.000Z",
    reason: "Keep organization-dependent admission available during the confirmed source outage",
  });
  assert.equal(override.transactionSequence, sequenceBeforeOverride + 1);
  assert.deepEqual(override.transactionPositions, [0, 1]);
  assert.deepEqual(store.issueCoreStaleSourceOverride({
    expectedLastTransactionSequence: sequenceBeforeOverride,
    expiresAt: "2026-08-18T11:00:00.000Z",
    reason: "Keep organization-dependent admission available during the confirmed source outage",
  }), override);
  const degraded = store.coreAdmissionReadiness();
  assert.equal(degraded.ready, true);
  assert.equal(degraded.reason, "ready");
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.overrideDecisionId, override.decisionRecordId);
  assert.equal(degraded.overrideExpiresAt, override.expiresAt);

  now = new Date("2026-08-18T11:00:00.000Z");
  const expired = store.coreAdmissionReadiness();
  assert.equal(expired.ready, false);
  assert.equal(expired.reason, "source-stale");
  assert.equal(expired.degraded, false);
  assert.equal(expired.overrideDecisionId, null);
  store.close();
  const reopened = new ControlPlaneStore(path, () => now);
  assert.equal(reopened.coreAdmissionReadiness().reason, "source-stale");
  reopened.close();
});

test("a stale-source override neither transfers to new authority nor masks a later hard failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-core-override-boundary-test-"));
  let now = new Date("2026-08-14T09:00:00.000Z");
  const store = new ControlPlaneStore(join(directory, "control-plane.db"), () => now);
  const first = await activationCandidate("1".repeat(40), "2".repeat(40));
  const firstActivation = store.activateCoreSnapshot({ candidate: first, expectedLastTransactionSequence: 1 });
  store.recordCoreSourceCheckEligible({
    checkId: uuidV7(now),
    candidate: first,
    expectedLastTransactionSequence: firstActivation.transactionSequence,
  });
  now = new Date("2026-08-15T10:00:00.000Z");
  const override = store.issueCoreStaleSourceOverride({
    expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
    expiresAt: "2026-08-16T10:00:00.000Z",
    reason: "Continue from the last validated authority during a bounded source outage",
  });
  assert.equal(store.coreAdmissionReadiness().overrideDecisionId, override.decisionRecordId);

  now = new Date("2026-08-15T11:00:00.000Z");
  const second = await activationCandidate("3".repeat(40), "4".repeat(40));
  store.rollbackCoreSnapshot({
    candidate: second,
    expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
    reason: "Select a separately reviewed recovery authority",
  });
  const afterRollback = store.coreAdmissionReadiness();
  assert.equal(afterRollback.reason, "continuity-blocked");
  assert.equal(afterRollback.degraded, false);
  assert.equal(afterRollback.overrideDecisionId, null);

  store.recordCoreSourceCheckEligible({
    checkId: uuidV7(now),
    candidate: second,
    expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
  });
  store.recordCoreCandidateRejection({
    checkId: uuidV7(now),
    operation: "automatic-source-check",
    stage: "validation",
    code: "candidate-invalid",
    summary: "a later configured-ref candidate is invalid",
    details: [],
    sourceUrl: second.sourceUrl,
    sourceRef: second.ref,
    commitId: "5".repeat(40),
    treeId: "6".repeat(40),
  });
  const hardFailure = store.coreAdmissionReadiness();
  assert.equal(hardFailure.reason, "candidate-invalid");
  assert.equal(hardFailure.degraded, false);
  assert.equal(hardFailure.overrideDecisionId, null);
  store.close();
});

test("Core check-detail pruning enforces 30 days while preserving readiness and cited evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-core-retention-test-"));
  const path = join(directory, "control-plane.db");
  let now = new Date("2026-06-01T00:00:00.000Z");
  let injectFailure = false;
  const store = new ControlPlaneStore(path, () => now, (point) => {
    if (injectFailure && point === "after-core-check-detail-delete") {
      throw new Error("injected check-detail prune failure");
    }
  });
  const candidate = await activationCandidate("7".repeat(40), "8".repeat(40));
  const activation = store.activateCoreSnapshot({ candidate, expectedLastTransactionSequence: 1 });
  const removableCheckId = uuidV7(now);
  store.recordCoreCandidateRejection({
    checkId: removableCheckId,
    operation: "automatic-source-check",
    stage: "validation",
    code: "candidate-invalid",
    summary: "an older invalid candidate is ordinary diagnostic detail",
    details: [],
    sourceUrl: candidate.sourceUrl,
    sourceRef: candidate.ref,
    commitId: "9".repeat(40),
    treeId: "a".repeat(40),
  });
  const citedCheckId = uuidV7(now);
  store.recordCoreSourceCheckEligible({
    checkId: citedCheckId,
    candidate,
    expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
  });

  now = new Date("2026-06-02T01:00:00.000Z");
  const override = store.issueCoreStaleSourceOverride({
    expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
    expiresAt: "2026-06-03T01:00:00.000Z",
    reason: "Preserve service while the configured authority source is unavailable",
  });
  now = new Date("2026-06-02T02:00:00.000Z");
  const latestValidatedCheckId = uuidV7(now);
  store.recordCoreSourceCheckEligible({
    checkId: latestValidatedCheckId,
    candidate,
    expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
  });
  now = new Date("2026-07-03T02:00:00.000Z");
  const latestAutomaticCheckId = uuidV7(now);
  store.recordCoreCandidateRejection({
    checkId: latestAutomaticCheckId,
    operation: "automatic-source-check",
    stage: "source",
    code: "source-unavailable",
    summary: "the configured Core ref is temporarily unavailable",
    details: [],
    sourceUrl: candidate.sourceUrl,
    sourceRef: candidate.ref,
  });

  const sequenceBeforePrune = store.metadata().lastTransactionSequence;
  const digestBeforeFailure = store.authoritativeDigest();
  injectFailure = true;
  assert.throws(
    () => store.pruneCoreCheckDetail({ expectedLastTransactionSequence: sequenceBeforePrune }),
    /injected check-detail prune failure/,
  );
  injectFailure = false;
  assert.equal(store.authoritativeDigest(), digestBeforeFailure);
  assert.equal(store.metadata().lastTransactionSequence, sequenceBeforePrune);
  assert.equal(store.coreCandidateRejections().some((row) => row.checkId === removableCheckId), true);

  const prune = store.pruneCoreCheckDetail({ expectedLastTransactionSequence: sequenceBeforePrune });
  assert.equal(prune.cutoffAt, "2026-06-03T02:00:00.000Z");
  assert.equal(prune.deletedTransactionCount, 1);
  assert.equal(prune.deletedOccurrenceCount, 2);
  assert.equal(prune.deletedFirstSequence, 3);
  assert.equal(prune.deletedLastSequence, 3);
  assert.equal(prune.remainingDetailedCheckCount, 3);
  assert.match(prune.deletedDigest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(prune.transactionPositions, [0, 1]);
  assert.equal(store.metadata().lastTransactionSequence, sequenceBeforePrune + 1);
  assert.deepEqual(
    store.occurrences().filter((occurrence) => occurrence.transactionSequence === prune.transactionSequence)
      .map((occurrence) => [occurrence.kind, occurrence.transactionPosition]),
    [
      ["core.check-detail-prune-observation", 0],
      ["core.check-detail-pruned", 1],
    ],
  );
  assert.equal(store.occurrences().some((occurrence) => occurrence.transactionSequence === 3), false);
  const retainedCheckIds = store.occurrences().flatMap((occurrence) =>
    occurrence.payload && typeof occurrence.payload === "object" && !Array.isArray(occurrence.payload) &&
      typeof occurrence.payload.checkId === "string"
      ? [occurrence.payload.checkId]
      : [],
  );
  assert.equal(retainedCheckIds.includes(citedCheckId), true);
  assert.equal(retainedCheckIds.includes(latestValidatedCheckId), true);
  assert.equal(retainedCheckIds.includes(latestAutomaticCheckId), true);
  assert.equal(store.occurrences().some((occurrence) => occurrence.recordId === override.decisionRecordId), true);
  assert.deepEqual(store.pruneCoreCheckDetail({ expectedLastTransactionSequence: sequenceBeforePrune }), prune);

  const empty = store.pruneCoreCheckDetail({
    expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
  });
  assert.equal(empty.deletedTransactionCount, 0);
  assert.equal(empty.deletedFirstSequence, null);
  assert.equal(empty.deletedLastSequence, null);
  assert.equal(empty.deletedDigest, `sha256:${createHash("sha256").update("[]").digest("hex")}`);
  store.close();

  const cliOutput = execFileSync(
    process.execPath,
    ["--import", "tsx", "src/core/cli.ts", "prune-check-history", String(empty.transactionSequence)],
    { cwd: process.cwd(), encoding: "utf8", env: childEnvironment({ SNOWCAT_CONTROL_DB: path }) },
  );
  const cliPrune = JSON.parse(cliOutput) as Record<string, unknown>;
  assert.equal(cliPrune.deletedTransactionCount, 0);
  assert.equal(cliPrune.transactionSequence, empty.transactionSequence + 1);

  const reopened = new ControlPlaneStore(path);
  assert.equal(reopened.metadata().lastTransactionSequence, cliPrune.transactionSequence);
  assert.equal(reopened.coreAdmissionReadiness().reason, "source-stale");
  reopened.close();
});

test("activate records a bounded source rejection while verify remains outside the target store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-core-cli-rejection-test-"));
  const controlPath = join(directory, "control-plane.db");
  const invalidMirror = join(directory, "not-a-bare-repository");
  await writeFile(invalidMirror, "not git", "utf8");
  const environment = childEnvironment({
    SNOWCAT_CONTROL_DB: controlPath,
    SNOWCAT_CORE_MIRROR: invalidMirror,
  });

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
  const directory = await mkdtemp(join(tmpdir(), "snowcat-core-activation-test-"));
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

test("automatic activation retains adopted verification profiles while rollback may select legacy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-core-profile-activation-test-"));
  const path = join(directory, "control-plane.db");
  const store = new ControlPlaneStore(
    path,
    () => new Date("2026-08-16T13:20:00.000Z"),
  );
  const legacy = await activationCandidate("1".repeat(40), "2".repeat(40));
  const legacyActivation = store.activateCoreSnapshot({
    candidate: legacy,
    expectedLastTransactionSequence: 1,
  });
  const profileCapable = await profileActivationCandidate("3".repeat(40), "4".repeat(40));
  const profileActivation = store.activateCoreSnapshot({
    candidate: profileCapable,
    expectedLastTransactionSequence: legacyActivation.transactionSequence,
    continuityAncestorCommitId: legacy.commitId,
  });
  assert.equal(profileCapable.verificationProfileCount, 1);
  assert.equal(profileActivation.transactionSequence, 3);

  const removed = await activationCandidate("5".repeat(40), "6".repeat(40));
  assert.throws(
    () =>
      store.activateCoreSnapshot({
        candidate: removed,
        expectedLastTransactionSequence: profileActivation.transactionSequence,
        continuityAncestorCommitId: profileCapable.commitId,
      }),
    /verification profile schema must be retained/,
  );
  const rollback = store.rollbackCoreSnapshot({
    candidate: legacy,
    expectedLastTransactionSequence: profileActivation.transactionSequence,
    reason: "Restore the exact retained authority that predates verification profiles",
  });
  assert.equal(rollback.sourceCommitId, legacy.commitId);
  assert.equal(rollback.transactionSequence, 4);

  const changedFiles = profileCapable.files.map((entry) =>
    entry.path ===
    "organization/contracts/verification-profiles/required-check-reliability/v1.json"
      ? entryFor(
          entry.path,
          json({ ...validVerificationProfile(), description: "Changed after an operator rollback." }),
        )
      : entry,
  );
  const changedAfterRollback: InspectedCoreCandidate = {
    sourceUrl: profileCapable.sourceUrl,
    ref: profileCapable.ref,
    commitId: "7".repeat(40),
    treeId: "8".repeat(40),
    files: changedFiles,
    ...validateCoreCatalog(changedFiles),
  };
  assert.throws(
    () =>
      store.activateCoreSnapshot({
        candidate: changedAfterRollback,
        expectedLastTransactionSequence: rollback.transactionSequence,
        continuityAncestorCommitId: legacy.commitId,
      }),
    /verification profile versions are immutable and retained/,
  );
  store.close();

  const reopened = new ControlPlaneStore(path);
  assert.equal(reopened.activeCoreSnapshot()?.sourceCommitId, legacy.commitId);
  reopened.close();
});

test("the shared source synchronizer activates and then records an unchanged eligible check", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-core-synchronizer-test-"));
  let now = new Date("2026-08-16T13:30:00.000Z");
  const store = new ControlPlaneStore(join(directory, "control-plane.db"), () => now);
  const candidate = await activationCandidate("4".repeat(40), "5".repeat(40));
  const config = {
    sourceUrl: candidate.sourceUrl,
    ref: candidate.ref,
    mirrorPath: join(directory, "unused.git"),
  };
  const adapters = { inspectCandidate: async () => candidate };
  const first = await synchronizeCoreSource(config, store, 1, adapters);
  assert.equal(first.status, "accepted");
  if (first.status !== "accepted") return;
  assert.equal(first.activation, "activated");
  assert.equal(first.activationResult?.transactionSequence, 2);
  assert.equal(first.sourceCheck.transactionSequence, 3);

  now = new Date("2026-08-16T13:45:00.000Z");
  const unchanged = await synchronizeCoreSource(config, store, 3, adapters);
  assert.equal(unchanged.status, "accepted");
  if (unchanged.status !== "accepted") return;
  assert.equal(unchanged.activation, "unchanged");
  assert.equal(unchanged.activationResult, null);
  assert.equal(unchanged.sourceCheck.transactionSequence, 4);
  assert.equal(store.coreAdmissionReadiness().lastValidatedAt, now.toISOString());
  store.close();
});

test("an attributed operator rollback creates a new snapshot and preserves later reactivation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-core-operator-rollback-test-"));
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
    { cwd: process.cwd(), encoding: "utf8", env: childEnvironment({ SNOWCAT_CONTROL_DB: path }) },
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

test("activeCoreRepositoryCatalog and activeCoreSurfaceContract read the retained candidate behind the active snapshot", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-core-active-catalog-test-"));
  const path = join(directory, "control-plane.db");
  const store = new ControlPlaneStore(path, () => new Date("2026-08-16T10:00:00.000Z"));
  context.after(() => store.close());

  assert.equal(store.activeCoreRepositoryCatalog(), undefined);
  assert.equal(store.activeCoreSurfaceContract(), undefined);

  const candidate = await activationCandidate("e".repeat(40), "f".repeat(40));
  const activation = store.activateCoreSnapshot({ candidate, expectedLastTransactionSequence: 1 });

  const catalog = store.activeCoreRepositoryCatalog();
  assert.equal(catalog?.snapshot.snapshotId, activation.snapshotId);
  assert.equal(catalog?.snapshot.sourceCommitId, candidate.commitId);
  assert.deepEqual(
    catalog?.repositories.map((repository) => repository.path),
    candidate.repositories.map((repository) => repository.path),
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(catalog?.repositories[0]?.declaration)),
    JSON.parse(JSON.stringify(candidate.repositories[0]?.declaration)),
  );

  const contract = store.activeCoreSurfaceContract();
  assert.equal(contract?.coreSnapshotId, activation.snapshotId);
  assert.equal(contract?.coreSourceCommitId, candidate.commitId);
  assert.equal(contract?.contract.contract.id, "repository-surfaces");
  assert.equal(contract?.contract.surfaces.length, 4);
  assert.throws(() => store.activeCoreSurfaceContract(2), /unsupported repository surface contract version/);
});

test("Core snapshot failure rolls back retained bytes and byte tampering fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-core-rollback-test-"));
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

async function profileActivationCandidate(
  commitId: string,
  treeId: string,
): Promise<InspectedCoreCandidate> {
  const files = [
    ...(await validCoreEntries()),
    ...(await verificationProfileContractEntries()),
    entryFor(
      "organization/contracts/verification-profiles/required-check-reliability/v1.json",
      json(validVerificationProfile()),
    ),
  ];
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

async function verificationProfileContractEntries(): Promise<CoreTreeEntry[]> {
  const bundled = await readFile(
    new URL("../src/core/schemas/v1/verification-profile.schema.json", import.meta.url),
  );
  const mismatched = {
    ...validVerificationProfile(),
    profile: { id: "mode-mismatch", version: 1 },
    evidence_mode: "deterministic",
    mechanism: {
      kind: "attestation-policy",
      attestation_policy: { id: "maintainer-attestation", version: 1 },
    },
    parameter_schema: emptyParameterSchema("mode-mismatch"),
  };
  const externalReference = {
    ...validVerificationProfile(),
    profile: { id: "external-reference", version: 1 },
    evidence_mode: "deterministic",
    mechanism: {
      kind: "deterministic-evaluator",
      evaluator: { id: "external-reference", version: 1 },
    },
    parameter_schema: {
      ...emptyParameterSchema("external-reference"),
      properties: { unsafe: { $ref: "https://example.com/remote.schema.json" } },
    },
  };
  return [
    entryFor("organization/schemas/v1/verification-profile.schema.json", bundled),
    entryFor(
      "organization/fixtures/v1/valid/verification-profile.json",
      json(validVerificationProfile()),
    ),
    entryFor(
      "organization/fixtures/v1/invalid/verification-profile-mode-mismatch.json",
      json(mismatched),
    ),
    entryFor(
      "organization/fixtures/v1/invalid/verification-profile-external-ref.json",
      json(externalReference),
    ),
  ];
}

async function goalContractEntries(): Promise<CoreTreeEntry[]> {
  const [envelopeSchema, goalSchema] = await Promise.all([
    readFile(new URL("../src/core/schemas/v1/envelope.schema.json", import.meta.url)),
    readFile(new URL("../src/core/schemas/v1/goal.schema.json", import.meta.url)),
  ]);
  const invalidGoal = validGoal("active");
  invalidGoal.spec.success_measures[0]!.required = false;
  return [
    entryFor("organization/schemas/v1/envelope.schema.json", envelopeSchema),
    entryFor("organization/schemas/v1/goal.schema.json", goalSchema),
    entryFor("organization/fixtures/v1/valid/goal.json", json(validGoal("active"))),
    entryFor(
      "organization/fixtures/v1/invalid/goal-no-required-measure.json",
      json(invalidGoal),
    ),
  ];
}

function validGoal(status: OrganizationGoal["metadata"]["status"]): OrganizationGoal {
  return {
    schema_version: 1,
    kind: "goal",
    metadata: {
      id: "improve-ci-reliability-2026-q4",
      status,
      owners: [{ kind: "github-user", id: "github.com:37492", login: "bketelsen" }],
      applies_to: {
        repository_selection: "selected",
        repository_ids: ["github.com:1331309458"],
      },
    },
    spec: {
      starts_on: "2026-10-01",
      ends_on: "2026-12-31",
      priority: "high",
      outcome: "Required checks remain conclusive and reliable while repositories evolve.",
      success_measures: [
        {
          id: "required-checks-stay-reliable",
          required: true,
          evidence_mode: "observational",
          subject: { kind: "github-repository", id: "github.com:1331309458" },
          observation_window: {
            starts_at: "2026-10-01T00:00:00.000Z",
            ends_at: "2026-10-31T23:59:59.999Z",
          },
          verification_profile: { id: "required-check-reliability", version: 1 },
          parameters: { minimum_rate: 0.95 },
        },
      ],
      encouraged_work: ["Improve required-check reliability."],
      excluded_work: ["Do not weaken required checks."],
    },
  };
}

function validVerificationProfile(): Record<string, unknown> {
  return {
    schema_version: 1,
    profile: { id: "required-check-reliability", version: 1 },
    description: "Evaluate required-check conclusions over a declared repository and time window.",
    evidence_mode: "observational",
    mechanism: {
      kind: "observational-evaluator",
      source_adapter: { id: "github-required-checks", version: 1 },
      evaluator: { id: "conclusive-run-rate", version: 1 },
    },
    parameter_schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://frostyard.org/schemas/organization/verification-profiles/required-check-reliability/v1-parameters.schema.json",
      type: "object",
      additionalProperties: false,
      required: ["minimum_rate"],
      properties: { minimum_rate: { type: "number", minimum: 0, maximum: 1 } },
    },
  };
}

function emptyParameterSchema(profileId: string): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id:
      `https://frostyard.org/schemas/organization/verification-profiles/` +
      `${profileId}/v1-parameters.schema.json`,
    type: "object",
    additionalProperties: false,
    properties: {},
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

function git(directory: string, args: string[]): void {
  execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" });
}
