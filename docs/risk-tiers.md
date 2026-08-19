# Change Risk Tiers

Every pull request must declare one risk tier (core
[ADR-0019](https://github.com/frostyard/core/blob/main/docs/adr/0019-governance-as-code-and-risk-tiers.md)).
The classification determines the review evidence and scrutiny needed in
addition to the repository's normal `npm run check` gate.

Choose the highest tier whose criteria match any part of the change. Consider
blast radius, privileges and trust boundaries, reversibility, compatibility,
and release or supply-chain impact — highest applicable, never lower. When
uncertain, choose the higher tier. Reviewers may reclassify a pull request if
its scope or risk changes.

## Tier 1: Low

Changes that do not alter runtime behavior or a protected boundary.

Examples include:

- documentation, comments, spelling, or formatting;
- test-only changes that do not modify production behavior;
- mechanical refactoring with equivalent behavior; and
- repository metadata that does not change CI permissions or release
  behavior.

**Required evidence:** Describe the scope, explain why behavior is unchanged,
and complete the applicable rows of `npm run check`. If tests are not
applicable, say why in the pull request.

## Tier 2: Moderate

Changes to normal Snowcat behavior with limited, understood impact and no
change to a protected boundary.

Examples include:

- ordinary bug fixes and feature additions in `src/queue/`, `src/control/`,
  `src/core/`, `src/repository/`, or `src/surface/` that do not touch a
  boundary listed under Tier 3;
- MCP tool behavior changes that stay compatible with existing callers;
- configuration or output parsing changes that do not cross a trust
  boundary; and
- changes spanning multiple packages that remain within the existing
  contracts.

**Required evidence:** Add focused success- and failure-path tests, update
the affected design docs or specs, and describe compatibility, failure, and
rollback considerations. A maintainer must confirm that the classification
and evidence are appropriate.

## Tier 3: High

Changes with broad behavioral, CI/build, dependency, persistence, or
operational impact that do not themselves cross a protected security
boundary.

Examples include:

- broad behavioral change across the queue, control plane, or surface;
- CI and build changes outside `.github/workflows/**` — test configuration,
  build scripts, and the checks `npm run check` runs;
- dependency and lockfile changes (`package.json`, `package-lock.json`);
- the queue schema migration ladder (`src/queue/store.ts`,
  `SCHEMA_VERSION`) or control-plane schema and migrations
  (`src/control/store.ts`, `CONTROL_PLANE_SCHEMA_VERSION`); and
- external commands and operational behavior that do not change what runs on
  the operator host or with what privileges.

**Required evidence:** Obtain maintainer review of the reliability impact.
Document failure modes, compatibility impact, and rollback or recovery.
Include targeted negative tests for the failure paths. The author or
generating agent must not self-approve, auto-merge, or weaken a required
check.

## Tier 4: Critical

Changes touching credentials, trust, destructive operations, privileged
environments, publication, deployment, or another protected security
boundary — including every protected boundary in
[`policies/agent-governance.json`](../policies/agent-governance.json).

Examples include:

- the `workflow-and-permissions` boundary: anything under
  `.github/workflows/**`;
- the `credentials-and-sensitive-data` boundary: `src/github/**`,
  `src/queue/artifact-verification.ts`, `src/queue/github-issues.ts`, and
  `src/repository/github-api.ts`;
- the `authentication` boundary: `src/mcp/**`, `src/app.ts`,
  `src/queue/eligibility.ts`, `src/auth/**`, `src/surface/session.ts`, and
  `src/surface/app.ts`;
- credential handling anywhere — tokens, session secrets, `/etc/snowcat/env`
  — and anything that changes who may authenticate or what they may do;
- publication and release: anything that publishes an artifact or changes
  what a release contains; and
- deployment: deploy units under `deploy/` (systemd services/timers,
  `install.sh`, `upgrade.sh`, the Incus profile and bootstrap script) that
  change what runs on the operator host or with what privileges, and
  destructive operations against live databases.

**Required evidence:** Provide a threat and abuse analysis naming the trust
boundary crossed. Obtain security-owner review. Include adversarial or
end-to-end evidence that the boundary holds. State an explicit rollback
plan. The author or generating agent must not self-approve, auto-merge,
weaken a required check, or disclose vulnerability details in a public pull
request.

## Classification workflow

1. The author selects one tier and gives a short rationale in the pull
   request template.
2. Reviewers verify the tier before approval and apply the corresponding
   requirements above.
3. The author updates the tier and evidence if the change grows in scope.
4. `npm run check` and human review still apply at every tier. A lower tier
   never exempts a change from the gate or overrides a higher-risk
   criterion above.
