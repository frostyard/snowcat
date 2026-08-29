import {
  allowedActions,
  CURE_CHANGE_KIND,
  type AllowedAction,
  type FollowUpInput,
  type FollowUpProposalInput,
  type FollowUpIntent,
  followUpIntents,
  type WorkItem,
} from "./types.ts";

type FollowUpParent = {
  delegableActions: readonly AllowedAction[];
  cure?: WorkItem["cure"];
};

/** Normalize request-level shorthand into the explicit durable child contract. */
export function normalizeFollowUpIntent(parent: FollowUpParent, proposal: FollowUpProposalInput): FollowUpInput {
  if (proposal.intent === undefined) return normalizeLegacyFollowUp(proposal);

  const intent = requireIntent(proposal.intent);
  const derived = derivedContract(parent, intent);
  const kind = derived.kind ?? requireKind(proposal);
  if (proposal.kind !== undefined && proposal.kind !== kind) {
    throw new Error(`follow-up intent ${intent} derives kind ${kind}, not ${proposal.kind}`);
  }
  assertOptionalActions("allowedActions", proposal.allowedActions, derived.allowedActions);
  assertOptionalActions("delegableActions", proposal.delegableActions, derived.delegableActions);
  assertOptionalScalar("requiredArtifact", proposal.requiredArtifact, derived.requiredArtifact);
  assertOptionalScalar("executionTarget", proposal.executionTarget, derived.executionTarget);
  return {
    kind,
    objective: proposal.objective,
    instructions: proposal.instructions,
    acceptanceCriteria: proposal.acceptanceCriteria,
    allowedActions: derived.allowedActions,
    delegableActions: derived.delegableActions,
    requiredArtifact: derived.requiredArtifact,
    executionTarget: derived.executionTarget,
  };
}

function normalizeLegacyFollowUp(proposal: FollowUpProposalInput): FollowUpInput {
  const missing = (
    ["kind", "allowedActions", "delegableActions", "requiredArtifact", "executionTarget"] as const
  ).filter((field) => proposal[field] === undefined);
  if (missing.length > 0) {
    throw new Error(`legacy follow-up without intent must declare ${missing.join(", ")}`);
  }
  return {
    kind: proposal.kind!,
    objective: proposal.objective,
    instructions: proposal.instructions,
    acceptanceCriteria: proposal.acceptanceCriteria,
    allowedActions: proposal.allowedActions!,
    delegableActions: proposal.delegableActions!,
    requiredArtifact: proposal.requiredArtifact!,
    executionTarget: proposal.executionTarget!,
  };
}

function derivedContract(parent: FollowUpParent, intent: FollowUpIntent): {
  kind?: string;
  allowedActions: AllowedAction[];
  delegableActions: AllowedAction[];
  requiredArtifact: "none" | "pull-request";
  executionTarget: "read-only" | "new-pull-request" | "existing-pull-request";
} {
  const placement: Record<
    FollowUpIntent,
    { change: boolean; kind?: string; requiredArtifact: "none" | "pull-request"; executionTarget: "read-only" | "new-pull-request" | "existing-pull-request" }
  > = {
    "read-only": { change: false, requiredArtifact: "none", executionTarget: "read-only" },
    "new-pr-change": { change: true, requiredArtifact: "pull-request", executionTarget: "new-pull-request" },
    "existing-pr-change": {
      change: true,
      kind: CURE_CHANGE_KIND,
      requiredArtifact: "pull-request",
      executionTarget: "existing-pull-request",
    },
  };
  const selected = placement[intent];
  const change = selected.change;
  const required: AllowedAction[] = change ? ["read", "write", "open-pr"] : ["read"];
  const unavailable = required.filter((action) => !parent.delegableActions.includes(action));
  if (unavailable.length > 0) {
    throw new Error(`follow-up intent ${intent} exceeds the parent delegation ceiling: missing ${unavailable.join(", ")}`);
  }
  if (intent === "existing-pr-change" && parent.cure === undefined) {
    throw new Error("follow-up intent existing-pr-change requires a parent cure binding");
  }
  const direct = new Set<AllowedAction>(required);
  for (const optional of ["run-tests", "open-issue", "create-followup"] as const) {
    if (change && optional === "open-issue") continue;
    if (parent.delegableActions.includes(optional)) direct.add(optional);
  }
  const normalizedAllowed = allowedActions.filter((action) => direct.has(action));
  const normalizedDelegable = direct.has("create-followup")
    ? allowedActions.filter((action) => parent.delegableActions.includes(action))
    : [];
  return {
    ...(selected.kind === undefined ? {} : { kind: selected.kind }),
    allowedActions: normalizedAllowed,
    delegableActions: normalizedDelegable,
    requiredArtifact: selected.requiredArtifact,
    executionTarget: selected.executionTarget,
  };
}

function requireIntent(intent: FollowUpIntent): FollowUpIntent {
  if (!(followUpIntents as readonly string[]).includes(intent)) {
    throw new Error(`follow-up intent must be one of ${followUpIntents.join(", ")}`);
  }
  return intent;
}

function requireKind(proposal: FollowUpProposalInput): string {
  if (proposal.kind === undefined) throw new Error(`follow-up intent ${proposal.intent} requires kind`);
  return proposal.kind;
}

function assertOptionalActions(
  field: "allowedActions" | "delegableActions",
  supplied: AllowedAction[] | undefined,
  derived: AllowedAction[],
): void {
  if (supplied === undefined) return;
  const normalized = allowedActions.filter((action) => supplied.includes(action));
  if (normalized.length !== supplied.length || normalized.length !== derived.length || normalized.some((action, index) => action !== derived[index])) {
    throw new Error(`follow-up intent contract mismatch: ${field} must be ${JSON.stringify(derived)}`);
  }
}

function assertOptionalScalar(field: string, supplied: string | undefined, derived: string): void {
  if (supplied !== undefined && supplied !== derived) {
    throw new Error(`follow-up intent contract mismatch: ${field} must be ${derived}`);
  }
}
