# Core snapshot ingestion

Living document. Rationale:
[ADR-0007](../adr/0007-use-frostyard-core-as-the-organization-authority.md),
[ADR-0013](../adr/0013-author-organization-records-as-strict-json.md), and
[ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md).
Contracts: [core snapshot verification](../specs/core-snapshot-verification.md)
and [Core snapshot activation](../specs/core-snapshot-activation.md).

## Overview

Core snapshot ingestion is the deterministic boundary between the mutable
`frostyard/core` branch and Fluent authority. The implemented path fetches one
exact commit into a bare mirror, reads only its Git tree and blob objects under
`organization/`, validates the complete supported contract, and emits a
content-addressed candidate catalog. A separate typed command reruns validation,
retains the exact catalog in the target database, and atomically selects it as
current authority. Neither verification nor activation creates enrollment.

```text
frostyard/core refs/heads/main
              │ fetch, resolve exact commit
              ▼
      host-local bare mirror
              │ bounded Git tree/blob reads; no checkout
              ▼
  schema parity + strict catalog validation
              │
              ├──► rejected candidate diagnostics
              └──► immutable candidate summary (not authority)
                              │ typed command; optimistic sequence
                              ▼
                 retained Core snapshot + activation fact
                              │ one SQLite transaction
                              ▼
                   checked active-snapshot pointer
```

## Design

### Git source boundary

[`git-source.ts`](../../src/core/git-source.ts) accepts only the configured
`frostyard/core` GitHub URL forms and one canonical `refs/heads/*` ref. The
defaults are HTTPS `frostyard/core`, `refs/heads/main`, and
`./data/core.git`. Git authentication remains in the host Git mechanism;
Fluent neither accepts credentials in the URL nor persists them in its
database.

The source is fetched into an internal candidate ref in a bare mirror. Git
hooks, the `ext` protocol, filesystem sources, ambient Git directory/object
environment variables, fsmonitor, and alternate object storage are disabled or
rejected. Tests alone can enable a filesystem source for an isolated fixture.
The reader resolves the candidate commit and `organization` tree IDs, enumerates
regular blobs, enforces limits before loading content, and uses `git cat-file`
instead of creating a working tree. Symlinks, submodules, non-blob entries,
unsafe paths, and unknown authority paths fail the whole candidate.
Replacement objects and lazy object fetching are disabled, so the resolved
object graph must be present in the fetched mirror exactly as addressed.

### Bundled contract and parity

Fluent bundles the three schema documents implemented by merged core PR #80:
repository declaration, repository surfaces, and repository agent governance.
The expected SHA-256 digest of each exact core schema blob is compiled into
Fluent. A fetched schema must match that byte digest, and its parsed canonical
content must match the bundled validator schema, before validation begins.
Fetched schema code or validation scripts are never executed.

The independent validator uses the same pinned Ajv 2020 and `jsonc-parser`
versions as core. It rejects invalid UTF-8, comments, trailing commas, duplicate
keys, unknown properties through the schemas, path/identity mismatch,
duplicate repository identities and owners, invalid surface catalogs, and
duplicate protected boundaries. It runs every recognized valid and invalid
fixture and refuses a corpus without both classes.

### Candidate catalog

Every recognized file contributes path, regular-file mode, Git object ID,
byte size, and content digest to a path-sorted canonical catalog digest. The
reported candidate binds source URL, source ref, commit ID, organization tree
ID, schema digests, fixture counts, and parsed repository declarations.
Repository declarations remain declarations: the merged `frostyard/core`
declaration is currently `disabled`, and even a future `enabled` declaration
will not become enrollment until a later transaction atomically persists and
activates the whole snapshot and GitHub reconciliation succeeds.

The bare mirror and JSON report are staging artifacts, not facts, projections,
or active authority. Re-running verification is safe and does not allocate a
control-plane transaction.

### Atomic retention and activation

[`ControlPlaneStore.activateCoreSnapshot`](../../src/control/store.ts) is the
only implemented authority transition. It takes the expected current control-
plane sequence and a fully materialized candidate, acquires the writer lock,
checks for an exact retry, validates the target database, and reruns the Core
validator over the candidate bytes. The internal candidate report is compared
with that independent result; callers cannot manufacture a catalog by editing
summary fields.

After the first activation, the CLI asks the Git source adapter to prove Core
source continuity from the active source commit to a different candidate. The
store then binds that exact ancestor to the still-current snapshot under the
writer lock before allocating authority. This two-part check keeps Git graph
inspection outside the SQLite transaction while preventing a proof against an
obsolete active snapshot from transferring to a concurrent state. Exact replay
returns its retained result before continuity is reevaluated.

The source is the immutable GitHub repository identity
`github.com:1331309458`, with its exact commit as a typed source revision. Each
accepted catalog receives a new Fluent-native `core-snapshot` UUIDv7 subject.
Its creation transaction emits a snapshot definition, an active-snapshot fact
on the control-plane database subject, and a past-tense activation event. The
active fact's registered latest-transaction precedence is authority; the
singleton table is a checked efficient pointer to it.

The same transaction retains every recognized file's raw bytes and Git/content
identity, a canonical parsed copy of each live repository declaration, the
validation report carried by the snapshot definition, occurrence and source
lineage, an indefinitely retained idempotency receipt, and advanced metadata
watermarks. The pointer moves last. Any failure rolls back all of these writes,
including SQLite's sequence allocation. Prior snapshots remain immutable and
available after another commit activates.

Startup revalidates the durable envelope and source vocabulary, recomputes each
file and complete catalog digest, checks parsed declarations against raw bytes,
and requires the pointer to name the latest accepted activation fact. Raw bytes
are transitively covered by the authoritative database digest through their
verified content digests, while disposable projections remain excluded.

### Rejected candidates

Activation assigns one server check identity before touching the source. A
failure before an exact commit resolves is a `source` rejection; a structurally
or semantically unusable resolved commit is a `validation` rejection; a failure
to prove that a validated commit descends from the active source commit is a
`continuity` rejection; and a failure after the authority transaction starts is
reported as `persistence` only after that transaction and its SQLite sequence
allocation roll back.

[`recordCoreCandidateRejection`](../../src/control/store.ts) appends a typed
`observation` and past-tense event in a separate idempotent audit transaction.
They bind the control-plane deployment, immutable GitHub repository source, and
exact commit when available. Summaries and at most eight details are normalized,
secret-pattern redacted, single-line, and capped at 512 UTF-8 bytes each. The
observation creates no candidate or snapshot subject, fact, hold, enrollment,
or pointer change. Its transaction sequence orders the audit occurrence; it
does not become activation precedence.

`core verify` intentionally records nothing. `core activate` attempts rejection
recording and preserves the original failure if diagnostics cannot be written.
The current manual-only slice retains accepted rejection history and receipts;
payload and list size are bounded now, while count/time purge semantics remain
required before periodic polling.

## Operational notes

- Run `npm run --silent core -- verify`. Success writes one JSON value to
  stdout; diagnostics and Git/Node warnings use stderr.
- Run `npm run --silent core -- activate <expected-control-plane-sequence>` to
  persist and select that fetched candidate. Equivalent retry uses the original
  expected sequence and returns its original result.
- Run `npm run --silent core -- rejections [limit]` to read the newest rejection
  observations; the default is 20 and the maximum is 100.
- `FLUENT_CORE_URL`, `FLUENT_CORE_REF`, and `FLUENT_CORE_MIRROR` select the
  exact allowed source, branch ref, and host-local mirror path.
- A valid report proves compatibility with the implemented repository-authority
  slice only. Core roadmap record kinds that do not yet exist remain unsupported
  and any unknown `organization/` path fails closed.
- A failed fetch or validation before the first activation leaves no last-known-
  good state. Atomic activation now preserves an existing current snapshot;
  durable rejected-candidate diagnostics preserve the failure. Freshness,
  rollback authority, retention/purge, and polling belong to
  later phases of the
  [ingestion plan](../plans/core-snapshot-ingestion.md).
- The mirror contains organization-governed data and should be backed up and
  permissioned as an `organization` asset. It must never be mounted as an
  enrolled repository checkout or exposed to workers as a tool directory.

## References

- Rationale:
  [ADR-0007](../adr/0007-use-frostyard-core-as-the-organization-authority.md),
  [ADR-0013](../adr/0013-author-organization-records-as-strict-json.md),
  [ADR-0014](../adr/0014-import-core-as-atomic-validated-snapshots.md), and
  [ADR-0015](../adr/0015-authorize-repository-enrollment-through-core.md)
- Contracts: [core snapshot verification](../specs/core-snapshot-verification.md)
  and [Core snapshot activation](../specs/core-snapshot-activation.md)
- Built in: [Core snapshot ingestion — Phases 1–2](../plans/core-snapshot-ingestion.md)
- Product: [GitHub organization agent fleet](../prd/agent-fleet.md)
