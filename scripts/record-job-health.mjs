#!/usr/bin/env node

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync, fsyncSync } from "node:fs";
import { basename, join } from "node:path";

const JOBS = new Set([
  "backup",
  "import-issues",
  "seed-dogfood",
  "sweep-dependencies",
  "sweep-settings",
  "verify-artifacts",
]);

const [directory, job, startedAt, finishedAt, durationValue, waitValue, exitValue] = process.argv.slice(2);
if (!directory || !job || !startedAt || !finishedAt || durationValue === undefined || waitValue === undefined || exitValue === undefined) {
  throw new Error("usage: record-job-health.mjs <directory> <job> <started-at> <finished-at> <duration-ms> <wait-ms> <exit-code>");
}
if (!JOBS.has(job)) throw new Error(`unknown scheduled job: ${job}`);
const durationMs = integer(durationValue, "duration-ms");
const waitMs = integer(waitValue, "wait-ms");
const exitCode = integer(exitValue, "exit-code");
if (exitCode > 255) throw new Error("exit-code must be at most 255");
timestamp(startedAt, "started-at");
timestamp(finishedAt, "finished-at");

mkdirSync(directory, { recursive: true, mode: 0o750 });
const path = join(directory, `${job}.json`);
let previous = {};
try {
  previous = JSON.parse(readFileSync(path, "utf8"));
  validatePrevious(previous, job);
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
    console.error(`record-job-health: replacing unreadable previous health for ${job}: ${message(error)}`);
    previous = {};
  }
}

const succeeded = exitCode === 0;
const next = {
  version: 1,
  job,
  lastAttemptStartedAt: startedAt,
  lastAttemptFinishedAt: finishedAt,
  lastDurationMs: durationMs,
  lastWaitMs: waitMs,
  lastResult: succeeded ? "success" : "failure",
  lastExitCode: exitCode,
  ...(succeeded
    ? {
        lastSuccessAt: finishedAt,
        ...("lastFailureAt" in previous ? { lastFailureAt: previous.lastFailureAt } : {}),
        ...("lastFailureExitCode" in previous ? { lastFailureExitCode: previous.lastFailureExitCode } : {}),
      }
    : {
        ...("lastSuccessAt" in previous ? { lastSuccessAt: previous.lastSuccessAt } : {}),
        lastFailureAt: finishedAt,
        lastFailureExitCode: exitCode,
      }),
};

const temporary = join(directory, `.${basename(path)}.${process.pid}.tmp`);
let descriptor;
try {
  descriptor = openSync(temporary, "wx", 0o600);
  writeSync(descriptor, `${JSON.stringify(next)}\n`);
  fsyncSync(descriptor);
  closeSync(descriptor);
  descriptor = undefined;
  renameSync(temporary, path);
  const directoryDescriptor = openSync(directory, "r");
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
} catch (error) {
  if (descriptor !== undefined) closeSync(descriptor);
  rmSync(temporary, { force: true });
  throw error;
}

function integer(value, name) {
  if (!/^[0-9]+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} is outside the safe integer range`);
  return parsed;
}

function timestamp(value, name) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(`${name} must be an ISO-8601 UTC timestamp`);
}

function validatePrevious(value, expectedJob) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("existing job health is not an object");
  if (value.version !== 1 || value.job !== expectedJob) throw new Error("existing job health has the wrong version or job");
  if (value.lastResult !== "success" && value.lastResult !== "failure") throw new Error("existing job health has an invalid result");
  for (const field of ["lastAttemptStartedAt", "lastAttemptFinishedAt"]) timestamp(value[field], field);
  for (const field of ["lastDurationMs", "lastWaitMs", "lastExitCode"]) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) throw new Error(`existing job health has an invalid ${field}`);
  }
  if (value.lastExitCode > 255 || (value.lastResult === "success") !== (value.lastExitCode === 0)) {
    throw new Error("existing job health has an inconsistent result and exit code");
  }
  if ("lastSuccessAt" in value) timestamp(value.lastSuccessAt, "lastSuccessAt");
  if ("lastFailureAt" in value) timestamp(value.lastFailureAt, "lastFailureAt");
  if (
    ("lastFailureAt" in value) !== ("lastFailureExitCode" in value) ||
    ("lastFailureExitCode" in value &&
      (!Number.isSafeInteger(value.lastFailureExitCode) || value.lastFailureExitCode <= 0 || value.lastFailureExitCode > 255))
  ) {
    throw new Error("existing job health has an invalid lastFailureExitCode");
  }
}

function message(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}
