import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createApp } from "../src/app.ts";
import { QueueStore } from "../src/queue/store.ts";
import { sessionDigest } from "../src/surface/session.ts";

const TOKEN = "inbox-ready-test-token";

function section(body: string, id: string): string {
  const match = new RegExp(`<(?:section|aside) class="fl-group[^"]*" id="${id}">.*?</(?:section|aside)>`, "s").exec(body);
  assert.ok(match, `section ${id} present`);
  return match[0];
}

/**
 * Reports an item, opens a review round, and completes it with the given
 * verdict against the given head; returns the origin and review item ids.
 */
function reportAndReview(
  queue: QueueStore,
  options: {
    repository: string;
    prNumber: number;
    head: string;
    draft: boolean;
    state?: "open" | "merged";
    decision?: "pass" | "block";
    blockers?: Array<{ fingerprint: string; location: string; contract: string; impact: string; resolution: string; verification: string }>;
    reviewerModel?: string;
  },
) {
  const url = `https://github.com/${options.repository}/pull/${options.prNumber}`;
  const seed = queue.enqueueSeed({
    repository: options.repository,
    kind: "issue-resolution",
    objective: `Resolve ${options.repository}#${options.prNumber}0: fixture ${options.prNumber}`,
    instructions: "Open a pull request.",
    acceptanceCriteria: ["PR open."],
    allowedActions: ["read", "write", "open-pr"],
    delegableActions: [],
    requiredArtifact: "pull-request",
    executionTarget: "new-pull-request",
    createdBy: "operator:test",
  });
  const lease = queue.claim({ worker: `claude:fixture:${options.prNumber}`, repository: options.repository, kinds: ["issue-resolution"] })!;
  queue.complete({
    id: seed.id,
    leaseToken: lease.leaseToken!,
    worker: `claude:fixture:${options.prNumber}`,
    result: {
      summary: "Opened the pull request.",
      evidence: ["npm run check passed."],
      artifacts: [
        {
          kind: "pull-request",
          url,
          verification: {
            status: "verified",
            verifiedAt: new Date().toISOString(),
            number: options.prNumber,
            state: options.state ?? "open",
            headSha: options.head,
            draft: options.draft,
          },
        },
      ],
      model: "claude-sonnet-5",
    },
    followUps: [],
  });
  if (options.decision === undefined) return { seed, url };
  const review = queue.enqueueReviewRoot(options.repository, {
    kind: "pr-review",
    objective: `Review ${options.repository}#${options.prNumber} (head ${options.head}, round 1 of 3)`,
    instructions: "Read-only.",
    acceptanceCriteria: ["Verdict supplied."],
    allowedActions: ["read", "run-tests"],
    delegableActions: [],
    executionTarget: "read-only",
    createdBy: "policy:review-gate",
    sourceRef: `pr-review:${url}@${options.head}`,
    review: { pullRequestUrl: url, headSha: options.head, round: 1, originItemId: seed.id, authorModel: "claude-sonnet-5", priorBlockers: [] },
  })!;
  const reviewer = queue.claim({ worker: `claude:fixture:${options.prNumber}:reviewer`, repository: options.repository, kinds: ["pr-review"] })!;
  queue.complete({
    id: review.id,
    leaseToken: reviewer.leaseToken!,
    worker: `claude:fixture:${options.prNumber}:reviewer`,
    result: { summary: options.decision === "pass" ? "Passes." : "Blocked.", evidence: [`head ${options.head}`], artifacts: [], model: options.reviewerModel ?? "claude-opus-5" },
    followUps: [],
    review: { decision: options.decision, blockers: options.blockers ?? [], advisories: [] },
  });
  return { seed, url, review };
}

test("the inbox's Ready to merge rail lists a passed draft to mark ready and a passed non-draft to queue for merge, and excludes in-flight review, description blockers, and merged pull requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-inbox-ready-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/alpha", true);
  queue.setRepositoryReviewGate("frostyard/alpha", true);
  queue.setRepositoryEnabled("frostyard/beta", true);
  queue.setRepositoryReviewGate("frostyard/beta", true);

  // (a) A draft with a completed pass round for its current head → mark ready.
  // (Whether the sweep's own attempt to auto-mark it ready stopped at a
  // protected boundary or was never attempted with writes off, the stored
  // state is the same: a passed round, still a draft.)
  const headA = "a".repeat(40);
  const { review: reviewA } = reportAndReview(queue, { repository: "frostyard/alpha", prNumber: 10, head: headA, draft: true, decision: "pass", reviewerModel: "claude-opus-5" });

  // (d) A draft with a description blocker → not listed here (still on adjudication).
  const headD = "d".repeat(40);
  reportAndReview(queue, {
    repository: "frostyard/alpha",
    prNumber: 12,
    head: headD,
    draft: true,
    decision: "block",
    blockers: [
      {
        fingerprint: "contract:pr-body:missing-risk-tier",
        location: "the pull request description",
        contract: "the template's Risk tier section",
        impact: "a human cannot judge the change's blast radius",
        resolution: "add the Risk tier section",
        verification: "re-read the description",
      },
    ],
  });

  // (b) A non-draft, verified, open pull request with a pass verdict for its
  // current head → queue for merge.
  const headB = "b".repeat(40);
  reportAndReview(queue, { repository: "frostyard/beta", prNumber: 20, head: headB, draft: false, decision: "pass", reviewerModel: "claude-sonnet-5" });

  // (e) A merged pull request → not listed.
  const headE = "e".repeat(40);
  reportAndReview(queue, { repository: "frostyard/beta", prNumber: 21, head: headE, draft: false, state: "merged" });

  // (c) A draft with an in-flight pr-review (queued, not completed) → not
  // listed. Created last: it stays queued forever, so an earlier position
  // would leave it the oldest queued `pr-review` root in this repository and
  // liable to be claimed by a later fixture's own review step above.
  const headC = "c".repeat(40);
  const { url: urlC, seed: seedC } = reportAndReview(queue, { repository: "frostyard/alpha", prNumber: 11, head: headC, draft: true });
  queue.enqueueReviewRoot("frostyard/alpha", {
    kind: "pr-review",
    objective: "Review frostyard/alpha#11 (head cccccccc, round 1 of 3)",
    instructions: "Read-only.",
    acceptanceCriteria: ["Verdict supplied."],
    allowedActions: ["read", "run-tests"],
    delegableActions: [],
    executionTarget: "read-only",
    createdBy: "policy:review-gate",
    sourceRef: `pr-review:${urlC}@${headC}`,
    review: { pullRequestUrl: urlC, headSha: headC, round: 1, originItemId: seedC.id, authorModel: "claude-sonnet-5", priorBlockers: [] },
  });

  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue }) });
  const cookie = `snowcat_session=${sessionDigest(TOKEN)}`;

  const inbox = await app.request("/", { headers: { Cookie: cookie } });
  assert.equal(inbox.status, 200);
  const body = await inbox.text();
  assert.match(body, /<span>Ready to merge<\/span><strong>2<\/strong>/, "only the two passed pull requests count");

  const rail = section(body, "readyToMerge");
  assert.match(rail, /Ready to merge/);

  // (a): mark ready, with the gh pr ready hint scoped to its repository.
  assert.match(rail, /<a href="https:\/\/github\.com\/frostyard\/alpha\/pull\/10" rel="noreferrer noopener">#10<\/a>/);
  assert.match(rail, /<span class="ph-badge ok">mark ready<\/span> <code>gh pr ready 10 --repo frostyard\/alpha<\/code>/);
  assert.match(rail, /passed round 1 \(claude-opus-5\)/);
  assert.match(rail, new RegExp(`href="/items/${reviewA!.id}">Open pr-review</a>`));

  // (b): queue for merge.
  assert.match(rail, /<a href="https:\/\/github\.com\/frostyard\/beta\/pull\/20" rel="noreferrer noopener">#20<\/a>/);
  assert.match(rail, /<span class="ph-badge ok">queue for merge<\/span> add it to the merge queue/);
  assert.match(rail, /passed round 1 \(claude-sonnet-5\)/);

  // (c), (d), (e) excluded.
  assert.equal(rail.includes("pull/11"), false, "in-flight review is not ready");
  assert.equal(rail.includes("pull/12"), false, "a description blocker stays on adjudication");
  assert.equal(rail.includes("pull/21"), false, "a merged pull request is not ready");

  // (d) still appears on the adjudication rail as a needs-human problem.
  const adjudication = section(body, "adjudication");
  assert.match(adjudication, /pull\/12/);

  const partial = await app.request("/?partial=readyToMerge", { headers: { Cookie: cookie } });
  assert.equal(partial.status, 200);
  assert.match(await partial.text(), /^<section class="fl-group" id="readyToMerge">/);
});

test("the Ready to merge rail queues a non-draft pull request for merge when the repository has no review gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-inbox-ready-ungated-test-"));
  const queue = new QueueStore(join(directory, "queue.db"));
  test.after(() => queue.close());
  queue.setRepositoryEnabled("frostyard/gamma", true);

  const head = "f".repeat(40);
  reportAndReview(queue, { repository: "frostyard/gamma", prNumber: 30, head, draft: false });

  const app = createApp({ appToken: TOKEN, surfaceStores: () => ({ queue }) });
  const cookie = `snowcat_session=${sessionDigest(TOKEN)}`;
  const inbox = await app.request("/", { headers: { Cookie: cookie } });
  const body = await inbox.text();
  assert.match(body, /<span>Ready to merge<\/span><strong>1<\/strong>/);
  const rail = section(body, "readyToMerge");
  assert.match(rail, /<span class="ph-badge ok">queue for merge<\/span> add it to the merge queue/);
  assert.match(rail, /review gate off/);
});
