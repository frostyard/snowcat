import { createHash } from "node:crypto";

import type { RepositorySurfaceContract, RepositorySurfaceDefinition } from "../core/validator.ts";
import { githubApiJson, type GitHubFetch } from "./github-api.ts";

const GITHUB_TIMEOUT_MS = 30_000;
const MAX_SURFACE_BYTES = 1_048_576;
const MAX_TREE_ENTRIES = 2_000;

export interface RepositorySurfaceTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  objectId: string;
  size: number | null;
}

export type RepositorySurfaceProbeEntry =
  | { surfaceId: string; path: string; kind: "missing" }
  | {
      surfaceId: string;
      path: string;
      kind: "found";
      mode: string;
      objectType: "blob" | "tree" | "commit";
      objectId: string;
      bytes: Uint8Array | null;
      treeEntries: RepositorySurfaceTreeEntry[] | null;
    };

export type RepositorySurfaceProbeInput =
  | { kind: "unavailable" }
  | {
      kind: "resolved";
      defaultBranch: string;
      repositoryCommitId: string;
      repositoryTreeId: string;
      surfaces: RepositorySurfaceProbeEntry[];
    };

export interface RepositorySurfaceInspectionTarget {
  owner: string;
  name: string;
  defaultBranch: string;
  contract: RepositorySurfaceContract;
}

export async function inspectRepositorySurfaces(
  target: RepositorySurfaceInspectionTarget,
  fetcher: GitHubFetch = fetch,
): Promise<RepositorySurfaceProbeInput> {
  assertTarget(target);
  const signal = AbortSignal.timeout(GITHUB_TIMEOUT_MS);
  const base = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}`;
  const commit = await githubApiJson(
    `${base}/commits/${encodeURIComponent(target.defaultBranch)}`,
    signal,
    fetcher,
  );
  if (commit.kind === "unavailable" || commit.status !== 200) return { kind: "unavailable" };
  const revision = parseCommit(commit.value);
  if (!revision) return { kind: "unavailable" };

  const trees = new Map<string, RepositorySurfaceTreeEntry[]>();
  const loadTree = async (treeId: string): Promise<RepositorySurfaceTreeEntry[] | null> => {
    const cached = trees.get(treeId);
    if (cached) return cached;
    const response = await githubApiJson(`${base}/git/trees/${treeId}`, signal, fetcher);
    if (response.kind === "unavailable" || response.status !== 200) return null;
    const listing = parseTree(response.value, treeId);
    if (!listing) return null;
    trees.set(treeId, listing);
    return listing;
  };

  const surfaces: RepositorySurfaceProbeEntry[] = [];
  for (const surface of target.contract.surfaces) {
    const resolved = await resolveSurface(revision.treeId, surface, loadTree);
    if (resolved === null) return { kind: "unavailable" };
    if (resolved.kind === "missing") {
      surfaces.push({ surfaceId: surface.id, path: surface.path, kind: "missing" });
      continue;
    }
    if (resolved.objectType === "blob") {
      const blob = await githubApiJson(`${base}/git/blobs/${resolved.objectId}`, signal, fetcher);
      if (blob.kind === "unavailable" || blob.status !== 200) return { kind: "unavailable" };
      const bytes = parseBlob(blob.value, resolved.objectId);
      if (!bytes) return { kind: "unavailable" };
      surfaces.push({ ...resolved, bytes, treeEntries: null });
      continue;
    }
    if (resolved.objectType === "tree") {
      const entries = await loadTree(resolved.objectId);
      if (!entries) return { kind: "unavailable" };
      surfaces.push({ ...resolved, bytes: null, treeEntries: entries });
      continue;
    }
    surfaces.push({ ...resolved, bytes: null, treeEntries: null });
  }
  return {
    kind: "resolved",
    defaultBranch: target.defaultBranch,
    repositoryCommitId: revision.commitId,
    repositoryTreeId: revision.treeId,
    surfaces,
  };
}

export function surfaceTreeDigest(entries: readonly RepositorySurfaceTreeEntry[]): string {
  const material = entries
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return `sha256:${createHash("sha256").update(JSON.stringify(material)).digest("hex")}`;
}

export function repositoryGitBlobObjectId(bytes: Uint8Array): string {
  return createHash("sha1")
    .update(Buffer.from(`blob ${bytes.byteLength}\0`, "utf8"))
    .update(bytes)
    .digest("hex");
}

export function repositoryGitTreeObjectId(entries: readonly RepositorySurfaceTreeEntry[]): string {
  const ordered = [...entries].sort((left, right) =>
    Buffer.compare(
      Buffer.from(`${left.path}${left.type === "tree" ? "/" : ""}`, "utf8"),
      Buffer.from(`${right.path}${right.type === "tree" ? "/" : ""}`, "utf8"),
    ),
  );
  const content = Buffer.concat(
    ordered.flatMap((entry) => [
      Buffer.from(`${entry.mode === "040000" ? "40000" : entry.mode} ${entry.path}\0`, "utf8"),
      Buffer.from(entry.objectId, "hex"),
    ]),
  );
  return createHash("sha1")
    .update(Buffer.from(`tree ${content.byteLength}\0`, "utf8"))
    .update(content)
    .digest("hex");
}

async function resolveSurface(
  rootTreeId: string,
  surface: RepositorySurfaceDefinition,
  loadTree: (treeId: string) => Promise<RepositorySurfaceTreeEntry[] | null>,
): Promise<RepositorySurfaceProbeEntry | null> {
  const segments = surface.path.split("/");
  let treeId = rootTreeId;
  for (const [index, segment] of segments.entries()) {
    const entries = await loadTree(treeId);
    if (!entries) return null;
    const match = entries.find((entry) => entry.path === segment);
    if (!match) return { surfaceId: surface.id, path: surface.path, kind: "missing" };
    if (index < segments.length - 1) {
      if (match.type !== "tree" || match.mode !== "040000") {
        return {
          surfaceId: surface.id,
          path: surface.path,
          kind: "found",
          mode: match.mode,
          objectType: match.type,
          objectId: match.objectId,
          bytes: null,
          treeEntries: null,
        };
      }
      treeId = match.objectId;
      continue;
    }
    return {
      surfaceId: surface.id,
      path: surface.path,
      kind: "found",
      mode: match.mode,
      objectType: match.type,
      objectId: match.objectId,
      bytes: null,
      treeEntries: null,
    };
  }
  return null;
}

function parseCommit(value: unknown): { commitId: string; treeId: string } | null {
  if (!isObject(value) || typeof value.sha !== "string" || !isSha1(value.sha)) return null;
  const commit = value.commit;
  if (!isObject(commit) || !isObject(commit.tree) || typeof commit.tree.sha !== "string" || !isSha1(commit.tree.sha)) {
    return null;
  }
  return { commitId: value.sha, treeId: commit.tree.sha };
}

function parseTree(value: unknown, expectedTreeId: string): RepositorySurfaceTreeEntry[] | null {
  if (
    !isObject(value) ||
    value.sha !== expectedTreeId ||
    value.truncated !== false ||
    !Array.isArray(value.tree) ||
    value.tree.length > MAX_TREE_ENTRIES
  ) {
    return null;
  }
  const entries: RepositorySurfaceTreeEntry[] = [];
  const paths = new Set<string>();
  for (const raw of value.tree) {
    if (
      !isObject(raw) ||
      typeof raw.path !== "string" ||
      !/^[^/\u0000]{1,255}$/.test(raw.path) ||
      paths.has(raw.path) ||
      typeof raw.mode !== "string" ||
      !["100644", "100755", "120000", "040000", "160000"].includes(raw.mode) ||
      (raw.type !== "blob" && raw.type !== "tree" && raw.type !== "commit") ||
      typeof raw.sha !== "string" ||
      !isSha1(raw.sha) ||
      !(raw.size === undefined || (Number.isSafeInteger(raw.size) && Number(raw.size) >= 0))
    ) {
      return null;
    }
    paths.add(raw.path);
    entries.push({
      path: raw.path,
      mode: raw.mode,
      type: raw.type,
      objectId: raw.sha,
      size: raw.size === undefined ? null : Number(raw.size),
    });
  }
  const sorted = entries.sort((left, right) => left.path.localeCompare(right.path));
  return repositoryGitTreeObjectId(sorted) === expectedTreeId ? sorted : null;
}

function parseBlob(value: unknown, expectedObjectId: string): Uint8Array | null {
  if (
    !isObject(value) ||
    value.sha !== expectedObjectId ||
    value.encoding !== "base64" ||
    typeof value.content !== "string" ||
    !Number.isSafeInteger(value.size) ||
    Number(value.size) < 0 ||
    Number(value.size) > MAX_SURFACE_BYTES
  ) {
    return null;
  }
  const encoded = value.content.replace(/[\r\n]/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength !== Number(value.size)) return null;
  return repositoryGitBlobObjectId(bytes) === expectedObjectId ? bytes : null;
}

function assertTarget(target: RepositorySurfaceInspectionTarget): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(target.owner)) throw new Error("invalid repository owner");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(target.name)) throw new Error("invalid repository name");
  if (!target.defaultBranch || target.defaultBranch.length > 255) throw new Error("invalid default branch");
  if (target.contract.contract.version !== 1 || target.contract.surfaces.length !== 4) {
    throw new Error("unsupported repository surface contract");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSha1(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}
