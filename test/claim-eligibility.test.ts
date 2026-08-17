import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlPlaneStore } from "../src/control/store.ts";
import { controlPlaneClaimEligibility, queueStoreOptionsFromEnvironment } from "../src/queue/eligibility.ts";
import { QueueStore } from "../src/queue/store.ts";
import { enrollExampleRepository } from "./helpers/core-fixtures.ts";

function seed(queue: QueueStore, repository: string, priority: number, kind = "quality-gap-discovery") {
  queue.setRepositoryEnabled(repository, true);
  return queue.enqueueSeed({
    repository,
    kind,
    objective: `Work for ${repository}`,
    instructions: "Read only.",
    acceptanceCriteria: ["One gap."],
    allowedActions: ["read"],
    delegableActions: [],
    priority,
    createdBy: "operator:test",
  });
}

test("the claim eligibility hook filters repositories on top of opt-in and fails closed when it throws", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-eligibility-store-test-"));
  const path = join(directory, "queue.db");
  const asked: string[] = [];
  let eligible = new Set(["frostyard/lodge"]);
  let explode = false;
  const queue = new QueueStore(path, undefined, {
    claimEligibility: (repository) => {
      asked.push(repository);
      if (explode) throw new Error("control plane unreadable");
      return eligible.has(repository);
    },
  });
  test.after(() => queue.close());
  const updex = seed(queue, "frostyard/updex", 100);
  const lodge = seed(queue, "frostyard/lodge", 1);

  // The higher-priority updex item is not in the running while its repository is ineligible.
  const first = queue.claim({ worker: "claude:eligibility" });
  assert.equal(first?.id, lodge.id);
  assert.deepEqual([...new Set(asked)].sort(), ["frostyard/lodge", "frostyard/updex"]);
  assert.equal(queue.claim({ worker: "claude:eligibility" }), undefined, "nothing else eligible");
  assert.equal(queue.claim({ worker: "claude:eligibility", repository: "frostyard/updex" }), undefined);
  assert.equal(queue.get(updex.id)?.status, "queued");

  // Eligibility is asked fresh on every claim.
  eligible = new Set(["frostyard/updex"]);
  assert.equal(queue.claim({ worker: "claude:eligibility" })?.id, updex.id);

  // A throwing hook fails the claim closed and leaves nothing leased.
  const third = seed(queue, "frostyard/updex", 5, "ci-gap-discovery");
  explode = true;
  assert.throws(() => queue.claim({ worker: "claude:eligibility" }), /control plane unreadable/);
  assert.equal(queue.get(third.id)?.status, "queued");
  assert.equal(queue.get(third.id)?.leaseOwner, undefined);

  // Without a hook, opt-in alone governs (same database, second store).
  const plain = new QueueStore(path);
  assert.equal(plain.claim({ worker: "claude:plain" })?.id, third.id);
  plain.close();
});

test("control-plane eligibility admits only enrolled repositories and reacts to operator holds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-eligibility-control-test-"));
  const controlPath = join(directory, "control-plane.db");
  const store = new ControlPlaneStore(controlPath, () => new Date("2026-08-17T12:00:00.000Z"));
  test.after(() => store.close());

  const missing = controlPlaneClaimEligibility(join(directory, "nope.db"));
  assert.throws(() => missing("frostyard/example"), /does not exist/);

  const eligibility = controlPlaneClaimEligibility(controlPath);
  assert.equal(eligibility("frostyard/example"), false, "no authority yet");

  await enrollExampleRepository(store);
  assert.equal(store.repositoryStatuses()[0]?.effectiveState, "enrolled");
  assert.equal(eligibility("frostyard/example"), true);
  assert.equal(eligibility("FrostYard/Example"), true, "slug comparison is case-insensitive");
  assert.equal(eligibility("frostyard/other"), false, "not declared in Core");

  const held = store.imposeRepositoryOperatorHold({
    expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
    repositoryId: "github.com:9001",
    reason: "Incident review.",
  });
  assert.equal(store.repositoryStatuses()[0]?.effectiveState, "operator-held");
  assert.equal(eligibility("frostyard/example"), false, "operator hold blocks claims");

  store.clearRepositoryOperatorHold({
    expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
    repositoryId: "github.com:9001",
    holdDecisionId: held.decisionRecordId,
    reason: "Resolved.",
  });
  assert.equal(eligibility("frostyard/example"), true);

  // Wired through a queue: the enrolled repository's item is claimable, the undeclared one is not.
  const queue = new QueueStore(join(directory, "queue.db"), undefined, { claimEligibility: eligibility });
  test.after(() => queue.close());
  const other = seed(queue, "frostyard/other", 50);
  const example = seed(queue, "frostyard/example", 1);
  assert.equal(queue.claim({ worker: "claude:control" })?.id, example.id);
  assert.equal(queue.claim({ worker: "claude:control" }), undefined);
  assert.equal(queue.get(other.id)?.status, "queued");
});

test("host processes wire the control-plane hook only when FLUENT_CONTROL_DB is configured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-eligibility-env-test-"));
  assert.deepEqual(queueStoreOptionsFromEnvironment({}), {});
  assert.deepEqual(queueStoreOptionsFromEnvironment({ FLUENT_CONTROL_DB: ":memory:" }), {});
  const configured = queueStoreOptionsFromEnvironment({ FLUENT_CONTROL_DB: join(directory, "control-plane.db") });
  assert.equal(typeof configured.claimEligibility, "function");

  // The MCP server honors the same environment: with an unenrolled control plane configured,
  // an opted-in repository's admitted item is not claimable; without it, it is.
  const controlPath = join(directory, "control-plane.db");
  new ControlPlaneStore(controlPath).close();
  const queuePath = join(directory, "queue.db");
  const queue = new QueueStore(queuePath);
  const item = seed(queue, "frostyard/updex", 1);
  queue.close();
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const claimVia = (env: Record<string, string>) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["--import", "tsx", "-e", `
          import { Client } from "@modelcontextprotocol/client";
          import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
          const client = new Client({ name: "env-test", version: "0.1.0" });
          await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/mcp/stdio.ts"], env: process.env, stderr: "ignore" }));
          const result = await client.callTool({ name: "claim_work", arguments: { worker: "claude:env-test" } });
          console.log(result.content[0].text);
          await client.close();
        `],
        { cwd: process.cwd(), encoding: "utf8", env: { ...baseEnv, ...env }, stdio: ["ignore", "pipe", "ignore"] },
      ),
    ) as { id?: string } | null;

  assert.equal(claimVia({ FLUENT_QUEUE_DB: queuePath, FLUENT_CONTROL_DB: controlPath }), null, "control plane configured, nothing enrolled");
  const claimed = claimVia({ FLUENT_QUEUE_DB: queuePath, FLUENT_CONTROL_DB: "" });
  assert.equal(claimed?.id, item.id, "opt-in alone when unset");

  const list = spawnSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", "list", "claimed"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...baseEnv, FLUENT_QUEUE_DB: queuePath, FLUENT_CONTROL_DB: controlPath },
  });
  assert.equal(list.status, 0, list.stderr);
  assert.equal((JSON.parse(list.stdout) as unknown[]).length, 1, "read commands work with the hook configured");
});
