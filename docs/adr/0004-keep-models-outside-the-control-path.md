# 0004 — Keep models outside the control path

- **Status:** Accepted
- **Date:** 2026-08-14

## Context

The first host-local trial completed a read-only testing-gap discovery and its
implementation child through two manually started Claude sessions. Fluent
handled enrollment, claims, leases, delegation, lineage, and completion with
deterministic code. Lemonade was not needed for either durable outcome.

The Lemonade integration proved that the local 27B model can answer a narrowly
prompted restatement, but three live probes varied: one exhausted its response
budget on reasoning, one added material beyond the requested sentence, and one
returned the requested concise answer. This is insufficient evidence for any
authoritative coordination role.

The same trial showed why model reports cannot establish truth. The
implementation worker reported that `git diff --exit-code` proved a temporarily
modified source file was restored byte-identically, but the source tree was
untracked, so Git could not provide that evidence.

## Decision

Fluent's control path is deterministic. Repository enrollment, work creation,
claim selection, lease enforcement, action authorization, delegation ceilings,
state transitions, artifact scope checks, and provenance recording are code and
data contracts, not model decisions.

Model output is always an untrusted proposal or claim. A model may draft text,
classify for presentation, summarize, or propose work, but its output must pass
the same deterministic validation as any other input and cannot authorize a
mutation. Operator approval or an explicitly approved deterministic policy is
required wherever accepting a proposal would establish organization intent.

The core queue must remain fully useful when no model endpoint is configured.
Flue and Lemonade are optional assistance surfaces until repeatable evaluations
show that a specific bounded task benefits from them. The successful provider
smoke test is not evidence that the model is sufficient for general
orchestration.

## Consequences

- The useful v1 product is smaller: a durable queue, policy engine, portable MCP
  contract, and provenance ledger.
- Queue availability and authorization do not depend on model latency, context,
  output format, or hallucination rate.
- Lemonade can be evaluated incrementally without blocking the maintenance
  loop or receiving standing authority.
- Broad goals cannot silently become executable work through a model. A
  deterministic policy or operator acceptance boundary must be visible.
- Worker summaries, evidence, and artifact URLs remain claims. Fluent can
  validate their shape and scope, but must represent external reconciliation
  separately from worker reporting.
- Optional model features need task-specific evaluations. A single generic
  "model quality" claim is not meaningful.

## Alternatives considered

- **Use Lemonade as the queue planner:** rejected because the live probes do
  not establish reliable constraint preservation, and queue planning changes
  durable intent.
- **Use model output with deterministic schema parsing:** rejected as a trust
  boundary by itself. Valid JSON can still contain widened authority or false
  claims.
- **Remove Flue and Lemonade immediately:** rejected because optional,
  non-authoritative assistance may still prove useful and has near-zero local
  inference cost.
- **Treat capable-worker evidence as verified:** rejected by the live trial;
  plausible evidence can rely on an invalid observation mechanism.

## References

- Shapes: [queue execution boundary](../design/queue-execution-boundary.md),
  [work queue contract](../specs/work-queue.md), and
  [queue vertical spike](../plans/queue-vertical-spike.md)
- Product: [GitHub organization maintenance fleet](../prd/agent-fleet.md)
- Builds on:
  [ADR-0003](0003-separate-work-coordination-from-execution.md)
