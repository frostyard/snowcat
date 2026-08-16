import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { enqueueDogfoodBatch } from "../src/queue/seeds.ts";
import { QueueStore } from "../src/queue/store.ts";

test("the dogfood feeder creates one bounded read-only root per specialty without active duplicates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-dogfood-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("bketelsen/fluent", true);

  const first = enqueueDogfoodBatch(queue, "bketelsen/fluent");
  assert.deepEqual(
    first.created.map((item) => item.kind),
    ["quality-gap-discovery", "ci-gap-discovery", "security-gap-discovery", "architecture-gap-discovery"],
  );
  assert.deepEqual(first.skippedKinds, []);
  for (const item of first.created) {
    assert.equal(item.status, "queued");
    assert.equal(item.createdBy, "operator:dogfood");
    assert.deepEqual(item.allowedActions, ["read", "create-followup"]);
    assert.equal(item.parentId, undefined);
  }

  const second = enqueueDogfoodBatch(queue, "bketelsen/fluent");
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.skippedKinds, first.created.map((item) => item.kind));

  const quality = queue.claim({ worker: "claude:fluent:dogfood", kinds: ["quality-gap-discovery"] })!;
  const completion = queue.complete({
    id: quality.id,
    leaseToken: quality.leaseToken!,
    worker: "claude:fluent:dogfood",
    result: { summary: "Found one quality gap.", evidence: ["src/example.ts"], artifacts: [] },
    followUps: [
      {
        kind: "quality-implementation",
        objective: "Correct the quality gap.",
        instructions: "Make the smallest change and run checks.",
        acceptanceCriteria: ["The project check passes."],
        allowedActions: ["read", "write", "run-tests"],
        delegableActions: [],
      },
    ],
  });
  assert.equal(completion.followUps[0]?.status, "proposed");

  const third = enqueueDogfoodBatch(queue, "bketelsen/fluent");
  assert.deepEqual(third.created, []);
  assert.deepEqual(third.skippedKinds, first.created.map((item) => item.kind));
});

test("the dogfood feeder detects active lineages beyond the 100-row listing cap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-dogfood-scale-test-"));
  let tick = 0;
  const queue = new QueueStore(join(directory, "queue.db"), () => new Date(Date.UTC(2026, 7, 15, 0, 0, tick++)));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("bketelsen/fluent", true);

  // 101 older, unrelated roots fill the whole 100-row listing window.
  for (let index = 0; index < 101; index += 1) {
    queue.enqueueSeed({
      repository: "bketelsen/fluent",
      kind: "filler-review",
      objective: `Filler root ${index}.`,
      instructions: "Read only.",
      acceptanceCriteria: ["One observation is recorded."],
      allowedActions: ["read"],
      delegableActions: [],
      createdBy: "operator:test",
    });
  }
  assert.equal(queue.list({ repository: "bketelsen/fluent", limit: 100 }).length, 100);

  const first = enqueueDogfoodBatch(queue, "bketelsen/fluent");
  assert.equal(first.created.length, 4);
  const quality = queue.claim({ worker: "claude:fluent:dogfood", kinds: ["quality-gap-discovery"] })!;
  const completion = queue.complete({
    id: quality.id,
    leaseToken: quality.leaseToken!,
    worker: "claude:fluent:dogfood",
    result: { summary: "Found one quality gap.", evidence: ["src/example.ts"], artifacts: [] },
    followUps: [
      {
        kind: "quality-implementation",
        objective: "Correct the quality gap.",
        instructions: "Make the smallest change and run checks.",
        acceptanceCriteria: ["The project check passes."],
        allowedActions: ["read", "write", "run-tests"],
        delegableActions: [],
      },
    ],
  });
  assert.equal(completion.followUps[0]?.status, "proposed");
  // The active dogfood lineages are the newest rows, outside a 100-row window.
  const window = queue.list({ repository: "bketelsen/fluent", limit: 100 });
  assert.equal(window.some((item) => item.kind !== "filler-review"), false);

  const second = enqueueDogfoodBatch(queue, "bketelsen/fluent");
  assert.deepEqual(second.created, []);
  assert.deepEqual(second.skippedKinds, first.created.map((item) => item.kind));

  // Once the quality lineage is terminal, only that specialty is offered again.
  queue.reject(completion.followUps[0]!.id, "operator:test", "Not needed.");
  const third = enqueueDogfoodBatch(queue, "bketelsen/fluent");
  assert.deepEqual(
    third.created.map((item) => item.kind),
    ["quality-gap-discovery"],
  );
  assert.deepEqual(third.skippedKinds, ["ci-gap-discovery", "security-gap-discovery", "architecture-gap-discovery"]);
});

test("an invalid later batch candidate rolls back roots inserted earlier in the transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-dogfood-rollback-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("bketelsen/fluent", true);

  assert.throws(
    () =>
      queue.enqueueInactiveRootBatch("bketelsen/fluent", [
        {
          kind: "quality-gap-discovery",
          objective: "Find one quality gap.",
          instructions: "Read only.",
          acceptanceCriteria: ["One gap is reported."],
          allowedActions: ["read"],
          delegableActions: [],
          createdBy: "operator:test",
        },
        {
          kind: "INVALID",
          objective: "This later candidate must fail validation.",
          instructions: "Never inserted.",
          acceptanceCriteria: ["The batch rolls back."],
          allowedActions: ["read"],
          delegableActions: [],
          createdBy: "operator:test",
        },
      ]),
    /invalid work kind/,
  );
  assert.deepEqual(queue.list({ repository: "bketelsen/fluent" }), []);
});

test("concurrent dogfood feeders create exactly one active root per specialty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fluent-dogfood-concurrency-test-"));
  const path = join(directory, "queue.db");
  const setup = new QueueStore(path);
  setup.setRepositoryEnabled("bketelsen/fluent", true);
  setup.close();

  const signal = new Int32Array(new SharedArrayBuffer(8));
  const workerSource = `
    (async () => {
      const { parentPort, workerData } = require("node:worker_threads");
      const { tsImport } = await import("tsx/esm/api");
      const { QueueStore } = await tsImport(workerData.storeUrl, workerData.parentUrl);
      const { enqueueDogfoodBatch } = await tsImport(workerData.seedsUrl, workerData.parentUrl);
      const queue = new QueueStore(workerData.path);
      parentPort.postMessage({ ready: true });
      Atomics.wait(workerData.signal, 1, 0);
      try {
        const result = enqueueDogfoodBatch(queue, "bketelsen/fluent");
        parentPort.postMessage({
          ready: false,
          createdKinds: result.created.map((item) => item.kind),
          skippedKinds: result.skippedKinds,
        });
      } finally {
        queue.close();
      }
    })().catch((error) => { throw error; });
  `;
  const workerData = {
    path,
    signal,
    storeUrl: new URL("../src/queue/store.ts", import.meta.url).href,
    seedsUrl: new URL("../src/queue/seeds.ts", import.meta.url).href,
    parentUrl: import.meta.url,
  };
  const workers = [
    new Worker(workerSource, { eval: true, workerData }),
    new Worker(workerSource, { eval: true, workerData }),
  ];
  const runs = workers.map((worker) => {
    let ready!: () => void;
    let resolveResult!: (result: { createdKinds: string[]; skippedKinds: string[] }) => void;
    let rejectRun!: (error: Error) => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const resultPromise = new Promise<{ createdKinds: string[]; skippedKinds: string[] }>((resolve, reject) => {
      resolveResult = resolve;
      rejectRun = reject;
    });
    const timeout = setTimeout(() => rejectRun(new Error("dogfood concurrency worker timed out")), 5000);
    worker.on("message", (message: { ready: boolean; createdKinds?: string[]; skippedKinds?: string[] }) => {
      if (message.ready) {
        ready();
      } else {
        clearTimeout(timeout);
        resolveResult({ createdKinds: message.createdKinds!, skippedKinds: message.skippedKinds! });
      }
    });
    worker.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    return { readyPromise, resultPromise };
  });

  await Promise.all(runs.map((run) => run.readyPromise));
  Atomics.store(signal, 1, 1);
  Atomics.notify(signal, 1, 2);

  const settled = await Promise.all(runs.map((run) => run.resultPromise));
  const created = settled.flatMap((result) => result.createdKinds).sort();
  const skipped = settled.flatMap((result) => result.skippedKinds).sort();
  const expected = [
    "architecture-gap-discovery",
    "ci-gap-discovery",
    "quality-gap-discovery",
    "security-gap-discovery",
  ];
  assert.deepEqual(created, expected);
  assert.deepEqual(skipped, expected);
  assert.deepEqual(
    settled.map((result) => result.createdKinds.length).sort((left, right) => left - right),
    [0, 4],
  );

  const verify = new QueueStore(path);
  assert.equal(verify.list({ repository: "bketelsen/fluent", limit: 100 }).length, 4);
  verify.close();
});
