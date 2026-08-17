export const runEvidenceClassifications = ["conclusive", "inconclusive", "missing"] as const;

export type RunEvidenceClassification = (typeof runEvidenceClassifications)[number];

export interface RunEvidenceOccurrence {
  key: string;
  classification: RunEvidenceClassification;
}

export interface ConclusiveRunRateInput {
  minimumRate: number;
  windowState: "open" | "closed";
  sourceCoverage: "complete" | "incomplete";
  occurrences: readonly RunEvidenceOccurrence[];
}

export type ConclusiveRunRateReason =
  | "threshold-met"
  | "threshold-not-met"
  | "window-open"
  | "source-incomplete"
  | "population-empty";

export interface ConclusiveRunRateResult {
  outcome: "satisfied" | "failed" | "unable";
  reason: ConclusiveRunRateReason;
  minimumRate: number;
  counts: {
    conclusive: number;
    inconclusive: number;
    missing: number;
    total: number;
  };
  rate: { numerator: number; denominator: number } | null;
}

export class VerificationMechanismInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationMechanismInputError";
  }
}

export function evaluateConclusiveRunRate(input: unknown): ConclusiveRunRateResult {
  const normalized = assertInput(input);
  const counts = {
    conclusive: 0,
    inconclusive: 0,
    missing: 0,
    total: normalized.occurrences.length,
  };
  for (const occurrence of normalized.occurrences) counts[occurrence.classification] += 1;

  const unable = (reason: Extract<ConclusiveRunRateReason, `${string}-${"open" | "incomplete" | "empty"}`>) => ({
    outcome: "unable" as const,
    reason,
    minimumRate: normalized.minimumRate,
    counts,
    rate: null,
  });
  if (normalized.windowState === "open") return unable("window-open");
  if (normalized.sourceCoverage === "incomplete") return unable("source-incomplete");
  if (counts.total === 0) return unable("population-empty");

  const rate = { numerator: counts.conclusive, denominator: counts.total };
  if (ratioMeetsMinimum(rate.numerator, rate.denominator, normalized.minimumRate)) {
    return {
      outcome: "satisfied",
      reason: "threshold-met",
      minimumRate: normalized.minimumRate,
      counts,
      rate,
    };
  }
  return {
    outcome: "failed",
    reason: "threshold-not-met",
    minimumRate: normalized.minimumRate,
    counts,
    rate,
  };
}

function assertInput(input: unknown): ConclusiveRunRateInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new VerificationMechanismInputError("conclusive-run-rate input must be an object");
  }
  const candidate = input as Record<string, unknown>;
  if (
    typeof candidate.minimumRate !== "number" ||
    !Number.isFinite(candidate.minimumRate) ||
    candidate.minimumRate < 0 ||
    candidate.minimumRate > 1
  ) {
    throw new VerificationMechanismInputError("minimumRate must be a finite number between zero and one");
  }
  if (candidate.windowState !== "open" && candidate.windowState !== "closed") {
    throw new VerificationMechanismInputError("windowState must be open or closed");
  }
  if (candidate.sourceCoverage !== "complete" && candidate.sourceCoverage !== "incomplete") {
    throw new VerificationMechanismInputError("sourceCoverage must be complete or incomplete");
  }
  if (!Array.isArray(candidate.occurrences)) {
    throw new VerificationMechanismInputError("occurrences must be an array");
  }
  const keys = new Set<string>();
  const occurrences: RunEvidenceOccurrence[] = [];
  for (const [index, value] of candidate.occurrences.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new VerificationMechanismInputError(`occurrences[${index}] must be an object`);
    }
    const occurrence = value as Record<string, unknown>;
    if (
      typeof occurrence.key !== "string" ||
      occurrence.key.length < 1 ||
      occurrence.key.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(occurrence.key)
    ) {
      throw new VerificationMechanismInputError(
        `occurrences[${index}].key must be a bounded non-control string`,
      );
    }
    if (keys.has(occurrence.key)) {
      throw new VerificationMechanismInputError(`duplicate occurrence key: ${occurrence.key}`);
    }
    if (
      occurrence.classification !== "conclusive" &&
      occurrence.classification !== "inconclusive" &&
      occurrence.classification !== "missing"
    ) {
      throw new VerificationMechanismInputError(
        `occurrences[${index}].classification is not registered`,
      );
    }
    keys.add(occurrence.key);
    occurrences.push({ key: occurrence.key, classification: occurrence.classification });
  }
  return {
    minimumRate: candidate.minimumRate,
    windowState: candidate.windowState,
    sourceCoverage: candidate.sourceCoverage,
    occurrences,
  };
}

function ratioMeetsMinimum(numerator: number, denominator: number, minimumRate: number): boolean {
  const [minimumNumerator, minimumDenominator] = decimalFraction(minimumRate);
  return BigInt(numerator) * minimumDenominator >= BigInt(denominator) * minimumNumerator;
}

function decimalFraction(value: number): readonly [bigint, bigint] {
  const [coefficient, exponentText] = value.toString().toLowerCase().split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole, fraction = ""] = coefficient!.split(".");
  const digits = BigInt(`${whole}${fraction}`);
  const scale = fraction.length - exponent;
  if (scale <= 0) return [digits * 10n ** BigInt(-scale), 1n];
  return [digits, 10n ** BigInt(scale)];
}
