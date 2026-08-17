import {
  ControlPlaneStore,
  type RepositoryCoreAuthorityResult,
  type RepositoryEnrollmentResult,
  type RepositoryGitHubInspectionInput,
  type RepositoryGitHubReconciliationResult,
  type RepositorySurfaceReconciliationResult,
  type RepositoryStatus,
} from "../control/store.ts";
import { inspectGitHubRepository } from "./github.ts";
import {
  inspectRepositorySurfaces,
  type RepositorySurfaceInspectionTarget,
  type RepositorySurfaceProbeInput,
} from "./surfaces.ts";

export type RepositoryIdentityInspector = (
  locator: { owner: string; name: string },
) => Promise<RepositoryGitHubInspectionInput>;

export type RepositorySurfaceInspector = (
  target: RepositorySurfaceInspectionTarget,
) => Promise<RepositorySurfaceProbeInput>;

export interface RepositoryReconciliationPassResult {
  coreSnapshotId: string;
  materialized: RepositoryCoreAuthorityResult[];
  github: RepositoryGitHubReconciliationResult[];
  surfaces: RepositorySurfaceReconciliationResult[];
  enrollments: RepositoryEnrollmentResult[];
  statuses: RepositoryStatus[];
}

export async function reconcileRepositories(
  store: ControlPlaneStore,
  inspect: RepositoryIdentityInspector = inspectGitHubRepository,
  inspectSurfaces: RepositorySurfaceInspector = inspectRepositorySurfaces,
): Promise<RepositoryReconciliationPassResult> {
  const catalog = store.activeCoreRepositoryCatalog();
  if (!catalog) throw new Error("repository reconciliation requires an active Core snapshot");
  const materialized: RepositoryCoreAuthorityResult[] = [];
  const github: RepositoryGitHubReconciliationResult[] = [];
  const surfaces: RepositorySurfaceReconciliationResult[] = [];
  const enrollments: RepositoryEnrollmentResult[] = [];

  for (const repository of [...catalog.repositories].sort((left, right) => left.path.localeCompare(right.path))) {
    const repositoryId = `github.com:${repository.declaration.repository.repository_id}`;
    let status = store
      .repositoryStatuses()
      .find(
        (candidate) =>
          candidate.repositoryId === repositoryId &&
          candidate.coreSnapshotId === catalog.snapshot.snapshotId,
      );
    if (!status || status.coreAuthorizationRecordId === null) {
      const authority = store.materializeRepositoryCoreAuthority({
        expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
        coreSnapshotId: catalog.snapshot.snapshotId,
        repositoryId,
      });
      materialized.push(authority);
      status = store.repositoryStatuses().find((candidate) => candidate.repositoryId === repositoryId);
      if (!status || status.coreAuthorizationRecordId === null) {
        throw new Error(`repository authority did not materialize for ${repositoryId}`);
      }
    }
    if (status.fleetState !== "enabled" || status.operatorHold !== null) continue;
    const inspection = await inspect({ owner: status.owner, name: status.name });
    const identity = store.recordRepositoryGitHubIdentity({
      expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
      coreAuthorizationRecordId: status.coreAuthorizationRecordId,
      inspection,
    });
    github.push(identity);
    if (identity.result !== "matched" || inspection.kind !== "found") continue;
    const contract = store.activeCoreSurfaceContract(status.surfaceContractVersion);
    if (!contract) throw new Error("repository surface reconciliation requires an active Core contract");
    const probe = await inspectSurfaces({
      owner: inspection.owner,
      name: inspection.name,
      defaultBranch: inspection.defaultBranch,
      contract: contract.contract,
    });
    const surface = store.recordRepositoryCanonicalSurfaces({
      expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
      githubReconciliationRecordId: identity.reconciliationRecordId,
      probe,
    });
    surfaces.push(surface);
    if (surface.result !== "valid") continue;
    enrollments.push(
      store.establishRepositoryEnrollment({
        expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
        surfaceReconciliationRecordId: surface.reconciliationRecordId,
      }),
    );
  }
  return {
    coreSnapshotId: catalog.snapshot.snapshotId,
    materialized,
    github,
    surfaces,
    enrollments,
    statuses: store.repositoryStatuses(),
  };
}
