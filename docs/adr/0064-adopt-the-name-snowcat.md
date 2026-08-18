# 0064 — Adopt the name Snowcat

- **Status:** Accepted
- **Date:** 2026-08-18

## Context

"Fluent" was a working name from the discovery draft; the PRD, the domain
language, and `AGENTS.md` all say so. The other frostyard products are named
for the working objects of a mountain (chairlift, pilothouse, firn, igloo,
updex's sysexts), and this one has become the thing that keeps the fleet's
repositories runnable overnight: on a cadence, mechanically, without deciding
what opens — the snowcat that grooms the runs while everyone else is asleep.

The name is referenced widely: the GitHub repository and npm package, the
MCP server name, environment variables (`FLUENT_*`), systemd units and host
paths (`fluent-*.service`, `/etc/fluent`, `/var/lib/fluent`), the `fluent`
issue label that hands the queue work, three skills (`work-fluent-queue`,
`write-fluent-issues`, `model-fluent-domain`), and, in `frostyard/core`, the
declaration `organization/repositories/frostyard/fluent.json`, the
`.github/skills-sync.json` entry, and the `labels.required` value of the
repository settings contract. Prose mentions in accepted core ADRs 0035–0040
and links to `github.com/frostyard/fluent/...` are not affected: ADRs are
immutable, GitHub redirects a renamed repository, and core ADR-0033 allows
link-only maintenance later.

## Decision

- The product is **Snowcat**. The repository becomes `frostyard/snowcat`
  (GitHub keeps the immutable repository ID, so enrollment continues), the
  package `@frostyard/snowcat`, and the MCP server `snowcat`.
- **The queue label becomes `snowcat`** in every enrolled repository (a
  GitHub label rename keeps its issues), in the feed timer, the runbook and
  skills, and in core's repository settings contract — the label is the
  fleet's word for "queued for the fleet," and it follows the product name.
- **Skills** are renamed `work-snowcat-queue`, `write-snowcat-issues`,
  `model-snowcat-domain`; core's skill-sync entry follows.
- **Compatibility, one release:** `SNOWCAT_*` environment variables are
  preferred and `FLUENT_*` are read as fallbacks with a deprecation line;
  the installer migrates `/etc/fluent/env` → `/etc/snowcat/env` and
  `/var/lib/fluent` → `/var/lib/snowcat` in place (move, never copy) and
  installs `snowcat-*.service` units, removing the `fluent-*` ones it
  installed; the queue store gains one attributed operator command to rename
  a repository slug (`frostyard/fluent` → `frostyard/snowcat`) across
  repositories, items, and events without touching history.
- **Order:** this ADR; the GitHub rename; the core pull request (declaration
  path and name, sync entry, contract label); the label rename in the four
  repositories with the timer flag; then the code, env, unit, and skill
  renames in one release with the compatibility above. Each step is
  reversible on its own.

## Consequences

- One name across repository, package, server, units, label, and skills;
  the fleet's vocabulary ("groomed overnight," "queued for the snowcat")
  stops fighting the metaphor of the rest of the organization.
- One release carries both spellings of every environment variable and
  path; operators re-run the installer once; workers re-add the MCP server
  under its new name; the domain language and every doc gain a rename
  commit.
- Accepted core ADRs keep saying "Fluent"; readers of history will meet the
  old name, which is why this ADR exists.

## Alternatives considered

- **Keep "Fluent":** rejected; it was never meant to be final and does not
  belong to the mountain.
- **Groomer / Musher / Patrol / Plow:** considered; Snowcat names the
  machine rather than the job or the driver, matching how the other
  products are named.
- **Rename the repository but keep the `fluent` label:** rejected; a
  vocabulary split for a one-time relabel is not worth carrying.

## References

- Shapes: [how Snowcat works](../design/how-snowcat-works.md),
  [queue operations runbook](../design/queue-operations.md),
  [ubiquitous language](../domain/ubiquitous-language.md),
  [work queue](../specs/work-queue.md)
- Builds on: [ADR-0002](0002-agent-portable-instruction-surface.md),
  [ADR-0059](0059-adopt-the-queue-store-as-the-v1-work-engine.md)
- Core: `organization/repositories/frostyard/fluent.json`,
  `.github/skills-sync.json`, the repository settings contract (core
  ADR-0040)
