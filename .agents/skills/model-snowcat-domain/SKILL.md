---
name: model-snowcat-domain
description: Build and sharpen Snowcat's canonical ubiquitous language, challenge ambiguous or conflicting terms, and reconcile vocabulary with ADRs, code, APIs, schemas, UI, skills, and docs. Use whenever a Snowcat design introduces or changes a domain concept, a word does multiple jobs, adjacent states or authority acts are being confused, or a review needs to check terminology before implementation.
---

# Model Snowcat Domain

Maintain precise shared language while design happens. The canonical file is
[`docs/domain/ubiquitous-language.md`](../../../docs/domain/ubiquitous-language.md);
root `CONTEXT.md` is a compatibility symlink and must not be edited separately.

## Resolve a term

1. Read the canonical language entry and the Accepted ADRs it cites. If the term
   is absent, read the nearest adjacent terms before proposing one.
2. Search current code and docs for the word and its likely synonyms. Quote the
   contradictory usages that make the boundary matter.
3. Stress-test the distinction with one concrete Snowcat scenario. State what
   each candidate meaning would cause the controller, worker, schema, API, or
   operator to do differently.
4. Classify the result:
   - Existing term already fits: use it and replace the ambiguous synonym in
     touched living surfaces.
   - Meaning is new but unambiguous from Accepted decisions: add or revise the
     canonical entry.
   - Meanings imply materially different product models: present the exact
     choice and obtain human resolution before canonicalizing. In unattended
     work, record an open language question instead of guessing.
   - Resolution embodies a significant hard-to-reverse tradeoff: write the next
     ADR from `docs/adr/TEMPLATE.md` first, then update the language.
5. Update the term immediately rather than collecting a glossary dump for the
   end of the task.
6. Reconcile touched code, schemas, APIs, UI, skills, and living docs. When live
   implementation intentionally lags, keep its spec truthful and record an
   explicit vocabulary migration or open question.

## Write a canonical entry

Use this exact shape:

```markdown
#### Canonical term

One or two sentences defining identity and boundary.

**Avoid:** rejected or dangerous synonym; overloaded phrase.
([ADR-NNNN](../adr/NNNN-title.md))
```

Add only a short disambiguating example when the definition cannot establish
the boundary alone. Keep one canonical term owner and preserve valid relative
links.

## Hold the boundaries

- Keep the language a glossary. Do not add fields, schemas, transition tables,
  implementation instructions, planning history, or a prose copy of the PRD.
- Never promote model-generated vocabulary without human review when more than
  one product model is plausible.
- Never edit an Accepted ADR solely to match new wording. Add a new ADR when a
  decision changes; otherwise link the existing decision from the term.
- Use `assertion` for an unverified statement and reserve `claim` for atomically
  leasing a work item.
- Replace generic `approval` with the exact act: admission, disposition,
  attestation, GitHub review, core merge, or another named authority transition.
- Replace ambiguous `complete` with attempt report, resolved, merged,
  implementation-complete, delivered, or outcome-achieved as applicable.
- Treat `agent` as informal narrative, not a schema or authority type. Use the
  exact worker, role, session, provider, skill, or deterministic controller.
- Prefer deleting or merging redundant entries over growing the glossary.

## Validate

Before finishing:

1. Confirm every added or changed term has one **Avoid** line and at least one
   Accepted ADR link.
2. Search touched surfaces for the rejected synonym and either correct it or
   explain the intentional implementation migration.
3. Run the repository documentation-link validation and `npm run check` when
   files changed.
4. Report the resolved distinction and any remaining open language question;
   do not describe an unresolved term as settled.
