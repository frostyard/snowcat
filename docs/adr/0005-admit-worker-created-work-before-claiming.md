# 0005 — Admit worker-created work before claiming

- **Status:** Accepted
- **Date:** 2026-08-14

## Context

The host-local trial relied on the operator reading a completed discovery and
manually starting a second worker. The discovery's child was already in the
claimable queue, so that review was convention rather than an enforced or
recorded approval.

Dogfooding with a worker loop removes the pause that made the convention appear
safe. A worker could complete an item, create claimable children, consume those
children, and recursively generate more work. Per-invocation limits do not
bound that loop, and deterministic schema validation does not establish that a
model-proposed objective is desirable organization work.

## Decision

Worker-created follow-ups enter a non-claimable `proposed` state. Only an
operator or a separately approved deterministic admission policy may move a
proposal to `queued`. Initial host-local operation provides explicit operator
`approve` and `reject` commands and records either decision as an event.

Operator-authored and deterministic-policy seed work may enter `queued`
directly with their origin recorded. Starting a worker is not itself an
approval event. Claim selection considers admitted `queued` work only.

One completion may propose at most ten children, and work decomposition may be
at most four parent-child edges below its root. These are hard safety bounds,
not throughput targets. Changing them is a contract change.

## Consequences

- A continuously available worker drains only an explicitly admitted finite
  queue and cannot recursively feed itself.
- The operator can review objective, evidence, actions, and delegation before
  spending another capable-agent run.
- Proposal rejection is durable and auditable rather than deletion.
- Dogfood feeding can safely create bounded read-only roots while
  implementation children accumulate for review.
- Admission adds friction. Later deterministic policies may admit narrow work
  classes, but they need explicit identity, criteria, and audit events.
- `proposed` is a logical queue state. The initial SQLite migration preserves
  existing work as admitted and adds an admission flag so the existing status
  table does not need destructive rebuilding.

## Alternatives considered

- **Treat launching another worker as approval:** rejected because it is
  implicit, selects by queue ordering rather than reviewed item identity, and
  leaves no approval event.
- **Let each parent choose automatic child admission:** deferred. It may become
  an approved deterministic policy, but adding it before dogfood evidence would
  recreate the unsafe default under another field.
- **Allow worker loops to consume their own children with depth limits only:**
  rejected because a bounded amount of unwanted work is still unwanted and
  can include issue or pull-request authority.
- **Delete rejected proposals:** rejected because provenance and learning from
  poor decomposition are product data.

## References

- Shapes: [queue execution boundary](../design/queue-execution-boundary.md),
  [work queue contract](../specs/work-queue.md), and
  [queue vertical spike](../plans/queue-vertical-spike.md)
- Product: [GitHub organization maintenance fleet](../prd/agent-fleet.md)
- Builds on: [ADR-0004](0004-keep-models-outside-the-control-path.md)
