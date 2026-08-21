import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const skillPath = join(root, ".agents", "skills", "work-snowcat-without-reviews", "SKILL.md");

test("the no-review queue skill filters before one claim and delegates the lifecycle", () => {
  const skill = readFileSync(skillPath, "utf8");
  const normalized = skill.replace(/\s+/g, " ");
  assert.match(skill, /^---\nname: work-snowcat-without-reviews\ndescription: Use when /);
  assert.match(normalized, /`list_work` with `status: "queued"`, `limit: 100`/);
  assert.match(normalized, /excluding only the exact kind `pr-review`/);
  assert.match(normalized, /Do not use a fixed kind whitelist/);
  assert.match(normalized, /Call `claim_work` exactly once with `kinds` set to that array/);
  assert.match(normalized, /`pr-review-fix`/);
  assert.match(normalized, /future non-review kind/);
  assert.match(normalized, /\*\*REQUIRED SUB-SKILL:\*\* Use `work-snowcat-queue`/);
  assert.doesNotMatch(skill, /## Review a pull request/);
});

test("AGENTS.md advertises the no-review queue skill", () => {
  const agents = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.match(agents, /\.agents\/skills\/work-snowcat-without-reviews\/SKILL\.md/);
});
