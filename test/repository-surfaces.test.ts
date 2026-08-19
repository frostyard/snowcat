import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
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

// The ADR-0002 agent-portable instruction surface: one canonical AGENTS.md
// with every vendor-specific entry point a relative symlink to it, and one
// real .agents/skills/ directory that .claude/skills aliases. Pinned here so
// `npm run check` fails when a sync, a rebase, or a tool that rewrites
// symlinks as regular files turns an alias back into a copy — the failure
// mode ADR-0002 exists to prevent, since a copy silently stops tracking the
// canonical file.
const INSTRUCTION_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["CLAUDE.md", "AGENTS.md"],
  ["GEMINI.md", "AGENTS.md"],
  [".github/copilot-instructions.md", "../AGENTS.md"],
];

for (const [alias, target] of INSTRUCTION_ALIASES) {
  test(`${alias} is a relative symlink to ${target}`, () => {
    const path = join(root, alias);
    assert.ok(lstatSync(path).isSymbolicLink(), `${alias} must be a symlink to ${target}, not a regular file`);
    assert.equal(readlinkSync(path), target, `${alias} must point at ${target}`);
  });
}

test(".claude/skills is a relative symlink to ../.agents/skills", () => {
  const path = join(root, ".claude", "skills");
  assert.ok(lstatSync(path).isSymbolicLink(), ".claude/skills must be a symlink to ../.agents/skills, not a real directory");
  assert.equal(readlinkSync(path), "../.agents/skills", ".claude/skills must point at ../.agents/skills");
});

test("AGENTS.md is the canonical real file the instruction aliases resolve to", () => {
  const path = join(root, "AGENTS.md");
  assert.ok(!lstatSync(path).isSymbolicLink(), "AGENTS.md must be a real file, not a symlink");
  assert.ok(statSync(path).isFile(), "AGENTS.md must be a regular file");
});

test(".agents/skills is a real directory holding at least one <skill>/SKILL.md", () => {
  const path = join(root, ".agents", "skills");
  assert.ok(!lstatSync(path).isSymbolicLink(), ".agents/skills must be a real directory, not a symlink");
  assert.ok(statSync(path).isDirectory(), ".agents/skills must be a directory");
  const skills = readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => existsSync(join(path, entry.name, "SKILL.md")));
  assert.ok(skills.length >= 1, ".agents/skills must contain at least one <skill>/SKILL.md");
});
