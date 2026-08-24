# 0072 — Back off claim selection after rapid worker releases

- **Status:** Accepted
- **Date:** 2026-08-23

## Context

`release_work` is the correct exit for a worker that claims an item it
cannot or should not do — a contract mismatch, a missing capability, a
self-authored review ([ADR-0029](0029-bound-adversarial-review.md)'s
independence rule). But a release changes nothing about the item, so the
same mismatch repeats on the next claim: on 2026-08-23 one item was claimed
and released five times in eleven minutes by campaign implementers before an
attempt stuck ([reality report finding 16](../design/reality.md)). Each
cycle burns a lease, a worker slot, and log attention, and the signal the
releases carry — this item's contract does not fit the fleet that keeps
drawing it — reaches nobody. The attempts ledger already records every
release with its worker and reason; nothing reads it at claim time.

## Decision

1. **Claim selection backs off a repeatedly released item.** A candidate
   with at least three `work.released` events not attributed to an
   `operator:` or `policy:` actor inside the trailing thirty-minute window
   is not in the running. The thresholds are fixed constants
   (`CLAIM_BACKOFF_RELEASES = 3`, `CLAIM_BACKOFF_WINDOW_SECONDS = 1800`),
   not configuration.
2. **The backoff is derived, never stored.** Nothing on the item changes —
   no status, no flag, no event; the exclusion is computed from the ledger
   by the same clock claim selection already uses, and the item re-enters
   the running the instant the decisive release slides out of the window.
3. **Only worker releases count.** An operator lease release
   ([ADR's rule 67 command](../specs/work-queue.md)) and a lease expiry
   evidence a gone holder, not a declined contract; neither counts toward
   the backoff.
4. **The churn is the operator's evidence.** The read-only `queue -- churn
   [--repository <owner/repo>]` listing names each backed-off item with its
   counted releases — time, worker, recorded reason — and when the backoff
   lapses. The remedies stay the ordinary operator ones: fix what the
   reasons complain about, `cancel`, `defer`, or re-propose; the backoff
   itself decides nothing.

## Consequences

- A contract-mismatched item stops consuming leases every campaign poll and
  becomes visible as a pattern instead of scattered log lines; the fleet's
  slots go to claimable work.
- Legitimate serial releases pause an item too — three self-authored
  reviewers releasing a `pr-review` in half an hour back it off just like a
  mismatch would. That is accepted: a fourth identical claim was not going
  to end differently, and the pause is bounded and self-lifting.
- Claim selection reads the events ledger; rung 15 adds the
  `work_events(work_item_id, event_type, occurred_at)` index so that read —
  and the attempts projection that always scanned the same way — stays
  cheap.
- The constants are deliberate policy, not tuning knobs; changing them is a
  new decision, not a configuration edit.

## Alternatives considered

- **Cancel after N releases:** destructive and wrong by default — the item's
  definition may be fine and the fleet mis-equipped; termination is the
  operator's call, which the churn listing informs.
- **Stored per-item backoff state (exponential, reset-on-claim):** more
  machinery than the sliding window needs, plus reset semantics and a new
  mutation path; the ledger already holds the whole signal.
- **Count expiries and operator releases too:** punishes slow or dead
  workers' items twice and conflates two different signals; rule 67 exists
  precisely to distinguish a gone holder from a declined contract.

## References

- Shapes: [specs/work-queue.md](../specs/work-queue.md) (rule 69),
  [design/queue-operations.md](../design/queue-operations.md),
  [design/reality.md](../design/reality.md) (finding 16)
- Builds on:
  [ADR-0059](0059-adopt-the-queue-store-as-the-v1-work-engine.md),
  [ADR-0029](0029-bound-adversarial-review.md)
