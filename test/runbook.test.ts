import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// The operator runbook described the surface as read-only and the board's
// repository buttons as CLI-only long after both stopped being true — and it
// contradicted its own "Repository actions" paragraph fifteen lines later. A
// runbook that is wrong about what an operator can do from the browser sends
// them to the CLI for work the surface already does, so these phrases are
// pinned out. Style follows test/readme.test.ts: prose asserted against the
// behavior it describes.
const runbook = readFileSync(join(process.cwd(), "docs", "design", "queue-operations.md"), "utf8");

test("the runbook does not call the operator surface read-only or its repository actions CLI-only", () => {
  assert.doesNotMatch(
    runbook,
    /read-only for now/i,
    'docs/design/queue-operations.md calls the operator surface "read-only for now"; it carries attributed operator mutations',
  );
  assert.doesNotMatch(
    runbook,
    /CLI-only for now/i,
    'docs/design/queue-operations.md calls a board action "CLI-only for now"; the Repository actions strip runs from the browser as operator:web',
  );
});

test("the runbook names every Repository actions button as a browser action", () => {
  for (const action of ["Import issues", "Seed dogfood", "Verify artifacts", "Hold"]) {
    assert.ok(
      runbook.includes(action),
      `docs/design/queue-operations.md no longer names ${action}, one of the board's Repository actions`,
    );
  }
  // The strip itself must still be described as running as operator:web, so
  // dropping the paragraph cannot leave the button names passing on their own.
  assert.match(
    runbook,
    /\*Repository actions\* strip[\s\S]{0,200}operator:web/,
    "docs/design/queue-operations.md no longer describes the Repository actions strip as running as operator:web",
  );
});

test("the runbook describes the default bounded events query as the first 100 in ascending order", () => {
  assert.match(
    runbook,
    /events --repository frostyard\/updex\s+# first\/oldest 100 after sequence 0, ascending by sequence/,
    "docs/design/queue-operations.md must describe the default --since 0 query as the first/oldest 100 matching events in ascending sequence order",
  );
  assert.doesNotMatch(
    runbook,
    /newest 100/i,
    'docs/design/queue-operations.md must not claim the default bounded events query returns the "newest 100"',
  );
});
