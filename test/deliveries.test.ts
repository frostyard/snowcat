import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { pendingDeliveries } from "../src/queue/deliveries.ts";
import { QueueStore } from "../src/queue/store.ts";
import type { WorkItem } from "../src/queue/types.ts";
import { childEnvironment } from "./helpers/child-environment.ts";

/** Seed, claim, and complete one item reporting the given artifact. */
function completeWithArtifact(
  queue: QueueStore,
  repository: string,
  objective: string,
  artifact: { kind: "pull-request" | "release"; url: string },
) {
  const seed = queue.enqueueSeed({
    repository,
    kind: "issue-resolution",
    objective,
    instructions: "Do the work and report the artifact.",
    acceptanceCriteria: ["The artifact exists."],
    // A pull-request row is ordinary change work; a release row is a
    // read-only reporter (reporting a release needs no action of its own).
    allowedActions: artifact.kind === "pull-request" ? ["read", "write", "run-tests", "open-pr"] : ["read", "run-tests"],
    delegableActions: [],
    requiredArtifact: artifact.kind === "pull-request" ? "pull-request" : "none",
    executionTarget: artifact.kind === "pull-request" ? "new-pull-request" : "read-only",
    createdBy: "operator:test",
  });

  const claimed = queue.claim({ worker: `claude:test:${seed.id.slice(0, 8)}`, repository })!;
  queue.complete({
    id: seed.id,
    leaseToken: claimed.leaseToken!,
    worker: claimed.leaseOwner!,
    result: { summary: objective, evidence: ["done"], artifacts: [{ ...artifact }] },
    followUps: [],
  });
  return seed;
}

test("deliveries lists open completed work ready-first and excludes merged, draft-gated-only rows sort after ready ones", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-deliveries-test-"));
  const path = join(directory, "queue.db");
  const queue = new QueueStore(path);
  queue.setRepositoryEnabled("frostyard/updex", true);
  queue.setRepositoryEnabled("frostyard/std", true);

  // Oldest first: a draft PR (gate's, not ready), then a ready non-draft PR,
  // then a merged PR (delivered, excluded), then a ready draft release.
  const gated = completeWithArtifact(queue, "frostyard/updex", "Gated draft", { kind: "pull-request", url: "https://github.com/frostyard/updex/pull/11" });
  const ready = completeWithArtifact(queue, "frostyard/updex", "Ready to merge", { kind: "pull-request", url: "https://github.com/frostyard/updex/pull/12" });
  const readyMerged = completeWithArtifact(queue, "frostyard/updex", "Observed the same pull request merged", { kind: "pull-request", url: "https://github.com/Frostyard/Updex/pull/12" });
  const merged = completeWithArtifact(queue, "frostyard/updex", "Already merged", { kind: "pull-request", url: "https://github.com/frostyard/updex/pull/13" });
  const release = completeWithArtifact(queue, "frostyard/std", "Publish the tag", { kind: "release", url: "https://github.com/frostyard/std/releases/tag/v1.2.3" });

  const at = new Date().toISOString();
  queue.recordArtifactVerification(gated.id, "https://github.com/frostyard/updex/pull/11", { status: "verified", verifiedAt: at, number: 11, state: "open", draft: true }, "operator:test");
  queue.recordArtifactVerification(ready.id, "https://github.com/frostyard/updex/pull/12", { status: "verified", verifiedAt: at, number: 12, state: "open" }, "operator:test");
  queue.recordArtifactVerification(readyMerged.id, "https://github.com/Frostyard/Updex/pull/12", { status: "verified", verifiedAt: new Date(Date.parse(at) + 1_000).toISOString(), number: 12, state: "merged", mergedAt: new Date(Date.parse(at) + 1_000).toISOString() }, "operator:test");
  queue.recordArtifactVerification(merged.id, "https://github.com/frostyard/updex/pull/13", { status: "verified", verifiedAt: at, number: 13, state: "merged", mergedAt: at }, "operator:test");
  queue.recordArtifactVerification(release.id, "https://github.com/frostyard/std/releases/tag/v1.2.3", { status: "verified", verifiedAt: at, number: 9001, state: "draft", tag: "v1.2.3" }, "operator:test");
  queue.close();

  const run = (args: string[]) =>
    execFileSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", ...args], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: childEnvironment({ SNOWCAT_QUEUE_DB: path }),
    });

  const rows = JSON.parse(run(["deliveries"])) as Array<Record<string, unknown>>;
  // Ready rows first, the gate-held draft last. Both terminal observations
  // are included in reconciliation and suppress their older open report.
  assert.deepEqual(
    rows.map((row) => [row.workItemId, row.handoff, row.ready]),
    [
      [release.id, "publish", true],
      [gated.id, "review", false],
    ],
  );
  assert.deepEqual(rows[0]?.artifact, {
    kind: "release",
    url: "https://github.com/frostyard/std/releases/tag/v1.2.3",
    state: "draft",
    draft: false,
    verifiedAt: at,
  });
  assert.ok(!run(["deliveries"]).includes("leaseToken"));

  // The repository filter narrows; a repository with only delivered work lists nothing.
  const std = JSON.parse(run(["deliveries", "--repository", "frostyard/std"])) as Array<Record<string, unknown>>;
  assert.deepEqual(
    std.map((row) => row.workItemId),
    [release.id],
  );
});

test("artifact-centric deliveries deduplicate one pull request and surface deferred handoff ownership", () => {
  const base = {
    repository: "frostyard/updex",
    kind: "issue-resolution",
    objective: "Resolve the issue.",
    sourceRef: "https://github.com/frostyard/updex/issues/7",
    createdAt: "2026-08-20T10:00:00.000Z",
    result: {
      summary: "Opened the pull request.",
      evidence: ["npm test passed"],
      artifacts: [
        {
          kind: "pull-request" as const,
          url: "https://github.com/frostyard/updex/pull/12",
          verification: {
            status: "verified" as const,
            verifiedAt: "2026-08-20T11:00:00.000Z",
            number: 12,
            state: "open" as const,
            draft: true,
          },
        },
      ],
    },
  };
  const rows = pendingDeliveries([
    { ...base, id: "origin" } as WorkItem,
    {
      ...base,
      id: "repair",
      createdAt: "2026-08-20T12:00:00.000Z",
      result: {
        ...base.result,
        artifacts: [
          {
            ...base.result.artifacts[0],
            url: "https://github.com/Frostyard/Updex/pull/12",
            verification: {
              ...base.result.artifacts[0]!.verification,
              verifiedAt: "2026-08-20T13:00:00.000Z",
              handoff: {
                status: "rejected" as const,
                checkedAt: "2026-08-20T13:00:00.000Z",
                reason: "pull request body is missing required template sections",
              },
            },
          },
        ],
      },
    } as WorkItem,
    {
      ...base,
      id: "source-refresh",
      createdAt: "2026-08-20T12:30:00.000Z",
      result: {
        ...base.result,
        artifacts: [
          {
            ...base.result.artifacts[0],
            verification: {
              ...base.result.artifacts[0]!.verification,
              verifiedAt: "2026-08-20T14:00:00.000Z",
              headSha: "b".repeat(40),
            },
          },
        ],
      },
    } as WorkItem,
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.workItemId, "origin", "the oldest completion remains the work context");
  assert.equal(rows[0]?.artifact.verifiedAt, "2026-08-20T14:00:00.000Z", "the newest source observation wins");
  assert.equal(rows[0]?.handoff, "repair");
  assert.equal(rows[0]?.ready, false);
  assert.match(rows[0]?.reason ?? "", /missing required template sections/);
});

test("a newer terminal observation suppresses an older pending delivery", () => {
  const item = (id: string, state: "open" | "merged", verifiedAt: string): WorkItem =>
    ({
      id,
      repository: "frostyard/updex",
      kind: "issue-resolution",
      objective: "Resolve the issue.",
      createdAt: verifiedAt,
      updatedAt: verifiedAt,
      result: {
        summary: state,
        evidence: ["observed"],
        artifacts: [
          {
            kind: "pull-request",
            url: `https://github.com/frostyard/updex/pull/14`,
            verification: {
              status: "verified",
              verifiedAt,
              number: 14,
              state,
              ...(state === "merged" ? { mergedAt: verifiedAt } : {}),
            },
          },
        ],
      },
    }) as WorkItem;

  assert.deepEqual(
    pendingDeliveries([
      item("open", "open", "2026-08-20T10:00:00.000Z"),
      item("merged", "merged", "2026-08-20T11:00:00.000Z"),
    ]),
    [],
  );
});

test("delivery observation selection limits pending identities rather than terminal history", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-delivery-selection-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/updex", true);
  const seed = queue.enqueueSeed({
    repository: "frostyard/updex",
    kind: "issue-resolution",
    objective: "Report two pull requests.",
    instructions: "Report both artifacts.",
    acceptanceCriteria: ["Both pull requests are recorded."],
    allowedActions: ["read", "write", "open-pr"],
    delegableActions: [],
    requiredArtifact: "pull-request",
    executionTarget: "new-pull-request",
    createdBy: "operator:test",
  });
  const claimed = queue.claim({ worker: "claude:test:two-artifacts" })!;
  queue.complete({
    id: seed.id,
    leaseToken: claimed.leaseToken!,
    worker: claimed.leaseOwner!,
    result: {
      summary: "Reported both.",
      evidence: ["observed"],
      artifacts: [
        {
          kind: "pull-request",
          url: "https://github.com/frostyard/updex/pull/21",
          verification: {
            status: "verified",
            verifiedAt: "2026-08-20T10:00:00.000Z",
            number: 21,
            state: "open",
          },
        },
        {
          kind: "pull-request",
          url: "https://github.com/frostyard/updex/pull/22",
          verification: {
            status: "verified",
            verifiedAt: "2026-08-20T11:00:00.000Z",
            number: 22,
            state: "open",
          },
        },
      ],
    },
    followUps: [],
  });
  const terminalUpdate = completeWithArtifact(queue, "frostyard/updex", "Newest terminal observation", {
    kind: "pull-request",
    url: "https://github.com/Frostyard/Updex/pull/22",
  });
  queue.recordArtifactVerification(terminalUpdate.id, "https://github.com/Frostyard/Updex/pull/22", {
    status: "verified",
    verifiedAt: "2026-08-20T12:00:00.000Z",
    number: 22,
    state: "merged",
    mergedAt: "2026-08-20T12:00:00.000Z",
  }, "operator:test");

  const selected = queue.completedItemsWithPendingArtifacts({ deliveryObservationsOnly: true, limit: 1 });
  assert.deepEqual(selected.map((item) => item.id), [seed.id]);
  assert.deepEqual(selected[0]?.result?.artifacts.map((artifact) => artifact.url), ["https://github.com/frostyard/updex/pull/21"]);
  assert.deepEqual(pendingDeliveries(selected).map((row) => row.workItemId), [seed.id]);
});
