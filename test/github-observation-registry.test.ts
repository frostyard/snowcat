import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_PLANE_REGISTRY_VERSION,
  assertRevision,
  assertSource,
  assertSourceRevision,
  assertSubject,
  commandKindRegistry,
  eventKindRegistry,
  recordKindRegistry,
} from "../src/control/registry.ts";

const digest = `sha256:${"a".repeat(64)}`;

test("GitHub observation subjects use exact source-native identities", () => {
  assert.equal(CONTROL_PLANE_REGISTRY_VERSION, 18);
  assert.equal(commandKindRegistry["github.record-installation-reconciliation"].schemaVersion, 1);
  assert.equal(recordKindRegistry["github.installation-repository-observation"].schemaVersion, 1);
  assert.equal(recordKindRegistry["github.installation-repository-reconciled"].schemaVersion, 1);
  assert.equal(eventKindRegistry["github.installation-repository-reconciliation-recorded"].schemaVersion, 1);
  assert.equal(commandKindRegistry["github.open-source-gap"].schemaVersion, 3);
  assert.equal(commandKindRegistry["github.repair-source-gap"].schemaVersion, 3);
  assert.equal(recordKindRegistry["github.source-gap-observation"].schemaVersion, 3);
  assert.equal(recordKindRegistry["github.source-gap-repair-observation"].schemaVersion, 3);
  assert.equal(eventKindRegistry["github.source-gap-opened"].schemaVersion, 3);
  assert.equal(eventKindRegistry["github.source-gap-repaired"].schemaVersion, 3);

  assert.doesNotThrow(() => assertSubject("github-app-hook", "github.com:app:12345:hook"));
  assert.doesNotThrow(() => assertSubject("github-pull-request", "github.com:987:pull:42"));
  assert.doesNotThrow(() => assertSubject("github-check-run", "github.com:987:check-run:654"));
  assert.doesNotThrow(() => assertSubject("github-commit-status", "github.com:987:commit-status:321"));

  assert.throws(() => assertSubject("github-app-hook", "github.com:app:0:hook"));
  assert.throws(() => assertSubject("github-pull-request", "frostyard/snowcat#42"));
  assert.throws(() => assertSubject("github-pull-request", "github.com:987:pull:0"));
  assert.throws(() => assertSubject("github-check-run", "github.com:987:check:654"));
  assert.throws(() => assertSubject("github-commit-status", "github.com:987:status:321"));
});

test("GitHub observation revisions are purpose-specific to their subjects", () => {
  assert.doesNotThrow(() => assertRevision("github-webhook-body-sha256", digest, "github-app-hook"));
  assert.doesNotThrow(() => assertRevision("github-delivery-audit-sha256", digest, "github-app-hook"));
  assert.doesNotThrow(() => assertRevision("github-rules-sha256", digest, "github-repository"));
  assert.doesNotThrow(() => assertRevision("github-branch-transition-sha256", digest, "github-repository"));
  assert.doesNotThrow(() => assertRevision("github-source-checkpoint-sha256", digest, "github-repository"));
  assert.doesNotThrow(() => assertRevision("github-source-gap-sha256", digest, "github-repository"));
  assert.doesNotThrow(() => assertRevision("github-pull-request-sha256", digest, "github-pull-request"));
  assert.doesNotThrow(() => assertRevision("github-check-run-sha256", digest, "github-check-run"));
  assert.doesNotThrow(() => assertRevision("github-commit-status-sha256", digest, "github-commit-status"));

  assert.throws(() => assertRevision("github-check-run-sha256", digest, "github-pull-request"));
  assert.throws(() => assertRevision("github-pull-request-sha256", digest, "github-repository"));
  assert.throws(() => assertRevision("github-rules-sha256", "sha256:ABC", "github-repository"));
});

test("webhook and GitHub API sources cannot exchange acquisition revisions", () => {
  assert.doesNotThrow(() =>
    assertSource("github-app-webhook", "github.com:app:12345:hook", "github-webhook-body-sha256"),
  );
  assert.doesNotThrow(() =>
    assertSource("github-api", "api.github.com", "github-delivery-audit-sha256"),
  );
  assert.doesNotThrow(() => assertSourceRevision("github-webhook-body-sha256", digest));
  assert.doesNotThrow(() => assertSourceRevision("github-delivery-audit-sha256", digest));
  assert.doesNotThrow(() => assertSource("snowcat-system", "github-observer"));

  assert.throws(() =>
    assertSource("github-app-webhook", "github.com:app:12345:hook", "github-delivery-audit-sha256"),
  );
  assert.throws(() =>
    assertSource("github-api", "api.github.com", "github-webhook-body-sha256"),
  );
  assert.throws(() =>
    assertSource("github-api", "api.github.com", "github-source-checkpoint-sha256"),
  );
  assert.throws(() =>
    assertSource("github-api", "api.github.com", "github-source-gap-sha256"),
  );
  assert.throws(() =>
    assertSource("snowcat-system", "github-observer", "github-source-gap-sha256"),
  );
});
