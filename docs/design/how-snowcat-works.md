# How Snowcat works

Living document, written for the team rather than for the implementer: what
Snowcat is, how it relates to `frostyard/core` and to the repositories it
maintains, and what happens between "a repository joins" and "a pull request
merges." Rationale lives in the ADRs linked at the end; exact contracts live in
the specs; this page is the map. Under two thousand words on purpose.

## The one-sentence version

Snowcat is a self-hosted work queue that keeps our repositories maintained by
letting **coding agents do bounded work** while **humans keep every decision
that matters** — what a repository is allowed to have done to it, what gets
admitted into the queue, and what merges.

## Three parties

```
frostyard/core ──(declares)──► Snowcat ──(coordinates)──► workers
     ▲                           │                          │
     │                           ▼                          ▼
 organization                enrolled                 pull requests
 authority                 repositories                on GitHub
```

**Core is the authority.** `frostyard/core` holds the organization's decisions
as strict, reviewed JSON: which repositories are in the fleet, which
maintenance programs each one wants, and the widest actions any agent may take
there (`organization/repositories/<owner>/<repo>.json`). Changing any of that is
a pull request to core, reviewed like code. Core also publishes the schemas
those files must satisfy and the *surfaces contract* — the four files a
repository must carry to be maintainable at all: `AGENTS.md`,
`policies/agent-governance.json`, `.agents/skills/`, and `docs/README.md`.

**Snowcat is the coordinator.** It imports core's tree as an atomic, validated
snapshot, reconciles each declared repository against GitHub (does the
repository exist, is it the same immutable repository ID, do its canonical
surfaces exist and validate at the current commit), and only then calls the
repository *enrolled*. Enrollment is a fact Snowcat computes, not a switch
anyone flips. Everything Snowcat does afterwards is gated on it. Snowcat runs on
one host, keeps two SQLite databases (the queue and the control plane), and
never talks to a model itself.

**Repositories are the ground truth.** Each enrolled repository carries its own
governance file — deny by default, a closed list of allowed actions, protected
boundaries such as workflows and release configuration — and its own gate
(`make check`, `npm run check`). Snowcat reads those; it never overrides them.
Bringing a repository up to that shape is the `frostyard-acmm-conformance`
pass: canonical files, relative aliases for the tool-specific names, a docs
gate, and a release setup, in one pull request.

**Workers are anyone's agents.** A worker is any coding agent — Claude Code,
Codex, Copilot CLI, a person at a terminal — that speaks Snowcat's small MCP
contract: `claim_work`, `heartbeat_work`, `complete_work`, `block_work`,
`release_work`. Snowcat owns authorization and bookkeeping; the worker owns its
own checkout, credentials, and tools. Snowcat never provides a sandbox and never
runs code.

## What flows, and in which direction

1. **Authority flows in from core.** The Core poll fetches core's default
   branch every fifteen minutes through a bare-mirror boundary, validates the
   whole tree against the bundled schemas (exact byte digests — Snowcat will
   not validate against bytes it has not reviewed), and activates one
   snapshot. Declarations become repository authority records; a repository
   whose declaration is `enabled` and whose GitHub identity and surfaces
   reconcile is `enrolled`.

2. **Work flows in from three feeders**, all on an hourly timer, all
   idempotent:
   - **Programs.** Snowcat's catalog names a small set of *maintenance
     programs* — quality, CI, security, architecture, conformance, triage,
     dependencies, docs — each a read-only *discovery* root: "find exactly one
     evidence-backed thing and propose at most one bounded child." A
     repository receives only the programs its core declaration lists, each on
     its own cadence (daily or weekly), and a program that answered "nothing"
     is not asked again until its cadence elapses.
   - **Issues.** Label a GitHub issue `snowcat` and the next feed imports it as
     a proposal whose objective is the title and whose body is quoted as
     untrusted context. That label is how you hand the fleet a task.
   - **The internal dependency chain.** A mechanical sweep — no model —
     compares each repository's default branch with its latest release tag and
     its `go.mod` with our own modules' releases. A repository ahead of its tag
     gets a `release-needed` proposal; a repository behind an upstream's latest
     release gets a `dependency-bump` proposal. The bump can only appear after
     the release exists, so the chain orders itself.

3. **Admission is human.** Everything a worker proposes, and everything the
   feeders import, is *proposed*, not claimable. The operator admits it from
   the inbox (or the CLI). Discovery roots are the one exception: they are
   admitted on creation because they are read-only and produce only
   proposals. The design principle: the fleet may *find* work freely; it may
   *do* work only after a person said yes.

4. **Execution is bounded.** A claimed item carries its `allowedActions`,
   its acceptance criteria, and everything earlier leases learned (operator
   notes, previous results). Those actions are fixed by the feeder that
   authored the item — the program catalog
   ([`src/queue/programs.ts`](../../src/queue/programs.ts)), the issue import
   ([`src/queue/github-issues.ts`](../../src/queue/github-issues.ts)), the
   pull-request cure
   ([`src/queue/pull-request-cure.ts`](../../src/queue/pull-request-cure.ts)),
   the dependency sweep
   ([`src/queue/internal-dependencies.ts`](../../src/queue/internal-dependencies.ts))
   — and, for a worker-proposed child, bounded by its parent's
   `delegableActions` ceiling, which the queue store enforces at
   `complete_work`. Core's `action_ceiling` and the repository's governance
   policy are read and recorded in the control-plane enrollment fact, but
   the queue does not apply them to items today: the only Core coupling on
   the work path is the enrolled-repository claim filter
   ([`src/queue/eligibility.ts`](../../src/queue/eligibility.ts);
   [ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md),
   Decision 3). Clamping item actions to Core's ceiling and the governance
   file is future work that starts with an ADR and a
   [work queue](../specs/work-queue.md) rule, not present behavior. The
   worker does exactly that one thing, opens one pull request, and completes
   with evidence and the pull request URL.

5. **Verification is Snowcat's.** On completion, Snowcat checks every reported
   issue and pull request against GitHub — wrong repository or missing means
   the completion is refused and the item stays with the worker; a GitHub
   outage records `unverified` and a later pass fixes it up. Every fifteen
   minutes the verify pass re-reads open pull requests, records merges, and
   derives each item's *delivery* state.

6. **Cure keeps pull requests mergeable.** The same pass reads each open pull
   request's mergeability, check runs, and reviews. A head that decayed —
   conflicts, behind base, a failing check, changes requested — gets one
   admitted `pr-cure` item bound to that exact head and to a digest of its
   patch. The cure worker may only do *mechanical* things (rebase, retitle,
   re-run, reply); Snowcat recomputes the patch's identity on completion and
   refuses if it changed. A cure that needs a code change becomes a proposal
   again. Cure never merges, approves, or dismisses.

7. **Merge stays human.** No path in Snowcat merges a pull request, cuts a tag,
   or publishes a release. The operator merges; `make bump` tags; the
   repository's own release workflow publishes.

## What you see

The operator surface (`npm run serve`) is a read-first view over the same
stores the CLI uses: an inbox of proposals grouped by repository, a per-
repository board (queued / leased / completed, with delivery state), an events
rail, and the same actions the CLI has — admit, defer, requeue, note, attach
an artifact, verify, seed, hold. Every action is attributed and lands in the
same ledger as the CLI's. `queue -- watch` gives the same feed in a terminal.

## What "safe" means here

- **Closed vocabularies everywhere.** Actions, program names, boundaries, and
  decisions are enums pinned in core's schemas and Snowcat's registry;
  widening one is a reviewed change on both sides.
- **Authority never comes from mutable state.** Not from GitHub topics, not
  from a local file, not from a database toggle — only from a merged core
  revision that Snowcat validated.
- **Workers can propose, not approve.** Follow-ups are proposals; a worker
  cannot admit its own work, cannot widen its child's actions beyond its own,
  and cannot borrow Snowcat's reserved principal namespaces.
- **Facts are computed, not asserted.** Enrollment, delivery, and "was that
  cure mechanical" are things Snowcat reads from GitHub and its ledgers, never
  things a worker claims.
- **Everything is on the ledger.** Every transition is an attributed event;
  the surface, the CLI, and the backups all read the same tables.

## Joining a repository

1. Run the ACMM conformance pass (one pull request: canonical surfaces,
   aliases, docs gate, governance file, release setup).
2. Declare it in `frostyard/core` — `enabled`, the programs it wants, the
   action ceiling — and merge.
3. Snowcat activates the snapshot, reconciles, and reports it `enrolled`;
   opt it into the queue; the next feed seeds its programs.

Today's fleet: `updex`, `snowcat`, `clix`, `std`.

## Giving it work

Label an issue `snowcat` and write it so a worker can finish it in one lease
and Snowcat can verify the result — the `write-snowcat-issues` skill is the
checklist. Or let the programs find work and admit what you like from the
inbox.

## What it is not

Not a CI system, not a scanner that opens issues on its own, not a place where
models make decisions, and not a merge bot. It is the queue between the two
human decisions — *what may be done* and *what lands* — with enough
verification in between that neither decision has to be re-litigated.

## References

- Rationale: [ADR-0059](../adr/0059-adopt-the-queue-store-as-the-v1-work-engine.md)
  (queue store as the v1 engine),
  [ADR-0009](../adr/0009-apply-goals-through-discovery-and-admission.md)
  (discovery and admission),
  [ADR-0021](../adr/0021-run-bounded-maintenance-assessments.md)
  (bounded assessments),
  [ADR-0060](../adr/0060-bring-the-operator-surface-forward-as-a-read-first-inbox.md)
  (operator surface),
  [ADR-0061](../adr/0061-cure-pull-requests-as-bounded-per-head-work.md)
  (pull-request cure),
  [ADR-0062](../adr/0062-retire-hive-fluent-owns-conformance.md)
  (Snowcat owns conformance and triage); core's
  [ADR-0035](https://github.com/frostyard/core/blob/main/docs/adr/0035-author-organization-authority-as-strict-json.md)
  (organization authority as strict JSON) and
  [ADR-0039](https://github.com/frostyard/core/blob/main/docs/adr/0039-widen-maintenance-programs-within-schema-v1.md)
  (widening `maintenance_programs`)
- Contracts: [work queue](../specs/work-queue.md),
  [repository authority reconciliation](../specs/repository-authority-reconciliation.md)
- Where it fits: [queue execution boundary](queue-execution-boundary.md),
  [repository enrollment](repository-enrollment.md),
  [core snapshot ingestion](core-snapshot-ingestion.md),
  [operator surface](operator-surface.md)
- Runbook: [queue operations](queue-operations.md)
- Built in: [recovery plan](../plans/recover.md) and the
  [maintenance programs plan](../plans/maintenance-programs.md)
