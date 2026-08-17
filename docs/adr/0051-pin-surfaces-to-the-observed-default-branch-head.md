# 0051 — Pin surfaces to the observed default-branch head

- **Status:** Accepted
- **Date:** 2026-08-16

## Context

An enabled repository declaration identifies a repository but intentionally
does not select a branch or commit. Canonical-surface validation nevertheless
requires one exact repository commit. Reading a mutable branch separately for
each file would permit a mixed revision, while validating a worker checkout
would couple enrollment authority to client tools and mutable files.

GitHub repository metadata identifies the default branch. Its Git data API can
resolve that branch to one commit and expose the object type and bytes of each
canonical path without executing repository code.

Surface availability is evidence, not enrollment by itself. A crash between
surface inspection and enrollment must remain resumable without collapsing
those authority acts.

## Decision

Each enabled repository reconciliation observes the current default-branch
name together with immutable identity metadata. After identity matches, Fluent
resolves that branch once to an exact commit and root tree, then reads only the
canonical paths selected by the active Core snapshot's surface contract at that
commit through bounded GitHub Git data requests.

Fluent accepts canonical files only as regular Git blobs and canonical
directories only as Git trees. It rejects symlinks, submodules, aliases,
missing paths, wrong object types, oversized or malformed responses, unknown
contracts, and governance that fails the bundled Core-compatible schema. No
repository code, checkout, worktree file, or generated runtime output is read.
Retained evidence binds the repository commit and tree, contract and schema
versions, Git object IDs, content digests, parsed governance, and a closed
result.

Surface reconciliation and enrollment establishment are separate registered
commands. The first records an observation, an immutable enrollment-checkpoint
policy decision, a reconciliation fact, and an event for one identity fact.
The second may establish `repository.enrolled` only from the active Core
authorization, current matched identity, and a valid surface decision. It
creates the durable RepositoryController definition and enrollment event but
no work.

An interrupted pass may therefore expose `awaiting-enrollment` after valid
surfaces. A consecutive equivalent command returns its original receipt; a
different intervening observation followed by recovery creates a new fact. A
later default-branch head or Core declaration produces new revision-bound
evidence; it never rewrites prior enrollment history.

## Consequences

- Every accepted surface set is internally consistent at one repository
  commit and remains explainable after the default branch advances.
- Fluent does not need a repository checkout, Git credential helper, or worker
  sandbox to enroll a repository.
- Default-branch movement intentionally causes a new surface evaluation.
- A repository can be visibly surface-held without blocking another one.
- Enrollment becomes an explicit fact rather than a synonym for valid files.
- GitHub API availability is required to advance evidence but not to read prior
  evidence.

## Alternatives considered

- **Pin a commit in the Core declaration:** rejected because the declaration
  carries fleet authority, not repository implementation state, and would
  require a Core PR for every repository commit.
- **Read the latest default branch separately per path:** rejected because one
  pass could combine files from different commits.
- **Validate an operator or worker checkout:** rejected because mutable local
  files and client sandboxing are outside Fluent's authority boundary.
- **Create enrollment in the surface transaction:** rejected because distinct
  evidence and authority transitions need independently resumable receipts.

## References

- Shapes: [repository enrollment design](../design/repository-enrollment.md),
  [repository surface reconciliation](../specs/repository-surface-reconciliation.md),
  and [Core snapshot ingestion plan](../plans/core-snapshot-ingestion.md)
- Builds on: [ADR-0015](0015-authorize-repository-enrollment-through-core.md),
  [ADR-0016](0016-read-only-canonical-repository-surfaces.md),
  [ADR-0040](0040-establish-facts-through-registered-predicate-contracts.md),
  and [ADR-0050](0050-reconcile-repository-enrollment-as-separate-facts.md)
- Product: [agent fleet PRD](../prd/agent-fleet.md#canonical-repository-surfaces)
