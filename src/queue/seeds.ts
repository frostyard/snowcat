import { QueueStore } from "./store.ts";
import type { AllowedAction, SeedWorkInput, WorkItem } from "./types.ts";

const discoveryActions: AllowedAction[] = ["read", "create-followup"];
const implementationCeiling: AllowedAction[] = [
  "read",
  "write",
  "run-tests",
  "open-issue",
  "open-pr",
  "create-followup",
];

const dogfoodTemplates: Array<Omit<SeedWorkInput, "repository" | "createdBy">> = [
  {
    kind: "quality-gap-discovery",
    objective: "Identify one evidence-backed software quality gap without proposing a new product feature.",
    instructions:
      "Inspect existing behavior and identify exactly one maintainability, reliability, or error-handling gap. Do not edit files or open a GitHub artifact. Report impact and file-level evidence, and propose one bounded implementation child only when justified.",
    acceptanceCriteria: [
      "The result identifies exactly one gap in existing behavior rather than a feature request.",
      "Evidence names the relevant implementation and any related tests or documentation.",
      "Any follow-up has a bounded change and verifiable project check.",
    ],
    allowedActions: discoveryActions,
    delegableActions: implementationCeiling,
    priority: 0,
  },
  {
    kind: "ci-gap-discovery",
    objective: "Identify one evidence-backed gap in CI or test signal quality.",
    instructions:
      "Inspect CI workflows, project checks, and tests. Identify exactly one missing, misleading, flaky, or unnecessarily weak signal. Do not edit files or open a GitHub artifact. Propose one bounded implementation child only when justified.",
    acceptanceCriteria: [
      "The result identifies exactly one CI or test-signal gap.",
      "Evidence cites the relevant workflow, command, source, or test paths.",
      "Any follow-up states the signal that will change and how it will be verified.",
    ],
    allowedActions: discoveryActions,
    delegableActions: implementationCeiling,
    priority: 0,
  },
  {
    kind: "security-gap-discovery",
    objective: "Identify one evidence-backed security hardening gap.",
    instructions:
      "Inspect trust boundaries, input validation, secret handling, dependencies, and authorization code. Identify exactly one concrete hardening gap without overstating exploitability. Do not edit files or open a GitHub artifact. Propose one bounded child only when the evidence justifies it.",
    acceptanceCriteria: [
      "The result identifies exactly one security hardening gap and distinguishes observation from verified exploitability.",
      "Evidence cites the relevant boundary and source, test, configuration, or dependency paths.",
      "Any follow-up has least-authority actions and mechanically verifiable criteria.",
    ],
    allowedActions: discoveryActions,
    delegableActions: implementationCeiling,
    priority: 0,
  },
  {
    kind: "architecture-gap-discovery",
    objective: "Identify one evidence-backed mismatch between this repository and its documented current contracts.",
    instructions:
      "Compare implementation and live repository instructions with accepted ADRs, design documents, and specs. Identify exactly one current mismatch; do not invent an organization standard or treat an aspiration as implemented truth. Do not edit files or open a GitHub artifact. Propose one bounded child only when justified.",
    acceptanceCriteria: [
      "The result identifies exactly one mismatch between live code or instructions and a current documented contract.",
      "Evidence cites both sides of the mismatch.",
      "Any follow-up preserves the distinction between current truth and aspiration.",
    ],
    allowedActions: discoveryActions,
    delegableActions: implementationCeiling,
    priority: 0,
  },
];

export function enqueueTestingGap(queue: QueueStore, repository: string, createdBy = "operator:cli"): WorkItem {
  return queue.enqueueSeed({
    repository,
    kind: "testing-gap-discovery",
    objective: "Identify one meaningful testing gap and propose a test that covers it.",
    instructions: [
      "Inspect the repository and identify exactly one evidence-backed testing gap.",
      "Do not edit files or open a GitHub artifact.",
      "Complete this item with the gap, its impact, and file-level evidence.",
      "Create one implementation follow-up when a concrete test is justified.",
    ].join(" "),
    acceptanceCriteria: [
      "The result identifies exactly one testing gap.",
      "Evidence names the relevant behavior and source or test locations.",
      "Any follow-up specifies a concrete test and verifiable completion criteria.",
    ],
    allowedActions: discoveryActions,
    delegableActions: implementationCeiling,
    priority: 0,
    createdBy,
  });
}

export function enqueueDogfoodBatch(
  queue: QueueStore,
  repository: string,
): { created: WorkItem[]; skippedKinds: string[] } {
  return queue.enqueueInactiveRootBatch(
    repository,
    dogfoodTemplates.map((template) => ({ ...template, createdBy: "operator:dogfood" })),
  );
}
