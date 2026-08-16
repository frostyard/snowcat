#!/usr/bin/env node

import {
  CoreCandidateInspectionError,
  CoreSourceContinuityError,
  coreGitSourceConfig,
  inspectCoreCommit,
  inspectCoreCandidate,
  verifyCoreSourceContinuity,
  type InspectedCoreCandidate,
} from "./git-source.ts";
import {
  ControlPlaneStore,
  CoreSnapshotPersistenceError,
  controlPlaneDatabasePath,
  type CoreCandidateRejectionInput,
} from "../control/store.ts";
import { uuidV7 } from "../control/encoding.ts";

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "verify" && args.length === 0) {
    const candidate = await inspectCoreCandidate(coreGitSourceConfig());
    const { files: _files, ...summary } = candidate;
    console.log(JSON.stringify(summary, null, 2));
  } else if (command === "activate" && args.length === 1) {
    const expectedLastTransactionSequence = parsePositiveInteger(args[0]!);
    const config = coreGitSourceConfig();
    const checkId = uuidV7();
    let candidate: InspectedCoreCandidate;
    try {
      candidate = await inspectCoreCandidate(config);
    } catch (error) {
      if (error instanceof CoreCandidateInspectionError) {
        recordAndReportRejection({
          checkId,
          operation: "automatic-source-check",
          stage: error.stage,
          code: error.code,
          summary: sanitizeDiagnostic(error.message),
          details: error.details.slice(0, 8).map(sanitizeDiagnostic),
          sourceUrl: error.sourceUrl,
          sourceRef: error.ref,
          commitId: error.commitId,
          treeId: error.treeId,
        });
      }
      throw error;
    }
    const store = new ControlPlaneStore(controlPlaneDatabasePath());
    try {
      const active = store.activeCoreSnapshot();
      let continuityAncestorCommitId: string | undefined;
      if (active && active.sourceCommitId !== candidate.commitId) {
        try {
          await verifyCoreSourceContinuity(config, candidate, active.sourceCommitId);
          continuityAncestorCommitId = active.sourceCommitId;
        } catch (error) {
          if (error instanceof CoreSourceContinuityError) {
            recordAndReportRejection(
              {
                checkId,
                operation: "automatic-source-check",
                stage: error.stage,
                code: error.code,
                summary: sanitizeDiagnostic(error.message),
                details: error.details.slice(0, 8).map(sanitizeDiagnostic),
                sourceUrl: error.sourceUrl,
                sourceRef: error.ref,
                commitId: error.commitId,
                treeId: error.treeId,
                catalogDigest: error.catalogDigest,
                activeCommitId: error.activeCommitId,
              },
              store,
            );
          }
          throw error;
        }
      }
      try {
        const currentSequence = store.metadata().lastTransactionSequence;
        const unchanged = active?.sourceCommitId === candidate.commitId && currentSequence === expectedLastTransactionSequence;
        const activation = unchanged
          ? undefined
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
        const current = store.activeCoreSnapshot();
        console.log(
          JSON.stringify(
            {
              activation: activation ? "activated" : "unchanged",
              activationResult: activation ?? null,
              activeSnapshot: current,
              sourceCheck,
              readiness: store.coreAdmissionReadiness(),
            },
            null,
            2,
          ),
        );
      } catch (error) {
        if (error instanceof CoreSnapshotPersistenceError) {
          recordAndReportRejection(
            {
              checkId,
              operation: "automatic-source-check",
              stage: "persistence",
              code: "persistence-failed",
              summary: sanitizeDiagnostic(error.message),
              details: [],
              sourceUrl: candidate.sourceUrl,
              sourceRef: candidate.ref,
              commitId: candidate.commitId,
              treeId: candidate.treeId,
              catalogDigest: candidate.catalogDigest,
              activeCommitId: active?.sourceCommitId,
            },
            store,
          );
        }
        throw error;
      }
    } finally {
      store.close();
    }
  } else if (command === "rejections" && args.length <= 1) {
    const limit = args.length === 0 ? 20 : parseBoundedLimit(args[0]!);
    const store = new ControlPlaneStore(controlPlaneDatabasePath());
    try {
      console.log(JSON.stringify(store.coreCandidateRejections(limit), null, 2));
    } finally {
      store.close();
    }
  } else if (command === "readiness" && args.length === 0) {
    const store = new ControlPlaneStore(controlPlaneDatabasePath());
    try {
      console.log(JSON.stringify(store.coreAdmissionReadiness(), null, 2));
    } finally {
      store.close();
    }
  } else if (command === "rollback" && args.length === 3) {
    const expectedLastTransactionSequence = parsePositiveInteger(args[0]!);
    const targetCommitId = args[1]!;
    const reason = args[2]!;
    const config = coreGitSourceConfig();
    const checkId = uuidV7();
    const store = new ControlPlaneStore(controlPlaneDatabasePath());
    try {
      const active = store.activeCoreSnapshot();
      let candidate = store.retainedCoreCandidate(targetCommitId);
      if (!candidate) {
        try {
          candidate = await inspectCoreCommit(config, targetCommitId);
        } catch (error) {
          if (error instanceof CoreCandidateInspectionError) {
            recordAndReportRejection(
              {
                checkId,
                operation: "operator-rollback",
                stage: error.stage,
                code: error.code,
                summary: sanitizeDiagnostic(error.message),
                details: error.details.slice(0, 8).map(sanitizeDiagnostic),
                sourceUrl: error.sourceUrl,
                sourceRef: error.ref,
                commitId: error.commitId,
                treeId: error.treeId,
                activeCommitId: active?.sourceCommitId,
              },
              store,
            );
          }
          throw error;
        }
      }
      try {
        console.log(
          JSON.stringify(
            store.rollbackCoreSnapshot({ candidate, expectedLastTransactionSequence, reason }),
            null,
            2,
          ),
        );
      } catch (error) {
        if (error instanceof CoreSnapshotPersistenceError) {
          recordAndReportRejection(
            {
              checkId,
              operation: "operator-rollback",
              stage: "persistence",
              code: "persistence-failed",
              summary: sanitizeDiagnostic(error.message),
              details: [],
              sourceUrl: candidate.sourceUrl,
              sourceRef: candidate.ref,
              commitId: candidate.commitId,
              treeId: candidate.treeId,
              catalogDigest: candidate.catalogDigest,
              activeCommitId: active?.sourceCommitId,
            },
            store,
          );
        }
        throw error;
      }
    } finally {
      store.close();
    }
  } else {
    throw new Error(
      "Usage: npm run --silent core -- verify\n" +
        "       npm run --silent core -- activate <expected-control-plane-sequence>\n" +
        "       npm run --silent core -- rollback <expected-control-plane-sequence> <target-commit> <reason>\n" +
        "       npm run --silent core -- rejections [limit]\n" +
        "       npm run --silent core -- readiness",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (error && typeof error === "object" && "details" in error && Array.isArray(error.details)) {
    for (const detail of error.details) console.error(String(detail));
  }
  process.exitCode = 1;
}

function recordAndReportRejection(input: CoreCandidateRejectionInput, existingStore?: ControlPlaneStore): void {
  let store = existingStore;
  try {
    store ??= new ControlPlaneStore(controlPlaneDatabasePath());
    const result = store.recordCoreCandidateRejection(input);
    console.error(`Core candidate rejection recorded: ${result.observationRecordId}`);
  } catch (error) {
    console.error(
      `Core candidate rejection could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (!existingStore) store?.close();
  }
}

function sanitizeDiagnostic(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b(token|password|secret|authorization)(\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = Buffer.from(normalized || "Unspecified Core candidate rejection", "utf8").subarray(0, 512);
  return new TextDecoder("utf-8", { fatal: false }).decode(bounded).replace(/\uFFFD$/u, "");
}

function parsePositiveInteger(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("expected control-plane sequence must be a positive canonical integer");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("expected control-plane sequence is outside the safe integer range");
  return parsed;
}

function parseBoundedLimit(value: string): number {
  const parsed = parsePositiveInteger(value);
  if (parsed > 100) throw new Error("Core candidate rejection limit must not exceed 100");
  return parsed;
}
