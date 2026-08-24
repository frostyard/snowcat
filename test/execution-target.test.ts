import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { buildQueueMcpServer } from "../src/mcp/server.ts";
import { contractProblem, QueueStore, SCHEMA_VERSION } from "../src/queue/store.ts";

const REPOSITORY = "frostyard/updex";
const HEAD = "a".repeat(40);

function definition(overrides: Record<string, unknown> = {}) {
  return {
    repository: REPOSITORY,
    kind: "issue-resolution",
    objective: "Resolve it.",
    instructions: "Do it.",
    acceptanceCriteria: ["Done."],
    delegableActions: [],
    createdBy: "operator:test",
    ...overrides,
  };
}

test("the consistency predicate binds target, actions, artifact, and binding (ADR-0073)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-execution-target-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);

  // A definition without a target is refused: declared, never inferred.
  assert.throws(
    () => queue.enqueueSeed(definition({ allowedActions: ["read"] }) as never),
    /executionTarget must be one of read-only, new-pull-request, existing-pull-request/,
  );
  assert.throws(
    () => queue.enqueueSeed(definition({ allowedActions: ["read"], executionTarget: "branchless" }) as never),
    /executionTarget must be one of/,
  );

  // read-only mutates nothing and delivers no pull request.
  assert.throws(
    () => queue.enqueueSeed(definition({ allowedActions: ["read", "write", "open-pr"], executionTarget: "read-only" }) as never),
    /read-only item mutates nothing/,
  );
  assert.throws(
    () =>
      queue.enqueueSeed(
        definition({ allowedActions: ["read", "run-tests"], requiredArtifact: "pull-request", executionTarget: "read-only" }) as never,
      ),
    // The legacy artifact check still speaks first for this shape (rule 64 order).
    /must deliver a pull request requires open-pr/,
  );
  assert.equal(
    contractProblem({ allowedActions: ["read"], requiredArtifact: "pull-request", executionTarget: "read-only" })?.code,
    "required-pull-request-without-open-pr",
  );
  assert.equal(
    contractProblem({ allowedActions: ["read", "open-issue"], requiredArtifact: "none", executionTarget: "read-only" }),
    undefined,
    "open-issue and create-followup stay available to a reporter",
  );

  // A mutating target needs write, open-pr, and the pull-request contract.
  assert.throws(
    () => queue.enqueueSeed(definition({ allowedActions: ["read", "open-pr"], requiredArtifact: "pull-request", executionTarget: "new-pull-request" }) as never),
    /alters the tree and publishes it/,
  );
  assert.throws(
    () =>
      queue.enqueueSeed(
        definition({ allowedActions: ["read", "write", "open-pr"], requiredArtifact: "none", executionTarget: "new-pull-request" }) as never,
      ),
    /delivers through a pull request: requiredArtifact must be pull-request/,
  );

  // existing-pull-request additionally needs the <url>@<head> binding.
  assert.equal(
    contractProblem({ allowedActions: ["read", "write", "open-pr"], requiredArtifact: "pull-request", executionTarget: "existing-pull-request" })?.code,
    "existing-pull-request-without-binding",
  );
  assert.equal(
    contractProblem({
      allowedActions: ["read", "write", "open-pr"],
      requiredArtifact: "pull-request",
      executionTarget: "existing-pull-request",
      sourceRef: `pr-review-fix:https://github.com/${REPOSITORY}/pull/9@${HEAD}`,
    }),
    undefined,
    "a sourceRef naming <url>@<head SHA> binds",
  );
  assert.equal(
    contractProblem({
      allowedActions: ["read", "write", "open-pr"],
      requiredArtifact: "pull-request",
      executionTarget: "existing-pull-request",
      sourceRef: `pr-cure:https://github.com/${REPOSITORY}/pull/9`,
    })?.code,
    "existing-pull-request-without-binding",
    "a sourceRef without the head SHA does not bind",
  );
  assert.equal(
    contractProblem({
      allowedActions: ["read", "write", "open-pr"],
      requiredArtifact: "pull-request",
      executionTarget: "existing-pull-request",
      review: { pullRequestUrl: `https://github.com/${REPOSITORY}/pull/9`, headSha: HEAD, round: 1, priorBlockers: [] },
    }),
    undefined,
    "a review record binds",
  );

  // A consistent declaration stores and reads back.
  const seeded = queue.enqueueSeed(
    definition({ allowedActions: ["read", "write", "run-tests", "open-pr"], requiredArtifact: "pull-request", executionTarget: "new-pull-request" }) as never,
  );
  assert.equal(seeded.executionTarget, "new-pull-request");
  assert.equal(queue.get(seeded.id)?.executionTarget, "new-pull-request");
});

test("a version-15 database gains the nullable rung-16 column: legacy rows read undeclared, stay claimable, and are audited", async () => {
  assert.equal(SCHEMA_VERSION, 16, "this test pins the ladder at rung 16; extend it when a rung is added");
  const directory = await mkdtemp(join(tmpdir(), "snowcat-execution-target-ladder-test-"));
  const path = join(directory, "queue.db");
  const current = new QueueStore(path);
  current.setRepositoryEnabled(REPOSITORY, true);
  const legacy = current.enqueueSeed(
    definition({ allowedActions: ["read"], executionTarget: "read-only" }) as never,
  );
  current.close();

  // Rewind to version 15: drop the column, exactly as a pre-ADR database looks.
  const raw = new DatabaseSync(path);
  raw.exec("ALTER TABLE work_items DROP COLUMN execution_target; PRAGMA user_version = 15;");
  raw.close();

  const migrated = new QueueStore(path);
  test.after(() => migrated.close());
  assert.equal(migrated.schemaVersion(), SCHEMA_VERSION);
  assert.equal(migrated.get(legacy.id)?.executionTarget, undefined, "the pre-rung row reads as undeclared, never back-filled");

  // Undeclared legacy work is still claimable...
  const claimed = migrated.claim({ worker: "claude:updex:legacy" })!;
  assert.equal(claimed.id, legacy.id);
  migrated.release(legacy.id, claimed.leaseToken!, "claude:updex:legacy", "put it back");

  // ...and visible to the audit as exactly that.
  const findings = migrated.auditContracts({ repository: REPOSITORY });
  assert.deepEqual(
    findings.map((finding) => [finding.id, finding.problem]),
    [[legacy.id, "undeclared-execution-target"]],
  );
});

test("the MCP follow-up schema requires executionTarget and the store validates its value", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-execution-target-mcp-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  test.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);
  queue.enqueueSeed(
    definition({
      kind: "quality-gap-discovery",
      allowedActions: ["read", "create-followup"],
      delegableActions: ["read", "run-tests"],
      executionTarget: "read-only",
    }) as never,
  );
  const claimed = queue.claim({ worker: "claude:updex:discovery" })!;

  const server = buildQueueMcpServer(path, {}, {}, undefined, queue);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "execution-target-test", version: "0.1.0" });
  await client.connect(clientTransport);
  test.after(async () => {
    await client.close();
    await server.close();
  });

  const followUp = {
    kind: "test-implementation",
    objective: "Cover it.",
    instructions: "Add the test.",
    acceptanceCriteria: ["Covered."],
    allowedActions: ["read", "run-tests"],
    delegableActions: [],
    requiredArtifact: "none",
  };
  const attempt = (extra: Record<string, unknown>) =>
    client.callTool({
      name: "complete_work",
      arguments: {
        id: claimed.id,
        leaseToken: claimed.leaseToken!,
        worker: "claude:updex:discovery",
        result: { summary: "One gap.", evidence: ["src/x.ts"], artifacts: [] },
        followUps: [{ ...followUp, ...extra }],
      },
    });

  const missing = (await attempt({})) as { isError?: boolean; content: unknown };
  assert.equal(missing.isError, true, "the schema refuses a follow-up without executionTarget");

  const accepted = (await attempt({ executionTarget: "read-only" })) as { isError?: boolean; content: Array<{ text: string }> };
  assert.ok(!accepted.isError, JSON.stringify(accepted.content));
  const parsed = JSON.parse(accepted.content[0]!.text) as { followUps: Array<{ executionTarget: string }> };
  assert.equal(parsed.followUps[0]?.executionTarget, "read-only");
});
