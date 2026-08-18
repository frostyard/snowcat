# 0062 — Retire Hive; Fluent owns repository conformance and triage

- **Status:** Accepted
- **Date:** 2026-08-18

## Context

Two automations worked the same repositories in August 2026. Hive scanned
`frostyard` repositories for ACMM conformance and quality issues and opened
issues and pull requests on its own; Fluent imported `fluent`-labeled issues
and ran bounded discovery programs through its queue. On 2026-08-18 Hive fixed
issues Fluent's workers had already fixed the same day (updex #313 was Hive's
`make lint` fix, rebased by a Fluent worker), and the same morning an ACMM
conformance agent worked in the operator's updex checkout while Fluent
workers read it. The recovery plan carried the boundary as an open question:
skip `fluent`-labeled issues in Hive, or import only what Hive would not
take. Both keep two authorities over one repository.

Fluent now runs maintenance from a program catalog with per-program cadence
([ADR-0021](0021-run-bounded-maintenance-assessments.md), plan Phases 1–4),
honors each repository's Core declaration, and Core's `maintenance_programs`
enum names `conformance` and `triage` (core ADR-0039). What conformance
checks — Core's binding ADRs, the canonical repository surfaces of the
surfaces contract, `make ci`, title lint, the ACMM criteria — is exactly what
Fluent already reads to enroll a repository.

## Decision

- **Hive is retired.** It no longer opens issues or pull requests on
  `frostyard` repositories. Its ACMM criteria become inputs to Fluent's
  `conformance` program, through the `frostyard-acmm-conformance` skill.
- **Fluent's `conformance` program owns repository conformance:** a weekly,
  read-only discovery root that compares the repository with Core's binding
  ADRs, the canonical surfaces, its CI gate, and the ACMM criteria, and
  proposes at most one bounded compliance change — or one Core issue when the
  ADR is what should move (the ADR-0022 → ADR-0038 case). Children are
  proposals; a compliance change lands through one pull request like any
  other work.
- **Fluent's `triage` program owns issue hygiene:** a daily, read-only
  discovery root over the repository's open issues — stale, duplicate,
  needs-reproduction, mislabeled, or resolved by a merged pull request but
  still open — proposing at most one bounded child per finding. Its children
  are always proposals, never admitted on creation, because closing or
  labeling an issue is outward-facing; each proposal names the exact issue
  and the exact action, and its ceiling is `read, open-issue` (issue mutation
  authority: comment, label, close), never a pull request.
- A repository opts into either program by declaring it in Core; the operator
  admits their children from the inbox.

## Consequences

- One authority per repository: what Fluent's programs find is the
  maintenance backlog; nothing else opens work on an enrolled repository
  without going through the queue.
- ACMM conformance stops being a scan that files issues and becomes a program
  whose findings are proposals with evidence, on the operator's cadence.
- Triage findings that would close issues wait for admission; the plan
  watches the admission rate before deciding whether any triage child may
  ever be admitted on creation.
- Anything Hive did that neither program covers is a new catalog entry, not a
  second scanner.

## Alternatives considered

- **Hive skips `fluent`-labeled issues:** rejected; two authorities still
  disagree about everything unlabeled, and duplicates recur.
- **Fluent imports only what Hive would not take:** rejected; Fluent's queue
  is meant to be the maintenance backlog, not the remainder.
- **Keep ACMM as Hive's and give Fluent only Core-ADR drift:** rejected; the
  criteria overlap almost entirely and the operator wanted one owner.

## References

- Shapes: [maintenance programs plan](../plans/maintenance-programs.md)
  (Phase 5), [recovery plan](../plans/recover.md) (Hive boundary),
  [queue operations runbook](../design/queue-operations.md),
  [work queue](../specs/work-queue.md)
- Builds on: [ADR-0021](0021-run-bounded-maintenance-assessments.md),
  [ADR-0009](0009-apply-goals-through-discovery-and-admission.md),
  [ADR-0059](0059-adopt-the-queue-store-as-the-v1-work-engine.md)
