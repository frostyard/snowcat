export const workStatuses = ["proposed", "queued", "claimed", "completed", "blocked", "cancelled"] as const;
export type WorkStatus = (typeof workStatuses)[number];

export const allowedActions = [
  "read",
  "write",
  "run-tests",
  "open-issue",
  "open-pr",
  "create-followup",
] as const;
export type AllowedAction = (typeof allowedActions)[number];

export interface WorkArtifact {
  kind: "issue" | "pull-request" | "commit" | "report" | "other";
  url: string;
  description?: string;
}

export interface WorkResult {
  summary: string;
  evidence: string[];
  artifacts: WorkArtifact[];
}

/**
 * A worker-proposed child. It carries no priority: scheduling priority is
 * operator-owned and children inherit their parent's value.
 */
export interface FollowUpInput {
  kind: string;
  objective: string;
  instructions: string;
  acceptanceCriteria: string[];
  allowedActions: AllowedAction[];
  delegableActions: AllowedAction[];
}

export interface WorkItem {
  id: string;
  rootId: string;
  parentId?: string;
  repository: string;
  kind: string;
  objective: string;
  instructions: string;
  acceptanceCriteria: string[];
  allowedActions: AllowedAction[];
  delegableActions: AllowedAction[];
  priority: number;
  status: WorkStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: string;
  result?: WorkResult;
}

export type ObservableWorkItem = Omit<WorkItem, "leaseToken">;

export function withoutLeaseToken(item: WorkItem): ObservableWorkItem {
  const { leaseToken: _leaseToken, ...observable } = item;
  return observable;
}

export interface SeedWorkInput {
  repository: string;
  kind: string;
  objective: string;
  instructions: string;
  acceptanceCriteria: string[];
  allowedActions: AllowedAction[];
  delegableActions: AllowedAction[];
  priority?: number;
  createdBy: string;
}

export interface ClaimInput {
  worker: string;
  repository?: string;
  kinds?: string[];
  leaseSeconds?: number;
}

export interface CompletionInput {
  id: string;
  leaseToken: string;
  worker: string;
  result: WorkResult;
  followUps: FollowUpInput[];
}

export interface WorkEvent {
  sequence: number;
  workItemId: string;
  type: string;
  actor: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}
