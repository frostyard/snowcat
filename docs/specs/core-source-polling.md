# Spec: Core source polling

This contract governs the deterministic `CoreSourceController`, its durable
singleton operational state, and the host-local commands used to run or inspect
periodic Core synchronization. It does not redefine Core authority, source
freshness, admission readiness, or check-detail retention.

## Interface

The host-local commands are:

```sh
npm run --silent core -- poll
npm run --silent core -- poll-once
npm run --silent core -- poll-state
```

`poll` remains active and sleeps until the durable next-due time. `poll-once`
attempts one due run and exits; a not-due or actively leased result is success
with no Git work. `poll-state` is read-only.

`SNOWCAT_CORE_POLL_INTERVAL_SECONDS` is optional. Its default is `900`; when
present it MUST be a canonical integer from `60` through `3600`.

The operational state has this exact logical shape:

| Field | Type | Constraints |
| --- | --- | --- |
| `scheduleVersion` | integer | Exactly `1` |
| `healthyIntervalSeconds` | integer | `60`–`3600`; currently configured value |
| `nextPollAt`, `nextPruneAt` | UTC instant | Completion-relative due times |
| `sourceUnavailableStreak` | integer | Non-negative; reset by every other source outcome |
| `inFlightRunId`, `inFlightStartedAt`, `inFlightExpiresAt` | UUIDv7/UTC or null | Null together, or one live/recoverable ten-minute lease |
| `lastRunId`, `lastStartedAt`, `lastCompletedAt` | UUIDv7/UTC or null | Null before the first completion; otherwise one ordered completed run |
| `lastRunStatus` | enum or null | `completed` or `controller-error` |
| `lastSourceOutcome` | enum or null | Core source-check outcome when one was obtained |
| `lastCheckDisposition` | enum or null | `recorded`, `suppressed`, `record-failed`, or `none` |
| `completedRunCount`, `suppressedCheckCount` | integer | Monotonic non-negative operational counters |

One run result is exactly one of `claimed`, `not-due`, or `in-flight`. A claimed
run result also reports its run/lease identity, source result when available,
check disposition, repository reconciliation when the source result is
eligible, whether retention pruning ran, and the completed state.

## Rules

1. Claim MUST occur atomically before Git work. At most one unexpired lease may
   exist; a second claimant MUST perform no Git operation.
2. The first initialized state is due immediately. A completed run schedules
   the next due time from server completion, never from wall-clock slots or
   worker-supplied time.
3. The lease duration is exactly 600 seconds. Git subprocesses MUST time out
   after 300 seconds.
4. `source-unavailable` completion MUST schedule delays of 1,800 seconds after
   the first consecutive failure and 3,600 seconds after the second and later
   failures. Every other obtained source outcome resets the streak and uses the
   configured healthy interval.
5. A controller error with no source outcome MUST preserve the prior outage
   streak and retry at the healthy interval.
6. Eligible outcomes MUST always append their eligible-check transaction.
7. A candidate-invalid or continuity-blocked rejection MUST be suppressed only
   when the immediately preceding automatic source-check outcome has the same
   stage/code, candidate commit, and relevant active commit. Source-unavailable,
   persistence-failed, changed, and non-consecutive outcomes MUST be recorded.
8. Suppression MUST NOT refresh source freshness, alter admission readiness,
   allocate a control-plane sequence, or change prior check detail. It MUST
   increment the operational suppression counter on completion.
   A source outcome whose required check transaction cannot be written MUST use
   `record-failed`, complete as `controller-error`, and remain eligible for the
   outcome's normal scheduling/backoff rule.
9. A due retention prune MUST run after source synchronization and before run
   completion. Successful prune advances `nextPruneAt` by exactly 24 hours.
   Failure leaves pruning due and completes the run as `controller-error`.
   An eligible source result MUST run one repository reconciliation pass before
   pruning; a persistence/invariant failure in that pass is a controller error,
   while a bounded GitHub `unavailable` result is an ordinary scoped outcome.
10. Poll-state mutation MUST use `BEGIN IMMEDIATE`, validate the exact lease
    identity on completion, and leave authority transactions independently
    serialized by their existing optimistic sequence checks.
11. Startup MUST validate the complete state row. Backup content digest MUST
    cover it. Poll state MUST NOT appear as a record, event, fact, decision, or
    projection.
12. `poll` MUST await one run before another, cap any single sleep at 60
    seconds so shutdown can be observed, and terminate cleanly on SIGINT or
    SIGTERM without starting another run.
13. Schema version `8` and registry version `18` have no in-place migration
    from the pre-production target; initialize a fresh database.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| Next poll delay | Completion outcome, outage streak, and configured healthy interval |
| Duplicate disposition | Immediately preceding automatic durable check versus current hard failure |
| Retention maintenance | `nextPruneAt` plus the Core check-detail prune command |
| Operator poll status | Validated singleton operational state |

## References

- Rationale: [ADR-0049](../adr/0049-poll-core-through-one-leased-controller.md)
  and [ADR-0050](../adr/0050-reconcile-repository-enrollment-as-separate-facts.md)
- Context: [Core snapshot ingestion](../design/core-snapshot-ingestion.md)
- Readiness: [Core source readiness](core-source-readiness.md)
- Retention: [Core check-detail retention](core-check-detail-retention.md)
- Substrate: [control-plane kernel](control-plane-kernel.md)
- Delivery: [Core snapshot ingestion plan](../plans/core-snapshot-ingestion.md)
- Downstream reconciliation:
  [repository authority reconciliation](repository-authority-reconciliation.md)
