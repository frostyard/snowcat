# 0017 — Standardize actions, boundaries, and risk

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

[ADR-0016](0016-read-only-canonical-repository-surfaces.md) establishes one
local agent-governance file and schema, but leaves its vocabulary open. The
existing policies mix three different questions:

- what operation an agent may perform;
- what sensitive system or trust boundary that operation affects; and
- how much review and evidence the resulting change needs.

Repository-specific verbs such as “submit Argo workflow,” “rotate
credentials,” and “publish results” cannot become permanent Fluent actions for
every repository. Collapsing them all into a generic `write` action would be
equally misleading. They need a small verb vocabulary plus independently
declared protected boundaries.

Risk tiers also drift. Snosi, pilothouse, and chairlift use four numbered tiers;
updex uses three numbered tiers; lab uses three named tiers. Allowing each scale
through the canonical schema would make cross-repository scheduling and review
requirements incomparable.

## Decision

The canonical `policies/agent-governance.json` v1 schema has exactly these
top-level fields:

```json
{
  "schema_version": 1,
  "default_decision": "deny",
  "actions": {},
  "protected_boundaries": [],
  "change_controls": {},
  "exception_controls": {},
  "risk_classification": {}
}
```

All fields are required and unknown fields are rejected. `default_decision` is
always `deny`. Action entries use only `allow`, `review-required`, or `deny`.
An omitted recognized action is denied. Across platform, organization,
enrollment, root, parent, and local-policy layers, decisions combine in the
order `deny` > `review-required` > `allow`; no layer can counteract a stricter
one.

### Action vocabulary

The actions Fluent may grant in v1 remain:

| Action | Meaning |
| --- | --- |
| `read` | Read repository content and public metadata; not credential stores |
| `write` | Modify the isolated working tree and create local commits |
| `run-tests` | Execute repository-declared validation in the worker's environment |
| `open-issue` | Create an issue in the work repository |
| `open-pr` | Push a non-protected work branch and open or update its pull request |
| `create-followup` | Propose bounded child work through Fluent |

The shared schema also recognizes these reserved actions so repository policy
and non-Fluent agents can express them consistently:

`approve-pr`, `merge-pr`, `push-protected-branch`, `publish-artifact`,
`publish-release`, `deploy`, `modify-protected-environment`, and
`manage-credentials`.

Fluent's v1 platform policy always denies every reserved action. Listing one as
`allow` locally cannot grant it. Adding or changing an action's meaning requires
a new governance schema version; repositories cannot add custom action names.

### Protected-boundary vocabulary

V1 defines these broad boundary identifiers:

- `authentication`;
- `credentials-and-sensitive-data`;
- `cryptographic-trust`;
- `destructive-data`;
- `installation-and-update`;
- `release-and-publication`;
- `deployment-and-infrastructure`;
- `workflow-and-permissions`;
- `quality-gates`;
- `supply-chain-provenance`; and
- `security-disclosure`.

A repository policy selects the boundaries it actually has. Each selected
boundary declares `deny` or `review-required`, a minimum risk tier, bounded
repository-relative path patterns where applicable, and any named deterministic
detectors. Boundaries only narrow an otherwise permitted action; they never
carry `allow`. Unknown boundary names, unbounded path traversal, and unknown
detectors fail validation.

Work proposed or seeded for implementation declares the boundaries it expects
to affect. A worker's declaration is untrusted: admission confirms it, path
matching and named detectors may add boundaries, and completion or artifact
review rechecks the actual changed paths. Omitting a detected boundary cannot
lower the decision or risk tier.

### Mandatory controls

The v1 schema requires these change controls to be enabled:

- changes go through pull requests;
- a human reviews before merge;
- every change receives the highest applicable risk classification;
- validation evidence is recorded;
- permissions stay least-privilege; and
- untrusted repository, issue, comment, downloaded, and tool content is treated
  as data rather than higher-priority instruction.

The policy also names guardrails that may tighten but never relax:
`required-checks`, `security-checks`, `review-requirements`,
`coverage-checks`, and `provenance-verification`.

Exception controls require an independent authorized approver, prohibit self-
approval, and require a rationale, exact target, compensating controls, expiry,
and restoration or closure plan. These fields govern repository-local review;
the accepted exception itself remains the core record defined by ADR-0010.

### Risk classification

All repositories use four ordered tiers:

| Tier | Meaning | Minimum handling |
| --- | --- | --- |
| `low` | No runtime, policy, security, workflow, build, or release effect | Relevant checks and normal review |
| `moderate` | Bounded routine behavior or tooling outside protected boundaries | Focused success/failure tests and maintainer review |
| `high` | Broad behavior, CI/build, dependencies, persistence, external commands, or operational impact | Failure analysis, targeted negative tests, knowledgeable review, and rollback notes |
| `critical` | Credentials, trust, destructive operations, privileged environments, publication, deployment, or another protected security boundary | Threat/abuse analysis, security-owner review, adversarial or end-to-end evidence, and explicit rollback plan |

Every change uses the highest applicable tier. Uncertain impact is classified
at the higher plausible tier until evidence narrows it. Repository policies may
raise a boundary's minimum tier but cannot define another scale or lower the
core minimum. Fluent work and resulting pull-request provenance retain the
selected tier, rationale, affected boundaries, and required evidence.

### Migration

Migration preserves every existing restriction:

- snosi action denials map directly; installer/update boundaries map to
  `installation-and-update`, signing/Secure Boot/TPM to
  `cryptographic-trust`, and its existing four tiers map directly;
- lab's cluster, Argo, and RBAC operations map to reserved deployment or
  protected-environment actions plus `deployment-and-infrastructure`; evidence
  publication maps to `release-and-publication`; its `medium` tier becomes
  `moderate`, and its former `high` cases split between `high` and `critical`;
- updex's accountability booleans map to action decisions, least-privilege and
  untrusted-input fields map to change controls, guardrails map to
  `never-relax`, and its Tier 3 security cases become `critical` where the new
  definition requires it; and
- any source rule without a lossless canonical mapping blocks that repository's
  migration until core adds a new schema version or records an explicit policy
  decision. It is not dropped into prose or silently weakened.

## Consequences

- Work authority, sensitive scope, and review depth become separate, composable
  facts rather than repository-specific boolean shapes.
- Fluent can calculate one monotonic decision without learning product-specific
  verbs or guessing that two nested fields mean the same thing.
- The action vocabulary remains small enough for MCP clients while reserved
  operations remain expressible and visibly denied.
- Boundary path matching can catch under-classified changes, though non-path
  effects still require named detectors or accountable review.
- A four-tier model makes organization reporting comparable and preserves a
  distinct critical tier for high-consequence changes.
- Migrating lab and updex requires judgment; a mechanical key rename is not
  sufficient.
- Core needs the exact JSON Schema, pattern grammar, detector registry,
  conformance fixtures, risk policy, and migration PRs. Fluent needs boundary
  fields and policy decisions. None is implemented yet.

## Alternatives considered

- **Use every existing action name:** rejected because repository product
  details would become global API surface.
- **Represent everything as `write`:** rejected because changing docs, rotating
  credentials, deploying a cluster, and merging a PR have radically different
  authority and evidence requirements.
- **Allow namespaced repository actions:** rejected for v1 because adapters and
  UI would still need custom semantics; broad boundaries cover the known cases.
- **Use boundaries as actions:** rejected because one operation may touch
  several boundaries and the same boundary may affect reads, writes, or
  publication differently.
- **Retain per-repository risk scales:** rejected because organization-level
  reporting and policy could not compare them reliably.
- **Use three tiers:** rejected because the majority four-tier model usefully
  separates broad high-risk engineering from credentials, destructive
  operations, and trust-root changes.
- **Let repositories weaken mandatory controls:** rejected because local policy
  may narrow organization authority but cannot relax its governance baseline.

## References

- Completes the canonical governance surface defined by
  [ADR-0016](0016-read-only-canonical-repository-surfaces.md)
- Preserves monotonic policy and exception semantics from
  [ADR-0010](0010-enforce-policies-monotonically-with-expiring-exceptions.md)
  and the v1 queue ceiling from
  [ADR-0003](0003-separate-work-coordination-from-execution.md)
- Product: [maintenance fleet PRD](../prd/agent-fleet.md), especially
  [canonical governance vocabulary](../prd/agent-fleet.md#canonical-governance-vocabulary)
- Implementation design, contract, and delivery plan: not yet authored
