import assert from "node:assert/strict";
import test from "node:test";

import {
  CORE_CHECK_DETAIL_MAXIMUM_ELIGIBLE_CHECKS,
  coreCheckDetailCutoff,
  selectCoreCheckDetailForPrune,
} from "../src/control/check-detail-retention.ts";

test("check-detail selection applies the 30-day window and 10,000 eligible-check cap", () => {
  const evaluatedAt = "2026-08-16T12:00:00.000Z";
  const cutoffAt = coreCheckDetailCutoff(evaluatedAt);
  assert.equal(cutoffAt, "2026-07-17T12:00:00.000Z");

  const protectedCheckId = "protected";
  const candidates = Array.from(
    { length: CORE_CHECK_DETAIL_MAXIMUM_ELIGIBLE_CHECKS + 3 },
    (_, index) => ({
      sequence: index + 1,
      recordedAt: "2026-08-01T00:00:00.000Z",
      checkId: index === 0 ? protectedCheckId : `check-${index}`,
    }),
  );
  candidates.push({ sequence: candidates.length + 1, recordedAt: "2026-06-01T00:00:00.000Z", checkId: "expired" });

  const selected = selectCoreCheckDetailForPrune(candidates, new Set([protectedCheckId]), cutoffAt);
  assert.deepEqual(
    selected.map((candidate) => candidate.checkId),
    ["check-1", "check-2", "expired"],
  );
});
