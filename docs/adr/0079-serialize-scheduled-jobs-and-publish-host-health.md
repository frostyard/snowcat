# 0079 — Serialize scheduled jobs and publish host health

- **Status:** Accepted
- **Date:** 2026-08-29

## Context

Snowcat runs six independent systemd timers so issue import, maintenance
seeding, artifact verification, repository sweeps, and backup can each keep
their own cadence. They nevertheless share one queue database, and backup also
reads the control-plane database. The timer calendar permits overlap.

On the live `selfie:snowcat` host at 2026-08-29 00:18 UTC,
`snowcat-seed-dogfood.service` overlapped `snowcat-verify.service`; verification
then exited with `database is locked`. Journald retained the failure, but the
operator inbox did not show which scheduled operation last succeeded or
failed. Recording that state in either SQLite database would add another
writer to the exact contention path being diagnosed.

## Decision

Keep the six timers and their independent cadences, but run every scheduled
service through `deploy/bin/snowcat-run-job`. The wrapper acquires one shared,
exclusive host `flock` before starting the real command. It waits rather than
skipping a due run and records how long lock acquisition delayed execution.
SIGINT and SIGTERM are forwarded to the active child and recorded as failed
attempts when the wrapper can still complete its shutdown path.

After each command exits, the wrapper writes one versioned health file for its
fixed job name under `/var/lib/snowcat/job-health` by default. The writer uses
an exclusive temporary file, file `fsync`, atomic rename, and directory
`fsync`. A record contains only timestamps, durations, lock wait, result, exit
code, and retained last-success/last-failure observations. It never contains
command output, source content, repository data, credentials, or arguments.

The health directory and lock path may be relocated with
`SNOWCAT_JOB_HEALTH_DIR` and `SNOWCAT_JOB_LOCK_FILE`. They remain outside the
queue and control-plane databases. If a successful command cannot persist its
health, the service fails rather than becoming success-shaped; if the command
already failed, its exit status remains authoritative and the health-write
failure is also emitted on stderr.

The operator inbox reads these files directly. A missing file is `never-run`;
a malformed or unreadable file is visibly `unreadable`, never treated as
healthy. The surface does not repair or mutate scheduler state. The next
completed attempt replaces an unreadable prior file with a fresh observation
and reports that discarded history on stderr; operational history is not
authoritative enough to wedge future runs.

## Consequences

Scheduled queue writers and backup no longer collide with one another even
when timer windows overlap. A long-running or hung job delays every later
scheduled job, which is preferable to concurrent SQLite contention but makes
systemd's process status and timeout/termination controls important.

The operator can see the last completed result, duration, lock wait, success,
and failure for every scheduled job without reading journald or opening another
database. SIGKILL, host loss, or power loss can still prevent a final record;
the prior completed observation remains and systemd remains authoritative for
the currently running process.

The health files are host observations, not queue facts or event-ledger
history. They are replaced in place, excluded from backup authority, and may
be deleted to return a job to `never-run`. If one is corrupt or from an
unsupported version, its retained success/failure history is lost when the
next completed attempt self-heals it.

## Alternatives considered

- **Rely on SQLite busy timeout:** rejected because live overlap already
  exhausted that tolerance and backup spans more than one database.
- **Merge the six timers into one service:** rejected because one feeder
  failure would skip unrelated work and the operator could no longer tune
  each cadence independently.
- **Store scheduler health in the queue database:** rejected because health
  persistence would become another queue writer and could fail for the same
  reason as the job it describes.
- **Skip a run when the lock is busy:** rejected because a due import,
  verification, or backup would disappear without an attempt.

## References

- Shapes:
  [scheduled jobs](../specs/scheduled-jobs.md),
  [operating the work queue](../design/queue-operations.md), and
  [operator surface](../design/operator-surface.md)
- Built in: [recovery plan](../plans/recover.md) Phase 6
- Builds on:
  [ADR-0059](0059-adopt-the-queue-store-as-the-v1-work-engine.md) and
  [ADR-0060](0060-bring-the-operator-surface-forward-as-a-read-first-inbox.md)
