import { deliveryArtifactIdentity } from "./artifact-identity.ts";
import type { WorkItem } from "./types.ts";

export type DeliveryHandoff = "verify" | "repair" | "review" | "merge" | "publish";

export interface PendingDelivery {
  artifact: {
    kind: "pull-request" | "release";
    url: string;
    state: "open" | "draft";
    draft: boolean;
    verifiedAt: string;
    headSha?: string;
  };
  handoff: DeliveryHandoff;
  reason?: string;
  ready: boolean;
  workItemId: string;
  repository: string;
  workKind: string;
  objective: string;
  sourceRef?: string;
  createdAt: string;
}

interface DeliveryAggregate {
  context: Omit<PendingDelivery, "artifact" | "handoff" | "reason" | "ready">;
  source: {
    kind: "pull-request" | "release";
    url: string;
    state: "open" | "closed" | "merged" | "published" | "draft";
    draft: boolean;
    verifiedAt: string;
    headSha?: string;
    order: string;
  };
  handoff?: {
    status: "unverified" | "rejected";
    reason: string;
    order: string;
  };
}

/** Project pending work as the individual GitHub artifacts a human acts on. */
export function pendingDeliveries(items: WorkItem[]): PendingDelivery[] {
  const byIdentity = new Map<string, DeliveryAggregate>();
  for (const item of items) {
    for (const artifact of item.result?.artifacts ?? []) {
      if (artifact.kind !== "pull-request" && artifact.kind !== "release") continue;
      const verification = artifact.verification;
      if (verification?.status !== "verified") continue;

      const identity = deliveryArtifactIdentity(item.repository, artifact)!;
      const context = {
        workItemId: item.id,
        repository: item.repository,
        workKind: item.kind,
        objective: item.objective,
        ...(item.sourceRef === undefined ? {} : { sourceRef: item.sourceRef }),
        createdAt: item.createdAt,
      };
      const source = {
        kind: artifact.kind,
        url: artifact.url,
        state: verification.state,
        draft: verification.draft === true,
        verifiedAt: verification.verifiedAt,
        ...(verification.headSha === undefined ? {} : { headSha: verification.headSha }),
        order: `${verification.verifiedAt}\0${item.updatedAt}`,
      };
      const existing = byIdentity.get(identity);
      if (!existing) {
        byIdentity.set(identity, {
          context,
          source,
          ...(verification.handoff === undefined
            ? {}
            : {
                handoff: {
                  status: verification.handoff.status,
                  reason: verification.handoff.reason,
                  order: `${handoffObservedAt(verification.handoff)}\0${item.updatedAt}`,
                },
              }),
        });
        continue;
      }

      if (context.createdAt < existing.context.createdAt) existing.context = context;
      if (source.order > existing.source.order) existing.source = source;
      if (verification.handoff !== undefined) {
        const marker = {
          status: verification.handoff.status,
          reason: verification.handoff.reason,
          order: `${handoffObservedAt(verification.handoff)}\0${item.updatedAt}`,
        };
        if (!existing.handoff || marker.order > existing.handoff.order) existing.handoff = marker;
      }
    }
  }

  return [...byIdentity.values()]
    .flatMap(({ context, source, handoff }): PendingDelivery[] => {
      if (source.state !== "open" && source.state !== "draft") return [];
      const next: DeliveryHandoff =
        source.kind === "release"
          ? "publish"
          : handoff?.status === "rejected"
            ? "repair"
            : handoff?.status === "unverified"
              ? "verify"
              : source.draft
                ? "review"
                : "merge";
      return [
        {
          ...context,
          artifact: {
            kind: source.kind,
            url: source.url,
            state: source.state,
            draft: source.draft,
            verifiedAt: source.verifiedAt,
            ...(source.headSha === undefined ? {} : { headSha: source.headSha }),
          },
          handoff: next,
          ...(handoff === undefined ? {} : { reason: handoff.reason }),
          ready: next === "merge" || next === "publish",
        },
      ];
    })
    .sort(
      (left, right) =>
        Number(right.ready) - Number(left.ready) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.artifact.url.localeCompare(right.artifact.url),
    );
}

function handoffObservedAt(
  handoff: { status: "unverified"; attemptedAt: string } | { status: "rejected"; checkedAt: string },
): string {
  return handoff.status === "unverified" ? handoff.attemptedAt : handoff.checkedAt;
}
