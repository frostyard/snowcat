# 0058 — Bound GitHub observation recovery and retention

- **Status:** Accepted
- **Date:** 2026-08-17

## Context

ADR-0057 requires authenticated webhook ingress, periodic polling, delivery
audit, finite recovery, source gaps, and protected retention before GitHub
observations may affect authority. GitHub exposes recent App webhook deliveries
for only three days. A controller that audits near that boundary has no useful
margin for an operator to restore service, while an unbounded controller or
retain-everything policy can exhaust API allowance and local SQLite storage.

The observation stream has different durability needs. Records cited by an
open observation window, retained evidence population, fact, decision, or audit
explanation must remain reproducible. Uncited duplicate transport and polling
detail is operational history rather than permanent authority. Source gaps are
small, material accounts of lost coverage and should not disappear merely
because their surrounding diagnostic detail ages out.

Cadence is also not evidence. A configured five-minute audit target does not
prove five-minute coverage, and crossing an operational deadline does not make
an exact later repair false. Fluent must retain what completed, what did not,
and which interval remains uncertain without turning a scheduler timestamp into
source truth.

## Decision

Fluent uses one leased App-wide delivery-audit schedule and independently
leased per-repository reconciliation schedules. A directly accepted relevant
delivery makes its repository immediately due; repeated triggers coalesce and
do not create overlapping runs.

The supported v1 operational bounds are:

| Bound | Default | Configurable range or rule |
| --- | --- | --- |
| Healthy repository reconciliation | 15 minutes after completion | 1–60 minutes |
| Healthy App delivery audit | 5 minutes after completion | 1–15 minutes |
| Controller lease | 10 minutes | Fixed in v1 |
| One GitHub API request | 30 seconds | Fixed maximum in v1 |
| Source-unavailable retry | 1, then 5, then 15 minutes | Fixed capped sequence; a later GitHub rate-limit reset or `Retry-After` wins |
| Delivery-audit safety deadline | 48 hours after the last complete audit boundary | Fixed in v1; leaves at least 24 hours inside GitHub's documented three-day history horizon |
| Ordinary uncited observation detail | 30 days | Fixed in v1 |
| Purge-eligible repository transactions | Newest 100,000 per repository | Authority/reference protection wins |
| Purge-eligible fleet transactions | Newest 1,000,000 total | Applied after the per-repository bound; authority/reference protection wins |
| Retention maintenance | At most once per 24 hours | Fixed in v1 |

Startup completes an App delivery audit before it admits a new observation
baseline or closes a window. A webhook trigger may move one repository's next
due time earlier but never moves the App audit boundary. A controller awaits
each acquired lease; an unexpired lease prevents duplicate work and an expired
lease is recoverable.

Every incomplete audit or repository scope creates or extends a typed source
gap from the last established coverage boundary as soon as the uncertainty is
known. Repeated retry uses the fixed sequence above. At 48 hours the operational
projection reports that the safety deadline is exceeded, an andon is eligible,
and no new baseline or window closure may rely on the interval. Fluent
continues bounded repair while GitHub still exposes exact records. A later
exact repair may close the gap; the 48-hour deadline is not evidence that
repair is impossible. If GitHub no longer exposes the exact interval, the gap
remains open and every overlapping population is `unable`.

Primary or secondary rate-limit instructions always delay until the later of
the ordinary retry and GitHub's explicit safe retry time. That delay remains an
open coverage gap; it is not a reason to extend the 48-hour safety deadline.
One run stops before lease expiry or when its implementing request/item budget
is exhausted. It commits completed observations but cannot emit a checkpoint
for an incomplete registered scope.

Retention protects, regardless of age or count:

- every record and relationship cited by an open window, retained evidence
  population, fact, decision, attestation, or audit explanation;
- the latest complete checkpoint and latest effective observation required for
  each current registered scope;
- every open gap and its acquisition and repair chain; and
- the compact gap occurrence and terminal repair disposition after closure.

All other GitHub ingress, delivery-audit, polling, checkpoint, and normalized
observation transactions become purge-eligible when older than 30 days or when
their repository or fleet count exceeds the applicable newest-transaction
limit. A transaction containing any protected occurrence is protected as a
whole. Authority/reference retention may exceed both count limits.

Pruning is one typed deterministic command with an optimistic control-plane
sequence. It deletes complete eligible transactions and their idempotency
receipts, never individual occurrences. It appends a retained summary
observation and event containing cutoffs, repository and fleet counts,
transaction/occurrence bounds, and a digest of deleted identities and payload
digests, then atomically rebuilds affected projections. Deleted transaction
sequences remain gaps and are never reused. A prune cannot close a source gap,
complete a checkpoint, or make an evidence population sufficient.

The implementing specification must set body, page, request, item, and
transaction-size limits that fit inside these schedules and lease. Those
mechanical limits may become stricter without changing the authority model;
loosening the recovery deadline or deleting a protected class requires a new
decision.

## Consequences

- Healthy webhook loss is normally discovered within five minutes and current
  source state is normally reconciled within fifteen minutes.
- A two-day audit deadline leaves one day of documented recovery margin for an
  operator or controller failure.
- Temporary failure creates visible uncertainty immediately while exact later
  repair remains possible; schedule state never impersonates coverage.
- Ordinary high-volume detail has time, per-repository, and fleet bounds, while
  protected evidence can exceed those storage targets.
- Keeping gap summaries durably supports ProcessObserver reliability analysis
  without retaining every surrounding API payload forever.
- A very active repository may lose uncited recent diagnostic detail before 30
  days when it exceeds 100,000 eligible transactions; active windows and cited
  evidence remain protected.
- Controller implementation must coordinate an App-wide lease, repository
  leases, rate-limit state, protected-reference discovery, atomic pruning, and
  projection repair.

## Alternatives considered

- **Audit every 24 hours:** rejected because it consumes too much of the
  three-day recovery horizon before a failure is noticed.
- **Use three days as the operational deadline:** rejected because the source's
  history boundary is not a safe local service objective and leaves no repair
  margin.
- **Declare repair impossible at 48 hours:** rejected because exact records may
  still be available; the deadline is an operational andon, not evidence.
- **Retain every GitHub observation forever:** rejected because webhook and
  check activity would make local storage unbounded.
- **Apply only a time limit:** rejected because a webhook storm can exhaust
  storage inside 30 days.
- **Apply hard total caps including cited evidence:** rejected because pruning
  must not make retained authority or decisions irreproducible.
- **Prune individual records from a transaction:** rejected because it would
  break atomic provenance and idempotent replay.

## References

- Shapes:
  [GitHub observation and reconciliation](../design/github-observation.md),
  [success-measure verification](../design/success-measure-verification.md),
  and
  [product foundation roadmap](../plans/product-foundation-roadmap.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md)
- Builds on:
  [ADR-0023](0023-base-ci-maintenance-on-observed-runs.md),
  [ADR-0033](0033-observe-processes-and-pull-scoped-andons.md),
  [ADR-0037](0037-store-facts-with-a-separate-event-ledger.md),
  [ADR-0042](0042-use-rebuildable-projections-only-as-read-models.md),
  [ADR-0043](0043-order-records-by-transaction-sequence-not-timestamps.md),
  [ADR-0048](0048-retain-core-check-detail-for-30-days.md),
  [ADR-0049](0049-poll-core-through-one-leased-controller.md), and
  [ADR-0057](0057-require-webhook-ingress-for-github-observation.md)
