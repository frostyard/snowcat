# 0003 — Separate work coordination from execution

- **Status:** Accepted
- **Date:** 2026-08-14

## Context

The operator already has working Codex, Claude, and Copilot subscriptions and
local models, but their authentication, token refresh, tools, and runtime
assumptions differ. A control plane that owns those processes also inherits
their credential lifecycle, sandboxing, failure recovery, and vendor-specific
behavior. The local Lemonade model is inexpensive and available, but it is not
reliable enough to make architectural decisions or perform substantial code
changes.

The fleet still needs durable work, repository opt-in, bounded authority,
retryable claims, outcome evidence, and parent-child lineage regardless of
which capable agent performs an item.

## Decision

Fluent coordinates work and does not execute native coding agents. It exposes a
durable queue through MCP. An operator starts the capable agent of their choice
and asks it to claim and complete one item. The client owns its process,
credentials, tools, model selection, and sandbox.

Flue agents use the local Lemonade model only for bounded instruction,
classification, and bookkeeping. Authoritative work enters the queue through
operator action, deterministic policy, or a finding reported by a capable
worker. A worker may create child work only within the parent item's explicit
delegation ceiling.

Fluent continues to enforce repository opt-in and action authorization and to
record leases, lineage, artifacts, and evidence. Client-reported evidence is
untrusted input, not proof that an action was safe or successful.

## Consequences

- Subscription credentials and short-lived token refresh stay out of Fluent.
- The worker skill and MCP contract become the portable integration surface.
- Fluent does not solve worker isolation; operators must run clients in an
  environment appropriate to their risk. This removes an implementation
  responsibility, not the underlying security concern.
- One invocation claims at most one item by default, bounding accidental token
  use and making outcomes observable.
- Queue leases permit recovery when manually started clients disappear.
- Remote workers will require an authenticated network transport; the spike's
  stdio transport is only a local proof of the contract.
- Fluent cannot directly attest to a worker's repository changes or GitHub
  artifacts. Independent verification remains future work.

## Alternatives considered

- **Fluent launches and supervises native clients:** rejected for v1 because it
  couples the control plane to credentials, token refresh, sandboxes, and
  rapidly changing vendor CLIs.
- **Lemonade performs repository maintenance itself:** rejected because the
  available local model is suited to shallow coordination, not authoritative
  architecture or large code changes.
- **WebSocket-only worker protocol:** deferred because manual pull workers do
  not need server push. An event stream can be added for user interfaces later.
- **Give every worker broad standing authority:** rejected because queue items
  need independently auditable, least-authority action limits.

## References

- Shapes: [queue execution boundary](../design/queue-execution-boundary.md),
  [work queue contract](../specs/work-queue.md), and
  [queue vertical spike](../plans/queue-vertical-spike.md)
- Product: [GitHub organization maintenance fleet](../prd/agent-fleet.md)
- Builds on: [ADR-0002](0002-agent-portable-instruction-surface.md)
