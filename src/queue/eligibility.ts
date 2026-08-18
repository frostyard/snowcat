import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { ControlPlaneStore } from "../control/store.ts";
import type { ClaimEligibility, QueueStoreOptions } from "./store.ts";

/**
 * The `owner/name` slugs whose effective control-plane state is `enrolled`,
 * which already excludes disabled and paused declarations, unresolved GitHub
 * identity or surfaces, and operator holds. The store is opened fresh per call
 * so a long-lived process always sees the current facts. A missing or
 * unreadable database throws rather than opening or creating anything.
 */
export function enrolledRepositories(controlPlanePath: string): string[] {
  const path = resolve(controlPlanePath);
  if (!existsSync(path)) {
    throw new Error(`control-plane database does not exist: ${path} (FLUENT_CONTROL_DB); unset it to run on queue opt-in alone`);
  }
  const store = new ControlPlaneStore(path);
  try {
    return store
      .repositoryStatuses()
      .filter((status) => status.effectiveState === "enrolled")
      .map((status) => `${status.owner}/${status.name}`);
  } finally {
    store.close();
  }
}

/**
 * Claim eligibility backed by the control-plane store: a repository's work is
 * claimable only while its effective state is `enrolled`. Each decision reads
 * the store fresh through `enrolledRepositories`, so a missing database fails
 * the claim closed.
 */
export function controlPlaneClaimEligibility(controlPlanePath: string): ClaimEligibility {
  return (repository) => {
    const slug = repository.toLowerCase();
    return enrolledRepositories(controlPlanePath).some((enrolled) => enrolled.toLowerCase() === slug);
  };
}

/**
 * Queue store options for a host process: the control-plane hook only when
 * `FLUENT_CONTROL_DB` is explicitly configured; otherwise opt-in alone
 * governs claims.
 */
export function queueStoreOptionsFromEnvironment(env: NodeJS.ProcessEnv = process.env): QueueStoreOptions {
  const configured = env.FLUENT_CONTROL_DB;
  if (!configured || configured === ":memory:") return {};
  return { claimEligibility: controlPlaneClaimEligibility(configured) };
}
