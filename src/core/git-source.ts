import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  CoreValidationError,
  validateCoreCatalog,
  type CoreTreeEntry,
  type ValidatedCoreCatalog,
} from "./validator.ts";

const CANDIDATE_REF = "refs/fluent/core-candidate";
const MAX_TREE_ENTRIES = 256;
const MAX_FILE_BYTES = 1_048_576;
const MAX_TREE_BYTES = 8_388_608;
const MAX_PATH_BYTES = 512;
const MAX_PATH_DEPTH = 12;
const ALLOWED_SOURCE_URLS = new Set([
  "https://github.com/frostyard/core.git",
  "git@github.com:frostyard/core.git",
  "ssh://git@github.com/frostyard/core.git",
]);

export interface CoreGitSourceConfig {
  sourceUrl: string;
  ref: string;
  mirrorPath: string;
  /** Test-only support for a local fixture repository. */
  allowFileSource?: boolean;
}

export interface InspectedCoreCandidate extends ValidatedCoreCatalog {
  sourceUrl: string;
  ref: string;
  commitId: string;
  treeId: string;
  files: CoreTreeEntry[];
}

export class CoreCandidateInspectionError extends Error {
  constructor(
    readonly stage: "source" | "validation",
    readonly code: "source-unavailable" | "candidate-invalid",
    message: string,
    readonly details: readonly string[],
    readonly sourceUrl: string,
    readonly ref: string,
    readonly commitId?: string,
    readonly treeId?: string,
  ) {
    super(message);
    this.name = "CoreCandidateInspectionError";
  }
}

export class CoreSourceContinuityError extends Error {
  readonly stage = "continuity" as const;

  constructor(
    readonly code: "candidate-not-descendant" | "continuity-unverifiable",
    message: string,
    readonly details: readonly string[],
    readonly sourceUrl: string,
    readonly ref: string,
    readonly commitId: string,
    readonly treeId: string,
    readonly catalogDigest: string,
    readonly activeCommitId: string,
  ) {
    super(message);
    this.name = "CoreSourceContinuityError";
  }
}

export function coreGitSourceConfig(): CoreGitSourceConfig {
  return {
    sourceUrl: process.env.FLUENT_CORE_URL ?? "https://github.com/frostyard/core.git",
    ref: process.env.FLUENT_CORE_REF ?? "refs/heads/main",
    mirrorPath: resolve(process.env.FLUENT_CORE_MIRROR ?? "./data/core.git"),
  };
}

export async function inspectCoreCandidate(config: CoreGitSourceConfig): Promise<InspectedCoreCandidate> {
  assertConfig(config);
  let commitId: string | undefined;
  let treeId: string | undefined;
  try {
    const mirrorPath = resolve(config.mirrorPath);
    await ensureBareMirror(mirrorPath, Boolean(config.allowFileSource));

    await git(
      [
        "--git-dir",
        mirrorPath,
        "fetch",
        "--force",
        "--no-tags",
        "--no-recurse-submodules",
        config.sourceUrl,
        `+${config.ref}:${CANDIDATE_REF}`,
      ],
      { allowFileSource: Boolean(config.allowFileSource), maxBuffer: 1_048_576 },
    );
    commitId = decodeLine(
      await git(["--git-dir", mirrorPath, "rev-parse", `${CANDIDATE_REF}^{commit}`], {
        allowFileSource: Boolean(config.allowFileSource),
      }),
      "candidate commit",
    );
    assertObjectId(commitId, "candidate commit");
    treeId = decodeLine(
      await git(["--git-dir", mirrorPath, "rev-parse", `${commitId}:organization`], {
        allowFileSource: Boolean(config.allowFileSource),
      }),
      "organization tree",
    );
    assertObjectId(treeId, "organization tree");

    const listing = await git(
      ["--git-dir", mirrorPath, "ls-tree", "-r", "-z", "-l", "--full-tree", commitId, "--", "organization/"],
      { allowFileSource: Boolean(config.allowFileSource), maxBuffer: 1_048_576 },
    );
    const metadata = parseTreeListing(listing);
    const entries: CoreTreeEntry[] = [];
    for (const item of metadata) {
      const bytes = await git(["--git-dir", mirrorPath, "cat-file", "blob", item.objectId], {
        allowFileSource: Boolean(config.allowFileSource),
        maxBuffer: MAX_FILE_BYTES + 1,
      });
      if (bytes.byteLength !== item.size) {
        throw new Error(`${item.path}: Git blob size changed during candidate inspection`);
      }
      entries.push({ ...item, bytes });
    }

    return {
      sourceUrl: config.sourceUrl,
      ref: config.ref,
      commitId,
      treeId,
      files: entries,
      ...validateCoreCatalog(entries),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const details = error instanceof CoreValidationError ? error.details : [];
    throw new CoreCandidateInspectionError(
      commitId === undefined ? "source" : "validation",
      commitId === undefined ? "source-unavailable" : "candidate-invalid",
      message,
      details,
      config.sourceUrl,
      config.ref,
      commitId,
      treeId,
    );
  }
}

export async function verifyCoreSourceContinuity(
  config: CoreGitSourceConfig,
  candidate: InspectedCoreCandidate,
  activeCommitId: string,
): Promise<void> {
  assertConfig(config);
  assertObjectId(activeCommitId, "active Core source commit");
  if (candidate.sourceUrl !== config.sourceUrl || candidate.ref !== config.ref) {
    throw new Error("Core candidate source does not match the continuity source configuration");
  }
  if (candidate.commitId === activeCommitId) return;

  let descendant: boolean;
  try {
    descendant = await gitIsAncestor(
      ["--git-dir", resolve(config.mirrorPath), "merge-base", "--is-ancestor", activeCommitId, candidate.commitId],
      Boolean(config.allowFileSource),
    );
  } catch (error) {
    throw new CoreSourceContinuityError(
      "continuity-unverifiable",
      `Core source continuity from ${activeCommitId} to ${candidate.commitId} could not be verified`,
      [error instanceof Error ? error.message : String(error)],
      candidate.sourceUrl,
      candidate.ref,
      candidate.commitId,
      candidate.treeId,
      candidate.catalogDigest,
      activeCommitId,
    );
  }
  if (!descendant) {
    throw new CoreSourceContinuityError(
      "candidate-not-descendant",
      `Core candidate ${candidate.commitId} does not descend from active commit ${activeCommitId}`,
      [],
      candidate.sourceUrl,
      candidate.ref,
      candidate.commitId,
      candidate.treeId,
      candidate.catalogDigest,
      activeCommitId,
    );
  }
}

function assertConfig(config: CoreGitSourceConfig): void {
  if (!config.allowFileSource && !ALLOWED_SOURCE_URLS.has(config.sourceUrl)) {
    throw new Error("core source URL must identify the configured frostyard/core GitHub repository");
  }
  if (
    !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(config.ref) ||
    config.ref.includes("..") ||
    config.ref.includes("//") ||
    config.ref.includes("@{") ||
    config.ref.endsWith("/") ||
    config.ref.endsWith(".")
  ) {
    throw new Error("core source ref must be one canonical refs/heads/* name");
  }
  if (!config.mirrorPath || config.mirrorPath === ":memory:") {
    throw new Error("core mirror must be a filesystem path");
  }
}

async function ensureBareMirror(mirrorPath: string, allowFileSource: boolean): Promise<void> {
  if (!existsSync(mirrorPath)) {
    mkdirSync(dirname(mirrorPath), { recursive: true });
    await git(["init", "--bare", mirrorPath], { allowFileSource });
  }
  if (existsSync(join(mirrorPath, "objects", "info", "alternates"))) {
    throw new Error("core mirror must not use alternate object storage");
  }
  const bare = decodeLine(
    await git(["--git-dir", mirrorPath, "rev-parse", "--is-bare-repository"], { allowFileSource }),
    "bare repository check",
  );
  if (bare !== "true") throw new Error("core mirror path is not a bare Git repository");
}

function parseTreeListing(bytes: Buffer): Array<Omit<CoreTreeEntry, "bytes"> & { size: number }> {
  let listing: string;
  try {
    listing = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("core organization tree contains a path that is not valid UTF-8");
  }
  const rows = listing.split("\0").filter(Boolean);
  if (rows.length === 0) throw new Error("core organization tree is empty");
  if (rows.length > MAX_TREE_ENTRIES) throw new Error(`core organization tree exceeds ${MAX_TREE_ENTRIES} files`);

  let totalBytes = 0;
  const seen = new Set<string>();
  const entries = rows.map((row) => {
    const match = /^(\d{6}) ([a-z]+) ([0-9a-f]+)\s+(\d+|-|)\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error("core organization tree contains an unparseable Git entry");
    const [, mode, type, objectId, rawSize, path] = match;
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new Error(`${path}: organization authority accepts only regular Git blobs`);
    }
    assertObjectId(objectId!, `${path} object`);
    const size = Number(rawSize);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {
      throw new Error(`${path}: authority file exceeds the ${MAX_FILE_BYTES}-byte limit`);
    }
    if (!path!.startsWith("organization/") || Buffer.byteLength(path!, "utf8") > MAX_PATH_BYTES) {
      throw new Error(`${path}: authority path is outside the bounded organization tree`);
    }
    if (path!.split("/").length > MAX_PATH_DEPTH || path!.split("/").some((component) => !component || component === "." || component === "..")) {
      throw new Error(`${path}: authority path exceeds the depth limit or contains an unsafe component`);
    }
    if (seen.has(path!)) throw new Error(`${path}: duplicate Git tree path`);
    seen.add(path!);
    totalBytes += size;
    if (totalBytes > MAX_TREE_BYTES) throw new Error(`core organization tree exceeds ${MAX_TREE_BYTES} total bytes`);
    return { path: path!, mode: mode as "100644" | "100755", objectId: objectId!, size };
  });
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function assertObjectId(value: string, label: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new Error(`${label} is not a canonical Git object ID`);
}

function decodeLine(bytes: Buffer, label: string): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
  if (!value || value.includes("\n") || value.includes("\r")) throw new Error(`${label} did not resolve to one value`);
  return value;
}

function git(
  args: readonly string[],
  options: { allowFileSource: boolean; maxBuffer?: number },
): Promise<Buffer> {
  const environment = secureGitEnvironment();
  const secureArgs = secureGitArgs(args, options.allowFileSource);
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      secureArgs,
      { encoding: "buffer", env: environment, maxBuffer: options.maxBuffer ?? 256 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise(Buffer.from(stdout));
          return;
        }
        const detail = Buffer.from(stderr).toString("utf8").trim().split("\n").slice(-1)[0];
        reject(new Error(`git ${args[0] ?? "command"} failed${detail ? `: ${detail}` : ""}`));
      },
    );
  });
}

function gitIsAncestor(args: readonly string[], allowFileSource: boolean): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      secureGitArgs(args, allowFileSource),
      { encoding: "buffer", env: secureGitEnvironment(), maxBuffer: 256 * 1024 },
      (error, _stdout, stderr) => {
        if (!error) {
          resolvePromise(true);
          return;
        }
        if (error.code === 1) {
          resolvePromise(false);
          return;
        }
        const detail = Buffer.from(stderr).toString("utf8").trim().split("\n").slice(-1)[0];
        reject(new Error(`git merge-base failed${detail ? `: ${detail}` : ""}`));
      },
    );
  });
}

function secureGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  delete environment.GIT_DIR;
  delete environment.GIT_WORK_TREE;
  delete environment.GIT_OBJECT_DIRECTORY;
  delete environment.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  delete environment.GIT_EXEC_PATH;
  delete environment.GIT_CONFIG_COUNT;
  for (const key of Object.keys(environment)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_/.test(key)) delete environment[key];
  }
  return environment;
}

function secureGitArgs(args: readonly string[], allowFileSource: boolean): string[] {
  return [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    `protocol.file.allow=${allowFileSource ? "always" : "never"}`,
    "-c",
    "protocol.ext.allow=never",
    ...args,
  ];
}
