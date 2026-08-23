/**
 * The Conventional Commits `type(scope): summary` title lint
 * .github/pull_request_template.md:1 documents and ADR-0061 assumes as the
 * repository's title lint: `inspectPullRequestHealth` (pull-request-cure.ts)
 * and scripts/check-pr-title.mjs (CI) both call this so decay detection and
 * the enforced gate never drift apart.
 */
export const conventionalCommitTypes = ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"] as const;

const TITLE_PATTERN = new RegExp(`^(${conventionalCommitTypes.join("|")})(\\([a-z0-9][a-z0-9./-]*\\))?: .+$`);

export type PullRequestTitleLint = { ok: true } | { ok: false; reason: string };

export function lintPullRequestTitle(title: string): PullRequestTitleLint {
  const trimmed = title.trim();
  if (trimmed.length === 0) return { ok: false, reason: "title is empty" };
  if (!TITLE_PATTERN.test(trimmed)) {
    return {
      ok: false,
      reason: `"${trimmed}" does not match Conventional Commits format "type(scope): summary" (type one of ${conventionalCommitTypes.join(", ")})`,
    };
  }
  return { ok: true };
}
