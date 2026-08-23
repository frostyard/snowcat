import assert from "node:assert/strict";
import test from "node:test";

import { conventionalCommitTypes, lintPullRequestTitle } from "../src/queue/pr-title-lint.ts";

test("a Conventional Commits title, with or without a scope, passes", () => {
  assert.deepEqual(lintPullRequestTitle("feat(queue): add title lint"), { ok: true });
  assert.deepEqual(lintPullRequestTitle("docs: fix stale claim"), { ok: true });
  for (const type of conventionalCommitTypes) {
    assert.equal(lintPullRequestTitle(`${type}: something`).ok, true, `type ${type} should pass`);
  }
});

test("a title with no Conventional Commits type, an empty title, or an unknown type fails with a reason", () => {
  const noType = lintPullRequestTitle("add title lint");
  assert.equal(noType.ok, false);
  if (!noType.ok) assert.match(noType.reason, /does not match Conventional Commits format/);

  const empty = lintPullRequestTitle("   ");
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(empty.reason, /empty/);

  const unknownType = lintPullRequestTitle("feature(queue): add title lint");
  assert.equal(unknownType.ok, false);
});
