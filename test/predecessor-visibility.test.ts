import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { createApp } from "../src/app.ts";
import { QueueStore } from "../src/queue/store.ts";
import type { ArtifactVerification, ProposedRootInput, WorkArtifact, WorkItem } from "../src/queue/types.ts";
import { readPredecessors } from "../src/surface/predecessor-state.ts";
import { readProgress } from "../src/surface/progress-state.ts";
import { sessionDigest } from "../src/surface/session.ts";

// The surface half of ADR-0066: an admitted item the claim gate withholds is
// not "in queue", it is waiting for a named predecessor — and when the chain
// loops back on itself it is waiting forever, which only the surface can say.
// Satisfaction itself is never decided here: every verdict these tests read
// comes from `QueueStore.predecessorStatuses`, the gate's own evaluation
// (test/predecessor-gate.test.ts owns its rules), and nothing asks GitHub.

const REPOSITORY = "frostyard/example";
const TOKEN = "predecessor-visibility-token";
const VERIFIED_AT = "2026-08-20T13:00:00.000Z";

const issue = (number: number) => `https://github.com/frostyard/example/issues/${number}`;

interface Harness {
  queue: QueueStore;
  /** Moves the store's clock on so `created_at` orders items deterministically. */
  advance: () => void;
}

function openQueue(t: TestContext): Harness {
  let now = new Date("2026-08-20T12:00:00.000Z");
  const queue = new QueueStore(":memory:", () => now);
  t.after(() => queue.close());
  queue.setRepositoryEnabled(REPOSITORY, true);
  return { queue, advance: () => (now = new Date(now.getTime() + 60_000)) };
}

function root(overrides: Partial<ProposedRootInput> & { sourceRef: string; kind: string }): ProposedRootInput {
  return {
    objective: `Land ${overrides.sourceRef}.`,
    instructions: "Read the issue, then open one pull request.",
    acceptanceCriteria: ["A pull request is open."],
    allowedActions: ["read", "write", "run-tests", "open-pr"],
    delegableActions: [],
    createdBy: "operator:import-issues",
    ...overrides,
  };
}

/** One imported, still-proposed root. */
function propose(harness: Harness, options: { sourceRef: string; kind: string; predecessors?: string[] }): WorkItem {
  const { created } = harness.queue.enqueueProposedRoots(REPOSITORY, [
    root({ sourceRef: options.sourceRef, kind: options.kind, ...(options.predecessors ? { predecessors: options.predecessors } : {}) }),
  ]);
  harness.advance();
  return created[0]!;
}

/** One admitted (queued) item: what the gate withholds and the strips show. */
function admit(harness: Harness, options: { sourceRef: string; kind: string; predecessors?: string[] }): WorkItem {
  return harness.queue.approve(propose(harness, options).id, "operator:test");
}

/** One predecessor taken through the real lifecycle, then given the verifications the sweep writes. */
function completeItem(
  harness: Harness,
  options: { sourceRef: string; kind: string; artifacts?: WorkArtifact[]; verifications?: Array<{ url: string; verification: ArtifactVerification }> },
): WorkItem {
  const item = admit(harness, { sourceRef: options.sourceRef, kind: options.kind });
  const worker = `claude:test:${options.kind}`;
  const claimed = harness.queue.claim({ worker, repository: REPOSITORY, kinds: [options.kind] });
  assert.equal(claimed?.id, item.id, "the seeding claim took the intended item");
  harness.queue.complete({
    id: item.id,
    leaseToken: claimed!.leaseToken!,
    worker,
    result: { summary: "Landed it.", evidence: ["npm run check"], artifacts: options.artifacts ?? [] },
    followUps: [],
  });
  for (const observed of options.verifications ?? []) {
    harness.queue.recordArtifactVerification(item.id, observed.url, observed.verification, "policy:verify-artifacts");
  }
  harness.advance();
  return harness.queue.get(item.id)!;
}

type VerifiedArtifact = Extract<ArtifactVerification, { status: "verified" }>;

/** One observation of the shape the `verify-artifacts` sweep stores. */
function verified(overrides: Omit<VerifiedArtifact, "status" | "verifiedAt">): ArtifactVerification {
  return { status: "verified", verifiedAt: VERIFIED_AT, ...overrides };
}

/** The markup of one `<section id="...">` of a rendered page. */
function section(body: string, id: string): string {
  const start = body.indexOf(`id="${id}"`);
  assert.notEqual(start, -1, `page has no #${id} section`);
  const end = body.indexOf("</section>", start);
  assert.notEqual(end, -1, `#${id} section is unterminated`);
  return body.slice(start, end);
}

async function itemPage(queue: QueueStore, id: string): Promise<string> {
  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue }) });
  const response = await app.request(`/items/${id}`, { headers: { Cookie: `snowcat_session=${sessionDigest(TOKEN)}` } });
  assert.equal(response.status, 200);
  return await response.text();
}

test("the item page states every predecessor's satisfaction with the gate's own reason", async (t) => {
  const harness = openQueue(t);
  const { queue } = harness;

  // One of each way an edge can stand, so the page has to render them all.
  const merged = "https://github.com/frostyard/example/pull/11";
  const met = completeItem(harness, {
    sourceRef: issue(1),
    kind: "met-slice",
    artifacts: [{ kind: "pull-request", url: merged }],
    verifications: [{ url: merged, verification: verified({ number: 11, state: "merged", mergedAt: "2026-08-20T12:30:00.000Z" }) }],
  });
  // issue(2) is imported nowhere: the gate has no item to read.
  const notCompleted = propose(harness, { sourceRef: issue(3), kind: "proposed-slice" });
  const cancelled = queue.reject(propose(harness, { sourceRef: issue(4), kind: "cancelled-slice" }).id, "operator:test", "Refiled elsewhere.");
  const openPull = "https://github.com/frostyard/example/pull/55";
  const unmerged = completeItem(harness, {
    sourceRef: issue(5),
    kind: "unmerged-slice",
    artifacts: [{ kind: "pull-request", url: openPull }],
    verifications: [{ url: openPull, verification: verified({ number: 55, state: "open" }) }],
  });
  const releaseUrl = "https://github.com/frostyard/example/releases/tag/v1.4.0";
  const unpublished = completeItem(harness, {
    sourceRef: issue(6),
    kind: "release-slice",
    artifacts: [{ kind: "release", url: releaseUrl }],
    verifications: [{ url: releaseUrl, verification: verified({ number: 4242, state: "draft", tag: "v1.4.0" }) }],
  });

  const successor = admit(harness, {
    sourceRef: issue(7),
    kind: "issue-resolution",
    predecessors: [issue(1), issue(2), issue(3), issue(4), issue(5), issue(6)],
  });

  const body = await itemPage(queue, successor.id);
  const predecessors = section(body, "predecessors");
  assert.match(predecessors, /<h2>Predecessors<\/h2><span>5 of 6 unmet · withheld from claims<\/span>/);

  // Met: the store reports no reason, so the page says what satisfaction means.
  assert.match(predecessors, new RegExp(`<a href="${issue(1)}" rel="noreferrer noopener">issue #1 ↗</a><br><span class="ph-badge ok">met</span>`));
  assert.match(predecessors, /completed, and every artifact it reported is observed delivered/);
  assert.match(predecessors, new RegExp(`<a href="/items/${met.id}">work item ${met.id.slice(0, 8)}</a> · completed · delivery merged`));

  // Each unmet variant carries the gate's own reason verbatim.
  assert.match(predecessors, /issue #2 ↗<\/a><br><span class="ph-badge ">not imported<\/span><\/span><span>no work item in this queue carries this source reference/);
  assert.match(predecessors, new RegExp(`issue #3 ↗</a><br><span class="ph-badge ">not completed</span></span><span>work item ${notCompleted.id} is proposed, not completed`));
  assert.match(predecessors, new RegExp(`issue #4 ↗</a><br><span class="ph-badge danger">cancelled</span></span><span>work item ${cancelled.id} is cancelled, not completed`));
  assert.match(
    predecessors,
    new RegExp(`issue #5 ↗</a><br><span class="ph-badge ">not delivered</span></span><span>work item ${unmerged.id} completed, but its pull request ${openPull} is observed open`),
  );
  assert.match(
    predecessors,
    new RegExp(`issue #6 ↗</a><br><span class="ph-badge ">not delivered</span></span><span>work item ${unpublished.id} completed, but its release ${releaseUrl} is observed draft`),
  );
  // Every declared reference is on the page in full, and each imported one links to its item page.
  for (const number of [1, 2, 3, 4, 5, 6]) assert.ok(predecessors.includes(issue(number)), `issue ${number} URL is shown`);
  for (const id of [notCompleted.id, cancelled.id, unmerged.id, unpublished.id]) {
    assert.ok(predecessors.includes(`/items/${id}`), `imported predecessor ${id} links to its item page`);
  }

  // What the page says is what the gate decides, entry for entry.
  assert.deepEqual(
    queue.predecessorStatuses(successor.id).map((status) => [status.sourceRef, status.satisfied, status.reason]),
    readPredecessors(queue, successor)!.entries.map((entry) => [entry.sourceRef, entry.satisfied, entry.reason]),
  );

  // An item declaring none renders no block at all (spec rule 63).
  assert.equal((await itemPage(queue, met.id)).includes('id="predecessors"'), false);
  assert.equal(body.includes("leaseToken"), false);
});

test("a queued item the gate withholds shows a predecessor chip instead of “in queue”", async (t) => {
  const harness = openQueue(t);
  const { queue } = harness;

  const predecessor = propose(harness, { sourceRef: issue(20), kind: "blocking-slice" });
  const successor = admit(harness, { sourceRef: issue(21), kind: "issue-resolution", predecessors: [issue(20)] });
  const plain = admit(harness, { sourceRef: issue(22), kind: "issue-resolution" });

  const waitingRow = (data: ReturnType<typeof readProgress>, id: string) => {
    const row = [...data.attention, ...data.repositories.flatMap((group) => group.rows)].find((candidate) => candidate.key === `item:${id}`);
    assert.ok(row, `no progress row for ${id}`);
    return row;
  };

  const gated = waitingRow(readProgress(queue), successor.id);
  assert.equal(gated.stage, "queued");
  assert.equal(gated.waiting, "waiting for predecessor issue #20 · not completed");
  assert.equal(gated.badge, undefined, "an ordinary wait is not a stop, so it stays out of the attention group");
  assert.equal(waitingRow(readProgress(queue), plain.id).waiting, "in queue", "an item declaring nothing is untouched");

  // The chip is on the page, and the plain one is not claimed to be waiting for anything.
  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue }) });
  const page = await (await app.request("/progress", { headers: { Cookie: `snowcat_session=${sessionDigest(TOKEN)}` } })).text();
  assert.match(page, /<small class="fl-waiting-chip" title="waiting for predecessor issue #20 · not completed">waiting for predecessor issue #20 · not completed/);
  assert.match(page, /<small class="fl-waiting-chip" title="in queue">in queue/);
  assert.equal(page.includes("leaseToken"), false);

  // Deliver the predecessor and the strip reverts: same derivation, new answer.
  const merged = "https://github.com/frostyard/example/pull/20";
  queue.approve(predecessor.id, "operator:test");
  const claimed = queue.claim({ worker: "claude:test:blocking", repository: REPOSITORY, kinds: ["blocking-slice"] })!;
  assert.equal(claimed.id, predecessor.id, "the seeding claim took the predecessor itself");
  queue.complete({
    id: predecessor.id,
    leaseToken: claimed.leaseToken!,
    worker: "claude:test:blocking",
    result: { summary: "Landed it.", evidence: ["npm run check"], artifacts: [{ kind: "pull-request", url: merged }] },
    followUps: [],
  });
  queue.recordArtifactVerification(predecessor.id, merged, verified({ number: 20, state: "merged", mergedAt: "2026-08-20T12:30:00.000Z" }), "policy:verify-artifacts");

  const released = waitingRow(readProgress(queue), successor.id);
  assert.equal(released.waiting, "in queue");
  assert.equal(released.badge, undefined);
  assert.equal(readPredecessors(queue, successor)!.unmet.length, 0);
});

test("two items waiting on each other are named a predecessor cycle and collected for attention", async (t) => {
  const harness = openQueue(t);
  const { queue } = harness;

  // Neither edge can ever deliver: each waits for the other (ADR-0066 — a
  // cycle is not rejected, it simply never becomes eligible).
  const first = admit(harness, { sourceRef: issue(30), kind: "issue-resolution", predecessors: [issue(31)] });
  const second = admit(harness, { sourceRef: issue(31), kind: "issue-resolution", predecessors: [issue(30)] });
  assert.equal(queue.claim({ worker: "claude:test:cycle", repository: REPOSITORY }), undefined, "the gate withholds both");

  const data = readProgress(queue);
  const attention = new Map(data.attention.map((row) => [row.key, row]));
  for (const [item, waitedOn] of [
    [first, 31],
    [second, 30],
  ] as const) {
    const row = attention.get(`item:${item.id}`);
    assert.ok(row, `the cycle member ${item.id} is in the attention group`);
    assert.deepEqual(row.badge, {
      label: "predecessor cycle",
      reason: `predecessor cycle through issue #${waitedOn} — no worker can claim this until you cancel or refile one of them`,
      tone: "amber",
    });
    assert.equal(row.waiting, `predecessor cycle · issue #${waitedOn}`);
    assert.equal(row.stage, "queued");
  }
  assert.equal(
    data.repositories.flatMap((group) => group.rows).some((row) => row.key === `item:${first.id}` || row.key === `item:${second.id}`),
    false,
    "an attention row is not repeated in its repository lane",
  );

  const page = await itemPage(queue, first.id);
  const predecessors = section(page, "predecessors");
  assert.match(predecessors, /<h2>Predecessors<\/h2><span>predecessor cycle · never claimable until you cancel or refile one of them<\/span>/);
  assert.match(predecessors, new RegExp(`issue #31 ↗</a><br><span class="ph-badge warn">predecessor cycle</span></span><span>work item ${second.id} is queued, not completed`));

  // Both members see it, and an item that names its own source reference is a cycle of one.
  const summary = readPredecessors(queue, second)!;
  assert.equal(summary.cycle, true);
  assert.equal(summary.nearest?.sourceRef, issue(30));
  const selfEdge = admit(harness, { sourceRef: issue(40), kind: "issue-resolution", predecessors: [issue(40)] });
  assert.equal(readPredecessors(queue, selfEdge)!.cycle, true);
});
