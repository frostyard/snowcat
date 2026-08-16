# 0022 — Focus quality on local correctness

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

[ADR-0021](0021-run-bounded-maintenance-assessments.md) defines the common
bounded assessment loop but leaves each maintenance specialist's scope open.
Continuous quality improvement can easily become an unbounded instruction to
“clean up the repository,” a pursuit of line-coverage percentages, or a route
for feature and bug-fix behavior to enter under a lower-risk label.

The role also overlaps adjacent programs. Flaky runs and workflow performance
belong to CI maintenance; vulnerabilities and trust failures belong to
security; package boundaries and broad refactors belong to architecture. The
quality role needs a useful local responsibility that does not absorb all three.

## Decision

The continuous-quality specialist improves local correctness, testability, and
maintainability without introducing product capabilities. Its canonical role
name is `quality`.

Quality owns:

- meaningful behavioral test gaps;
- missing error-path, boundary, and edge-case coverage;
- regression protection for important or recently changed behavior;
- misleading, brittle, redundant, or low-value tests;
- bounded behavior-preserving refactors with concrete validation evidence; and
- local dead code or needless complexity that can be removed without changing
  the product contract.

Quality does not own CI workflow execution, repeated-run trends, runner
configuration, or build performance; security vulnerabilities or trust
boundaries; package and component boundaries; broad dependency restructuring;
or product feature design. It may report an adjacent concern, but the
RepositoryController routes proposed work to CI, security, architecture, or
feature delivery rather than allowing quality authority to expand.

The RepositoryController selects one bounded assessment subject at an exact
repository commit. Initial selectors include one recently changed component,
one important behavior lacking regression protection, one error-handling path,
one weak test area, or one local maintainability hotspot. The brief includes
relevant prior findings, accepted outcomes, repository-declared validation,
available deterministic coverage facts, and the exact subject boundary. It
does not ask for a whole-repository quality audit.

A quality finding identifies:

- the exact behavior, symbol, path, or test involved;
- why the gap or local design harms correctness, testability, or maintenance;
- concrete current evidence and the observation method;
- a bounded proposed test or improvement;
- how the change can be validated; and
- any uncertainty, expected risk, or adjacent-program routing.

“No meaningful finding in this subject” is a valid successful assessment.
Coverage percentage, test count, changed-line count, linter output volume, and
similar scalar activity measures are evidence inputs, not sufficient findings
or success objectives. A worker MUST NOT manufacture tests merely to raise a
number.

An admitted quality implementation may add or improve tests and may perform a
small behavior-preserving refactor needed to improve testability or remove
local complexity. Its pull request must state the preserved behavior and
provide focused validation evidence. It MUST NOT add a product capability or
silently change externally observable behavior.

If assessment reveals an existing behavioral defect, the regression test and
behavior correction become separately scoped work unless an approved item
explicitly authorizes both at the resulting risk tier. A test-improvement item
does not provide implicit authority for a production behavior change. Broad or
cross-component refactors route to architecture; changed product intent routes
to feature delivery.

A quality finding is resolved only when the defined condition is re-evaluated
at an exact later commit with the required validation evidence. An opened issue,
reported pull request, passing unrelated CI, or increased aggregate coverage
does not by itself establish resolution.

## Consequences

- Quality has a meaningful remit without becoming a catch-all maintenance role.
- Bounded selectors make assessments comparable and reduce repeated full-repo
  analysis.
- Tests optimize for behavioral confidence rather than coverage theater.
- Small refactors remain possible when they have an explicit preserved contract
  and focused evidence.
- Defects and broad refactors may require another proposal and review cycle;
  this makes behavior and authority changes visible.
- Routing adjacent findings preserves useful observations but requires the
  RepositoryController to support cross-program proposal lineage.
- Exact selector order, cadence, hotspot calculation, evidence schema, and the
  threshold between local and architectural refactoring remain to be defined.

## Alternatives considered

- **Limit quality to test files:** rejected because testability often requires a
  small behavior-preserving production-code seam or simplification.
- **Allow quality to fix any discovered bug:** rejected because a read-only test
  assessment must not silently authorize behavior changes.
- **Optimize for aggregate coverage:** rejected because agents can increase the
  number with assertions that add little regression protection.
- **Make quality own CI flakiness:** rejected because identifying repeated-run
  behavior requires CI history and belongs to the CI program.
- **Make quality own all refactoring:** rejected because structural and
  cross-component changes require architecture scope and evidence.
- **Audit the entire repository each run:** rejected by the bounded assessment
  contract and because results would be expensive, repetitive, and hard to
  compare.

## References

- Specializes the bounded maintenance loop in
  [ADR-0021](0021-run-bounded-maintenance-assessments.md)
- Applies proposal admission from
  [ADR-0005](0005-admit-worker-created-work-before-claiming.md), canonical risk
  and boundary handling from
  [ADR-0017](0017-standardize-actions-boundaries-and-risk.md), and the
  RepositoryController boundary from
  [ADR-0020](0020-call-the-repository-coordinator-repositorycontroller.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [continuous quality workflow](../prd/agent-fleet.md#continuous-quality-workflow)
- External input: [Hive quality advisory policy](https://github.com/kubestellar/hive/blob/v4/v2/policies/quality-advisory.md)
- Implementation design, contract, and delivery plan: not yet authored
