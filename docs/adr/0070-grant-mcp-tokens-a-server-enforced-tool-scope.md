# 0070 — Grant MCP tokens a server-enforced tool scope

- **Status:** Accepted
- **Date:** 2026-08-21

## Context

A Snowcat-minted MCP token ([ADR-0063](0063-authenticate-people-through-cloudflare-access-and-mint-mcp-tokens.md))
identifies a member and a client, and since schema rung 9 it may carry a
claim restriction — the work kinds `claim_work` may lease
([work queue spec](../specs/work-queue.md) rules 49–50). It still
authenticates a client that can invoke every MCP tool: the restriction
narrows what a claim returns, not which tools exist for the credential.

Snowcat Cockpit needs an operator-triggered, read-only snapshot of queued
work over HTTP MCP (Cockpit ADR-0004, *Observe Snowcat once to plan bounded
fleets*). Its interim credential is a token restricted to a synthetic,
never-seeded kind (`cockpit-observer-no-claim`). That prevents a successful
claim today, but it is not an observation-only credential: `heartbeat_work`,
`complete_work`, `block_work`, and `release_work` remain callable, and a
kind seeded by mistake under that name would reopen the claim path. A
client-side promise to call only `list_work` is not a production
authorization boundary, and the host runs on a mesh where the token is the
whole credential.

## Decision

A minted token may carry a **tool grant**: the only MCP tools the credential
may call. The grant is stored with the token (`mcp_tokens.tools_json`,
schema rung 14; `NULL` is every tool, which is what every existing token
is), validated at mint against the closed list of tools the contract exposes
(`mcpToolNames`), shown by `token list` and the surface's `/tokens` page, and
never widened afterwards.

The server enforces it by **registration, not filtering**: for a credential
with a grant, `buildQueueMcpServer` registers only the granted tools. A call
to any other tool is refused by the protocol layer as an unknown tool before
any handler runs, whatever arguments it carries, and `tools/list` advertises
only the grant. The stdio server honors the same shape through
`SNOWCAT_MCP_TOOLS`.

Operators mint a grant as an explicit list (`token mint … --tools
list_work,get_work`) or by a catalogued **profile** (`--profile observer` =
`get_work`, `list_work`). A profile is a grant, not a base to widen; the two
flags are mutually exclusive. A grant that includes `claim_work` is recorded
in each lease's `work.claimed` payload as `toolsGrant`, beside the existing
`kindsRestriction`, so the ledger names the authority the lease was taken
under; it changes nothing about which item is claimed.

## Consequences

- An observation-only client is a property of its credential. Cockpit's
  synthetic-kind compromise can be retired: mint `--profile observer` and
  the token can list and read, and nothing else, whatever it sends.
- Lease tokens never reach an observation-only client: the only tool that
  reveals one (`claim_work`) is not registered for it.
- Existing tokens are unchanged (`NULL` grant); an operator narrows a token
  only by minting a new one — grants are immutable, like kinds.
- The tool list becomes a closed vocabulary the server, the store, the CLI,
  and the tests share. Adding an MCP tool means adding it to `mcpToolNames`
  and deciding which profiles include it; a new tool is therefore never
  silently granted to an existing restricted token.
- Two independent restrictions now ride one token (kinds and tools). They
  compose by intersection of effect — a `pr-review`-kinds token with a grant
  lacking `claim_work` claims nothing — and neither widens the other.
- The surface's `/tokens` page still mints unrestricted tokens only; grants
  are minted from the CLI, like kinds.

## Alternatives considered

- **Named roles stored on the token, checked inside each handler:** a
  check inside the handler runs after input parsing and relies on every
  future handler remembering it; registering only the granted tools makes
  the refusal structural and keeps `tools/list` truthful.
- **A separate read-only endpoint (`/mcp-observe`):** two endpoints with two
  tool sets to keep in step, and the credential would still have to say
  which one it may use. One endpoint, one token shape.
- **Keep the synthetic-kind compromise:** it guards one tool by accident
  and fails open on a seeding mistake.
- **Scopes in the MCP authorization protocol (OAuth):** Snowcat holds no
  OAuth client by decision ([ADR-0063](0063-authenticate-people-through-cloudflare-access-and-mint-mcp-tokens.md));
  the minted token is the credential and the grant rides it.

## References

- Shapes: [work queue](../specs/work-queue.md) (rules 49–50 and 65),
  [queue operations runbook](../design/queue-operations.md)
  (an observation-only client), [operator surface](../design/operator-surface.md)
  (`/tokens`), [queue execution boundary](../design/queue-execution-boundary.md)
- Builds on: [ADR-0063](0063-authenticate-people-through-cloudflare-access-and-mint-mcp-tokens.md)
- Requested by: frostyard/snowcat-cockpit ADR-0004; snowcat issue #191
