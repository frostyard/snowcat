# 0063 — Authenticate people through Cloudflare Access; mint MCP tokens so the ledger says who

- **Status:** Proposed
- **Date:** 2026-08-18

## Context

Fluent runs on one host ([ADR-0059](0059-adopt-the-queue-store-as-the-v1-work-engine.md),
[runbook deployment section](../design/queue-operations.md#deployment-v1-decided-2026-08-17)).
Its only credentials are the operator's: the shell that starts a worker
client, `FLUENT_GITHUB_TOKEN`, and one shared `FLUENT_APP_TOKEN` for the
operator surface. MCP is stdio only, so a worker must run on the host; a
worker's identity is a string it declares about itself
(`claude-code:frostyard/updex:abc`), trusted as provenance and never as
authorization ([ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md));
the surface writes every decision as `operator:web`.

Two facts changed on 2026-08-18. The fleet grew to four repositories with
eight programs and several worker sessions running at once, so *who admitted
this* and *which client did that* stopped being answerable from the ledger.
And the first workers that must run somewhere other than the operator's
laptop are now wanted — the recovery plan's stated trigger for the deferred
"remote workers, per-operator surface auth" work.

The people are three members of the `frostyard` GitHub organization at equal
trust. Authorization already exists and is per repository, not per person:
each repository's governance file and its Core declaration bound what any
worker may do there. What is missing is authentication — knowing who — and a
transport that lets a worker reach the queue from another machine. The
organization already runs Cloudflare; every MCP client in use (Claude Code,
Codex, Copilot CLI) can send a static bearer header, while OAuth flows for
remote MCP servers are still unevenly supported.

## Decision

- **People authenticate at the edge, not in Fluent.** The host is published
  through a Cloudflare Tunnel with **Cloudflare Access** in front of both the
  operator surface and a new HTTP MCP endpoint, using GitHub as the identity
  provider and one policy: member of the `frostyard` organization. Fluent
  writes no login page and holds no OAuth client; it verifies the Access JWT
  (`Cf-Access-Jwt-Assertion`, signature checked against the team's public
  keys, audience pinned) and reads the GitHub login from it. `FLUENT_APP_TOKEN`
  is retired once Access is in place; loopback without Access remains the
  local-development mode.
- **MCP moves to Streamable HTTP behind that gate**, keeping stdio for the
  local operator. A worker authenticates with a **Fluent-minted token**: a
  member creates it from the surface (name it after the client — "codex on
  the laptop"), Fluent stores only its hash with the owner's GitHub login,
  the client sends it as a bearer header, and the member revokes it from the
  same page. Tokens grant nothing by themselves; they identify.
- **Actors are identities, not claims.** Every event and decision is
  attributed to `github:<login>` (with the token's client name for workers)
  taken from the Access JWT or the token, never from the request payload. The
  self-declared worker identity of ADR-0018 becomes an optional label
  recorded beside the real one; the reserved-namespace rule becomes "the
  transport supplies the principal, the payload cannot." `operator:web` and
  the local `operator:cli` remain the attributions for the unauthenticated
  local modes only.
- **Nothing else changes.** Single host, SQLite, the timers, the governance
  and Core ceilings, and merge-stays-human are untouched; there are no roles,
  teams, grants, or per-person policies — three equal members do not need
  them, and the first request for one is a new ADR.

## Consequences

- Workers can run anywhere a member can reach the tunnel; the operator's
  laptop stops being the only place the fleet exists.
- The ledger finally answers "who": admission, requeue, cure completions,
  and merges-that-followed carry a GitHub login. Revoking a token ends a
  client's access without touching anyone else's.
- New obligations: keep the Access policy and the token page correct;
  rotate the tunnel credential like any other secret; verify JWTs with the
  team's key set and refuse a stale one; local development must not be
  reachable through the tunnel without Access.
- Deferred, deliberately: MCP OAuth (revisit when every client speaks it),
  per-repository or per-person grants (ADR-0032/0034 remain "Later"), and
  audit export beyond the ledger.

## Alternatives considered

- **In-app GitHub OAuth for the surface and OAuth for MCP:** rejected for
  now; it re-implements what Access provides, and OAuth for MCP is not yet
  usable from every client. It stays the fallback if a client cannot send a
  header or someone outside the organization ever needs read access.
- **Access service tokens instead of Fluent-minted tokens for MCP:** rejected
  because Fluent would not know which token, and therefore which client, made
  a change; minting keeps revocation and attribution inside the ledger.
- **Keep stdio-only and require every worker on the host:** rejected; it was
  the v1 simplification and its trigger for revisiting has arrived.

## References

- Shapes: [queue operations runbook](../design/queue-operations.md)
  (deployment), [queue execution boundary](../design/queue-execution-boundary.md),
  [operator surface](../design/operator-surface.md),
  [work queue](../specs/work-queue.md) (actors and reserved namespaces)
- Builds on: [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md),
  [ADR-0059](0059-adopt-the-queue-store-as-the-v1-work-engine.md),
  [ADR-0060](0060-bring-the-operator-surface-forward-as-a-read-first-inbox.md)
- Plan: [recovery plan](../plans/recover.md) — "Later / remote workers"
