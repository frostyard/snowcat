# 0077 — Derive follow-up contracts from proposer intent

- **Status:** Accepted
- **Date:** 2026-08-29

## Context

A worker that discovers adjacent work must currently repeat Snowcat's complete
durable child contract: kind, actions, delegation ceiling, required artifact,
and execution target. The values are tightly coupled. A change on a new branch,
a read-only investigation, and a change to an already-bound pull request each
have only one lawful contract shape under the parent ceiling.

Live use repeatedly produced follow-up refusals because capable workers omitted
one field or assembled an internally inconsistent combination. Asking every
worker prompt and client to reproduce the derivation does not add authority:
the parent ceiling and queue invariants remain authoritative. It distributes
one deterministic policy across prompts, models, and client versions.

[ADR-0069](0069-declare-the-required-artifact-on-every-work-item.md) and
[ADR-0073](0073-declare-the-execution-target-on-every-work-item.md) require
explicit durable fields so claimers never infer a delivery contract from kind
or actions. That remains necessary after proposal acceptance.

## Decision

Snowcat accepts an optional, closed follow-up `intent` vocabulary:

| Intent | Kind | Direct contract |
| --- | --- | --- |
| `read-only` | proposer declares | `read-only`, artifact `none`, direct `read` |
| `new-pr-change` | proposer declares | `new-pull-request`, artifact `pull-request`, direct `read`, `write`, and `open-pr` |
| `existing-pr-change` | server sets `pr-cure-change` | `existing-pull-request`, artifact `pull-request`, direct `read`, `write`, and `open-pr` |

The queue normalizes an intent-shaped proposal inside the parent's completion
transaction after establishing the active lease and parent. It adds
`run-tests` and `create-followup` to direct actions only when the parent can
delegate them, and also adds `open-issue` to a read-only child when delegated.
When it adds `create-followup`, the child receives the parent's complete
delegation ceiling; otherwise its delegation ceiling is empty.
Every derived direct and delegable action remains a subset of the parent
ceiling, and the existing contract predicate and policy-authority hook still
judge the normalized definition.

`existing-pr-change` is server-owned specialization. It is valid only under a
parent with a cure binding, becomes kind `pr-cure-change`, and inherits that
binding through the existing parent-owned mechanism. A proposer cannot name or
replace the pull request, head, cure record, review record, source reference,
priority, or predecessor. Review-bound lineages are outside this intent; their
server-defined `pr-review-fix` work continues through the review gate.

Intent is request-level shorthand, not durable state. The stored child still
carries the complete explicit contract required by ADR-0069 and ADR-0073. A
client may redundantly supply any derived field with an intent, but Snowcat
rejects the entire completion unless it exactly agrees with the canonical
derivation.

The existing full follow-up object remains a permanent compatibility form.
When `intent` is absent, every previously required contract field remains
required and retains its existing meaning. The MCP schema stays one strict
additive object rather than a union, so clients that cannot consume union
schemas can continue to discover and call the tool.

## Consequences

Worker prompts state what the child is for instead of reconstructing a coupled
contract. Follow-up refusal becomes evidence of an exceeded parent ceiling or
a genuinely invalid request rather than formatting drift.

Snowcat owns and must test one normalization table. Adding an intent is a
contract change requiring an ADR, specification update, and compatibility
coverage. Intent names must describe the desired work placement, not become
aliases for program kinds.

When the parent delegates `create-followup`, intent normalization deliberately
preserves its full ceiling rather than asking the worker to narrow it. That
keeps findings reachable but can let a child delegate actions it does not use
directly; lineage depth and the parent's existing ceiling remain the hard
bounds. A proposer that needs a narrower child ceiling uses the complete legacy
form instead of intent shorthand.

Older clients continue to work unchanged. Newer clients can send shorthand to
an older server only after normal capability/version rollout; the additive
transport shape does not make old servers understand new fields.

## Alternatives considered

- **Keep every field worker-authored:** rejected because it duplicates
  deterministic server policy in prompts and caused recurring invalid
  follow-ups without adding authority.
- **Infer contract from kind or action combinations:** rejected because it
  makes durable definitions ambiguous and reverses ADR-0069 and ADR-0073.
- **Use separate schema variants or a union:** rejected because strict MCP
  clients do not uniformly support union-shaped tool schemas.
- **Default missing legacy fields:** rejected because a typo in an old request
  would silently change the requested delivery contract.

## References

- Shapes:
  [queue execution boundary](../design/queue-execution-boundary.md),
  [work queue](../specs/work-queue.md),
  [Snowcat ubiquitous language](../domain/ubiquitous-language.md), and
  [worker queue procedure](../../.agents/skills/work-snowcat-queue/SKILL.md)
- Builds on:
  [ADR-0005](0005-admit-worker-created-work-before-claiming.md),
  [ADR-0061](0061-cure-pull-requests-as-bounded-per-head-work.md),
  [ADR-0069](0069-declare-the-required-artifact-on-every-work-item.md),
  [ADR-0073](0073-declare-the-execution-target-on-every-work-item.md), and
  [ADR-0074](0074-compile-policy-into-work-admission.md)
