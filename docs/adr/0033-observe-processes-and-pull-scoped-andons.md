# 0033 — Observe processes and pull scoped andons

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

Fluent coordinates versioned phases, contracts, validation profiles, worker
roles, skills, and workflows across repositories and initiatives. Each
individual transition may be correct while the overall process performs badly:
review may rarely converge, implementation may repeatedly miss acceptance,
verification may be unable to collect evidence, or a contract change may make
an entire work cohort fail.

A dashboard alone leaves the operator to discover those failures manually. A
self-modifying agent would be worse: it could draw conclusions from a few
attempts, confuse correlation with cause, optimize a visible metric at the
expense of outcomes, or weaken the criteria used to judge itself. Useful
process judgment needs comparable evidence, a minimum operating baseline,
version-aware cohorts, bounded intervention, and an approved change path.

Fluent also cannot stop an externally managed coding-agent process. Its andon
cord can stop control-plane authorization and advancement, preserve evidence,
and quarantine later reports, but process termination remains outside the
coordination boundary from
[ADR-0003](0003-separate-work-coordination-from-execution.md).

## Decision

Each Fluent deployment has one logical `ProcessObserver`. It is deterministic
code plus durable state, not a model, prompt, worker, or free-form memory. It
observes RepositoryController, FleetController, queue, review, verification,
and routing events without owning those controllers' source facts.

The ProcessObserver consumes an append-only operational event history. Each
relevant event retains subject and correlation identities, timestamps, stage
and transition, repository and initiative scope, risk and role, attempt and
worker-grant metadata, outcome classification, and exact versions or digests of
the applicable core snapshot, contract, workflow, skill, criteria, validation,
plan, and policy. Sensitive fields follow their existing access and redaction
rules; observation MUST NOT justify collecting secrets, provider credentials,
unredacted restricted findings, or full worker transcripts.

The observer derives explicit stage funnels rather than one completion rate,
including where applicable:

```text
admitted
  -> eligible
  -> claimed
  -> useful completion
  -> artifact verified
  -> review passed
  -> merged
  -> outcome verified
```

Metrics retain their numerator, denominator, exclusions, censored or still-open
attempts, unavailable evidence, and source-event identities. Reported provider
usage may be displayed only with its verification state; absent or
worker-reported token counts MUST NOT be treated as trusted cost facts.

Process judgments use versioned, approved `observation profiles`. A profile
declares:

- the comparable cohort, including relevant workflow and contract versions,
  role, risk, repository class, and capability profile;
- exact metric, numerator, denominator, exclusions, and evidence quality;
- minimum completed sample, minimum observation duration, baseline window, and
  treatment of incomplete or unavailable cases;
- expected range, warning threshold, and andon threshold with an appropriate
  uncertainty rule;
- affected scope, response level, review deadline, and recovery condition; and
- guardrail measures that detect displaced failures or metric gaming.

Before minimum sample, duration, and evidence-quality requirements are met, a
performance result is `insufficient-data`. It is not healthy, degraded, or
evidence for a process change. Cohorts with materially different governing
versions or profiles MUST NOT be pooled merely to reach a sample threshold.

Baseline requirements apply to performance judgments. They do not delay an
exact deterministic safety or integrity invariant such as unauthorized action,
cross-repository artifact mismatch, restricted-data disclosure, invalid schema,
or execution under a revoked grant. Those conditions use their own versioned
detectors and may stop on the first verified occurrence.

The ProcessObserver emits three response levels:

- `notice` records a mature deviation for operator attention without stopping
  work;
- `scoped-hold` stops new admission, eligibility, claims, or advancement at the
  profile's exact affected boundary while allowing already leased work to reach
  a safe reporting boundary; its outputs remain quarantined from further
  advancement until reconciliation; and
- `safety-stop` immediately denies the affected mutations and renewals for a
  verified safety or integrity invariant, treating later worker reports and
  artifacts as stale provenance.

Every andon uses the smallest scope supported by its evidence: a stage,
workflow version, contract version, role, risk tier, repository cohort,
repository, initiative, or exact combination. A review-convergence failure in
one cohort MUST NOT halt unrelated maintenance or repositories. Expanding a
hold requires new evidence or an attributed authorized decision.

An andon record binds its detector and observation-profile versions, condition,
scope, exact evidence snapshot, response level, source event, creation time,
actor, review deadline, clear condition, and every later disposition. A hold
does not disappear because a process restarts or a newer event looks better.
Only its declared deterministic recovery rule or an authorized human
disposition may clear, narrow, replace, or waive it; deterministic policy denial
and safety invariants cannot be waived through this process.

When a mature performance signal or andon warrants investigation, Fluent may
create one bounded read-only `process-improvement-analyst` proposal for the
exact signal fingerprint and scope. After ordinary admission, the capable
worker receives the baseline, cohort definition, funnel and failure
distribution, governing versions, representative evidence, prior changes, and
guardrails. It does not receive authority to edit, publish, approve, or activate
a process change.

The analyst distinguishes observation from causation. A low review-pass rate
establishes a process symptom, not whether review criteria, implementation
criteria, planning, routing, or capability assignment caused it. Its result may
state up to three ranked hypotheses and recommends the smallest discriminating
change or experiment. Unsupported causal certainty is a failed analysis, not a
reason to broaden the proposal.

A process-improvement proposal identifies exact evidence and baseline, affected
canonical sources and versions, causal hypothesis, smallest proposed change,
expected mechanism, success and guardrail measures, rollout cohort and
evaluation window, rollback conditions, risks, and unresolved uncertainty. It
begins as non-claimable proposed work and cannot clear the andon that motivated
it.

Accepted changes follow their canonical governance path: adversarial review,
operator or authorized-owner approval, a pull request against the one canonical
source, and a new immutable contract, profile, workflow, skill, criteria, or
agent-role version. Changed behavior rolls out to an explicit bounded cohort
and is compared with the preserved baseline before broader adoption. An
observer finding never edits a loaded definition in place.

The ProcessObserver cannot author or approve its own observation profile,
detector, threshold, guardrail, or recovery rule. The analyst cannot review or
approve its own change. Observation-profile changes preserve prior calculations
and trigger a new comparison lineage rather than retroactively recomputing an
old result as if the new rule had always applied.

One active andon and one active improvement lineage are allowed per signal
fingerprint, subject version, and scope. Repeated events update the evidence of
that lineage rather than producing duplicate holds, issues, or proposals. A
closed no-change investigation enters a declared cooldown and requires material
new evidence or a governing-version change before another proposal.

Observer health is itself deterministic operational state: event-ingestion
lag, missing expected stages, invalid version metadata, calculation failure,
and stale profiles are visible. Missing observer evidence produces
`unavailable` or `insufficient-data`; it MUST NOT be interpreted as process
health. This is a self-health check, not an infinite hierarchy of observers.

## Consequences

- Fluent can stop a failing workflow before it consumes an unbounded number of
  capable-agent attempts.
- Version-aware cohorts prevent results from unrelated process revisions from
  being averaged into a misleading rate.
- Minimum samples and durations reduce premature conclusions, while exact
  safety invariants still stop immediately.
- Scoped holds preserve unrelated fleet progress and ordinary in-flight work;
  safety stops intentionally sacrifice stale attempts when authority or data
  integrity is at risk.
- Separating deterministic observation from capable analysis preserves the
  model-free control path while still supporting nuanced hypotheses.
- Immutable baselines and bounded rollouts make process changes evaluable and
  reversible.
- The observer can propose improvements but cannot create a self-approving,
  self-rewriting control loop.
- Detailed version and funnel telemetry increases storage, schema, retention,
  and privacy obligations.
- Exact funnel taxonomy, event schema, default profiles, uncertainty methods,
  canonical owner for each process surface, and operator UX remain open.

## Alternatives considered

- **Use dashboards and rely on manual discovery:** rejected because systemic
  failure can continue consuming workers until an operator notices.
- **Let a process agent watch transcripts and rewrite skills:** rejected because
  it lacks deterministic authority, comparable evidence, and separation of
  duties.
- **Judge after a fixed number of any attempts:** rejected because incompatible
  versions, roles, and risks do not form a meaningful baseline.
- **Require baseline evidence before every stop:** rejected because a verified
  safety invariant should not wait for repetition.
- **Stop the whole fleet when one threshold fails:** rejected because unrelated
  work should continue and broad stops create their own availability risk.
- **Treat a low success rate as proof of a specific cause:** rejected because
  process data identifies a symptom before it establishes causality.
- **Apply improvements immediately:** rejected because unreviewed changes could
  weaken gates, game metrics, or displace failures to another phase.
- **Recalculate history under every new profile:** rejected because it would
  erase the measurement rule that motivated the original decision.

## References

- Builds on the coordination boundary and deterministic authority in
  [ADR-0003](0003-separate-work-coordination-from-execution.md) and
  [ADR-0004](0004-keep-models-outside-the-control-path.md)
- Observes repository and fleet coordination from
  [ADR-0020](0020-call-the-repository-coordinator-repositorycontroller.md) and
  [ADR-0026](0026-coordinate-enrolled-repositories-with-fleetcontroller.md)
- Observes review, execution, verification, and routing defined by
  [ADR-0029](0029-bound-adversarial-review.md),
  [ADR-0030](0030-execute-one-slice-through-one-pull-request.md),
  [ADR-0031](0031-separate-delivery-from-outcome-achievement.md), and
  [ADR-0032](0032-route-work-with-operator-issued-grants.md)
- Uses canonical-source and versioning rules from
  [ADR-0012](0012-version-criteria-and-preserve-assessment-truth.md),
  [ADR-0013](0013-author-organization-records-as-strict-json.md), and
  [ADR-0016](0016-read-only-canonical-repository-surfaces.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [process observation and improvement](../prd/agent-fleet.md#process-observation-and-improvement)
- Implementation design, contract, and delivery plan: not yet authored
