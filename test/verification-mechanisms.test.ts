import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateConclusiveRunRate,
  VerificationMechanismInputError,
} from "../src/verification/conclusive-run-rate.ts";
import {
  supportsVerificationEvaluator,
  supportsVerificationSourceAdapter,
  verificationEvaluator,
} from "../src/verification/registry.ts";

const occurrences = (conclusive: number, inconclusive: number, missing: number) => [
  ...Array.from({ length: conclusive }, (_, index) => ({
    key: `conclusive:${index}`,
    classification: "conclusive" as const,
  })),
  ...Array.from({ length: inconclusive }, (_, index) => ({
    key: `inconclusive:${index}`,
    classification: "inconclusive" as const,
  })),
  ...Array.from({ length: missing }, (_, index) => ({
    key: `missing:${index}`,
    classification: "missing" as const,
  })),
];

test("the registry exposes only callable implemented verification mechanisms", () => {
  assert.equal(supportsVerificationEvaluator("conclusive-run-rate:v1"), true);
  assert.equal(supportsVerificationSourceAdapter("github-check-runs:v1"), false);
  assert.equal(verificationEvaluator("not-implemented:v1"), undefined);

  const evaluator = verificationEvaluator("conclusive-run-rate:v1");
  assert.equal(evaluator?.id, "conclusive-run-rate");
  assert.equal(evaluator?.version, 1);
  assert.equal(
    evaluator?.evaluate({
      minimumRate: 0.95,
      windowState: "closed",
      sourceCoverage: "complete",
      occurrences: occurrences(19, 0, 1),
    }).outcome,
    "satisfied",
  );
});

test("conclusive-run-rate compares the unrounded integer ratio with its threshold", () => {
  assert.deepEqual(
    evaluateConclusiveRunRate({
      minimumRate: 0.95,
      windowState: "closed",
      sourceCoverage: "complete",
      occurrences: occurrences(19, 0, 1),
    }),
    {
      outcome: "satisfied",
      reason: "threshold-met",
      minimumRate: 0.95,
      counts: { conclusive: 19, inconclusive: 0, missing: 1, total: 20 },
      rate: { numerator: 19, denominator: 20 },
    },
  );
  assert.equal(
    evaluateConclusiveRunRate({
      minimumRate: 0.95,
      windowState: "closed",
      sourceCoverage: "complete",
      occurrences: occurrences(18, 1, 1),
    }).outcome,
    "failed",
  );
  assert.equal(
    evaluateConclusiveRunRate({
      minimumRate: 0.6666666666666667,
      windowState: "closed",
      sourceCoverage: "complete",
      occurrences: occurrences(2, 1, 0),
    }).outcome,
    "failed",
  );
});

test("open windows, incomplete coverage, and empty populations are unable", () => {
  for (const expected of [
    { windowState: "open", sourceCoverage: "complete", values: occurrences(1, 0, 0), reason: "window-open" },
    {
      windowState: "closed",
      sourceCoverage: "incomplete",
      values: occurrences(1, 0, 0),
      reason: "source-incomplete",
    },
    { windowState: "closed", sourceCoverage: "complete", values: [], reason: "population-empty" },
  ] as const) {
    const result = evaluateConclusiveRunRate({
      minimumRate: 0.95,
      windowState: expected.windowState,
      sourceCoverage: expected.sourceCoverage,
      occurrences: expected.values,
    });
    assert.equal(result.outcome, "unable");
    assert.equal(result.reason, expected.reason);
    assert.equal(result.rate, null);
  }
});

test("malformed or duplicate evidence populations violate the evaluator contract", () => {
  assert.throws(
    () =>
      evaluateConclusiveRunRate({
        minimumRate: 0.95,
        windowState: "closed",
        sourceCoverage: "complete",
        occurrences: [
          { key: "same", classification: "conclusive" },
          { key: "same", classification: "missing" },
        ],
      }),
    (error) =>
      error instanceof VerificationMechanismInputError && /duplicate occurrence key/.test(error.message),
  );
  assert.throws(
    () =>
      evaluateConclusiveRunRate({
        minimumRate: Number.NaN,
        windowState: "closed",
        sourceCoverage: "complete",
        occurrences: [],
      }),
    VerificationMechanismInputError,
  );
});
