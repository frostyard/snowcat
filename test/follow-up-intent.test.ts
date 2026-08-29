import assert from "node:assert/strict";
import test from "node:test";

import { normalizeFollowUpIntent } from "../src/queue/follow-up-intent.ts";

const content = {
  kind: "quality-fix",
  objective: "Resolve the finding.",
  instructions: "Make the bounded change and verify it.",
  acceptanceCriteria: ["The finding is resolved."],
};

test("follow-up intent derives one complete contract inside the parent ceiling", () => {
  const parent = {
    delegableActions: ["read", "write", "run-tests", "open-issue", "open-pr", "create-followup"] as const,
    cure: undefined,
  };
  assert.deepEqual(normalizeFollowUpIntent(parent, { ...content, intent: "read-only" }), {
    ...content,
    allowedActions: ["read", "run-tests", "open-issue", "create-followup"],
    delegableActions: ["read", "write", "run-tests", "open-issue", "open-pr", "create-followup"],
    requiredArtifact: "none",
    executionTarget: "read-only",
  });
  assert.deepEqual(normalizeFollowUpIntent(parent, { ...content, intent: "new-pr-change" }), {
    ...content,
    allowedActions: ["read", "write", "run-tests", "open-pr", "create-followup"],
    delegableActions: ["read", "write", "run-tests", "open-issue", "open-pr", "create-followup"],
    requiredArtifact: "pull-request",
    executionTarget: "new-pull-request",
  });
});

test("intent refuses exceeded ceilings and contradictory client fields", () => {
  const parent = { delegableActions: ["read"] as const, cure: undefined };
  assert.throws(
    () => normalizeFollowUpIntent(parent, { ...content, intent: "new-pr-change" }),
    /exceeds the parent delegation ceiling: missing write, open-pr/,
  );
  assert.throws(
    () => normalizeFollowUpIntent(parent, { ...content, intent: "read-only", requiredArtifact: "pull-request" }),
    /contract mismatch: requiredArtifact must be none/,
  );
  assert.throws(
    () => normalizeFollowUpIntent(parent, { ...content, intent: "readonly" as never }),
    /follow-up intent must be one of read-only, new-pr-change, existing-pr-change/,
  );
});

test("existing-PR change intent owns its kind and requires a parent binding", () => {
  const delegation = ["read", "write", "run-tests", "open-pr"] as const;
  assert.throws(
    () => normalizeFollowUpIntent({ delegableActions: delegation, cure: undefined }, { ...content, intent: "existing-pr-change" }),
    /requires a parent cure binding/,
  );
  const normalized = normalizeFollowUpIntent(
    {
      delegableActions: delegation,
      cure: {
        pullRequestUrl: "https://github.com/frostyard/example/pull/7",
        headSha: "a".repeat(40),
        patchDigest: `sha256:${"b".repeat(64)}`,
        decay: ["dirty"],
      },
    },
    {
      intent: "existing-pr-change",
      objective: content.objective,
      instructions: content.instructions,
      acceptanceCriteria: content.acceptanceCriteria,
    },
  );
  assert.equal(normalized.kind, "pr-cure-change");
  assert.equal(normalized.executionTarget, "existing-pull-request");
});

test("legacy follow-ups remain complete explicit contracts", () => {
  const parent = { delegableActions: ["read"] as const, cure: undefined };
  assert.throws(
    () => normalizeFollowUpIntent(parent, { ...content }),
    /legacy follow-up without intent must declare allowedActions, delegableActions, requiredArtifact, executionTarget/,
  );
  assert.deepEqual(
    normalizeFollowUpIntent(parent, {
      ...content,
      allowedActions: ["read"],
      delegableActions: [],
      requiredArtifact: "none",
      executionTarget: "read-only",
    }),
    {
      ...content,
      allowedActions: ["read"],
      delegableActions: [],
      requiredArtifact: "none",
      executionTarget: "read-only",
    },
  );
});
