import assert from "node:assert/strict";
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// The agent-knowledge surfaces core ADR-0018 requires of every frostyard
// repository (bound here by docs/org-adrs.md): a `.cursorrules` alias of the
// canonical AGENTS.md, the `.memory/` corrections inbox with its five-field
// append-only contract, and at least one task-shaped runbook under
// `.github/prompts/`. Checked against the repository root so `npm run check`
// fails when one is removed or its shape drifts.
const root = process.cwd();
const CORRECTION_KEYS = "correction,date,evidence,promoted_to,scope";

test(".cursorrules is a relative symlink to the canonical AGENTS.md", () => {
  const path = join(root, ".cursorrules");
  assert.ok(lstatSync(path).isSymbolicLink(), ".cursorrules must be a symlink, not a regular file");
  assert.equal(readlinkSync(path), "AGENTS.md");
});

test(".memory/ carries the inbox contract and a well-formed append-only corrections.jsonl", () => {
  assert.ok(statSync(join(root, ".memory", "README.md")).isFile(), ".memory/README.md must exist");
  const lines = readFileSync(join(root, ".memory", "corrections.jsonl"), "utf8").split("\n").filter(Boolean);
  assert.ok(lines.length >= 1, "corrections.jsonl must hold at least one correction");
  for (const [index, line] of lines.entries()) {
    const parsed: unknown = JSON.parse(line);
    assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed), `line ${index + 1} is not a JSON object`);
    assert.equal(Object.keys(parsed as object).sort().join(","), CORRECTION_KEYS, `line ${index + 1} does not carry exactly the five fields`);
  }
});

test(".github/prompts/ holds at least one task-shaped runbook", () => {
  const prompts = readdirSync(join(root, ".github", "prompts")).filter((name) => name.endsWith(".prompt.md"));
  assert.ok(prompts.length >= 1, ".github/prompts/ must contain at least one *.prompt.md runbook");
  assert.ok(statSync(join(root, ".github", "prompts", "README.md")).isFile(), ".github/prompts/README.md must exist");
});
