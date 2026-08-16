# 0038 — Separate lifecycle pause from runtime interventions

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

Fluent currently uses `pause` for two different authority acts. Canonical core
declarations give repositories and initiatives a `paused` lifecycle state that
changes only through a reviewed core revision. ADR-0034 also permits an
operator to create a temporary runtime pause in Fluent operational state.
ADR-0015 separately calls the immediate local repository stop a `suspension`,
ADR-0035 lists pause as a Fluent-runtime decision, while ProcessObserver creates
`scoped-hold` and `safety-stop` interventions.

Those words cannot remain interchangeable. A controller must know which
authority owns the condition, whether a core PR is required to clear it,
whether in-flight attempts may finish, whether downstream advancement is
allowed, and whether the condition expires. If a generic `pause` command can
mean either lifecycle change or runtime override, Fluent could present local
state as if it changed core, resume work when only one of several independent
conditions cleared, or terminate useful reporting when the operator merely
wanted to stop new claims.

## Decision

Fluent reserves **pause** for a lifecycle state authored by a canonical core
record whose accepted schema defines `paused`. Activating the exact core
snapshot establishes that lifecycle fact; resumption requires activation of a
later authorized core revision. Fluent UI and APIs may request or link to the
canonical change path, but a local mutation cannot create, clear, or impersonate
that state.

A paused subject retains its identity, history, definitions, facts, evidence,
and existing artifacts. Its governing contract defines which new discovery,
planning, admission, claims, renewals, or advancement are prohibited. A pause
does not silently cancel related subjects or erase an independent hold, drain,
or denial.

Fluent uses **hold** for a runtime condition that makes a bounded subject or
scope ineligible or prevents named advancement gates until explicit recovery.
A hold records its source, exact scope, reason, start, affected gates, recovery
rule, and any expiry or review deadline. GitHub identity mismatch, missing
repository policy, an operator emergency intervention, and a ProcessObserver
andon may create different typed holds. Clearing one hold cannot clear another
hold or a core pause. ADR-0015's immediate local repository `suspension` is
represented in the target model and product surfaces as an operator-imposed
repository hold.

Fluent uses **drain** for an attributed, expiring runtime scheduling
intervention that prevents new claims in a bounded scope while allowing
already-leased attempts to reach their normally permitted reporting boundary.
A drain does not make work ineligible, cancel leases, block report ingestion,
quarantine artifacts, or prevent downstream advancement by itself. Those
stronger effects require the applicable pause, hold, safety stop, grant
revocation, or policy decision.

Pins and capacity reductions remain separate runtime scheduling interventions.
They alter ordering or available concurrency without acquiring the meaning of
pause, hold, or drain.

Authority evaluation treats pause, every applicable hold, and drain as
independent typed inputs. The most restrictive applicable effect controls the
attempted transition, and removing one input never implies that the others were
removed. Operator surfaces show each condition's canonical owner, source
revision or runtime actor, scope, effect, recovery path, and expiry separately.

New runtime schemas, commands, UI actions, and events MUST NOT use `pause` for
an operational override. Historical queue and scheduling records retain their
original vocabulary and provenance; migration may classify an unambiguous
legacy runtime pause as a hold or drain, but ambiguous records remain legacy
events and do not manufacture a lifecycle fact.

This decision narrows the runtime-pause language in ADR-0034 and ADR-0035
without changing their accepted scheduling or typed-decision models. It also
standardizes the target vocabulary for ADR-0015's local suspension; the
Accepted ADRs remain unchanged as historical decision records.

## Consequences

- An operator can tell whether resumption belongs in core or in Fluent.
- Core lifecycle authority cannot be counterfeited by a convenient local
  control-plane toggle.
- Holds can stop unsafe advancement while drains support graceful maintenance
  of externally managed workers.
- Multiple independent restrictions remain visible and cannot be cleared by
  one overly broad resume action.
- UI, API, event, and storage contracts need typed condition sources and
  effects rather than a generic paused boolean.
- Existing PRD wording and future scheduling specs must replace temporary
  runtime pause with hold, drain, pin, or capacity reduction as applicable.
- Legacy runtime-pause records may remain semantically weaker than target
  records when their intended effect cannot be proven.

## Alternatives considered

- **Use pause for both lifecycle and runtime state:** rejected because the same
  verb would have different owners, persistence, recovery paths, and effects.
- **Store a local shadow of core pause:** rejected because two writable
  authorities could disagree about the same lifecycle state.
- **Use hold for every kind of stop:** rejected because a graceful drain must
  allow in-flight reporting, while lifecycle pause and safety holds have
  broader authority consequences.
- **Use suspension as a fourth canonical intervention:** rejected because its
  intended local emergency behavior is already the bounded behavior of a typed
  operator hold.
- **Make drain cancel or revoke active leases:** rejected because that is a
  safety-stop or revocation behavior, not graceful draining.
- **Rewrite every historical runtime pause during migration:** rejected because
  old records may not contain enough evidence to distinguish hold from drain.

## References

- Refines lifecycle and local intervention vocabulary from
  [ADR-0015](0015-authorize-repository-enrollment-through-core.md), process
  holds from [ADR-0033](0033-observe-processes-and-pull-scoped-andons.md), and
  runtime scheduling interventions from
  [ADR-0034](0034-schedule-a-bounded-ready-inventory.md) and
  [ADR-0035](0035-route-human-authority-through-typed-decisions.md)
- Uses independent facts, operational state, events, and migration rules from
  [ADR-0037](0037-store-facts-with-a-separate-event-ledger.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [repository enrollment](../prd/agent-fleet.md#repository-enrollment) and
  [portfolio scheduling and backpressure](../prd/agent-fleet.md#portfolio-scheduling-and-backpressure)
- Language: [Fluent ubiquitous language](../domain/ubiquitous-language.md)
- Delivery: [product foundation roadmap](../plans/product-foundation-roadmap.md)
