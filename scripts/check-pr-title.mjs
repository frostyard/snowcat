#!/usr/bin/env node
// Enforces the Conventional Commits PR-title format documented in
// .github/pull_request_template.md against one title: the argument, or
// PR_TITLE when no argument is given (for a future CI workflow to pass the
// pull request's title this way). Same lint pull-request-cure.ts's
// inspectPullRequestHealth uses for the `bad-title` decay (ADR-0061).
import { lintPullRequestTitle } from "../src/queue/pr-title-lint.ts";

const title = process.argv[2] ?? process.env.PR_TITLE;
if (title === undefined) {
  console.error("usage: check-pr-title.mjs <title>  (or set PR_TITLE)");
  process.exit(2);
}

const result = lintPullRequestTitle(title);
if (!result.ok) {
  console.error(`PR title lint failed: ${result.reason}`);
  process.exit(1);
}
console.log(`PR title lint passed: "${title}"`);
