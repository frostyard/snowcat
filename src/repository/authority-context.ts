import { canonicalJson, sha256 } from "../control/encoding.ts";
import type {
  RepositoryCoreAuthorityPayload,
  RepositoryEnrollmentPayload,
  RepositoryGitHubReconciliationPayload,
  RepositoryState,
  RepositorySurfaceReconciliationPayload,
} from "../control/registry.ts";

export interface RepositoryAuthorityContextInput {
  authority: RepositoryCoreAuthorityPayload;
  github: RepositoryGitHubReconciliationPayload;
  surfaces: RepositorySurfaceReconciliationPayload;
  enrollment: RepositoryEnrollmentPayload;
}

export type RepositoryHeldWorkCause =
  | "github-unavailable"
  | "surfaces-unavailable"
  | "core-paused"
  | "core-disabled"
  | "operator-hold"
  | "github-reconciliation-failure"
  | "surface-validation-failure"
  | "authority-context-changed";

export type RepositoryHeldWorkRecovery =
  | { decision: "remain-held"; reason: "repository-not-enrolled" }
  | { decision: "resume-automatically"; reason: "unchanged-transient-outage" }
  | {
      decision: "require-operator-disposition";
      reason: "authority-context-changed" | "non-transient-hold";
    };

/**
 * Digest the semantic inputs that established one repository enrollment.
 * Record identities and evaluation times are deliberately excluded so an
 * equivalent retry after a transient outage reproduces the same digest.
 */
export function repositoryAuthorityContextDigest(input: RepositoryAuthorityContextInput): string {
  const { authority, github, surfaces, enrollment } = input;
  if (
    authority.repositoryId !== github.repositoryId ||
    authority.repositoryId !== surfaces.repositoryId ||
    authority.repositoryId !== enrollment.repositoryId ||
    authority.coreSnapshotId !== github.coreSnapshotId ||
    authority.coreSnapshotId !== surfaces.coreSnapshotId ||
    authority.coreSnapshotId !== enrollment.coreSnapshotId ||
    authority.coreAuthorizationRecordId !== github.coreAuthorizationRecordId ||
    authority.coreAuthorizationRecordId !== surfaces.coreAuthorizationRecordId ||
    authority.coreAuthorizationRecordId !== enrollment.coreAuthorizationRecordId ||
    github.reconciliationRecordId !== surfaces.githubReconciliationRecordId ||
    github.reconciliationRecordId !== enrollment.githubReconciliationRecordId ||
    surfaces.reconciliationRecordId !== enrollment.surfaceReconciliationRecordId ||
    surfaces.policyDecisionRecordId !== enrollment.surfacePolicyDecisionRecordId ||
    authority.surfaceContractVersion !== surfaces.surfaceContractVersion ||
    authority.surfaceContractVersion !== enrollment.surfaceContractVersion ||
    github.observedDefaultBranch !== surfaces.defaultBranch ||
    canonicalJson(authority.maintenancePrograms) !== canonicalJson(enrollment.maintenancePrograms) ||
    canonicalJson(authority.actionCeiling) !== canonicalJson(enrollment.actionCeiling) ||
    authority.fleetState !== "enabled" ||
    github.result !== "matched" ||
    surfaces.result !== "valid" ||
    surfaces.decision !== "permit" ||
    surfaces.repositoryCommitId === null ||
    surfaces.repositoryCommitId !== enrollment.repositoryCommitId
  ) {
    throw new Error("repository authority context requires one coherent enrolled repository");
  }

  return sha256(
    canonicalJson({
      schemaVersion: 1,
      repositoryId: authority.repositoryId,
      core: {
        snapshotId: authority.coreSnapshotId,
        sourceCommitId: authority.sourceCommitId,
        declarationPath: authority.declarationPath,
        declarationDigest: authority.declarationDigest,
        owner: authority.owner,
        name: authority.name,
        accountableOwners: authority.accountableOwners,
        fleetState: authority.fleetState,
        maintenancePrograms: authority.maintenancePrograms,
        actionCeiling: authority.actionCeiling,
        surfaceContractVersion: authority.surfaceContractVersion,
      },
      github: {
        declaredOwner: github.declaredOwner,
        declaredName: github.declaredName,
        declaredRepositoryId: github.declaredRepositoryId,
        observedOwner: github.observedOwner,
        observedName: github.observedName,
        observedRepositoryId: github.observedRepositoryId,
        archived: github.archived,
        defaultBranch: github.observedDefaultBranch,
        responseDigest: github.responseDigest,
      },
      surfaces: {
        defaultBranch: surfaces.defaultBranch,
        repositoryCommitId: surfaces.repositoryCommitId,
        repositoryTreeId: surfaces.repositoryTreeId,
        surfaceContractVersion: surfaces.surfaceContractVersion,
        governanceSchemaVersion: surfaces.governanceSchemaVersion,
        surfaceContractDigest: surfaces.surfaceContractDigest,
        governanceSchemaDigest: surfaces.governanceSchemaDigest,
        surfaces: surfaces.surfaces,
        governancePolicy: surfaces.governancePolicy,
        checkpoint: surfaces.checkpoint,
        decision: surfaces.decision,
        requirementResults: surfaces.requirementResults,
        exceptionRecordIds: surfaces.exceptionRecordIds,
        probeDigest: surfaces.probeDigest,
      },
      enrollment: {
        repositoryCommitId: enrollment.repositoryCommitId,
        surfaceContractVersion: enrollment.surfaceContractVersion,
        maintenancePrograms: enrollment.maintenancePrograms,
        actionCeiling: enrollment.actionCeiling,
      },
    }),
  );
}

export function evaluateRepositoryHeldWorkRecovery(input: {
  cause: RepositoryHeldWorkCause;
  heldAuthorityContextDigest: string;
  currentAuthorityContextDigest: string | null;
  currentRepositoryState: RepositoryState;
}): RepositoryHeldWorkRecovery {
  if (!/^sha256:[0-9a-f]{64}$/.test(input.heldAuthorityContextDigest)) {
    throw new Error("held work requires a valid authority-context digest");
  }
  if (
    input.currentAuthorityContextDigest !== null &&
    !/^sha256:[0-9a-f]{64}$/.test(input.currentAuthorityContextDigest)
  ) {
    throw new Error("held work recovery requires a valid current authority-context digest");
  }
  if (input.currentRepositoryState !== "enrolled" || input.currentAuthorityContextDigest === null) {
    return { decision: "remain-held", reason: "repository-not-enrolled" };
  }
  if (input.currentAuthorityContextDigest !== input.heldAuthorityContextDigest) {
    return { decision: "require-operator-disposition", reason: "authority-context-changed" };
  }
  if (input.cause === "github-unavailable" || input.cause === "surfaces-unavailable") {
    return { decision: "resume-automatically", reason: "unchanged-transient-outage" };
  }
  return { decision: "require-operator-disposition", reason: "non-transient-hold" };
}
