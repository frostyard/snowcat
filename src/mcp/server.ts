import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { verifyCompletionArtifacts, type ArtifactVerifierOptions } from "../queue/artifact-verification.ts";
import { assertCureCompletion } from "../queue/pull-request-cure.ts";
import { assertReviewCompletion, assertReviewGate } from "../queue/pull-request-review.ts";
import { QueueStore, queueDatabasePath, validateMcpTools, validateWorkerIdentity, validateWorkKinds, type QueueStoreOptions } from "../queue/store.ts";
import {
  allowedActions,
  MAX_REVIEW_ADVISORIES,
  MAX_REVIEW_BLOCKERS,
  mcpToolNames,
  MODEL_NAME_PATTERN,
  type McpToolName,
  requiredArtifacts,
  reviewDecisions,
  withoutLeaseToken,
  workStatuses,
} from "../queue/types.ts";

const actionSchema = z.enum(allowedActions);
// Worker identities may not borrow Snowcat's reserved principal namespaces
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
// Strict: `verification` is Snowcat's own observation, computed by the server
// at completion time; a worker-supplied value is rejected, not stripped.
const artifactSchema = z.strictObject({
  kind: z.enum(["issue", "pull-request", "release", "commit", "report", "other"]),
  url: z.url().startsWith("https://"),
  description: z.string().min(1).optional(),
});
// A pr-review verdict (ADR-0029, ADR-0065): bounded, fingerprinted, strict.
const fingerprintSchema = z.string().regex(/^[a-z0-9][a-z0-9._:/-]{3,120}$/i);
const reviewBlockerSchema = z.strictObject({
  fingerprint: fingerprintSchema,
  location: z.string().min(1),
  contract: z.string().min(1),
  impact: z.string().min(1),
  resolution: z.string().min(1),
  verification: z.string().min(1),
});
const reviewSchema = z.strictObject({
  decision: z.enum(reviewDecisions),
  blockers: z.array(reviewBlockerSchema).max(MAX_REVIEW_BLOCKERS),
  advisories: z.array(z.strictObject({ fingerprint: fingerprintSchema, text: z.string().min(1) })).max(MAX_REVIEW_ADVISORIES),
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
  // Required, never defaulted (ADR-0069): the proposer states whether the
  // child is a change that lands through a pull request. The store refuses a
  // `write` child without `pull-request`, and `pull-request` without `open-pr`.
  requiredArtifact: z.enum(requiredArtifacts),
});

/**
 * A transport-established identity (ADR-0063): the `member:<owner>/<client>`
 * principal derived from a verified minted token. When present, every tool
 * acts as that principal — the payload's `worker` becomes the claim's label
 * — and can never widen it. Absent (stdio, local mode) the payload's worker
 * is the principal, as before.
 */
export interface McpIdentity {
  /**
   * The transport-established principal. Present for the HTTP endpoint (a
   * verified minted token); absent for stdio, where the payload's worker is
   * the principal as before.
   */
  principal?: string;
  /**
   * The work kinds this credential may claim: a minted token's `kinds`
   * (schema rung 9) or stdio's `SNOWCAT_MCP_KINDS`. Absent is unrestricted.
   * It bounds `claim_work` only — a restricted client still heartbeats,
   * completes, blocks, and releases whatever it already holds.
   */
  kinds?: string[];
  /**
   * The MCP tools this credential may call: a minted token's `tools`
   * (schema rung 14, ADR-0070) or stdio's `SNOWCAT_MCP_TOOLS`. Absent is
   * every tool. The server registers only the granted tools, so an ungranted
   * call is refused by the protocol layer — unknown tool — before any handler
   * can touch the queue; an observation-only client cannot claim, renew,
   * complete, block, or release whatever it sends.
   */
  tools?: string[];
}

/**
 * The stdio equivalent of a token's tool grant (ADR-0070):
 * `SNOWCAT_MCP_TOOLS=list_work,get_work` registers only those tools on the
 * local server. Unset or blank is every tool; a name that is not an MCP tool
 * is refused loudly at startup rather than silently widening.
 */
export function mcpToolsFromEnvironment(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = env.SNOWCAT_MCP_TOOLS?.trim();
  if (!raw) return undefined;
  return validateMcpTools(raw.split(",").map((tool) => tool.trim()).filter((tool) => tool !== ""), "SNOWCAT_MCP_TOOLS");
}

/**
 * The stdio equivalent of a token's kinds: `SNOWCAT_MCP_KINDS=pr-review` (or
 * a comma-separated list) restricts what the local server may claim. Unset or
 * blank is unrestricted; anything that is not a work kind is refused loudly at
 * startup rather than silently widening.
 */
export function mcpKindsFromEnvironment(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const raw = env.SNOWCAT_MCP_KINDS?.trim();
  if (!raw) return undefined;
  return validateWorkKinds(raw.split(",").map((kind) => kind.trim()).filter((kind) => kind !== ""), "SNOWCAT_MCP_KINDS");
}

export function buildQueueMcpServer(
  path = queueDatabasePath(),
  verifier: ArtifactVerifierOptions = {},
  storeOptions: QueueStoreOptions = {},
  identity?: McpIdentity,
  sharedQueue?: QueueStore,
): McpServer {
  const queue = sharedQueue ?? new QueueStore(path, undefined, storeOptions);
  const actor = (declared: string) => identity?.principal ?? declared;
  // The credential's tool grant (ADR-0070), validated again here so a grant
  // that reached the identity by any route still names only real tools. A
  // tool outside the grant is simply never registered for this client.
  const grant = identity?.tools === undefined ? undefined : new Set(validateMcpTools(identity.tools, "MCP identity tools"));
  const granted = (tool: McpToolName): boolean => grant === undefined || grant.has(tool);
  const server = new McpServer(
    { name: "snowcat", version: "0.1.0" },
    {
      instructions: [
        "Claim at most one work item unless the operator explicitly requests a loop.",
        "Perform only the allowedActions listed on the claimed item.",
        "Before changing anything, check whether the work already exists: read operatorNotes when present and look for pull requests that reference the item's sourceRef issue; re-report or block rather than opening a duplicate.",
        "Never broaden child permissions beyond delegableActions.",
        "Every follow-up declares requiredArtifact: \"pull-request\" for a change (it then needs open-pr in allowedActions) or \"none\" for discovery-only work. An item whose requiredArtifact is pull-request completes only with a pull-request artifact; block_work instead when no change is warranted.",
        "Complete work with concrete evidence and bounded follow-up items, and report the model you ran as result.model.",
        "In a review-gated repository open pull requests as drafts; a pr-review item completes with a structured review verdict and touches nothing on GitHub.",
      ].join(" "),
    },
  );

  if (granted("list_work")) server.registerTool(
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

  if (granted("get_work")) server.registerTool(
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

  if (granted("claim_work")) server.registerTool(
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
    async (input) =>
      toolResult(
        queue.claim({
          ...input,
          // A verified token's identity replaces the payload's worker and
          // demotes it to a label (ADR-0063).
          ...(identity?.principal ? { worker: identity.principal, label: input.worker } : {}),
          // The credential's own restriction, intersected by the store with
          // whatever `kinds` the caller asked for.
          ...(identity?.kinds ? { allowedKinds: identity.kinds } : {}),
          // The grant the lease is taken under, for the ledger (ADR-0070).
          ...(identity?.tools ? { allowedTools: identity.tools } : {}),
        }) ?? null,
      ),
  );

  if (granted("heartbeat_work")) server.registerTool(
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
      toolResult(withoutLeaseToken(queue.heartbeat(id, leaseToken, actor(worker), leaseSeconds))),
  );

  if (granted("complete_work")) server.registerTool(
    "complete_work",
    {
      description:
        "Complete leased work with evidence and zero or more bounded child items. Child permissions cannot exceed the parent's delegation ceiling. result.model is the model you ran (provenance). A pr-review item must supply `review` (decision, blockers, advisories); no other kind may.",
      inputSchema: z.object({
        id: z.string().uuid(),
        leaseToken: z.string().uuid(),
        worker: workerSchema,
        result: z.object({
          summary: z.string().min(1),
          evidence: z.array(z.string().min(1)),
          artifacts: z.array(artifactSchema),
          model: z.string().regex(MODEL_NAME_PATTERN).optional(),
        }),
        followUps: z.array(followUpSchema).max(10),
        review: reviewSchema.optional(),
      }),
    },
    async (input) => {
      // Verify reported issues and pull requests against GitHub before the
      // completion transaction. A rejected artifact leaves the item claimed so
      // the worker can correct the report; an unavailable GitHub records
      // `unverified` and the later verify-artifacts pass closes the loop.
      const item = queue.get(input.id);
      const artifacts = item
        ? await verifyCompletionArtifacts(item.repository, input.result.artifacts, verifier)
        : input.result.artifacts;
      // In a review-gated repository an open pull request must be a draft
      // (ADR-0065); a pr-cure completion is refused when the pull request's
      // patch identity changed (ADR-0061): mechanical is a fact Snowcat
      // computes, not a claim; a pr-review verdict must bind to the head the
      // round named.
      if (item) {
        assertReviewGate(queue, item, artifacts);
        await assertCureCompletion(item, artifacts, verifier);
        await assertReviewCompletion(item, artifacts, input.review, verifier);
      }
      return toolResult(queue.complete({ ...input, worker: actor(input.worker), result: { ...input.result, artifacts } }));
    },
  );

  if (granted("block_work")) server.registerTool(
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
    async ({ id, leaseToken, worker, reason }) => toolResult(queue.block(id, leaseToken, actor(worker), reason)),
  );

  if (granted("release_work")) server.registerTool(
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
    async ({ id, leaseToken, worker, reason }) => toolResult(queue.release(id, leaseToken, actor(worker), reason)),
  );

  return server;
}

/** Every tool the server registers for an unrestricted identity, in registration order; tests pin it to `mcpToolNames`. */
export const registeredMcpToolNames: readonly McpToolName[] = mcpToolNames;

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
