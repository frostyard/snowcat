import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

// policies/agent-governance.json is the surface Snowcat reads when it enrolls
// this repository, so a protected boundary that has fallen behind the code is
// not a stale comment — it is an agent being told a file is unguarded. These
// tests pin the `authentication` boundary against the tree it claims to cover
// (ADR-0063) and against docs/risk-tiers.md, which restates the same set for
// humans. Style follows test/readme.test.ts: prose and policy pinned against
// the code they describe.
const root = process.cwd();
const governance = JSON.parse(readFileSync(join(root, "policies", "agent-governance.json"), "utf8"));

// Minimal glob matcher for the two shapes the policy uses: an exact path, and
// a `dir/**` prefix. Deliberately not a full glob implementation — a new
// pattern shape should fail loudly here rather than match by accident.
function matchesPath(pattern: string, path: string): boolean {
  if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -2));
  assert.ok(!pattern.includes("*"), `unsupported glob shape in agent-governance.json: ${pattern}`);
  return path === pattern;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(relative(root, path));
  }
  return out;
}

function boundary(id: string) {
  const found = governance.protected_boundaries.find((b: { id: string }) => b.id === id);
  assert.ok(found, `agent-governance.json has no protected boundary with id "${id}"`);
  return found;
}

test("the authentication boundary stays review-required at high risk", () => {
  const auth = boundary("authentication");
  assert.equal(auth.decision, "review-required", "the authentication boundary must stay review-required");
  assert.equal(auth.minimum_risk_tier, "high", "the authentication boundary must stay at minimum_risk_tier high");
});

test("every authentication and session-authorization file is covered by a protected boundary", () => {
  const covered = governance.protected_boundaries.flatMap((b: { paths: string[] }) => b.paths);
  const guarded = [...walk(join(root, "src", "auth")), join("src", "surface", "session.ts"), join("src", "surface", "app.ts")];

  assert.ok(guarded.length > 2, "expected src/auth/ to hold at least one file besides the two surface files");
  for (const file of guarded) {
    assert.ok(
      covered.some((pattern: string) => matchesPath(pattern, file)),
      `${file} is authentication or session-authorization code but no protected boundary in policies/agent-governance.json covers it (ADR-0063)`,
    );
  }
});

test("every protected-boundary path resolves to a file that exists", () => {
  for (const b of governance.protected_boundaries) {
    for (const pattern of b.paths) {
      const target = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
      let exists = false;
      try {
        exists = statSync(join(root, target)) !== undefined;
      } catch {
        exists = false;
      }
      assert.ok(exists, `protected boundary "${b.id}" names ${pattern}, which no longer exists — a moved file leaves the boundary guarding nothing`);
    }
  }
});

test("docs/risk-tiers.md Tier 3 restates every authentication boundary path", () => {
  const tiers = readFileSync(join(root, "docs", "risk-tiers.md"), "utf8");
  const start = tiers.indexOf("## Tier 3");
  assert.ok(start >= 0, "docs/risk-tiers.md has no '## Tier 3' heading");
  const rest = tiers.slice(start + 1);
  const end = rest.indexOf("\n## ");
  const tier3 = end >= 0 ? rest.slice(0, end) : rest;

  for (const path of boundary("authentication").paths) {
    assert.ok(
      tier3.includes(`\`${path}\``),
      `docs/risk-tiers.md Tier 3 does not list ${path}, which the authentication boundary protects`,
    );
  }
});
