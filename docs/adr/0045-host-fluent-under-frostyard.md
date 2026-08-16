# 0045 — Host Fluent under the Frostyard organization

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

Fluent began in `bketelsen/fluent` while its queue and provider integration
were exploratory. The product now exists to coordinate Frostyard repositories,
reads organization authority from `frostyard/core`, and is expected to use
organization-scoped GitHub Apps, teams, review rules, and repository enrollment.
Keeping its canonical source under a personal account would make those normal
organization controls a permanent special case.

A GitHub repository has a durable source-native identity distinct from its
owner/name locator. Moving the existing repository can preserve that identity
and its history; creating a replacement repository would not.

## Decision

The canonical source repository for Fluent is `frostyard/fluent`. On
2026-08-16, repository identity `1334681570` was transferred from
`bketelsen/fluent` without recreating the repository or changing its private
visibility, default `main` branch, commits, or Actions history.

Maintained local clones, automation, documentation, fixtures, and future
integrations use `frostyard/fluent` as the current display locator. The former
locator may remain in historical records when it identifies where an event
actually occurred, but those records must say that the repository was later
transferred. Redirect behavior at the former locator is compatibility only and
must not become maintained configuration.

Organization ownership does not enroll Fluent in the agent fleet. Enrollment
still requires the canonical declaration and review path in `frostyard/core`,
and runtime reconciliation still binds that declaration to the source-native
repository identity.

## Consequences

- Fluent can use Frostyard organization governance, teams, applications, and
  repository policy without a personal-account exception.
- Repository identity and history remain continuous across the locator change.
- Maintained references must use the Frostyard locator; historical evidence
  preserves the locator that was true when the evidence was collected.
- Any Frostyard organization defaults that apply to transferred repositories
  become part of Fluent's hosting environment and must be observed explicitly.
- A future move to another owner requires another explicit decision and locator
  reconciliation; code must not treat the current slug as immutable identity.

## Alternatives considered

- **Keep Fluent under `bketelsen`:** rejected because organization governance
  and integrations would retain an unnecessary personal-account exception.
- **Create a new `frostyard/fluent` repository and copy the source:** rejected
  because it would split source-native identity and historical artifacts.
- **Keep maintained references on the former locator and rely on redirects:**
  rejected because compatibility routing is not canonical configuration and
  can conceal stale ownership assumptions.

## References

- Shapes: [queue execution boundary](../design/queue-execution-boundary.md),
  [GitHub organization agent fleet](../prd/agent-fleet.md), and
  [product foundation roadmap](../plans/product-foundation-roadmap.md)
- Historical delivery record:
  [queue vertical spike](../plans/queue-vertical-spike.md)
- Builds on:
  [ADR-0007](0007-use-frostyard-core-as-the-organization-authority.md),
  [ADR-0015](0015-authorize-repository-enrollment-through-core.md), and
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md)
