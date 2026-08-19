import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// core's repository-agent-governance schema v1 fixes the risk scale as a
// const, so the tier list is not this repository's to shorten. Three surfaces
// publish it — the policy itself, the doc operators classify against, and the
// checkbox list every pull request fills in — and they drifted apart once
// already: the policy carried four tiers while the doc and the template
// offered three, so no pull request could ever declare the critical tier the
// schema requires. core ADR-0019 names an in-repo test as the mitigation for
// exactly that drift. Style follows test/repository-surfaces.test.ts.
const root = process.cwd();
const governance = JSON.parse(readFileSync(join(root, "policies", "agent-governance.json"), "utf8"));
const tiers: string[] = governance.risk_classification.tiers;

const RISK_TIERS = readFileSync(join(root, "docs", "risk-tiers.md"), "utf8");
const PR_TEMPLATE = readFileSync(join(root, ".github", "pull_request_template.md"), "utf8");

const titleCase = (tier: string) => tier[0]!.toUpperCase() + tier.slice(1);

test("the governance policy still fixes the four-tier scale core's schema requires", () => {
  assert.equal(governance.schema_version, 1, "policies/agent-governance.json schema_version must be 1");
  assert.equal(governance.default_decision, "deny", "policies/agent-governance.json default_decision must be deny");
  assert.deepEqual(tiers, ["low", "moderate", "high", "critical"], "risk_classification.tiers must be the schema's fixed four-tier scale");
});

test("docs/risk-tiers.md publishes exactly the policy's tiers, in order", () => {
  tiers.forEach((tier, index) => {
    const name = titleCase(tier);
    const headings = RISK_TIERS.match(new RegExp(`^## Tier \\d+: ${name}$`, "gm")) ?? [];
    assert.equal(headings.length, 1, `docs/risk-tiers.md must have exactly one "## Tier N: ${name}" heading, found ${headings.length}`);
    assert.equal(headings[0], `## Tier ${index + 1}: ${name}`, `docs/risk-tiers.md numbers ${name} wrongly: ${headings[0]}`);
  });

  // No stray tier beyond the policy's, so adding one here also fails.
  const all = RISK_TIERS.match(/^## Tier \d+: .+$/gm) ?? [];
  assert.equal(all.length, tiers.length, `docs/risk-tiers.md has ${all.length} tier headings but the policy names ${tiers.length}: ${all.join(", ")}`);
});

test(".github/pull_request_template.md offers exactly the policy's tiers, in order", () => {
  tiers.forEach((tier, index) => {
    const name = titleCase(tier);
    const boxes = PR_TEMPLATE.match(new RegExp(`^- \\[ \\] Tier \\d+: ${name}$`, "gm")) ?? [];
    assert.equal(boxes.length, 1, `.github/pull_request_template.md must have exactly one "- [ ] Tier N: ${name}" checkbox, found ${boxes.length}`);
    assert.equal(boxes[0], `- [ ] Tier ${index + 1}: ${name}`, `.github/pull_request_template.md numbers ${name} wrongly: ${boxes[0]}`);
  });

  const all = PR_TEMPLATE.match(/^- \[ \] Tier \d+: .+$/gm) ?? [];
  assert.equal(all.length, tiers.length, `.github/pull_request_template.md has ${all.length} tier checkboxes but the policy names ${tiers.length}: ${all.join(", ")}`);
});
