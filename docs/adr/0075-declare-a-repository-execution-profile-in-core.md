# 0075 — Declare a repository execution profile in core

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

Three of the policy-to-execution audit's findings are the same seam seen
from different sides ([reality report](../design/reality.md), findings 5, 7,
and 13): nothing machine-readable states what a repository's work needs from
the environment that executes it.

- **Tools** (finding 5): Cockpit ships a deliberately generic OCI baseline.
  `std` and `clix` make `golangci-lint` optional, so its absence lets the
  gate *pass* while the PR template claims lint was clean; `updex` pins
  exactly 2.12.2, so the same image burns lease time installing it; an
  earlier campaign lost four workers to in-lease toolchain downloads
  crossing the PID ceiling. The image is qualified against nothing.
- **Gates** (finding 7): a `pr-review` item grants `read, run-tests`, but
  `make check` in two sample repositories runs `gofmt -w` — the prescribed
  verification mutates the checkout. Which command verifies without writing
  is knowable only by reading Makefiles, which is model inference again.
- **Credentials** (finding 13): no fleet credential can push
  `.github/workflows/**`, and the queue found out by burning two
  implementation attempts and their review rounds. What scopes a change
  needs is discovered inside leases, never before them.

Each repository already publishes machine-checked authority surfaces under
core's repository-surfaces contract — the agent-governance policy Snowcat
enrolls against and now compiles into admission
([ADR-0074](0074-compile-policy-into-work-admission.md)), and the settings
contract core's
[ADR-0040](https://github.com/frostyard/core/blob/main/docs/adr/0040-repository-settings-contract.md)
defines for `sweep-repository-settings`. Execution needs are the missing
sibling.

## Decision

1. **Core gains a versioned repository execution profile surface.** A
   canonical `policies/execution-profile.json` (v1) under the
   repository-surfaces contract, validated by a schema core owns and
   Snowcat bundles — the exact shape is core's to adjudicate; this ADR
   commits Snowcat and Cockpit to consume v1 and proposes its sections:

   - `gates` — the repository's own commands, credential-free by contract:
     `verify` (non-mutating: `gofmt -l` and a diff check, never `-w`) for
     read-only work, and `check` (the full gate) for change work.
   - `tools` — required executables with the version constraint the gate
     actually enforces (`golangci-lint 2.12.2`), each `required` or
     `optional`; an optional tool's absence may skip a step, a required
     tool's absence disqualifies the environment, never the check.
   - `runtime` — the resource floor and path facts execution has already
     tripped over: minimum PIDs and memory, caches, `$GOPATH/bin` on PATH.
   - `credentials` — the scopes work there can require, each bound to the
     paths that require it (`github:workflow` for
     `.github/workflows/**`), so a lane knows before claiming whether its
     token can deliver.

2. **Snowcat records the profile at enrollment, exactly as it records
   governance.** The surface reconciliation validates the bytes against the
   bundled schema and retains the result on the enrollment fact; the
   policy-authority read
   ([ADR-0074](0074-compile-policy-into-work-admission.md)) exposes it
   beside the governance policy. A repository without the surface enrolls
   as *unprofiled* — visible, defaulting to today's behavior — because a
   fleet-wide flag day would block enrollment on files no repository has
   yet; a Core declaration may later require it per repository.

3. **Executors qualify lanes before launch, never inside leases.** Cockpit
   compares its image and credential against the profile when it prepares a
   repository: a missing required tool, an unmet runtime floor, or an
   absent credential scope makes that repository's lane **unready with the
   reason named** — not an ad hoc install charged to a lease, not a
   silently skipped check, not a push refusal three attempts in. Lane
   readiness is Cockpit's to report; Snowcat never schedules executors
   ([ADR-0003](0003-separate-work-coordination-from-execution.md)).

4. **The queue carries the profile's facts to the work that needs them.**
   Reviewer instructions name the profile's `verify` gate instead of asking
   the model to infer a safe command from a Makefile; items whose execution
   target binds paths a `credentials` entry covers surface that scope on
   the item, so a lane without it can decline before claiming rather than
   discover mid-lease. The queue surfaces and records; qualification and
   refusal stay executor-side.

5. **Absence is visible, never guessed.** No profile means no tool, gate,
   or credential claims — executors keep their current defaults and the
   repository reads as unprofiled in the same places unbound policy does.
   Nothing synthesizes a profile from Makefiles, CI files, or prose.

## Consequences

- The recurring waste class ends where it starts: an unqualified lane is
  unready before any lease exists, and "the gate passed" stops being
  compatible with "the gate's lint never ran".
- Reviewers get a contract-named non-mutating command, closing the
  read-only-review contradiction without weakening any repository's real
  gate.
- Core owns one more surface schema, and each fleet repository adds one
  more canonical file — real toil, carried by the same fleet issues that
  already bring `make verify` and risk sections to `std` and `clix`; the
  settings-contract precedent shows the shape works.
- Snowcat bundles another schema digest (it validates nothing it has not
  reviewed) and the enrollment fact grows; the recovery-plan phase that
  consumes it lands with the implementing change, honoring the rule that
  no unconsumed control-plane surface is added.
- A profile can lie — declare a `verify` that mutates, or omit a tool the
  gate needs. It is versioned, reviewed, and diffable where prose was not;
  drift between profile and Makefile is a mechanical comparison a future
  conformance program can make, which no prose convention allowed.
- Until core lands the schema, this ADR changes no behavior; it fixes the
  consumption contract so the core-side change has a committed consumer.

## Alternatives considered

- **Bake every tool into one fat image:** `updex`'s exact pin against
  `std`'s optional lint shows requirements diverge per repository, and one
  image accumulating every repository's toolchain maximizes supply-chain
  surface for lanes that need none of it.
- **Per-repository Cockpit configuration:** invisible to Core authority,
  drifts silently from the repositories it describes, and every other
  executor (a laptop session) learns nothing from it.
- **State requirements in AGENTS.md prose:** model-read and unenforceable —
  the reality report's findings 8 and 10 are precisely the record of prose
  contracts failing under pressure.
- **Let Snowcat infer profiles from Makefiles and CI files:** synthesized
  authority the repository never reviewed; the fleet's rule is that
  surfaces are declared and validated, never guessed
  ([ADR-0074](0074-compile-policy-into-work-admission.md) applied the same
  principle to policy).

## References

- Shapes: [design/reality.md](../design/reality.md) (findings 5, 7, 13),
  [design/how-snowcat-works.md](../design/how-snowcat-works.md),
  [specs/work-queue.md](../specs/work-queue.md) (reviewer-instruction and
  item-surface rules — amended alongside the implementing code),
  [domain/ubiquitous-language.md](../domain/ubiquitous-language.md)
  (Execution profile)
- Builds on:
  [ADR-0003](0003-separate-work-coordination-from-execution.md),
  [ADR-0007](0007-use-frostyard-core-as-the-organization-authority.md),
  [ADR-0015](0015-authorize-repository-enrollment-through-core.md),
  [ADR-0050](0050-reconcile-repository-enrollment-as-separate-facts.md),
  [ADR-0073](0073-declare-the-execution-target-on-every-work-item.md),
  [ADR-0074](0074-compile-policy-into-work-admission.md); core
  [ADR-0040](https://github.com/frostyard/core/blob/main/docs/adr/0040-repository-settings-contract.md)
