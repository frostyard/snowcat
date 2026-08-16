# 0036 — Maintain a canonical domain language

- **Status:** Accepted
- **Date:** 2026-08-15

## Context

Fluent now has accepted product decisions spanning organization governance,
work coordination, external workers, repository and fleet control, feature
delivery, assurance, scheduling, and human authority. Several ordinary words
already carry multiple possible meanings: “agent” may mean a provider process,
worker, role, skill, or deterministic controller; “claim” may mean leasing work
or asserting a fact; and “complete” may mean a worker report, merge, delivered
behavior, or achieved outcome.

Those collisions are dangerous at schema, API, database, UI, skill, and prompt
boundaries. Humans can repair ambiguity through conversation, while capable
workers often choose a plausible meaning and propagate it confidently.
Generating a large unreviewed glossary would create a different failure: fluent-
sounding definitions could become false authority.

The repository already has an ADR convention and documentation taxonomy. The
referenced
[domain-modeling discipline](https://github.com/mattpocock/skills/blob/main/docs/engineering/domain-modeling.md)
usefully separates a lean ubiquitous language from decisions and implementation
specifications, but its bundled file and ADR conventions must be adapted to the
local documentation rules.

## Decision

Add `docs/domain/` as the canonical documentation category answering “What do
our words mean?” Its initial and canonical language is
[ubiquitous-language.md](../domain/ubiquitous-language.md). A root
`CONTEXT.md` symlink points to that file for agent tools that discover the
conventional name; the symlink is not another editable copy.

The language file is a living, human-reviewed glossary. One entry contains:

- one canonical term;
- a one- or two-sentence definition establishing its identity or boundary;
- rejected, overloaded, or dangerous synonyms under **Avoid**; and
- only when necessary, one short disambiguating note or example.

The glossary does not contain implementation fields, state-transition tables,
API shapes, schema definitions, planning history, general programming terms,
or a prose copy of the PRD. Those belong in specs, design docs, plans, or ADRs.
A hard-to-reverse tradeoff still requires an ADR; the glossary records the
resulting word, not the decision history.

Terms are grouped for retrieval but remain one canonical file until the lean
language genuinely spans bounded contexts that readers should not load
together. File length alone is not a reason to split a bloated glossary. Any
future split requires one canonical domain index and unambiguous term ownership.

Resolve terminology during design rather than batching it at the end. When a
conversation distinguishes adjacent concepts, update the term at that point.
When a code, schema, API, UI, skill, or doc change introduces or changes a
domain term, it MUST either use the canonical language or update the language
and affected decision first. Reviewers challenge vague or conflicting terms
rather than silently selecting a synonym.

The accepted language describes the target product model. Current spike code
and live implementation docs remain truthful about existing names. A mismatch
between target language and implemented names is recorded as an explicit
migration or open language question; it is not concealed by rewriting a live
spec before code changes or by weakening the canonical definition to match a
temporary implementation.

Normative product and implementation surfaces use precise terms. `Agent`
remains acceptable in informal product narrative and when naming an actual
external product category, but it is not a normative domain type. Contracts
use `worker`, `worker session`, `worker role`, `provider`, `skill`,
`RepositoryController`, `FleetController`, or `ProcessObserver` as applicable.

Likewise, a statement offered as evidence is an `assertion`; `claim` is reserved
for atomically leasing a work item. Generic `task`, `job`, and `ticket` do not
replace `work item` in domain contracts. Generic `approval` is replaced by the
specific act—admission, decision disposition, attestation, GitHub review, core
merge, or another named authority transition.

Every domain-language change is reviewed alongside the ADRs and current code it
purports to summarize. An agent may draft or challenge entries but MUST NOT
promote its own unreviewed vocabulary to canonical truth. New entries link the
accepted ADRs that establish them; Accepted ADRs remain immutable and need not
be edited solely to add a glossary backlink.

## Consequences

- Humans and capable workers get one compact vocabulary before reading the
  much larger PRD and ADR set.
- Precise terms reduce accidental state, authority, and lifecycle conflation in
  schemas, APIs, database names, UI labels, skills, and prompts.
- The root compatibility symlink improves discovery without creating two
  editable sources.
- Keeping the glossary lean prevents it from becoming a shadow specification.
- Inline maintenance turns terminology into an active design discipline rather
  than a one-time documentation dump.
- Explicit implementation mismatches preserve truth while giving migrations a
  target language.
- Restricting “agent,” “claim,” “approval,” and “complete” will require edits
  in existing narrative and future implementation contracts.
- The initial scaffold can be derived from Accepted ADRs, but unresolved
  collisions still require operator discussion before becoming canonical.
- A future portable domain-modeling skill may enforce this practice after the
  language stabilizes; the skill is not itself the authority.

## Alternatives considered

- **Rely on the PRD and ADRs:** rejected because definitions are distributed and
  expensive to retrieve at every naming boundary.
- **Generate an exhaustive glossary automatically:** rejected because
  unreviewed plausible definitions become authoritative lore.
- **Use root `CONTEXT.md` as the canonical editable file:** rejected because
  domain documentation belongs in the indexed docs taxonomy; a symlink retains
  compatibility.
- **Call the file `GLOSSARY.md`:** rejected for now because
  `ubiquitous-language.md` states its domain purpose while `CONTEXT.md` remains
  the compatibility surface.
- **Put domain terms in a design doc:** rejected because terminology answers a
  different question from current system architecture.
- **Split immediately into bounded-context files:** rejected because the first
  task is to make one lean language coherent and discover real seams.
- **Let current spike names define the domain:** rejected because the spike
  intentionally predates many accepted product decisions.
- **Ban the word “agent” everywhere:** rejected because it remains useful
  informal language and part of external product names; only normative type use
  is prohibited.

## References

- Builds on the documentation system in
  [ADR-0001](0001-record-architecture-decisions.md) and portable canonical
  surfaces in
  [ADR-0002](0002-agent-portable-instruction-surface.md)
- Names concepts established throughout
  [ADR-0003](0003-separate-work-coordination-from-execution.md) through
  [ADR-0035](0035-route-human-authority-through-typed-decisions.md)
- Canonical language:
  [Fluent ubiquitous language](../domain/ubiquitous-language.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md), especially
  [canonical domain language](../prd/agent-fleet.md#canonical-domain-language)
- External method:
  [domain-modeling](https://github.com/mattpocock/skills/blob/main/docs/engineering/domain-modeling.md)
