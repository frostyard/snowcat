# 0066 — Sequence project slices on observed predecessor delivery

- **Status:** Accepted
- **Date:** 2026-08-19

## Context

A project larger than one pull request — "add the capability to updex, then
change snosi to consume it, land them in that order" — is not expressible in
the queue. Claim order is priority then age and nothing else; follow-ups are
a bounded safety valve (proposed at birth, ten per completion, four edges
deep), not a planning surface; `blocked` names no blocking item and exits
only through a human. The operator can deliver such a project today only by
becoming its scheduler: importing everything and pacing admission by hand as
each step merges.

The dependency vocabulary already exists, one altitude up.
[ADR-0028](0028-approve-immutable-delivery-plans-in-core.md) approved
immutable Core delivery plans as ordered acyclic slice graphs, and
[ADR-0034](0034-schedule-a-bounded-ready-inventory.md) made dependencies part
of eligibility; [ADR-0059](0059-adopt-the-queue-store-as-the-v1-work-engine.md)
parked both "until a real repository shows the need". The need has now
arrived — but at project scope, not initiative scope: three issues and two
edges between two fleet repositories, with no PRD revision, no portfolio, and
no Core authority act anywhere in sight. Pulling initiative machinery down
onto that is the wrong altitude.

Meanwhile the queue already sequences work three times without a single
stored edge, and all three share one shape: the next item becomes actionable
only when deterministic code observes an external GitHub fact. Review rounds
([ADR-0065](0065-gate-worker-pull-requests-behind-bounded-review.md)) advance
on an observed verdict and head; cure roots
([ADR-0061](0061-cure-pull-requests-as-bounded-per-head-work.md)) key to an
observed head; the internal-dependency sweep's own doc comment says "the
chain orders itself: the upstream release lands first, the downstream bump
appears afterwards." The PRD states the underlying rule outright: later
eligibility MUST require an independently observed predecessor signal — never
a worker's assertion.

Two more facts bound the design. Snowcat never merges and never publishes, so
a human already stands at every edge a project could declare; the moment a
plan most needs re-checking against reality is a moment the operator is
already looking at a pull request. And fleet repositories consume each other
at version boundaries — snosi takes updex by release tag, not by sibling
checkout — so "the predecessor landed" is sometimes "a release exists", not
"a pull request merged". Finally, imported issue bodies are untrusted:
`import-issues` already quotes them as context authored by whoever filed the
issue, and anything the queue reads out of them must stay safe under that
assumption.

## Decision

Snowcat sequences project work through predecessor references carried on
imported work items and satisfied only by observed delivery. Planning stays a
human-and-agent conversation outside the engine; the queue gains
representation and gating, nothing agentic.

1. **Planning is a skill, not an engine feature.** The
   [frostyard-plan-project skill](https://github.com/frostyard/core/blob/main/.agents/skills/frostyard-plan-project/SKILL.md)
   in frostyard/core interviews the human socratically, shapes one-PR-sized
   slices with evidence-shaped acceptance criteria, and writes GitHub
   issues: one umbrella issue as the plan record — never labeled for import
   — and one labeled issue per slice. Acceptance criteria are the binding
   contract; instructions are advisory and expected to rot, degrading to a
   worker `block` the operator sees. Nothing here supersedes ADR-0028: a
   Core-approved delivery plan remains the initiative-scale instrument; a
   project plan is just issues.
2. **Edges are `depends-on` lines resolved through source references.**
   `import-issues` parses lines of the form `depends-on: <GitHub issue URL>`
   from a labeled issue's body and stores the URLs on the created item
   (schema rung: a nullable predecessors column). Predecessors are source
   references, not item ids: stable under import order, idempotent under
   re-import, and cross-repository by construction, because the queue is one
   database and the URL names the repository. Read from an untrusted body,
   a predecessor is safe by direction: it can only delay the item that
   declares it — it authorizes nothing, reorders nothing, and touches no
   other item.
3. **A predecessor is satisfied only by observed delivery.** At claim time,
   an item with predecessors is eligible only when for every predecessor URL
   a work item with that source reference exists in the queue, is completed,
   and its verified artifacts are delivered — every pull-request artifact
   merged, every release artifact published; an item that reported no
   artifact satisfies on completion alone. The `verify-artifacts` sweep's
   observations decide, never a worker's say-so, and the claim transaction
   rechecks like it already does for admission and enrollment. A predecessor
   URL with no imported item leaves the successor ineligible, visibly.
4. **Releases are slices with release artifacts.** The artifact vocabulary
   grows GitHub release URLs: `complete_work` verifies them against GitHub
   like pull requests, `attach-artifact` accepts them for the tag a human
   published, and delivery derivation learns `published`. A version-boundary
   edge is expressed as a release slice between producer and consumer — its
   work is preparing the release, a human publishes, the sweep observes.
   Snowcat still never merges or publishes anything.
5. **Slices materialize up front and are gated, not staged.** Every slice
   issue imports immediately as a proposed root; operator admission is the
   plan-review moment; the predecessor gate — not late creation — handles
   freshness from then on. The whole plan is visible in the queue from day
   one, and admitting it is one sitting, not one admission per merge.
6. **Failure is loud and manual.** No cascade: a cancelled or never-delivered
   predecessor leaves its successors ineligible and visible until the
   operator cancels or refiles them. Nothing automatic prunes a plan; a
   dying project should be conspicuous, not tidy.

## Consequences

- "Add it to updex, then snosi, land them in sequence" becomes three issues
  and two `depends-on` lines; humans merging and publishing remain the
  pacing mechanism, now enforced by the gate instead of by hand-paced
  admission.
- One queue schema rung (the predecessors column) plus a claim-path check
  that joins on source reference within the same database; the work-queue
  spec gains its rules alongside that implementing change, not before.
  `verify-artifacts` grows release reads; no new GitHub writes.
- The eligibility rule stays single: completed plus artifacts observed
  delivered. Artifact type carries the semantics (merged vs. published), so
  no condition grammar enters the claim SQL.
- The surface and `list` must say *why* a gated item is not claimable and
  which predecessors are unmet; without that, gated slices read as stuck.
  The implementing change owes cycle visibility too: a cycle is not
  rejected, it is two items that never become eligible, and only the
  surface can make that legible.
- Editing `depends-on` lines on GitHub after import changes nothing — the
  importer skips existing source references. The implementing change must
  either refresh predecessors on re-import or document cancel-and-refile as
  the correction path.
- Instruction rot is accepted rather than fought: a stale slice blocks with
  a reason instead of guessing, which is only safe while the skill keeps
  acceptance criteria evidence-shaped. The skill carries that burden
  explicitly.
- Follow-up bounds, admission triggers, ceilings, and lineage rules are
  untouched: slices are sibling proposed roots, not lineage.

## Alternatives considered

- **Implement ADR-0028's Core-approved plans now:** rejected; initiative
  machinery (PRD revisions, immutable versioned graphs, Core authority
  transactions) at project scope, for what is three issues and two edges.
  ADR-0028 stands, one altitude up.
- **A planner work-item kind that creates dependent items directly:**
  rejected; it puts decomposition output inside the engine where it is
  hardest to review. Issues on GitHub are reviewable where the operator
  already lives, and children born proposed would re-create per-step
  admission toil anyway.
- **Edges by item id:** rejected; ids exist only after import, forcing
  creation-order coupling, and cannot cross an import boundary. Source
  references are already the stable origin identity.
- **A condition grammar on edges (merged vs. tag-exists):** rejected; two
  condition types in the eligibility path forever. A release slice keeps
  one rule and makes the release visible as the real work it is.
- **Late materialization (create each successor only when its predecessor
  delivers, like review rounds):** rejected; it trades the whole-plan
  inventory away for freshness the human-at-every-merge already provides.
- **Satisfy edges on completion alone:** rejected; an unmerged pull request
  is not a landed predecessor, and completion is a worker's assertion where
  the PRD demands an independent observation.
- **Automatic cascade when a predecessor dies:** rejected; silently
  cancelling downstream work hides a failing plan exactly when the operator
  most needs to see it.
- **Keep hand-paced admission (status quo):** rejected as the durable
  answer; it works and remains the fallback, but it makes the operator the
  scheduler of every project step, which is the toil this decision removes.

## References

- Shapes: [work queue spec](../specs/work-queue.md) (rules added with the
  implementing rung), [queue operations runbook](../design/queue-operations.md),
  and the
  [frostyard-plan-project skill](https://github.com/frostyard/core/blob/main/.agents/skills/frostyard-plan-project/SKILL.md)
  in frostyard/core
- Builds on:
  [ADR-0004](0004-keep-models-outside-the-control-path.md),
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md),
  [ADR-0028](0028-approve-immutable-delivery-plans-in-core.md),
  [ADR-0031](0031-separate-delivery-from-outcome-achievement.md),
  [ADR-0034](0034-schedule-a-bounded-ready-inventory.md),
  [ADR-0059](0059-adopt-the-queue-store-as-the-v1-work-engine.md),
  [ADR-0061](0061-cure-pull-requests-as-bounded-per-head-work.md), and
  [ADR-0065](0065-gate-worker-pull-requests-behind-bounded-review.md)
- Plan: [recovery plan, Later / ideas](../plans/recover.md#later-ideas)
- Terms: [predecessor](../domain/ubiquitous-language.md#predecessor),
  [source reference](../domain/ubiquitous-language.md#source-reference),
  [delivery state](../domain/ubiquitous-language.md#delivery-state)
