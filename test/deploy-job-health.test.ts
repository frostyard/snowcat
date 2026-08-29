import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readScheduledJobHealth } from "../src/surface/job-health.ts";
import { childEnvironment } from "./helpers/child-environment.ts";

const WRAPPER = join(process.cwd(), "deploy", "bin", "snowcat-run-job");
const WRITER = join(process.cwd(), "scripts", "record-job-health.mjs");

interface RecordedHealth {
  version: 1;
  job: string;
  lastAttemptStartedAt: string;
  lastAttemptFinishedAt: string;
  lastDurationMs: number;
  lastWaitMs: number;
  lastResult: "success" | "failure";
  lastExitCode: number;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  lastFailureExitCode?: number;
}

function runJob(directory: string, job: string, command: string) {
  return spawnSync("bash", [WRAPPER, job, "bash", "-c", command], {
    encoding: "utf8",
    env: childEnvironment({
      SNOWCAT_HOME: process.cwd(),
      SNOWCAT_JOB_HEALTH_DIR: join(directory, "health"),
      SNOWCAT_JOB_LOCK_FILE: join(directory, "scheduled-jobs.lock"),
    }),
  });
}

async function readHealth(directory: string, job: string): Promise<RecordedHealth> {
  return JSON.parse(await readFile(join(directory, "health", `${job}.json`), "utf8")) as RecordedHealth;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForChild(child: ReturnType<typeof spawn>): Promise<{ code: number | null; stderr: string }> {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

test("snowcat-run-job retains the latest success and failure observations without partial files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-job-health-test-"));

  const first = runJob(directory, "verify-artifacts", "exit 0");
  assert.equal(first.status, 0, first.stderr);
  const firstHealth = await readHealth(directory, "verify-artifacts");
  assert.equal(firstHealth.lastResult, "success");
  assert.equal(firstHealth.lastExitCode, 0);
  assert.equal(firstHealth.lastSuccessAt, firstHealth.lastAttemptFinishedAt);
  assert.equal(firstHealth.lastFailureAt, undefined);

  const failed = runJob(directory, "verify-artifacts", "exit 7");
  assert.equal(failed.status, 7, failed.stderr);
  const failedHealth = await readHealth(directory, "verify-artifacts");
  assert.equal(failedHealth.lastResult, "failure");
  assert.equal(failedHealth.lastExitCode, 7);
  assert.equal(failedHealth.lastSuccessAt, firstHealth.lastSuccessAt);
  assert.equal(failedHealth.lastFailureAt, failedHealth.lastAttemptFinishedAt);
  assert.equal(failedHealth.lastFailureExitCode, 7);

  const recovered = runJob(directory, "verify-artifacts", "exit 0");
  assert.equal(recovered.status, 0, recovered.stderr);
  const recoveredHealth = await readHealth(directory, "verify-artifacts");
  assert.equal(recoveredHealth.lastResult, "success");
  assert.equal(recoveredHealth.lastSuccessAt, recoveredHealth.lastAttemptFinishedAt);
  assert.equal(recoveredHealth.lastFailureAt, failedHealth.lastFailureAt);
  assert.equal(recoveredHealth.lastFailureExitCode, 7);
  assert.deepEqual(await readdir(join(directory, "health")), ["verify-artifacts.json"]);

  await writeFile(join(directory, "health", "verify-artifacts.json"), "{corrupt");
  const healed = runJob(directory, "verify-artifacts", "exit 0");
  assert.equal(healed.status, 0, healed.stderr);
  assert.match(healed.stderr, /replacing unreadable previous health for verify-artifacts/);
  const healedHealth = await readHealth(directory, "verify-artifacts");
  assert.equal(healedHealth.lastResult, "success");
  assert.equal(healedHealth.lastSuccessAt, healedHealth.lastAttemptFinishedAt);
  assert.equal(healedHealth.lastFailureAt, undefined);

  const invalid = spawnSync(
    process.execPath,
    [WRITER, join(directory, "health"), "verify-artifacts", "not-a-time", healedHealth.lastAttemptFinishedAt, "0", "0", "0"],
    { encoding: "utf8" },
  );
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /ISO-8601 UTC timestamp/);
  assert.deepEqual(await readHealth(directory, "verify-artifacts"), healedHealth);
  assert.deepEqual(await readdir(join(directory, "health")), ["verify-artifacts.json"]);
});

test("snowcat-run-job serializes every scheduled command through one host lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-job-lock-test-"));
  const marker = join(directory, "first-started");
  const environment = childEnvironment({
    SNOWCAT_HOME: process.cwd(),
    SNOWCAT_JOB_HEALTH_DIR: join(directory, "health"),
    SNOWCAT_JOB_LOCK_FILE: join(directory, "scheduled-jobs.lock"),
  });

  const first = spawn("bash", [WRAPPER, "seed-dogfood", "bash", "-c", `touch '${marker}'; sleep 0.5`], {
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const firstDone = waitForChild(first);
  await waitForFile(marker);
  const second = spawn("bash", [WRAPPER, "verify-artifacts", "bash", "-c", "exit 0"], {
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });

  const [firstResult, secondResult] = await Promise.all([firstDone, waitForChild(second)]);
  assert.equal(firstResult.code, 0, firstResult.stderr);
  assert.equal(secondResult.code, 0, secondResult.stderr);
  const secondHealth = await readHealth(directory, "verify-artifacts");
  assert.ok(secondHealth.lastWaitMs >= 300, `expected lock wait >= 300 ms, got ${secondHealth.lastWaitMs}`);
});

test("snowcat-run-job records a terminated command as a failed attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-job-signal-test-"));
  const marker = join(directory, "child-started");
  const child = spawn(
    "bash",
    [WRAPPER, "import-issues", process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "started"); setTimeout(() => {}, 5000)`],
    {
      env: childEnvironment({
        SNOWCAT_HOME: process.cwd(),
        SNOWCAT_JOB_HEALTH_DIR: join(directory, "health"),
        SNOWCAT_JOB_LOCK_FILE: join(directory, "scheduled-jobs.lock"),
      }),
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const completed = waitForChild(child);
  await waitForFile(marker);
  child.kill("SIGTERM");
  const result = await completed;
  assert.equal(result.code, 143, result.stderr);
  const health = await readHealth(directory, "import-issues");
  assert.equal(health.lastResult, "failure");
  assert.equal(health.lastExitCode, 143);
  assert.equal(health.lastFailureAt, health.lastAttemptFinishedAt);
});

test("readScheduledJobHealth distinguishes absent, valid, malformed, and mismatched observations", async () => {
  assert.deepEqual(readScheduledJobHealth(undefined), []);

  const directory = await mkdtemp(join(tmpdir(), "snowcat-job-health-reader-test-"));
  assert.equal(readScheduledJobHealth(directory).every((row) => row.status === "never-run"), true);

  const valid: RecordedHealth = {
    version: 1,
    job: "verify-artifacts",
    lastAttemptStartedAt: "2026-08-29T00:00:00.000Z",
    lastAttemptFinishedAt: "2026-08-29T00:00:02.000Z",
    lastDurationMs: 2_000,
    lastWaitMs: 15,
    lastResult: "failure",
    lastExitCode: 1,
    lastSuccessAt: "2026-08-28T23:58:00.000Z",
    lastFailureAt: "2026-08-29T00:00:02.000Z",
    lastFailureExitCode: 1,
  };
  await writeFile(join(directory, "verify-artifacts.json"), `${JSON.stringify(valid)}\n`);
  await writeFile(join(directory, "import-issues.json"), "{not json");
  await writeFile(join(directory, "seed-dogfood.json"), `${JSON.stringify({ ...valid, job: "backup" })}\n`);
  await writeFile(join(directory, "sweep-dependencies.json"), "x".repeat(16 * 1024 + 1));

  const rows = readScheduledJobHealth(directory);
  assert.deepEqual(rows.find((row) => row.job === "verify-artifacts"), {
    job: valid.job,
    status: valid.lastResult,
    lastAttemptStartedAt: valid.lastAttemptStartedAt,
    lastAttemptFinishedAt: valid.lastAttemptFinishedAt,
    lastDurationMs: valid.lastDurationMs,
    lastWaitMs: valid.lastWaitMs,
    lastExitCode: valid.lastExitCode,
    lastSuccessAt: valid.lastSuccessAt,
    lastFailureAt: valid.lastFailureAt,
    lastFailureExitCode: valid.lastFailureExitCode,
  });
  const malformed = rows.find((row) => row.job === "import-issues");
  assert.equal(malformed?.status, "unreadable");
  assert.match(malformed?.status === "unreadable" ? malformed.reason : "", /JSON/);
  const mismatched = rows.find((row) => row.job === "seed-dogfood");
  assert.equal(mismatched?.status, "unreadable");
  assert.match(mismatched?.status === "unreadable" ? mismatched.reason : "", /does not match the scheduled-job contract/);
  const oversized = rows.find((row) => row.job === "sweep-dependencies");
  assert.equal(oversized?.status, "unreadable");
  assert.match(oversized?.status === "unreadable" ? oversized.reason : "", /exceeds 16384 bytes/);
  assert.equal(rows.find((row) => row.job === "backup")?.status, "never-run");
});
