import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { ControlPlaneStore } from "../control/store.ts";
import type { PolicyAuthority, PolicyAuthorityHook } from "./store.ts";
import { allowedActions as ALLOWED_ACTIONS, type AllowedAction, type PolicyBoundary, type PolicyDecision } from "./types.ts";

/**
 * The control-plane-backed policy authority hook (ADR-0074): each decision
 * reads the store fresh — exactly like claim eligibility — and answers with
 * the enrolled repository's Core action ceiling, its governance policy's
 * action decisions and protected boundaries, and the revisions that identify
 * them. `undefined` (the fail-closed answer) when the repository is not
 * enrolled or its recorded policy cannot be read as core's
 * repository-agent-governance schema v1.
 */
export function controlPlanePolicyAuthority(controlPlanePath: string): PolicyAuthorityHook {
  return (repository) => {
    const path = resolve(controlPlanePath);
    if (!existsSync(path)) return undefined;
    const store = new ControlPlaneStore(path);
    try {
      const slug = repository.toLowerCase();
      const status = store
        .repositoryStatuses()
        .find((candidate) => `${candidate.owner}/${candidate.name}`.toLowerCase() === slug && candidate.effectiveState === "enrolled");
      if (!status) return undefined;
      const policy = parseGovernancePolicy(status.governancePolicy);
      if (!policy) return undefined;
      return {
        coreSnapshotId: status.coreSnapshotId,
        repositoryCommitId: status.repositoryCommitId,
        actionCeiling: status.actionCeiling.filter(isAllowedAction),
        ...policy,
      };
    } finally {
      store.close();
    }
  };
}

function isAllowedAction(value: unknown): value is AllowedAction {
  return typeof value === "string" && (ALLOWED_ACTIONS as readonly string[]).includes(value);
}

function isDecision(value: unknown): value is PolicyDecision {
  return value === "allow" || value === "review-required" || value === "deny";
}

/**
 * Narrow read of core's repository-agent-governance schema v1 — the same
 * bytes enrollment already validated, re-read defensively so a malformed
 * record answers `undefined` (fail closed) rather than a permissive default.
 */
function parseGovernancePolicy(
  value: unknown,
): Pick<PolicyAuthority, "defaultDecision" | "actionDecisions" | "protectedBoundaries"> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const policy = value as Record<string, unknown>;
  if (!isDecision(policy.default_decision)) return undefined;
  const actionDecisions: Partial<Record<AllowedAction, PolicyDecision>> = {};
  if (typeof policy.actions !== "object" || policy.actions === null) return undefined;
  for (const [action, decision] of Object.entries(policy.actions as Record<string, unknown>)) {
    if (!isAllowedAction(action) || !isDecision(decision)) return undefined;
    actionDecisions[action] = decision;
  }
  const protectedBoundaries: PolicyBoundary[] = [];
  for (const entry of Array.isArray(policy.protected_boundaries) ? policy.protected_boundaries : []) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const boundary = entry as Record<string, unknown>;
    if (typeof boundary.id !== "string" || !isDecision(boundary.decision)) return undefined;
    if (!Array.isArray(boundary.paths) || boundary.paths.some((path) => typeof path !== "string")) return undefined;
    protectedBoundaries.push({
      id: boundary.id,
      decision: boundary.decision,
      minimumRiskTier: typeof boundary.minimum_risk_tier === "string" ? boundary.minimum_risk_tier : "unstated",
      paths: [...(boundary.paths as string[])],
    });
  }
  return { defaultDecision: policy.default_decision, actionDecisions, protectedBoundaries };
}
