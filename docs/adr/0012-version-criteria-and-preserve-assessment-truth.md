# 0012 — Version criteria and preserve assessment truth

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

Frostyard wants Hive-inspired ACMM levels and repository agentic-harness
requirements without inheriting vendor assumptions. [ADR-0008](0008-use-five-organization-record-kinds.md)
therefore defines an immutable criteria-set record. The product still needs to
say what a version means, how an assessment is represented, and how exceptions
affect a reported level.

A single pass/fail score would discard important distinctions. A requirement
may be inapplicable, covered by an approved exception, not yet examined, or
uncheckable because a verifier failed. Calling all of those either pass or fail
would make repository maturity look more certain than the evidence supports.

Criteria failures should guide maintenance, but an assessment must not become
another path that creates claimable work without admission.

## Decision

An accepted criteria set has a stable identifier and explicit version. Its
content is immutable: changing level definitions, criterion semantics,
applicability, required evidence, or verification creates a new version. Old
versions remain available so prior assessments and work citations continue to
resolve. The exact version syntax is deferred to the specification.

A criteria set defines ordered levels and stable criterion identifiers. Each
criterion declares its level, applicability, requirement, required evidence,
and either a named deterministic verifier or an authorized review attestation,
using the verification boundary from [ADR-0010](0010-enforce-policies-monotonically-with-expiring-exceptions.md).
Criteria describe portable behavior or evidence; a vendor-specific file is not
sufficient unless the criterion explicitly requires that artifact for a
portable behavioral reason.

Every assessment pins:

- repository and exact repository Git revision;
- criteria-set identifier and version;
- exact `frostyard/core` revision containing the criteria;
- evaluator identity, verifier versions, and evaluation time; and
- per-criterion result, evidence, and applicable exception.

The only criterion result states are `pass`, `fail`, `not-applicable`,
`excepted`, `unknown`, and `error`. `Not-applicable` requires deterministic
applicability or an authorized attestation. `Excepted` requires a currently
valid exception naming that exact criterion and version. Neither state is
stored as `pass`; `unknown` and `error` never satisfy a level.

Fluent derives the achieved level deterministically from all applicable
criteria at that level and every preceding level. `Pass`, `not-applicable`, and
a valid `excepted` result satisfy the calculation. Any displayed level with an
exception must include the exception count, such as “Level 2 (1 exception),”
and expose the waived criteria. Fluent must never present it as an
unqualified Level 2 result.

An assessment is a historical observation and does not mutate when criteria,
repository code, or exceptions later change. A current-status view may overlay
that an exception has expired or that a newer criteria version exists, without
rewriting the recorded result. Reassessment against a new repository revision
or criteria version creates a new assessment.

Worker-reported assessment evidence remains untrusted until its deterministic
verifier passes or an authorized reviewer attests it. Failed or unknown
criteria may produce proposed maintenance work with criterion and assessment
citations, but neither the criteria set nor assessment admits that work.

## Consequences

- Readiness claims remain reproducible against exact repository and criteria
  revisions.
- Dashboards distinguish failure, inapplicability, exception, missing evidence,
  and verifier failure instead of compressing them into a misleading score.
- Exceptions can permit a qualified level while remaining conspicuous and
  expiring according to ADR-0010.
- Criteria evolution never erases the meaning of historical assessments.
- Failed assessments can guide the maintenance queue without bypassing
  operator admission.
- Fluent needs immutable criteria storage, an assessment model, level
  computation, current-status overlays, and portable verifiers. None is
  implemented yet.

## Alternatives considered

- **Edit a criteria set in place:** rejected because old assessments would
  silently change meaning.
- **Reduce assessment to one score:** rejected because it hides evidence gaps,
  verifier errors, exceptions, and applicability.
- **Treat an exception as a pass:** rejected because waived compliance is not
  demonstrated compliance.
- **Make any exception prevent level attainment:** rejected because an approved
  exception intentionally permits operation; the qualified level keeps that
  fact visible without pretending the criterion passed.
- **Allow worker self-attestation:** rejected because a worker claim is
  provenance, not independent verification.
- **Create admitted remediation work for every failure:** rejected because a
  gap may be low value, incorrect, duplicate, or outside current goals and
  still requires admission.

## References

- Defines criteria-set semantics for
  [ADR-0008](0008-use-five-organization-record-kinds.md) and versioned authority
  from [ADR-0007](0007-use-frostyard-core-as-the-organization-authority.md)
- Uses policy verification and exception rules from
  [ADR-0010](0010-enforce-policies-monotonically-with-expiring-exceptions.md)
- Preserves deterministic control from
  [ADR-0004](0004-keep-models-outside-the-control-path.md) and admission from
  [ADR-0005](0005-admit-worker-created-work-before-claiming.md)
- Product: [maintenance fleet PRD](../prd/agent-fleet.md), especially
  [readiness criteria and assessments](../prd/agent-fleet.md#readiness-criteria-and-assessments)
- Implementation design, contract, and delivery plan: not yet authored
