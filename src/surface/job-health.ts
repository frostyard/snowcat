import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_HEALTH_FILE_BYTES = 16 * 1024;

export const scheduledJobNames = [
  "verify-artifacts",
  "import-issues",
  "seed-dogfood",
  "sweep-dependencies",
  "sweep-settings",
  "backup",
] as const;

export type ScheduledJobName = (typeof scheduledJobNames)[number];

export type ScheduledJobHealth =
  | { job: ScheduledJobName; status: "never-run" }
  | { job: ScheduledJobName; status: "unreadable"; reason: string }
  | {
      job: ScheduledJobName;
      status: "success" | "failure";
      lastAttemptStartedAt: string;
      lastAttemptFinishedAt: string;
      lastDurationMs: number;
      lastWaitMs: number;
      lastExitCode: number;
      lastSuccessAt?: string;
      lastFailureAt?: string;
      lastFailureExitCode?: number;
    };

/** Read the six atomically replaced host-job observations without opening a database. */
export function readScheduledJobHealth(directory: string | undefined): ScheduledJobHealth[] {
  if (directory === undefined) return [];
  return scheduledJobNames.map((job) => readOne(directory, job));
}

function readOne(directory: string, job: ScheduledJobName): ScheduledJobHealth {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readBoundedFile(join(directory, `${job}.json`)));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return { job, status: "never-run" };
    return { job, status: "unreadable", reason: message(error) };
  }
  if (!isHealthRecord(parsed, job)) {
    return { job, status: "unreadable", reason: "health file does not match the scheduled-job contract" };
  }
  return {
    job,
    status: parsed.lastResult,
    lastAttemptStartedAt: parsed.lastAttemptStartedAt,
    lastAttemptFinishedAt: parsed.lastAttemptFinishedAt,
    lastDurationMs: parsed.lastDurationMs,
    lastWaitMs: parsed.lastWaitMs,
    lastExitCode: parsed.lastExitCode,
    ...(parsed.lastSuccessAt === undefined ? {} : { lastSuccessAt: parsed.lastSuccessAt }),
    ...(parsed.lastFailureAt === undefined ? {} : { lastFailureAt: parsed.lastFailureAt }),
    ...(parsed.lastFailureExitCode === undefined ? {} : { lastFailureExitCode: parsed.lastFailureExitCode }),
  };
}

interface HealthRecord {
  version: 1;
  job: ScheduledJobName;
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

function isHealthRecord(value: unknown, job: ScheduledJobName): value is HealthRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    record.job === job &&
    iso(record.lastAttemptStartedAt) &&
    iso(record.lastAttemptFinishedAt) &&
    nonNegativeInteger(record.lastDurationMs) &&
    nonNegativeInteger(record.lastWaitMs) &&
    (record.lastResult === "success" || record.lastResult === "failure") &&
    exitCode(record.lastExitCode) &&
    (record.lastResult === "success") === (record.lastExitCode === 0) &&
    optionalIso(record.lastSuccessAt) &&
    optionalIso(record.lastFailureAt) &&
    (record.lastFailureAt === undefined) === (record.lastFailureExitCode === undefined) &&
    (record.lastFailureExitCode === undefined || (exitCode(record.lastFailureExitCode) && record.lastFailureExitCode !== 0))
  );
}

function iso(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function optionalIso(value: unknown): boolean {
  return value === undefined || iso(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function exitCode(value: unknown): value is number {
  return nonNegativeInteger(value) && value <= 255;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 240);
}

function readBoundedFile(path: string): string {
  const descriptor = openSync(path, "r");
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("health path is not a regular file");
    if (stat.size > MAX_HEALTH_FILE_BYTES) throw new Error(`health file exceeds ${MAX_HEALTH_FILE_BYTES} bytes`);
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}
