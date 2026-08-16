# 0021 — Run bounded maintenance assessments

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

[ADR-0020](0020-call-the-repository-coordinator-repositorycontroller.md)
defines one deterministic RepositoryController per enrolled repository, while
capable external workers provide bounded engineering judgment. The initial
maintenance programs—continuous quality improvement, CI, security, and
architecture—need a common control loop before their specialist
responsibilities can be defined consistently.

Hive's role policies provide clear responsibilities and progressively broader
outputs, but their recurring prompts commonly ask an agent to audit a broad
area, record every finding, and sometimes open an issue for every confirmed
problem. Repeating that pattern across repositories risks duplicate findings,
unbounded output, issue floods, and token use that is unrelated to the most
valuable next outcome.

Requiring operator approval before every recurring read-only assessment would
prevent useful continuous operation. Letting an assessment worker admit its
own implementation follow-ups would instead recreate an authorization feedback
loop.

## Decision

Every enabled maintenance program has one logical program instance within its
repository's RepositoryController. Quality, CI, security, and architecture use
the same deterministic control loop; their later role contracts specialize
scope, inputs, evidence, and permitted outputs.

Enabling a maintenance program through the repository's accepted core
declaration authorizes the RepositoryController to create and admit recurring
bounded read-only assessment roots according to accepted program configuration.
Enrollment itself still creates no work. The controller creates an assessment
only when its deterministic due rule is satisfied and no equivalent active root
lineage exists.

Before creating an assessment, the RepositoryController:

- reconciles enrollment, holds, effective policy, and relevant reported
  artifacts;
- selects exact core and repository snapshots;
- identifies the bounded subject, time or commit window, and requested maximum
  output;
- includes applicable goals, knowledge, criteria, prior findings, work,
  artifacts, and acceptance history; and
- records the program-contract version and deterministic trigger.

An assessment MUST ask a focused question rather than instruct a worker to
audit everything. It defines what evidence is required, what constitutes no
meaningful finding, and a hard limit on returned findings or proposed actions.
A valid no-finding result is a useful outcome and updates the program's
assessment history without manufacturing work.

The capable worker owns semantic analysis. It may inspect the supplied subject,
exercise engineering judgment, return concrete evidence, and propose a bounded
resolution. Its findings, classifications, summaries, and proposed work remain
untrusted claims. The worker does not mutate RepositoryController state
directly, choose scheduling priority, clear holds, approve follow-ups, or expand
the assessment scope.

The RepositoryController records each report and deduplicates it against known
findings, queue lineages, issues, pull requests, and accepted outcomes. A
worker-created implementation or GitHub-mutation follow-up enters `proposed`
and requires the admission path from
[ADR-0005](0005-admit-worker-created-work-before-claiming.md). A worker may
open an issue or pull request only when the claimed item explicitly authorizes
that action; assessment authority does not carry into its follow-up.

For admitted work, the controller coordinates the lease and lineage,
independently reconciles reported artifacts, and schedules later re-evaluation
when the specialist contract requires it. A finding is not resolved merely
because a worker reports completion or a pull request exists. Resolution must
come from the defined verification or re-evaluation signal.

Repository state remains factored rather than collapsed into one authoritative
health label. At minimum, Fluent exposes separately:

- operational state such as enabled, paused, disabled, or held;
- context validity and freshness;
- per-program due, active, awaiting-admission, and blocked conditions;
- finding lifecycle and verification state;
- artifact reconciliation state; and
- readiness against an exact criteria-set version.

A UI may calculate a concise health presentation from those facts but MUST NOT
replace or conceal them with a model-generated judgment.

## Consequences

- All maintenance specialists share one inspectable control loop while keeping
  their engineering responsibilities distinct.
- Program enablement supports continuous read-only discovery without repetitive
  operator approval.
- Implementation remains human-gated in the initial operation even when its
  parent assessment was admitted automatically.
- Focused questions, output caps, and active-lineage deduplication bound token
  consumption and maintainer noise.
- “No meaningful finding” becomes a successful result rather than pressure to
  invent work.
- Deduplication can prevent obvious repetition but cannot determine semantic
  equivalence perfectly; ambiguous cases must remain visible.
- Factual state dimensions make holds and stale evidence diagnosable, though
  the UI must do more work to present them clearly.
- Exact cadence rules, work-in-progress limits, finding schema, deduplication
  keys, and specialist evidence contracts remain to be defined.

## Alternatives considered

- **Require approval for every assessment:** rejected because it turns enabled
  continuous maintenance into a manual task generator.
- **Let the worker admit its follow-ups:** rejected because the same model would
  discover, authorize, and recursively consume its own work.
- **Audit the whole repository every cycle:** rejected because it is expensive,
  difficult to compare over time, and likely to repeat known findings.
- **Create an issue for every finding:** rejected because a reported finding is
  not necessarily verified, valuable, unique, or worth maintainer attention.
- **Permit unlimited findings:** rejected because output volume becomes a proxy
  for activity rather than outcome quality.
- **Treat a reported PR as resolution:** rejected because artifact existence
  does not establish correctness, merge, acceptance, or removal of the original
  condition.
- **Store one controller health state:** rejected because enrollment, context,
  program, finding, artifact, and readiness failures have different remedies.

## References

- Builds on coordination and proposal admission from
  [ADR-0003](0003-separate-work-coordination-from-execution.md) and
  [ADR-0005](0005-admit-worker-created-work-before-claiming.md), repository
  enrollment from
  [ADR-0015](0015-authorize-repository-enrollment-through-core.md), artifact
  reconciliation from
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md), and the
  RepositoryController boundary in
  [ADR-0020](0020-call-the-repository-coordinator-repositorycontroller.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [common maintenance workflow](../prd/agent-fleet.md#common-maintenance-workflow)
- External input: [Hive policy overview](https://github.com/kubestellar/hive/blob/v4/v2/policies/README.md)
- Implementation design, contract, and delivery plan: not yet authored
