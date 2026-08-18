#!/usr/bin/env node

import {
  CoreCandidateInspectionError,
  coreGitSourceConfig,
  inspectCoreCommit,
  inspectCoreCandidate,
} from "./git-source.ts";
import { runCorePollOnce, runCorePollingLoop } from "./controller.ts";
import { parseCorePollInterval } from "./poll-policy.ts";
import { sanitizeCoreDiagnostic, synchronizeCoreSource } from "./synchronize.ts";
import {
  ControlPlaneStore,
  CoreSnapshotPersistenceError,
  controlPlaneDatabasePath,
  type CoreCandidateRejectionInput,
} from "../control/store.ts";
import { uuidV7 } from "../control/encoding.ts";
import { reconcileRepositories } from "../repository/controller.ts";
import { CoreValidationError } from "./validator.ts";
import { adoptLegacyEnvironment } from "../env-compat.ts";

// FLUENT_* is read for one release (Snowcat ADR-0064); every entry point adopts it first.
adoptLegacyEnvironment();

const [command, ...args] = process.argv.slice(2);

try {
  if (command === "verify" && args.length === 0) {
    const candidate = await inspectCoreCandidate(coreGitSourceConfig());
    const { files: _files, ...summary } = candidate;
    console.log(JSON.stringify(summary, null, 2));
  } else if (command === "activate" && args.length === 1) {
    const expectedLastTransactionSequence = parsePositiveInteger(args[0]!);
    const store = new ControlPlaneStore(controlPlaneDatabasePath());
    try {
      const result = await synchronizeCoreSource(
        coreGitSourceConfig(),
        store,
        expectedLastTransactionSequence,
      );
      if (result.status === "rejected") {
        if (result.checkDisposition === "suppressed") {
          console.error("Equivalent Core candidate rejection suppressed");
        } else if (result.rejectionResult) {
          console.error(`Core candidate rejection recorded: ${result.rejectionResult.observationRecordId}`);
        }
        if (result.diagnosticError) {
          console.error(`Core candidate rejection could not be recorded: ${result.diagnosticError.message}`);
        }
        throw result.failure;
      }
      const repositoryReconciliation = await reconcileRepositories(store);
      console.log(
        JSON.stringify(
          {
            activation: result.activation,
            activationResult: result.activationResult,
            activeSnapshot: store.activeCoreSnapshot(),
            sourceCheck: result.sourceCheck,
            readiness: store.coreAdmissionReadiness(),
            repositoryReconciliation,
          },
          null,
          2,
        ),
      );
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
  } else if (command === "override-staleness" && args.length === 3) {
    const expectedLastTransactionSequence = parsePositiveInteger(args[0]!);
    const expiresAt = args[1]!;
    const reason = args[2]!;
    const store = new ControlPlaneStore(controlPlaneDatabasePath());
    try {
      const decision = store.issueCoreStaleSourceOverride({
        expectedLastTransactionSequence,
        expiresAt,
        reason,
      });
      console.log(JSON.stringify({ decision, readiness: store.coreAdmissionReadiness() }, null, 2));
    } finally {
      store.close();
    }
  } else if (command === "prune-check-history" && args.length === 1) {
    const expectedLastTransactionSequence = parsePositiveInteger(args[0]!);
    const store = new ControlPlaneStore(controlPlaneDatabasePath());
    try {
      console.log(JSON.stringify(store.pruneCoreCheckDetail({ expectedLastTransactionSequence }), null, 2));
    } finally {
      store.close();
    }
  } else if (command === "poll-state" && args.length === 0) {
    const store = new ControlPlaneStore(controlPlaneDatabasePath());
    try {
      console.log(JSON.stringify(store.corePollState(), null, 2));
    } finally {
      store.close();
    }
  } else if (command === "poll-once" && args.length === 0) {
    const healthyIntervalSeconds = parseCorePollInterval(process.env.SNOWCAT_CORE_POLL_INTERVAL_SECONDS);
    const store = new ControlPlaneStore(controlPlaneDatabasePath());
    try {
      const result = await runCorePollOnce(
        store,
        coreGitSourceConfig(),
        healthyIntervalSeconds,
        synchronizeCoreSource,
        reconcileRepositories,
      );
      console.log(JSON.stringify(result, null, 2));
      if (result.status === "claimed" && result.controllerError !== null) process.exitCode = 1;
    } finally {
      store.close();
    }
  } else if (command === "poll" && args.length === 0) {
    const healthyIntervalSeconds = parseCorePollInterval(process.env.SNOWCAT_CORE_POLL_INTERVAL_SECONDS);
    const store = new ControlPlaneStore(controlPlaneDatabasePath());
    let stopping = false;
    const stop = () => {
      stopping = true;
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await runCorePollingLoop(
        store,
        coreGitSourceConfig(),
        healthyIntervalSeconds,
        () => stopping,
        (result) => console.log(JSON.stringify(result)),
        reconcileRepositories,
      );
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
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
                summary: sanitizeCoreDiagnostic(error.message),
                details: error.details.slice(0, 8).map(sanitizeCoreDiagnostic),
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
        if (error instanceof CoreValidationError) {
          recordAndReportRejection(
            {
              checkId,
              operation: "operator-rollback",
              stage: "validation",
              code: "candidate-invalid",
              summary: sanitizeCoreDiagnostic(error.message),
              details: error.details.slice(0, 8).map(sanitizeCoreDiagnostic),
              sourceUrl: candidate.sourceUrl,
              sourceRef: candidate.ref,
              commitId: candidate.commitId,
              treeId: candidate.treeId,
              activeCommitId: active?.sourceCommitId,
            },
            store,
          );
        } else if (error instanceof CoreSnapshotPersistenceError) {
          recordAndReportRejection(
            {
              checkId,
              operation: "operator-rollback",
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
        "       npm run --silent core -- readiness\n" +
        "       npm run --silent core -- override-staleness <expected-control-plane-sequence> <expires-at> <reason>\n" +
        "       npm run --silent core -- prune-check-history <expected-control-plane-sequence>\n" +
        "       npm run --silent core -- poll-state\n" +
        "       npm run --silent core -- poll-once\n" +
        "       npm run --silent core -- poll",
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
