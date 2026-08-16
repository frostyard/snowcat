import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { QueueStore } from "../src/queue/store.ts";

test("a manually started MCP client can claim, complete, and create child work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-mcp-test-"));
  const path = join(directory, "queue.db");
  const setup = new QueueStore(path);
  setup.setRepositoryEnabled("frostyard/updex", true);
  const seed = setup.enqueueSeed({
    repository: "frostyard/updex",
    kind: "testing-gap-discovery",
    objective: "Identify one meaningful testing gap and propose a test that covers it.",
    instructions: "Read only, report evidence, and create one bounded follow-up.",
    acceptanceCriteria: ["Exactly one testing gap is identified with file-level evidence."],
    allowedActions: ["read", "create-followup"],
    delegableActions: ["read", "write", "run-tests", "open-pr"],
    createdBy: "operator:test",
  });
  setup.close();

  const client = new Client({ name: "fluent-test-worker", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/stdio.ts"],
    cwd: process.cwd(),
    env: stringEnvironment({ ...process.env, FLUENT_QUEUE_DB: path }),
  });
  await client.connect(transport);
  test.after(async () => client.close());

  const listed = parseToolText(await client.callTool({ name: "list_work", arguments: { status: "queued" } }));
  assert.equal(listed[0].id, seed.id);
  assert.equal(listed[0].leaseToken, undefined);

  const claimed = parseToolText(
    await client.callTool({
      name: "claim_work",
      arguments: { worker: "codex:updex:test", repository: "frostyard/updex", leaseSeconds: 60 },
    }),
  );
  assert.equal(claimed.id, seed.id);
  assert.match(claimed.leaseToken, /^[0-9a-f-]{36}$/);

  const heartbeat = parseToolText(
    await client.callTool({
      name: "heartbeat_work",
      arguments: {
        id: seed.id,
        leaseToken: claimed.leaseToken,
        worker: "codex:updex:test",
        leaseSeconds: 60,
      },
    }),
  );
  assert.equal(heartbeat.id, seed.id);
  assert.equal(heartbeat.leaseToken, undefined);

  const completed = parseToolText(
    await client.callTool({
      name: "complete_work",
      arguments: {
        id: seed.id,
        leaseToken: claimed.leaseToken,
        worker: "codex:updex:test",
        result: {
          summary: "The timeout retry branch lacks a test.",
          evidence: ["pkg/retry/retry.go:42 and pkg/retry/retry_test.go"],
          artifacts: [],
        },
        followUps: [
          {
            kind: "test-implementation",
            objective: "Test retry exhaustion after repeated timeouts.",
            instructions: "Implement the smallest deterministic regression test and run checks.",
            acceptanceCriteria: ["The new regression test passes in the full project check."],
            allowedActions: ["read", "write", "run-tests", "open-pr"],
            delegableActions: [],
          },
        ],
      },
    }),
  );
  assert.equal(completed.completed.status, "completed");
  assert.equal(completed.followUps[0].parentId, seed.id);

  await client.close();
  const verify = new QueueStore(path);
  test.after(() => verify.close());
  assert.equal(verify.list({ status: "proposed" }).length, 1);
  assert.equal(verify.list({ status: "queued" }).length, 0);
  assert.equal(verify.list({ status: "completed" }).length, 1);
});

test("the MCP boundary rejects a follow-up that supplies priority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-mcp-priority-test-"));
  const path = join(directory, "queue.db");
  const setup = new QueueStore(path);
  setup.setRepositoryEnabled("frostyard/updex", true);
  const seed = setup.enqueueSeed({
    repository: "frostyard/updex",
    kind: "testing-gap-discovery",
    objective: "Identify one meaningful testing gap and propose a test that covers it.",
    instructions: "Read only, report evidence, and create one bounded follow-up.",
    acceptanceCriteria: ["Exactly one testing gap is identified with file-level evidence."],
    allowedActions: ["read", "create-followup"],
    delegableActions: ["read", "write", "run-tests"],
    priority: 5,
    createdBy: "operator:test",
  });
  setup.close();

  const client = new Client({ name: "fluent-test-worker", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/stdio.ts"],
    cwd: process.cwd(),
    env: stringEnvironment({ ...process.env, FLUENT_QUEUE_DB: path }),
  });
  await client.connect(transport);
  test.after(async () => client.close());

  const claimed = parseToolText(
    await client.callTool({
      name: "claim_work",
      arguments: { worker: "codex:updex:priority", repository: "frostyard/updex", leaseSeconds: 60 },
    }),
  );
  assert.equal(claimed.id, seed.id);

  const followUp = {
    kind: "test-implementation",
    objective: "Test retry exhaustion after repeated timeouts.",
    instructions: "Implement the smallest deterministic regression test and run checks.",
    acceptanceCriteria: ["The new regression test passes in the full project check."],
    allowedActions: ["read", "write", "run-tests"],
    delegableActions: [],
  };
  const completion = {
    id: seed.id,
    leaseToken: claimed.leaseToken,
    worker: "codex:updex:priority",
    result: { summary: "Found a gap.", evidence: ["pkg/retry/retry.go:42"], artifacts: [] },
  };

  const rejected = await callToolExpectingError(client, "complete_work", {
    ...completion,
    followUps: [{ ...followUp, priority: 999 }],
  });
  assert.match(rejected, /priority|[Uu]nrecognized/);

  const verifyRejected = new QueueStore(path);
  assert.equal(verifyRejected.get(seed.id)?.status, "claimed");
  assert.equal(verifyRejected.list({ status: "proposed" }).length, 0);
  verifyRejected.close();

  const completed = parseToolText(
    await client.callTool({ name: "complete_work", arguments: { ...completion, followUps: [followUp] } }),
  );
  assert.equal(completed.completed.status, "completed");
  assert.equal(completed.followUps[0].priority, 5);
  await client.close();
});

test("the MCP boundary rejects worker identities in reserved principal namespaces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-mcp-principal-test-"));
  const path = join(directory, "queue.db");
  const setup = new QueueStore(path);
  setup.setRepositoryEnabled("frostyard/updex", true);
  const seed = setup.enqueueSeed({
    repository: "frostyard/updex",
    kind: "testing-gap-discovery",
    objective: "Identify one meaningful testing gap.",
    instructions: "Read only.",
    acceptanceCriteria: ["One gap is identified."],
    allowedActions: ["read"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  setup.close();

  const client = new Client({ name: "fluent-test-worker", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/stdio.ts"],
    cwd: process.cwd(),
    env: stringEnvironment({ ...process.env, FLUENT_QUEUE_DB: path }),
  });
  await client.connect(transport);
  test.after(async () => client.close());

  const rejected = await callToolExpectingError(client, "claim_work", {
    worker: "operator:dogfood",
    repository: "frostyard/updex",
  });
  // The schema, not the store, must reject it: schema failures carry the
  // SDK's input-validation prefix and name the offending field.
  assert.match(rejected, /Input validation error.*worker.*reserved principal namespace/s);
  const listed = parseToolText(await client.callTool({ name: "list_work", arguments: { status: "queued" } }));
  assert.equal(listed[0].id, seed.id);
  assert.equal(listed[0].leaseOwner, undefined);

  const claimed = parseToolText(
    await client.callTool({ name: "claim_work", arguments: { worker: "codex:updex:one", repository: "frostyard/updex" } }),
  );
  assert.equal(claimed.id, seed.id);
  const heartbeat = await callToolExpectingError(client, "heartbeat_work", {
    id: seed.id,
    leaseToken: claimed.leaseToken,
    worker: "system",
  });
  assert.match(heartbeat, /Input validation error.*worker.*reserved principal namespace/s);
  await client.close();
});

test("the MCP release path omits the old token and permits reclaim by another worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-mcp-release-test-"));
  const path = join(directory, "queue.db");
  const setup = new QueueStore(path);
  setup.setRepositoryEnabled("frostyard/updex", true);
  const seed = setup.enqueueSeed({
    repository: "frostyard/updex",
    kind: "testing-gap-discovery",
    objective: "Identify one meaningful testing gap.",
    instructions: "Read only.",
    acceptanceCriteria: ["One gap is identified."],
    allowedActions: ["read"],
    delegableActions: [],
    createdBy: "operator:test",
  });
  setup.close();

  const client = new Client({ name: "fluent-release-test-worker", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/stdio.ts"],
    cwd: process.cwd(),
    env: stringEnvironment({ ...process.env, FLUENT_QUEUE_DB: path }),
  });
  await client.connect(transport);
  test.after(async () => client.close());

  const first = parseToolText(
    await client.callTool({
      name: "claim_work",
      arguments: { worker: "codex:updex:mismatch", repository: "frostyard/updex", leaseSeconds: 60 },
    }),
  );
  assert.equal(first.id, seed.id);
  const released = parseToolText(
    await client.callTool({
      name: "release_work",
      arguments: {
        id: seed.id,
        leaseToken: first.leaseToken,
        worker: "codex:updex:mismatch",
        reason: "Wrong specialty.",
      },
    }),
  );
  assert.equal(released.id, seed.id);
  assert.equal(released.status, "queued");
  assert.equal(released.leaseToken, undefined);

  const second = parseToolText(
    await client.callTool({
      name: "claim_work",
      arguments: { worker: "claude:updex:correct", repository: "frostyard/updex", leaseSeconds: 60 },
    }),
  );
  assert.equal(second.id, seed.id);
  assert.equal(second.leaseOwner, "claude:updex:correct");
  assert.notEqual(second.leaseToken, first.leaseToken);
  await client.close();
});

async function callToolExpectingError(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  let result: { isError?: boolean; content: unknown[] };
  try {
    result = (await client.callTool({ name, arguments: args })) as typeof result;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  assert.equal(result.isError, true, "tool call should have failed");
  const first = result.content[0] as { text?: string } | undefined;
  return first?.text ?? "";
}

function parseToolText(result: { content: unknown[] }): any {
  const first = result.content[0] as { type?: string; text?: string } | undefined;
  assert.equal(first?.type, "text");
  assert.equal(typeof first.text, "string");
  return JSON.parse(first.text!);
}

function stringEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
