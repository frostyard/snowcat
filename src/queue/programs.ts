import type { RepositoryMaintenanceProgram } from "../control/registry.ts";
import type { AllowedAction, SeedWorkInput } from "./types.ts";

/** A discovery root definition without the repository and author the feeder supplies. */
export type DiscoveryTemplate = Omit<SeedWorkInput, "repository" | "createdBy" | "delegableActions">;

export interface MaintenanceProgram {
  /** The Core `maintenance_programs` value this program serves. */
  id: RepositoryMaintenanceProgram;
  /** The read-only discovery root the feeder seeds. */
  discovery: DiscoveryTemplate;
  /** The widest actions a child of the discovery root may be granted (`delegableActions`). */
  childCeiling: AllowedAction[];
  /** How children enter the queue: today always `proposed`, awaiting operator admission. */
  childAdmission: "proposed";
  /** No-finding cooldown: how long a completed root that proposed nothing suppresses re-asking. */
  cooldownSeconds: number;
}

const discoveryActions: AllowedAction[] = ["read", "create-followup"];
const implementationCeiling: AllowedAction[] = [
  "read",
  "write",
  "run-tests",
  "open-issue",
  "open-pr",
  "create-followup",
];

const DAY = 24 * 60 * 60;
const WEEK = 7 * DAY;

/**
 * The maintenance program catalog: one entry per Core `maintenance_programs`
 * value. A program is a read-only discovery root that finds exactly one
 * evidence-backed thing and proposes at most one bounded child; the operator
 * admits; a worker lands it through one pull request; Fluent verifies the
 * artifact. Entries differ in what they look at (`discovery`), how often a
 * no-finding answer suppresses re-asking (`cooldownSeconds`), how wide a child
 * may be (`childCeiling`), and how children enter the queue (`childAdmission`,
 * always `proposed` today). Adding a program is one entry here plus its Core
 * enum value; the discovery text of the first four is unchanged from the
 * original dogfood feeder.
 */
export const maintenancePrograms: readonly MaintenanceProgram[] = [
  {
    id: "quality",
    cooldownSeconds: DAY,
    childCeiling: implementationCeiling,
    childAdmission: "proposed",
    discovery: {
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
      priority: 0,
    },
  },
  {
    id: "ci",
    cooldownSeconds: DAY,
    childCeiling: implementationCeiling,
    childAdmission: "proposed",
    discovery: {
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
      priority: 0,
    },
  },
  {
    id: "security",
    cooldownSeconds: DAY,
    childCeiling: implementationCeiling,
    childAdmission: "proposed",
    discovery: {
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
      priority: 0,
    },
  },
  {
    id: "architecture",
    cooldownSeconds: WEEK,
    childCeiling: implementationCeiling,
    childAdmission: "proposed",
    discovery: {
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
      priority: 0,
    },
  },
];

/** The catalog entry for a Core program id. */
export function maintenanceProgram(id: RepositoryMaintenanceProgram): MaintenanceProgram {
  const program = maintenancePrograms.find((candidate) => candidate.id === id);
  if (program === undefined) throw new Error(`unknown maintenance program: ${id}`);
  return program;
}

/** The seed input for a program's discovery root in `repository`, authored by the feeder. */
export function discoveryRootFor(program: MaintenanceProgram, repository: string, createdBy = "operator:dogfood"): SeedWorkInput {
  return { ...program.discovery, delegableActions: program.childCeiling, repository, createdBy };
}
