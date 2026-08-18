import type { RepositoryMaintenanceProgram } from "../control/registry.ts";
import { enrolledRepositoryPrograms } from "./eligibility.ts";
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

/**
 * One discovery root template per maintenance program. `program` is the Core
 * `maintenance_programs` value the template serves; a repository under the
 * enrollment gate is seeded only for the programs its declaration lists.
 */
type DogfoodTemplate = Omit<SeedWorkInput, "repository" | "createdBy"> & { program: RepositoryMaintenanceProgram };

const dogfoodTemplates: DogfoodTemplate[] = [
  {
    program: "quality",
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
    program: "ci",
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
    program: "security",
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
    program: "architecture",
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

/** Default no-finding cooldown for the repeating dogfood feeder: one day. */
export const DEFAULT_DOGFOOD_COOLDOWN_SECONDS = 24 * 60 * 60;

export interface DogfoodBatchOptions {
  cooldownSeconds?: number;
  /**
   * The maintenance programs to seed. Omitted means every program in the
   * catalog (explicit `seed-dogfood <owner/repo>` for a repository outside the
   * enrollment gate); a Core declaration's `maintenance_programs` narrows the
   * batch to exactly those programs.
   */
  programs?: readonly RepositoryMaintenanceProgram[];
}

export interface DogfoodBatchResult {
  created: WorkItem[];
  skippedKinds: string[];
  cooledKinds: string[];
  /** Catalog kinds not offered because `programs` did not list their program. */
  undeclaredKinds: string[];
}

export function enqueueDogfoodBatch(queue: QueueStore, repository: string, options: DogfoodBatchOptions = {}): DogfoodBatchResult {
  const declared = options.programs === undefined ? undefined : new Set(options.programs);
  const offered = dogfoodTemplates.filter((template) => declared === undefined || declared.has(template.program));
  const undeclaredKinds = dogfoodTemplates.filter((template) => !offered.includes(template)).map((template) => template.kind);
  const batch = queue.enqueueInactiveRootBatch(
    repository,
    offered.map(({ program: _program, ...template }) => ({ ...template, createdBy: "operator:dogfood" })),
    { cooldownSeconds: options.cooldownSeconds ?? DEFAULT_DOGFOOD_COOLDOWN_SECONDS },
  );
  return { ...batch, undeclaredKinds };
}

export interface EnrolledDogfoodResult {
  /**
   * One feeder result per repository that is both opted in and `enrolled`, in
   * queue slug order, with the programs its Core declaration lists.
   */
  seeded: Array<{ repository: string; programs: RepositoryMaintenanceProgram[] } & DogfoodBatchResult>;
  /** Enrolled repositories that are not opted in to the queue, so nothing was seeded for them. */
  notOptedIn: string[];
}

/**
 * Runs the dogfood feeder for every repository that is opted in to the queue
 * and `enrolled` in the control-plane store at `controlPlanePath`, one
 * transaction per repository, so a failure in one repository leaves the others'
 * roots intact. Each repository is seeded only for the programs its Core
 * declaration lists in `maintenance_programs`. Slugs are matched
 * case-insensitively and seeded under the queue's opt-in spelling.
 * `seed-dogfood <owner/repo>` is unchanged by this.
 */
export function enqueueDogfoodBatchForEnrolled(
  queue: QueueStore,
  controlPlanePath: string,
  options: { cooldownSeconds?: number } = {},
): EnrolledDogfoodResult {
  const enrolled = enrolledRepositoryPrograms(controlPlanePath);
  const optedIn = new Map(queue.enabledRepositories().map((slug) => [slug.toLowerCase(), slug]));
  const seeded: EnrolledDogfoodResult["seeded"] = [];
  const notOptedIn: string[] = [];
  for (const { slug, maintenancePrograms } of [...enrolled].sort((left, right) => (left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0))) {
    const repository = optedIn.get(slug.toLowerCase());
    if (repository === undefined) {
      notOptedIn.push(slug);
      continue;
    }
    seeded.push({
      repository,
      programs: [...maintenancePrograms],
      ...enqueueDogfoodBatch(queue, repository, { cooldownSeconds: options.cooldownSeconds, programs: maintenancePrograms }),
    });
  }
  return { seeded, notOptedIn };
}
