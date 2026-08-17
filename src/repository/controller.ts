import {
  ControlPlaneStore,
  type RepositoryCoreAuthorityResult,
  type RepositoryGitHubInspectionInput,
  type RepositoryGitHubReconciliationResult,
  type RepositoryPreSurfaceStatus,
} from "../control/store.ts";
import { inspectGitHubRepository } from "./github.ts";

export type RepositoryIdentityInspector = (
  locator: { owner: string; name: string },
) => Promise<RepositoryGitHubInspectionInput>;

export interface RepositoryReconciliationPassResult {
  coreSnapshotId: string;
  materialized: RepositoryCoreAuthorityResult[];
  github: RepositoryGitHubReconciliationResult[];
  statuses: RepositoryPreSurfaceStatus[];
}

export async function reconcileRepositories(
  store: ControlPlaneStore,
  inspect: RepositoryIdentityInspector = inspectGitHubRepository,
): Promise<RepositoryReconciliationPassResult> {
  const catalog = store.activeCoreRepositoryCatalog();
  if (!catalog) throw new Error("repository reconciliation requires an active Core snapshot");
  const materialized: RepositoryCoreAuthorityResult[] = [];
  const github: RepositoryGitHubReconciliationResult[] = [];

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
    if (status.fleetState !== "enabled" || status.githubResult === "matched") continue;
    const inspection = await inspect({ owner: status.owner, name: status.name });
    github.push(
      store.recordRepositoryGitHubIdentity({
        expectedLastTransactionSequence: store.metadata().lastTransactionSequence,
        coreAuthorizationRecordId: status.coreAuthorizationRecordId,
        inspection,
      }),
    );
  }
  return {
    coreSnapshotId: catalog.snapshot.snapshotId,
    materialized,
    github,
    statuses: store.repositoryStatuses(),
  };
}
