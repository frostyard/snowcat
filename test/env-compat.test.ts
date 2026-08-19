import assert from "node:assert/strict";
import test from "node:test";

import { adoptLegacyEnvironment } from "../src/env-compat.ts";

test("adoptLegacyEnvironment copies FLUENT_* to unset SNOWCAT_* twins, never overrides, and says so once", () => {
  const warnings: string[] = [];
  const env: NodeJS.ProcessEnv = {
    FLUENT_QUEUE_DB: "/legacy/queue.db",
    FLUENT_CONTROL_DB: "/legacy/control.db",
    SNOWCAT_CONTROL_DB: "/new/control.db",
    OTHER: "x",
  };
  const adopted = adoptLegacyEnvironment(env, (line) => warnings.push(line));
  assert.deepEqual(adopted, ["FLUENT_QUEUE_DB"]);
  assert.equal(env.SNOWCAT_QUEUE_DB, "/legacy/queue.db");
  assert.equal(env.SNOWCAT_CONTROL_DB, "/new/control.db", "an explicit SNOWCAT_* wins");
  assert.equal(env.OTHER, "x");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /adopted legacy FLUENT_QUEUE_DB; rename to SNOWCAT_\*/);
  assert.deepEqual(adoptLegacyEnvironment({ SNOWCAT_QUEUE_DB: "/x" }, (line) => warnings.push(line)), []);
  assert.equal(warnings.length, 1, "nothing to adopt, nothing said");
});
