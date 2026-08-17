# GitHub observation and reconciliation

Living document. Rationale:
[ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md),
[ADR-0056](../adr/0056-derive-required-checks-from-enforced-github-rules.md),
and
[ADR-0057](../adr/0057-require-webhook-ingress-for-github-observation.md).
Proposed operational bounds:
[ADR-0058](../adr/0058-bound-github-observation-recovery-and-retention.md).
Adjacent contracts:
[control-plane kernel](../specs/control-plane-kernel.md) and
[conclusive-run-rate evaluator](../specs/conclusive-run-rate-evaluator.md).

## Overview

Fluent observes GitHub through an authenticated webhook ingress plus a
read-only reconciliation controller. Webhooks preserve transient source state
and trigger low-latency work. Polling verifies current state, completes pages,
and repairs recent missed deliveries. Durable typed observations feed
predicate contracts and source adapters; neither HTTP payloads nor API
responses directly establish authority.

```text
GitHub App webhook ──► authenticated ingress ──► receipt + observations
                                                    │
                                                    ▼
GitHub read APIs ───► leased reconciler ─────► checkpoints / source gaps
                                                    │
                           typed predicates ◄───────┤
                           evidence adapters ◄──────┘
```

The initial implementation supports repository identity and enrollment facts
already present in the target kernel, then adds the records needed for
artifact, merge, and enforced-required-check reconciliation. The source adapter
stays unregistered until its complete path is executable.

## Design

### Boundaries

| Component | Owns | Must not do |
| --- | --- | --- |
| GitHub webhook ingress | Authentication, bounds, delivery idempotency, allowlisted normalization, durable acceptance | Call GitHub, run models, derive facts, evaluate windows, expose reads |
| GitHub reconciliation controller | Leased scheduling, read-only API calls, full pagination, delivery audit, retry and repair | Hold the SQLite writer during network I/O, mutate GitHub, hide failed coverage |
| Typed source commands | Atomic observations, receipts, checkpoints, gaps, events, and idempotent results | Accept free-form kinds or generic fact writes |
| Predicate contracts | Establish exact GitHub propositions from accepted observations | Treat transport receipt or projection as truth |
| `github-required-checks:v1` | Build one closed evidence population from retained rules, revisions, checks, statuses, and coverage | Query GitHub during evaluation or shrink the denominator to returned runs |
| Projections | Operator status, lag, gaps, and reconciliation views | Become source authority or evidence sufficiency |

Worker GitHub credentials remain outside Fluent. The observer App is a separate
identity and has no repository write permission.

### App installation and events

The v1 GitHub App is installed only on repositories in the initial observation
scope. It requests these repository permissions:

| Permission | Level | Use |
| --- | --- | --- |
| Metadata | Read | Immutable repository identity and locator |
| Contents | Read | Default-branch refs, commits, ancestry, and branch transitions |
| Pull requests | Read | Artifact state, head/base revisions, merge state, and actors |
| Checks | Read | Check suites and runs for exact candidate revisions |
| Commit statuses | Read | Status contexts for exact candidate revisions |
| Administration | Read | Applicable rules and ruleset-change webhook subscription |

The App subscribes only to events needed by a registered observation contract:
`repository_ruleset`, `branch_protection_rule`, `pull_request`, `push`,
`check_run`, `check_suite`, and `status`, plus installation and repository-scope
changes needed to detect lost access. A new event or action is unsupported until
its schema and disposition are registered. Unknown relevant input creates a
source gap instead of being silently ignored.

The App private key and webhook secret are host-injected runtime secrets.
Installation IDs, App integration ID, hook identity, repository IDs, delivery
GUIDs, and non-secret source revisions are provenance and may be retained.

### Webhook ingress

The ingress is one POST-only HTTPS route. A reverse proxy or tunnel may
terminate public TLS, but it forwards the exact request body and signature
headers to Fluent over a protected local connection. Health, administration,
MCP, and operator APIs are different listeners or routes and are not exposed by
the webhook boundary.

Ingress reads a bounded body, verifies the SHA-256 HMAC in constant time,
validates registered headers and payload shape, and opens one short SQLite write
transaction. The transaction deduplicates the delivery GUID and appends:

1. one GitHub delivery receipt;
2. zero or more allowlisted observations for that event;
3. evidence relationships from the receipt to those observations; and
4. one past-tense processing event.

An equivalent redelivery returns the original receipt without creating new
observations. Reuse of a GUID with another body digest, event, installation, or
repository is a conflict and fails closed. If the transaction cannot commit,
the endpoint returns a non-success response so GitHub records a failed
delivery. Successful ingress performs no network I/O and returns within
GitHub's ten-second delivery deadline.

The exact raw body exists only while verifying and normalizing the request. It
is not written to the database, logs, events, or error output. Retained payloads
contain only fields registered for the event kind. Unsupported optional fields
are discarded; an unsupported event/action or malformed required field retains
bounded diagnostic provenance and creates a gap when the event could affect an
observed subject.

### Durable observation families

Registry version 12 assigns the source-native subject identities and purpose-
specific revision kinds below. The implementing records and commands will
assign exact registered kinds and payload schemas without changing these
identity joins:

| Family | Stable subject and revision | Selected content |
| --- | --- | --- |
| Delivery receipt | `github-app-hook` / `github.com:app:<app-id>:hook`; `github-webhook-body-sha256` | Delivery GUID stays transport provenance rather than becoming subject identity; content includes event/action, installation and repository IDs, received time, disposition, and normalized-record references |
| Delivery-audit observation | Same `github-app-hook`; `github-delivery-audit-sha256` | GitHub delivery ID/GUID, outcome, repository and installation IDs, canonical response digest, missing-receipt relationship, repair disposition |
| Repository observation | `github-repository` / `github.com:<repository-id>`; `github-metadata-sha256` | Owner/name locator, archive/access state, default branch |
| Effective-rules observation | Same `github-repository`; `github-rules-sha256` | Exact branch, ruleset IDs and source types, enforcement, selectors, integration IDs, bypass shape, unsupported classic/queue shape |
| Pull-request observation | `github-pull-request` / `github.com:<repository-id>:pull:<number>`; `github-pull-request-sha256` | State, actor IDs, base repository/branch/SHA, head repository/branch/SHA, pre-merge test SHA when present, merged time and resulting SHA |
| Branch-transition observation | Parent `github-repository`; `github-branch-transition-sha256` | Ref locator, before/after SHA, forced/deleted flags, source actor, delivery and ancestry bindings; a mutable ref name is not promoted to stable subject identity |
| Check-run observation | `github-check-run` / `github.com:<repository-id>:check-run:<check-run-id>`; `github-check-run-sha256` | Candidate SHA, name, App integration ID, suite/run attempt, status, conclusion, source times, PR associations |
| Commit-status observation | `github-commit-status` / `github.com:<repository-id>:commit-status:<status-id>`; `github-commit-status-sha256` | Candidate SHA, context, creator identity, state, source times |
| Source checkpoint | Parent `github-repository`; `github-source-checkpoint-sha256` | Registered query scope, endpoints, observation time, page proof, item count, response validators, normalized digest |
| Source gap | Parent `github-repository`; `github-source-gap-sha256` | Registered scope and interval, cause, first detection, affected identities/windows, repair observations and disposition |

Every family in this table will use a registered `observation` record kind; the
design does not introduce another generic record class. Registry version 12
contains only their subjects, revisions, and sources so far. An observation
records source state and provenance; it does not become a merge, required-check
satisfaction, artifact verification, or outcome fact merely because the GitHub
App is trusted.

Direct deliveries use source `github-app-webhook` and an exact body revision;
API acquisitions use `github-api` and the applicable canonical response
revision. Checkpoints and gaps use deterministic source
`fluent-system/github-observer` with no caller-selected source revision: their
own checkpoint or gap digest binds the repository subject, but is not
misrepresented as a revision issued by GitHub.

### Reconciliation cycle

A relevant receipt makes its repository due without running reconciliation in
the request. A leased controller also runs at startup and periodically. One
cycle performs bounded network reads first, then submits typed commands in
short transactions.

The controller:

1. validates the installation and immutable repository identity;
2. reads the current default branch and all active rules applying to it;
3. enumerates open pull requests and pull requests changed since the retained
   cursor overlap;
4. walks default-branch transitions from the last checkpoint without assuming
   timestamps are total order;
5. selects candidate head and observed test-merge revisions for relevant pull
   requests;
6. fully enumerates check runs and commit statuses for those exact revisions;
7. audits recent App webhook deliveries and fetches any missing delivery by
   GUID while GitHub still exposes it, retaining the API repair as a distinct
   delivery-audit observation; and
8. writes a source checkpoint only when every registered scope and page
   completed without conflict.

Pagination is part of the result, not an SDK detail. Missing a page, exceeding
a source cap, rate limiting before completion, an invalid cursor, or a response
that changes incompatibly during enumeration prevents a checkpoint. Ordinary
unchanged polls may reuse ETags or response validators only when the endpoint's
contract proves the same scoped representation.

Subject to acceptance of ADR-0058, healthy repository reconciliation defaults
to 15 minutes and App delivery audit to 5 minutes. Both are completion-relative
leased schedules; webhook triggers only make the affected repository due.
Source-unavailable retry uses 1, 5, then 15 minutes, while a later explicit
GitHub rate-limit time wins. Backoff cannot extend the claimed coverage
interval or make an overdue audit healthy.

### Coverage over an observation window

A required-check window has four coverage stages:

| Stage | Required evidence |
| --- | --- |
| `awaiting-baseline` | No window result is possible yet. |
| `observing` | Starting checkpoints bind repository identity, default branch, effective rules, open PR candidates, and delivery-audit continuity. |
| `settling` | The declared end passed, but a post-end poll and delivery audit have not yet closed late ingestion. |
| `closed` | The end checkpoint exists and every relevant gap is repaired, so the adapter may emit a complete evidence population. |

These labels are a future projection, not a universal status or authoritative
record. An open or settling window evaluates `unable`.

Each gap binds a registered scope and begins at the last established coverage
boundary. Its affected interval remains open until exact repair observations
establish an exclusive end. Recovery may fetch a missed delivery, complete
pagination, reconcile ancestry, or obtain a previously unavailable exact
source record. The repair appends typed observations that cite the gap; it does
not delete the gap, impersonate the missing ingress receipt, or move its
original transaction sequence. If exact repair becomes impossible, the gap
remains and every overlapping population is incomplete.

### Resolving the required-check revision

For each merged qualifying pull request, the adapter must have retained:

- the latest head SHA relevant to the merge;
- every observed pre-merge test SHA associated with that pull request;
- the stable enforced selector set and integration IDs;
- check runs and commit statuses for candidate revisions; and
- the pull-request merge observation plus exactly one matching default-branch
  transition.

GitHub's documented rule is applied deterministically to those retained source
records: if the test-merge revision has applicable status-check evidence, that
revision governs; otherwise the latest head revision governs. The chosen SHA is
the required-check revision. This is a deterministic derivation over observed
source revisions, not an inference from the resulting merge commit.

Zero candidates, multiple unresolved candidates, a candidate known only after
GitHub replaced the pre-merge field, or a missing source page creates a source
gap. The adapter does not guess. Merge queues and fork heads remain unsupported
by v1 before this resolution path.

### Delivery audit and recovery horizon

The App-level delivery API is a repair surface, not a permanent event log.
Fluent compares recent GitHub delivery GUIDs with its receipts, fetches locally
missing deliveries, and normalizes the parsed payload through a registered
App-API acquisition path. The result cites a delivery-audit observation and
does not fabricate the absent exact-body digest or HMAC verification. Fluent
does not ask GitHub to redeliver or treat a successful HTTP status in GitHub's
history as proof that local normalization committed.

GitHub documents recent deliveries for the past three days. Proposed ADR-0058
sets a 48-hour safety deadline, leaving 24 hours of operating margin. Crossing
that deadline surfaces an andon and blocks a new baseline or window closure; it
does not assert that exact later repair is impossible. Restart always audits
deliveries before admitting a new baseline or closing a window. If the exact
interval is no longer available, the gap remains open and overlapping results
remain `unable`.

### Information handling and retention

Allowlisted observations retain identities, SHAs, states, conclusions,
timestamps, rule parameters, and bounded provenance needed by registered
consumers. They exclude free-form PR and issue bodies, review text, commit
messages, diffs, check logs and annotations, workflow logs, and repository file
content unless another accepted contract explicitly selects them.

Receipts, checkpoints, gaps, and observations cited by an open window, retained
evidence population, fact, decision, or audit explanation are protected from
ordinary pruning. Proposed ADR-0058 retains other detail for 30 days and bounds
purge-eligible history to the newest 100,000 transactions per repository and
1,000,000 across the fleet. Open gaps and compact closed-gap/repair history
remain protected. Pruning removes complete unprotected transactions, preserves
deletion digests and sequence gaps, and cannot turn missing coverage into
complete coverage.

## Operational notes

- Do not enable a required-check observation window until the webhook endpoint,
  App installation, startup delivery audit, scheduled reconciliation, and
  starting checkpoint set are all healthy.
- A valid signature with an unknown relevant action is an adapter-version
  failure, not harmless noise. Surface it and open a source gap.
- An invalid signature is rejected at ingress and treated as untrusted traffic;
  it does not establish a GitHub source gap by itself.
- A GitHub outage, rate limit, pagination cap, or expired delivery-history
  boundary reduces availability. It never changes an absent source record into
  a negative observation.
- Existing `src/repository/github-api.ts` implements a bounded read-only helper
  for repository identity only. It is not yet webhook ingress, pagination,
  App authentication, delivery audit, or the observation adapter described
  here.
- Follow the
  [required-check ruleset runbook](required-check-ruleset-operations.md) only
  when the adapter is ready for its real-repository acceptance test.

## References

- Rationale:
  [ADR-0018](../adr/0018-bind-worker-sessions-and-verify-github-artifacts.md),
  [ADR-0056](../adr/0056-derive-required-checks-from-enforced-github-rules.md),
  and
  [ADR-0057](../adr/0057-require-webhook-ingress-for-github-observation.md)
- Proposed operations:
  [ADR-0058](../adr/0058-bound-github-observation-recovery-and-retention.md)
- Adjacent contracts:
  [control-plane kernel](../specs/control-plane-kernel.md) and
  [conclusive-run-rate evaluator](../specs/conclusive-run-rate-evaluator.md)
- Built in:
  [product foundation roadmap — Phase 4](../plans/product-foundation-roadmap.md#phase-4-observe-github-without-impersonating-workers-large)
- Product: [agent fleet PRD](../prd/agent-fleet.md)
- Operations:
  [enforced required-check rulesets](required-check-ruleset-operations.md)
- GitHub:
  [webhook best practices](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks),
  [webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads),
  [App delivery API](https://docs.github.com/en/rest/apps/webhooks),
  [viewing recent deliveries](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries),
  [pull-request API](https://docs.github.com/en/rest/pulls/pulls), and
  [required-check behavior](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)
