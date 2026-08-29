import type { WorkArtifact } from "./types.ts";

/**
 * Stable identity for one pull request inside its current queue repository.
 * The verified GitHub number wins; legacy/unverified rows fall back to the
 * number in a structurally valid GitHub pull-request URL.
 */
export function pullRequestArtifactIdentity(repository: string, artifact: WorkArtifact): string {
  const verifiedNumber =
    artifact.kind === "pull-request" && artifact.verification?.status === "verified"
      ? artifact.verification.number
      : undefined;
  const urlNumber = pullRequestNumber(artifact.url);
  const number = verifiedNumber ?? urlNumber;
  return number === undefined
    ? `pull-request-url:${artifact.url.toLowerCase()}`
    : `pull-request:${repository.toLowerCase()}#${number}`;
}

/** Identity used by the artifact-centric delivery projection. */
export function deliveryArtifactIdentity(repository: string, artifact: WorkArtifact): string | undefined {
  if (artifact.kind === "pull-request") return pullRequestArtifactIdentity(repository, artifact);
  if (artifact.kind === "release") return `release:${artifact.url.toLowerCase()}`;
  return undefined;
}

function pullRequestNumber(value: string): number | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") return undefined;
  const match = /^\/[^/]+\/[^/]+\/pull\/([1-9][0-9]*)\/?$/i.exec(url.pathname);
  return match ? Number(match[1]) : undefined;
}
