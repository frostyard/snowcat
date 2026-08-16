# 0023 — Base CI maintenance on observed runs

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

[ADR-0021](0021-run-bounded-maintenance-assessments.md) defines a common
maintenance loop, and
[ADR-0022](0022-focus-quality-on-local-correctness.md) assigns behavioral test
gaps to quality. CI maintenance needs a separate responsibility: the system
that executes automated validation can be failing, flaky, slow, wasteful, or
misconfigured even when the underlying tests are appropriate.

CI diagnosis depends on historical facts. A coding agent looking at one failed
run can suggest a cause, but it cannot truthfully infer recurrence, flakiness,
or a duration regression without an observation window. Repeatedly asking an
agent to list runs would also waste capable-agent time on data collection that
the RepositoryController can perform deterministically.

## Decision

The CI-maintenance specialist preserves the reliability, diagnostic value, and
reasonable efficiency of the repository's automated validation system. Its
canonical role name is `ci-maintainer`.

The RepositoryController collects and retains bounded CI facts through its
read-only integration. Those facts include, when available:

- workflow, check, job, and run identities and conclusions;
- associated repository, commit, branch, and pull request;
- start, completion, queue, and duration timestamps;
- attempts, reruns, cancellations, and timeouts;
- normalized failure signatures derived without storing secrets; and
- required-check and validation configuration at an exact revision.

Every trend calculation names its deterministic query, source, inclusive time
or run window, sample size, exclusions, and calculation version. The
RepositoryController—not a model—computes recurrence, rerun outcomes, duration
baselines, cancellation rates, and similar aggregates. Missing or partial
telemetry remains explicit.

CI maintenance owns:

- current persistent workflow or required-check failures;
- recurring failure signatures and flaky tests supported by run history;
- slow, redundant, or wasteful workflow execution with material impact;
- missing, bypassed, or ineffective required validation;
- broken caching, dependency setup, runner, matrix, trigger, and workflow
  configuration; and
- CI-specific dependency and action pinning, subject to security policy.

Quality owns missing behavioral tests and test-content strength. Security owns
vulnerable actions, excessive permissions, untrusted workflow execution,
credential exposure, and provenance or trust failures. Architecture owns broad
build-system restructuring and cross-component boundaries. A CI finding that
touches `workflow-and-permissions`, `quality-gates`, or
`supply-chain-provenance` retains those protected boundaries and routes the
required review rather than weakening them.

A bounded CI assessment examines one incident, failure signature, flaky-test
candidate, workflow performance regression, ineffective gate, or configuration
problem. Its brief supplies the exact observation window and controller-
calculated facts. A single failed run may establish a current incident, but it
MUST NOT be described as recurring, regressed, or flaky without the required
historical evidence. “No meaningful CI problem in the observed window” is a
valid result.

A CI finding identifies:

- exact workflows, jobs, checks, runs, commits, or pull requests;
- the observation window, sample size, baseline, and exclusions;
- the normalized symptom or failure signature;
- frequency, rerun behavior, duration change, or gate effect as applicable;
- operational or maintainer impact;
- a bounded causal hypothesis and supporting repository evidence;
- a proposed change and validation plan; and
- uncertainty, risk, protected boundaries, and adjacent-program routing.

The specialist may diagnose the pattern and propose a workflow, runner,
configuration, or bounded test-stability change. Any implementation remains a
separately admitted item. It MUST NOT weaken or remove required checks merely
to make CI green, reduce security or review controls, suppress a failure without
preserving signal, or rewrite product behavior under CI authority.

Resolution uses the finding's defined post-change evidence window. One green
run may resolve a deterministic configuration incident when the acceptance
criteria say so; it does not resolve a flaky or performance finding that
requires repeated observations. An issue, pull request, disabled check, or
lower run count does not independently establish improvement.

## Consequences

- Models spend their effort diagnosing and fixing CI rather than collecting run
  lists and calculating basic trends.
- Every recurrence, flakiness, and performance claim can be reproduced from a
  named observation window.
- Current incidents remain actionable without being mislabeled as trends.
- CI and quality retain a clear boundary between execution reliability and test
  content.
- Protected workflow and supply-chain changes receive appropriate security and
  governance treatment.
- Historical collection consumes storage and API budget, so retention and
  polling must be bounded.
- Normalizing failure signatures can group unrelated failures or split related
  ones; the algorithm version and raw source references must remain available.
- Exact CI providers, collection cadence, retention, signature algorithm,
  materiality thresholds, and post-change evidence windows remain to be
  defined.

## Alternatives considered

- **Let each worker query and interpret recent runs:** rejected because the
  input window and calculations would vary by client and waste agent effort.
- **Treat every failed run as a trend:** rejected because one observation cannot
  establish recurrence, flakiness, or regression.
- **Require multiple failures before recording an incident:** rejected because
  a single current failure of a required gate may need immediate action.
- **Put all test failures under quality:** rejected because workflow, runner,
  retry, and repeated-run behavior are CI-system concerns.
- **Let CI remove failing gates:** rejected because green status obtained by
  weakening validation is not improved reliability.
- **Optimize raw duration regardless of impact:** rejected because small speed
  changes can create churn without improving contributor or operator outcomes.

## References

- Specializes the bounded maintenance loop in
  [ADR-0021](0021-run-bounded-maintenance-assessments.md)
- Maintains the boundary with quality from
  [ADR-0022](0022-focus-quality-on-local-correctness.md) and applies protected
  boundaries and change controls from
  [ADR-0017](0017-standardize-actions-boundaries-and-risk.md)
- Uses independent source verification consistent with
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md) and the
  RepositoryController boundary from
  [ADR-0020](0020-call-the-repository-coordinator-repositorycontroller.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [CI-maintenance workflow](../prd/agent-fleet.md#ci-maintenance-workflow)
- External input: [Hive CI maintainer full policy](https://github.com/kubestellar/hive/blob/v4/v2/policies/ci-maintainer-full.md)
- Implementation design, contract, and delivery plan: not yet authored
