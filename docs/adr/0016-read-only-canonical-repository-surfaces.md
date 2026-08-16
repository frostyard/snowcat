# 0016 — Read only canonical repository surfaces

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

Frostyard repositories currently contain several machine-readable files that
core ADR-0019 groups under governance, but they are not one contract:

- snosi and lab use `policies/agent-governance.json` with deny-by-default
  action maps, change controls, protected boundaries, and exception rules;
- updex uses `.github/policies/ai-governance.json` with a different nested
  controls schema;
- pilothouse's `policies/repository.yaml` is a required-file and glob manifest,
  not an agent authorization policy; and
- chairlift's `.github/policies/auto-qa-tuning.json` configures a quality loop,
  not general agent authority.

Teaching Fluent to search common paths, guess formats, and normalize these
files would preserve accidental divergence as a permanent product contract.
It would also repeat the vendor-specific discovery problem that the canonical
`AGENTS.md` surface already solved.

[ADR-0015](0015-authorize-repository-enrollment-through-core.md) makes core the
authority for enrollment. Core should likewise publish the canonical
repository surfaces that an enrolled repository promises to provide.

## Decision

Core owns a versioned repository-surface contract at:

```text
organization/contracts/repository-surfaces/v1.json
```

and validates it with:

```text
organization/schemas/v1/repository-surfaces.schema.json
```

Every repository enrollment declaration names one supported surface-contract
version. The contract maps stable surface IDs to one canonical repository path,
artifact type, and schema where applicable. It is immutable after acceptance;
changing a path, meaning, or schema association creates a new contract version
and an explicit repository migration.

The initial contract contains only surfaces with an established consumer:

| Surface ID | Canonical repository path | Type | Consumer |
| --- | --- | --- | --- |
| `agent-instructions` | `AGENTS.md` | Markdown file | Workers and repository context |
| `agent-governance` | `policies/agent-governance.json` | Strict JSON | Fluent policy evaluation and repository CI |
| `agent-skills` | `.agents/skills/` | Directory tree | Workers |
| `documentation-index` | `docs/README.md` | Markdown file | Workers and repository context |

Core owns the one v1 local governance schema at:

```text
organization/schemas/v1/repository-agent-governance.schema.json
```

It is deny-by-default, uses a canonical action and protected-boundary
vocabulary, declares required change controls and exception governance, rejects
unknown properties, and remains tool-agnostic. Repository policy may add
denials, boundaries, or review requirements, but cannot widen the organization
policy, enrollment declaration, root work item, parent delegation, or Fluent
platform ceiling. Exact fields and vocabularies land with the schema and
conformance fixtures.

A canonical file path must resolve to a regular Git blob, and a canonical
directory path must resolve to a real Git tree. It cannot itself be a symlink,
submodule, generated build artifact, or chain of aliases. Compatibility and
provider-specific paths may be committed relative symlinks that point *to* the
canonical surface. Fluent reads only the canonical path and never searches,
follows aliases, or falls back to legacy locations.

For each repository revision it evaluates, Fluent reads the surface contract
from the active core snapshot, selects the exact repository Git commit, and
loads the canonical blobs and trees from Git without executing repository code.
It validates the local governance file with its bundled copy of core's schema
and pins the repository commit, surface-contract version, schema version,
content hash, and parsed policy in the policy decision. A missing, wrong-type,
invalid, unknown-version, or digest-incompatible required surface places that
repository on hold; Fluent does not guess what the author meant.

Existing outliers are migration inputs, not formats Fluent supports forever:

- snosi and lab keep `policies/agent-governance.json` and migrate their content
  to the exact common schema;
- updex moves and adapts its policy to
  `policies/agent-governance.json`; its former path may become a relative
  compatibility symlink to the canonical file;
- pilothouse's structural manifest remains a repository-local CI detail and is
  not read as agent governance; and
- chairlift's quality-loop tuning remains separate configuration and is not
  read as agent governance.

No catch-all surface registry is created for files without a Fluent or worker
consumer. When another artifact class needs machine consumption, core defines
one canonical path and schema in a new surface-contract version before Fluent
supports it.

## Consequences

- “Where does Fluent read this?” has one versioned answer rather than a search
  list or format adapter chain.
- Repository CI and Fluent evaluate the same canonical governance schema while
  repositories retain stricter local constraints.
- Legacy tools can keep working through aliases without making the aliases
  authoritative.
- A repository must migrate before enrollment can become healthy; Fluent will
  not silently accept a plausible legacy file.
- Structural conformance, QA tuning, agent authorization, instructions, and
  skills remain distinct artifact types instead of being flattened into
  “policy.”
- Core needs the surface contract, governance schema, fixtures, migration
  guidance, and a core-side ADR. Fluent needs canonical-surface loading and
  repository holds. None is implemented yet.

## Alternatives considered

- **Search a list of conventional paths:** rejected because fallback order is
  hidden policy and lets divergent layouts persist indefinitely.
- **Support one adapter per existing repository:** rejected because accidental
  schemas become permanent product APIs and every new repository adds code.
- **Let enrollment declare arbitrary policy paths:** rejected because each
  repository could invent another convention and point Fluent at unrelated or
  sensitive files.
- **Use the updex schema as canonical:** rejected because it mixes broad AI
  guidance, documentation links, and authorization in a repository-specific
  hierarchy.
- **Treat pilothouse and chairlift files as governance policy:** rejected
  because one describes structural files and the other quality-loop tuning;
  neither answers which actions an agent may take.
- **Allow the canonical path itself to be a symlink:** rejected because the
  actual content owner would remain elsewhere and Git clients disagree about
  directory-symlink behavior. Aliases point to canonical content, not the
  reverse.
- **Predeclare canonical paths for every conceivable artifact:** rejected
  because a registry without a consumer creates ceremony and freezes guesses.

## References

- Extends strict organization authoring from
  [ADR-0013](0013-author-organization-records-as-strict-json.md), atomic import
  from [ADR-0014](0014-import-core-as-atomic-validated-snapshots.md), and core
  enrollment from
  [ADR-0015](0015-authorize-repository-enrollment-through-core.md)
- Preserves monotonic policy evaluation from
  [ADR-0010](0010-enforce-policies-monotonically-with-expiring-exceptions.md)
  and portable instructions from
  [ADR-0002](0002-agent-portable-instruction-surface.md)
- Existing inputs:
  [snosi policy](https://github.com/frostyard/snosi/blob/main/policies/agent-governance.json),
  [lab policy](https://github.com/frostyard/lab/blob/main/policies/agent-governance.json),
  [updex policy](https://github.com/frostyard/updex/blob/main/.github/policies/ai-governance.json),
  [pilothouse structural manifest](https://github.com/frostyard/pilothouse/blob/main/policies/repository.yaml),
  and [chairlift QA tuning](https://github.com/frostyard/chairlift/blob/main/.github/policies/auto-qa-tuning.json)
- Product: [maintenance fleet PRD](../prd/agent-fleet.md), especially
  [canonical repository surfaces](../prd/agent-fleet.md#canonical-repository-surfaces)
- Implementation design, contract, and delivery plan: not yet authored
