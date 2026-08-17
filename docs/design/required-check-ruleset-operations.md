# Operating enforced required checks

Living document. Rationale:
[ADR-0056](../adr/0056-derive-required-checks-from-enforced-github-rules.md).
Adjacent contract:
[conclusive-run-rate evaluator](../specs/conclusive-run-rate-evaluator.md).

## Overview

This is the operator runbook for making a repository's default-branch checks
both enforceable by GitHub and observable by Fluent. It defines the narrow v1
configuration that `github-required-checks:v1` will accept. It does not grant
Fluent permission to edit repository rules, register the still-unimplemented
source adapter, or open a measurement window.

The deployment must first satisfy the authenticated ingress and reconciliation
boundary in the
[GitHub observation design](github-observation.md). Ruleset activation without
that observer still enforces CI, but it cannot create retrospective Fluent
coverage.

Enabling this ruleset changes the delivery path: direct pushes to the default
branch stop working. Operators and workers must submit every change through a
pull request, and GitHub must receive every named check from the bound GitHub
App before it permits the merge.

## Required configuration

Use one repository-level branch ruleset per initial repository. Organization
rulesets may replace these later, but repository-level rulesets keep the first
rollout and its failures isolated.

| Setting | V1 value | Reason |
| --- | --- | --- |
| Target | Branches: `~DEFAULT_BRANCH` | Follows the repository's declared default branch without naming a second authority in Core. |
| Enforcement | `Active` | Disabled or evaluate-only rules are not enforced required checks. |
| Bypass list | Empty | A bypassed update makes the observation window incomplete. |
| Require a pull request | Enabled, zero required approvals | Makes every ordinary default-branch update attributable to a pull request without inventing a human-review policy. |
| Allowed merge methods | Preserve the repository's currently enabled methods | Merge style is not part of the required-check decision. |
| Require status checks | Enabled | Establishes the enforced selector set. |
| Expected source | Exact GitHub App for every check; never `Any source` | V1 requires producer attribution. |
| Require branches to be up to date | Enabled | Tests the proposed change with the latest default-branch state. |
| Restrict deletions | Enabled | Prevents deletion of the protected default branch. |
| Block force pushes | Enabled | Preserves an explainable branch-update history. |
| Merge queue | Disabled | Merge-group revisions are explicitly unsupported by v1. |
| Classic branch protection | Absent on the same branch | Classic protection is not a v1 selector authority and overlapping rules can make the effective contract ambiguous. |

Do not add approvals, code-owner review, signed commits, deployments, or
metadata restrictions merely to satisfy this runbook. Those may be valuable,
but they are separate governance decisions.

### Initial Frostyard selectors

The following values were observed from successful default-branch check runs
on 2026-08-17. Re-run the preflight commands before using them; a copied stale
name or integration ID can block every merge.

| Repository | Default branch | Required contexts | Expected source |
| --- | --- | --- | --- |
| `frostyard/fluent` | `main` | `check (node 24)`, `check (node 26)` | GitHub Actions, integration ID `15368` |
| `frostyard/core` | `main` | `docs-gate`, `scaffold-e2e` | GitHub Actions, integration ID `15368` |

Both repositories currently allow merge commits, squash merges, and rebase
merges. Preserve all three unless a separate decision changes that policy.

## Preflight

Perform these checks immediately before creating or changing a ruleset.

1. Confirm the default branch and enabled merge methods:

   ```bash
   gh api repos/OWNER/REPO \
     --jq '{default_branch,allow_merge_commit,allow_squash_merge,allow_rebase_merge}'
   ```

2. Confirm that every candidate context has completed successfully and capture
   its exact producer. GitHub requires a selectable check to have run recently;
   do not type a plausible name from memory.

   ```bash
   DEFAULT_BRANCH="$(gh api repos/OWNER/REPO --jq .default_branch)"
   gh api "repos/OWNER/REPO/commits/${DEFAULT_BRANCH}/check-runs" \
     --jq '.check_runs[] | [.name, .app.id, .app.slug, .conclusion] | @tsv'
   ```

3. Inspect every rule already applying to the branch. GitHub aggregates
   overlapping rulesets, so a second active ruleset can add a stricter rule or
   another required context.

   ```bash
   gh api "repos/OWNER/REPO/rules/branches/${DEFAULT_BRANCH}"
   gh api repos/OWNER/REPO/rulesets
   ```

4. Check for classic branch protection:

   ```bash
   gh api "repos/OWNER/REPO/branches/${DEFAULT_BRANCH}/protection"
   ```

   A `404 Branch not protected` response is the expected v1 state. If classic
   protection exists, reconcile or remove it before declaring the repository
   measurement-ready.

5. Inspect the workflow. Every required job must run for every pull request
   targeting the default branch. Do not require a workflow or job that path
   filters, branch filters, or conditions can leave perpetually pending.

6. Save the preflight output with the operator change record. If a measurement
   window is already open, changing any target, selector, producer, bypass, or
   enforcement setting makes that window `unable`; close it before proceeding.

## Enable through the GitHub UI

1. Open **Repository → Settings → Rules → Rulesets** and choose
   **New branch ruleset**.
2. Name it `fluent-default-branch-required-checks-v1` (or replace `fluent`
   with the repository name) and initially set enforcement to **Disabled**.
3. Leave the bypass list empty.
4. Under target branches, add **Include default branch**.
5. Enable **Restrict deletions**, **Require a pull request before merging**,
   **Require status checks to pass**, and **Block force pushes**.
6. Set required approvals to zero and leave review-specific options disabled.
   Preserve all merge methods already enabled by the repository.
7. Add each context from the preflight output. For every context, select
   **GitHub Actions** as its expected source; do not select **Any source**.
8. Enable **Require branches to be up to date before merging**.
9. Create the disabled ruleset, inspect it once, edit it, and set enforcement
   to **Active**. Activation takes effect immediately.

GitHub may not offer the expected App until it has recently emitted that check
in the repository. Run the workflow successfully and repeat the preflight
rather than falling back to **Any source**.

## Enable through the GitHub API

The API is useful for a reviewed, repeatable rollout. This exact example is for
`frostyard/fluent`; regenerate the contexts and integration IDs from preflight
before use. Save it as `fluent-ruleset.json` outside the repository unless the
organization later adopts a canonical ruleset-as-code location.

```json
{
  "name": "fluent-default-branch-required-checks-v1",
  "target": "branch",
  "enforcement": "disabled",
  "bypass_actors": [],
  "conditions": {
    "ref_name": {
      "include": ["~DEFAULT_BRANCH"],
      "exclude": []
    }
  },
  "rules": [
    {"type": "deletion"},
    {
      "type": "pull_request",
      "parameters": {
        "allowed_merge_methods": ["merge", "squash", "rebase"],
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_approving_review_count": 0,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "do_not_enforce_on_create": false,
        "required_status_checks": [
          {"context": "check (node 24)", "integration_id": 15368},
          {"context": "check (node 26)", "integration_id": 15368}
        ],
        "strict_required_status_checks_policy": true
      }
    },
    {"type": "non_fast_forward"}
  ]
}
```

Create it disabled, capture the returned ruleset ID, verify the stored body,
then activate it through the UI. Keeping activation as a separate operator
action prevents an unreviewed payload from immediately blocking the branch.

```bash
gh api --method POST \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  repos/frostyard/fluent/rulesets \
  --input fluent-ruleset.json
```

```bash
gh api repos/frostyard/fluent/rulesets/RULESET_ID
```

For `frostyard/core`, change the name and replace the two required contexts
with `docs-gate` and `scaffold-e2e`. Do not reuse this example for another
repository without discovering its own context names and producer IDs.

## Verify enforcement

After activation:

1. Query the effective branch rules and confirm there is exactly one stable,
   non-empty required-check selector set with the expected integration ID:

   ```bash
   DEFAULT_BRANCH="$(gh api repos/OWNER/REPO --jq .default_branch)"
   gh api "repos/OWNER/REPO/rules/branches/${DEFAULT_BRANCH}" \
     --jq '.[] | {type,ruleset_id,ruleset_source_type,ruleset_source,parameters}'
   ```

2. Confirm the named ruleset reports `active` and an empty bypass list:

   ```bash
   gh api repos/OWNER/REPO/rulesets \
     --jq '.[] | {id,name,enforcement,bypass_actors}'
   ```

3. Open a trivial pull request. Confirm every required context appears from
   GitHub Actions, the merge is blocked while a context is pending or failing,
   and the merge becomes eligible only after every context succeeds. Close the
   pull request if it exists solely for verification.
4. Inspect **Settings → Rules → Insights** when the repository plan provides
   it. Confirm the test pull request passed without bypass. Do not attempt a
   direct push merely to prove that GitHub will reject it.
5. Record the ruleset ID, active ruleset body, default branch, selector names,
   integration IDs, activation time, and verification pull request in the
   operator change record.

The repository is enforcement-ready after these checks. It is not yet
measurement-ready: Fluent must first implement and register
`github-required-checks:v1`, retain a complete baseline, and explicitly open a
new observation window. Historical merges before that baseline do not count.

## Change, emergency disablement, and recovery

- Treat any ruleset edit as a versioned operational change. A selector,
  producer, branch, bypass, or enforcement change invalidates an open v1
  measurement window; do not blend the old and new populations.
- For an emergency, disable rather than delete the ruleset, record the operator,
  reason, time, and affected work, and assume the current window is `unable`.
- Repair the workflow or ruleset while disabled, run all candidate checks
  successfully, repeat the full preflight, then reactivate and establish a new
  baseline. Never work around a broken producer by selecting **Any source**.
- Keep merge queue disabled until a later adapter version explicitly models
  `merge_group` revisions.
- A direct or bypass update that occurs despite the intended configuration must
  remain visible as a completeness failure; it must not be omitted from the
  evidence population.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Required check waits forever | Confirm the exact job name and that the workflow runs on every pull request without path, branch, or skip filters. |
| “Expected GitHub App” error | Compare the check run's `.app.id` with the ruleset `integration_id`; rerun the workflow if the check is no longer recent. |
| GitHub Actions is unavailable as a source | Produce a successful recent check run, then add the pre-existing context and select its App. |
| More rules apply than expected | Inspect both repository and organization rulesets plus classic branch protection; GitHub aggregates overlapping rules. |
| Direct push is rejected | This is the intended pull-request-only boundary. Open a pull request. |
| Operator must bypass urgently | Disable the ruleset with an attributed incident record and invalidate the measurement window; do not add a silent permanent bypass. |
| Merge queue blocks checks | Keep merge queue disabled in v1; supporting it requires `merge_group` workflow triggers and a new Fluent adapter contract. |

## Operational notes

- Repository admins or a role with permission to edit repository rules can
  manage repository rulesets. Anyone with read access can inspect active
  rulesets.
- GitHub aggregates all applicable rulesets and classic protection, using the
  most restrictive overlapping rule. Verification must inspect effective
  branch rules, not only the named repository ruleset.
- GitHub required contexts can be check runs or commit statuses. If both share
  one name, GitHub may require both; avoid deliberately reusing a context name
  across those producer types.
- A required check must have completed successfully in the repository during
  the preceding seven days for GitHub to recognize it during configuration.

## References

- Rationale:
  [ADR-0056](../adr/0056-derive-required-checks-from-enforced-github-rules.md)
  and
  [ADR-0057](../adr/0057-require-webhook-ingress-for-github-observation.md)
- Context:
  [success-measure verification](success-measure-verification.md)
- Ingress and reconciliation:
  [GitHub observation](github-observation.md)
- Adjacent contract:
  [conclusive-run-rate evaluator](../specs/conclusive-run-rate-evaluator.md)
- Built in:
  [product foundation roadmap — Phase 4](../plans/product-foundation-roadmap.md#phase-4-observe-github-without-impersonating-workers-large)
- GitHub:
  [creating repository rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository),
  [available rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
  [ruleset layering](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets),
  [required-check troubleshooting](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks), and
  [repository rules API](https://docs.github.com/en/rest/repos/rules)
