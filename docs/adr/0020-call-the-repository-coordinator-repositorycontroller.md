# 0020 — Call the repository coordinator RepositoryController

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

Earlier product discussion used “repository agent,” “repository workstream,”
and “repository steward” for the durable coordinator associated with each
enrolled repository. Those names communicate continuity and responsibility,
but “agent” and “steward” also suggest that a model process is continuously
thinking, remembering, or acting for the repository.

That implication conflicts with Fluent's established boundary. Models remain
outside the deterministic control path, capable clients are started by the
operator, and every worker attempt is bounded and disposable. The repository's
identity, state, policy, and history must survive without any model endpoint or
running worker.

## Decision

`RepositoryController` is the canonical product and architecture term for the
durable coordinator associated with an enrolled repository. Current product,
design, contract, plan, UI, CLI, API, and code terminology MUST use that name
when referring to this concept. The class-style capitalization makes the
software boundary explicit; an implementation is not required to use one class
or one process.

Each enrolled repository has exactly one logical RepositoryController. It is
deterministic code plus durable state. Its responsibilities include:

- retaining repository identity, enrollment, effective policy, exact context
  snapshots, observations, assessments, work lineage, and outcomes;
- determining which configured evaluations or reconciliations are due;
- compiling bounded work context from authoritative records and repository
  surfaces;
- enforcing holds, action ceilings, dependencies, admission, leases, and other
  deterministic gates;
- coordinating maintenance and feature-delivery program state; and
- reconciling reported artifacts and projecting factual repository health.

A RepositoryController is not an LLM, prompt, conversation, provider session,
worker process, or free-form memory. It MUST remain operational when Lemonade
and every capable-agent provider are unavailable. Generated summaries may be
used as disposable presentation, but they do not become controller memory or
authority.

When analysis or implementation requires engineering judgment, the
RepositoryController exposes a bounded queue item. An operator-started capable
worker claims one attempt under a specialist or delivery role and reports its
result. The worker acts for that attempt; it does not become, impersonate, or
own the RepositoryController. A later attempt may use another provider without
changing repository continuity.

Previously accepted ADRs remain immutable. Where they use “repository agent,”
“repository workstream,” or “repository steward” for this same durable
coordinator, this ADR supplies the canonical current term without reversing
their underlying decisions.

## Consequences

- Product language no longer implies one continuously running model per
  repository.
- The continuity users expect from a dedicated repository coordinator comes
  from durable state and responsibility rather than chat history.
- Workers and providers become replaceable executors without losing repository
  identity or progress.
- Implementation may distribute controller behavior across database records,
  schedulers, reconcilers, and services, but those pieces must present one
  logical RepositoryController.
- “RepositoryController” is intentionally less anthropomorphic; user-facing
  explanations must communicate its responsibilities rather than relying on an
  agent persona.
- Existing accepted ADR text will retain older terminology, so readers need
  this decision when interpreting those references.

## Alternatives considered

- **Repository agent:** rejected because it strongly implies an LLM or
  continuously running agent process.
- **Repository steward:** rejected because it still suggests an autonomous
  reasoning role and leaves the code/model boundary unclear.
- **Repository workstream:** rejected as the primary name because it describes
  the retained work but not the coordinating software boundary.
- **Repository service:** rejected because it is too broad and does not convey
  deterministic coordination and state progression.
- **Keep separate internal and user-facing names:** rejected because the
  translation would preserve ambiguity in requirements and operational
  discussion.

## References

- Builds on the model-free control path in
  [ADR-0004](0004-keep-models-outside-the-control-path.md), durable queue
  boundary in
  [ADR-0003](0003-separate-work-coordination-from-execution.md), and repository
  enrollment lifecycle in
  [ADR-0015](0015-authorize-repository-enrollment-through-core.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [enrollment and RepositoryControllers](../prd/agent-fleet.md#enrollment-and-repositorycontrollers)
- Shapes: [queue execution boundary](../design/queue-execution-boundary.md)
- Implementation contract and delivery plan: not yet authored
