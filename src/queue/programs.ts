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
 * value Fluent implements (Core's enum may be wider; ADR-0039). A program is a read-only discovery root that finds exactly one
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
  {
    id: "conformance",
    cooldownSeconds: WEEK,
    childCeiling: implementationCeiling,
    childAdmission: "proposed",
    discovery: {
      kind: "conformance-gap-discovery",
      objective: "Identify one evidence-backed way this repository does not satisfy the organization's binding contracts.",
      instructions:
        "Compare the repository with frostyard/core's binding ADRs (its docs/org-adrs.md against Core's current ADR set), the canonical repository surfaces of the surfaces contract (agent instructions, governance file, skills directory, documentation index — present, real content, valid), its `make ci` gate and title lint, and the ACMM criteria (the frostyard-acmm-conformance skill). Identify exactly one current gap; do not treat an aspiration as a binding contract or invent an organization standard. Do not edit files or open a GitHub artifact. Propose one bounded child only when justified: a compliance change in this repository, or — when the ADR is what should move — one bounded item to raise it with Core.",
      acceptanceCriteria: [
        "The result identifies exactly one gap between the repository and a named, current, binding organization contract.",
        "Evidence cites the contract (ADR, surfaces contract entry, ACMM criterion, or gate) and the repository path or output that fails it.",
        "Any follow-up is one bounded compliance change with a mechanically verifiable check, or one bounded item to raise the contract with Core; never both.",
      ],
      allowedActions: discoveryActions,
      priority: 0,
    },
  },
  {
    id: "triage",
    cooldownSeconds: DAY,
    childCeiling: ["read", "open-issue"],
    childAdmission: "proposed",
    discovery: {
      kind: "triage-discovery",
      objective: "Identify one open issue that needs a triage action: stale, duplicate, needs reproduction, mislabeled, or resolved but still open.",
      instructions:
        "Read the repository's open issues (and, for each candidate, its linked or referencing pull requests). Identify exactly one issue that is stale, a duplicate of another, missing a reproduction the reporter can supply, mislabeled, or resolved by a merged pull request yet still open. Do not edit files or open a GitHub artifact, and do not comment on, label, or close anything. Propose at most one child naming the exact issue and the exact action (close with a reason, label, ask for reproduction, link the duplicate); its actions may be at most read and open-issue, never a pull request. Children of this program are always proposals for the operator to admit.",
      acceptanceCriteria: [
        "The result identifies exactly one open issue and the one triage action it needs, with the evidence (the merged pull request, the duplicate, the last activity date, the missing information).",
        "Any follow-up names the issue URL and the action verbatim, is bounded to that one issue, and grants at most read and open-issue.",
        "No issue was commented on, labeled, or closed by this item.",
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
