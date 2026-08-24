import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { RepositoryMaintenanceProgram } from "../control/registry.ts";
import { ControlPlaneStore } from "../control/store.ts";
import { controlPlanePolicyAuthority } from "./policy-authority.ts";
import type { ClaimEligibility, QueueStoreOptions } from "./store.ts";

export interface EnrolledRepositoryPrograms {
  /** `owner/name` as Core declares it. */
  slug: string;
  /** The declaration's `maintenance_programs`, in declared order. */
  maintenancePrograms: RepositoryMaintenanceProgram[];
}

/**
 * The repositories whose effective control-plane state is `enrolled` — which
 * already excludes disabled and paused declarations, unresolved GitHub
 * identity or surfaces, and operator holds — with the maintenance programs
 * each declaration lists. The store is opened fresh per call so a long-lived
 * process always sees the current facts. A missing or unreadable database
 * throws rather than opening or creating anything.
 */
export function enrolledRepositoryPrograms(controlPlanePath: string): EnrolledRepositoryPrograms[] {
  const path = resolve(controlPlanePath);
  if (!existsSync(path)) {
    throw new Error(`control-plane database does not exist: ${path} (SNOWCAT_CONTROL_DB); unset it to run on queue opt-in alone`);
  }
  const store = new ControlPlaneStore(path);
  try {
    return store
      .repositoryStatuses()
      .filter((status) => status.effectiveState === "enrolled")
      .map((status) => ({ slug: `${status.owner}/${status.name}`, maintenancePrograms: [...status.maintenancePrograms] }));
  } finally {
    store.close();
  }
}

/** The `owner/name` slugs of `enrolledRepositoryPrograms`. */
export function enrolledRepositories(controlPlanePath: string): string[] {
  return enrolledRepositoryPrograms(controlPlanePath).map((entry) => entry.slug);
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
 * `SNOWCAT_CONTROL_DB` is explicitly configured; otherwise opt-in alone
 * governs claims.
 */
export function queueStoreOptionsFromEnvironment(env: NodeJS.ProcessEnv = process.env): QueueStoreOptions {
  const configured = env.SNOWCAT_CONTROL_DB;
  if (!configured || configured === ":memory:") return {};
  // ADR-0074: the same configuration that gates claims also binds every
  // definition and admission to the repository's current policy authority.
  return { claimEligibility: controlPlaneClaimEligibility(configured), policyAuthority: controlPlanePolicyAuthority(configured) };
}
