import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { buildQueueMcpServer } from "../src/mcp/server.ts";
import { QueueStore, type PredecessorStatus } from "../src/queue/store.ts";
import type { ArtifactVerification, ProposedRootInput, WorkArtifact, WorkItem } from "../src/queue/types.ts";
import { childEnvironment } from "./helpers/child-environment.ts";

// The claim gate of ADR-0066 decision 3: an item that declares predecessors is
// claimable only when every one of them names a completed item whose artifacts
// Snowcat itself observed delivered. Eligibility is read from stored
// verification state alone — these tests never install a fetcher, and one of
// them proves the claim path would throw if it asked GitHub anything.
//
// This file replaces the slice-1 expectation in test/predecessors.test.ts that
// an admitted item with unmet predecessors is still claimed.

const REPOSITORY = "frostyard/updex";
const OTHER_REPOSITORY = "frostyard/std";
const WORKER = "claude:test:author";
const VERIFIED_AT = "2026-08-20T13:00:00.000Z";

const issue = (number: number, repository = REPOSITORY) => `https://github.com/${repository}/issues/${number}`;

function mergedPullRequest(number: number): ArtifactVerification {
  return { status: "verified", verifiedAt: VERIFIED_AT, number, state: "merged", mergedAt: "2026-08-20T12:30:00.000Z" };
}

function openPullRequest(number: number): ArtifactVerification {
  return { status: "verified", verifiedAt: VERIFIED_AT, number, state: "open" };
}

function release(state: "draft" | "published"): ArtifactVerification {
  return {
    status: "verified",
    verifiedAt: VERIFIED_AT,
    number: 4242,
    state,
    tag: "v1.4.0",
    ...(state === "published" ? { publishedAt: "2026-08-20T12:45:00.000Z" } : {}),
  };
}

interface Harness {
  queue: QueueStore;
  path: string;
  /** Moves the store's clock on, so `created_at` orders candidates deterministically. */
  advance: () => void;
}

async function openQueue(prefix: string): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), `snowcat-${prefix}-`));
  const path = join(directory, "queue.db");
  let now = new Date("2026-08-20T12:00:00.000Z");
  const queue = new QueueStore(path, () => now);
  queue.setRepositoryEnabled(REPOSITORY, true);
  queue.setRepositoryEnabled(OTHER_REPOSITORY, true);
  return { queue, path, advance: () => (now = new Date(now.getTime() + 60_000)) };
}

function root(overrides: Partial<ProposedRootInput> & { sourceRef: string }): ProposedRootInput {
  return {
    kind: "issue-resolution",
    objective: "Land the slice.",
    instructions: "Read the issue, then open one pull request.",
    acceptanceCriteria: ["A pull request is open."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    createdBy: "operator:import-issues",
    ...overrides,
  };
}

/** One admitted successor: the item under test, carrying the edges it waits for. */
function admitSuccessor(
  harness: Harness,
  options: { sourceRef: string; predecessors?: string[]; priority?: number; repository?: string },
): WorkItem {
  const { created } = harness.queue.enqueueProposedRoots(options.repository ?? REPOSITORY, [
    root({ sourceRef: options.sourceRef, ...(options.predecessors ? { predecessors: options.predecessors } : {}), priority: options.priority ?? 0 }),
  ]);
  harness.advance();
  return harness.queue.approve(created[0]!.id, "operator:test");
}

/**
 * One predecessor item, taken through the real lifecycle: imported, admitted,
 * claimed, completed with the artifacts a worker reported, and then given the
 * verifications the `verify-artifacts` sweep writes. Its own kind keeps the
 * seeding claim from picking up anything else that is queued.
 */
function completePredecessor(
  harness: Harness,
  options: {
    sourceRef: string;
    repository?: string;
    artifacts?: WorkArtifact[];
    verifications?: Array<{ url: string; verification: ArtifactVerification }>;
    allowedActions?: ProposedRootInput["allowedActions"];
  },
): WorkItem {
  const repository = options.repository ?? REPOSITORY;
  const { created } = harness.queue.enqueueProposedRoots(repository, [
    root({
      sourceRef: options.sourceRef,
      kind: "project-slice",
      ...(options.allowedActions ? { allowedActions: options.allowedActions } : {}),
    }),
  ]);
  const item = created[0]!;
  harness.queue.approve(item.id, "operator:test");
  const claimed = harness.queue.claim({ worker: "claude:test:predecessor", repository, kinds: ["project-slice"] });
  assert.equal(claimed?.id, item.id, "the seeding claim took the predecessor itself");
  harness.queue.complete({
    id: item.id,
    leaseToken: claimed!.leaseToken!,
    worker: "claude:test:predecessor",
    result: { summary: "Landed the predecessor slice.", evidence: ["npm run check"], artifacts: options.artifacts ?? [] },
    followUps: [],
  });
  for (const observed of options.verifications ?? []) {
    harness.queue.recordArtifactVerification(item.id, observed.url, observed.verification, "policy:verify-artifacts");
  }
  harness.advance();
  return harness.queue.get(item.id)!;
}

const statusFor = (statuses: PredecessorStatus[], sourceRef: string): PredecessorStatus =>
  statuses.find((entry) => entry.sourceRef === sourceRef)!;

test("an item whose predecessor is not delivered is skipped, and the claim takes the next eligible item", async () => {
  const harness = await openQueue("gate-skip");
  const { queue } = harness;
  test.after(() => queue.close());

  // The predecessor exists — imported, awaiting the operator — but is not
  // completed, so its successor is out of the running whatever its priority.
  const { created } = queue.enqueueProposedRoots(REPOSITORY, [root({ sourceRef: issue(1), kind: "project-slice" })]);
  const predecessor = created[0]!;
  harness.advance();
  const gated = admitSuccessor(harness, { sourceRef: issue(2), predecessors: [issue(1)], priority: 5 });
  const plain = admitSuccessor(harness, { sourceRef: issue(3), priority: 1 });

  const claimed = queue.claim({ worker: WORKER, repository: REPOSITORY });
  assert.equal(claimed?.id, plain.id, "the lower-priority ungated item is claimed; the gated one is not a candidate");
  assert.equal(queue.claim({ worker: "claude:test:second", repository: REPOSITORY }), undefined, "and nothing else is claimable");

  // Ineligible is not blocked, cancelled, or hidden: the item stays queued and
  // says why (ADR-0066 decision 6 — failure is loud and manual).
  assert.equal(queue.get(gated.id)!.status, "queued");
  const [status] = queue.predecessorStatuses(gated.id);
  assert.equal(status!.satisfied, false);
  assert.equal(status!.itemId, predecessor.id);
  assert.match(status!.reason!, /is proposed, not completed/);
  assert.deepEqual(
    queue.events(gated.id).map((event) => event.type),
    ["work.proposed", "work.approved"],
    "the gate writes nothing to the item it withholds",
  );
});

test("a completed predecessor whose pull request is observed merged unblocks its successor, across repositories", async () => {
  const harness = await openQueue("gate-merged");
  const { queue } = harness;
  test.after(() => queue.close());

  const pullRequest = "https://github.com/frostyard/std/pull/12";
  const predecessor = completePredecessor(harness, {
    sourceRef: issue(20, OTHER_REPOSITORY),
    repository: OTHER_REPOSITORY,
    artifacts: [{ kind: "pull-request", url: pullRequest }],
  });
  // Predecessors join on source reference, and the queue is one database: the
  // edge crosses from frostyard/std to frostyard/updex without naming an id.
  const gated = admitSuccessor(harness, { sourceRef: issue(21), predecessors: [issue(20, OTHER_REPOSITORY)] });

  // Completion alone is a worker's assertion; an unverified pull request is
  // not a landed predecessor.
  assert.equal(queue.claim({ worker: WORKER, repository: REPOSITORY }), undefined);
  assert.match(queue.predecessorStatuses(gated.id)[0]!.reason!, /pull request .*\/pull\/12 is observed unverified/);

  // The sweep sees it open, then merged. Only the merge satisfies the edge.
  queue.recordArtifactVerification(predecessor.id, pullRequest, openPullRequest(12), "policy:verify-artifacts");
  assert.equal(queue.claim({ worker: WORKER, repository: REPOSITORY }), undefined);
  assert.match(queue.predecessorStatuses(gated.id)[0]!.reason!, /is observed open/);

  queue.recordArtifactVerification(predecessor.id, pullRequest, mergedPullRequest(12), "policy:verify-artifacts");
  const satisfied = queue.predecessorStatuses(gated.id)[0]!;
  assert.equal(satisfied.satisfied, true);
  assert.equal(satisfied.reason, undefined);
  assert.equal(satisfied.itemId, predecessor.id);
  assert.equal(satisfied.delivery, "merged");
  assert.equal(queue.claim({ worker: WORKER, repository: REPOSITORY })?.id, gated.id);
});

test("a published release satisfies a predecessor where a draft release does not", async () => {
  const harness = await openQueue("gate-release");
  const { queue } = harness;
  test.after(() => queue.close());

  const releaseUrl = "https://github.com/frostyard/updex/releases/tag/v1.4.0";
  const predecessor = completePredecessor(harness, {
    sourceRef: issue(30),
    artifacts: [{ kind: "release", url: releaseUrl }],
    verifications: [{ url: releaseUrl, verification: release("draft") }],
  });
  const gated = admitSuccessor(harness, { sourceRef: issue(31), predecessors: [issue(30)] });

  // A draft release verifies but is not delivered: a human has not published
  // it, and the human at the boundary is the pacing mechanism.
  assert.equal(queue.get(predecessor.id)!.delivery, "open");
  assert.equal(queue.claim({ worker: WORKER, repository: REPOSITORY }), undefined);
  assert.match(queue.predecessorStatuses(gated.id)[0]!.reason!, /release .*\/releases\/tag\/v1\.4\.0 is observed draft/);

  queue.recordArtifactVerification(predecessor.id, releaseUrl, release("published"), "policy:verify-artifacts");
  assert.equal(queue.get(predecessor.id)!.delivery, "published");
  assert.equal(queue.predecessorStatuses(gated.id)[0]!.satisfied, true);
  assert.equal(queue.claim({ worker: WORKER, repository: REPOSITORY })?.id, gated.id);
});

test("a completed predecessor that reported no pull request or release satisfies on completion alone", async () => {
  const harness = await openQueue("gate-artifactless");
  const { queue } = harness;
  test.after(() => queue.close());

  const none = completePredecessor(harness, { sourceRef: issue(40), artifacts: [] });
  // An issue is neither merged nor published; it carries no delivery boundary,
  // so it does not withhold the successor either.
  const issueOnly = completePredecessor(harness, {
    sourceRef: issue(41),
    allowedActions: ["read", "open-issue"],
    artifacts: [{ kind: "issue", url: "https://github.com/frostyard/updex/issues/9" }],
  });
  const gated = admitSuccessor(harness, { sourceRef: issue(42), predecessors: [issue(40), issue(41)] });

  assert.equal(queue.get(none.id)!.delivery, "none");
  assert.deepEqual(
    queue.predecessorStatuses(gated.id).map((entry) => entry.satisfied),
    [true, true],
  );
  assert.equal(queue.get(issueOnly.id)!.delivery, "none");
  assert.equal(queue.claim({ worker: WORKER, repository: REPOSITORY })?.id, gated.id);
});

test("a predecessor URL no work item carries leaves its successor ineligible and visible", async () => {
  const harness = await openQueue("gate-missing");
  const { queue } = harness;
  test.after(() => queue.close());

  const gated = admitSuccessor(harness, { sourceRef: issue(50), predecessors: [issue(51)] });
  assert.equal(queue.claim({ worker: WORKER, repository: REPOSITORY }), undefined);
  const [status] = queue.predecessorStatuses(gated.id);
  assert.deepEqual(status, {
    sourceRef: issue(51),
    satisfied: false,
    reason: "no work item in this queue carries this source reference",
  });
  assert.equal(queue.get(gated.id)!.status, "queued", "an unimported predecessor is a visible wait, not a block");
  assert.equal(queue.list({ repository: REPOSITORY, status: "queued" }).length, 1);
});

test("a cancelled predecessor withholds its successor forever, and nothing cascades to it", async () => {
  const harness = await openQueue("gate-cancelled");
  const { queue } = harness;
  test.after(() => queue.close());

  const { created } = queue.enqueueProposedRoots(REPOSITORY, [root({ sourceRef: issue(60), kind: "project-slice" })]);
  const rejected = queue.reject(created[0]!.id, "operator:test", "the project changed shape");
  assert.equal(rejected.status, "cancelled");
  harness.advance();
  const gated = admitSuccessor(harness, { sourceRef: issue(61), predecessors: [issue(60)] });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(queue.claim({ worker: WORKER, repository: REPOSITORY }), undefined, "a cancelled predecessor never delivers");
  }
  // ADR-0066 decision 6: no automatic cascade. The successor is still queued,
  // still visible, and untouched — the operator cancels or refiles it.
  const successor = queue.get(gated.id)!;
  assert.equal(successor.status, "queued");
  assert.equal(successor.result, undefined);
  assert.deepEqual(
    queue.events(gated.id).map((event) => event.type),
    ["work.proposed", "work.approved"],
  );
  assert.match(queue.predecessorStatuses(gated.id)[0]!.reason!, /is cancelled, not completed/);
});

test("a two-item cycle claims neither member, while a third eligible item still claims", async () => {
  const harness = await openQueue("gate-cycle");
  const { queue } = harness;
  test.after(() => queue.close());

  // A cycle is not rejected at import — the queue never sees the graph, only
  // one item's edges — so its consequence is exactly this: neither member ever
  // becomes eligible, and the rest of the queue is unaffected.
  const first = admitSuccessor(harness, { sourceRef: issue(70), predecessors: [issue(71)], priority: 9 });
  const second = admitSuccessor(harness, { sourceRef: issue(71), predecessors: [issue(70)], priority: 9 });
  const eligible = admitSuccessor(harness, { sourceRef: issue(72), priority: 0 });

  assert.equal(queue.claim({ worker: WORKER, repository: REPOSITORY })?.id, eligible.id);
  assert.equal(queue.claim({ worker: "claude:test:second", repository: REPOSITORY }), undefined);
  for (const member of [first, second]) {
    assert.equal(queue.get(member.id)!.status, "queued");
    assert.match(queue.predecessorStatuses(member.id)[0]!.reason!, /is queued, not completed/);
  }
});

test("the claim path and predecessor reads ask GitHub nothing", async () => {
  const harness = await openQueue("gate-no-fetch");
  const { queue } = harness;
  test.after(() => queue.close());

  const pullRequest = "https://github.com/frostyard/updex/pull/80";
  completePredecessor(harness, {
    sourceRef: issue(80),
    artifacts: [{ kind: "pull-request", url: pullRequest }],
    verifications: [{ url: pullRequest, verification: mergedPullRequest(80) }],
  });
  const satisfied = admitSuccessor(harness, { sourceRef: issue(81), predecessors: [issue(80)], priority: 5 });
  const unmet = admitSuccessor(harness, { sourceRef: issue(82), predecessors: [issue(83)], priority: 4 });

  // Eligibility is decided from stored observations only. A fetcher that
  // throws on call turns any GitHub read in the claim path into a failure.
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls += 1;
    throw new Error("the claim path must not read GitHub");
  }) as typeof fetch;
  try {
    assert.equal(queue.claim({ worker: WORKER, repository: REPOSITORY })?.id, satisfied.id);
    assert.equal(queue.claim({ worker: "claude:test:second", repository: REPOSITORY }), undefined, "the unmet item stays out");
    assert.equal(queue.predecessorStatuses(unmet.id)[0]!.satisfied, false);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 0, "no request was attempted at all");
});

test("queue -- show prints each predecessor with its current satisfaction", async () => {
  const harness = await openQueue("gate-show");
  const { queue, path } = harness;

  const pullRequest = "https://github.com/frostyard/updex/pull/90";
  completePredecessor(harness, {
    sourceRef: issue(90),
    artifacts: [{ kind: "pull-request", url: pullRequest }],
    verifications: [{ url: pullRequest, verification: mergedPullRequest(90) }],
  });
  const gated = admitSuccessor(harness, { sourceRef: issue(91), predecessors: [issue(90), issue(92)] });
  const plain = admitSuccessor(harness, { sourceRef: issue(93) });
  queue.close();

  const run = (id: string) =>
    JSON.parse(
      execFileSync(process.execPath, ["--import", "tsx", "src/queue/cli.ts", "show", id], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: childEnvironment({ SNOWCAT_QUEUE_DB: path }),
      }),
    ) as { item: Record<string, unknown>; predecessors?: PredecessorStatus[]; events: unknown[] };

  const shown = run(gated.id);
  assert.deepEqual(shown.item.predecessors, [issue(90), issue(92)]);
  assert.equal(shown.predecessors?.length, 2);
  assert.equal(statusFor(shown.predecessors!, issue(90)).satisfied, true);
  assert.equal(statusFor(shown.predecessors!, issue(90)).delivery, "merged");
  const unmet = statusFor(shown.predecessors!, issue(92));
  assert.equal(unmet.satisfied, false);
  assert.match(unmet.reason!, /no work item in this queue carries this source reference/);

  // An item that declares none prints no predecessors block at all.
  assert.equal(run(plain.id).predecessors, undefined);
});

test("list_work carries an item's predecessors, and claim_work still refuses it", async () => {
  const harness = await openQueue("gate-mcp");
  const { queue, path } = harness;
  const gated = admitSuccessor(harness, { sourceRef: issue(100), predecessors: [issue(101)] });
  queue.close();

  const server = buildQueueMcpServer(path);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "predecessor-gate-test", version: "0.1.0" });
  await client.connect(clientTransport);
  test.after(async () => {
    await client.close();
    await server.close();
  });

  const parse = (result: unknown) => JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as never;
  const listed = parse(await client.callTool({ name: "list_work", arguments: { status: "queued" } })) as Array<Record<string, unknown>>;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, gated.id);
  assert.deepEqual(listed[0]!.predecessors, [issue(101)], "the field is read-only bookkeeping, listed with the item");

  // No new MCP tool decides eligibility: the gate lives in the claim itself.
  const claimed = parse(
    await client.callTool({ name: "claim_work", arguments: { worker: "claude:test:mcp", repository: REPOSITORY } }),
  );
  assert.equal(claimed, null);
});
