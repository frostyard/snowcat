# Spec: Scheduled jobs

This contract governs the six timer-triggered host jobs, their shared
serialization boundary, their durable health observations, and the read-only
operator-surface projection that consumes those observations.

## Interface

Every scheduled service invokes:

```sh
deploy/bin/snowcat-run-job <job> <command> [args...]
```

`job` MUST be exactly one of:

| Job | Scheduled command |
| --- | --- |
| `verify-artifacts` | `queue -- verify-artifacts` |
| `import-issues` | `queue -- import-issues --enrolled --label snowcat` |
| `seed-dogfood` | `queue -- seed-dogfood --enrolled` |
| `sweep-dependencies` | `queue -- sweep-dependencies --enrolled` |
| `sweep-settings` | `queue -- sweep-repository-settings --enrolled` |
| `backup` | `deploy/bin/snowcat-backup` |

| Environment variable | Default | Constraints |
| --- | --- | --- |
| `SNOWCAT_JOB_LOCK_FILE` | `/var/lib/snowcat/scheduled-jobs.lock` | One path shared by all six services |
| `SNOWCAT_JOB_HEALTH_DIR` | `/var/lib/snowcat/job-health` | Directory readable by the operator surface and writable by the service user |

The atomically replaced file `<health-directory>/<job>.json` has this shape:

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `version` | integer | yes | Exactly `1` |
| `job` | string | yes | Matches the file name and fixed job vocabulary |
| `lastAttemptStartedAt` | string | yes | Canonical UTC ISO-8601 timestamp |
| `lastAttemptFinishedAt` | string | yes | Canonical UTC ISO-8601 timestamp |
| `lastDurationMs` | integer | yes | Non-negative execution time after lock acquisition |
| `lastWaitMs` | integer | yes | Non-negative wait before lock acquisition |
| `lastResult` | string | yes | `success` or `failure` |
| `lastExitCode` | integer | yes | `0`–`255`; `0` exactly when `lastResult` is `success` |
| `lastSuccessAt` | string | no | Finish time of the newest successful attempt |
| `lastFailureAt` | string | no | Finish time of the newest failed attempt |
| `lastFailureExitCode` | integer | no | Non-zero `1`–`255`; present exactly when `lastFailureAt` is present |

```json
{
  "version": 1,
  "job": "verify-artifacts",
  "lastAttemptStartedAt": "2026-08-29T00:18:04.123Z",
  "lastAttemptFinishedAt": "2026-08-29T00:18:06.456Z",
  "lastDurationMs": 2333,
  "lastWaitMs": 417,
  "lastResult": "failure",
  "lastExitCode": 1,
  "lastSuccessAt": "2026-08-29T00:16:05.000Z",
  "lastFailureAt": "2026-08-29T00:18:06.456Z",
  "lastFailureExitCode": 1
}
```

## Rules

1. All six shipped timer services MUST acquire the same exclusive advisory
   lock before starting their command. Lock contention MUST wait and MUST NOT
   skip the due command.
2. Execution duration MUST exclude lock wait. `lastWaitMs` MUST measure from
   wrapper entry until lock acquisition.
3. SIGINT and SIGTERM received while a child is active MUST be forwarded to
   that child. When shutdown remains recordable, the attempt MUST be stored as
   failure with exit status `130` or `143`.
4. One job's non-zero exit MUST NOT prevent later timer activations for other
   jobs. The wrapper MUST return the command's non-zero exit status.
5. A health-write failure after a successful command MUST make the service
   fail. A health-write failure after a failed command MUST preserve the
   command's status and emit the persistence error.
6. The writer MUST create a new temporary file exclusively, flush it, rename
   it over the target, and flush the containing directory. A failed write MUST
   leave no partial target or temporary file.
7. A new observation MUST retain the prior `lastSuccessAt` when the current
   attempt fails and the prior failure fields when the current attempt
   succeeds.
8. If the prior job file cannot be read or validated, the writer MUST emit a
   bounded diagnostic, discard its non-authoritative history, and atomically
   replace it with the current valid observation. Corruption MUST NOT
   permanently turn later successful commands into failed services.
9. Health state MUST remain outside both SQLite databases. It MUST NOT enter
   the queue event ledger, backup manifests, or control-plane records.
10. Health state MUST contain no command arguments, stdout, stderr, repository
   content, GitHub response, credential, or source-derived value.
11. The reader MUST return `never-run` for an absent job file and `unreadable`
    with a bounded reason for invalid JSON, an unsupported version, a
    mismatched job name, invalid fields, or a read failure. It MUST NOT infer
    success from either condition.
12. The operator surface MUST read health without opening a new database or
    mutating the host files. It MUST show the latest result, finish time,
    duration, lock wait, last success, and last failure for each job.
13. `deploy/install.sh` MUST create the default health directory and MUST wire
    all six generated service drop-ins through the wrapper. Re-running the
    installer MUST remain idempotent.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| Service result | Scheduled command status plus health-persistence status |
| Inbox scheduled-jobs rail | Six validated health files in fixed job order |
| Contention signal | `lastWaitMs` on the latest completed attempt |
| Recovery history | Retained latest success and latest failure per job |

## References

- Rationale:
  [ADR-0079](../adr/0079-serialize-scheduled-jobs-and-publish-host-health.md)
- Context:
  [operating the work queue](../design/queue-operations.md) and
  [operator surface](../design/operator-surface.md)
- Delivery: [recovery plan](../plans/recover.md) Phase 6
