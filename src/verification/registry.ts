import {
  evaluateConclusiveRunRate,
  type ConclusiveRunRateResult,
} from "./conclusive-run-rate.ts";

export interface VerificationEvaluatorImplementation {
  id: string;
  version: number;
  evaluate: (input: unknown) => ConclusiveRunRateResult;
}

const evaluatorImplementations = {
  "conclusive-run-rate:v1": {
    id: "conclusive-run-rate",
    version: 1,
    evaluate: evaluateConclusiveRunRate,
  },
} as const satisfies Record<string, VerificationEvaluatorImplementation>;

const sourceAdapterKeys = new Set<string>();
const attestationPolicyKeys = new Set<string>();

export function supportsVerificationEvaluator(key: string): boolean {
  return Object.hasOwn(evaluatorImplementations, key);
}

export function verificationEvaluator(key: string): VerificationEvaluatorImplementation | undefined {
  if (!supportsVerificationEvaluator(key)) return undefined;
  return evaluatorImplementations[key as keyof typeof evaluatorImplementations];
}

export function supportsVerificationSourceAdapter(key: string): boolean {
  return sourceAdapterKeys.has(key);
}

export function supportsVerificationAttestationPolicy(key: string): boolean {
  return attestationPolicyKeys.has(key);
}
