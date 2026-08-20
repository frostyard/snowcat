# 0068 — Alias the ACMM contributing guide

- **Status:** Accepted
- **Date:** 2026-08-20

## Context

The `acmm:prereq-contrib-guide` criterion recognizes `CONTRIBUTING.md` at the
repository root. Snowcat already keeps its live contribution and agent
instructions in the canonical real [`AGENTS.md`](../../AGENTS.md), under the
single-instruction-surface decision in
[ADR-0002](0002-agent-portable-instruction-surface.md). A second regular file
would duplicate that guidance and could silently drift.

Core
[ADR-0029](https://github.com/frostyard/core/blob/main/docs/adr/0029-acmm-conformance-via-canonical-aliases.md)
provides the organization pattern: satisfy a file-path criterion with a
committed relative symlink when canonical content already exists, keep
directory criteria as real trees, and treat aliases as paths rather than new
documents.

## Decision

Snowcat satisfies exactly the contributing-guide criterion with this alias:

| Alias | Canonical target | Criterion |
| --- | --- | --- |
| `CONTRIBUTING.md` | `AGENTS.md` | `acmm:prereq-contrib-guide` |

`CONTRIBUTING.md` is a committed relative symlink, never a copy. Changes go to
`AGENTS.md`, not the alias. The alias is not a document: it receives no
`docs/README.md` index entry and has no independent cross-link obligations.
The real ADR is indexed.

`test/repository-surfaces.test.ts` pins the file type and exact relative target
so Snowcat's full `npm run check` gate rejects a copy, broken link, or
misdirected alias.

If an ACMM evaluator ever rejects a symlink for this file criterion,
`CONTRIBUTING.md` becomes a small real stub that points readers to
`AGENTS.md`. That bounded compatibility change does not reverse the
single-canonical-content decision.

## Consequences

- ACMM's accepted root path resolves to Snowcat's existing canonical
  contribution guidance without creating a second body of instructions.
- Tools and checkouts must preserve Git symlinks. A platform that materializes
  symlinks as plain files will fail the repository-surfaces test instead of
  drifting silently.
- Future ACMM aliases remain separate decisions; this ADR's registry contains
  only the contributing-guide alias.

## Alternatives considered

- **Copy `AGENTS.md` into `CONTRIBUTING.md`:** rejected because the copies
  would drift while claiming equal authority.
- **Add a content-free regular placeholder:** rejected because it would not
  guide contributors and would create a second document surface.
- **Leave the accepted path absent:** rejected because canonical content
  already satisfies the criterion through Core's established alias pattern.

## References

- Shapes: [canonical instructions and contribution guide](../../AGENTS.md) and
  [organization decisions](../org-adrs.md)
- Implements: [`test/repository-surfaces.test.ts`](../../test/repository-surfaces.test.ts)
- Builds on: [ADR-0002](0002-agent-portable-instruction-surface.md),
  [ADR-0062](0062-retire-hive-fluent-owns-conformance.md), and
  [core ADR-0029](https://github.com/frostyard/core/blob/main/docs/adr/0029-acmm-conformance-via-canonical-aliases.md)
