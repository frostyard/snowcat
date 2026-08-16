import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { QueueStore, queueDatabasePath, validateWorkerIdentity } from "../queue/store.ts";
import { allowedActions, withoutLeaseToken, workStatuses } from "../queue/types.ts";

const actionSchema = z.enum(allowedActions);
// Worker identities may not borrow Fluent's reserved principal namespaces
// (operator:, policy:, system:), so provenance cannot be spoofed at the boundary.
const workerSchema = z.string().min(1).refine(
  (worker) => {
    try {
      validateWorkerIdentity(worker);
      return true;
    } catch {
      return false;
    }
  },
  { message: "worker identity uses a reserved principal namespace (operator:, policy:, system:)" },
);
const artifactSchema = z.object({
  kind: z.enum(["issue", "pull-request", "commit", "report", "other"]),
  url: z.url().startsWith("https://"),
  description: z.string().min(1).optional(),
});
// Strict: unknown fields such as `priority` are rejected rather than stripped,
// because scheduling priority is operator-owned and children inherit it.
const followUpSchema = z.strictObject({
  kind: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  objective: z.string().min(1),
  instructions: z.string().min(1),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  allowedActions: z.array(actionSchema),
  delegableActions: z.array(actionSchema),
});

export function buildQueueMcpServer(path = queueDatabasePath()): McpServer {
  const queue = new QueueStore(path);
  const server = new McpServer(
    { name: "fluent-queue", version: "0.1.0" },
    {
      instructions: [
        "Claim at most one work item unless the operator explicitly requests a loop.",
        "Perform only the allowedActions listed on the claimed item.",
        "Never broaden child permissions beyond delegableActions.",
        "Complete work with concrete evidence and bounded follow-up items.",
      ].join(" "),
    },
  );

  server.registerTool(
    "list_work",
    {
      description: "List queue bookkeeping without exposing lease tokens. Use claim_work before doing an item.",
      inputSchema: z.object({
        status: z.enum(workStatuses).optional(),
        repository: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
    },
    async ({ status, repository, limit }) =>
      toolResult(queue.list({ status, repository, limit }).map(withoutLeaseToken)),
  );

  server.registerTool(
    "get_work",
    {
      description: "Read one work item's bookkeeping and lineage metadata without exposing its lease token.",
      inputSchema: z.object({ id: z.string().uuid() }),
    },
    async ({ id }) => {
      const item = queue.get(id);
      return toolResult(item ? withoutLeaseToken(item) : null);
    },
  );

  server.registerTool(
    "claim_work",
    {
      description:
        "Lease one eligible item. The returned leaseToken is required for progress and completion; do not expose it.",
      inputSchema: z.object({
        worker: workerSchema,
        repository: z.string().optional(),
        kinds: z.array(z.string()).optional(),
        leaseSeconds: z.number().int().min(30).max(3600).optional(),
      }),
    },
    async (input) => toolResult(queue.claim(input) ?? null),
  );

  server.registerTool(
    "heartbeat_work",
    {
      description: "Renew an active lease before or after a long work step.",
      inputSchema: z.object({
        id: z.string().uuid(),
        leaseToken: z.string().uuid(),
        worker: workerSchema,
        leaseSeconds: z.number().int().min(30).max(3600).optional(),
      }),
    },
    async ({ id, leaseToken, worker, leaseSeconds }) =>
      toolResult(withoutLeaseToken(queue.heartbeat(id, leaseToken, worker, leaseSeconds))),
  );

  server.registerTool(
    "complete_work",
    {
      description:
        "Complete leased work with evidence and zero or more bounded child items. Child permissions cannot exceed the parent's delegation ceiling.",
      inputSchema: z.object({
        id: z.string().uuid(),
        leaseToken: z.string().uuid(),
        worker: workerSchema,
        result: z.object({
          summary: z.string().min(1),
          evidence: z.array(z.string().min(1)),
          artifacts: z.array(artifactSchema),
        }),
        followUps: z.array(followUpSchema).max(10),
      }),
    },
    async (input) => toolResult(queue.complete(input)),
  );

  server.registerTool(
    "block_work",
    {
      description: "Mark leased work blocked when operator input or an external state change is required.",
      inputSchema: z.object({
        id: z.string().uuid(),
        leaseToken: z.string().uuid(),
        worker: workerSchema,
        reason: z.string().min(1),
      }),
    },
    async ({ id, leaseToken, worker, reason }) => toolResult(queue.block(id, leaseToken, worker, reason)),
  );

  server.registerTool(
    "release_work",
    {
      description: "Release a mismatched or unstarted item back to the queue without completing it.",
      inputSchema: z.object({
        id: z.string().uuid(),
        leaseToken: z.string().uuid(),
        worker: workerSchema,
        reason: z.string().min(1),
      }),
    },
    async ({ id, leaseToken, worker, reason }) => toolResult(queue.release(id, leaseToken, worker, reason)),
  );

  return server;
}

function toolResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
} {
  const structuredContent = { value };
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent,
  };
}
