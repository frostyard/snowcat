import type { AllowedAction } from "./types.ts";

/**
 * The closed registry of standing authorizations (ADR-0074): each entry
 * names the Accepted ADR that pre-authorizes one mechanical admission path
 * and the exact action set it may cover. A `policy:`-attributed creator can
 * mint admitted work only for a kind listed here, and only within the
 * entry's actions; everything else proposes and a human admits. Shaped like
 * the verification-mechanism registry: adding an entry is an ADR plus a row,
 * never a code path that quietly self-authorizes.
 */
export interface StandingAuthorization {
  id: string;
  adr: string;
  actions: readonly AllowedAction[];
}

export const STANDING_AUTHORIZATIONS: Readonly<Record<string, StandingAuthorization>> = {
  // ADR-0061: one admitted mechanical cure per decayed head.
  "pr-cure": { id: "pr-cure:v1", adr: "ADR-0061", actions: ["read", "write", "run-tests", "open-pr", "create-followup"] },
  // ADR-0065: one bounded read-only review round per draft head.
  "pr-review": { id: "pr-review:v1", adr: "ADR-0065", actions: ["read", "run-tests"] },
  // ADR-0065 with ADR-0067/ADR-0071: one bounded fix for a round's tree blockers.
  "pr-review-fix": { id: "pr-review-fix:v1", adr: "ADR-0065", actions: ["read", "write", "run-tests", "open-pr"] },
};

/** The standing authorization for one mechanically admitted kind, or undefined when no ADR pre-authorizes it. */
export function standingAuthorizationFor(kind: string): StandingAuthorization | undefined {
  return STANDING_AUTHORIZATIONS[kind];
}
