# 0041 — Enforce three information classes and scoped access

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

Fluent coordinates public repository work, ordinary non-public organization
operations, and security findings whose existence may itself be sensitive.
ADR-0024 prohibits raw secrets and requires high and critical findings to
remain restricted. ADR-0032 makes information access part of worker routing,
ADR-0035 hides restricted decisions, and ADR-0037 places information class in
every durable record envelope and keeps sensitive content out of broad events.

Those decisions do not yet define the classes, how scope intersects with a
class ceiling, how relationships and derived records inherit sensitivity, or
how an API avoids leaking restricted existence through counts and errors.
Treating repository visibility as the answer is insufficient: members of a
private repository may still be too broad an audience for an undisclosed
vulnerability.

The initial deployment has one operator who controls the host. Application
classification cannot protect data from that host administrator, and splitting
SQLite files would not create such a boundary. It must instead protect data
across worker sessions, future named-member roles, API and UI views, event
consumers, logs, projections, exports, and external artifacts.

Some material must not be classified and retained at all. Credentials, private
keys, raw secrets, exploit payloads, sensitive personal data, and unrestricted
logs create unacceptable exposure even in a restricted row.

## Decision

V1 has exactly three ordered information classes, from least to most
restrictive:

1. **`public`** — information already public or reviewed as safe for ordinary
   public-repository worker context;
2. **`organization`** — ordinary non-public repository, work, operational, and
   organization information; and
3. **`restricted`** — existence-hidden security or similarly sensitive
   information requiring explicit record or compartment scope.

Unknown classes fail closed. Repositories and plugins cannot add class names or
change their order. `public` class does not authorize publication, a GitHub
mutation, or disclosure through any particular artifact; action authority and
disclosure decisions remain separate.

Risk tier, repository visibility, action authority, worker capability, and
information class remain independent. High and critical security findings
default to `restricted`, but risk alone is not a general replacement for
classification.

### Forbidden content

Raw credentials, tokens, session material, private keys, secret values,
operational exploit payloads, sensitive personal data, and unrestricted
sensitive logs MUST NOT enter Fluent records, evidence text, work briefs,
prompts, model summaries, event payloads, artifacts, errors, traces, search
indexes, or backups. `restricted` is not permission to store them.

Accepted contracts retain only minimum safe metadata, non-secret fingerprints,
bounded locations, sanitized excerpts when explicitly permitted, and access-
controlled external evidence references that grant no access by themselves.
Detection at ingestion rejects or safely quarantines the command before normal
persistence and emits only a sanitized attributable safety event. Exact
detectors and quarantine handling belong in implementing specs.

### Classification and scope

Every durable definition, assertion, observation, evidence relationship, fact,
decision, operational-state history record, event, and stored projection has an
information class assigned by its versioned record, predicate, event, decision,
or projection contract. A client, worker, model, payload, or source label cannot
lower the contract's class.

Information class is only one access dimension. Each record also has an
information scope identifying the exact repositories, subjects, roles, and,
for restricted data, named compartment required to know that it exists or read
it. A class ceiling means a principal may be considered for that class; it does
not grant access to every record at or below the ceiling.

Effective read access is the intersection of authenticated principal, current
session, role policy, worker grant where applicable, repository and subject
scope, information-class ceiling, restricted compartment, current holds or
revocation, and the record contract's access rule. Missing or unknown inputs
deny access.

The initial operator may receive deployment-wide access through an explicit v1
role policy because that principal already controls the host. Future named
members and every worker session require explicit scope; host control is not
silently inferred from an application login.

### Inheritance and relationships

A record derived from, quoting, summarizing, or exposing the existence of other
records inherits the most restrictive applicable input class and the
intersection-safe scope by default. A relationship record is at least as
restricted as the most restricted endpoint whose existence it reveals.

A lower-class record cannot contain a subject reference, record ID, count,
fingerprint, title, error, URL, or correlation value that reveals a
higher-class record. Higher-class records may reference lower-class records
when their scopes otherwise permit it.

Ordinary transformation, aggregation, projection, truncation, hashing, or field
redaction cannot lower class. Hashing a restricted finding still reveals a
stable restricted fingerprint; aggregating one finding may reveal its
existence.

### Declassification

Lowering information class is an explicit declassification path owned by a
versioned contract. It creates a new independently identified lower-class
record; it never mutates, relabels, or exposes a filtered view of the original.

The path requires an authorized reviewer, exact restricted source revisions,
a bounded lower-class schema, deterministic forbidden-content and leakage
checks, rationale, intended audience, and an evidence-bound attestation or
typed decision. The visible lower-class record contains no reference that
reveals restricted existence. Its provenance relationship to the source is
stored separately at the source's restricted class.

A sanitized remediation work item, public advisory, issue, or pull request must
originate from such an accepted lower-class record and receive its own ordinary
admission and action authority. Declassification does not authorize external
publication or prove remediation.

### Existence hiding and query behavior

An unauthorized principal or worker receives no indication that a restricted
record, work item, decision, event, relationship, artifact, or lineage exists.
Filtering occurs before ranking, counting, pagination, aggregation, faceting,
search, scheduling, capacity-gap calculation, and notification. Page sizes,
total counts, cursors, timing, errors, and not-found behavior must not expose
excluded records beyond bounded operational side channels addressed by the
implementation threat model.

Work listing and claim evaluate information access before returning a summary
or creating a lease. Restricted work without compatible explicit scope behaves
as absent to the session, not as a visible denied item. A targeted identifier
does not bypass the same check.

Revocation, grant expiry, hold, or role change prevents future reads, claims,
renewals, and mutations immediately. It cannot erase information already
disclosed to an external worker, so restricted grants remain short-lived,
minimal, attributable, and reviewable.

### Events, observation, and operational output

Events inherit the most restrictive subject, input, and payload class. A
restricted event remains restricted even when its payload contains only a
record reference, because subject and event existence may be sensitive.
Broadly readable events use separately registered safe event contracts and
cannot include hidden correlation, counts, or identifiers.

ProcessObserver profiles declare their permitted information classes and
scopes. Observer inputs, funnels, findings, and andons inherit the most
restrictive contributing class and scope. Aggregation does not automatically
declassify an observer result; a safe lower-class metric requires the explicit
declassification path and minimum-cohort protections declared by its contract.

Ordinary application logs, errors, metrics, traces, and health endpoints contain
only safe type, bounded outcome, and opaque operational correlation data whose
visibility is itself authorized. They do not copy record payloads, restricted
subject identities, evidence, decision rationale, work objectives, or worker
briefs.

### SQLite, indexes, and backups

V1 keeps one transactional SQLite control-plane database. All access by workers,
named members, UI, CLI, API, search, and controllers goes through the same
mandatory authorization layer; no application role receives direct database
access. Every query and projection proves class and scope filtering with
positive, negative, and inference-leak tests.

Search and indexes either enforce the same pre-result access rules or are
physically partitioned so unauthorized candidates, counts, snippets, and terms
cannot appear. A cache or projection never weakens the source access rule.

The database file, WAL, temporary files, diagnostics containing data, exports,
and every backup inherit the most restrictive class stored in them. In normal
v1 operation that means they are treated as `restricted`, protected by host
permissions, excluded from ordinary logs and artifacts, and restored only into
an equivalently controlled deployment. Exact backup encryption, retention, and
key operations belong in the operations specification.

Physical database separation is not a v1 access boundary. The single host
operator controls every local file, while multiple databases would complicate
atomic fact, evidence, decision, and event transactions. A future threat model
requiring separation from the host administrator or independently managed keys
requires a new architecture decision.

## Consequences

- Public, ordinary organization, and restricted work have one small portable
  vocabulary across repositories and worker clients.
- Class ceiling and information scope cannot be confused with blanket access.
- Restricted existence is protected across lists, searches, counts, events,
  decisions, scheduling, and ProcessObserver output.
- Secrets and exploit material stay outside Fluent rather than relying on an
  optimistic restricted label.
- Declassification produces reviewable independent records instead of fragile
  field-filtered views.
- One SQLite transaction can preserve fact, evidence, decision, and event
  consistency across classes.
- The database and its backups must normally be operated as restricted assets,
  even when most records describe public repositories.
- Application authorization becomes a critical security boundary and needs
  pervasive negative and inference-leak tests because SQLite supplies no row-
  level security.
- Exact restricted-reviewer roles, detector rules, retention periods, embargo
  lifecycle, private-disclosure integration, and backup cryptography remain to
  be specified.

## Alternatives considered

- **Use public and private only:** rejected because ordinary organization data
  and existence-hidden security findings require different access behavior.
- **Use repository visibility as information class:** rejected because private
  repository membership can exceed need-to-know security access.
- **Let every repository define classes:** rejected because routing and
  cross-repository enforcement would become incomparable and fail open on
  unknown values.
- **Treat restricted as permission to store secrets:** rejected because the
  control plane, prompts, logs, and backups would become a credential and
  exploit repository.
- **Grant all restricted data to anyone with a restricted ceiling:** rejected
  because class is sensitivity, not subject-level need-to-know scope.
- **Redact fields dynamically from one record:** rejected because caches,
  indexes, errors, and new fields can bypass a fragile filtered view.
- **Assume aggregation declassifies:** rejected because small cohorts, stable
  fingerprints, counts, and timing can reveal restricted existence.
- **Use a second SQLite database for restricted data:** rejected for v1 because
  the same host operator owns both files and cross-database authority
  transactions would become harder to make atomic.
- **Hide payload but expose restricted metadata:** rejected because existence,
  repository, timing, severity, and workflow state may themselves be sensitive.
- **Promise protection from the host administrator:** rejected because the
  self-hosted single-node deployment does not provide that technical boundary.

## References

- Specializes restricted finding and disclosure behavior from
  [ADR-0024](0024-restrict-security-findings-before-disclosure.md)
- Applies authenticated identity, scoped worker grants, and existence-hidden
  decisions from [ADR-0018](0018-bind-worker-sessions-and-verify-github-artifacts.md),
  [ADR-0032](0032-route-work-with-operator-issued-grants.md), and
  [ADR-0035](0035-route-human-authority-through-typed-decisions.md)
- Applies record, event, projection, and information-class envelopes from
  [ADR-0037](0037-store-facts-with-a-separate-event-ledger.md) and predicate
  contracts from
  [ADR-0040](0040-establish-facts-through-registered-predicate-contracts.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [security-maintenance workflow](../prd/agent-fleet.md#security-maintenance-workflow),
  [worker grants and deterministic routing](../prd/agent-fleet.md#worker-grants-and-deterministic-routing),
  and
  [control-plane records and event ledger](../prd/agent-fleet.md#control-plane-records-and-event-ledger)
- Language: [Fluent ubiquitous language](../domain/ubiquitous-language.md)
- Delivery: [product foundation roadmap](../plans/product-foundation-roadmap.md)
