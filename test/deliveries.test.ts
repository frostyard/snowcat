import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { QueueStore } from "../src/queue/store.ts";
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
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
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
  const merged = completeWithArtifact(queue, "frostyard/updex", "Already merged", { kind: "pull-request", url: "https://github.com/frostyard/updex/pull/13" });
  const release = completeWithArtifact(queue, "frostyard/std", "Publish the tag", { kind: "release", url: "https://github.com/frostyard/std/releases/tag/v1.2.3" });

  const at = new Date().toISOString();
  queue.recordArtifactVerification(gated.id, "https://github.com/frostyard/updex/pull/11", { status: "verified", verifiedAt: at, number: 11, state: "open", draft: true }, "operator:test");
  queue.recordArtifactVerification(ready.id, "https://github.com/frostyard/updex/pull/12", { status: "verified", verifiedAt: at, number: 12, state: "open" }, "operator:test");
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
  // Ready rows first (oldest first among them), the gate-held draft last;
  // the merged item is delivered and absent entirely.
  assert.deepEqual(
    rows.map((row) => [row.id, row.ready]),
    [
      [ready.id, true],
      [release.id, true],
      [gated.id, false],
    ],
  );
  assert.deepEqual(rows[0]?.artifacts, [{ kind: "pull-request", url: "https://github.com/frostyard/updex/pull/12", state: "open", draft: false }]);
  assert.deepEqual(rows[1]?.artifacts, [{ kind: "release", url: "https://github.com/frostyard/std/releases/tag/v1.2.3", state: "draft", draft: false }]);
  assert.ok(!run(["deliveries"]).includes("leaseToken"));

  // The repository filter narrows; a repository with only delivered work lists nothing.
  const std = JSON.parse(run(["deliveries", "--repository", "frostyard/std"])) as Array<Record<string, unknown>>;
  assert.deepEqual(
    std.map((row) => row.id),
    [release.id],
  );
});
