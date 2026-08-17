# 0057 — Require webhook ingress for GitHub observation

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

ADR-0056 requires Fluent to retain the exact revision GitHub evaluated for
required checks and to expose any gap that makes an evidence population
incomplete. Polling can read current pull requests, rules, checks, statuses, and
branch heads, but it cannot continuously preserve state that GitHub later
replaces.

In particular, the pull-request API exposes a synthetic test-merge SHA before a
merge and changes `merge_commit_sha` to the resulting branch commit afterward.
GitHub may require checks on that test-merge revision when it has statuses, or
on the pull-request head otherwise. A pull request can merge between two polls,
so polling alone can permanently miss the revision that governed the merge.

GitHub offers authenticated webhooks for pull requests, pushes, checks,
statuses, and ruleset changes. Webhook delivery is nevertheless an at-least-
once notification transport, not a complete source snapshot. Deliveries may be
duplicated, delayed, rejected, or missed while Fluent is unavailable. GitHub's
delivery inspection surface exposes only recent history, so recovery also has
a finite horizon.

The accepted deployment is self-hosted on the operator's server. Requiring an
inbound endpoint reachable by GitHub is a material deployment boundary and
requires explicit acceptance rather than being hidden inside an adapter.

## Decision

Any Fluent deployment that uses `github-required-checks:v1` or authoritative
GitHub merge reconciliation MUST expose one bounded HTTPS webhook endpoint
reachable by GitHub. Direct ingress, a reverse proxy, or a tunnel is acceptable
when TLS and the request body remain protected in transit and the self-hosted
Fluent instance remains the durable processor. A third-party webhook queue is
not a source of authority.

The endpoint belongs to Fluent's separate read-only GitHub App. The App retains
read-only repository permissions; webhook ingress does not authorize Fluent to
write repository content, checks, statuses, issues, pull requests, rules, or
merges. App-level read access to recent delivery history may support repair,
but Fluent does not request redelivery or mutate GitHub as part of normal
reconciliation.

### Ingress transaction

For each request, Fluent MUST:

1. enforce method, content type, request-size, and time bounds;
2. verify `X-Hub-Signature-256` over the exact request bytes with a host-injected
   webhook secret before trusting any payload field;
3. validate the delivery GUID, event, action, App installation, immutable
   repository identity, and supported payload shape;
4. deduplicate by the GitHub delivery GUID, which remains stable on redelivery;
5. atomically retain a bounded observation-class GitHub delivery receipt, the
   applicable allowlisted typed observations, and an attributable event; and
6. return a successful response only after that transaction commits, without
   calling GitHub, running a model, or performing reconciliation in the request
   path.

If validation or persistence fails, Fluent MUST fail the request rather than
acknowledge data it did not durably accept. Exact raw webhook bodies MUST NOT be
retained after the ingress transaction. The receipt retains the delivery GUID,
event and action, source identities, exact-body digest, signature-verification
result, received time, processing disposition, and normalized-record
references. Free-form pull-request text, commit messages, check output, diffs,
and logs are excluded unless a later typed contract explicitly requires them.

A GitHub delivery receipt proves only that Fluent authenticated and durably
processed one transport delivery. It is not the observation it references, a
GitHub fact, an effective-rules snapshot, or proof of source coverage.

### Reconciliation and checkpoints

Every relevant receipt schedules bounded reconciliation outside the HTTP
request. A leased periodic controller also reconciles while no webhook arrives
and on startup. Webhooks reduce detection latency; polling repairs and verifies
current source state. Neither path can silently substitute for the other.

Reconciliation uses only fully paginated, allowlisted read operations and
retains typed observations for repository identity and default branch,
applicable rules, pull requests, default-branch transitions, check runs, and
commit statuses. One successful complete enumeration produces a source
checkpoint binding its exact query scope, observation time, pagination proof,
source revisions or response validators, item count, and normalized digest.
A checkpoint proves only that bounded read at that time; it does not
retroactively prove a quiet interval.

The controller separately audits recent GitHub App delivery history by GUID and
fetches a missed delivery while GitHub still exposes it. Because the delivery
API returns an authenticated parsed record rather than the exact original HTTP
bytes, repair creates a delivery-audit observation and API-sourced normalized
observations; it MUST NOT manufacture the missing HMAC-verified ingress receipt
or its exact-body digest. This read-only repair does not ask GitHub to
redeliver. The implementation MUST audit often enough to leave a documented
safety margin inside GitHub's delivery-history horizon. Exact schedules,
backoff, request budgets, and the conservative repair deadline belong in the
implementing specification and operations configuration.

### Source coverage and gaps

An observation window may begin only after Fluent retains a starting checkpoint
set for the repository, default branch, effective required-check selectors,
open pull requests that could merge, their candidate revisions, and delivery-
audit continuity. It may close only after a post-window reconciliation and
delivery audit cover the end boundary.

Fluent records a source gap for a registered source scope and an interval
beginning at the last established coverage boundary when required coverage
cannot be established. Its end remains open until exact repair observations
bound it. Causes include an unauditable webhook outage, an authenticated but
unsupported relevant payload, failed normalization, incomplete pagination,
unresolved ruleset or branch change, broken branch-update continuity,
conflicting source records, or an unrecoverable required-check revision.

A source gap, source checkpoint, delivery receipt, and delivery-audit result
are registered observation-class records rather than new generic record
classes. A later repair appends the observations that bound or resolve the gap;
it never deletes the gap occurrence or rewrites what Fluent knew earlier. A
dependent evidence population remains incomplete while a relevant gap is
unrepaired. If the recovery horizon expires before exact repair, every
overlapping v1 result is `unable` rather than approximated from current state.

### Required-check revision

Fluent derives the required-check revision only from retained source records
that identify the pull request, head revision, candidate test-merge revision,
required selectors, and matching check or status revisions. It does not use the
post-merge `merge_commit_sha` as a substitute for a missed pre-merge revision.
If the source records do not select exactly one revision under GitHub's
documented required-check behavior, the occurrence has a source gap and the
window is incomplete.

### Security and retention

The public endpoint exposes no reads, administrative operations, MCP tools, or
generic mutation. It accepts only the configured GitHub App hook, uses
constant-time SHA-256 signature comparison, applies bounded concurrency and
request size, and keeps the webhook secret and App key outside durable records
and logs.

Delivery receipts and normalized observations use the existing information-
class boundary. Retention MUST protect every record cited by an open window,
retained verification result, fact, or decision. Ordinary uncited transport
detail may be pruned under a later bounded retention contract, but its removal
cannot manufacture source coverage or erase a recorded gap.

The source adapter remains unregistered until ingress, delivery audit,
reconciliation, checkpoints, gaps, retention protection, and recovery fixtures
are implemented together.

## Consequences

- V1 GitHub observation requires one narrow public HTTPS ingress path even
  though the durable service remains self-hosted.
- Fluent can retain pre-merge source state that polling alone may miss while
  preserving a read-only GitHub permission boundary.
- Webhook receipt, normalized observation, source checkpoint, source gap,
  evidence population, and fact remain mechanically distinct.
- A server outage can reduce availability and make a measurement `unable`; it
  cannot be reinterpreted as successful source coverage.
- The operator must manage TLS or a tunnel, webhook and App secrets, endpoint
  monitoring, and recovery within GitHub's finite delivery-history horizon.
- Ingress parsing, delivery audit, normalization, polling, gap repair, and
  evidence retention add substantial implementation and test surface.

## Alternatives considered

- **Poll GitHub only:** rejected because a pull request can merge between polls
  and GitHub replaces the pre-merge test SHA afterward.
- **Trust webhooks without reconciliation:** rejected because webhooks are
  duplicated and can be missed, delayed, rejected, or unsupported.
- **Have Fluent create a required GitHub check:** rejected because it grants
  repository write authority and makes Fluent part of the merge gate rather
  than an independent observer.
- **Store every raw webhook body indefinitely:** rejected because it retains
  broad free-form repository content without making observations or coverage
  more authoritative.
- **Use a hosted webhook queue as canonical input:** rejected because it adds
  another authority and custody boundary to the self-hosted control plane.
- **Infer the tested revision from the final merge commit:** rejected because
  GitHub documents different pre- and post-merge meanings for
  `merge_commit_sha`.

## References

- Shapes:
  [GitHub observation and reconciliation](../design/github-observation.md),
  [success-measure verification](../design/success-measure-verification.md),
  [required-check ruleset operations](../design/required-check-ruleset-operations.md),
  and
  [product foundation roadmap](../plans/product-foundation-roadmap.md)
- Builds on:
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md),
  [ADR-0023](0023-base-ci-maintenance-on-observed-runs.md),
  [ADR-0037](0037-store-facts-with-a-separate-event-ledger.md),
  [ADR-0043](0043-order-records-by-transaction-sequence-not-timestamps.md),
  [ADR-0055](0055-separate-evidence-population-from-rate-evaluation.md), and
  [ADR-0056](0056-derive-required-checks-from-enforced-github-rules.md)
