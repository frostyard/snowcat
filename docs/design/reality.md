# Reality: policy-to-execution alignment

Living discovery report, captured 2026-08-23. This document makes no new
architecture decision. It compares the intended boundaries in
[ADR-0003](../adr/0003-separate-work-coordination-from-execution.md),
[ADR-0017](../adr/0017-standardize-actions-boundaries-and-risk.md),
[ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md),
[ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md),
[ADR-0065](../adr/0065-gate-worker-pull-requests-behind-bounded-review.md),
and [ADR-0069](../adr/0069-declare-the-required-artifact-on-every-work-item.md)
with the tools that currently execute them. Exact queue behavior remains in
the [work queue contract](../specs/work-queue.md).

## Overview

Snowcat's safety architecture is sound at its large boundaries: Core owns
organization authority, Snowcat coordinates work without running a model,
Cockpit owns execution isolation, and a human still admits, reviews, merges,
releases, and deploys. The avoidable failures are at the translations between
those boundaries. The same work is described differently by policy, queue,
skill, execution adapter, repository gate, and artifact verifier. A worker can
therefore need to disobey one instruction to satisfy another, infer authority
that was not granted, install missing tools during a lease, or report a green
result that skipped a required check.

```text
Core policy ──► Snowcat work contract ──► worker skill ──► Cockpit workspace
     │                    │                    │                  │
     └──────── recorded, but incompletely compiled ─────────────┘
                                                                  │
target repository policy ◄── PR evidence ◄── repository gate ◄────┘
```

A **success roadblock** in this report is a cross-layer mismatch that makes a
correct worker choose between contradictory instructions, hides a missing
precondition until after claim, or lets a weaker signal stand in for the
contract the operator thought was being checked. It is not simply a missing
feature.

### Scope and evidence baseline

The audit read Core, Snowcat, Cockpit, and three enrolled repositories at these
locally available revisions:

| Repository | Revision inspected | Role in the audit |
| --- | --- | --- |
| `frostyard/core` | `0ffddbc` | schemas, declarations, organization policy |
| `frostyard/snowcat` | `2465da0` | queue, MCP contract, skills, artifact verification |
| `frostyard/snowcat-cockpit` | `5ebc980` | workspace allocation, prompts, OCI runtime, campaigns |
| `frostyard/std` | `b20ab2f` (`origin/main`) | small Go target and repository governance |
| `frostyard/clix` | `c9942bf` (`origin/main`) | Go target and repository governance |
| `frostyard/updex` | `a594ead` (`origin/main`) | stricter Go target and repository governance |

The sample is enough to expose repeated contract seams; it is not a claim that
every Frostyard repository has every target-side problem below.

Later the same day (2026-08-23), findings 10–17 were added from operating
the review gate end-to-end on snowcat#199 and snowcat#202 — two review
rounds, one review fix, and the merge-queue delivery — so their evidence is
the queue's attempt ledger and the campaign's worker records rather than
contract text. They cover the failure class a static audit cannot see:
places where every document agrees and the runtime still diverges.

## Findings at a glance

| Priority | Roadblock | What makes success unnecessarily hard |
| --- | --- | --- |
| P0 | Existing-PR work starts on a new branch | A compliant Cockpit worker cannot both keep its allocated branch and update the pull request Snowcat bound it to. |
| P0 | `open-pr` is treated as `write` | Cockpit authorizes commits and pushes for a queue contract that Snowcat deliberately accepts without `write`. |
| P0 | Core and repository policy stop at enrollment | The queue records policy but feeders and automated roots grant hard-coded actions without compiling the effective policy. |
| P1 | Fresh-base instructions are mutually unsatisfiable | The skill says pull immediately before branching after Cockpit has already branched and forbidden branch changes. |
| P1 | The OCI image is generic, not repository-qualified | Required tools may be absent; some target gates skip them and still succeed, while stricter gates consume lease time installing them. |
| P1 | Governance evidence is not deterministic | Artifact verification proves that a PR exists, not that its risk, protected-boundary, template, or validation obligations were met. |
| P2 | Read-only review is told to run mutating gates | `make check` in two sample repositories runs `gofmt -w`, conflicting with a review item's lack of `write`. |
| P2 | Lease correctness is a prompt ritual | Long prose asks the model to renew around every expensive step; the trial record shows this is not a reliable lifecycle mechanism. |
| P3 | Cockpit's role spec disagrees with Cockpit | The documented implementer whitelist is stale while runtime selection is intentionally open-ended. |
| P0 | Completion is a prompt ritual too | A worker can narrate success, exit 0, and leave its lease orphaned; nothing reconciles provider exit with the queue attempt. |
| P1 | An orphaned lease has no operator exit | `requeue` is blocked-only and reclaim is claim-time-only, so a dead worker stalls its item for the full lease. |
| P1 | Reviewer diversity concentrates on the weakest harness | The different-model rule routes review work to the other provider, whose lifecycle failures then gate every pull request. |
| P1 | Credential scope is outside the work contract | The queue can mint work no fleet credential can deliver (workflow-scoped pushes), discovered only inside leases. |
| P2 | Description blockers burn the round budget | An unadjudicated `contract:pr-body:` defect forces every later round to block on a decision already routed to a human. |
| P2 | Identity and independence are asserted | One shared principal plus self-asserted `result.model` means nothing enforces that a reviewer is not the author. |
| P3 | Claim/release churn has no backoff | Contract-mismatched items are claimed and released repeatedly with no cooldown or escalation. |
| P3 | Ready is machine-terminal, not success-terminal | The gate's last act is marking ready; ready→merged is untracked and the merge procedure is undocumented. |

## Detailed findings

### 1. Existing-pull-request work is launched on the wrong branch

Snowcat gives `pr-cure` and `pr-review-fix` work an existing pull request and
exact head. The canonical worker skill says to push the pull request's branch:
[`work-snowcat-queue`](../../.agents/skills/work-snowcat-queue/SKILL.md)
under “Cure a pull request” and “Fix review blockers.” The queue-generated fix
instructions are equally explicit in
[`reviewFixRootDefinition`](../../src/queue/pull-request-review.ts).

Cockpit cannot honor that contract as launched. Before the worker claims
anything, it creates `cockpit/<worker-id>` from the prepared base and persists
that branch as lifecycle state
([allocation](https://github.com/frostyard/snowcat-cockpit/blob/5ebc980b55fa9649b16c89a6d2a1c1700d22d3bd/internal/worker/worker.go#L289-L325)).
Its implementer prompt then says not to create, rename, or switch branches and
to push the current branch
([prompt](https://github.com/frostyard/snowcat-cockpit/blob/5ebc980b55fa9649b16c89a6d2a1c1700d22d3bd/internal/worker/worker.go#L710-L718)).

The contradiction is structural, not a prompting defect. A worker that obeys
Cockpit cannot update the bound PR head. A worker that checks out the PR branch
can succeed, but violates the prompt and leaves Cockpit's recorded branch
false. Opening a new PR is worse: cure identity and review-round state remain
bound to the original URL.

The work contract needs an execution target before repository mutation:

- `new-pull-request`: allocate a fresh branch from a qualified base;
- `existing-pull-request`: check out the named PR head/branch and refuse a
  moved head; or
- `read-only-review`: check out the exact head detached, with no push path.

Cockpit can still launch before claim only if the worker reconfigures the
workspace immediately after claim through a deterministic helper that also
updates the durable worker record. Prefer making claim and workspace targeting
one worker-side operation so there is never a useful interval with the wrong
branch.

### 2. Cockpit widens `open-pr` into `write`

Snowcat's deliverability predicate requires `open-pr` when a pull request is
required and refuses `write` without `open-pr`, but it intentionally accepts
`requiredArtifact: pull-request` with `read, open-pr` and no `write`
([`contractProblem`](../../src/queue/store.ts) and its
[explicit test](../../test/required-artifact.test.ts)). Those are distinct
capabilities in the queue vocabulary.

Cockpit classifies that no-`write` shape as ready
([`assessContract`](https://github.com/frostyard/snowcat-cockpit/blob/5ebc980b55fa9649b16c89a6d2a1c1700d22d3bd/internal/queueview/queueview.go#L371-L390))
and its prompt says `open-pr` plus the required artifact authorizes committing
and pushing. The adapter has converted authority to publish a PR into authority
to alter the repository tree.

There are two legitimate delivery modes, and the contract currently collapses
them:

- creating a new PR requires `write` and `open-pr`;
- reporting or mechanically operating on an existing PR can require
  `open-pr` without granting arbitrary tree changes, but must name the PR and
  allowed mutation class.

Until the queue represents that distinction, Cockpit must never infer
`write`. New-PR work without it should be suspicious or undeliverable, and
existing-PR work should be routed by its typed binding rather than by the
artifact value alone.

### 3. Policy is retained at enrollment but not enforced on work

Core's governance schema is richer than the queue contract. Each action is
`allow`, `review-required`, or `deny`; protected boundaries carry a decision,
minimum risk tier, and paths; change controls require least privilege,
validation evidence, and highest-applicable risk
([schema](https://github.com/frostyard/core/blob/0ffddbc8993e87045d8380f5a4bf6178227187fa/organization/schemas/v1/repository-agent-governance.schema.json)).
The `std`, `clix`, and `updex` policies all make issue, PR, and follow-up
creation review-required and protect workflows and release files
([std](https://github.com/frostyard/std/blob/b20ab2ffd034996f2cd24ccf284fd9ab3b7304d2/policies/agent-governance.json),
[clix](https://github.com/frostyard/clix/blob/c9942bfa0c35aeef467f90017729d6fb0ae20702/policies/agent-governance.json),
[updex](https://github.com/frostyard/updex/blob/a594eadba7badbd0f4e217b5d5ec07f679eeb958/policies/agent-governance.json)).

Snowcat validates and records the Core ceiling and repository policy in the
enrollment fact, then applies neither to queue items. The current design states
that directly in [How Snowcat works](how-snowcat-works.md#what-flows-and-in-which-direction).
Issue imports grant the fixed six-action set in
[`github-issues.ts`](../../src/queue/github-issues.ts), while every maintenance
program shares another fixed six-action child ceiling in
[`programs.ts`](../../src/queue/programs.ts). Claim eligibility checks only the
repository's enrolled state.

Human admission may incidentally satisfy an action's `review-required` value
for an imported or worker-proposed item, but the admitted item carries no
policy revision or decision evidence proving that interpretation. Mechanically
admitted roots such as review fixes do not pass through that human decision at
all. Protected paths, minimum risk, `deny`, and required human acts have no
work-level representation.

Compile effective authority when work is defined and revalidate it when work
is admitted or mechanically admitted. At minimum, retain on the item:

- the active Core snapshot and repository-policy revision used;
- effective actions after intersection with the Core ceiling and repository
  decisions;
- protected boundaries and minimum risk relevant to the proposed scope; and
- the human decision or approved deterministic policy that satisfied each
  `review-required` act.

Fail closed when scope is too vague to determine whether a protected boundary
is involved. Do not make a model classify its own authority.

### 4. Base freshness cannot be satisfied by a managed worker

The canonical skill tells a worker to pull the default branch immediately
before branching
([worker procedure](../../.agents/skills/work-snowcat-queue/SKILL.md#do-the-work)).
Cockpit's managed-worker contract says launch creates the branch without
fetching or pulling and requires the worker to keep it
([managed workers](https://github.com/frostyard/snowcat-cockpit/blob/5ebc980b55fa9649b16c89a6d2a1c1700d22d3bd/docs/specs/managed-workers.md#L75-L100)).
A campaign fetches once during repository setup, pins that commit, and reuses
it for later launches
([campaign setup](https://github.com/frostyard/snowcat-cockpit/blob/5ebc980b55fa9649b16c89a6d2a1c1700d22d3bd/docs/specs/repositories-and-board-campaigns.md#L33-L43),
[launch rule](https://github.com/frostyard/snowcat-cockpit/blob/5ebc980b55fa9649b16c89a6d2a1c1700d22d3bd/docs/specs/repositories-and-board-campaigns.md#L98-L106)).

The skill instruction is impossible after Cockpit launch and a long-running
campaign's immutable base can become arbitrarily old. Conflict cure later is
not a substitute: stale work wastes a model attempt, review round, and human
attention before the conflict is observed. The merge queue (core ADR-0042)
bounds the damage — GitHub rebuilds each entry on the queue tip and re-runs
checks — so a stale base costs wasted attempts and attention rather than a
wrong merge.

Make base freshness a checked launch precondition rather than worker prose.
Refresh and pin per implementation launch, or give prepared bases a short
maximum age and compare their commit to the observed default branch before
allocation. Existing-PR and exact-head work should use their bound head instead
of the default branch. The resulting base commit belongs in attempt evidence.

### 5. The worker image is not qualified against repository gates

Cockpit deliberately supplies a small generic OCI baseline: Go 1.26.6,
Node.js 26, and common tools, but no `golangci-lint`
([OCI contract](https://github.com/frostyard/snowcat-cockpit/blob/5ebc980b55fa9649b16c89a6d2a1c1700d22d3bd/docs/specs/oci-workers.md#L62-L85)).
That interacts differently with the sample repositories:

- `std` and `clix` make `golangci-lint` optional in `make check`; its absence
  prints “skipping” and the gate can succeed even though both PR templates say
  lint must be clean
  ([std gate](https://github.com/frostyard/std/blob/b20ab2ffd034996f2cd24ccf284fd9ab3b7304d2/Makefile),
  [clix gate](https://github.com/frostyard/clix/blob/c9942bfa0c35aeef467f90017729d6fb0ae20702/Makefile)).
- `updex`'s `make ci` requires exactly version 2.12.2, so the same image must
  install it during the lease before useful validation
  ([updex gate](https://github.com/frostyard/updex/blob/a594eadba7badbd0f4e217b5d5ec07f679eeb958/Makefile)).
- Cockpit relocates `GOPATH` to `/home/cockpit/go`, while the image does not
  add `$GOPATH/bin` to its declared path; a successful `go install` therefore
  still needs an execution-side path correction.

The earlier Cockpit campaign already demonstrated the cost of discovering
runtime prerequisites inside leases: missing Node led four workers to download
toolchains, cross the PID ceiling, and expire before reporting
([retained trial](https://github.com/frostyard/snowcat-cockpit/blob/5ebc980b55fa9649b16c89a6d2a1c1700d22d3bd/docs/plans/0003-board-campaigns.md#L75-L90)).
Node is fixed; the seam remains.

Core needs a versioned repository execution profile surface naming the
credential-free gate, required tool versions, resource floor, and cache/path
needs. Cockpit should qualify or select an image against that profile before
launch. A missing required tool must make the repository/lane unready, not
turn into either a skipped check or an ad hoc installation charged to the
work lease.

### 6. Pull-request verification proves existence, not governance

[`artifact-verification.ts`](../../src/queue/artifact-verification.ts) verifies
the artifact kind, URL/number, target repository, state, head SHA, and draft
state. It does not verify PR-template sections, declared
risk, protected-boundary disclosure, repository review rubric, or the checks
the result says passed. (Since this was captured, snowcat#199 landed the
conventional-title lint, its CI workflow, and the `bad-title` decay for
snowcat itself; the remaining items and the target repositories stand as
written.) The semantic review prompt can identify a missing
description obligation, but only when the review gate is enabled and only when
the target repository actually expresses the obligation.

The sample exposes that second limit. `std` and `clix` governance require
highest-applicable risk classification, yet their current PR templates have no
risk-classification section
([std template](https://github.com/frostyard/std/blob/b20ab2ffd034996f2cd24ccf284fd9ab3b7304d2/.github/pull_request_template.md),
[clix template](https://github.com/frostyard/clix/blob/c9942bfa0c35aeef467f90017729d6fb0ae20702/.github/pull_request_template.md)).
`updex` carries the
[section](https://github.com/frostyard/updex/blob/a594eadba7badbd0f4e217b5d5ec07f679eeb958/.github/pull_request_template.md)
and a local risk-tier document. Core enables `quality`, `ci`, `dependencies`,
and `docs` for `std` and `clix`, but not `conformance`, so the fleet is not
scheduled to find this class of authority/surface drift.

Carry policy/rubric revision and required governance evidence into the origin
work and its review item. Deterministically verify the mechanical parts—title
shape, required PR-body fields, named validation contexts, and risk value—then
leave semantic correctness to the bounded reviewer and final human. Treat
conformance as an enrollment baseline or a mandatory periodic program, not an
optional specialty that can be absent exactly where surfaces drift.

### 7. Read-only review is encouraged to run mutating validation

A `pr-review` item grants only `read` and `run-tests`, and the skill tells the
reviewer to run the repository's own checks when possible. In `std` and
`clix`, `make check` invokes `gofmt -w` before lint and tests. Even when the
tree is already formatted, the prescribed command is a mutating operation;
when it is not, a reviewer lacking `write` changes the checkout merely by
validating it.

Repositories in the fleet need a credential-free, non-mutating verification
entry point—typically `make verify` or `make ci` using `gofmt -l` plus a diff
check. Mutating developer conveniences such as `make fmt` can remain separate.
The execution profile should name the non-mutating command for reviews rather
than asking the model to infer one from `AGENTS.md` and a Makefile.

### 8. Lease correctness is encoded as repeated prompt discipline

Cockpit's role prompt asks the model to claim a 3,600-second lease, heartbeat
immediately, heartbeat before and after every install/build/test/network step,
watch a ten-minute interval, and stop mutation after lease loss
([prompt](https://github.com/frostyard/snowcat-cockpit/blob/5ebc980b55fa9649b16c89a6d2a1c1700d22d3bd/internal/worker/worker.go#L710-L718)).
The retained campaign record shows foreground workers expiring through long
setup and test work even after lifecycle language was a known concern.

The lease token should remain inside the worker boundary; Cockpit should not
persist it or infer completion. That does not require making the model the
scheduler. A worker-local MCP wrapper can renew while a claimed attempt is
active, expose an explicit “lease lost” result to the provider, and stop
wrapped mutation commands after loss. The model should decide and report the
work; deterministic client plumbing should keep its capability alive.

### 9. Cockpit documents a selection rule it no longer runs

Cockpit's current classifier sends every kind except discovery, exact review,
and human-operated `release-needed` to the implementer. Its generated prompt
explicitly rejects a fixed whitelist. The living
[`worker-profiles` spec](https://github.com/frostyard/snowcat-cockpit/blob/5ebc980b55fa9649b16c89a6d2a1c1700d22d3bd/docs/specs/worker-profiles.md#L64-L75)
still says implementers receive only `*-fix`, `pr-cure`, and
`pr-cure-change`, then incorrectly says another skill's selection admits
discovery work.

This drift is lower risk than the runtime contradictions, but it makes reviews
and operator decisions target a fictional boundary. Define the role/kind table
once in code and test generated documentation or fixtures against it. Keep
role selection open-ended only if the typed work contract—not a kind-name
heuristic—carries every execution requirement.

### 10. Completion is a prompt ritual too

Finding 8 covers renewal; the terminal step has the same shape. On
2026-08-23 two Cockpit reviewer workers (copilot provider) printed a
completed-verdict narrative, exited 0, and had never called
`complete_work`: items `ba71c5c2` (snowcat#202) and `9cc4c7a6` (snowcat#199)
stayed `claimed` while the campaign recorded both workers as running and
their containers were gone; one "review" lasted 14 seconds and never fetched
the diff. Nothing reconciles provider exit with the queue attempt's outcome,
so a worker that narrates completion is indistinguishable from one that
completed. The prompt's "claim 3,600 seconds and heartbeat immediately"
maximizes the damage: a worker that dies seconds after claim has already
extended its orphaned lease to the full hour.

Treat "provider exited while its claimed attempt reached no terminal
outcome (completed, blocked, released)" as a failed lane, record it, and
surface it. The worker-local wrapper of finding 8 is the right observer: it
knows whether `complete_work` ever crossed the wire, and renewal tied to
liveness stops front-loaded leases outliving their workers.

### 11. An orphaned lease has no operator exit

`requeue` acts only on `blocked` items; an expired lease is reclaimed only
inside `claim_work`; no read shows "claimed, but the holder is gone".
Recovering the two orphaned reviews above meant waiting out both full
leases and winning a polling race against the campaign's own 30-second
claim loop. An attributed operator command (`queue -- release-lease <id>
<reason>`, the same decision shape as `repository -- hold`) plus a
stale-claim listing would turn an hour of dead time per incident into a
minute.

### 12. Reviewer diversity concentrates on the weakest harness

The gate asks each round for a model different from the author's
([ADR-0065](../adr/0065-gate-worker-pull-requests-behind-bounded-review.md)),
and most authoring runs on one provider — so review work routes
deterministically toward the other. Both of the day's lifecycle failures
(finding 10) were that lane. Model diversity is being purchased with
harness monoculture: the review gate's integrity is bounded by the least
reliable client in the fleet. The contract should separate the two
properties — a diverse model on a qualified client — where a client
qualifies by demonstrated lifecycle completion, not by provider name.

### 13. Credential scope is outside the work contract

Finding 5 qualifies tools; credentials have the same seam. Item `4ed69c08`
(snowcat#199) required CI wiring under `.github/workflows/`, and no fleet
credential can push one: GitHub refuses workflow files from OAuth tokens
without the `workflow` scope, which burned two implementation attempts and
their review rounds before an operator SSH push landed the file. The
execution profile of finding 5 should name required credential scopes next
to required tools, and an item whose scope touches paths the lane's
credential cannot write is unready rather than claimable. The same episode
is finding 3's sharpest corollary observed live: a mechanically admitted
`pr-review-fix` was required to modify a path the repository's own policy
marks review-required at Tier 4 — the policy said human decision; the
mechanics said push.

### 14. Description blockers burn the round budget

[ADR-0067](../adr/0067-adjudicate-description-blockers-by-a-human.md)
routes `contract:pr-body:` blockers to a human and forbids automated cure
— but rounds are head-keyed, and each later round must honestly re-raise a
still-uncured description defect. One unadjudicated body defect therefore
converts every remaining round into a block: snowcat#199's round 3 blocked
solely on the risk-classification blocker already routed to a human in
round 2, over a clean tree. Later rounds should report an
already-adjudicated description fingerprint without counting it toward
block/pass. Relatedly, the minted fix item's objective names the
`contract:pr-body:` fingerprint that ADR-0067 excludes from the fix's
scope — item `552c67f0` read "Fix … missing-risk-classification" while the
ADR forbids the fixer from touching it. (Addressed 2026-08-23:
[ADR-0071](../adr/0071-pass-the-tree-when-only-adjudicated-description-blockers-remain.md)
takes the pass consequence when only already-adjudicated description
blockers remain; the fix-objective half was already correct in ADR-0067's
implementation and read wrong that day only because the host predated it.)

### 15. Identity and independence are asserted, not enforced

Every actor in the day's operation — campaign workers, the operator's
session, the reclaim poller — presented the same member principal; only
free-text claim labels differed, and `result.model` is self-asserted (the
gate already says so). The queue would have accepted the author of a head
claiming its own round-3 review; skill prose alone prevented it. The
minted-token machinery (kind restrictions and tool grants, work-queue spec
schema rungs 9 and 14) exists precisely to make identity a credential
property and is unused by the fleet: one minted token per lane role would
make the different-reviewer rule and review-only claims checkable instead
of ritual. This is finding 8's shape applied to identity.

### 16. Claim/release churn has no backoff

A contract-mismatched item is claimed and released repeatedly with no
cooldown, cost, or escalation: item `81dd224a` (snowcat#201's fix) was
claimed and released five times in eleven minutes by campaign implementers
before an attempt stuck. The attempts ledger already records everything
needed; an item released by several workers in a short window should back
off from claim selection and surface to the operator as evidence of
exactly the mismatches findings 1 and 2 describe.

### 17. Ready is machine-terminal, not success-terminal

The gate's last automated act is marking a draft ready; delivery of the
merge is untracked and unprompted. Three ready pull requests sat idle on
2026-08-23 until the operator hand-enqueued them, and the merge procedure
itself — core ADR-0042's merge queue, GraphQL `enqueuePullRequest`,
`gh pr merge` disabled by that contract — is written down in no repository
document. Automating merges stays off the table (see controls to
preserve), but `verify-artifacts` already derives `delivery` and could
name ready-but-unmerged heads, and the enqueue procedure belongs in
[queue operations](queue-operations.md).

## Remediation order

1. **Make execution target and mutation mode explicit.** Add new-PR,
   existing-PR, and read-only exact-head shapes; require `write` for new tree
   changes; make Cockpit configure the claimed target before work.
2. **Compile policy into admission.** Bind each item to Core and repository
   policy revisions, intersect actions, carry protected-boundary/risk
   requirements, and record how review-required acts were authorized.
3. **Move freshness and environment readiness out of prompts.** Qualify the
   base and repository execution profile before claimable work consumes a
   worker slot.
4. **Make verification evidence-shaped.** Provide non-mutating target gates
   and deterministically verify mechanical PR-governance obligations.
5. **Automate lifecycle mechanics and remove duplicate prose.** Keep lease
   renewal and completion reconciliation in worker-local plumbing — a
   provider exit with no terminal queue outcome is a failure, whatever the
   model printed — give the operator a lease-release exit, and generate
   Cockpit role documentation from the same source as classification.
6. **Make identity a credential property.** Mint per-role queue tokens
   (existing schema rungs 9 and 14) so review-only claims, the
   different-reviewer rule, and lane attribution are enforced by the
   credential rather than asked of the model.

Each step changes a contract and therefore starts with an ADR, updates the
[work queue spec](../specs/work-queue.md) or the appropriate Cockpit spec, and
lands end-to-end tests across the seam. Fixing only the prompt on either side
will preserve the underlying disagreement.

## Controls to preserve

None of these findings argues for moving native coding-agent processes into
Snowcat, giving Cockpit a persisted lease token, weakening human admission,
removing draft review, allowing merge/release/deploy, or replacing repository
gates with generic central checks. Those controls are why failures are bounded.
The goal is to make the work contract carry enough exact information that all
layers enforce the same boundary without worker interpretation.

## Operational notes

- Re-run this audit when Core's governance schema, Snowcat's work-item shape,
  Cockpit's managed-worker contract, or a fleet-wide repository gate changes.
- Treat a worker that had to switch an unexpected branch, install a required
  tool, or explain why a canonical gate was unsafe to run as evidence of a
  contract defect, not merely an idiosyncratic attempt.
- Until finding 1 is fixed, do not route `pr-cure`, `pr-cure-change`, or
  `pr-review-fix` through a Cockpit implementer that enforces the current
  preallocated-branch prompt.
- Until finding 2 is fixed, Cockpit should refuse new-PR work without explicit
  `write`, even though Snowcat's current predicate accepts it.
- A provider that exits while its claimed item is still `claimed` has failed
  regardless of what it printed; inspect the lease and count it against that
  lane (finding 10).
- Until finding 11 lands, recovery from an orphaned lease is claim-at-expiry:
  note `leaseExpiresAt` and reclaim immediately after it, ahead of the
  campaign's own poll.
- Route work that must touch `.github/workflows/**` — or any path fleet
  credentials cannot push — to the operator's own credential, not a campaign
  lane (finding 13).

## References

- Intended boundaries:
  [ADR-0003](../adr/0003-separate-work-coordination-from-execution.md),
  [ADR-0017](../adr/0017-standardize-actions-boundaries-and-risk.md),
  [ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md),
  [ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md),
  [ADR-0065](../adr/0065-gate-worker-pull-requests-behind-bounded-review.md),
  and [ADR-0069](../adr/0069-declare-the-required-artifact-on-every-work-item.md)
- Contracts: [work queue](../specs/work-queue.md)
- Architecture: [how Snowcat works](how-snowcat-works.md) and
  [queue execution boundary](queue-execution-boundary.md)
- Built and observed in: [recovery plan](../plans/recover.md)
