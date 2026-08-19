# Spec: Control-plane kernel

This contract governs initialization, validation, typed Core snapshot storage,
and the first rebuildable read models of the clean target SQLite database. It
is consumed only by internal Snowcat code and host-local diagnostics; it exposes
no generic record-writing, fact-writing, administrative, or worker interface.

## Interface

### Database selection and identity

| Item | Value | Constraint |
| --- | --- | --- |
| Environment variable | `SNOWCAT_CONTROL_DB` | Optional; target database path |
| Default path | `./data/control-plane.db` | Distinct from the queue-spike default |
| SQLite application ID | `1179405908` | Decimal encoding of `FLNT` |
| Schema version | `8` | Stored in both `PRAGMA user_version` and metadata |
| Registry version | `18` | Stored in metadata and both initialization payloads |
| Node runtime | `>=24.0.0` | Required for the stable `node:sqlite` surface and online backup API |
| Database lineage ID | UUIDv7 | Generated once by the server; never reused or inferred from path |
| Operator principal ID | UUIDv7 | Generated once and stored separately from database, session, worker, or provider identity |

`ControlPlaneStore.metadata()` returns application, schema, registry, database
lineage, operator principal, creation time, control-time watermark, and last
transaction sequence.
`ControlPlaneStore.occurrences()` returns occurrences ordered by transaction
sequence and position. Neither method mutates the database or returns a secret.

### Closed registry version 18

| Registry | Name | Version or ID rule | Contract |
| --- | --- | --- | --- |
| Subject | `control-plane-database` | UUIDv7 | Snowcat authority; accepts `sha256` and `transaction-sequence` revisions |
| Subject | `operator-principal` | UUIDv7 | Snowcat authority; accepts `sha256` revision |
| Subject | `core-snapshot` | UUIDv7 | Snowcat authority; accepts `core-catalog-sha256` revision |
| Subject | `github-repository` | `github.com:<repository-id>` | GitHub authority; accepts exact Core-declaration, metadata, surface, Git-commit, rules, branch-transition, checkpoint, source-gap, and installation-reconciliation revisions |
| Subject | `github-app-hook` | `github.com:app:<app-id>:hook` | GitHub authority; one App webhook bound to direct-delivery and delivery-audit revisions |
| Subject | `github-pull-request` | `github.com:<repository-id>:pull:<number>` | GitHub authority; immutable repository identity plus positive pull-request number |
| Subject | `github-check-run` | `github.com:<repository-id>:check-run:<check-run-id>` | GitHub authority; immutable repository identity plus positive check-run ID |
| Subject | `github-commit-status` | `github.com:<repository-id>:commit-status:<status-id>` | GitHub authority; immutable repository identity plus positive commit-status ID |
| Revision | `sha256` | `sha256:` plus 64 lowercase hexadecimal characters | Exact payload digest |
| Revision | `transaction-sequence` | Positive safe integer encoded as canonical decimal | Exact database state checked through that sequence |
| Revision | `core-catalog-sha256` | `sha256:` plus 64 lowercase hexadecimal characters | Exact retained Core catalog |
| Revision | `git-commit-sha1` | `sha1:` plus 40 lowercase hexadecimal characters | Exact Git source commit |
| Revision | `core-declaration-sha256` | `sha256:` plus 64 lowercase hexadecimal characters | Exact active repository declaration bytes |
| Revision | `github-metadata-sha256` | `sha256:` plus 64 lowercase hexadecimal characters | Exact bounded selected GitHub metadata result |
| Revision | `repository-surfaces-sha256` | `sha256:` plus 64 lowercase hexadecimal characters | Exact bounded canonical-surface probe |
| Revisions | `github-webhook-body-sha256`, `github-delivery-audit-sha256` | `sha256:` plus 64 lowercase hexadecimal characters | Exact direct-delivery bytes or canonical selected delivery-API response; the acquisition paths are not interchangeable |
| Revisions | `github-rules-sha256`, `github-pull-request-sha256`, `github-branch-transition-sha256`, `github-check-run-sha256`, `github-commit-status-sha256` | `sha256:` plus 64 lowercase hexadecimal characters | Exact canonical allowlisted source representation for the named GitHub subject or repository transition |
| Revisions | `github-source-checkpoint-sha256`, `github-source-gap-sha256` | `sha256:` plus 64 lowercase hexadecimal characters | Exact canonical checkpoint or gap observation contract input |
| Revisions | `github-installation-response-sha256`, `github-installation-reconciliation-sha256` | `sha256:` plus 64 lowercase hexadecimal characters | Exact bounded GitHub response or canonical installation reconciliation input; unavailable acquisition has no source revision |
| Source | `fluent-system` | Source ID `kernel` or `github-observer` | Internal deterministic bootstrap or GitHub reconciliation source; accepts no caller-selected source revision |
| Source | `github-repository` | `github.com:` plus immutable positive numeric repository ID | Source revision must be `git-commit-sha1` |
| Source | `operator-principal` | UUIDv7 matching a stored operator subject | Human authority source; accepts no source revision |
| Source | `github-api` | Only source ID `api.github.com` | Bounded selected GitHub API acquisition; accepts only registered API-obtainable metadata, delivery-audit, installation-response, rules, pull-request, transition, check-run, and commit-status revisions—not controller checkpoint, gap, or unavailable-result digests |
| Source | `github-app-webhook` | Exact `github-app-hook` subject ID | Direct authenticated delivery acquisition; accepts only `github-webhook-body-sha256` |
| Record | `control-plane.database-definition` | Schema 1 | Class `definition`; subject `control-plane-database`; minimum class `organization` |
| Record | `principal.definition` | Schema 1 | Class `definition`; subject `operator-principal`; minimum class `organization` |
| Record | `control-plane.integrity-observation` | Schema 1 | Class `observation`; subject `control-plane-database`; minimum class `organization` |
| Record | `core.snapshot-definition` | Schema 1 | Class `definition`; subject `core-snapshot`; minimum class `organization` |
| Record | `core.snapshot-active` | Schema 1 | Class `fact`; subject `control-plane-database`; minimum class `organization` |
| Record | `core.candidate-rejection-observation` | Schema 1 | Class `observation`; subject `control-plane-database`; minimum class `organization` |
| Record | `core.source-check-eligible-observation` | Schema 1 | Class `observation`; subject `control-plane-database`; minimum class `organization` |
| Record | `core.stale-source-override-decision` | Schema 1 | Class `decision`; subject `control-plane-database`; minimum class `organization` |
| Record | `core.check-detail-prune-observation` | Schema 1 | Class `observation`; subject `control-plane-database`; minimum class `organization` |
| Record | `core.rollback-decision` | Schema 1 | Class `decision`; subject `control-plane-database`; minimum class `organization` |
| Record | `repository.declaration-definition` | Schema 1 | Class `definition`; subject `github-repository`; exact active Core declaration |
| Record | `repository.core-authorized` | Schema 1 | Class `fact`; subject `github-repository`; active-snapshot precedence |
| Record | `repository.github-identity-observation` | Schema 1 | Class `observation`; subject `github-repository`; bounded selected GitHub result |
| Record | `repository.github-identity-reconciled` | Schema 1 | Class `fact`; subject `github-repository`; bound to one Core authorization fact |
| Record | `repository.canonical-surface-observation` | Schema 1 | Class `observation`; subject `github-repository`; bounded exact-commit surface result |
| Record | `repository.enrollment-checkpoint-policy-decision` | Schema 1 | Class `decision`; subject `github-repository`; explicit permit or deny with requirement results |
| Record | `repository.canonical-surfaces-reconciled` | Schema 1 | Class `fact`; subject `github-repository`; bound to one identity fact |
| Record | `repository.controller-definition` | Schema 1 | Class `definition`; subject `github-repository`; exact enrollment prerequisites and scope |
| Record | `repository.enrolled` | Schema 1 | Class `fact`; subject `github-repository`; active-prerequisite precedence |
| Record | `repository.operator-hold-decision` | Schema 1 | Class `decision`; subject `github-repository`; resolved impose or exact clear |
| Record | `github.delivery-receipt-observation` | Schema 1 | Class `observation`; subject `github-app-hook`; verified body provenance and bounded disposition |
| Record | `github.delivery-audit-observation` | Schema 1 | Class `observation`; subject `github-app-hook`; API delivery identity, response provenance, and absence of a prior direct receipt |
| Record | `github.pull-request-observation` | Schema 2 | Class `observation`; subject `github-pull-request`; allowlisted same-repository state and revisions with direct-webhook or API-repair acquisition provenance |
| Record | `github.source-checkpoint-observation` | Schema 1 | Class `observation`; subject `github-repository`; complete bounded audit boundary for one registered scope |
| Record | `github.source-gap-observation` | Schema 3 | Class `observation`; subject `github-repository`; open interval lower-bounded by the latest checkpoint, with explicit interval or delivery-content failure kind |
| Record | `github.source-gap-repair-observation` | Schema 3 | Class `observation`; subject `github-repository`; terminal complete-audit repair, with exact API-audit citations for delivery-content gaps |
| Records | `github.installation-repository-observation` / `github.installation-repository-reconciled` | Schema 1 | Classes `observation` / `fact`; subject `github-repository`; App installation access reconciliation without changing enrollment |
| Event | `control-plane.initialized` | Schema 1 | Subject `control-plane-database`; minimum class `organization` |
| Event | `control-plane.integrity-checked` | Schema 1 | Subject `control-plane-database`; minimum class `organization` |
| Event | `core.snapshot-activated` | Schema 1 | Subject `core-snapshot`; minimum class `organization` |
| Event | `core.candidate-rejected` | Schema 1 | Subject `control-plane-database`; minimum class `organization` |
| Event | `core.source-check-eligible` | Schema 1 | Subject `control-plane-database`; minimum class `organization` |
| Event | `core.stale-source-override-issued` | Schema 1 | Subject `control-plane-database`; minimum class `organization` |
| Event | `core.check-detail-pruned` | Schema 1 | Subject `control-plane-database`; minimum class `organization` |
| Event | `core.snapshot-rollback-activated` | Schema 1 | Subject `core-snapshot`; minimum class `organization` |
| Event | `repository.core-authority-reconciled` | Schema 1 | Subject `github-repository`; declaration authority materialized |
| Event | `repository.github-identity-reconciliation-recorded` | Schema 1 | Subject `github-repository`; bounded identity outcome recorded |
| Event | `repository.canonical-surfaces-reconciliation-recorded` | Schema 1 | Subject `github-repository`; bounded surface outcome recorded |
| Event | `repository.enrollment-established` | Schema 1 | Subject `github-repository`; exact enrollment established |
| Event | `repository.operator-hold-imposed` / `repository.operator-hold-cleared` | Schema 1 | Subject `github-repository`; attributed local intervention transition |
| Event | `github.delivery-recorded` | Schema 1 | Subject `github-app-hook`; causally linked receipt disposition |
| Event | `github.delivery-repair-recorded` | Schema 1 | Subject `github-app-hook`; causally linked API repair disposition |
| Event | `github.source-checkpoint-recorded` | Schema 1 | Subject `github-repository`; checkpoint accepted |
| Event | `github.source-gap-opened` | Schema 3 | Subject `github-repository`; lower-bounded gap opened |
| Event | `github.source-gap-repaired` | Schema 3 | Subject `github-repository`; exact evidence-bound repair accepted |
| Event | `github.installation-repository-reconciliation-recorded` | Schema 1 | Subject `github-repository`; installation access outcome durably recorded |
| Command | `control-plane.initialize` | Schema 1 | Outputs database definition, principal definition, then initialization event |
| Command | `control-plane.check-integrity` | Schema 1 | Outputs the integrity observation, then integrity-checked event |
| Command | `core.activate-snapshot` | Schema 1 | Outputs snapshot definition, active fact, then activation event |
| Command | `core.record-candidate-rejection` | Schema 1 | Outputs rejection observation, then rejection event |
| Command | `core.record-source-check-eligible` | Schema 1 | Outputs eligible-check observation, then eligible-check event |
| Command | `core.issue-stale-source-override` | Schema 1 | Outputs resolved operator decision, then causally linked event |
| Command | `core.prune-check-detail` | Schema 1 | Outputs prune observation, then prune event after atomic bounded deletion and projection rebuild |
| Command | `core.rollback-snapshot` | Schema 1 | Outputs resolved decision, snapshot definition, active fact, then rollback event |
| Command | `repository.materialize-core-authority` | Schema 1 | Outputs declaration definition, Core authorization fact, then event |
| Command | `repository.record-github-identity` | Schema 1 | Outputs GitHub observation, identity-reconciliation fact, then event |
| Command | `repository.record-canonical-surfaces` | Schema 1 | Outputs observation, policy decision, fact, then event |
| Command | `repository.establish-enrollment` | Schema 1 | Outputs controller definition, enrollment fact, then event |
| Command | `repository.impose-operator-hold` / `repository.clear-operator-hold` | Schema 1 | Each outputs one resolved operator decision, then event |
| Command | `github.record-pull-request-delivery` | Schema 1 | Outputs receipt observation, pull-request observation, then delivery event |
| Command | `github.record-pull-request-delivery-repair` | Schema 1 | Outputs delivery-audit observation, pull-request observation, then repair event |
| Command | `github.record-source-checkpoint` | Schema 1 | Outputs checkpoint observation, then event |
| Command | `github.open-source-gap` | Schema 3 | Outputs open-gap observation, then event |
| Command | `github.repair-source-gap` | Schema 3 | Outputs successor checkpoint, terminal repair observation, then event |
| Command | `github.record-installation-reconciliation` | Schema 1 | Outputs installation observation, reconciliation fact, then event |
| Predicate | `core.snapshot-active` | Contract 1 | Established by automatic activation or operator rollback; latest transaction sequence wins |
| Predicate | `repository.core-authorized` | Contract 1 | Established only from an active retained Core declaration |
| Predicate | `repository.github-identity-reconciled` | Contract 1 | Established only from bounded GitHub metadata and bound Core authority |
| Predicate | `repository.canonical-surfaces-reconciled` | Contract 1 | Established only from bounded exact-commit evidence and bound identity |
| Predicate | `repository.enrolled` | Contract 1 | Established only from current active prerequisite facts |
| Predicate | `github.installation-repository-reconciled` | Contract 1 | Latest App/repository access outcome; only `active` is healthy for GitHub observation |
| Projection | `control-plane.subject-lookup` | Contract and transformation version 2; information-handling version 1 | Stable subjects and their first durable creation records for internal diagnostics |
| Projection | `control-plane.event-cursor` | Contract, transformation, and information-handling version 1 | Payload-free event cursor for internal diagnostics and ProcessObserver |

The two registered payloads have the same exact shape; additional keys are
invalid:

```json
{
  "databaseLineageId": "0198b0a6-c200-7abc-8def-0123456789ab",
  "operatorPrincipalId": "0198b0a6-c200-7abc-8def-0123456789ac",
  "registryVersion": 18,
  "schemaVersion": 8
}
```

The example UUID illustrates the encoding only. Runtime values are generated by
the server.

The operator definition payload is exactly:

```json
{
  "binding": "local-stdio-implicit",
  "principalKind": "operator"
}
```

The integrity observation and event payload have this exact shape:

```json
{
  "checkedThroughSequence": 1,
  "databaseLineageId": "0198b0a6-c200-7abc-8def-0123456789ab",
  "registryVersion": 18,
  "result": "ok",
  "schemaVersion": 8
}
```

### Integrity command

`ControlPlaneStore.checkIntegrity(input)` accepts:

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `expectedLastTransactionSequence` | integer | yes | Positive safe integer; optimistic binding to pre-command state |
| `idempotencyKey` | string | yes | 1–128 ASCII letters, digits, `.`, `_`, `:`, or `-`; first character alphanumeric |

An accepted result contains `result: "ok"`, the checked-through sequence,
observation and event UUIDv7 record IDs, transaction sequence, fixed positions
`[0, 1]`, and its evaluation and recorded UTC time. Equivalent replay returns
the exact stored result. A key already bound to another input digest fails.

### Core snapshot commands

`ControlPlaneStore.activateCoreSnapshot(input)` is the only implemented fact-
establishment path. It accepts a verified materialized candidate, the exact
positive current sequence expected by the caller, and after initial activation
the exact active commit whose Git ancestry the source adapter verified. Its source, payloads, ordered
outputs, retained catalog, idempotency, pointer, integrity, and excluded
behavior are specified by
[Core snapshot activation](core-snapshot-activation.md). No other predicate or
caller-selected fact kind is writable.

`recordCoreCandidateRejection(input)` accepts one server UUIDv7 check identity,
the registered source/validation/continuity/persistence stage and matching code, bounded
sanitized diagnostic text, configured source URL/ref, and the commit/tree/
catalog identities available at that stage. It atomically writes an observation,
event, receipt, transaction, and metadata watermarks. It accepts no authority
expectation because it observes a rejected candidate rather than mutating the
active predicate. `coreCandidateRejections(limit)` returns newest observations
only, with a limit from 1 through 100. Exact payload constraints live in
[Core snapshot activation](core-snapshot-activation.md).

`rollbackCoreSnapshot(input)` accepts a completely materialized target
candidate, exact positive pre-command sequence, and bounded operator reason. It
atomically creates the registered resolved decision plus a new snapshot,
active fact, rollback event, receipt, and pointer. `retainedCoreCandidate(commit)`
provides independently revalidated retained bytes for outage recovery; a target
not already retained is materialized through the exact-commit Git source path.

### Verified pull-request delivery command

`verifyAndNormalizeGitHubPullRequestWebhook(request)` is the implemented
pre-transaction trust boundary. It accepts one configured positive App ID, a
32–1024-byte secret, lowercase delivery GUID, event and content-type headers,
`sha256=<lowercase-hex>` signature, and exact raw bytes. The body is non-empty
and at most 25 MiB. The verifier authenticates those exact bytes with
HMAC-SHA-256 and constant-time digest comparison before event dispatch or JSON
parsing. It then requires `pull_request`, one registered action, safe positive
numeric GitHub IDs, canonical UTC source times, and the selected repository,
sender, base, head, state, draft, merge, and revision fields. It rejects fork
heads and inconsistent action/state/merge shapes. The result contains only the
typed command input; all other GitHub fields are discarded. Configuration,
headers, authentication, body bounds, unsupported event/action/shape, and
malformed payloads have closed non-source-derived failure codes.

`createGitHubWebhookIngress(options)` exposes that boundary as an injectable
Hono router with only `POST /`; other methods return `405` and `Allow: POST`.
It rejects an invalid or oversized declared length before reading, otherwise
streams the raw body into bounded chunks and cancels once the 25 MiB limit is
crossed. Successful authentication, normalization, and durable acceptance
returns only `202 {"status":"accepted"}`. Authentication is `401`, invalid
headers or payload are `400`, oversized input is `413`, unsupported registered
scope is `422`, delivery or enrollment conflict is `409`, and configuration,
clock, or unknown persistence failure is a detail-free `503`. No response
contains source payload, database path, record IDs, or internal exception text.
The router is dependency-injected and not mounted by the default app in this
slice.

`ControlPlaneStore.recordVerifiedGitHubPullRequestDelivery(input)` is an internal typed
acceptance boundary for a caller that has already verified an exact GitHub App
webhook body. It is not an HTTP or signature-verification endpoint. Its input is
an exact object containing App ID, lowercase delivery GUID, `sha256:` body
digest, positive request-byte count capped at 25 MiB, installation and immutable
repository IDs, one registered pull-request action, and an exact selected
pull-request object. The selected object contains only number, actor ID,
open/closed state, draft/merged flags, same-repository base and head identities,
branch names, typed commit revisions, optional observed test-merge revision,
merge identity and time, and source update time. Free-form title, body, review,
commit-message, diff, log, and annotation content is neither accepted nor
retained.

The repository MUST already have a retained `repository.enrolled` fact. Paused,
disabled, and locally held repositories remain observable because those states
block work gates, not source intake. Fork heads and merge queues are unsupported
by this first command. An open pull request cannot be merged; a closed merged
pull request requires merge time and resulting commit and cannot retain a
pre-merge test revision; a closed unmerged pull request has neither merge field.

An accepted command creates the App-hook and pull-request subjects when absent,
then atomically emits `github.delivery-receipt-observation` at position `0`,
`github.pull-request-observation` at position `1`, and
`github.delivery-recorded` at position `2`. The receipt binds the exact body
digest; the pull-request observation binds a separately derived digest over the
allowlisted selected representation, records acquisition `direct-webhook`, and
cites the receipt through its generic acquisition record and causation; the
event cites the same receipt. All use one server time, correlation ID,
deployment scope, and organization information class. The idempotency key is
`github-delivery:<app-id>:<delivery-guid>` and its receipt expires exactly 30
days after acceptance. Exact replay returns the original result before current
enrollment is reevaluated; reuse of the GUID with different verified content
fails closed.

Startup re-derives the selected-observation and command-input digests and checks
the prior enrollment, subjects, revisions, sources, causal links, output order,
result, and retention deadline. The bounded router can connect the pure
verifier to this command when explicitly mounted with a lifecycle-owned store,
but the default app does not mount it. This slice does not implement production
listener/configuration lifecycle, automatic repository application/gap
creation, or durable-detail pruning. The App-wide operational acquisition
schedule is implemented separately; typed delivery-audit checkpoint, gap, and
repair commands are specified below, but that controller does not invoke them
yet.

### App delivery-list acquisition

`auditGitHubAppDeliveries(input)` performs the implemented read-only,
transport-side enumeration for the App-wide audit. It uses only
`GET /app/hook/deliveries?per_page=100`, identifies as the configured App with
a fresh caller-supplied JWT for every request, and pins the shared GitHub REST
media type, user agent, origin, and API version `2026-03-10` in one code
contract. App JWTs and response bodies never enter the returned result or
durable store.

The acquisition follows only the API's `rel="next"` cursor URL. Every URL MUST
remain on `api.github.com`, retain the exact delivery-list path and
`per_page=100`, contain only `cursor` and `per_page` query keys, and occur once
in a run. The run is serial and bounded to 100 completed pages, 10,000 listed
deliveries, 1 MiB per response, one same-origin redirect, and 30 seconds per
request. A continuing cursor at the page bound is incomplete, not success.

One complete result contains a server-captured upper boundary, exact-response
page-proof digest, completed page and listed-delivery counts, and only
allowlisted pull-request delivery summaries. Irrelevant event bodies are not
normalized or returned. A repository selection filters by immutable repository
and installation IDs and derives its own selected-response digest. A registered
pull-request action is marked supported; an unknown bounded action remains
identifiable so the controller can open an `unsupported-relevant-delivery` gap.

Network/authentication/status failure yields `source-unavailable`; malformed
JSON or relevant fields yields `normalization-failed`; unsafe, repeated, or
malformed pagination yields `pagination-incomplete`; and a response or page
budget breach yields `request-budget-exhausted`. The result retains only a
closed diagnostic code. For a rate-limited response it returns the later valid
time from `Retry-After` and a zero-remaining `X-RateLimit-Reset`; the future
controller MUST still compare that with its ordinary retry schedule. No
incomplete result contains summaries or can establish a checkpoint.

`fetchGitHubPullRequestDeliveryDetail(input)` implements the separate bounded
read of one supported selected delivery. It permits only
`GET /app/hook/deliveries/<delivery-id>`, the same App-JWT and one-redirect
rules, 30 seconds, and a 25 MiB response. Exact list/detail metadata MUST match.
It reuses the same allowlisted pull-request normalizer as webhook ingress,
requires payload action, repository, and installation identities to match the
list summary, hashes the exact API response bytes, and returns only a typed
repair input. Unknown registered-scope actions are reported without making the
detail request. Raw request payload, response payload, headers, title, body,
and other free-form content are discarded.

`recordAuditedGitHubPullRequestDelivery(input)` is the corresponding typed
control-plane command. It requires exact optimistic sequence and prior
repository enrollment, and rejects a repair when a direct receipt for the App
and GUID was already observed. It atomically appends
`github.delivery-audit-observation`, schema-2
`github.pull-request-observation`, and `github.delivery-repair-recorded` at
positions `[0,1,2]`. The audit observation is on the App-hook subject; both
records use source `github-api` / `api.github.com` and the exact
`github-delivery-audit-sha256` response revision. The pull-request observation
records acquisition `delivery-api-repair` and cites the audit observation; no
webhook receipt or body digest is manufactured.

The command is idempotent on App ID plus delivery ID for 30 days. Startup
re-derives its command and normalized-observation digests; verifies enrollment,
absence of an earlier direct receipt, source/revision, subject, output order,
causation, correlation, result, and retention; and fails closed on tampering.
A later direct webhook may still be retained as its own source occurrence.
This command records repair evidence but does not by itself close a source gap
or establish a checkpoint.

### Observer installation acquisition

`inspectGitHubRepositoryInstallation(input)` performs the implemented read-only
source acquisition for one configured App and already known immutable
repository. It calls only
`GET /repos/<owner>/<repository>/installation` with a fresh App JWT, the pinned
GitHub media type, user agent, and API version. It permits one same-origin
redirect whose path is still a repository-installation endpoint, rejects a
second or unsafe redirect, and bounds the request to 30 seconds and the body to
1 MiB.

A `200` response must contain a positive installation ID, the exact configured
App ID, Organization or User target type, `all` or `selected` repository
selection, nullable suspension time, and the exact v1 permission/event profile.
Only metadata, contents, pull requests, checks, commit statuses, and
administration at `read` are accepted, with only the subscribed events listed
in the GitHub observation design. Extra or write permission and a missing or
extra event produce `permission-mismatch`; suspension produces `suspended`.
`404` is `not-installed`; all other status, authentication, transport, bound,
or normalization failures are `unavailable`.

The result retains no JWT, token, raw response, account object, permission map,
or event array. An observed result contains only App, installation, repository,
target type, repository selection, access classification, exact-response
digest, and server observation time.

`recordGitHubInstallationReconciliation(input)` persists that typed result only
for an already enrolled immutable repository and exact optimistic sequence. It
atomically appends observation, reconciliation fact, and event at positions
`[0,1,2]`, causally rooted in the latest enrollment. Source-backed observed and
`not-installed` outcomes retain source `github-api` and the exact response
revision; `unavailable` uses `fluent-system/github-observer` with no invented
GitHub revision. Replay is bound to the complete inspection for 30 days.
Startup re-derives command and inspection digests and verifies enrollment,
source distinction, output order, causation, result, and retention. No outcome
changes enrollment; only `active` is eligible input to the delivery-audit
controller's future per-repository application step.
`githubInstallationReconciliation(repositoryId, appId)` is a
read-only lookup of the latest validated outcome for that exact pair.

### App delivery-audit operational controller

Schema v8 adds the singleton `github_delivery_audit_state` for the App-wide
half of the GitHub reconciliation controller. The first claim binds one
positive numeric App ID for the database lineage. A different App cannot reuse
the schedule. Healthy cadence defaults to 300 seconds and accepts only 60–900
seconds. `claimGitHubDeliveryAudit(appId, interval)` claims one UUIDv7 run for a
fixed 600 seconds, reports an unexpired owner without overlap, and recovers an
expired lease. Claiming and completion are short SQLite transactions; the
bounded GitHub list request runs between them with no SQLite writer held.

`completeGitHubDeliveryAudit(input)` distinguishes operational run status from
source acquisition outcome. `completed` requires exactly one outcome:
`complete`, `source-unavailable`, `pagination-incomplete`,
`request-budget-exhausted`, `unsupported-relevant-delivery`, or
`normalization-failed`. `controller-error` carries no invented source outcome.
The transient claimed-run result includes a control-character-normalized,
secret-redacted controller diagnostic bounded to 512 UTF-8 bytes; the durable
singleton stores only `controller-error`, never that diagnostic text.
Only `complete` advances the retained App acquisition boundary. Any other
completion retries after 1, then 5, then 15 minutes; a later exact GitHub
`Retry-After` or rate-limit reset wins. A complete result resets the streak and
schedules from completion. Startup validates App identity, canonical times,
lease duration, outcome/status linkage, boundary linkage, and monotonic
counters.

`runGitHubDeliveryAuditOnce` joins the claim, the bounded App delivery-list
client, and completion bookkeeping. Its operational boundary is not a
repository source checkpoint and cannot establish or close coverage. Automatic
selection, missing-receipt repair, checkpoint/gap submission, production App
credential loading, and process lifecycle remain later controller work.

### Pull-request-delivery coverage commands

Registry v18 fixes one coverage scope:
`github.pull-request-deliveries:v1`. These commands accept bounded results from
a deterministic delivery-audit controller after network acquisition; they do
not call GitHub or independently prove caller-supplied pagination digests.
Every command requires a currently enrolled immutable repository, exact
optimistic pre-command sequence, UUIDv7 run ID, configured App and installation
IDs, organization information class, deployment scope, and the
`fluent-system/github-observer` source with no source revision.

`recordGitHubSourceCheckpoint(input)` accepts canonical UTC `coveredFrom` and
`coveredThrough`, 1–100 completed pages, 0–10,000 selected deliveries, and
SHA-256 page-proof and selected-response digests. The first checkpoint MUST
have equal boundaries: it establishes a point from which future continuity can
be judged and does not claim retrospective coverage. A successor MUST begin
exactly at the latest checkpoint's upper boundary and retain the same App and
installation. It is rejected while a source gap is open.

`openGitHubSourceGap(input)` requires the exact latest checkpoint and one cause
from `delivery-audit-incomplete`, `source-unavailable`,
`pagination-incomplete`, `request-budget-exhausted`,
`unsupported-relevant-delivery`, `normalization-failed`, or
`recovery-horizon-expired`. Without a checkpoint, the baseline is unavailable
and no gap is written. The immutable gap uses its observation record ID as
`gapId`, begins at the checkpoint upper boundary, has a null upper bound, and
prevents a second open gap for the same v1 scope.
The command classifies the missing evidence independently from its cause.
`coverageFailureKind=interval-coverage` requires an empty affected-delivery set;
`delivery-content` requires 1–100 sorted unique affected delivery GUIDs. This
distinction matters because source unavailability, request-budget exhaustion,
or normalization failure can occur at either App-list or known-delivery detail
scope. Unsupported relevant deliveries require `delivery-content`; incomplete
audit, pagination, and expired-horizon causes require `interval-coverage`.
A malformed acquisition that cannot be attributed to a repository uses
the future App-wide controller boundary rather than inventing a repository gap.

`repairGitHubSourceGap(input)` requires that exact current open gap and a
complete audit ending strictly after its lower bound. It atomically emits a
successor checkpoint covering from the gap lower bound through the supplied
exclusive end, a terminal repair observation, and an event. It never edits or
deletes the original gap. After repair, ordinary checkpoint continuity resumes
from the new checkpoint. Interval-only causes require method
`complete-delivery-audit` and no delivery-audit citations. Content causes
require `delivery-observations-and-complete-audit`: the command accepts 1–100
sorted unique `repairAuditRecordIds`, requires their API repair transactions to
occur after the gap and before closure, and requires their repository, App,
installation, and delivery-GUID set to match the gap exactly. A complete audit
is still mandatory; repaired content alone cannot establish interval
continuity.

All three commands assign one server evaluation/recorded time, have exact run-
ID idempotency, and retain replay receipts for 30 days. Startup re-derives
checkpoint, gap, repair, and command-input digests; verifies output order,
causation, prior enrollment, App/installation continuity, boundary continuity,
single-open-gap behavior, exact content-repair audit identity and transaction
order, and terminal repair uniqueness; and fails closed on tampering. Latest
checkpoints and compact gap/repair history are intended to be protected by the
unimplemented GitHub retention command.

### Projection interface

Initialization publishes one immutable generation for each registered
projection at source sequence `1`. `ControlPlaneStore.rebuildProjections()`
builds shadow generations through the current authoritative transaction
sequence, validates their digests and invariants, and atomically activates both
heads. It allocates no control transaction, record, event, or authority fact.
`repairProjections()` explicitly discards all disposable generations and
reconstructs both projections from retained source records.

Every generation stores its registered projection name, server-generated
UUIDv7 identity, contract/transformation/information-handling versions, source
sequence and digest, output digest, row count, invariant result `ok`, and one
explicit canonical UTC evaluation/build instant.

`projectionHealth()` reports each active head as `current`, `stale`,
`unavailable`, or `invalid`, including source/current sequence and lag.
`projectedSubjects(access)` and `projectedEvents(access, after, limit)` require
an internal access context containing a maximum information class and explicit
deployment IDs. They filter before returning rows and join each candidate back
to its current authoritative definition or event. The event cursor is the pair
`(transactionSequence, transactionPosition)` and `limit` is 1–1000.

Subject rows contain subject kind and ID, creation sequence, creation-record
ID, and current information class/scope. The creation record is the earliest
durable record for that subject in its creation transaction; source-native
subjects may therefore be introduced by an observation rather than being
misclassified as Snowcat definitions. Event rows contain event record
ID, kind/version, subject, correlation ID, current information class/scope,
transaction coordinates, and recorded time. Event payloads and payload digests
are deliberately absent from the cursor projection.

### Backup and restore staging

`await ControlPlaneStore.createBackup(path)` uses SQLite's online backup API
through a dedicated read-only source connection for filesystem databases. The
destination is create-only: it must differ from the live database and queue-
spike paths and must not exist. The completed artifact is reopened through the
normal target validator, passes `PRAGMA quick_check`, has usable projection
heads, and must still match the live authoritative digest and sequence before a
manifest is returned.

The manifest has this exact shape:

| Field | Constraint |
| --- | --- |
| `formatVersion` | Literal `1` |
| `backupPath` | Absolute filesystem path to the created artifact |
| `databaseLineageId` | Preserved target UUIDv7 lineage |
| `schemaVersion`, `registryVersion` | Exact supported versions |
| `lastTransactionSequence` | Highest durable source transaction in the artifact |
| `nextTransactionSequence` | Exactly `lastTransactionSequence + 1` |
| `controlTimeWatermark` | Preserved canonical UTC watermark |
| `authoritativeDigest` | SHA-256 over canonical rows from metadata, transactions, subjects, occurrences, record/event subtypes, receipts, Core snapshot metadata/file identities/parsed records, active pointer, Core poll operational state, and SQLite's transaction allocation; raw bytes are transitively bound by startup-verified file digests and projections are excluded |
| `createdAt` | Server UTC time at which backup creation began; not a control transaction time |

`ControlPlaneStore.verifyBackup(manifest, expectation)` requires the caller's
expected database lineage and highest transaction sequence previously visible
for that lineage. It reopens and validates the artifact, compares every manifest
content field, and refuses an artifact below the supplied sequence fence.

`await ControlPlaneStore.stageRestore(manifest, targetPath, expectation)` first
performs that verification, copies the backup through SQLite into a new
nonexistent target path, and validates the staged artifact again. It never
overwrites or switches the live database. Activation remains an operator
procedure after the live store is closed.

### Local operator CLI

`npm run --silent control -- <command>` is a host-local JSON interface over only the
kernel operations above:

| Command | Effect |
| --- | --- |
| `metadata` | Prints target metadata plus the authoritative digest |
| `check-integrity <expected-sequence> <idempotency-key>` | Executes the registered integrity command |
| `projection-health` | Prints current/stale/unavailable/invalid state for each registered projection |
| `rebuild-projections` | Builds and atomically publishes ordinary shadow generations |
| `repair-projections` | Opens through the narrow projection-repair validation path, discards disposable generations, and rebuilds them |
| `backup <new-backup.db>` | Creates a verified backup and prints its manifest JSON |
| `verify-backup <manifest.json> <lineage-id> <minimum-sequence>` | Validates a saved manifest and artifact without opening the configured live database |
| `stage-restore <manifest.json> <new-target.db> <lineage-id> <minimum-sequence>` | Verifies and stages a create-only restore without opening or replacing the configured live database |

Every successful command prints exactly one JSON value to stdout. Usage and
failure messages go to stderr with a nonzero exit status. The CLI is local
operator tooling, not an authenticated remote API or worker surface. Projection
rebuild/repair and backup staging remain non-authoritative operations; invoking
the integrity check does not change its registered `fluent-system/kernel`
source identity.

### Tables

| Table | Purpose | Primary invariants |
| --- | --- | --- |
| `control_plane_metadata` | One row describing the target lineage | Singleton key `1`; application/schema/registry versions; UUIDv7 lineage; persisted time and sequence watermarks |
| `control_transactions` | Accepted command transactions | Monotonic `AUTOINCREMENT` sequence; unique UUIDv7 transaction ID; command, principal/source, optional session/idempotency, digest, evaluation and recorded time |
| `subjects` | Stable typed subjects | Composite key `(subject_kind, subject_id)`; creation transaction reference |
| `durable_occurrences` | Common record/event envelope | Unique UUIDv7 record ID; record/event subtype; registered kind/version/subject/source; typed revisions; class/scope; canonical payload/digest; causal fields; unique `(transaction_sequence, transaction_position)` |
| `durable_records` | Record subtype | Exactly one accepted non-event record class for each referenced occurrence |
| `event_ledger` | Event subtype | Event occurrence reference; no record class |
| `idempotency_receipts` | Registered command replay results | Composite command-scope key; payload digest, canonical retained result, transaction reference, and retention deadline |
| `core_snapshots` | Retained snapshot lineage | Snapshot/source/catalog identities and definition/fact/event/transaction references |
| `core_snapshot_files` | Exact snapshot contents | Path, mode, Git object, size, content digest, optional canonical parsed live declaration, and raw bytes |
| `core_active_snapshot` | Checked current-authority pointer | Singleton reference to the latest snapshot activation fact and transaction |
| `core_poll_state` | CoreSourceController operational state | Singleton schedule v1; bounded healthy interval; due/prune times; outage streak; one expiring lease; last completion and monotonic counters |
| `github_delivery_audit_state` | App-wide GitHub delivery-audit operational state | Singleton schedule v1; one bound App; 1–15 minute healthy cadence; fixed ten-minute lease; bounded incomplete retry; last complete acquisition boundary and completion counters |
| `projection_generations` | Immutable read-model build metadata | Registered versions, source/output digests, source watermark, evaluation/build time, row count, and invariant result |
| `projection_heads` | Active-generation pointers | One head per registered projection; atomically references one validated generation |
| `projection_subject_lookup` | Subject lookup rows | Generation-scoped stable subject and first durable creation-record identity plus information class/scope |
| `projection_event_cursor` | Event cursor rows | Generation-scoped payload-free event metadata ordered by transaction sequence and position |

Record classes are exactly `definition`, `assertion`, `observation`,
`evidence-reference`, `fact`, and `decision`. Information classes are exactly
`public`, `organization`, and `restricted`. Only the kinds listed in the closed
registry are accepted by current kernel code.

### Initialization outputs

The first accepted transaction has sequence `1`, command
`control-plane.initialize` schema `1`, principal/source
`fluent-system` / `kernel`, no session or idempotency key, and one captured UTC
evaluation/recorded time. Its outputs are:

| Position | Subtype | Kind | Class | Information |
| --- | --- | --- | --- | --- |
| `0` | record | `control-plane.database-definition` | `definition` | `organization`, scoped to the database lineage deployment |
| `1` | record | `principal.definition` | `definition` | `organization`, scoped to the database lineage deployment |
| `2` | event | `control-plane.initialized` | none | `organization`, scoped to the database lineage deployment |

Each output has an independent UUIDv7 record identity. Database and principal
subjects remain distinct; the database definition and event share their
database payload and revision. All outputs share correlation, transaction, and
recorded time. Event is not a record class.

An accepted `control-plane.check-integrity` transaction uses the same two output
positions. Its record is `control-plane.integrity-observation` class
`observation`; its event is `control-plane.integrity-checked`. Both use revision
kind `transaction-sequence` and the pre-command sequence as the revision value.

## Rules

1. The store MUST initialize only a SQLite database with application ID `0` and
   no application tables.
2. The target path MUST differ from the resolved queue-spike path. A file with
   spike tables MUST be refused before target schema or application metadata is
   written.
3. Initialization schema, metadata, transaction, subject, outputs, watermarks,
   application ID, and user version MUST commit atomically under
   `BEGIN IMMEDIATE`.
4. A current target database MUST reopen without schema writes or another
   initialization transaction.
5. Older, newer, incomplete, unexpected, or differently identified schemas
   MUST fail closed. Unregistered indexes, triggers, and views are unexpected.
   Schema version 8 and registry version 18 define no upgrade path from earlier
   pre-production target stores.
6. Subject, record, event, command, source, revision, record-class, and
   information-class names MUST come from the code-owned versioned registries.
   Payload validity alone MUST NOT create a kind.
7. Every record and event occurrence MUST have a server-generated UUIDv7 record
   identity independent of subject, transaction, correlation, and idempotency
   identity.
8. The pair `(transaction_sequence, transaction_position)` MUST be unique
   across records and events. UUID or time order MUST NOT substitute for it.
9. Payload and information-scope JSON MUST use deterministic key-sorted compact
   encoding. Payload digest MUST be SHA-256 over those exact UTF-8 payload bytes.
10. The initialization payload MUST have exactly the four documented fields,
    and its subject ID MUST equal its `databaseLineageId`. Its
    `operatorPrincipalId` MUST equal the separately stored operator subject and
    metadata identity.
11. Startup MUST validate the metadata sequence watermark against both the
    maximum stored transaction sequence and SQLite's allocated sequence. Any
    mismatch MUST fail closed.
12. Startup MUST validate persisted registry references, subtype coverage,
    UUIDv7 subject identity, revision syntax, source identity, information
    minimum, payload digest, payload contract, each command's exact ordered
    outputs, and every receipt's transaction and returned-record lineage.
13. A durable record MUST have exactly one `durable_records` subtype and an
    event exactly one `event_ledger` subtype. An event MUST NOT receive a record
    class.
14. Initialization MUST assign one server UTC instant after acquiring the write
    transaction and use it as evaluation time, recorded time, creation time, and
    initial control-time watermark.
15. The target store MUST NOT inspect spike rows, import spike records, attach a
    spike database, or create a legacy establishment path.
16. The store MUST expose no generic record, event, assertion, or fact mutation
    method. Later mutations require registered typed command handlers.
17. The target database, WAL, temporary files, exports, and backups MUST be
    operated as `restricted` assets even when a particular occurrence has a
    lower information class.
18. Initialization MUST create exactly one operator-principal subject with a
    server-generated UUIDv7 and `principal.definition` payload binding it
    implicitly to the local-stdio deployment. It MUST NOT derive that identity
    from an OS name, provider, model, GitHub actor, or caller-supplied worker
    string.
19. Integrity execution MUST first bind an expected current sequence and run
    SQLite `PRAGMA quick_check`. A stale expectation or non-`ok` check MUST
    create no transaction, occurrence, receipt, or watermark change.
20. Equivalent idempotent replay MUST return the original result, identities,
    sequence, positions, and times without evaluating the current clock or
    expected sequence. Reusing its key with a different input digest MUST fail.
21. New command execution MUST fail when evaluation time is earlier than the
    persisted control-time watermark. Version 1 applies zero backward-clock
    tolerance and defines no recovery command.
22. The integrity observation, event, receipt, metadata watermarks, and command
    transaction MUST commit or roll back together. A rolled-back allocation
    MUST leave both the stored maximum and SQLite allocation watermark at their
    prior value.
23. Integrity receipts MUST use command scope `database:<lineage-id>` and the
    explicit retention deadline `9999-12-31T23:59:59.999Z`. Version 1 has no
    purge path, so a key remains bound for the database lineage.
24. Projection names and all three projection versions MUST come from the
    code-owned projection-contract registry. Unknown names or versions MUST
    fail closed; callers cannot supply transformations or SQL.
25. A full rebuild MUST read source rows only through its explicit transaction-
    sequence watermark, compute deterministic source and output digests, write
    immutable shadow rows, verify row count and contract invariants, and change
    active heads only in the same successful SQLite transaction.
26. Projection build, activation, failure, repair, or deletion MUST NOT create,
    edit, or remove a control transaction, subject, durable occurrence,
    idempotency receipt, metadata watermark, or SQLite transaction allocation.
27. Subject lookup MUST derive each subject from exactly one definition in its
    creation transaction. Event cursor MUST derive from `event_ledger` joined
    to the common occurrence envelope and MUST NOT copy event payloads.
28. A stale generation MAY return its bounded older rows with `stale: true` but
    MUST recheck every returned identity, information class, and scope against
    current authoritative rows. It MUST NOT return newer source data by guessing
    or authorize a mutation.
29. Projection reads MUST enforce both maximum information class and exact
    deployment scope before result formation. A lower class ceiling, wrong
    deployment, malformed access context, invalid active generation, or failed
    digest/invariant check MUST disclose no row.
30. `repairProjections()` MUST be an explicit projection-only recovery path.
    Deleting every projection row and rebuilding at the same authoritative
    watermark MUST reproduce the same output digests without changing source
    history or order.
31. Version 1 retains inactive generations for diagnostics during ordinary
    rebuilds. Explicit repair may discard them all; no projection generation is
    a backup, authority snapshot, subject revision, or domain concurrency token.
32. Backup and restore targets MUST be filesystem paths and create-only. Backup
    MUST refuse the live and queue-spike paths; staged restore MUST refuse the
    backup and queue-spike paths. Neither operation may overwrite a file.
33. A backup MUST use SQLite's online backup mechanism, then reopen the artifact
    through current schema/registry validation, run `PRAGMA quick_check`, and
    verify its projection heads before returning success.
34. The authoritative backup digest MUST exclude all disposable projection
    tables and include SQLite's allocated control-transaction sequence. Equal
    digests therefore prove equal target authority and allocation state, not
    physical SQLite byte equality.
35. Backup verification and restore staging MUST require an expected lineage
    and a positive highest previously visible sequence. A different lineage,
    manifest/content mismatch, damaged database, or artifact sequence below the
    fence MUST fail before a restore artifact is created.
36. Restore staging MUST preserve database lineage, control-time watermark,
    authoritative digest, last sequence, and next sequence. The first later
    command MUST allocate exactly the manifest's `nextTransactionSequence`.
37. Backup creation, verification, and restore staging MUST NOT allocate a
    control transaction or modify source metadata, records, receipts, events,
    projections, or sequence. Stage creation is not live activation.
38. The local control CLI MUST accept exactly the documented positional
    arguments, require canonical positive safe-integer sequence values, emit no
    stack trace, and write no successful JSON to stdout after a failure.
39. `verify-backup` and `stage-restore` MUST dispatch without constructing a
    store at `SNOWCAT_CONTROL_DB`; inspecting a backup must never initialize an
    absent live database as a side effect.
40. Normal startup MUST continue to reject missing or unknown projection heads.
    The projection-repair opener MAY skip only projection-catalog startup
    validation; it MUST still validate application/schema identity, transaction
    lineage, subjects, occurrences, receipts, and authoritative registries
    before deleting projection rows.
41. The CLI MUST NOT expose generic SQL, record/fact mutation, live restore
    replacement, worker execution, provider credentials, lease tokens, or a way
    to reinterpret projection output as authority.
42. `core.activate-snapshot` and `core.rollback-snapshot` MUST be the only
    establishment paths for predicate `core.snapshot-active`; the latest accepted
    transaction sequence MUST define precedence, and the singleton pointer MUST
    be validated against that fact.
43. Startup MUST validate retained Core raw bytes, content and catalog digests,
    canonical parsed live declarations, source revisions, ordered outputs,
    idempotency receipts, and all snapshot/pointer occurrence lineage.
44. Core activation MUST leave projections stale rather than synchronously
    rebuilding them inside the authority transaction.
45. A Core candidate rejection MUST create exactly one registered observation
    and one matching past-tense event in its own idempotent transaction. It MUST
    NOT create a subject, fact, snapshot, enrollment, hold, or active-pointer
    change.
46. Rejection payloads MUST enforce the stage/code relationship, optional
    source revision sufficiency, single-line 512-byte text fields, at most eight
    detail fields, canonical source identity, deployment scope, organization
    information class, server time, and check-ID correlation.
47. Reusing a rejection check ID with equivalent input MUST return the original
    record identities and order; reuse with different diagnostic input MUST
    fail. The [Core check-detail retention](core-check-detail-retention.md)
    contract governs deletion of eligible check/rejection receipts and their
    complete transactions.
48. Every new automatic activation after the first MUST require the source
    adapter's ancestry binding to equal the source commit of the active snapshot
    under the same writer lock. Missing or stale bindings MUST allocate no
    transaction, snapshot, fact, event, receipt, or pointer change.
49. `core.rollback-snapshot` MUST run as the stored `operator-principal`, bind
    the exact prior sequence and active snapshot, require a different exact
    target commit and bounded reason, and emit one decision followed by the new
    definition, fact, and rollback event at positions 0 through 3.
50. Startup MUST verify rollback decision, operator, previous-snapshot, target,
    reason, causation, event, receipt, and transaction linkage. A rollback MUST
    retain every prior snapshot and MUST create a new snapshot identity even
    when target bytes were previously retained.
51. `core.prune-check-detail` MUST enforce the registered 30-day and 10,000
    eligible-detail bounds without deleting snapshots, decisions, current
    readiness anchors, or cited evidence. It MUST retain a typed digest-bearing
    result and rebuild every projection atomically from the post-prune source.
52. Startup MUST validate the exact Core poll singleton, interval, times, lease,
    completion linkage, outcome/disposition vocabulary, and counters. Poll
    state MUST be covered by backup integrity but MUST NOT allocate or establish
    a record, event, fact, decision, or transaction sequence.
53. Repository authority, GitHub identity, canonical surfaces, and enrollment
    MUST use only their registered commands and predicates. Authority and
    identity emit three outputs, surfaces emit four, and enrollment emits three;
    each write retains one idempotency receipt indefinitely. Local hold impose
    and clear each emit a decision and event under the stored operator.
54. Startup MUST verify repository subject identity, active-snapshot declaration
    bytes and digest, source revisions, authority and reconciliation record IDs,
    causation, payload lineage, transaction result, and receipt output linkage.
55. The repository status read MUST derive from the active snapshot's latest
    applicable authority, identity, surface, and enrollment facts. It MUST
    expose `enrolled` only when the enrollment fact binds all current
    prerequisites.
56. Startup MUST verify each local-hold decision chain, exact Core authority,
    declaration digest, operator, affected gates, recovery rule, causation,
    ordered output, transaction result, and receipt. Status and direct
    enrollment MUST treat an active operator hold as an independent narrowing
    input under the [local hold contract](repository-local-holds.md).

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| SQLite v5 target schema | Created transactionally by `ControlPlaneStore` |
| Registry validation | Code-owned constants and validators in `src/control/registry.ts` |
| Initialization definition and event | Fixed outputs of `control-plane.initialize` v1 |
| Implicit operator identity | Fixed `operator-principal` subject and `principal.definition` initialization output |
| Integrity observation, event, and receipt | Fixed outputs of `control-plane.check-integrity` v1 |
| Core snapshot definition, fact, event, retained files, and receipt | Fixed outputs and source material of `core.activate-snapshot` v1 |
| Core candidate rejection observation, event, and receipt | Bounded fixed outputs of `core.record-candidate-rejection` v1 |
| Core poll operational state | Validated singleton owned by `CoreSourceController` |
| Repository effective status | Active Core authorization plus current identity, surface, enrollment, and independent operator-hold decisions |
| Subject lookup generations | Full deterministic rebuild from subjects and their first durable creation records |
| Event cursor generations | Full deterministic rebuild from event occurrences without payload copies |
| Backup manifest | Verified metadata and canonical authoritative digest of one online SQLite backup artifact |
| Staged restore | Create-only SQLite copy revalidated against the manifest and caller's lineage/sequence fence |
| Focused conformance fixtures | `test/control-store.test.ts` and `test/github-observation-registry.test.ts` |

## References

- Rationale:
  [ADR-0037](../adr/0037-store-facts-with-a-separate-event-ledger.md),
  [ADR-0039](../adr/0039-use-typed-source-native-subject-identities.md),
  [ADR-0040](../adr/0040-establish-facts-through-registered-predicate-contracts.md),
  [ADR-0041](../adr/0041-enforce-three-information-classes-and-scoped-access.md),
  [ADR-0042](../adr/0042-use-rebuildable-projections-only-as-read-models.md),
  [ADR-0043](../adr/0043-order-records-by-transaction-sequence-not-timestamps.md),
  [ADR-0044](../adr/0044-replace-the-queue-spike-database.md),
  [ADR-0048](../adr/0048-retain-core-check-detail-for-30-days.md), and
  [ADR-0049](../adr/0049-poll-core-through-one-leased-controller.md), and
  [ADR-0050](../adr/0050-reconcile-repository-enrollment-as-separate-facts.md), and
  [ADR-0051](../adr/0051-pin-surfaces-to-the-observed-default-branch-head.md),
  [ADR-0052](../adr/0052-bind-local-repository-holds-to-explicit-operator-decisions.md), and
  [ADR-0057](../adr/0057-require-webhook-ingress-for-github-observation.md)
- Context: [control-plane kernel](../design/control-plane-kernel.md) and
  [GitHub observation](../design/github-observation.md)
- Core authority contract: [Core snapshot activation](core-snapshot-activation.md)
- Core diagnostic retention: [Core check-detail retention](core-check-detail-retention.md)
- Core polling: [Core source polling](core-source-polling.md)
- Repository reconciliation: [repository authority reconciliation](repository-authority-reconciliation.md)
  and [repository surface reconciliation](repository-surface-reconciliation.md),
  and [local repository holds](repository-local-holds.md)
- Delivery: [control-plane kernel bootstrap](../plans/control-plane-kernel-bootstrap.md)
- Product: [GitHub organization agent fleet](../prd/agent-fleet.md)
