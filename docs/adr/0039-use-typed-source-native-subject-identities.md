# 0039 — Use typed source-native subject identities

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

ADR-0037 requires every durable subject to have a stable typed identity and
requires authority decisions to bind exact revisions. The product coordinates
subjects owned by different authority systems: Fluent-native work and
decisions, GitHub repositories and pull requests, Git commits and blobs, and
declared core records such as goals, policies, enrollments, initiatives, and
delivery plans.

No single convenient string identifies all of them safely. Repository slugs,
branch names, file paths, and display names can change. A Fluent-generated ID
for an external object can obscure the identity its authority system actually
recognizes. Conversely, an external numeric ID without its kind and source
namespace can collide or be interpreted incorrectly. A content digest can
identify a revision but not the logical subject that survives revision.

Revision also differs by kind. A Git blob has one immutable object ID, while a
pull-request review may depend on base SHA, head SHA, and the digest of relevant
metadata and evidence. Calling either value a generic `version` would allow a
decision or review to transfer to state it did not evaluate.

## Decision

Every subject reference is the pair `(subject_kind, subject_id)`. Both parts are
required. General control-plane code treats `subject_id` as an opaque canonical
string and never interprets an untyped ID.

`subject_kind` comes from a closed, versioned registry implemented by Fluent.
Each registry entry declares:

- the authority system and namespace for that kind;
- the canonical ID scheme and validation rule;
- the accepted revision-binding kinds and when one is mandatory;
- the adapter or command family allowed to establish identity and revisions;
  and
- display-locator behavior without granting the locator authority.

Unknown subject kinds, ID schemes, revision kinds, or malformed canonical IDs
fail closed at ingestion and authority boundaries. Adding a subject kind
requires a registry and schema version change, validation fixtures, and
migration analysis. It requires a new ADR only when it changes an architectural
or authority boundary; ordinary vocabulary growth does not create ceremonial
ADRs.

### Identity sources

Fluent-native subjects created after this model is implemented use
server-generated UUIDv7 values. These include work items, work attempts,
worker sessions, grants, decisions, holds, and other control-plane subjects.
The server, not a worker or model, assigns identities for authoritative native
records. Existing valid native IDs retain their identity during migration and
are classified under an explicit legacy scheme rather than rewritten to look
like UUIDv7 values.

External subjects retain stable identities from their authoritative source:

- a GitHub repository uses its immutable GitHub repository ID, qualified by
  the GitHub service namespace;
- a GitHub issue or pull request uses the immutable repository identity plus
  its source-assigned number or immutable object ID according to the registered
  kind;
- a Git commit or blob uses an algorithm-qualified object ID and repository
  identity; and
- a core-authored logical record uses its declared stable ID, record kind, and
  immutable core repository identity.

The exact string encoding belongs in the subject-registry specification. A
conceptual pull-request reference could be
`(github-pull-request, github.com:<repository-id>:<number>)`; its display locator
may be `frostyard/chairlift#42`. The locator can change without changing the
subject.

When an external source lacks a stable identity adequate for authority, Fluent
does not mint a substitute and pretend it is source-native. The adapter records
an observation with available provenance, and the affected authority gate
remains unavailable or requires an accepted reconciliation mechanism.

### Record identity is separate

Every durable definition, assertion, observation, evidence reference, fact,
decision, event, and operational-state history record has its own unique
`record_id`. New records use server-generated UUIDv7 values. A record ID names
one stored occurrence; it does not name the subject described by its payload.

Correlation IDs, causation IDs, idempotency keys, lease tokens, public artifact
nonces, repository locators, and provider request IDs remain distinct. None may
be substituted for a record ID or subject reference merely because it is
unique in one context.

### Revision bindings

A revision binding qualifies a stable subject reference with the exact state
relevant to a statement, evaluation, or authority act. It has a registered
revision kind and validated typed value; it is not one universal integer or
free-form version string.

Revision bindings follow the subject's authority semantics:

- Git-authored definitions bind the source repository and commit plus the blob
  or canonical payload digest where content identity matters;
- commits and blobs bind an algorithm-qualified immutable object ID;
- pull-request implementation and review bind at least the base and head SHAs,
  plus a digest of any additional mutable evidence snapshot on which the result
  depends;
- versioned Fluent definitions bind their immutable definition revision or
  payload digest; and
- external observations retain the source revision, ETag, sequence, or
  response digest that the accepted adapter can actually establish, without
  claiming stronger exactness than the source provides.

The registry declares which revision components are required for each command,
predicate, review, or decision family. A decision tied to one revision binding
becomes stale when any required component changes. A newer observation does not
silently move an older assertion, fact, review, or disposition to the new
revision.

### Aliases and lifecycle

Mutable names, slugs, URLs, paths, branch names, and human labels are versioned
aliases or display locators. Fluent retains their observation history for
routing and explanation but never uses them alone for authority joins.

Deletion, archive, transfer, rename, supersession, or loss of access does not
free a stable identity for reuse. Conflicting source identity or an apparent
identity replacement creates a mismatch or hold for reconciliation; it does
not update the subject reference in place.

## Consequences

- Repository renames and core file moves cannot redirect authority to another
  subject.
- External records remain recognizable in their source system without a second
  Fluent identity becoming a competing authority.
- Record, subject, revision, correlation, and idempotency identities have
  mechanically different purposes.
- Composite revision bindings prevent review or consent from drifting when
  relevant pull-request state changes without a new head commit.
- A closed registry makes unknown model-authored subject kinds fail safely.
- UUIDv7 provides sortable, decentralized native identifiers, but implementations
  need a standards-conforming generator and fixtures for clock irregularities.
- Kind-specific canonicalization, revision validation, aliases, and migration
  add more schema and adapter work than a generic text ID.
- Some external sources will remain unavailable for authority when they cannot
  supply a stable identity or adequate revision evidence.

## Alternatives considered

- **Give every subject a Fluent UUID:** rejected for external subjects because
  it creates an alias table whose Fluent identity can obscure or conflict with
  the authoritative source identity.
- **Use external IDs everywhere:** rejected because Fluent-native subjects need
  server-owned identity and external IDs are meaningless without kind and
  source namespace.
- **Use repository slugs, paths, or URLs:** rejected because they are mutable
  locators and can later identify a different subject.
- **Use content digest as subject identity:** rejected because revisions of one
  logical subject would become unrelated subjects.
- **Use one generic revision string:** rejected because revision sufficiency is
  kind- and operation-specific.
- **Use head SHA as the complete pull-request revision:** rejected because
  base, reviews, labels, checks, and other decision-relevant state can change
  without changing the head commit.
- **Allow clients to register subject kinds dynamically:** rejected because a
  worker or model could introduce new authority semantics outside schema review.
- **Rewrite existing IDs into UUIDv7:** rejected because migration would break
  lineage and fabricate an identity history the queue never recorded.

## References

- Builds on source identity and exact artifact lineage from
  [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md), exact
  review targets from [ADR-0029](0029-bound-adversarial-review.md), and stale
  decision binding from
  [ADR-0035](0035-route-human-authority-through-typed-decisions.md)
- Refines stable subjects, record envelopes, revision binding, and migration
  from [ADR-0037](0037-store-facts-with-a-separate-event-ledger.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [worker identity and GitHub reconciliation](../prd/agent-fleet.md#worker-identity-and-github-reconciliation)
  and
  [control-plane records and event ledger](../prd/agent-fleet.md#control-plane-records-and-event-ledger)
- Language: [Fluent ubiquitous language](../domain/ubiquitous-language.md)
- Delivery: [product foundation roadmap](../plans/product-foundation-roadmap.md)
