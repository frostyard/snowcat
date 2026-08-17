# PRD: GitHub Organization Agent Fleet

- **Status:** Discovery
- **Last updated:** 2026-08-16
- **Owner:** operator

Fluent gives a GitHub organization operator a self-hosted queue of durable,
bounded maintenance and approved feature-delivery work. The operator chooses
and starts a capable coding agent to perform each item; Fluent preserves
repository context, organizational direction, authority limits, lineage, and
outcomes across those independent runs.

## Problem

The existing Hive deployment approximates the desired experience, including
ACMM levels and suggested repository harness requirements, but is not reliable
enough for sustained use. Agents consume tokens without useful outcomes and
fail at the essential handoff of opening reviewable issues and pull requests.
Its implementation also assumes Claude-specific surfaces that do not govern
Codex, Copilot, OpenCode, or locally hosted models.

The operator already has useful Codex, Claude, and Copilot subscriptions, plus
an inexpensive local Lemonade server. Making Fluent launch those clients would
pull rapidly changing login, short-lived token refresh, tools, and sandboxing
into the control plane. Making the weaker local model perform architectural or
large repository work would save subscription usage at the expense of outcome
quality. Neither produces the portable, observable coordination layer the
organization needs.

The first host-local trial showed that the useful coordination path needs no
model inference: deterministic code handed one discovery item and its child to
two operator-started Claude sessions. It also showed that plausible worker
evidence may rely on an invalid observation method, so recorded provenance and
independent verification must remain separate concepts.

`frostyard/core` is the initial Git-backed authority for accepted organization
goals, policies, shared knowledge, readiness criteria, and exceptions. That
authority will apply only to explicit, reviewed, versioned records—not every
file or the repository's current layout, which remains an ambition rather than
a canonical contract. Broad vision remains reviewed human-readable context
until it is expressed as an actionable goal.

## Goals and success measures

Targets other than the safety boundary remain open during discovery. Numeric
targets are required before this PRD can become Approved.

| Goal | Measure | Target |
| --- | --- | --- |
| Produce reviewable maintenance outcomes | Completed items accepted by a maintainer, including useful issues/PRs | TBD |
| Bound wasted capable-agent use | Runs with no useful result; tokens and wall time per accepted outcome | TBD |
| Improve opted-in repositories | Versioned readiness, CI, security, and quality trend per repository | TBD |
| Coordinate shared outcomes | Multi-repository initiatives completed without contract-breaking intermediate states | TBD |
| Preserve traceability | Items with source, lease history, evidence, artifacts, and complete lineage | TBD |
| Preserve operator control | Merge, release, deploy, or non-opted-in repository authorization by Fluent | 0 |
| Keep authority deterministic | State transitions authorized solely by model output | 0 |

## Users

- The initial operator enrolls repositories, creates or approves work, starts
  capable agents, reviews outcomes, and resolves blocked items.
- Repository maintainers review issues and pull requests produced by workers,
  even when they do not operate Fluent.
- Named organization members may participate later under explicit roles and
  permissions that have not yet been designed.
- A worker is any operator-started Codex, Claude, Copilot, OpenCode, Qwen, or
  other client able to follow the portable skill and MCP contract.

## Requirements

### Enrollment and RepositoryControllers

1. The operator MUST explicitly opt each repository into Fluent. GitHub
   organization membership MUST NOT imply enrollment.
2. Each opted-in repository MUST have one durable logical
   RepositoryController containing goals, observations, queued work, outcome
   history, and readiness state. A RepositoryController MUST be deterministic
   code plus durable state, not a model, prompt, conversation, provider session,
   worker process, or free-form memory.
3. Opting a repository out MUST prevent new claims while retaining its history.
4. Work MUST identify its repository, objective, acceptance criteria, origin,
   priority, allowed actions, delegation ceiling, status, and lineage.

### Coordination and execution boundary

5. Fluent MUST expose durable work that a manually started capable agent can
   list, inspect, claim, renew, complete, block, and release through an
   agent-portable interface. V1 uses MCP.
6. Fluent MUST NOT launch, supervise, authenticate, refresh credentials for, or
   sandbox Codex, Claude, Copilot, or other capable worker processes.
7. The worker client and operator environment MUST own provider selection,
   subscription login, tools, process lifecycle, and execution isolation.
8. Fluent MUST still enforce repository opt-in, per-item action authorization,
   delegation ceilings, leases, and provenance. Client-owned sandboxing MUST
   NOT be interpreted as removing the underlying security requirement.
9. One "work the Fluent queue" invocation MUST claim at most one item by
   default. Processing multiple items requires an explicit operator request.
10. Claims MUST be leased and recoverable. A stale client MUST NOT retain
    authority after its lease is reclaimed.
11. Completion MUST record a summary, concrete evidence, reported artifacts,
    worker identity, and zero or more child items atomically.
12. A worker MUST NOT grant child work actions outside the operator-defined
    delegation ceiling of its parent. Recursive decomposition MUST preserve
    root and parent lineage.
13. Worker-reported evidence and artifact URLs MUST be retained as provenance
    but treated as untrusted until independently verified.

### Deterministic control path and optional model assistance

14. Repository enrollment, work acceptance, claim selection, lease enforcement,
    authorization, delegation, state transitions, and provenance recording MUST
    be deterministic operations.
15. Model output MUST be treated as an untrusted proposal or claim. It MUST NOT
    authorize a state transition or bypass deterministic validation, even when
    it conforms to a structured schema.
16. The core queue MUST remain fully useful when no model endpoint is
    configured. Flue agents MAY provide optional bounded drafting,
    classification, summarization, or presentation assistance.
17. Optional local agents MUST NOT independently make architectural direction,
    perform heavy refactors, inspect repositories as the authoritative worker,
    broaden permissions, create policy-level durable work, or promote a worker
    claim to verified fact.
18. The optional Lemonade integration MUST support the OpenAI-compatible endpoint
    `http://10.0.1.200:13305/v1` and exact model
    `Qwen3.8-27B-GGUF-UD-Q4_K_XL`.
19. Local-agent context and output budgets MUST be set for a named bounded task
    and observed behavior, not raised merely because the model advertises
    a large maximum context window. Provider compatibility MUST NOT be reported
    as evidence of model sufficiency; each optional task requires a repeatable
    evaluation.

### Maintenance program

20. Fluent MUST support these initial maintenance work kinds:
    continuous quality improvement, CI maintenance, security, and architecture.
21. Continuous quality improvement in v1 MUST improve existing software quality
    and MUST NOT introduce product features.
22. CI maintenance MUST identify testing gaps, add and improve tests, and
    eventually monitor CI trends.
23. Security maintenance MUST audit repositories and MAY file issues and open
    pull requests for security improvements when the item permits those actions.
24. Architecture maintenance MUST guide repositories toward approved
    organization standards and MUST NOT assume the present `frostyard/core`
    structure is canonical.
25. The first vertical workflow MUST seed "identify one meaningful testing gap
    and propose a test that covers it" as read-only discovery, then allow the
    capable worker to create a bounded implementation child.

### Organization direction, knowledge, and readiness

26. V1 MUST recognize exactly five structured organization record kinds in
    `frostyard/core`: goal, policy, knowledge, criteria set, and exception.
    Records MUST have a common machine-readable identity, lifecycle, ownership,
    and applicability envelope at a merged Git revision. Fluent MUST NOT
    interpret arbitrary repository prose or its present layout as an
    authoritative schema.
27. Fluent MUST retain the source record identity and exact Git revision for
    organization context that influences admitted work. Workers MUST be able to
    consult that context and propose contributions, but an observation,
    database row, or unmerged change MUST NOT become accepted guidance or
    policy without the defined review path.
28. A goal MAY influence work discovery and priority but MUST NOT authorize an
    action or admit work. A policy MUST express a mandatory scoped constraint;
    knowledge MUST remain advisory; criteria sets MUST be immutable and
    versioned; and every exception MUST name its target, owner, scope, and
    expiry.
29. Conformance MUST be evaluated from tool-agnostic behavior and canonical
    instruction surfaces. A vendor-specific file such as
    `.claude/settings.json` MUST NOT establish conformance by itself.
30. Existing Frostyard ACMM implementation issues and the conformance skill in
    `frostyard/core` SHOULD inform criteria discovery without implicitly
    promoting their current content or placement into the authoritative
    contract. Every repository assessment MUST identify the criteria-set
    version it used.

### Goal application

31. A goal MUST declare its owner, repository applicability, inclusive start
    and end dates, lifecycle status, priority band, outcome, success measures,
    encouraged work, and excluded work. New work MUST treat a goal as active
    only when its status is `active`, its date window includes the current
    date, and it applies to the opted-in repository.
32. V1 goal priority bands MUST be `high`, `normal`, and `low`. Urgent work MUST
    be an attributed operator override rather than a persistent goal band.
33. An operator or authorized deterministic maintenance program MAY include
    applicable active goals in a bounded discovery item. A goal MUST NOT create
    or admit work by itself. An execution worker MUST receive only the goal
    snapshots accepted with its item, not the entire goal catalog.
34. A worker MAY propose goal references and explain the expected contribution,
    but MUST NOT set priority. Initial operator admission MUST confirm or remove
    proposed goal references before they influence scheduling.
35. On initial admission or operator-authored seeding, Fluent MUST derive a
    default queue priority deterministically from the highest accepted goal
    band; multiple goals MUST NOT add priority together. Work without a goal
    MUST retain its maintenance-program or operator default. An operator MAY
    override priority only with an attributed reason.
36. Admission MUST freeze the accepted goal snapshots, their exact
    `frostyard/core` revision, and the resulting priority. A later goal edit,
    pause, completion, cancellation, or expiry MUST affect future work only and
    MUST NOT silently rewrite, reorder, or cancel admitted work.
37. Goal measures MAY inform progress reporting but MUST NOT automatically
    change goal lifecycle. Fluent MUST surface conflicting applicable goals for
    operator resolution rather than delegate precedence to a model.

### Policy and exception enforcement

38. Every policy MUST contain stable requirement identifiers and declare its
    lifecycle, owner, applicability, effective date, rationale, required
    evidence, and applicable queue checkpoints.
39. Every policy requirement MUST use either a named, versioned deterministic
    verifier or an explicit attestation by an authorized reviewer. Fluent MUST
    fail closed when a required verifier is unknown, receives invalid input, or
    errors. A worker or model report MUST NOT satisfy a review requirement by
    itself.
40. At each protected transition, Fluent MUST produce an explainable policy
    decision citing the applicable requirements, verification or attestation
    results, exceptions, and exact `frostyard/core` revision.
41. Policy MUST be monotonic with respect to authority: it MAY remove actions,
    add obligations, or reject a transition, but MUST NOT grant authority beyond
    repository enrollment, Fluent's platform ceiling, root authority, parent
    delegation, or another applicable policy. The most restrictive result MUST
    win, and unresolved conflicts MUST require operator action.
42. An exception MUST name one exact policy requirement or versioned criteria
    criterion and declare its owner, approving authority, rationale, scope,
    inclusive start and end dates, and compensating controls. Its scope MUST be
    no broader than its target, and it MUST NOT waive opt-in, platform, root, or
    parent authority limits or unrelated requirements.
43. Fluent MUST re-evaluate exception validity at admission, claim, and lease
    renewal. A lease relying on an exception MUST NOT extend beyond its end
    time. Expiry or revocation MUST make affected unclaimed work ineligible and
    prevent renewal without deleting its history or authorizing follow-ups.
44. Admission MUST retain the policy decision as historical context. Ordinary
    policy edits MUST affect future admissions by default; applying them to
    existing work MUST require an attributed operator reconciliation. Exception
    status and expiry MUST remain live eligibility checks.

### Shared knowledge

45. A knowledge record MUST declare its owner, applicability, concise claim or
    guidance, supporting sources and their verification state, known
    limitations, lifecycle, review date, and `review_after` date. Fluent MUST
    NOT replace that provenance with a scalar confidence score.
46. Active knowledge past its `review_after` date MUST remain searchable and
    historically citeable but MUST be labeled stale and excluded from default
    worker context. Superseded and retracted knowledge MUST remain in history
    and MUST NOT enter default context.
47. Initial knowledge retrieval MUST be deterministic and bounded using
    validated applicability metadata and exact or full-text matching. Optional
    semantic retrieval MAY suggest records later but MUST NOT change their
    lifecycle, verification, authority, or exact citations.
48. Workers MAY propose knowledge additions, corrections, supersession, or
    retraction with sources and limitations. Such proposals MUST NOT become
    accepted knowledge until merged through the authorized `frostyard/core`
    review path.
49. Knowledge MUST remain advisory: it MUST NOT authorize actions, admit or
    prioritize work, waive policy, satisfy a verifier by itself, or change a
    readiness result. Fluent MUST surface conflicting active knowledge for
    review rather than ask a model to select the truth.

### Readiness criteria and assessments

50. Every criteria set MUST have a stable identifier and explicit immutable
    version. Any semantic, applicability, evidence, verification, criterion, or
    level change MUST create a new version, while old versions remain
    resolvable.
51. A criteria set MUST define ordered levels and stable criterion identifiers.
    Each criterion MUST declare its level, applicability, requirement, required
    evidence, and either a named deterministic verifier or an authorized review
    attestation.
52. Every assessment MUST pin the repository revision, criteria-set identifier
    and version, `frostyard/core` revision, evaluator, verifier versions,
    evaluation time, and per-criterion result and evidence.
53. Criterion results MUST be exactly `pass`, `fail`, `not-applicable`,
    `excepted`, `unknown`, or `error`. `Not-applicable` MUST require
    deterministic applicability or authorized attestation; `excepted` MUST
    identify a currently valid exception for that exact criterion version; and
    neither result MUST be stored as `pass`.
54. Fluent MUST derive a level from all applicable criteria at that level and
    every preceding level. `Unknown` and `error` MUST NOT satisfy a level. A
    level relying on one or more valid exceptions MUST display the exception
    count and waived criteria and MUST NOT appear as an unqualified result.
55. Assessments MUST remain immutable historical observations. New repository
    revisions or criteria versions MUST produce new assessments; current views
    MAY overlay expired exceptions or newer available criteria without
    rewriting history.
56. Worker-reported assessment evidence MUST remain untrusted until verified or
    attested. Failed, unknown, or errored criteria MAY generate proposed work
    with assessment citations but MUST NOT admit that work.

### Core authoring and snapshot import

57. `frostyard/core` MUST store strict JSON records under `organization/`, with
    fixed directories for goals, policies, knowledge, versioned criteria sets,
    exceptions, and immutable versioned JSON Schemas. Records MUST NOT live in
    a Fluent-specific directory or require a hand-maintained manifest. An
    implementing core ADR MUST explicitly permit organization-governed records
    scoped to individual repositories.
58. Every record MUST use a versioned common envelope containing `kind`,
    identity, lifecycle, ownership, and applicability plus a kind-specific
    `spec`. Paths and IDs MUST agree, references MUST be structured, object
    schemas MUST reject unknown properties, and semantic schema changes MUST
    create a new schema version.
59. Core CI MUST validate the complete organization tree with a pinned,
    standards-conforming JSON Schema Draft 2020-12 implementation plus
    duplicate-key, path, identity, reference, lifecycle, applicability, and
    bounded-input checks. Core and Fluent MUST share valid and invalid
    conformance fixtures while retaining independent validator implementations.
60. Fluent MUST import from a configured Git repository and branch through a
    read-only bare mirror. It MUST read Git trees and blobs only and MUST NOT
    check out files, follow source symlinks, execute hooks or scripts, or load
    validator code from `frostyard/core`.
61. Fluent MUST recognize only schema versions bundled with its release. A
    fetched schema MUST NOT redefine an existing version, and an unknown version
    MUST fail closed until Fluent explicitly supports it. Fetched recognized
    schemas MUST match Fluent's bundled expected digests.
62. A core commit MUST activate atomically only after the entire bounded tree,
    every record, every reference, and every cross-record invariant validates
    and the immutable snapshot is durably stored. Failure MUST retain the last
    known-good snapshot and expose the candidate commit and diagnostics.
63. Every snapshot MUST retain the source URL, branch ref, commit and tree IDs,
    raw record bytes, parsed records, content hashes, validation report, import
    time, and whole-catalog digest. Work MUST cite the snapshot and record
    identities rather than a mutable branch name.
64. Automatic activation MUST require the candidate commit to fast-forward the
    active source commit. Rewinds, unrelated history, and rollbacks MUST require
    an attributed operator action and MUST NOT delete prior snapshots.
65. V1 MUST support manual synchronization and configurable periodic polling.
    The default healthy cadence MUST be 15 minutes from prior completion, with
    one leased run, 30/60-minute consecutive source-outage backoff, and
    suppression only for consecutive equivalent candidate-invalid or
    continuity-blocked detail. Successful unchanged checks MUST remain durable
    freshness evidence.
    After 24 hours without a successfully fetched and validated source ref, new
    goal-derived discovery and organization-dependent admission MUST fail
    closed by default while existing context and admitted work remain usable.
66. Date-based rules MUST continue locally during source outages, so stale
    source data MUST NOT prolong a goal or exception. A stale-source override
    MUST be attributed, time-bounded, and conspicuously reported. Source
    freshness MUST remain distinct from Core admission readiness: candidate
    invalidity, unresolved continuity rejection, and persistence failure MUST
    block new organization-dependent discovery and admission immediately, and
    the override MUST relax only elapsed-time staleness.
67. Organization policy MUST complement rather than replace repository-local
    policy and CI enforcement. Fluent MUST apply the most restrictive result
    from both layers and MUST NOT overwrite local policy files during import or
    synchronization.

### Repository enrollment

68. Initial enrollment MUST require a strict JSON repository declaration under
    `organization/repositories/<owner>/<repository>.json` in a PR merged to the
    configured `frostyard/core` branch. GitHub organization membership, topics,
    Fluent controls, repository-local files, workers, and models MUST NOT enable
    an undeclared repository.
69. A declaration MUST identify both the GitHub `owner/name` and immutable
    repository ID, accountable owners, fleet state, enabled maintenance
    programs, and an action ceiling no broader than Fluent's platform ceiling.
    It MUST NOT contain credentials, provider or worker configuration, or
    repository-local implementation details.
70. Activating the validated core snapshot containing a new `enabled`
    declaration MUST make that exact declaration eligible for deterministic
    repository reconciliation. Only after its immutable GitHub identity and
    required canonical surfaces match MAY Fluent establish enrollment, create
    the durable RepositoryController and enrollment event, and it MUST do so
    without creating work. Fluent MUST retain the source snapshot and PR or
    commit attribution when available.
71. Fluent MUST reconcile the declaration with GitHub and place only the
    affected repository on hold when the slug is missing, renamed, transferred,
    or archived, the immutable ID differs, or required local policy is
    unavailable. A hold MUST prevent discovery, admission, claims, and renewal
    without invalidating unrelated records in the core snapshot.
72. `paused` and `disabled` declarations MUST prevent new discovery, admission,
    claims, and lease renewal while retaining all repository history. Existing
    leases MUST NOT be lengthened; late terminal reports MAY be retained as
    provenance but MUST NOT restore authority or admit follow-ups.
73. An enrolled declaration MUST be changed to `disabled`, not deleted. Fluent
    MUST reject removal of a declaration present in its active snapshot. A later
    core PR MAY re-enable it. Held work MUST require attributed operator
    reconciliation before becoming claimable, except that work held solely by transient
    GitHub or canonical-surface unavailability MAY instead resume automatically
    after successful reconciliation only when its exact versioned repository
    authority-context digest is unchanged. Core pause/disable, an operator hold,
    any substantive reconciliation failure, or any changed digest MUST require
    an attributed per-item `resume` or `cancel` disposition.
74. The operator MUST be able to impose and clear an immediate local repository
    hold with actor, reason, affected gates, recovery rule, and time. That hold
    MAY only narrow the active core declaration; it MUST NOT enable a
    repository, add programs, raise ceilings, or survive as hidden state after
    it is cleared.
75. Core branch protection, CODEOWNERS, and review roles MUST govern who may
    merge enrollment changes. Fluent MUST display the active declaration,
    snapshot, GitHub reconciliation state, local hold, and effective
    intersection as separate facts.

### Canonical repository surfaces

76. Core MUST publish an immutable, versioned repository-surface contract under
    `organization/contracts/repository-surfaces/`. Every enrollment declaration
    MUST select one supported version, and a canonical path, meaning, or schema
    change MUST create a new version and explicit repository migration.
77. The initial contract MUST define exactly these canonical surfaces:
    `AGENTS.md` for agent instructions, `policies/agent-governance.json` for
    local agent governance, `.agents/skills/` for worker skills, and
    `docs/README.md` for documentation discovery. New surface types MUST require
    an identified consumer rather than speculative registry entries.
78. Core MUST define one strict, tool-agnostic v1 repository-agent-governance
    schema. It MUST be deny-by-default, use canonical action and protected-
    boundary vocabularies, declare change and exception controls, reject unknown
    properties, and permit local policy only to narrow effective authority.
79. A canonical file MUST be a regular Git blob and a canonical directory MUST
    be a real Git tree. Legacy and provider-specific paths MAY be relative
    symlinks pointing to canonical content, but the canonical path MUST NOT be a
    symlink, submodule, generated artifact, or alias chain.
80. Fluent MUST read only the canonical path declared by the selected surface
    contract. It MUST NOT search fallback locations, normalize arbitrary
    JSON/YAML, follow compatibility aliases, or allow enrollment declarations
    to select arbitrary paths.
81. Fluent MUST validate repository governance at an exact repository commit
    with its bundled schema and retain the commit, surface-contract and schema
    versions, content hash, parsed policy, and resulting policy decision. A
    missing, wrong-type, invalid, unknown-version, or digest-incompatible
    required surface MUST place only that repository on hold. For automated
    enrollment, Fluent MUST resolve the observed GitHub default branch once and
    pin its head commit before loading any canonical path. A surface result and
    repository enrollment MUST remain separate durable transitions; valid
    surfaces alone MUST NOT create work.
82. Existing repositories MUST migrate to the canonical schema rather than
    receive permanent Fluent adapters. Snosi and lab are the closest schema
    precursors; updex MUST move and adapt its policy. Pilothouse's structural
    manifest and chairlift's quality tuning MUST remain distinct artifact types
    and MUST NOT be interpreted as agent-governance policy.

### Canonical governance vocabulary

83. The v1 repository-agent-governance schema MUST require
    `schema_version`, deny-by-default behavior, action decisions, protected
    boundaries, change controls, exception controls, and risk classification;
    it MUST reject unknown fields. Decisions MUST combine monotonically as
    `deny` over `review-required` over `allow`, with omission treated as deny.
84. Fluent's grantable v1 actions MUST remain `read`, `write`, `run-tests`,
    `open-issue`, `open-pr`, and `create-followup`. The shared policy vocabulary
    MUST additionally recognize `approve-pr`, `merge-pr`,
    `push-protected-branch`, `publish-artifact`, `publish-release`, `deploy`,
    `modify-protected-environment`, and `manage-credentials`, all of which the
    Fluent v1 platform policy MUST deny.
85. V1 protected boundaries MUST be `authentication`,
    `credentials-and-sensitive-data`, `cryptographic-trust`,
    `destructive-data`, `installation-and-update`,
    `release-and-publication`, `deployment-and-infrastructure`,
    `workflow-and-permissions`, `quality-gates`,
    `supply-chain-provenance`, and `security-disclosure`. Local policy MAY
    select and strengthen them but MUST NOT invent names or grant authority.
86. Selected boundaries MUST declare `deny` or `review-required`, a minimum
    risk tier, bounded repository-relative path patterns where applicable, and
    only known deterministic detectors. Admission MUST confirm proposed
    affected boundaries, and actual changed paths and detectors MUST be able to
    add—but never remove—boundaries during review.
87. V1 change controls MUST require pull requests, human review before merge,
    highest-applicable risk classification, validation evidence, least
    privilege, and treatment of untrusted content as data. Required checks,
    security checks, review requirements, coverage checks, and provenance
    verification MAY tighten but MUST never relax.
88. Exception controls MUST prohibit self-approval and require an independent
    authorized approver, exact target, rationale, compensating controls,
    expiry, and restoration or closure plan. Repository policy MUST NOT treat a
    local exception declaration as the accepted core exception record.
89. All repositories MUST use the ordered risk tiers `low`, `moderate`, `high`,
    and `critical`, select the highest applicable tier, and classify uncertain
    impact at the higher plausible tier. Local policy MAY raise but MUST NOT
    lower core boundary minimums or define another scale.
90. Fluent work and resulting pull-request provenance MUST retain risk tier,
    rationale, affected boundaries, required evidence, and the policy decision
    that produced them. Worker-supplied classification MUST remain untrusted
    until admission and changed-path review confirm it.
91. Migration from existing policies MUST preserve every restriction. Lab's
    three tiers and updex's numbered tiers MUST map into the four-tier model;
    repository-specific operations MUST map to canonical actions plus
    boundaries. Any rule without a lossless mapping MUST block migration rather
    than be dropped, weakened, or hidden in prose.

### Worker identity and GitHub reconciliation

92. Fluent MUST record the initiating operator or named-member principal,
    server-assigned worker session, work attempt, expected GitHub actor, actual
    GitHub actor, and descriptive client, provider, and model metadata as
    distinct provenance. Provider, model, Git author, Git committer, and other
    caller-supplied identity strings MUST NOT grant authority.
93. Authoritative principal and worker identity MUST be bound by the server-side
    authenticated session rather than selected by a queue request. Initial
    local stdio MAY bind the single operator implicitly, but the data model MUST
    preserve principal, session, and attempt separately.
94. Every successful claim MUST mint a unique attempt ID and public correlation
    nonce. A reported GitHub issue or pull request MUST carry a minimal marker
    containing its item, attempt, and nonce; the marker MUST NOT contain a lease
    token, credential, prompt, evidence payload, or private host detail.
95. Workers MUST use GitHub write credentials owned by their client and
    operator environment. Fluent MUST NOT receive, mint, refresh, proxy, store,
    or distribute those credentials.
96. Fluent MUST reconcile artifacts through a separate least-privilege,
    read-only GitHub identity. V1 MUST use a GitHub App installation for any
    repository whose merge or required-check history can affect authority, and
    MUST combine authenticated inbound App webhooks with bounded read-only
    polling and delivery audit. App keys, webhook secrets, and tokens MUST
    remain runtime secrets outside durable records and logs.
97. Issue and pull-request reconciliation MUST independently verify the
    immutable enrolled repository ID, artifact kind and number, canonical URL,
    actual GitHub actor, exact correlation marker, attempt timing, permitted
    action, and duplicates. Pull-request verification MUST additionally record
    base, head, commits, state, and that the worker did not merge it.
98. Artifact reconciliation MUST distinguish `reported`, `pending`, `verified`,
    `mismatch`, and `unavailable`. Completion reporting, artifact verification,
    policy or evidence validation, and maintainer acceptance MUST remain
    separate states and MUST NOT be presented as one another.
99. Verification MUST establish only artifact existence, repository identity,
    authenticated actor, and attempt lineage. Git author and committer strings
    MUST remain informational and MUST NOT satisfy an authenticated-actor
    check.
100. Pending and unavailable reconciliation MUST retry with bounded backoff and
    retain observations, source checkpoints, source gaps, GitHub delivery
    receipts, and state transitions. A GitHub outage or unauditable ingress gap
    MUST delay verification or make an overlapping population `unable` rather
    than turn absence of evidence into a mismatch.
101. An expired lease or later claim MUST create a new attempt and nonce. A late
    artifact from a stale attempt MUST remain visible provenance but MUST NOT
    silently satisfy the current attempt; an operator MAY explicitly adopt it
    only after successful reconciliation and applicability review.
102. Workers MUST be able to inspect known artifacts and reconciliation states
    for an item through a read-only queue operation before creating another
    issue or pull request. Duplicate detection MUST expose races and MUST NOT
    transfer authority between attempts.

### Common maintenance workflow

103. Every enabled maintenance program MUST have one logical program instance
    within its repository's RepositoryController. Quality, CI, security, and
    architecture MUST share one control loop while retaining distinct
    versioned responsibility and evidence contracts.
104. Enabling a maintenance program through the accepted core enrollment
    declaration MUST authorize its RepositoryController to create and admit
    recurring bounded read-only assessment roots under deterministic program
    configuration. Enrollment MUST still create no work by itself.
105. The RepositoryController MUST create an assessment only when its due rule
    is satisfied and no equivalent active root lineage exists. It MUST retain
    the trigger, program-contract version, exact core and repository snapshots,
    bounded subject and window, applicable context, and requested output cap.
106. An assessment MUST ask a focused question, define required evidence and a
    valid no-meaningful-finding outcome, and impose a hard limit on findings and
    proposed actions. It MUST NOT direct a worker to audit an unbounded
    repository area or produce activity merely to fill its output allowance.
107. The capable worker MUST own semantic analysis and MAY return evidence,
    findings, and bounded resolution proposals. Worker findings,
    classifications, summaries, and proposals MUST remain untrusted claims and
    MUST NOT directly mutate RepositoryController state, priority, holds, or
    scope.
108. The RepositoryController MUST record and deduplicate a report against
    known findings, queue lineages, issues, pull requests, and accepted
    outcomes. Ambiguous semantic equivalence MUST remain visible rather than be
    silently discarded.
109. Every worker-created implementation or GitHub-mutation follow-up MUST enter
    `proposed` and follow normal admission. Assessment authority MUST NOT carry
    into a follow-up, and a worker MUST open an issue or pull request only when
    its currently claimed item explicitly permits that action.
110. For admitted follow-up work, the RepositoryController MUST coordinate
    leases and lineage, independently reconcile reported artifacts, and perform
    or schedule the specialist contract's later re-evaluation. A completion
    report or existing pull request MUST NOT by itself resolve the finding.
111. Fluent MUST expose operational state, context freshness and validity,
    per-program conditions, finding lifecycle and verification, artifact
    reconciliation, and versioned readiness as separate facts. A calculated
    health presentation MUST NOT conceal or replace those facts.
112. Program cadence, concurrency and work-in-progress limits, retry behavior,
    deduplication, and assessment history MUST be deterministic and bounded.
    Model output MUST NOT decide when another maintenance assessment runs.

### Continuous quality workflow

113. The `quality` specialist MUST improve local correctness, testability, and
    maintainability without introducing product capabilities. It MUST NOT serve
    as a general repository-cleanup or feature-development role.
114. Quality MUST own meaningful behavioral test gaps, missing error and edge-
    case coverage, regression protection, weak or misleading tests, bounded
    behavior-preserving refactors, and removable local complexity or dead code.
115. CI execution and trends MUST route to CI maintenance; vulnerabilities and
    trust boundaries to security; package boundaries and broad restructuring to
    architecture; and changed product intent to feature delivery. A quality
    finding MAY retain that routing observation but MUST NOT inherit the target
    program's authority.
116. Each quality assessment MUST select one bounded subject at an exact commit,
    such as a recently changed component, important unprotected behavior,
    error-handling path, weak test area, or local maintainability hotspot. It
    MUST include relevant prior outcomes and available deterministic facts and
    MUST NOT request a whole-repository quality audit.
117. A quality finding MUST identify the exact behavior or code location,
    impact on correctness, testability, or maintenance, current evidence and
    observation method, bounded proposed improvement, validation method,
    uncertainty, expected risk, and any adjacent-program routing.
118. “No meaningful finding” MUST be a valid quality-assessment result.
    Coverage percentage, test count, changed-line count, linter volume, and
    similar scalar activity measures MAY support analysis but MUST NOT alone be
    a finding, objective, or proof of improvement.
119. An admitted quality implementation MAY add or improve tests and perform a
    small behavior-preserving refactor with an explicit preserved contract and
    focused evidence. It MUST NOT add product capability or silently change
    externally observable behavior.
120. A discovered behavioral defect MUST become separately scoped regression-
    test and correction work unless one approved item explicitly authorizes
    both at the effective risk tier. Test-improvement authority MUST NOT imply
    production-behavior authority.
121. A quality finding MUST be resolved only by re-evaluating its defined
    condition at an exact later commit with required validation evidence. An
    issue, reported pull request, unrelated passing CI, or increased aggregate
    coverage MUST NOT independently establish resolution.

### CI-maintenance workflow

122. The `ci-maintainer` specialist MUST preserve the reliability, diagnostic
    value, and reasonable efficiency of automated repository validation. It
    MUST focus on the validation system rather than absorb test-content,
    security, architecture, or product responsibilities.
123. The RepositoryController MUST collect bounded read-only CI facts when
    available, including workflow, check, job and run identities, conclusions,
    repository and commit associations, timing, attempts, reruns,
    cancellations, timeouts, normalized secret-safe failure signatures, and
    required-check configuration at an exact revision.
124. Every CI trend calculation MUST retain its deterministic query, source,
    inclusive time or run window, sample size, exclusions, and calculation
    version. Recurrence, rerun behavior, duration baselines, cancellation rates,
    and similar aggregates MUST be computed by code, not inferred by a model.
125. CI maintenance MUST own persistent validation failures, recurring failure
    signatures, historically supported flaky tests, materially slow or
    wasteful workflows, ineffective required validation, and bounded caching,
    dependency setup, runner, matrix, trigger, or workflow configuration.
126. Missing behavioral tests MUST route to quality; vulnerable actions,
    excessive permissions, untrusted execution, credential exposure, and trust
    failures to security; and broad build-system restructuring to architecture.
    CI work MUST preserve applicable `workflow-and-permissions`,
    `quality-gates`, and `supply-chain-provenance` boundaries.
127. A CI assessment MUST examine one bounded incident, signature, flaky-test
    candidate, performance regression, ineffective gate, or configuration
    problem using an exact observation window. One failed run MAY establish a
    current incident but MUST NOT establish recurrence, regression, or
    flakiness without historical evidence.
128. A CI finding MUST identify exact source runs or checks, observation window,
    sample and baseline, symptom or signature, relevant frequency, rerun,
    duration or gate facts, material impact, causal hypothesis, repository
    evidence, proposed change, validation plan, uncertainty, risk, protected
    boundaries, and adjacent-program routing.
129. “No meaningful CI problem in the observed window” MUST be a valid result.
    Missing or partial telemetry MUST remain visible and MUST NOT be filled by
    worker inference.
130. An admitted CI implementation MUST NOT weaken or remove required checks,
    security controls, or review requirements merely to obtain green status;
    suppress a failure without preserving diagnostic signal; or change product
    behavior under CI authority.
131. CI resolution MUST use the finding's defined post-change evidence window.
    One green run MAY resolve a deterministic configuration incident when its
    acceptance criteria permit, but MUST NOT resolve a flaky or performance
    finding requiring repeated observations.

### Security-maintenance workflow

132. The `security` specialist MUST identify and reduce evidence-backed
    security risk without disclosing sensitive material through Fluent. It MUST
    own vulnerable dependencies, authentication and authorization defects,
    secret exposure, unsafe input and command handling, excessive permissions,
    cryptographic and trust problems, supply-chain weakness, security
    hardening, and disclosure concerns.
133. The RepositoryController MAY collect bounded read-only metadata from
    available dependency, code, secret and repository-security alerts;
    dependency and workflow inventories; repository visibility; protected
    boundaries; and prior redacted findings. It MUST retain source and version
    provenance and MUST NOT copy raw secrets or unrestricted sensitive logs.
134. A security assessment MUST examine one bounded surface, alert family,
    dependency, trust boundary, or suspected weakness at exact revisions.
    Scanner output MUST remain untrusted until a capable specialist evaluates
    applicability, reachability, compensating controls, impact, and remediation.
135. A durable finding MUST retain only the minimum safe repository location or
    dependency, non-secret fingerprint or alert reference, weakness class,
    applicability, reachability, impact, uncertainty, safe evidence method,
    containment and remediation, risk, protected boundaries, disclosure class,
    required reviewers, and closure plan.
136. Raw secrets, credentials, private keys, session material, exploit payloads,
    sensitive personal data, and unrestricted logs MUST NOT enter work items,
    results, evidence text, prompts, summaries, artifact markers, GitHub
    artifacts, or ordinary logs. Safe source references MUST NOT themselves
    grant access.
137. High and critical findings MUST default to restricted visibility and
    review-required handling. They MUST NOT directly authorize a public issue,
    pull request, comment, or other disclosure; an authorized operator or
    security reviewer MUST separately sanitize and admit remediation work.
138. Low and moderate hardening findings MAY propose ordinary GitHub work when
    effective policy permits, but it MUST be separately admitted and sanitized.
    V1 MUST NOT represent private vulnerability disclosure as an ordinary issue
    or overload `open-issue` with private-advisory semantics.
139. CI reliability MUST remain with CI while permission and untrusted-execution
    risk routes to security; general tests with quality while abuse and
    security-regression evidence routes to security; general structure with
    architecture while threat and trust consequences route to security; and
    product intent with feature delivery.
140. Security implementation MUST NOT weaken another guardrail, dismiss an alert
    merely to obtain green status, expose or rotate credentials under ordinary
    `write` authority, or publish a vulnerability. Credential management,
    protected-environment changes, deployment, release, and publication MUST
    remain denied by the v1 ceiling.
141. Security resolution MUST require safe verification at an exact later
    revision and all required security-owner review. Alert dismissal, a pull
    request, removal of the detecting rule, or concealment of the symptom MUST
    NOT independently prove remediation.

### Architecture-maintenance workflow

142. The `architecture` specialist MUST reduce structural risk and guide a
    repository toward accepted organization and repository direction without
    inventing product intent or treating personal preference as a standard.
143. Architecture MUST own component and package boundaries, dependency
    direction and coupling, interface structure, data ownership and flow,
    cross-cutting duplication, structural technical debt, evolvability and
    operability constraints, standards conformance, and incremental structural
    migration plans.
144. A standards-based finding MUST cite the exact accepted core goal, policy,
    knowledge record, criteria version, or repository decision establishing the
    direction. A target based only on repository evidence MUST be labeled as a
    proposal rather than accepted organization intent.
145. Each architecture assessment MUST examine one bounded component boundary,
    dependency direction, interface, data flow, accepted standard, or
    structural hotspot at exact revisions. It MUST NOT request a whole-system
    architecture review, and no material concern MUST be a valid result.
146. A finding MUST identify the current structure, concrete risk or cost,
    accepted directional source or proposed status, affected components and
    contracts, bounded target state, incremental migration, preserved behavior,
    compatibility, non-goals, validation, rollback, uncertainty, risk, protected
    boundaries, and adjacent-program routing.
147. Local testability MUST remain with quality; workflow execution with CI
    unless part of a broader build boundary; threat and trust consequences with
    security; and product intent or public behavior with feature delivery.
148. Separately admitted architecture work MAY propose an ADR, issue, migration
    plan, or bounded behavior-preserving refactor pull request. An agent-authored
    ADR MUST remain proposed until the repository's human review path accepts
    it.
149. Architecture authority MUST NOT introduce product capability, silently
    break a consumer, change a public contract, or split a broad migration into
    maintenance PRs to bypass delivery-plan approval.
150. Structural difference between repositories MUST NOT itself establish an
    architecture defect. Standardization MUST cite accepted direction,
    compatibility need, or measurable maintenance or operational cost.
151. Architecture resolution MUST verify the bounded structural condition and
    its named consequences at an exact later revision. An ADR, issue, plan, or
    partial refactor MUST NOT independently establish conformance or risk
    removal.

### FleetController and cross-repository coordination

152. One Fluent fleet MUST have one logical FleetController composed of
    deterministic code and durable state. It MUST coordinate enrolled
    RepositoryControllers and MUST NOT be an LLM, prompt, conversation,
    provider session, or worker process.
153. The FleetController MUST retain the enrolled repository inventory, exact
    RepositoryController snapshots, declared producer-consumer and dependency
    relationships, compatibility observations and verification, applicable
    organization context, multi-repository initiative progress, and aggregate
    readiness and outcomes with their source facts.
154. Core MUST declare cross-repository relationships as strict JSON under
    `organization/relationships/<relationship-id>.json`, validated by
    `organization/schemas/v1/relationship.schema.json`. A relationship MUST be
    versioned operational configuration rather than a sixth context kind.
155. A relationship declaration MUST identify stable identity, lifecycle,
    purpose, accountable owners, producer repository and canonical contract
    reference, consumer repositories and canonical expectation or test
    references, compatibility policy, and immutable GitHub repository IDs.
156. The producer repository MUST own its canonical published contract and each
    consumer MUST own its canonical expectation or compatibility test. Core
    MUST declare intent and MUST NOT copy those artifacts. Fluent MUST read them
    only through versioned canonical repository surfaces at exact commits.
157. A missing, invalid, unsupported, or mismatched relationship artifact MUST
    hold only that relationship. A relationship MUST NOT enroll a repository,
    broaden an action ceiling, override local policy, or transfer contract
    ownership between repositories.
158. Semantic cross-repository analysis MUST use a bounded
    `fleet-architecture` worker citing every source revision. Its result MUST
    remain an untrusted finding until deterministic contract or schema checks,
    other accepted verification, or accountable human review confirms it.
159. Fleet architecture MUST examine one declared relationship, contract
    surface, or common outcome. Mere repository difference MUST NOT be a defect;
    a finding MUST cite compatibility policy, accepted direction, or measurable
    cross-repository cost.
160. A multi-repository delivery plan MUST verify that every target is enrolled
    and intersect every slice with its RepositoryController's effective policy.
    Fleet approval MUST NOT bypass local holds, admission, evidence, or review,
    and each slice MUST execute through its RepositoryController.
161. Cross-repository delivery SHOULD use compatibility-first sequencing:
    introduce a backward-compatible producer contract, adopt it in consumers,
    verify adoption, and remove deprecated behavior only in a later change.
162. Independent slices MAY proceed concurrently, but dependent work MUST wait
    for its independently observed predecessor signal. Fluent MUST NOT present
    pull requests in separate repositories as an atomic change.
163. Aggregate fleet health MUST remain a projection over separate repository,
    relationship, initiative, context, finding, artifact, and readiness states.
    It MUST NOT replace those facts with one authoritative scalar or model
    judgment.

### Feature initiative intake

164. Every feature initiative Fluent may plan MUST have one canonical Markdown
    PRD in `frostyard/core` at `docs/prd/<initiative-id>.md`. Repository-local
    PRDs MUST NOT grant Fluent v1 delivery authority; repository implementation
    plans and code MUST remain in the repositories they serve.
165. Each PRD MUST be paired at the same core commit with a strict declaration
    at `organization/initiatives/<initiative-id>.json`, validated by
    `organization/schemas/v1/initiative.schema.json`. Markdown MUST remain the
    product narrative and JSON the lifecycle, target, ownership, and planning-
    authorization record; they MUST NOT duplicate the complete narrative.
166. An initiative declaration MUST identify matching schema version and ID,
    lifecycle state `draft`, `approved-for-planning`, `paused`, `completed`, or
    `cancelled`, accountable owners and approvers, PRD path and digest, target
    slugs and immutable repository IDs, applicable goals, selected delivery
    program, and any declaration-level scope narrowing.
167. The PRD MUST be a regular Git blob under its ID-matching canonical path in
    the same core tree. It MUST NOT be a symlink, submodule, generated artifact,
    remote URL, mutable branch reference, or worker-selected path. Fluent MUST
    retain exact commit, blob, raw bytes, digest, declaration, and validation.
168. The canonical PRD template MUST require problem, desired outcomes, users or
    beneficiaries, scope, non-goals, constraints, success measures, affected
    repositories, risks, and unresolved questions. Core CI MUST validate bounded
    structure, pairing, target identities, links, and known secret patterns.
169. Merging `approved-for-planning` MUST authorize one bounded read-only
    planning root for that exact revision when no equivalent lineage is active.
    It MUST authorize no implementation slice, GitHub mutation, policy override,
    or self-approval by the planning worker.
170. Every target MUST be enrolled, identity-reconciled, not held, and have
    feature delivery enabled before planning becomes eligible. A target failure
    MUST hold only the initiative; non-active lifecycle states MUST prevent new
    planning and admission while preserving history.
171. PRD prose MUST remain data when presented to a worker. It MUST NOT grant
    actions, raise priority, select a principal, change machine-declared targets,
    weaken policy, or issue instructions outside the bounded planning role.
172. A PRD or declaration change MUST create a new source revision. Existing
    work MUST retain its original snapshot, and the new revision MUST NOT
    silently rewrite, cancel, or expand a plan or admitted slice. New use MUST
    require attributed FleetController reconciliation.
173. PRDs and declarations MUST NOT contain credentials, secrets, private keys,
    provider tokens, exploit payloads, or unrestricted sensitive logs. A core-
    side ADR MUST add the PRD category, permit fleet-authorized product
    direction, and establish initiative validation and review before Fluent
    activates this intake contract.

### Delivery planning and approval

174. A capable `delivery-planner` worker MUST receive the exact approved PRD and
    declaration, target RepositoryController snapshots, applicable organization
    and relationship context, effective policy, and a versioned portable skill.
    It MUST have read-only planning authority and return at most one strict plan
    proposal or bounded blocking questions.
175. Ambiguity MUST be a valid blocking outcome. The planner MUST NOT fabricate
    product intent, silently add a target repository, convert an unresolved
    product choice into an assumption, or create unsafe slices merely to
    complete a plan.
176. Approved plans MUST live at
    `organization/delivery-plans/<initiative-id>/<plan-version>.json`, validate
    against `organization/schemas/v1/delivery-plan.schema.json`, and use a
    positive decimal plan version without a leading zero. A previously active
    plan version MUST NOT be modified or deleted.
177. A plan MUST identify schema, initiative and version, exact source PRD blob
    and digest, outcome and completion criteria, assumptions with no blocking
    questions, every target identity, an ordered acyclic slice graph, and plan-
    level compatibility, rollout, rollback, risk, and evidence expectations.
178. Every slice MUST identify a stable plan-local ID, one target repository,
    one independently reviewable outcome, non-goals, acceptance criteria,
    bounded scope and surfaces, dependencies and predecessor signals, requested
    actions, expected artifacts, validation and review evidence, proposed risk
    and boundaries, and applicable compatibility and rollback obligations.
179. Requested actions, risk, and boundaries MUST remain untrusted planning
    inputs. Core and Fluent MUST independently validate identities, source
    digests, unique IDs, dependency existence and acyclicity, bounded sizes and
    vocabularies, and MUST intersect every slice with current effective policy.
180. Slices MUST represent outcomes rather than arbitrary file groups, prompt
    fragments, context chunks, or token estimates. One slice MUST produce at
    most one pull request by default; inseparable work MUST declare a safe
    intermediate compatibility mechanism or remain one slice.
181. The read-only planner MUST return its proposal to Fluent and MUST NOT push
    it to core. An operator or separately admitted publication worker MUST open
    a core PR adding the immutable plan and updating the initiative's
    `active_plan` version and digest without modifying prior versions.
182. Merging the core plan PR MUST be the attributed batch approval. The
    FleetController MUST atomically validate the complete plan against every
    current target; any held, missing, unenrolled, delivery-disabled, stale, or
    action-denying target MUST hold the plan and admit no slices.
183. Successful activation MUST materialize every exact slice as admitted work
    bound to its plan, PRD and target RepositoryController. Only dependency-
    eligible slices MAY be claimed, and later eligibility MUST require an
    independently observed predecessor signal plus another policy check.
184. Independent slices MAY run concurrently within explicit limits. Dependent
    slices SHOULD normally wait for predecessor merge or another accepted
    declared signal, and V1 MUST NOT create dependent stacked pull requests by
    default.
185. Any material plan change MUST create a new immutable version and approval
    PR. Activating it MUST NOT silently cancel, rewrite, or transfer claimed,
    completed, or admitted old-plan work; unfinished divergence MUST require
    attributed FleetController reconciliation before changed work is eligible.

### Bounded adversarial review

186. Fluent MUST define one capable `adversarial-reviewer` role with separate
    versioned `prd`, `delivery-plan`, and `pull-request` profiles. Review MUST be
    read-only and MUST NOT grant edit, GitHub-review, approval, merge, admission,
    policy-waiver, or scope-expansion authority.
187. Every review MUST bind to an immutable subject: exact core and PRD digests
    for PRDs, exact proposed plan and source digests for plans, or exact
    repository, PR number, base and head SHAs, verified diff, CI observation,
    slice and plan for pull requests.
188. The responsible controller MUST validate prerequisites before review. A PR
    review MUST NOT become eligible until its artifact is verified, exact head
    SHA is known, and required CI facts are available or explicitly unavailable
    under accepted review policy.
189. A valid result MUST use decision `pass`, `block`, or `unable-to-review`,
    contain no more than five blockers and three advisories, and name missing
    input or capability rather than fabricate a result when unable. `pass` MAY
    include advisories.
190. Every blocker MUST identify exact artifact location, violated accepted
    requirement or concrete counterexample, material impact, minimally
    sufficient resolution, verification method, and stable deduplication
    fingerprint.
191. Style preferences, optional improvements, alternative valid designs,
    speculative future concerns without current impact, and opportunistic
    adjacent work MUST NOT block. Advisories MUST NOT require resolution,
    prevent progression, or create work automatically.
192. PRD review MUST limit blockers to material contradiction, scope- or
    feasibility-changing unresolved decisions, untestable required outcomes,
    missing critical constraints, conflict with accepted direction, or safety
    and security omissions that prevent responsible planning.
193. Delivery-plan review MUST limit blockers to omitted or contradicted PRD
    outcomes, unsafe or cyclic ordering, non-reviewable slices without a safe
    compatibility mechanism, missing dependencies, impossible acceptance,
    policy or action mismatch, material risk or boundary underclassification,
    or missing required rollout or rollback.
194. Pull-request review MUST limit blockers to concrete correctness or security
    defects, unmet slice acceptance, unauthorized or out-of-scope behavior,
    false or materially insufficient required evidence, missing required
    validation, or compatibility and contract breaks. Implementation preference
    alone MUST NOT block.
195. The reviewer session and attempt MUST differ from the artifact-authoring
    session and attempt. Different provider or model metadata MAY improve
    diversity but MUST NOT establish identity, independence, or authority.
196. One artifact review lineage MUST receive no more than three completed valid
    automated rounds before human adjudication. Re-review MUST examine prior
    blockers and the subject diff; a new blocker MUST identify how that diff
    introduced it or made it newly assessable. Rewording or splitting a concern
    MUST NOT extend the budget.
197. Review lineage MUST follow the logical PRD, proposed plan, or plan-slice PR
    across corrective revisions. A new revision MUST NOT reset the budget
    automatically; only an attributed human MAY start another lineage after a
    recorded material scope change.
198. Any reviewed PRD or plan byte change and any reviewed PR head-SHA change
    MUST invalidate the applicable pass. A bounded re-review MAY run when budget
    remains; otherwise human adjudication MUST be required.
199. `block` MUST conservatively stop Fluent progression but remain an untrusted
    semantic claim. `pass` MUST satisfy only the adversarial gate and MUST NOT
    prove correctness, approve core or GitHub artifacts, accept risk, or replace
    maintainer review.
200. An authorized human MUST be able to mark each blocker `resolved`, `waived`,
    or `escalated` with actor, rationale, exact subject, and evidence. Human
    disposition MUST NOT override deterministic denial, holds, mandatory review,
    denied actions, or security exception controls.
201. A PRD or plan MUST require a current pass or explicit disposition of every
    blocker before activation. A merged PR with an unresolved blocker MUST be
    recorded as merged but MUST NOT verify its slice outcome or release
    dependents until authorized reconciliation.

### Delivery slice execution and rework

202. A `delivery-implementer` attempt MUST receive exactly one dependency-
    eligible approved slice through a versioned portable skill. It MUST NOT
    receive authority over the whole initiative or choose another slice.
203. Before eligibility, the RepositoryController MUST verify active enrollment
    and delivery enablement, current context and no hold, active reviewed plan
    lineage, every predecessor signal, current policy and evidence requirements,
    and no competing attempt or unresolved equivalent PR lineage.
204. The implementation brief MUST bind plan and slice, current default branch
    and head, predecessor outcomes, relevant contracts and context, effective
    actions, validation and review, existing artifacts, and attempt identity.
    Implementation MUST start from the current base while approved scope remains
    bound to the plan snapshot.
205. Material drift affecting scope, acceptance, ordering, risk, boundaries,
    compatibility, or rollback MUST block as `plan-drift` and propose an
    amendment. An implementer MUST NOT silently alter the approved slice to
    accommodate drift.
206. Within effective authority, an implementer MAY modify its client-owned
    worktree, run validation, commit, push one non-protected branch, and open or
    update one PR targeting the normal base branch. The PR MUST carry safe
    Fluent correlation and cite initiative, plan, and slice.
207. One slice MUST have one PR lineage and at most one open PR by default.
    Corrective pushes MUST update that PR; a replacement MUST require attributed
    reconciliation of the prior artifact.
208. Worker completion MUST report summary, evidence, commits, branch, PR,
    limitations, and drift or follow-up proposals. It MUST NOT establish
    artifact existence, CI success, review pass, maintainer acceptance, merge,
    or outcome verification.
209. Fluent MUST store dependency eligibility, attempts and repair budget,
    artifact reconciliation, CI, adversarial review, maintainer review, merge or
    closure, and outcome verification as separate facts. A derived delivery
    stage MUST NOT replace them.
210. Required pending or failing CI MUST stop progression. The implementer MUST
    NOT weaken validation to obtain green status. After deterministic
    prerequisites, the RepositoryController MUST create an adversarial review
    bound to the exact PR head.
211. An authorized maintainer's formal changes-requested decision MUST stop
    progression and MAY support repair. Free-form GitHub content MUST remain
    attributed untrusted data and MUST NOT expand scope, grant actions, or
    override the plan. Approval MUST NOT imply merge.
212. A repair attempt MUST remain on the same slice and PR and receive only the
    exact current head, unresolved CI failures, adversarial blockers, authorized
    change requests, and related diff. It MUST NOT reopen cleanup, feature
    scope, or review advisories.
213. One slice MUST receive one initial implementation attempt and at most three
    repair attempts by default. Exhaustion MUST require human adjudication;
    each additionally authorized attempt MUST be singular, attributed, bounded,
    and justified rather than resetting the budget.
214. Every corrective push MUST invalidate prior head-bound review and affected
    CI evidence without resetting review or repair budgets. Repeated signatures
    and blocker fingerprints MUST remain visible.
215. A PR closed without merge MUST require reconciliation before replacement.
    A PR merged with unresolved blockers, denied policy, missing required checks,
    or authorized changes requested MUST be recorded as merged but MUST NOT
    verify outcome or release dependents.
216. V1 delivery dependencies MUST use only `merged` or `outcome-verified`.
    Reported, open, CI-green, or approved PRs MUST NOT satisfy dependencies.
    `merged` MUST require independent base-branch and merge-gate observation;
    `outcome-verified` MUST additionally verify slice acceptance evidence.
217. Post-merge verification MUST use the slice's declared method and prefer
    deterministic evidence. Semantic verification MUST use a separate bounded
    read-only attempt; an implementer MUST NOT attest its own semantic outcome.
    Dependents MUST require the declared verified signal and a fresh policy
    check.

### Delivery and outcome verification

218. The post-merge semantic verification role MUST be named
    `delivery-verifier`. It MUST be a bounded read-only role with an attempt and
    session separate from implementation, and MUST NOT modify code or
    artifacts, expand acceptance, admit work, or act as success authority.
219. The RepositoryController MUST begin normal slice verification only after
    independently observing the exact merge commit on the declared base and
    reconciling required merge-time gates. A merge with unresolved gates MUST
    remain a merge fact without advancing to outcome verification.
220. A verification brief MUST bind initiative, PRD digest, plan and slice,
    exact merge revision, every acceptance criterion and evidence mode, typed
    subject, exact verification-profile version and parameters, absolute
    observation window, required evidence and owner, relevant contracts and
    predecessor outputs, confounding changes, allowed reads, and attempt
    identity.
221. Every slice acceptance criterion and initiative success measure MUST
    declare exactly one evidence mode: `deterministic`, `observational`, or
    `human-attested`, and MUST reference one exact versioned verification
    profile whose mode matches. Its typed subject, absolute observation window,
    and parameters MUST be complete, and the parameters MUST pass the profile's
    embedded schema. The profile plus parameters MUST be the v1 decision rule;
    scripts, generic expressions, and parallel prose rules MUST be rejected.
    Automation MUST be preferred only when it measures the actual requirement;
    Fluent MUST NOT substitute a convenient proxy for a semantic outcome.
222. A `deterministic` criterion MUST use a versioned evaluator over trusted
    repository, CI, artifact, or system facts and retain reproducible inputs,
    evaluator version, and result.
223. An `observational` criterion MUST name its trusted source, subject,
    baseline where applicable, threshold, observation window, and attribution
    limits. It MUST NOT pass before its declared window and decision rule are
    satisfied.
224. A `human-attested` criterion MUST require an authorized named principal
    and retain the exact subject, evidence, rationale, decision, and timestamp.
    Worker identity or model confidence MUST NOT satisfy the attestation.
225. A delivery verifier MAY recommend `pass`, `fail`, or `unable` and provide
    criterion-level evidence, but its model-derived recommendation MUST remain
    an untrusted claim. Only a deterministic evaluator, completed observational
    rule over trusted facts, or authorized human attestation MAY advance an
    authoritative criterion state.
226. Fluent MUST retain state and evidence for every criterion. A slice MUST
    reach `outcome-verified` only when all required criteria are satisfied for
    the declared subject and no hold or invalidation applies; a derived slice
    status MUST NOT replace the underlying facts.
227. Observation windows MUST be durable controller state rather than worker
    leases. Their start, end, observations, gaps, and intervening changes MUST
    be retained. Missing or materially confounded evidence MUST produce
    `unable`, not a fabricated pass or fail.
228. Failed or unable verification MUST NOT mutate the approved slice, erase
    its merge, or authorize repair. Fluent MAY create bounded proposed repair,
    rollback, investigation, or plan-amendment work carrying the exact failed
    criteria and evidence; normal admission and plan approval MUST still apply.
229. The FleetController MUST distinguish `implementation-complete` when every
    required slice has a reconciled `merged` signal, `delivered` when every
    required slice is `outcome-verified`, `measuring` while delivered work
    awaits required initiative measures, `outcome-achieved` when every required
    measure is satisfied, and `outcome-not-achieved` when the evaluation period
    completes with at least one required measure failed.
230. Paused, superseded, and cancelled MUST remain initiative-lifecycle facts
    imported from core rather than inferred delivery states. Delivery without
    outcome achievement MUST NOT itself authorize rollback, more features, a
    new plan, or a lifecycle change.
231. An approved delivery plan MUST operationalize every required PRD success
    measure with evidence mode, typed subject, exact verification profile and
    valid parameters, absolute observation window, and aggregation rule. The
    selected profile parameters MUST encode source-specific baseline,
    threshold, attribution, or accountable-human requirements. The plan MUST
    NOT silently weaken, replace, or omit a PRD measure; unmeasurable required
    outcomes MUST block planning pending resolution.
232. Every derived initiative state MUST expose its exact plan, slices,
    criteria, measures, evidence, and source revisions. Fluent MUST NOT infer
    business success from PR count, merge count, CI status, issue closure,
    worker confidence, or elapsed time.

### Worker grants and deterministic routing

233. Fluent MUST route work through a short-lived immutable `worker grant`
    stored in durable operational state and bound to one authenticated
    principal and server-assigned worker session. A grant MUST NOT be a provider
    credential, core organization record, reusable persona, or worker-authored
    claim.
234. V1 local stdio MAY bind the operator implicitly, but only an authorized
    operator surface MAY issue a grant. Remote transport MUST authenticate the
    principal before issuance; named-member issuance and receipt MUST remain
    unavailable until separately authorized by role policy.
235. A grant MUST record grant, principal, session, and issuer identities;
    issuance, expiry, revocation, and reason history; grant shape; exact
    immutable repository IDs; roles; versioned capability profiles; risk,
    action, and information-access ceilings; and the policy snapshots that
    constrained issuance.
236. A `repository-dedicated` grant MUST name exactly one repository and one or
    more roles. A `fleet-specialist` grant MUST name exactly one specialist role
    and an explicit non-empty set of enrolled repository IDs. V1 MUST NOT use a
    dynamic “all current and future repositories” scope.
237. Grant shape MUST constrain a session without implying a persistent worker,
    provider assignment, repository exclusivity, free-form memory, or another
    controller. Repository continuity MUST remain in RepositoryController state.
238. Claimable work MUST separately declare immutable repository ID, work role,
    versioned required capabilities, risk tier, requested actions,
    information-access class, and independence constraints. Admission or an
    authorized deterministic controller MUST fix these fields; workers MUST NOT
    select or weaken them.
239. Capability names MUST use one versioned Fluent vocabulary. In v1, an
    authorized operator MUST assign capability profiles. Provider, model,
    client, tool, environment, self-description, and work history MUST remain
    metadata and MUST NOT automatically add or broaden a capability or grant.
240. Before listing a brief or granting a claim, Fluent MUST verify the current
    session-bound grant; explicit enrolled repository; required role and every
    capability; risk, action, and information ceilings; current policy and
    holds; independence and dependency rules; admission; and work-specific
    eligibility. Unknown values MUST fail closed.
241. Routing authority MUST be the intersection of the work item, worker grant,
    current organization and repository policy, and product action ceiling.
    Every source MAY narrow authority; none MUST fill an authority absent from
    another required source.
242. A worker session MUST see only eligible work summaries and, after claim,
    the claimed brief. Ineligible or restricted work MUST NOT disclose its
    objective, instructions, evidence, lineage, or existence except through a
    separately authorized aggregate operator view.
243. One claim MUST lease at most one eligible item. The default claim path
    MUST use operator-owned priority and stable deterministic tie breaking over
    eligible work; providers and models MUST NOT rank the global queue. Any
    future targeted claim MUST still apply the complete eligibility predicate.
244. Grant expiry MUST bound its leases. Expiry or revocation MUST immediately
    prevent new claims and renewal, and every mutation MUST recheck grant,
    session, lease, and current policy. Later completion and artifacts MUST
    remain stale provenance without recovering authority or erasing history.
245. An authorized operator MAY narrow or revoke access. Any broadening MUST
    issue a new grant rather than mutate an in-use snapshot. A worker MUST NOT
    issue, choose, renew, modify, or delegate its grant.
246. Follow-up proposals MUST NOT inherit the proposing worker's grant. They
    MUST pass through normal admission and be matched independently to a later
    eligible worker session.

### Process observation and improvement

247. Each Fluent deployment MUST have one logical `ProcessObserver` implemented
    as deterministic code plus durable state. It MUST observe but not replace
    RepositoryController, FleetController, queue, review, verification, and
    routing source facts, and MUST NOT be a model, worker, prompt, or free-form
    memory.
248. Relevant operational events MUST retain correlation and subject IDs,
    timestamps, stage and transition, repository and initiative scope, role and
    risk, attempt and grant metadata, outcome classification, and exact
    applicable core, contract, workflow, skill, criteria, validation, plan, and
    policy versions or digests. Observation MUST NOT justify storing secrets,
    provider credentials, unredacted restricted findings, or full transcripts.
249. Observer metrics MUST expose stage funnels with numerator, denominator,
    exclusions, open or censored attempts, unavailable evidence, and source
    events. Worker-reported or absent usage MUST retain its verification state
    and MUST NOT be treated as trusted cost evidence.
250. Every performance judgment MUST use a versioned approved observation
    profile declaring comparable cohort, exact metric, exclusions and evidence
    quality, minimum completed sample and duration, baseline window, expected
    range, uncertainty rule, warning and andon thresholds, affected scope,
    response, review and recovery conditions, and anti-gaming guardrails.
251. Before a profile's minimum sample, duration, and evidence requirements are
    satisfied, its result MUST be `insufficient-data`, not healthy or degraded.
    Materially different governing versions or capability profiles MUST NOT be
    pooled merely to reach the minimum.
252. Baseline requirements MUST apply to performance judgments but MUST NOT
    delay a verified deterministic safety or integrity invariant such as an
    unauthorized action, cross-repository mismatch, restricted disclosure,
    invalid schema, or execution under a revoked grant.
253. ProcessObserver responses MUST distinguish `notice`, which records without
    stopping work; `scoped-hold`, which stops new affected admission,
    eligibility, claims, or advancement while allowing active leases to report
    into quarantine; and `safety-stop`, which immediately denies affected
    mutations and renewals and treats later outputs as stale provenance.
254. Every response MUST use the smallest evidence-supported combination of
    stage, governing version, role, risk, repository cohort, repository, and
    initiative. Scope expansion MUST require material new evidence or an
    attributed authorized decision.
255. An andon record MUST bind detector and observation-profile versions,
    condition, scope, evidence snapshot, response level, source events,
    creation actor and time, review deadline, clear condition, and dispositions.
    Restart or a later favorable event MUST NOT clear it; only its declared
    recovery rule or an authorized human disposition MAY do so, without
    overriding deterministic denial or a safety invariant.
256. A mature signal MAY produce one bounded read-only
    `process-improvement-analyst` proposal for its exact fingerprint and scope.
    After normal admission, its brief MUST provide baseline, cohort, funnel,
    failure distribution, governing versions, representative evidence, prior
    changes, and guardrails, without edit, publication, approval, or activation
    authority.
257. Process analysis MUST distinguish symptom from cause. It MAY return no
    more than three ranked causal hypotheses and SHOULD recommend the smallest
    discriminating change or experiment. A low stage-success rate MUST NOT by
    itself establish which upstream definition caused it.
258. An improvement proposal MUST identify exact evidence and baseline,
    affected canonical sources and versions, causal hypothesis, smallest
    change, expected mechanism, success and guardrail measures, rollout cohort
    and evaluation window, rollback conditions, risks, and uncertainty. It
    MUST begin non-claimable and MUST NOT clear its motivating andon.
259. Accepted improvements MUST follow the canonical source's adversarial
    review and approval path, land through a PR as a new immutable version, and
    roll out to a bounded explicit cohort before broader adoption. Results MUST
    compare against the preserved baseline; findings MUST NOT edit loaded
    definitions in place.
260. ProcessObserver MUST NOT author or approve its profiles, detectors,
    thresholds, guardrails, or recovery rules, and an analyst MUST NOT review
    or approve its own change. A profile revision MUST start a new comparison
    lineage without rewriting prior calculations.
261. Fluent MUST allow at most one active andon and one active improvement
    lineage per signal fingerprint, subject version, and scope. Repeated events
    MUST update that lineage; a closed no-change investigation MUST enter a
    declared cooldown until material evidence or governing versions change.
262. Observer ingestion lag, missing expected stages, invalid version metadata,
    calculation failures, and stale profiles MUST be visible self-health facts.
    Missing observer evidence MUST yield `unavailable` or `insufficient-data`,
    never process health, without creating a recursive hierarchy of observers.

### Portfolio scheduling and backpressure

263. Portfolio scheduling MUST be a deterministic control-plane function shared
    by RepositoryControllers and FleetController. It MUST NOT be a model,
    specialist worker, persistent agent, or independent source of product
    intent.
264. Fluent MUST retain source authorization and current eligibility facts,
    bounded ready candidate projection, work-attempt fact, and active lease
    operational state separately. `authorized` MUST mean a recognized source
    permits work to exist; `eligible` that current gates pass; `ready` that one
    projection generation selected it for claim consideration; and `claimed`
    only a display summary of the attempt and active lease. A display status or
    ready row MUST NOT replace those records or authorize claim.
265. Fluent MUST NOT preassign a separate `scheduled` state to an external
    process. Selection and lease creation MUST be one atomic claim; a ready item
    MUST remain available to any compatible grant until claimed, held,
    invalidated, or withdrawn.
266. Authorized scheduling sources MUST be limited to operator admission,
    enabled maintenance-program cadence, active approved delivery plans, and
    other explicitly accepted deterministic sources. RepositoryController,
    FleetController, and ProcessObserver MUST contribute only the bounded work
    their accepted contracts permit.
267. An empty authorized or eligible inventory MUST be valid. A ready target,
    idle client, active grant, organizational goal, or model suggestion MUST
    NOT authorize Fluent to invent work.
268. Versioned scheduling policy MUST independently limit total ready and
    claimed inventory, active lineages per repository, ready and active work per
    program or role, parallel initiative slices, open implementation PRs
    awaiting review or verification, downstream review/repair/verification
    inventory, and issue- or PR-producing outcomes per repository and window.
269. Every applicable limit MUST have room before materialization. Configured
    capacity MUST be reserved for review, repair, and verification so
    implementation cannot consume all work in progress. Limits MUST NOT cancel
    work, grant actions, satisfy dependencies, or create source authority.
270. A worker session MUST hold no more than one active lease by default. Any
    future explicit concurrency grant MUST remain subject to repository, role,
    capability, risk, action, information, and isolation constraints.
271. Scheduling MUST use the ordered priority bands `urgent`, `high`, `normal`,
    and `background`, set only by accepted deterministic policy or attributed
    operator decision. Priority MUST remain distinct from risk; neither work nor
    a worker MUST raise its own band.
272. Default atomic claim selection MUST first choose the highest compatible
    ready priority band, then choose a repository by deterministic deficit
    round-robin with equal weight absent stricter accepted policy, then choose
    the repository's oldest ready item in that band, with stable item identity
    as the final tie breaker.
273. Fairness credits and accepted weights MUST be durable and reconstructable.
    An ineligible repository MUST NOT accumulate an unbounded claim on future
    capacity.
274. Versioned aging policy MAY promote a ready item by at most one band after a
    declared wait but MUST NOT promote into `urgent`, bypass a hold, alter risk
    or actions, or override routing. Original priority and aging history MUST be
    retained.
275. An attributed operator MAY pin one eligible item ahead of ordinary
    selection, impose a scoped hold, drain a bounded scope, or reduce capacity.
    Pins, drains, and capacity reductions MUST record reason and expiry; holds
    MUST record reason, affected gates, and recovery or expiry. No runtime
    intervention MAY bypass authorization, policy, dependency, andon, WIP,
    information, or grant gates.
276. Continuous consumption MUST be an explicit operator-started client mode
    that claims and resolves one item at a time. Grant expiry or revocation, an
    andon, budget exhaustion, or no eligible work MUST end normal consumption.
    A wait or event stream MAY reduce polling but MUST NOT make Fluent manage
    the client process.
277. Authorized or eligible work without a compatible active grant MUST produce
    a capacity gap naming missing repository scope, role, capability, risk
    ceiling, action, information class, or independence. It MUST NOT broaden a
    grant, duplicate work, lower requirements, or start a client.
278. A completed valid no-meaningful-finding maintenance assessment MUST
    increase its next interval within versioned program minimum and maximum
    bounds. Relevant repository change, governing-version change, regression,
    accepted finding, or attributed operator action MAY reset cooldown; failed,
    blocked, invalid, or unavailable results MUST NOT count as no-finding.
279. Authoritative scheduling budgets MUST use independently observable claims,
    attempts, lineages, rounds, elapsed windows, GitHub artifacts, created-item
    rates, and concurrency. Provider token or cost reports MUST remain labeled
    ProcessObserver evidence, not hard v1 scheduling inputs without a trusted
    adapter.
280. Durable organization scheduling constraints, weights, and cadence bounds
    MUST be canonical core policy. Runtime pins, holds, drains, and capacity
    reductions MUST be attributed Fluent operational state; pins, drains, and
    capacity reductions MUST expire, while holds MUST persist until their
    accepted recovery or clearing rule succeeds. Runtime state MUST NOT relax a
    core maximum or prohibition.
281. Every authorization, eligibility, materialization, exclusion, selection,
    aging, capacity-gap, budget, and override decision MUST emit enough
    versioned evidence for ProcessObserver to reconstruct its funnel and cohort
    without retaining secret work content.

### Typed human decisions and OperatorInbox

282. Every required human authorization MUST be a durable typed decision
    record. `OperatorInbox` MUST be a deterministic derived view of pending
    records for the operator, not a work queue, controller, agent, or independent
    authority.
283. Decision records MUST NOT be claimable, delegable, or resolvable through
    worker MCP or model output. Worker reports and recommendations MAY be
    evidence but MUST NOT choose a disposition.
284. A decision MUST bind immutable identity and type, source and lineage, exact
    subject and revision or evidence snapshot, scope, risk and information
    class, policy and authority snapshot, safe evidence, reason required,
    finite permitted choices and deterministic effects, deciding role, rationale
    requirement, deadline or expiry, invalidators, state, and append-only event
    history.
285. Free-form rationale MUST be evidence attached to a typed choice. It MUST
    NOT add a choice or action, change scope, waive an undeclared constraint, or
    become instructions to a worker.
286. Submission MUST repeat the exact subject and authority versions shown to
    the principal. Fluent MUST transactionally recheck identity, role, subject,
    evidence, policy, holds, state, and invalidators; changed binding facts MUST
    reject the choice as `stale` and MUST NOT transfer it to refreshed facts.
287. Decision state MUST distinguish at least `pending`, `resolved`, `expired`,
    `superseded`, `cancelled`, `stale`, and `waiting-external`. Resolution MUST
    retain principal, choice, rationale, subject, effective changes, time, and
    events; identical replay MUST be idempotent and conflicting replay rejected.
288. A choice MUST perform only effects declared by its versioned contract and
    current policy. It MUST NOT override deterministic denial, action ceiling,
    expired exception, security control, safety invariant, opt-out, or canonical
    approval path; permitted exceptions MUST use their explicit workflow.
289. V1 runtime decision contracts MUST cover proposal admission, deferral and
    rejection; blocked-work requeue or cancellation; adversarial-blocker
    disposition; one extra bounded attempt; stale or replacement artifact
    reconciliation; grant issuance, narrowing, or revocation; permitted andon
    disposition; temporary scheduling controls; semantic attestation; and
    modeled responses to drift or failed verification.
290. Each decision type MUST retain its own authority, choices, effects, and
    invalidation rules. Presence in OperatorInbox MUST NOT imply that the
    current principal can take every displayed action.
291. Core-owned organization decisions MUST remain Git decisions. Fluent MAY
    dismiss, request a bounded PR proposal, or link a core PR, but MUST remain
    `waiting-external` until independently observing the authorized merge in a
    valid core snapshot. Local approval MUST NOT mutate core-owned records or
    lifecycles.
292. Repository-owned decisions MUST remain canonical repository or GitHub
    acts. Fluent MUST independently observe maintainer review, repository PRs,
    merge, and artifact state; an inbox choice MUST NOT forge those acts or
    authorize Fluent to merge, release, or deploy.
293. Restricted security decisions MUST use their private access and disclosure
    path. Unauthorized principals MUST NOT see existence or metadata when it
    would leak sensitive information, and v1 batch decisions MUST exclude
    restricted security records.
294. Batch decisions MUST share decision type, authority rule, information
    class, risk ceiling, choice, and contract version; preview every subject and
    net effect; enforce a hard size limit; reject atomically if any member is
    stale or unauthorized; and record one disposition per subject. A universal
    “approve all” MUST NOT exist.
295. Web UI and CLI MUST call the same authenticated decision API and receive
    identical preview, validation, stale detection, and result. OperatorInbox
    MAY filter by deadline, severity, repository, initiative, type, and access,
    but presentation state MUST NOT carry authority.
296. Every rendered decision MUST identify whether resolution is local,
    requires a core PR, requires a repository or GitHub act, or requires the
    private security path. Fluent MUST present the consequences and remaining
    obligations of every offered choice before submission.
297. Pending decisions MUST NOT default to approval. Expiry MUST apply the
    decision contract's fail-closed result, normally retaining the hold or
    ineligibility, and record that no authorization was granted; deadlines and
    notifications MUST remain aids rather than consent.
298. V1 MUST preserve required role and exact principal despite having one
    operator. Decision events MUST be available to ProcessObserver with safe
    type, scope, governing versions, wait, staleness, and outcome facts, but
    ProcessObserver MUST NOT resolve decisions or modify their contracts.

### Canonical domain language

299. Fluent MUST maintain one canonical human-reviewed ubiquitous language at
    `docs/domain/ubiquitous-language.md`, with root `CONTEXT.md` as a
    compatibility symlink rather than a second editable source.
300. A canonical term MUST have a lean one- or two-sentence definition, rejected
    or dangerous synonyms, and links to the Accepted ADRs establishing it. The
    language MUST NOT become an implementation spec, schema, state table,
    decision log, planning history, or prose copy of this PRD.
301. Normative contracts MUST use precise types instead of `agent`, generic
    `task`, unqualified `claim`, generic `approval`, or ambiguous `complete`.
    Informal product narrative MAY use agent, but APIs, schemas, UI actions,
    skills, and worker briefs MUST use the exact controller, worker, role,
    session, attempt, assertion, work item, or authority act.
302. Domain language MUST be updated when a design conversation resolves a term
    or when a code, schema, API, UI, skill, or documentation change introduces
    or changes a domain concept. Review MUST challenge conflicting terms rather
    than silently choosing a synonym.
303. A terminology change that embodies a significant tradeoff MUST first use
    the normal ADR path. An agent MAY draft or challenge language but MUST NOT
    promote unreviewed definitions to canonical truth.
304. The canonical language MUST describe the accepted target product while
    live specs remain truthful about implemented behavior. A mismatch MUST be
    recorded as an open language question or explicit migration; it MUST NOT be
    hidden by weakening the term or documenting unimplemented code as live.

### Feature delivery

305. Feature delivery MUST be an explicit v1 program that an enrollment
    declaration MAY enable for an opted-in repository. It MUST NOT be deferred
    to an unspecified future product version or enabled implicitly by ACMM
    level, repository maturity, an existing issue, a PRD, or a model.
306. Fluent MUST accept a human-authorized PRD at an exact source revision and
    coordinate its decomposition into bounded, ordered implementation work. A
    PRD or planning-model output MUST NOT directly create claimable work before
    the versioned plan and approval contract is defined and satisfied.
307. Approved feature work MUST remain within effective repository policy and
    the v1 action ceiling: capable workers MAY open the ordered pull requests,
    but Fluent MUST NOT authorize merge, release, or deployment. Scope or plan
    amendments MUST NOT silently inherit prior approval.
308. Discovery and implementation planning MUST define the detailed feature-
    delivery workflow after the RepositoryController and maintenance-agent
    workflows. That design order MUST NOT be interpreted as a runtime rule that
    maintenance work always precedes feature work.

### Authority, hosting, and product surface

309. V1 action authority MUST stop at reading/writing code, running tests,
    opening issues, opening pull requests, and creating follow-up work. Fluent
    MUST NOT authorize merge, release, or deploy.
310. The system MUST be fully self-hosted on the operator's server and initially
    support a single live operator. Initial spikes MUST run directly on the
    host. Incus, Podman, or Docker MAY host clients later, but that is an
    operator deployment choice outside Fluent's process model.
311. The single-host control plane SHOULD use SQLite until measured operational
    needs justify a database server.
312. Subscription credentials and short-lived provider tokens MUST NOT enter
    Fluent's database, transcripts, logs, work items, or knowledge base.
313. Worker transport MUST support authentication before it is exposed beyond a
    local stdio boundary.
314. Every user-facing surface MUST use the Frostyard design system after
    `frostyard/core` publishes a stable, consumable contract for it.
315. Every capable-worker follow-up MUST begin as non-claimable proposed work.
    Initial host-local operation MUST require an actor-attributed operator
    approval or rejection before the proposal can be claimed.
316. One completion MUST propose no more than ten children, and decomposition
    MUST stop four parent-child edges below a root. Continuous consumers MUST
    consume admitted work only and MUST NOT approve their own proposals.
317. The operator MUST be able to withdraw admission from queued, unclaimed
    work for later approval or rejection, and MUST be able to requeue or cancel
    blocked work with an actor-attributed reason. Workers MUST NOT receive
    those admission or blocked-work transitions through MCP.

### Control-plane records and event ledger

318. Fluent MUST use a fact-oriented relational control-plane store with a
    separate append-only event ledger. Event replay MUST NOT be the sole source
    of current authority.
319. Every durable subject MUST have a registered subject kind and stable
    identity independent of its display name, mutable locator, and revision.
    Statements about exact content MUST also bind the applicable revision,
    digest, or external SHA.
320. The durable model MUST distinguish definitions, assertions, observations,
    evidence references, facts, decisions, operational state, projections, and
    events. One class MUST NOT silently substitute for another at an authority
    boundary.
321. Every durable assertion, observation, evidence reference, fact, decision,
    and event MUST carry the common conceptual envelope defined by
    [ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md),
    including identity, typed schema, exact subject, provenance, time,
    correlation, causation, information class, digest, and applicable
    idempotency identity.
322. Record, subject, predicate, transition, and decision kinds MUST come from
    versioned typed registries. Unknown kinds or schema versions MUST fail
    closed at authority boundaries; syntactically valid free-form JSON MUST NOT
    create authority semantics.
323. Facts MUST be append-only propositions. Supersession, invalidation, and
    changed applicability MUST create attributable records rather than mutate
    historical payload or provenance, and conflicting facts MUST NOT use
    last-write-wins unless the predicate contract explicitly permits it.
324. An assertion MUST become authoritative only when an accepted verification
    or attestation mechanism creates a fact that cites the evaluated assertion
    and evidence. Mutation, confident language, or trusted transport alone MUST
    NOT promote an assertion to a fact.
325. Deterministic command handlers MUST bind the authenticated principal and
    session, command schema, exact expected revision binding, idempotency key,
    and typed payload. Invariant evaluation, accepted writes, and event
    insertion MUST be transactional, with optimistic concurrency and
    deterministic idempotent replay behavior.
326. Fluent MAY mutate operational state in place only for current concurrency
    and delivery mechanics such as leases, cursors, fairness credits, retry
    schedules, and WIP counters. The same transaction MUST record attributable
    history, and mutable operational state MUST NOT become retrospective
    product truth.
327. Events MUST be append-only, past-tense, schema-versioned, subject-bound,
    correlated, and causally attributable. They MAY support audit,
    notification, ProcessObserver, and debugging, but MUST NOT by themselves
    establish authorization, evidence sufficiency, or a canonical external
    act; sensitive content MUST remain behind information controls.
328. Projections MUST be rebuildable from authoritative records and current
    operational state, carry their projection version, and remain caches or
    views. No universal status field MAY own a subject lifecycle.
329. RepositoryController, FleetController, and ProcessObserver MUST operate on
    the shared typed store rather than private copies of truth. V1 MUST retain
    SQLite and bootstrap the target control plane in a fresh database. It MUST
    NOT import, reinterpret, dual-write, or read through queue-spike rows.
330. Every subject reference MUST contain both a registered `subject_kind` and
    its kind-specific opaque canonical `subject_id`. General control-plane code
    MUST NOT interpret an untyped ID or infer identity from payload shape.
331. The versioned subject-kind registry MUST declare each kind's authority
    namespace, ID validation, accepted revision-binding kinds, authoritative
    adapters or commands, and display-locator behavior. Unknown kinds, schemes,
    revisions, and malformed IDs MUST fail closed at ingestion and authority
    boundaries.
332. New Fluent-native subjects MUST receive server-generated UUIDv7 identity.
    Definitions imported from authoritative sources and external observations
    MUST retain their valid source-native identity rather than being rewritten
    as UUIDv7.
333. External subjects MUST retain source-native stable identity: GitHub
    repositories use service-qualified immutable repository IDs; issues and
    pull requests include repository identity and their source identity; Git
    objects use repository and algorithm-qualified object IDs; and core records
    use declared kind and ID qualified by immutable core repository identity.
334. If an external source cannot provide stable identity sufficient for an
    authority act, Fluent MUST retain the available observation but MUST NOT
    mint a substitute or pass the affected gate without an accepted
    reconciliation mechanism.
335. Every durable record occurrence MUST have a record identity distinct from
    its subject reference. New record identities MUST be server-generated
    UUIDv7; correlation, causation, idempotency, leases, public nonces,
    locators, and provider request IDs MUST NOT substitute for record identity.
336. Revision bindings MUST use registered kind-specific typed values and
    include every component required by the consuming command, predicate,
    review, or decision family. A change to any required component MUST make
    the bound authority act stale rather than move it to newer state.
337. Git-authored definitions MUST bind repository, commit, and applicable blob
    or payload digest; pull-request review MUST bind base SHA, head SHA, and any
    additional mutable evidence-snapshot digest on which it depends. An adapter
    MUST NOT claim revision exactness stronger than its source evidence.
338. Names, slugs, URLs, paths, branch names, and labels MUST remain versioned
    display locators rather than authority identity. Rename, transfer, archive,
    deletion, supersession, or access loss MUST NOT free identity for reuse;
    apparent replacement or conflict MUST produce mismatch or hold for
    reconciliation rather than an in-place identity rewrite.
339. Fluent MUST maintain a closed versioned predicate-contract registry as the
    sole semantic owner of authoritative proposition families. No public,
    administrative, MCP, plugin, controller, worker, model, import, or migration
    surface MAY provide a generic fact-writing operation.
340. Every predicate contract MUST define stable name and version, proposition
    and payload schema, allowed subject and revision kinds, cardinality and
    effective-time semantics, finite establishment paths, required authority
    and evidence, information class, invalidation and conflict behavior,
    reducer, and authority-sensitive consumers.
341. Unknown predicates, contract versions, establishment paths, payloads, or
    reducers MUST fail closed. Semantic changes MUST create a new contract
    version without reinterpreting existing facts; adding a predicate MUST ship
    registry code, schemas, positive and negative fixtures, migration analysis,
    and consumer review.
342. Workers and models MUST produce assertions, and external adapters MUST
    produce observations. Only a predicate contract's accepted canonical-source,
    deterministic-verification, typed-decision or attestation, internal-command,
    or deterministic-derivation path MAY establish its exact fact.
343. Each established fact MUST retain predicate-contract and establishment-path
    versions, exact subject and revision binding, principal or source, inputs,
    evidence and mechanism, effective and recorded time, information class,
    idempotency identity, and payload digest. Semantically different results
    MUST use different predicates rather than overloaded paths.
344. Fact establishment MUST transactionally validate identity, revision,
    authority, evidence, information class, idempotency, current applicable
    facts, and predicate invariants, then append the fact, evidence and
    dependency relationships, and event together. Rejection MUST NOT partially
    establish authority.
345. Controllers MUST invoke shared typed establishment commands and query the
    shared store. They MAY decide when to attempt a command but MUST NOT own
    private facts, write authoritative rows directly, or infer an unregistered
    predicate from an event or projection.
346. Every predicate reducer MUST be pure, deterministic, versioned, and bounded
    to declared records for one predicate and subject. It MUST NOT call a model,
    network, implicit clock, mutable configuration, or unrelated event stream,
    and MUST return explicit absent, current, set, conflict, or unavailable
    results as its contract requires.
347. Last-write-wins MUST NOT be the default conflict rule. Unresolved
    incompatible applicable facts MUST remain visible and make every
    authority-sensitive consumer fail closed; a human disposition MAY resolve
    conflict only through a path and effect declared by the predicate contract.
348. Calculated values MUST remain projections by default. Durable derived facts
    MUST use a registered deterministic derivation with exact versioned inputs,
    dependency edges, revision bindings, output schema, invalidation behavior,
    and named consumers; changed or conflicted inputs MUST make the derivation
    stale rather than rewrite it.
349. A queue-spike row MUST NOT establish a target fact or reserve a target
    identity. A still-useful spike objective MUST be re-authored through the
    current target authority path and receive new identity, provenance, time,
    and transaction order.
350. V1 information classes MUST be exactly `public`, `organization`, and
    `restricted`, ordered from least to most restrictive. Unknown classes MUST
    fail closed, and `public` classification MUST NOT itself authorize an
    external publication or mutation.
351. Raw credentials, tokens, session material, private keys, secret values,
    exploit payloads, sensitive personal data, and unrestricted sensitive logs
    MUST remain forbidden content rather than a fourth class. They MUST NOT
    enter records, prompts, events, artifacts, errors, traces, indexes, exports,
    or backups.
352. Every durable record, evidence relationship, event, and stored projection
    MUST receive an information class and information scope from its versioned
    contract. Clients, workers, models, payloads, source labels, repository
    visibility, and risk tier MUST NOT lower or substitute for classification.
353. Effective read access MUST intersect authenticated principal, session,
    role policy, worker grant where applicable, repository and subject scope,
    information-class ceiling, restricted compartment, current revocation or
    hold, and the record contract. A class ceiling alone MUST grant no access.
354. Derived records and relationships MUST inherit the most restrictive input
    class and intersection-safe scope by default. Lower-class records MUST NOT
    expose higher-class existence through identifiers, references, counts,
    fingerprints, titles, errors, URLs, correlation values, or stable hashes.
355. Declassification MUST create a separately identified lower-class record
    through an authorized versioned path with exact sources, bounded schema,
    leakage checks, rationale, audience, and evidence-bound attestation or
    decision. Mutation, field filtering, hashing, truncation, aggregation, or
    projection MUST NOT lower an existing record's class.
356. Unauthorized principals and workers MUST NOT learn that restricted work,
    records, evidence, decisions, events, relationships, artifacts, or lineage
    exist. Filtering MUST occur before ranking, counts, pagination, search,
    aggregation, scheduling, capacity-gap calculation, and notification, with
    non-revealing errors and targeted lookup behavior.
357. Work listing and claim MUST evaluate information access before returning a
    summary or creating a lease. A restricted item without compatible explicit
    scope MUST behave as absent to that session, and grant expiry, revocation,
    hold, or role change MUST immediately prevent future access and renewal.
358. Events and ProcessObserver inputs, funnels, findings, and andons MUST
    inherit the most restrictive contributing class and scope. References and
    aggregation MUST NOT automatically declassify them; any lower-class event
    or metric MUST use a separately registered safe contract and accepted
    declassification path.
359. Ordinary logs, metrics, traces, errors, and health endpoints MUST NOT copy
    record payloads, restricted subject identity, evidence, rationale,
    objectives, or briefs. Search, indexes, caches, and projections MUST enforce
    pre-result access rules and MUST NOT leak candidates, terms, snippets, or
    counts.
360. V1 MUST retain one transactional SQLite database and enforce class and
    scope through the shared application authorization layer. The database,
    WAL, temporary data files, diagnostics containing data, exports, and backups
    MUST inherit the most restrictive stored class and normally be operated as
    `restricted` assets.
361. V1 MUST state that information classification does not protect data from
    the operator controlling the self-hosted machine. Physical database
    separation MUST NOT be claimed as a host boundary; a future requirement for
    separate host administrators or keys MUST receive a new architecture
    decision.
362. Fluent MUST maintain a closed versioned projection-contract registry.
    Projections MUST remain disposable read models for display, filtering,
    coordination, scheduling, search, and observation; they MUST NOT establish
    facts, grant access or actions, satisfy evidence, own operational state, or
    authorize mutations.
363. Every projection contract MUST define name, purpose, version, consumers,
    output key and schema, exact typed sources and reducers, deterministic
    transformation and ordering, information handling, freshness and
    unavailability, rebuild and activation, drift checks, and generation
    retention. Unknown projection or source versions MUST fail closed.
364. Projection rebuild MUST read the authoritative records and current
    operational state declared by its contract and use registered fact reducers
    for authority-sensitive results. Events MAY trigger refresh and diagnose
    lag but MUST NOT be the sole rebuild source or substitute for source records.
365. Projection transformation MUST be pure for an explicit source snapshot and
    evaluation time and MUST NOT call a model, network, implicit clock, mutable
    configuration, or external authority. Conflicted, missing, or unknown
    required inputs MUST yield explicit unavailable or omitted output rather
    than a guessed newest value.
366. Every full rebuild MUST create an immutable projection generation with
    identity, contract and transformation versions, evaluation and build time,
    source watermarks and digests, information-handling version, counts,
    invariant results, and outcome. Fluent MUST validate a shadow generation
    and atomically activate it without disturbing the prior generation on
    failure.
367. Incremental projection maintenance MUST be semantically equivalent to full
    rebuild at the same source watermark and MUST receive periodic or triggered
    drift comparison. Projection rebuild or repair MUST NOT establish,
    invalidate, mutate, or delete source truth or operational state.
368. Before non-public disclosure or authority-sensitive mutation, the serving
    command MUST transactionally recheck current identity and revision,
    principal and session, role, grant, information access, facts, decisions,
    holds, policy, operational state, idempotency, and invariants from their
    authoritative sources. Projection versions and rows MUST NOT serve as domain
    concurrency tokens.
369. A stale projection MAY conservatively omit currently permitted results but
    MUST NOT reveal inaccessible records or make invalid candidates claimable.
    Filtering and current-source access checks MUST occur before output,
    ranking, counts, pagination, search, notification, or timing-visible result
    distinctions.
370. Ready inventory MUST be a named materialized candidate-selection
    projection over authorized work, reduced eligibility, dependencies, holds,
    priority, routing, current WIP and capacity state, and scheduling policy.
    Membership MUST mean only that the item was a candidate at that generation's
    source watermark.
371. Atomic claim MUST recheck current authorization, eligibility, information
    access, grant compatibility, WIP, capacity, holds, drain state, and lease
    absence before creating an attempt and lease. Candidate failure MUST create
    no authority transition and MUST trigger bounded safe projection repair or
    health evidence.
372. Leases, cursors, fairness credits, retry schedules, WIP counters, pins,
    holds, drains, and capacity reductions MUST remain operational state rather
    than projections. Materialization, exclusion, and selection events MAY
    preserve audit history but MUST NOT grant authority.
373. Status and stage views, OperatorInbox, and ProcessObserver funnels and
    cohorts MUST be named projections with contract, generation, source
    watermark, freshness, and information behavior. No universal status or
    cached inbox action MAY replace independent facts or current disposition
    authority.
374. The queue spike's `work_items.status` MUST remain truthful source state for
    its live prototype contract until coordinated replacement code and spec
    changes land. Target projection tables or caches MUST NOT become a silent
    alternate claim path, and target runtime MUST NOT read through spike state.
375. Every committed write transaction creating durable records MUST receive a
    monotonically increasing transaction sequence, and every record within it a
    deterministic transaction position. Their pair MUST be the canonical total
    order of accepted record occurrences across the control-plane store.
376. Transaction order MUST mean only Fluent persistence order and MUST NOT
    imply external occurrence, causality, supersession, or greater authority.
    Gaps MUST be valid, and backup restore and migration MUST prevent reuse of a
    sequence already visible in that database lineage.
377. Fluent MUST distinguish server-assigned recorded time, source-domain
    effective time, server-assigned observation time, source occurrence time,
    and server-assigned command evaluation time. Persisted instants MUST use
    unambiguous UTC while retaining original source precision when needed for
    provenance.
378. Workers, models, clients, repositories, commits, and external sources MUST
    NOT set recorded or evaluation time or reorder accepted history. Their time
    values MUST remain typed evidence with provenance and MUST NOT receive
    automatic precedence.
379. Effective or recorded time MUST NOT create implicit newest-wins behavior.
    Only a versioned predicate, decision, policy, or lifecycle contract MAY
    define how effective intervals affect applicability or conflict.
380. A mutating command MUST capture one evaluation time after acquiring its
    bounded SQLite writer transaction and use it for every authority and
    deadline check. Time-bounded authority MUST be valid only while
    `evaluation_time < expires_at` and expired at equality.
381. External I/O and model work MUST NOT run while the writer transaction is
    held. A command exceeding its transaction-duration bound MUST abort rather
    than commit using stale evaluation time.
382. Fluent MUST persist and monitor a control-time watermark. Material backward
    clock movement MUST fail closed for new or renewed time-sensitive authority;
    forward movement MAY expire authority early but MUST NOT extend it. Clock
    skew and recovery MUST produce visible operational evidence without editing
    prior times or sequences.
383. Late information MUST append at its current transaction sequence while
    retaining earlier effective or source time. It MAY trigger reducers,
    projections, holds, or reconciliation but MUST NOT rewrite prior records,
    insert into past sequence, or retroactively authorize an earlier command.
384. Historical authority and audit queries MUST support both `as known at`
    transaction sequence and, where applicable, `effective at` domain time. An
    effective-time result without an as-known boundary MUST be labeled current
    analysis because later information may change it.
385. Event-ledger and incremental-projection cursors MUST use transaction
    sequence and position rather than timestamp, UUID order, or external event
    order. Correlation and causation MUST be explicit identities and MUST NOT be
    inferred from timestamp proximity.
386. ProcessObserver MUST use sequence watermarks for complete ingestion and
    recorded server time for control-plane durations. Metrics using source or
    effective time MUST declare source quality, missing values, precision, and
    late-arrival treatment.
387. An idempotency receipt MUST bind principal or command scope, command and
    payload digest, key, retained result, record identities, transaction
    sequence and positions, evaluation and recorded time, and retention
    deadline. Equivalent replay MUST return the original result and metadata
    without re-evaluating newer authority.
388. Idempotency-key reuse with different payload, subject, principal scope, or
    command version MUST fail. Receipt retention MUST be versioned per command
    and no shorter than the unsafe duplicate-effect window; purging MUST NOT
    permit reuse of domain identity or rewriting prior history.
389. Queue-spike IDs, events, timestamps, ordering, actors, leases, results, and
    admission values MUST remain only in a read-only archive or secret-safe
    export and MUST NOT enter target records. Target records begin at their
    actual target transaction sequence and MUST NOT fabricate continuity with
    spike history.

## Non-goals

- Automatically enrolling every repository in the GitHub organization.
- Fluent-managed coding-agent processes, credentials, token refresh, or
  sandboxes.
- Requiring model inference for enrollment, queue operation, authorization, or
  provenance recording.
- Using the local Lemonade model as a substitute for capable architectural and
  implementation agents.
- Autonomous feature invention or implementation from an unapproved PRD or
  plan, plus all merge, release, or deployment in v1.
- Self-modifying observation, review, validation, workflow, skill, criteria, or
  agent-role definitions outside their canonical review and approval paths.
- A universal approval action or a Fluent-local substitute for required core,
  repository, GitHub, or restricted-security decisions.
- Treating one vendor's settings, instructions, skills, or credential format as
  the fleet-wide standard.
- Declaring the current `frostyard/core` layout, ACMM content, or design-system
  packaging correct before evaluation.
- Multi-host or active-active control-plane operation in v1.
- WebSocket push for workers in the first slice; pull through MCP is sufficient.

## Discovery inventory

This inventory distinguishes accepted product direction from implemented
behavior. An Accepted ADR is a design commitment, not evidence that its runtime
contract or code exists.

### Product areas with accepted direction

| Area | Accepted direction | Primary decisions |
| --- | --- | --- |
| Coordination boundary | Fluent coordinates durable work but does not manage capable-agent processes, credentials, sandboxes, or provider sessions; model output stays outside deterministic authority | [ADR-0003](../adr/0003-separate-work-coordination-from-execution.md), [ADR-0004](../adr/0004-keep-models-outside-the-control-path.md) |
| Admission and lineage | Worker-created follow-ups begin as proposals, admission is database-enforced, and attempts and GitHub artifacts retain distinct verified lineage | [ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md), [ADR-0006](../adr/0006-enforce-admission-in-the-database.md), [ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md) |
| Organization authority | `frostyard/core` owns canonical strict JSON organization records, enrollment, goals, policy, knowledge, versioned criteria, exceptions, relationships, initiatives, and immutable delivery-plan approval | [ADR-0007](../adr/0007-use-frostyard-core-as-the-organization-authority.md) through [ADR-0017](../adr/0017-standardize-actions-boundaries-and-risk.md), plus [ADR-0026](../adr/0026-coordinate-enrolled-repositories-with-fleetcontroller.md) through [ADR-0028](../adr/0028-approve-immutable-delivery-plans-in-core.md) |
| Repository maintenance | Deterministic RepositoryControllers run bounded quality, CI, security, and architecture maintenance workflows against canonical repository surfaces | [ADR-0020](../adr/0020-call-the-repository-coordinator-repositorycontroller.md) through [ADR-0025](../adr/0025-ground-architecture-in-accepted-direction.md) |
| Fleet and feature delivery | FleetController coordinates cross-repository contracts; approved core PRDs become immutable dependency-ordered plans, bounded slice PRs, review, repair, post-merge verification, and profile-bound measured outcomes | [ADR-0019](../adr/0019-include-feature-delivery-in-v1.md), [ADR-0026](../adr/0026-coordinate-enrolled-repositories-with-fleetcontroller.md) through [ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md), and [ADR-0054](../adr/0054-bind-success-measures-to-versioned-verification-profiles.md) |
| Worker routing and capacity | Operator-issued grants route repository-dedicated and fleet-specialist sessions; bounded fair scheduling applies WIP limits and reports capacity gaps | [ADR-0032](../adr/0032-route-work-with-operator-issued-grants.md), [ADR-0034](../adr/0034-schedule-a-bounded-ready-inventory.md) |
| Process improvement | Deterministic ProcessObserver uses mature versioned baselines, scoped andons, and governed analyst proposals without a self-modifying loop | [ADR-0033](../adr/0033-observe-processes-and-pull-scoped-andons.md) |
| Human authority | Typed optimistic-concurrency decisions feed OperatorInbox while core, repository, GitHub, and restricted-security acts remain in their canonical authority systems | [ADR-0035](../adr/0035-route-human-authority-through-typed-decisions.md) |
| Domain language | One canonical lean ubiquitous language distinguishes controllers, workers, work state, evidence, governance, delivery, intervention, and decisions for humans and capable workers | [ADR-0036](../adr/0036-maintain-a-canonical-domain-language.md), [Fluent ubiquitous language](../domain/ubiquitous-language.md) |
| Control-plane persistence | Typed authoritative records and current operational state answer authority; a separate event ledger supports audit and ProcessObserver without full event sourcing | [ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md) |
| Lifecycle and runtime intervention | Core owns pause lifecycle; typed runtime holds block named gates and drains stop new claims while permitting in-flight reporting | [ADR-0038](../adr/0038-separate-lifecycle-pause-from-runtime-interventions.md) |
| Subject identity | Typed source-native subject identity remains separate from server-generated record identity, mutable display locators, and kind-specific revision bindings | [ADR-0039](../adr/0039-use-typed-source-native-subject-identities.md) |
| Fact authority | Closed predicate contracts own fact establishment, evidence, reduction, conflict, derivation, and consumption; no generic fact-writing surface exists | [ADR-0040](../adr/0040-establish-facts-through-registered-predicate-contracts.md) |
| Information handling | Three ordered classes combine with exact information scope; restricted existence stays hidden, forbidden secrets stay out, and declassification creates a separately reviewed record | [ADR-0041](../adr/0041-enforce-three-information-classes-and-scoped-access.md) |
| Projection boundary | Versioned rebuildable read models accelerate ready inventory, status, inbox, search, and observation while every disclosure and mutation rechecks current authority | [ADR-0042](../adr/0042-use-rebuildable-projections-only-as-read-models.md) |
| Time and ordering | Transaction sequence orders accepted records while recorded, effective, observation, source-occurrence, and evaluation times retain distinct semantics | [ADR-0043](../adr/0043-order-records-by-transaction-sequence-not-timestamps.md) |
| Spike replacement | The target control plane starts in a fresh database; the queue spike remains a temporary predecessor and is archived rather than imported at cutover | [ADR-0044](../adr/0044-replace-the-queue-spike-database.md) |

### Implemented vertical-slice baseline

The code retains the host-local queue vertical slice described by the
[queue design](../design/queue-execution-boundary.md),
[work-queue spec](../specs/work-queue.md), and
[completed spike plan](../plans/queue-vertical-spike.md):

- SQLite work items, leases, lineage, bounded child proposals, and database-
  enforced admission;
- deterministic opt-in, testing-gap and dogfood seeds, proposal approval,
  deferral, rejection, blocked-work requeue, and cancellation through the CLI;
- stdio MCP listing, claim, heartbeat, completion, block, and release;
- the portable `work-fluent-queue` skill;
- artifact URL scope validation while worker evidence remains unverified;
- optional local-model queue-clerk compatibility outside the control path; and
- tests for current admission, lease, lineage, concurrency, and MCP boundaries.

That disposable spike does **not** implement the target control plane described
below. FleetController, ProcessObserver, worker grants, the factored scheduler,
OperatorInbox, maintenance roles, the feature-delivery pipeline, GitHub
artifact observation, and outcome fact establishment remain unimplemented.

The separate target [control-plane kernel](../design/control-plane-kernel.md)
now implements clean database identity, a distinct stable implicit local-
operator principal, closed bootstrap registries, transactionally ordered
database/principal definitions and initialization event, and one registered
sequence-bound integrity observation with idempotent replay, strict backward-
clock refusal, and fail-closed startup validation. It also implements two
registered rebuildable read models: a subject lookup and payload-free event
cursor with immutable generations, sequence watermarks, digests, atomic
activation, access filtering, stale/invalid health, and projection-only repair
under the exact [kernel specification](../specs/control-plane-kernel.md). Online
backup and create-only restore staging bind lineage, canonical authoritative
content, and a highest-visible sequence fence so an older restore cannot reuse
transaction order. A host-local JSON CLI exposes only those implemented
diagnostics and recovery operations. The kernel now also implements the first
bounded fact path: exact verified Core bytes are retained as immutable snapshots
and selected through an atomic, idempotent active-snapshot fact under the
[activation contract](../specs/core-snapshot-activation.md). That path creates
neither enrollment nor work. Later automatic activation now binds verified Git
ancestry from the active source commit. Attributed operator rollback creates a
resolved decision and new exact-target snapshot while retaining history and
supporting recovery from retained bytes. Source, validation, continuity, and
rolled-back persistence failures create bounded rejection observations and audit events while
standalone verification remains read-only. The accepted
[Core source readiness contract](../specs/core-source-readiness.md) separates
elapsed source freshness from the stricter new-admission gate. Its durable
  automatic outcomes, deterministic 24-hour read, and typed override decision
  with its 24-hour cap are implemented. Ordinary source-check and rejection
  detail now has a typed 30-day/10,000-item retention boundary with protected
  readiness and decision evidence. A leased deterministic `CoreSourceController`
  now owns the first narrow operational-state singleton and periodic synchronization.
  Active declarations now materialize as source-native GitHub repository subjects,
  exact definitions, and `repository.core-authorized` facts. Enabled declarations
  receive bounded GitHub identity reconciliation as a separate fact; missing,
  changed, mismatched, archived, and unavailable results remain scoped to that
  repository. Matched identities now receive exact-commit canonical-surface
  decisions and a separate enrollment transaction that creates the
  RepositoryController definition without work. Attributed non-expiring local
  operator holds now block four fixed repository gates across Core revisions
  until the exact hold is cleared, without changing enrollment history. Enrolled
  repository status now exposes a stable semantic authority-context digest and
  a closed evaluator permits automatic held-work recovery only after unchanged
  transient GitHub or surface outages; target work persistence and operator
  disposition commands remain. Snapshot validation now also accepts the
  backward-compatible verification-profile and Goal extensions, pins their
  exact schemas, validates referenced profiles, parameters, lifecycle, and
  conformance fixtures, and prevents unsafe automatic removal or mutation.
  The closed mechanism registry now contains the real callable
  `conclusive-run-rate:v1` evaluator; its
  `github-required-checks:v1` source adapter, evidence retention, fact
  establishment, and Goal application remain unimplemented, so a
  representative live Goal still fails closed.
  Registry version 14 fixes source-native App-hook, pull-request, check-run,
  and commit-status subjects and purpose-specific webhook, API, rules,
  transition, checkpoint, and gap revisions. It now also implements the first
  enrollment-bound typed GitHub-source transaction: an already verified,
  allowlisted, same-repository pull-request delivery atomically creates its
  receipt observation, pull-request observation, and audit event with exact
  replay and reopen-time lineage verification. A pure exact-body HMAC verifier
  and allowlisted payload normalizer now precede that command. Callable HTTP
  handling now exists as a bounded injectable POST-only router, but stays
  unmounted by default until hosting lifecycle and coverage recovery exist.
  The fixed pull-request-delivery audit scope now has typed point/continuation
  checkpoints, lower-bounded source gaps, complete-audit repair, exact replay,
  and reopen-time chain verification. Bounded App-JWT delivery-list acquisition
  now follows opaque cursor links, records exact page proofs in its result, and
  derives per-repository selected summaries without writing authority.
  Delivery-detail acquisition, API-sourced repair records, scheduling and
  leases, remaining observation families, and retention pruning remain
  unimplemented.
  The kernel does not yet implement target work, general fact mutation, general
  operational state, fleet coordination, or worker mutation and never reads or
  imports the spike database.

### Remaining design and delivery tracks

| Track | What remains before implementation is well specified |
| --- | --- |
| Core contract and migration | Remaining organization JSON Schemas, fixtures, and canonical-surface migrations; verification-profile and Goal import are implemented, while all remaining record kinds, Goal application, source adapters, evidence retention, and fact establishment remain |
| Control-plane domain model | Execute the [control-plane kernel bootstrap](../plans/control-plane-kernel-bootstrap.md): specify exact durable schemas, predicates, reducers, events, projections, invalidation, idempotency, and state machines in a fresh target database shared by RepositoryController, FleetController, ProcessObserver, scheduling, and decisions |
| GitHub observation | Complete the accepted webhook-plus-polling boundary on the registered v14 vocabulary and ADR-0058 operating bounds; exact-body HMAC verification, allowlisted same-repository normalization, an unmounted bounded router, durable acceptance, typed pull-request-delivery checkpoint/gap/repair persistence, and bounded App delivery-list acquisition are implemented, while production listener lifecycle, delivery-detail repair, scheduled leases, remaining records and commands, installation and actor mapping, CI/review/merge and artifact predicates, forks, and external decision signals remain |
| Workflow contracts | Versioned role briefs, evidence schemas, skills, attempt budgets, and deterministic gates for maintenance, planning, review, implementation, repair, and verification |
| Restricted security | Exact forbidden-content detectors, retention, embargo, reviewer roles, declassification profiles, and private disclosure contracts for high and critical findings |
| Scheduling and routing details | Capability and grant schemas, information-scope and restricted-compartment schemas, WIP defaults, priority mapping, fair-queue credits, cooldowns, capacity reservations, and capacity-gap UX |
| Observation and improvement details | Event and funnel taxonomy, baseline profiles, uncertainty methods, andon detectors, process-surface ownership, experiment rollout, and retention |
| Human decision plane | Decision schemas, authority matrix, batch limits, expiry behavior, notification, restricted views, CLI/API, and Frostyard-design-system OperatorInbox |
| Knowledge, criteria, and goals | Retrieval and provenance indexes, conflict and review rules, ACMM criteria adoption and migration, assessment comparability, and verified goal-progress aggregation |
| Operations and membership | Authenticated non-stdio transport, backup and recovery, SQLite production decision, deployment packaging, observability, and later named-member roles |
| Product approval | Execute the dependency-ordered [product foundation roadmap](../plans/product-foundation-roadmap.md), set numeric success targets, and resolve or deliberately defer the PRD open questions |

## Open questions

- Which core CODEOWNERS and branch-protection roles may approve enrollment,
  pause, disable, ceiling, and maintenance-program changes after named-member
  support lands?
- What exact JSON field shapes, repository-path pattern grammar, detector
  interface, and rejection fixtures implement the accepted governance
  vocabulary without executing repository-controlled code?
- Which repository migration order gets every initially opted-in repository
  onto the canonical surfaces before enrollment is activated?
- What exact per-kind v1 fields, size limits, lifecycle transition tables, and
  conformance fixtures complete the `organization/` JSON Schemas?
- Which maintainers may accept each organization record type, and what
  precedence, effective-time, supersession, and conflict rules apply?
- What is the versioned verifier interface, which policy checkpoints ship in
  v1, and which named-member roles may provide review attestations?
- What exact restricted-record retention periods, reviewer roles, embargo
  lifecycle, forbidden-content detectors, declassification profiles, and
  private-disclosure integration safely support high and critical findings?
- How does a `frostyard/core` policy change produce an impact report and a
  bounded operator reconciliation of already admitted work?
- How are goal progress observations aggregated without mistaking worker claims
  for verified measures, and what UI helps the operator decide whether to
  complete, pause, or revise a goal in `frostyard/core`?
- What is the smallest retrievable shared-knowledge unit, and which metadata
  and full-text indexes keep bounded retrieval useful without embeddings?
- Which source types count as independently verified knowledge, what default
  review intervals apply, and who resolves conflicting active records?
- Which ACMM concepts and criteria are adopted, extended, or replaced, and how
  are repository assessments migrated between immutable criteria versions?
- What criteria-set version syntax and initial level calculation preserve the
  useful parts of Hive ACMM while removing provider-specific assumptions?
- What exact capability vocabulary, profile and grant schemas, information
  classes, default lifetimes, priority aging, grant-issuance UX, and revocation
  behavior complete deterministic worker routing?
- What exact event and funnel taxonomy, observation-profile schema, default
  cohort baselines, uncertainty rules, andon scopes, process-surface ownership,
  retention policy, and operator UX implement ProcessObserver safely?
- What exact WIP defaults, deficit-round-robin credits, aging intervals,
  priority mappings, no-finding cooldown, downstream reservations, capacity-gap
  aggregation, and temporary-override UX implement bounded scheduling?
- What exact decision-type schemas, authority matrix, batch limit, deadlines,
  fail-closed expiry effects, notification channels, restricted views, and
  retention rules implement OperatorInbox and future named-member decisions?
- What exact plan and slice limits, predecessor-signal vocabulary, publication
  UX, target-owner review rules, and old-plan reconciliation transitions finish
  the approved delivery-plan contract?
- Beyond the implemented `conclusive-run-rate:v1` evaluator, which initial
  verification profiles and closed Fluent mechanism versions ship for
  delivery, which named roles satisfy attestation policies, and what evidence
  retention, expiry, and confounding rules apply to each profile?
- What exact registered record schemas, command outputs, pagination proof, and
  mechanical request/item limits implement the accepted ADR-0057 acquisition
  model and ADR-0058 operating bounds on the v14 subject and revision
  identities? Merge queues, forks, classic protection, and changing rule sets
  remain explicit post-v1 adapter work.
- What reviewer capability profile, trigger UX, fingerprint algorithm,
  material-scope lineage reset, and unavailable-CI policy implement bounded
  adversarial review consistently across PRDs, plans, and pull requests?
- What exact relationship fields, compatibility-policy vocabulary, canonical
  producer and consumer artifact surfaces, verifier interfaces, and fixtures
  implement FleetController contract assessment without copying authority into
  core?
- How do multi-repository plans represent compatibility windows, partial
  rollout, rollback, repository-specific holds, and amendments after some
  slices have merged?
- What exact read-only GitHub App permissions and installation scope support
  reconciliation, and how are named-member principals bound to permitted
  GitHub actors?
- How do fork-based pull requests fit the actor, repository, head, and duplicate
  checks, and which enrolled repositories permit that contribution route?
- Which public TLS or tunnel packaging makes the required GitHub webhook
  ingress simple to operate without exposing administrative, worker, or MCP
  surfaces, and what explicit signal records maintainer acceptance?
- Which narrowly defined proposal classes, if any, may a future approved
  deterministic policy admit without individual operator action? V1 begins
  with explicit operator admission for every worker-created proposal.
- Which optional tasks, if any, demonstrate enough measurable benefit to
  justify a local-model feature rather than deterministic code or plain UI?
- What schedules, concurrency limits, token budgets, retry ceilings, and
  dead-letter policies apply beyond the implemented operator-only requeue and
  cancellation paths for blocked work?
- What authenticated MCP transport and identity model support Incus or remote
  workers? Is a later event stream needed for the UI?
- Is Node's built-in SQLite API acceptable on the selected production runtime,
  or should the store use another binding or a host PostgreSQL service?
- Which actions can named organization members perform, and what legal/account
  boundaries apply when they use subscription-backed clients?
- Which capabilities belong first in the operator UI versus a `clix`-based CLI,
  and what package is the stable Frostyard design-system contract?
- What numeric targets define useful outcomes, wasted usage, reliability,
  traceability, and repository improvement?

## References

- Product inputs: [Hive ACMM levels](https://github.com/kubestellar/hive#acmm-levels),
  [Frostyard ACMM conformance skill](https://github.com/frostyard/core/blob/main/.agents/skills/frostyard-acmm-conformance/SKILL.md),
  and the implementation histories in `frostyard/updex` and
  `frostyard/chairlift`
- Decisions:
  [ADR-0003](../adr/0003-separate-work-coordination-from-execution.md) and
  [ADR-0004](../adr/0004-keep-models-outside-the-control-path.md), with
  proposal admission from
  [ADR-0005](../adr/0005-admit-worker-created-work-before-claiming.md) and
  database enforcement from
  [ADR-0006](../adr/0006-enforce-admission-in-the-database.md), plus the
  organization authority decision in
  [ADR-0007](../adr/0007-use-frostyard-core-as-the-organization-authority.md)
  and its five-kind record taxonomy in
  [ADR-0008](../adr/0008-use-five-organization-record-kinds.md), with goal
  application defined by
  [ADR-0009](../adr/0009-apply-goals-through-discovery-and-admission.md) and
  monotonic policy enforcement defined by
  [ADR-0010](../adr/0010-enforce-policies-monotonically-with-expiring-exceptions.md),
  with knowledge lifecycle from
  [ADR-0011](../adr/0011-treat-knowledge-as-reviewed-advisory-evidence.md)
  and readiness truth from
  [ADR-0012](../adr/0012-version-criteria-and-preserve-assessment-truth.md);
  strict core authoring is defined by
  [ADR-0013](../adr/0013-author-organization-records-as-strict-json.md) and
  atomic import by
  [ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md), with
  repository enrollment authorized by
  [ADR-0015](../adr/0015-authorize-repository-enrollment-through-core.md) and
  canonical local surfaces defined by
  [ADR-0016](../adr/0016-read-only-canonical-repository-surfaces.md), with the
  governance vocabulary and risk model in
  [ADR-0017](../adr/0017-standardize-actions-boundaries-and-risk.md), and
  worker identity and GitHub reconciliation defined by
  [ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md),
  with feature delivery retained in v1 by
  [ADR-0019](../adr/0019-include-feature-delivery-in-v1.md); the deterministic
  per-repository coordinator is named by
  [ADR-0020](../adr/0020-call-the-repository-coordinator-repositorycontroller.md),
  and its common maintenance loop is defined by
  [ADR-0021](../adr/0021-run-bounded-maintenance-assessments.md), with the
  continuous-quality role specialized by
  [ADR-0022](../adr/0022-focus-quality-on-local-correctness.md) and the
  CI-maintenance role by
  [ADR-0023](../adr/0023-base-ci-maintenance-on-observed-runs.md), with
  restricted security handling defined by
  [ADR-0024](../adr/0024-restrict-security-findings-before-disclosure.md),
  repository architecture grounded by
  [ADR-0025](../adr/0025-ground-architecture-in-accepted-direction.md), and
  cross-repository coordination defined by
  [ADR-0026](../adr/0026-coordinate-enrolled-repositories-with-fleetcontroller.md),
  with feature-planning intake authorized from core by
  [ADR-0027](../adr/0027-authorize-feature-planning-from-core-prds.md) and
  immutable delivery plans approved through
  [ADR-0028](../adr/0028-approve-immutable-delivery-plans-in-core.md), with
  bounded adversarial review defined by
  [ADR-0029](../adr/0029-bound-adversarial-review.md) and one-slice PR execution
  defined by
  [ADR-0030](../adr/0030-execute-one-slice-through-one-pull-request.md), with
  delivery separated from outcome achievement by
  [ADR-0031](../adr/0031-separate-delivery-from-outcome-achievement.md), and
  worker sessions routed by operator-issued grants in
  [ADR-0032](../adr/0032-route-work-with-operator-issued-grants.md), with
  evidence-based process improvement and scoped andons from
  [ADR-0033](../adr/0033-observe-processes-and-pull-scoped-andons.md), and
  bounded portfolio scheduling from
  [ADR-0034](../adr/0034-schedule-a-bounded-ready-inventory.md), with typed human
  authority routed through
  [ADR-0035](../adr/0035-route-human-authority-through-typed-decisions.md), with
  the shared target vocabulary maintained by
  [ADR-0036](../adr/0036-maintain-a-canonical-domain-language.md), with the
  shared fact-oriented store and separate event ledger established by
  [ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md), with
  lifecycle pause separated from runtime interventions by
  [ADR-0038](../adr/0038-separate-lifecycle-pause-from-runtime-interventions.md),
  with typed source-native identity and revision binding defined by
  [ADR-0039](../adr/0039-use-typed-source-native-subject-identities.md), with
  authoritative fact semantics owned by
  [ADR-0040](../adr/0040-establish-facts-through-registered-predicate-contracts.md),
  with information classification and scoped access defined by
  [ADR-0041](../adr/0041-enforce-three-information-classes-and-scoped-access.md),
  with rebuildable read models bounded by
  [ADR-0042](../adr/0042-use-rebuildable-projections-only-as-read-models.md),
  with time and record ordering defined by
  [ADR-0043](../adr/0043-order-records-by-transaction-sequence-not-timestamps.md),
  with clean replacement of the queue-spike database defined by
  [ADR-0044](../adr/0044-replace-the-queue-spike-database.md), with canonical
  source ownership established by
  [ADR-0045](../adr/0045-host-fluent-under-frostyard.md), with Core source
  freshness separated from admission readiness by
  [ADR-0046](../adr/0046-separate-core-source-freshness-from-admission-readiness.md),
  with stale-source overrides capped by
  [ADR-0047](../adr/0047-cap-stale-source-overrides-at-24-hours.md), and the
  check-detail retention boundary in
  [ADR-0048](../adr/0048-retain-core-check-detail-for-30-days.md), with leased
  polling defined by
  [ADR-0049](../adr/0049-poll-core-through-one-leased-controller.md), with
  repository reconciliation split across exact authority facts by
  [ADR-0050](../adr/0050-reconcile-repository-enrollment-as-separate-facts.md),
  with exact-commit surface selection and enrollment separation in
  [ADR-0051](../adr/0051-pin-surfaces-to-the-observed-default-branch-head.md),
  with explicit local operator holds in
  [ADR-0052](../adr/0052-bind-local-repository-holds-to-explicit-operator-decisions.md),
  with unchanged transient recovery in
  [ADR-0053](../adr/0053-resume-only-unchanged-transient-held-work.md), with
  executable success-measure contracts in
  [ADR-0054](../adr/0054-bind-success-measures-to-versioned-verification-profiles.md),
  with evidence populations separated from rate evaluation in
  [ADR-0055](../adr/0055-separate-evidence-population-from-rate-evaluation.md),
  with required checks derived only from enforced GitHub rules in
  [ADR-0056](../adr/0056-derive-required-checks-from-enforced-github-rules.md),
  with authenticated webhook ingress and polling reconciliation required by
  [ADR-0057](../adr/0057-require-webhook-ingress-for-github-observation.md),
  and the
  [Fluent ubiquitous language](../domain/ubiquitous-language.md)
- Designs: [queue execution boundary](../design/queue-execution-boundary.md),
  [control-plane kernel](../design/control-plane-kernel.md), and
  [core snapshot ingestion](../design/core-snapshot-ingestion.md), plus
  [repository enrollment](../design/repository-enrollment.md) and
  [success-measure verification](../design/success-measure-verification.md),
  plus
  [GitHub observation and reconciliation](../design/github-observation.md),
  with the operator-facing
  [required-check ruleset runbook](../design/required-check-ruleset-operations.md)
- Contracts: [work queue](../specs/work-queue.md),
  [control-plane kernel](../specs/control-plane-kernel.md), and
  [core snapshot verification](../specs/core-snapshot-verification.md), plus
  [Core snapshot activation](../specs/core-snapshot-activation.md) and
  [Core source readiness](../specs/core-source-readiness.md), plus
  [Core check-detail retention](../specs/core-check-detail-retention.md) and
  [Core source polling](../specs/core-source-polling.md), plus
  [repository authority reconciliation](../specs/repository-authority-reconciliation.md)
  and [repository surface reconciliation](../specs/repository-surface-reconciliation.md),
  and [local repository holds](../specs/repository-local-holds.md), and
  [held-work recovery](../specs/repository-held-work-recovery.md), and
  [verification-profile ingestion](../specs/verification-profile-ingestion.md),
  [Goal ingestion](../specs/goal-ingestion.md), and the
  [conclusive-run-rate evaluator](../specs/conclusive-run-rate-evaluator.md)
- Delivery: [queue vertical spike](../plans/queue-vertical-spike.md),
  [control-plane kernel bootstrap](../plans/control-plane-kernel-bootstrap.md),
  [core snapshot ingestion](../plans/core-snapshot-ingestion.md), and
  [product foundation roadmap](../plans/product-foundation-roadmap.md)
