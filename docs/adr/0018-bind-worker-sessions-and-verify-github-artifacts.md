# 0018 — Bind worker sessions and verify GitHub artifacts

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

[ADR-0003](0003-separate-work-coordination-from-execution.md) leaves capable
coding agents, their GitHub credentials, and their tools under operator control.
That boundary avoids importing subscription authentication and client process
management into Fluent, but it creates two distinct trust problems:

- a worker can claim an arbitrary identity when it calls the queue; and
- a completion can report an issue, pull request, commit, or check URL that does
  not exist, belongs to another repository or attempt, or was created by an
  unexpected actor.

The current queue correctly retains worker reports as provenance rather than
verified fact. V1 now needs a durable identity and reconciliation model without
taking possession of the worker's write credentials. Lease recovery adds a
further complication: an expired attempt may create an artifact after another
worker has claimed the same item, causing duplicate issues or pull requests.

Git commit author and committer strings do not solve these problems. A client
can set them freely, and they do not establish which authenticated GitHub actor
pushed a branch or opened a pull request.

## Decision

Fluent separates and records these identities:

- the authenticated operator or named-member principal that initiated the
  worker session;
- a server-assigned worker session, bound to that principal and client
  connection;
- descriptive provider, client, and model metadata, which never grants
  authority;
- a distinct server-assigned work-attempt ID for each successful claim;
- the expected GitHub actor or bounded set of actors permitted for the
  principal or session; and
- the actual GitHub actor independently observed during reconciliation.

An authenticated queue transport MUST derive its authoritative principal and
worker-session identity from the server-side session. A caller-supplied worker,
provider, model, account, author, or committer string is untrusted metadata and
MUST NOT select a principal, inherit authority, or satisfy actor verification.
The initial local-stdio deployment may bind the one operator implicitly; it
must preserve these distinct identities so remote and named-member transport
does not require redefining provenance.

Every claim creates a new attempt ID and a random public correlation nonce.
Fluent gives both to the worker for artifact correlation. The worker places a
minimal machine-readable marker in an issue or pull-request body:

```html
<!-- fluent-work-item: <item-id>; attempt: <attempt-id>; correlation: <nonce> -->
```

The nonce correlates public artifacts; it is not authentication and grants no
queue authority. A marker MUST NOT contain a lease token, credential, prompt,
evidence payload, private host address, or other secret. Lease tokens remain
confined to the authenticated worker protocol.

Workers continue to use GitHub write credentials owned by their client and
operator environment. Fluent MUST NOT receive, mint, refresh, proxy, store, or
distribute those credentials. For reconciliation, the Fluent control plane
uses a separate read-only GitHub identity. A least-privilege GitHub App
installation is preferred; a read-only host-injected token is acceptable for
the initial single-operator deployment. Its credential is a runtime secret and
MUST NOT enter the database, logs, work records, prompts, or artifact markers.

Reporting completion and verifying an artifact are separate transitions. A
reported artifact progresses through `reported`, `pending`, and `verified`, or
to `mismatch` when GitHub returns contradictory facts. `unavailable` records a
bounded reconciliation failure without asserting that the report is false.
Fluent retries pending or unavailable reconciliation with bounded backoff and
retains every observation and transition.

For an issue or pull request, reconciliation checks at least:

- the immutable enrolled GitHub repository ID, artifact kind and number, and
  canonical URL;
- the actual GitHub actor against the session's permitted actor binding;
- the exact item ID, attempt ID, and public correlation nonce in the marker;
- artifact creation time against the attempt and lease history;
- the action permitted by the admitted work and effective policy;
- for a pull request, its base, head, commits, current state, and that the
  worker did not merge it; and
- whether the item or another attempt already has an equivalent artifact.

Commit author and committer strings remain informational. They may be retained
for diagnostics but MUST NOT satisfy authenticated-actor checks.

Verification establishes existence, repository identity, authenticated actor,
and attempt lineage. It does not establish that code is correct, evidence is
truthful, checks are sufficient, a change complies with all policy, or a
maintainer accepts the outcome. Those remain separate validation, policy, and
human-review decisions. Queue completion means that a worker submitted its
report; it MUST NOT be presented as artifact verification or maintainer
acceptance.

Artifacts are attempt-specific. Lease expiry or a new claim creates another
attempt and nonce. A late artifact from a stale attempt is preserved as stale
provenance but MUST NOT silently satisfy the current attempt. An operator may
explicitly adopt a reconciled stale artifact after reviewing its repository,
content, state, actor, and applicability. Workers receive a read-only way to
find known item artifacts and their reconciliation state before creating
another issue or pull request, but discovery never transfers authority from an
old attempt.

## Consequences

- Fluent can prove which GitHub account created an artifact without holding
  the account's write credential.
- Operator, session, attempt, provider, and GitHub identities remain distinct,
  making attribution accurate even when several agents use one operator
  account.
- A public correlation marker makes reconciliation deterministic and portable
  across capable clients, but it adds small visible implementation metadata to
  issue and pull-request bodies.
- GitHub outages delay verification instead of turning absence of evidence into
  a mismatch.
- Attempt-specific lineage prevents late workers from silently completing new
  leases, while explicit adoption gives the operator a safe recovery path.
- Read-only artifact discovery and duplicate checks reduce duplicate work but
  cannot eliminate races between concurrent GitHub writes; reconciliation must
  expose rather than conceal those races.
- The control plane gains a GitHub integration and secret to operate even
  though it still owns no worker write credentials.
- Exact GitHub App permissions, actor-binding administration, fork-based pull
  requests, retry schedules, and maintainer-acceptance signals remain delivery
  decisions.

## Alternatives considered

- **Trust worker-supplied identity and URLs:** rejected because a bug, stale
  client, or malicious worker could claim another session's artifact or report
  a plausible non-result as completion.
- **Give Fluent the worker's GitHub token:** rejected because it crosses the
  coordination/execution boundary and puts write credentials, token refresh,
  and account impersonation in the control plane.
- **Have Fluent open every issue and pull request:** rejected because it makes
  the control plane an execution proxy and obscures the accountable actor that
  performed the work.
- **Use commit author email as identity:** rejected because Git metadata is
  caller-controlled and does not prove the authenticated GitHub actor.
- **Put the lease token in the artifact marker:** rejected because public
  repository content would disclose a queue capability.
- **Let any artifact for the item satisfy a later attempt:** rejected because
  stale, partial, or superseded work could be accepted without review.
- **Treat a successful GitHub lookup as maintainer acceptance:** rejected
  because artifact existence says nothing about correctness or usefulness.

## References

- Builds on the execution and credential boundary in
  [ADR-0003](0003-separate-work-coordination-from-execution.md), deterministic
  authority in [ADR-0004](0004-keep-models-outside-the-control-path.md), and
  database-enforced admission in
  [ADR-0006](0006-enforce-admission-in-the-database.md)
- Applies the action ceiling and governance vocabulary from
  [ADR-0017](0017-standardize-actions-boundaries-and-risk.md)
- Product: [maintenance fleet PRD](../prd/agent-fleet.md), especially
  [worker identity and GitHub reconciliation](../prd/agent-fleet.md#worker-identity-and-github-reconciliation)
- Implementation design, contract, and delivery plan: not yet authored
