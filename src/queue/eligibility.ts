import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { ControlPlaneStore } from "../control/store.ts";
import type { ClaimEligibility, QueueStoreOptions } from "./store.ts";

/**
 * Claim eligibility backed by the control-plane store: a repository's work is
 * claimable only while its effective state is `enrolled`, which already
 * excludes disabled and paused declarations, unresolved GitHub identity or
 * surfaces, and operator holds. The store is opened read-only per decision so
 * a long-lived MCP server always sees the current facts. A missing or
 * unreadable database fails the claim closed rather than opening or creating
 * anything.
 */
export function controlPlaneClaimEligibility(controlPlanePath: string): ClaimEligibility {
  const path = resolve(controlPlanePath);
  return (repository) => {
    if (!existsSync(path)) {
      throw new Error(`control-plane database does not exist: ${path}; unset FLUENT_CONTROL_DB to claim on queue opt-in alone`);
    }
    const store = new ControlPlaneStore(path);
    try {
      const slug = repository.toLowerCase();
      return store
        .repositoryStatuses()
        .some((status) => `${status.owner}/${status.name}`.toLowerCase() === slug && status.effectiveState === "enrolled");
    } finally {
      store.close();
    }
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
