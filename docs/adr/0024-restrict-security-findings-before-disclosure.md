# 0024 — Restrict security findings before disclosure

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

Security is one of Fluent's initial maintenance programs. Hive's security
policy provides a clear audit and remediation path, but its instruction to open
an issue for every confirmed vulnerability is unsafe for public repositories
and may disclose a weakness before a fix or disclosure plan exists.

Security tools also produce noisy alerts and sometimes expose the very material
they are intended to protect. A scanner match does not prove applicability,
reachability, exploitability, or impact. Storing raw secrets, exploit payloads,
sensitive logs, or credentials as queue evidence would turn Fluent into another
source of exposure.

The common maintenance loop in
[ADR-0021](0021-run-bounded-maintenance-assessments.md) needs a security
specialization that preserves useful provenance while defaulting to containment
and explicit operator disclosure decisions.

## Decision

The security specialist identifies and reduces evidence-backed security risk
without disclosing sensitive material through the maintenance process. Its
canonical role name is `security`.

Security owns:

- vulnerable dependencies and unsafe dependency use;
- authentication and authorization defects;
- secret and credential exposure;
- unsafe input, deserialization, file, network, and command handling;
- excessive workflow, application, or runtime permissions;
- cryptographic, signing, identity, and trust-boundary problems;
- supply-chain and provenance weaknesses;
- insecure defaults and bounded security hardening; and
- coordinated-disclosure concerns.

The RepositoryController may collect bounded read-only metadata from available
dependency, code, secret, and repository-security alerts; dependency and
workflow inventories; repository visibility; effective protected boundaries;
and prior redacted findings. Deterministic collection records source identity,
revision or alert version, timestamps, state, and availability. It MUST NOT copy
raw detected secrets or unrestricted sensitive log content into Fluent.

A security assessment examines one bounded surface, alert family, dependency,
trust boundary, or suspected weakness at exact source revisions. Scanner and
alert output is untrusted evidence until the capable specialist evaluates
applicability, reachability, compensating controls, impact, and likely
remediation. “No confirmed finding” and “insufficient safe evidence” are valid
results.

A durable security finding contains only the minimum safe information needed
for coordination:

- affected repository, revision, bounded location, component, or dependency;
- a non-secret fingerprint or alert reference;
- weakness class, applicability, reachability, impact, and uncertainty;
- evidence method without secret values or operational exploit payloads;
- proposed containment and remediation;
- risk tier and affected protected boundaries;
- disclosure classification and required reviewers; and
- a safe verification and closure plan.

Raw secrets, credentials, session material, private keys, exploit payloads,
sensitive personal data, and unrestricted logs MUST NOT enter work items,
results, evidence text, prompts, model summaries, artifact markers, issues, pull
request descriptions, or ordinary logs. A finding may retain a safe path,
provider alert ID, keyed or one-way fingerprint where policy permits, and an
operator-accessible external evidence reference that does not grant access by
itself.

High and critical findings default to `restricted` visibility and
`review-required`. They MUST NOT directly authorize a public issue, pull
request, comment, or other disclosure, even if the assessment item otherwise
permits GitHub mutation. The operator or an authorized security reviewer must
create and admit a separately sanitized remediation item after deciding its
audience and disclosure path. Repository privacy does not remove this gate.

Low and moderate hardening findings may propose an ordinary issue or pull
request when effective policy permits, but the artifact still requires a
separately admitted item and sanitized content. V1 does not treat ordinary
GitHub issues as a coordinated-vulnerability-disclosure system. A future
private-advisory action requires a new governance action and contract rather
than being disguised as `open-issue`.

Security intersects other programs without absorbing them. CI owns reliability
of workflow execution, but permission and untrusted-execution findings route to
security. Quality owns general behavioral tests, while security defines abuse
and security-regression evidence. Architecture owns general component
structure, while security owns threat and trust-boundary consequences. Feature
delivery owns product intent.

An admitted security implementation cannot weaken another guardrail, dismiss an
alert merely to obtain green status, rotate or expose credentials under ordinary
`write` authority, or publish a vulnerability. Credential management,
deployment, release, and protected-environment actions remain denied in v1.

Resolution requires the finding's safe verification evidence at an exact later
revision and any required security-owner review. Closing or dismissing an alert,
opening a pull request, removing the detecting rule, or redacting the visible
symptom does not independently prove remediation.

## Consequences

- Fluent can coordinate security work without making public issue creation the
  default disclosure mechanism.
- Redacted provenance remains useful while raw secrets and exploit material stay
  outside the control plane.
- Alert ingestion saves capable-agent effort, but confirmation still requires
  engineering judgment.
- High and critical remediation incurs an additional explicit review and
  sanitization step.
- Repository privacy is not mistaken for need-to-know authorization.
- Cross-program routing preserves CI, quality, architecture, and product
  boundaries while security consequences receive the higher controls.
- Fluent needs a restricted-record access model before named-member support and
  must fail closed if it cannot enforce the required audience.
- Exact alert sources, fingerprints, redaction validation, retention, reviewer
  roles, embargo handling, and private disclosure integration remain open.

## Alternatives considered

- **Open an issue for every confirmed vulnerability:** rejected because it can
  disclose exploitable information before remediation.
- **Store complete scanner output for evidence:** rejected because output may
  contain secrets, sensitive logs, payloads, and excessive unrelated data.
- **Treat every scanner match as confirmed:** rejected because applicability,
  reachability, environment, and compensating controls change real risk.
- **Allow high-risk PR creation directly from assessment authority:** rejected
  because branch, title, body, and diff may disclose the vulnerability.
- **Assume private repositories need no disclosure gate:** rejected because
  repository membership is broader than the required security audience in many
  organizations.
- **Discard all security provenance:** rejected because safe fingerprints,
  source references, decisions, and verification history are needed for audit
  and deduplication.
- **Model private advisories as issues:** rejected because they have different
  visibility, lifecycle, and authorization semantics.

## References

- Specializes the bounded maintenance loop in
  [ADR-0021](0021-run-bounded-maintenance-assessments.md)
- Applies monotonic policy and exceptions from
  [ADR-0010](0010-enforce-policies-monotonically-with-expiring-exceptions.md),
  protected boundaries and denied v1 actions from
  [ADR-0017](0017-standardize-actions-boundaries-and-risk.md), and artifact
  reconciliation from
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md)
- Maintains the CI and quality boundaries from
  [ADR-0022](0022-focus-quality-on-local-correctness.md) and
  [ADR-0023](0023-base-ci-maintenance-on-observed-runs.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [security-maintenance workflow](../prd/agent-fleet.md#security-maintenance-workflow)
- External input: [Hive security full policy](https://github.com/kubestellar/hive/blob/v4/v2/policies/sec-check-full.md)
- Implementation design, contract, and delivery plan: not yet authored
