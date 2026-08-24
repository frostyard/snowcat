# 0076 — Pin repository tools in the repository and qualify lanes by running them

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

[ADR-0075](0075-declare-a-repository-execution-profile-in-core.md) answered
the reality report's findings 5, 7, and 13 with one core-owned surface: a
versioned `policies/execution-profile.json` declaring gates, tools (each
`required` or `optional`), a runtime floor, and credential scopes. Writing
the rollout plan for it
([plans/repository-tooling-rollout.md](../plans/repository-tooling-rollout.md))
and then executing its first phase on 2026-08-24 showed three things the
ADR had not weighed.

- **The pin already exists; it is just not installable.** `std`, `clix`, and
  `updex` each carry `GOLANGCI_LINT_VERSION := …` in their Makefile and
  `std`'s CI `sed`s it out to feed its lint action. A third copy of that
  fact in a core-schema'd JSON file makes every version bump a three-file
  change across two repositories' review rules — exactly the friction the
  fleet's `sweep-dependencies` exists to remove — and still nothing can
  `install` from it.
- **`optional` is the defect, not a feature.** `std` and `clix` made
  `golangci-lint` optional in `make lint`; that soft-skip is how "gate
  passed" became compatible with "lint never ran". A schema that lets a
  repository declare a tool optional legitimises the failure mode the
  finding names.
- **Compatibility is a fact about pairs, not a declaration.** The day's
  work hit the Go/lint seam twice: `std`'s `go.mod` moved to 1.26.7 while
  the image shipped 1.26.6, and golangci-lint 2.13.1 embeds Go 1.27's
  `gofmt`, which formats one `updex` file differently from Go 1.26's — each
  rejecting the other's form. No profile field predicts that; only running
  the pair does.

Meanwhile the parts of ADR-0075 that changed worker behaviour the same day
were the ones with no schema at all: a named non-mutating gate (`make
verify`, now in all three repositories and in the reviewer instructions),
a worker image that carries the tool the gates hard-require, and
`GOTOOLCHAIN=local` so an unsatisfiable `go.mod` fails at the first `go`
invocation instead of downloading inside a lease. Cockpit's first campaign
on that image took `clix` from discovery through an independent
`make verify` review to merge, and `std` and `updex` through the same gate.

## Decision

1. **The repository owns its tool pins, in one machine-installable file.**
   `mise.toml` with a committed `mise.lock` at the repository root declares
   every executable the repository's gates invoke beyond the published
   worker base-image baseline; the lock is the repository's checksum
   registry for tools under core
   [ADR-0023](https://github.com/frostyard/core/blob/main/docs/adr/0023-verified-pinned-downloads.md).
   `go.mod` remains the only Go pin, written as a full `1.x.y`; mise reads
   it and nothing pins Go twice. No tool is optional: a gate that invokes a
   tool requires it, and `make lint` fails — never skips — when the tool is
   absent.
2. **Core solidifies the convention, not the versions.** Core's repository
   tooling contract names the files (`mise.toml`, `mise.lock`, `go.mod`),
   the gate triad — `verify` (non-mutating, credential-free), `check` (the
   developer gate, may format), `ci` (calls `verify`; core
   [ADR-0022](https://github.com/frostyard/core/blob/main/docs/adr/0022-make-ci-gate-and-test-naming-filter.md)
   lineage) — the bump order (a `golangci-lint` release built with Go N
   lands before `go.mod` moves to N, shipped as one change), and the
   worker-image lineage. Core does not gain an execution-profile schema,
   and Snowcat's enrollment fact records nothing about tools.
3. **Executors provision from the pin before the lease and qualify by
   running, not by declaring.** Every executor image is
   `ghcr.io/frostyard/snowcat-worker-base` or `FROM` it; the baseline the
   base guarantees is a versioned, published file. At target preparation —
   before any lease exists
   ([ADR-0003](0003-separate-work-coordination-from-execution.md)) — the
   executor runs `mise install --locked` into a per-repository cache and
   mounts it read-only; a tool the lock names but cannot be installed, or a
   Go that does not satisfy `go.mod` under `GOTOOLCHAIN=local`, makes the
   lane unready with the tool or version named. A repository needing what
   mise cannot install extends the base with its own image, qualified by
   running `make check` under the executor's exact launch limits. The
   runtime floor of ADR-0075 is dropped: the qualification run is where a
   limit is tripped, and a floor can be added when one is.
4. **The queue names the gate, never the tools.** Reviewer instructions
   name `make verify` and forbid `make check` for `pr-review` work
   (landed 2026-08-24; work-queue spec rule 53). Snowcat carries no tool
   facts on items and infers nothing from Makefiles, CI files, or prose.
5. **Credential scopes stay declared and path-bound, in the governance
   surface.** Finding 13 survives unchanged: a repository declares the
   credential scope a path needs (`github:workflow` for
   `.github/workflows/**`) so a lane can decline before claiming. Its home
   is core's `policies/agent-governance.json` protected-boundary record —
   the record that already names those paths — as a schema addition core
   adjudicates, not a separate profile; a required scope is an execution
   need attached to an authority record and never confers authority.
   Snowcat surfaces the scope on items whose execution target binds those
   paths once core publishes the field; the recovery plan carries that
   phase.
6. **Absence is visible, never guessed** (ADR-0075 §5, unchanged). No
   `mise.toml` means the executor provisions nothing and the lane is not
   unready for it; nothing synthesizes a pin file.

## Consequences

- A version bump is one file in one repository, and its pull request's CI
  is the compatibility proof — workers never run a Go/lint pair CI has not
  passed. The pair-bump order is a convention `sweep-dependencies` can
  enforce mechanically (rollout plan, Phase 7).
- The "gate passed but lint never ran" class is closed by the gate itself
  rather than by a schema: every gate hard-requires its tools.
- Core owns a convention and a conformance check (files present, targets
  present) instead of a schema and its versioning; no fleet repository
  writes a JSON file that duplicates its Makefile.
- Cockpit's image stops accumulating repository-specific tools: the
  stopgap of shipping `golangci-lint` in the base (rollout plan, Phase 0)
  is retired once every enrolled repository declares it in `mise.lock`
  (Phase 6). Until then the base tracks the fleet's highest `go` directive.
- Two seams this ADR does not close are tracked as the Cockpit ADR's
  items: the worker kit is still a release-time vendored copy of Snowcat's
  skills, and the managed-repository catalog is node-local state invisible
  to Core — both bit the same campaign that proved this decision.
- `mise.lock`'s stability as an ADR-0023 registry and mise's reading of
  `go.mod` are assumptions the `std` pilot (rollout plan, Phase 3) tests;
  the plan names the fallback for each.
- ADR-0075 is superseded in full. Its gate naming (§1 `gates`, §4) and its
  "qualify before the lease" and "absence is visible" principles (§3, §5)
  continue here; its `tools`, `runtime`, enrollment-recorded profile, and
  bundled schema do not.

## Alternatives considered

- **Keep ADR-0075's schema, drop `optional`:** still a third copy of every
  pin with nothing able to install from it; the friction, not the
  optionality, was the larger cost.
- **A bespoke `tools.json` instead of `mise.toml`:** needs its own
  installer, CI action, and image glue; mise supplies `install`, `ls
  --missing`, a checksum lock, and `outdated` for every language the fleet
  uses.
- **Go `tool` directives for Go-built tools:** Go-only, and golangci-lint
  discourages that install path because dependency merging changes lint
  results.
- **Per-repository worker images as the default:** a pin bump then needs an
  image rebuild and a digest roll on every node; provisioning from the lock
  at preparation makes the common case need no image at all, and keeps the
  extension image for system packages mise cannot install.
- **Fold credential scopes into a thin execution profile after all:** one
  file with one section duplicates the path index the governance policy
  already keeps; a scope is a fact about the boundary, so it lives on the
  boundary.

## References

- Shapes: [plans/repository-tooling-rollout.md](../plans/repository-tooling-rollout.md)
  (Phases 1–7), [design/reality.md](../design/reality.md) (findings 5, 7,
  13), [specs/work-queue.md](../specs/work-queue.md) (rule 53),
  [domain/ubiquitous-language.md](../domain/ubiquitous-language.md)
  (Execution profile → Repository tooling convention)
- Supersedes: [ADR-0075](0075-declare-a-repository-execution-profile-in-core.md)
- Builds on: [ADR-0003](0003-separate-work-coordination-from-execution.md),
  [ADR-0065](0065-gate-worker-pull-requests-behind-bounded-review.md),
  [ADR-0073](0073-declare-the-execution-target-on-every-work-item.md),
  [ADR-0074](0074-compile-policy-into-work-admission.md); core
  [ADR-0022](https://github.com/frostyard/core/blob/main/docs/adr/0022-make-ci-gate-and-test-naming-filter.md),
  [ADR-0023](https://github.com/frostyard/core/blob/main/docs/adr/0023-verified-pinned-downloads.md)
