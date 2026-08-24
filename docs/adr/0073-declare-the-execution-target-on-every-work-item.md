# 0073 — Declare the execution target on every work item

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

A work item says what a worker may do (`allowedActions`,
[ADR-0017](0017-standardize-actions-boundaries-and-risk.md)) and what its
completion must deliver (`requiredArtifact`,
[ADR-0069](0069-declare-the-required-artifact-on-every-work-item.md)) — but
not **where execution happens**: which branch, from which base, whether an
existing pull request is bound, or whether the checkout may be mutated at
all. That placement is today carried by kind-name convention (`pr-review-fix`
means "the bound pull request's branch"; discovery kinds mean "read only")
and by prose in skills and executor prompts.

The policy-to-execution audit found the two worst seams in the fleet exactly
here ([reality report](../design/reality.md), findings 1 and 2, both P0):

- **Existing-pull-request work launches on the wrong branch.** Cockpit
  allocates a fresh `cockpit/<worker-id>` branch before claim and forbids
  switching, so a compliant worker cannot update the pull request its
  `pr-cure` or `pr-review-fix` item binds; a worker that succeeds does so by
  violating its prompt. The contradiction is structural: nothing typed on the
  item tells the executor to target the bound branch.
- **`open-pr` is widened into `write`.** The queue deliberately accepts
  `requiredArtifact: pull-request` with `read, open-pr` and no `write`;
  Cockpit reads that shape as authority to commit and push. Authority to put
  a pull request in front of humans and authority to alter the tree are
  different grants, and only convention separates them.

Both failures were reproduced in live operation on 2026-08-23. The
remediation the audit ordered first is to make execution target and mutation
mode explicit on the work contract.

## Decision

1. **Every work item declares an `executionTarget`.** A closed vocabulary,
   declared by whoever defines the item — seed, import, program catalog,
   sweep, or follow-up — exactly as ADR-0069 declares `requiredArtifact`:
   required on every new definition, never inferred from kind or actions.

   - `read-only` — the worker checks out to read and run checks, and mutates
     nothing: no branch, no push path. When the item binds an exact head (a
     `pr-review`'s `review` record), the checkout is that head, detached;
     otherwise the observed default-branch head.
   - `new-pull-request` — the worker allocates a fresh branch from a
     freshly observed default-branch base and delivers a new pull request.
   - `existing-pull-request` — the worker checks out the bound pull
     request's branch at exactly the recorded head, pushes to it, and never
     opens a second pull request; a moved head is refused, not adopted.

2. **A consistency predicate binds target, actions, artifact, and binding**
   — enforced where ADR-0069's predicate already runs: at proposal, again at
   admission, and refused at completion on mismatch.

   - `read-only` ⇒ `allowedActions` excludes `write` and `open-pr`, and
     `requiredArtifact` is `none`.
   - `new-pull-request` ⇒ `allowedActions` includes both `write` and
     `open-pr`, and `requiredArtifact` is `pull-request`.
   - `existing-pull-request` ⇒ `allowedActions` includes both `write` and
     `open-pr` (updating a pull request keeps it in front of humans — the
     same grant opening one exercises), `requiredArtifact` is
     `pull-request`, and the item carries a pull-request binding — the
     `review` or `cure` record, or `sourceRef`, naming `<url>@<head SHA>`.

   This retires finding 2 at the root: `open-pr` without `write` can no
   longer describe tree-changing work at all, so no executor has anything to
   infer. Snowcat's own definers declare accordingly: review roots
   `read-only`; fix and cure roots `existing-pull-request`; catalog
   discovery `read-only`; imported and followed-up work as its definer
   states.

3. **Executors configure the claimed target before any repository
   mutation.** The seam contract for Cockpit — and any other executor — is:
   after claim, before touching the tree, set the workspace to the item's
   target (fresh branch from a fresh base; the bound branch at the recorded
   head; or a detached read-only checkout), record what was set in the
   durable worker record, and release or block when the target cannot be
   satisfied (a moved head, a vanished branch). Snowcat carries what
   execution needs on the item; it never orchestrates the checkout itself
   ([ADR-0003](0003-separate-work-coordination-from-execution.md)).

4. **Legacy items are visible, not guessed at.** The schema rung adds the
   column nullable; every pre-existing row reads as *undeclared*. An
   undeclared item stays claimable under today's conventions while the
   backlog drains, `audit-contracts` lists in-flight undeclared items, and
   every new definition — including every follow-up over MCP — must declare.
   Nothing ever back-fills a target from kind or actions.

## Consequences

- The two P0 seams close at the contract instead of at the prompt: an
  executor that honors the typed target cannot start existing-PR work on a
  fresh branch, and cannot read tree authority out of `open-pr`. Until
  Cockpit implements target configuration, the operational exclusion of
  cure and fix kinds from its implementer lanes stays in force.
- Definers carry one more required field, and the MCP `complete_work`
  follow-up schema grows with it — a breaking addition for follow-up
  authors, softened by the same staged path ADR-0069 used (accept-and-warn
  is not offered; skills and the schema change together).
- The queue schema gains a rung; the work-queue spec gains the field, the
  predicate, and the executor seam rule alongside the implementing code;
  Cockpit's managed-worker and worker-profiles specs change on its side of
  the seam.
- `read-only` deliberately excludes `open-issue`-only work from needing a
  tree at all — a reporting item binds no mutation either way; the target
  describes the checkout, not the GitHub surface.
- A mis-declared target is a new failure class (an `existing-pull-request`
  item whose binding names a closed pull request); the predicate catches
  shape, the cure sweep and `audit-contracts` catch drift, and a worker that
  cannot satisfy a target releases with the reason — which the claim
  backoff ([ADR-0072](0072-back-off-claim-selection-after-rapid-worker-releases.md))
  then surfaces instead of letting it churn.

## Alternatives considered

- **Infer the target from the kind:** kinds are an open vocabulary and the
  inference is exactly the convention that failed; ADR-0069 already rejected
  inference for the artifact contract and the same reasoning holds.
- **Encode placement in `allowedActions`:** overloads a permission
  vocabulary with workspace semantics — the confusion finding 2 documents is
  precisely an executor reading placement out of permissions.
- **Fix it in Cockpit's classifier alone:** leaves the contract ambiguous
  for every other executor (laptop sessions, future clients) and keeps the
  boundary enforced by prompt discipline, the failure class findings 8 and
  10 establish as unreliable.

## References

- Shapes: [specs/work-queue.md](../specs/work-queue.md) (field table,
  contract predicate, and executor seam — amended alongside the
  implementing code),
  [design/queue-execution-boundary.md](../design/queue-execution-boundary.md),
  [design/reality.md](../design/reality.md) (findings 1–2),
  [domain/ubiquitous-language.md](../domain/ubiquitous-language.md)
  (Execution target)
- Builds on:
  [ADR-0003](0003-separate-work-coordination-from-execution.md),
  [ADR-0017](0017-standardize-actions-boundaries-and-risk.md),
  [ADR-0061](0061-cure-pull-requests-as-bounded-per-head-work.md),
  [ADR-0065](0065-gate-worker-pull-requests-behind-bounded-review.md),
  [ADR-0069](0069-declare-the-required-artifact-on-every-work-item.md),
  [ADR-0072](0072-back-off-claim-selection-after-rapid-worker-releases.md)
