import type { PredecessorStatus, QueueStore } from "../queue/store.ts";
import type { ObservableWorkItem } from "../queue/types.ts";
import { artifactLabel } from "./pages.ts";

/**
 * Why one declared predecessor is not satisfied, in one scannable word or two.
 * It is a label for the store's own verdict, never a second opinion: every
 * entry that carries one is `satisfied: false` because
 * `QueueStore.predecessorStatuses` said so.
 */
export type PredecessorLabel = "met" | "predecessor cycle" | "not imported" | "cancelled" | "not completed" | "not delivered";

/**
 * One declared predecessor as the surface shows it: exactly the claim gate's
 * `PredecessorStatus` ([spec rule 63](../../docs/specs/work-queue.md)), plus
 * the two things a page needs and the gate does not — a short label to scan
 * and whether this unmet edge is part of a cycle back to the declaring item.
 */
export interface PredecessorEntry extends PredecessorStatus {
  label: PredecessorLabel;
  /** True when following unmet edges from this one leads back to the item that declared it. */
  cycle: boolean;
}

/** Every predecessor one item declares, in stored order, and what they mean together. */
export interface PredecessorSummary {
  entries: PredecessorEntry[];
  /** The unmet subset, in stored order: non-empty exactly when the gate withholds this item. */
  unmet: PredecessorEntry[];
  /** The nearest unmet edge — the first one in stored order — which the progress chip names. */
  nearest?: PredecessorEntry;
  /** True when any unmet edge loops back: the item can never become eligible without an operator. */
  cycle: boolean;
}

/** The one store read this module makes; a cache keyed by work-item id memoizes it per pass. */
type PredecessorReader = Pick<QueueStore, "predecessorStatuses">;
export type PredecessorCache = Map<string, PredecessorStatus[]>;

/**
 * How many work items one cycle walk may visit before it gives up. A cycle is
 * found within a handful of hops in practice; the ceiling only bounds a
 * pathological chain, and giving up reports "no cycle", never a false one.
 */
const CYCLE_WALK_LIMIT = 200;

/**
 * What the item page and the progress strips say about one item's
 * predecessors ([ADR-0066](../../docs/adr/0066-sequence-project-slices-on-observed-predecessor-delivery.md)).
 * Satisfaction is not decided here: every verdict comes from
 * `QueueStore.predecessorStatuses`, the same evaluation the claim transaction
 * runs, so what an operator reads is what the gate decides — and, like the
 * gate, nothing here asks GitHub or writes anything. Cycle detection is the
 * one thing added, and it decides no edge: it walks the unmet edges the gate
 * already reported, looking for a path back to `item`.
 *
 * Returns `undefined` for an item that declares no predecessors, so a caller
 * renders no block at all (spec rule 63).
 */
export function readPredecessors(
  queue: PredecessorReader,
  item: Pick<ObservableWorkItem, "id" | "predecessors">,
  cache: PredecessorCache = new Map(),
): PredecessorSummary | undefined {
  if (!item.predecessors || item.predecessors.length === 0) return undefined;
  const entries = statusesOf(queue, item.id, cache).map((status): PredecessorEntry => {
    const cycle = !status.satisfied && status.itemId !== undefined && loopsBack(queue, item.id, status.itemId, cache);
    return { ...status, cycle, label: labelFor(status, cycle) };
  });
  const unmet = entries.filter((entry) => !entry.satisfied);
  return {
    entries,
    unmet,
    ...(unmet[0] ? { nearest: unmet[0] } : {}),
    cycle: entries.some((entry) => entry.cycle),
  };
}

/** `issue #161` for a predecessor source reference — always a GitHub issue URL under spec rule 58. */
export function predecessorLabel(sourceRef: string): string {
  return artifactLabel("issue", sourceRef);
}

/**
 * The waiting chip and stop badge a queued item's unmet predecessors earn.
 * A plain wait names the nearest unmet edge and stays out of the attention
 * group; a cycle is a stop only an operator can clear, so it is amber and the
 * attention group collects it (ADR-0066 consequences).
 */
export function predecessorWait(summary: PredecessorSummary): { waiting: string; badge?: { label: string; reason: string; tone: "amber" } } {
  const nearest = summary.nearest;
  if (!nearest) return { waiting: "in queue" };
  const named = predecessorLabel(nearest.sourceRef);
  if (summary.cycle) {
    const looping = summary.entries.find((entry) => entry.cycle) ?? nearest;
    const reason = `predecessor cycle through ${predecessorLabel(looping.sourceRef)} — no worker can claim this until you cancel or refile one of them`;
    return { waiting: `predecessor cycle · ${predecessorLabel(looping.sourceRef)}`, badge: { label: "predecessor cycle", reason, tone: "amber" } };
  }
  return { waiting: `waiting for predecessor ${named} · ${nearest.label}` };
}

/** The gate's verdict as one scannable label; the store's `reason` carries the detail. */
function labelFor(status: PredecessorStatus, cycle: boolean): PredecessorLabel {
  if (status.satisfied) return "met";
  if (cycle) return "predecessor cycle";
  if (status.itemId === undefined) return "not imported";
  if (status.status === "cancelled") return "cancelled";
  if (status.status !== "completed") return "not completed";
  return "not delivered";
}

function statusesOf(queue: PredecessorReader, id: string, cache: PredecessorCache): PredecessorStatus[] {
  const cached = cache.get(id);
  if (cached) return cached;
  const statuses = queue.predecessorStatuses(id);
  cache.set(id, statuses);
  return statuses;
}

/**
 * Whether the unmet edges reachable from `from` lead back to `start`. Only
 * unmet edges are followed: a satisfied one has already delivered and can
 * withhold nothing, so a loop through it is history, not a deadlock.
 */
function loopsBack(queue: PredecessorReader, start: string, from: string, cache: PredecessorCache): boolean {
  const seen = new Set<string>();
  const frontier = [from];
  while (frontier.length > 0 && seen.size < CYCLE_WALK_LIMIT) {
    const id = frontier.pop()!;
    if (id === start) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const status of statusesOf(queue, id, cache)) {
      if (status.satisfied || status.itemId === undefined) continue;
      frontier.push(status.itemId);
    }
  }
  return false;
}
