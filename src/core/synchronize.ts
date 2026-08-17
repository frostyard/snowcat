import {
  CoreCandidateInspectionError,
  CoreSourceContinuityError,
  inspectCoreCandidate,
  verifyCoreSourceContinuity,
  type CoreGitSourceConfig,
  type InspectedCoreCandidate,
} from "./git-source.ts";
import {
  ControlPlaneStore,
  CoreSnapshotPersistenceError,
  type CoreCandidateRejectionInput,
  type CoreCandidateRejectionResult,
  type CorePollCheckDisposition,
  type CoreSnapshotActivationResult,
  type CoreSourceCheckEligibleResult,
  type CoreSourceCheckOutcome,
} from "../control/store.ts";
import { uuidV7 } from "../control/encoding.ts";
import { assertRepositoryDeclarationRetention, CoreValidationError } from "./validator.ts";

interface CoreSynchronizationBase {
  outcome: CoreSourceCheckOutcome;
  checkDisposition: Exclude<CorePollCheckDisposition, "none">;
  checkId: string;
  rejectionResult: CoreCandidateRejectionResult | null;
  diagnosticError: Error | null;
}

export interface CoreSynchronizationAccepted extends CoreSynchronizationBase {
  status: "accepted";
  outcome: "eligible";
  activation: "activated" | "unchanged";
  activationResult: CoreSnapshotActivationResult | null;
  sourceCheck: CoreSourceCheckEligibleResult;
  failure: null;
}

export interface CoreSynchronizationRejected extends CoreSynchronizationBase {
  status: "rejected";
  outcome: Exclude<CoreSourceCheckOutcome, "eligible">;
  activation: null;
  activationResult: null;
  sourceCheck: null;
  failure: Error;
}

export type CoreSynchronizationResult = CoreSynchronizationAccepted | CoreSynchronizationRejected;

export interface CoreSynchronizationAdapters {
  inspectCandidate?: typeof inspectCoreCandidate;
  verifyContinuity?: typeof verifyCoreSourceContinuity;
}

export async function synchronizeCoreSource(
  config: CoreGitSourceConfig,
  store: ControlPlaneStore,
  expectedLastTransactionSequence: number,
  adapters: CoreSynchronizationAdapters = {},
): Promise<CoreSynchronizationResult> {
  const inspectCandidate = adapters.inspectCandidate ?? inspectCoreCandidate;
  const verifyContinuity = adapters.verifyContinuity ?? verifyCoreSourceContinuity;
  const checkId = uuidV7();
  let candidate: InspectedCoreCandidate;
  try {
    candidate = await inspectCandidate(config);
  } catch (error) {
    if (!(error instanceof CoreCandidateInspectionError)) throw error;
    return rejectedResult(
      store,
      {
        checkId,
        operation: "automatic-source-check",
        stage: error.stage,
        code: error.code,
        summary: sanitizeCoreDiagnostic(error.message),
        details: error.details.slice(0, 8).map(sanitizeCoreDiagnostic),
        sourceUrl: error.sourceUrl,
        sourceRef: error.ref,
        commitId: error.commitId,
        treeId: error.treeId,
      },
      error.stage === "source" ? "source-unavailable" : "candidate-invalid",
      error,
    );
  }

  const active = store.activeCoreSnapshot();
  if (active) {
    const activeCandidate = store.retainedCoreCandidate(active.sourceCommitId);
    if (!activeCandidate) throw new Error("active Core candidate is not retained");
    try {
      assertRepositoryDeclarationRetention(activeCandidate, candidate);
    } catch (error) {
      if (!(error instanceof CoreValidationError)) throw error;
      const inspectionError = new CoreCandidateInspectionError(
        "validation",
        "candidate-invalid",
        error.message,
        error.details,
        candidate.sourceUrl,
        candidate.ref,
        candidate.commitId,
        candidate.treeId,
      );
      return rejectedResult(
        store,
        {
          checkId,
          operation: "automatic-source-check",
          stage: "validation",
          code: "candidate-invalid",
          summary: sanitizeCoreDiagnostic(error.message),
          details: error.details.slice(0, 8).map(sanitizeCoreDiagnostic),
          sourceUrl: candidate.sourceUrl,
          sourceRef: candidate.ref,
          commitId: candidate.commitId,
          treeId: candidate.treeId,
        },
        "candidate-invalid",
        inspectionError,
      );
    }
  }
  let continuityAncestorCommitId: string | undefined;
  if (active && active.sourceCommitId !== candidate.commitId) {
    try {
      await verifyContinuity(config, candidate, active.sourceCommitId);
      continuityAncestorCommitId = active.sourceCommitId;
    } catch (error) {
      if (!(error instanceof CoreSourceContinuityError)) throw error;
      return rejectedResult(
        store,
        {
          checkId,
          operation: "automatic-source-check",
          stage: error.stage,
          code: error.code,
          summary: sanitizeCoreDiagnostic(error.message),
          details: error.details.slice(0, 8).map(sanitizeCoreDiagnostic),
          sourceUrl: error.sourceUrl,
          sourceRef: error.ref,
          commitId: error.commitId,
          treeId: error.treeId,
          catalogDigest: error.catalogDigest,
          activeCommitId: error.activeCommitId,
        },
        "continuity-blocked",
        error,
      );
    }
  }

  try {
    const currentSequence = store.metadata().lastTransactionSequence;
    if (currentSequence !== expectedLastTransactionSequence) {
      throw new Error(
        `stale control-plane sequence: expected ${expectedLastTransactionSequence}, current ${currentSequence}`,
      );
    }
    const unchanged = active?.sourceCommitId === candidate.commitId;
    const activationResult = unchanged
      ? null
      : store.activateCoreSnapshot({
          candidate,
          expectedLastTransactionSequence,
          continuityAncestorCommitId,
        });
    const sourceCheck = store.recordCoreSourceCheckEligible({
      checkId,
      candidate,
      expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
    });
    return {
      status: "accepted",
      outcome: "eligible",
      checkDisposition: "recorded",
      checkId,
      activation: unchanged ? "unchanged" : "activated",
      activationResult,
      sourceCheck,
      rejectionResult: null,
      diagnosticError: null,
      failure: null,
    };
  } catch (error) {
    if (!(error instanceof CoreSnapshotPersistenceError)) throw error;
    return rejectedResult(
      store,
      {
        checkId,
        operation: "automatic-source-check",
        stage: "persistence",
        code: "persistence-failed",
        summary: sanitizeCoreDiagnostic(error.message),
        details: [],
        sourceUrl: candidate.sourceUrl,
        sourceRef: candidate.ref,
        commitId: candidate.commitId,
        treeId: candidate.treeId,
        catalogDigest: candidate.catalogDigest,
        activeCommitId: active?.sourceCommitId,
      },
      "persistence-failed",
      error,
    );
  }
}

function rejectedResult(
  store: ControlPlaneStore,
  input: CoreCandidateRejectionInput,
  outcome: CoreSynchronizationRejected["outcome"],
  failure: Error,
): CoreSynchronizationRejected {
  if (store.shouldSuppressCoreCandidateRejection(input)) {
    return {
      status: "rejected",
      outcome,
      checkDisposition: "suppressed",
      checkId: input.checkId,
      activation: null,
      activationResult: null,
      sourceCheck: null,
      rejectionResult: null,
      diagnosticError: null,
      failure,
    };
  }
  try {
    const rejectionResult = store.recordCoreCandidateRejection(input);
    return {
      status: "rejected",
      outcome,
      checkDisposition: "recorded",
      checkId: input.checkId,
      activation: null,
      activationResult: null,
      sourceCheck: null,
      rejectionResult,
      diagnosticError: null,
      failure,
    };
  } catch (error) {
    return {
      status: "rejected",
      outcome,
      checkDisposition: "record-failed",
      checkId: input.checkId,
      activation: null,
      activationResult: null,
      sourceCheck: null,
      rejectionResult: null,
      diagnosticError: error instanceof Error ? error : new Error(String(error)),
      failure,
    };
  }
}

export function sanitizeCoreDiagnostic(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b(token|password|secret|authorization)(\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = Buffer.from(normalized || "Unspecified Core candidate rejection", "utf8").subarray(0, 512);
  return new TextDecoder("utf-8", { fatal: false }).decode(bounded).replace(/\uFFFD$/u, "");
}
