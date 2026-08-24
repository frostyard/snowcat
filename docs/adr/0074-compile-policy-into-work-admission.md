# 0074 — Compile policy into work admission

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

Core's governance is richer than anything the queue enforces. A repository's
Core declaration carries an `action_ceiling`; its `agent-governance` surface
marks each action `allow`, `review-required`, or `deny` and names protected
boundaries with paths and minimum risk tiers. Snowcat validates and records
all of it in the control-plane enrollment fact
([ADR-0015](0015-authorize-repository-enrollment-through-core.md),
[ADR-0050](0050-reconcile-repository-enrollment-as-separate-facts.md)) — and
then applies none of it to work. Feeders grant fixed action sets; the one
Core coupling on the work path is the enrolled-repository claim filter
([ADR-0059](0059-adopt-the-queue-store-as-the-v1-work-engine.md) decision 3);
[how Snowcat works](../design/how-snowcat-works.md) states plainly that
clamping items to the ceiling and the governance file is future work that
starts with an ADR.

The audit named the cost ([reality report](../design/reality.md), finding 3),
and live operation demonstrated its sharpest corollary on 2026-08-23: a
mechanically admitted `pr-review-fix` was required to modify
`.github/workflows/**` — a path the repository's own policy marks
review-required at its highest tier — and no human decision, policy
revision, or authorization evidence appears anywhere on the item. Human
admission may *incidentally* satisfy a `review-required` act, but the
admitted item cannot prove which policy it was judged under; mechanically
admitted roots never pass through that human at all.

## Decision

1. **Every item binds the policy it was authorized under.** When the
   control-plane store is configured, every definition path reads the
   repository's enrollment authority — the Core `action_ceiling` and the
   enrollment's recorded `governancePolicy` with its revision digest — and
   stamps the item with a **policy binding**: the Core authority revision
   and the governance digest it was defined against. Without a control
   store, and on every pre-existing row, the item reads as **unbound** —
   visible in `audit-contracts`, exactly as ADR-0073's undeclared legacy
   is, and never guessed at.

2. **Deny and the ceiling are enforced deterministically.** A definition
   whose `allowedActions` or `delegableActions` exceed the bound
   `action_ceiling`, or include an action the governance policy marks
   `deny`, is refused where the contract predicate already runs
   ([ADR-0069](0069-declare-the-required-artifact-on-every-work-item.md),
   [ADR-0073](0073-declare-the-execution-target-on-every-work-item.md)):
   at definition, and re-checked at admission against the then-current
   authority — an admission after the policy moved re-binds the item to
   what it was actually admitted under.

3. **A `review-required` act names its satisfier.** Human admission records
   the decision as evidence: `approve` stamps the acting principal, the
   binding it judged, and the review-required actions that approval covers,
   on the item and in the ledger. A mechanically admitted root — cure,
   review round, review fix — must cite a **standing authorization** from a
   closed in-code registry, shaped like the verification-mechanism registry
   ([`src/verification/registry.ts`](../../src/verification/registry.ts)):
   each entry names the Accepted ADR that pre-authorizes that mechanical
   path ([ADR-0061](0061-cure-pull-requests-as-bounded-per-head-work.md)
   for cures, [ADR-0065](0065-gate-worker-pull-requests-behind-bounded-review.md)
   with [ADR-0067](0067-adjudicate-description-blockers-by-a-human.md) and
   [ADR-0071](0071-pass-the-tree-when-only-adjudicated-description-blockers-remain.md)
   for the review gate) and the exact action set it may cover. A mechanical
   path with no registry entry cannot mint admitted work: it proposes, and
   a human admits.

4. **Protected boundaries are checked where they become checkable — at the
   delivered diff.** The binding carries the policy's protected boundaries
   and minimum tiers; the review sweep injects them into reviewer
   instructions deterministically, and artifact verification compares the
   delivered pull request's changed files against the boundary paths. A
   mechanically admitted item whose diff touches a `review-required`
   boundary routes to human adjudication instead of any automatic
   ready-marking; the finding names the boundary and its minimum tier. No
   model ever classifies its own authority, and vague scope needs no
   up-front classification: the diff is judged when it exists.

5. **Fail closed at admission; leave claim alone.** An unreachable control
   store or unreadable policy at admission leaves the item proposed — the
   operator sees why, nothing guesses. Claim time stays exactly ADR-0059's
   enrolled-repository filter: admission is the policy choke point, and the
   hot claim path gains no second authority read.

## Consequences

- The queue gains a second, deliberate coupling to the control plane — the
  definition/admission policy read beside the claim eligibility hook. The
  "only coupling" statements in the agent instructions and
  [how Snowcat works](../design/how-snowcat-works.md) amend alongside the
  implementing change, which also adds the schema rung for the binding and
  authorization records and the work-queue spec rules that pin them.
- The 2026-08-23 episode becomes structurally impossible to repeat quietly:
  a mechanical fix whose diff lands in a protected boundary surfaces to a
  human with the policy evidence attached, and every admitted item can
  answer "who allowed this, under which policy revision".
- Feeders read policy once per batch; enrollment authority is already local
  in the control store, so the cost is a read, not a GitHub call.
- Unbound legacy items drain visibly rather than being migrated; a
  repository run without a control store keeps today's behavior and is
  labeled as such.
- The standing-authorization registry is one more closed vocabulary to
  maintain — deliberately: adding a mechanical admission path becomes an
  ADR plus a registry entry, not a code path that quietly self-authorizes.
- A policy that tightens between definition and admission is honored (the
  admission re-check); one that tightens after admission is caught only at
  the diff check or the next human touch — accepted, since retroactive
  revocation of admitted work is an operator decision, not a sweep's.

## Alternatives considered

- **Let the model classify scope against boundaries at definition:** the
  reality report's findings 8 and 10 document exactly why authority must
  not depend on model self-report; rejected outright.
- **Enforce at claim instead of admission:** too late — the work was
  already defined and admitted with wrong authority — and it puts a policy
  read on the hot path ADR-0059 kept minimal.
- **A generic policy engine in Snowcat:** Snowcat consumes Core's closed
  schema ([ADR-0007](0007-use-frostyard-core-as-the-organization-authority.md));
  interpreting arbitrary policy shapes would grow the control path the
  fleet keeps deliberately small.
- **Keep human admission as the implicit satisfier (status quo):** the
  admitted item proves nothing about what was judged, and mechanical
  admissions bypass the human entirely — finding 3, unchanged.

## References

- Shapes: [specs/work-queue.md](../specs/work-queue.md) (binding,
  predicate, and adjudication rules — amended alongside the implementing
  code), [design/how-snowcat-works.md](../design/how-snowcat-works.md),
  [design/reality.md](../design/reality.md) (finding 3),
  [domain/ubiquitous-language.md](../domain/ubiquitous-language.md)
  (Policy binding; Standing authorization)
- Builds on:
  [ADR-0007](0007-use-frostyard-core-as-the-organization-authority.md),
  [ADR-0015](0015-authorize-repository-enrollment-through-core.md),
  [ADR-0017](0017-standardize-actions-boundaries-and-risk.md),
  [ADR-0050](0050-reconcile-repository-enrollment-as-separate-facts.md),
  [ADR-0059](0059-adopt-the-queue-store-as-the-v1-work-engine.md),
  [ADR-0069](0069-declare-the-required-artifact-on-every-work-item.md),
  [ADR-0073](0073-declare-the-execution-target-on-every-work-item.md)
