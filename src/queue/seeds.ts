import type { RepositoryMaintenanceProgram } from "../control/registry.ts";
import { enrolledRepositoryPrograms } from "./eligibility.ts";
import { discoveryRootFor, maintenancePrograms } from "./programs.ts";
import { QueueStore } from "./store.ts";
import type { AllowedAction, WorkItem } from "./types.ts";

const discoveryActions: AllowedAction[] = ["read", "create-followup"];
const implementationCeiling: AllowedAction[] = ["read", "write", "run-tests", "open-issue", "open-pr", "create-followup"];

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

export interface DogfoodBatchOptions {
  /**
   * Overrides every program's own no-finding cooldown (`--cooldown-hours`);
   * omitted means each program's catalog cadence applies.
   */
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

/**
 * Seeds the discovery roots of the maintenance program catalog for one
 * repository: every program, or only `options.programs`. Each root carries its
 * program's own no-finding cooldown unless `options.cooldownSeconds` overrides
 * them all.
 */
export function enqueueDogfoodBatch(queue: QueueStore, repository: string, options: DogfoodBatchOptions = {}): DogfoodBatchResult {
  const declared = options.programs === undefined ? undefined : new Set(options.programs);
  const offered = maintenancePrograms.filter((program) => declared === undefined || declared.has(program.id));
  const undeclaredKinds = maintenancePrograms.filter((program) => !offered.includes(program)).map((program) => program.discovery.kind);
  const batch = queue.enqueueInactiveRootBatch(
    repository,
    offered.map((program) => {
      const { repository: _repository, ...root } = discoveryRootFor(program, repository);
      return { ...root, cooldownSeconds: program.cooldownSeconds };
    }),
    options.cooldownSeconds === undefined ? {} : { cooldownSeconds: options.cooldownSeconds },
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
