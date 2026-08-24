# Plan: Repository tooling and worker image rollout

<!--
Plans are updated as work lands: check off what shipped, renumber what moved.
Every phase MUST have a "Done when" — a demonstrable outcome, not an activity.
-->

This plan moves the fleet from "the worker image is qualified against
nothing" ([reality report](../design/reality.md), findings 5, 7, and 13) to a
state where every repository declares its own tool pins in one
machine-installable file, executors satisfy that declaration before any lease
exists, and a version bump is a one-file change that CI proves compatible
before a worker ever sees it. It replaces the execution path of
[ADR-0075](../adr/0075-declare-a-repository-execution-profile-in-core.md)
(a core-owned `tools` schema with `required|optional` entries) with a
convention core solidifies but does not version: `mise.toml` + `mise.lock`
own tool pins, `go.mod` owns the Go version, named gates (`verify`,
`check`) are Make targets, and a published Snowcat worker base image is the
lineage every executor starts from. It is remediation step 3 of the reality
report, spans four repositories, and runs beside — never ahead of — the
[recovery plan](recover.md). Phase 0 is deliberately a stopgap so that
Cockpit runs today; Phases 1–7 are the durable design that retires it.

Baseline on 2026-08-24:

- Six enabled fleet declarations in core: `clix`, `core`, `firn`, `snowcat`,
  `std`, `updex`.
- `std`, `clix`, and `updex` pin `GOLANGCI_LINT_VERSION := 2.12.2` in their
  Makefiles and `go 1.26.6` in `go.mod`; `std`'s CI `sed`s the pin out of the
  Makefile. Cockpit's own Makefile pins 2.13.1 — the fleet already disagrees.
- `make check` is `fmt lint test` in all three (mutating: `gofmt -w`);
  `make lint` in `std`/`clix` soft-skips when `golangci-lint` is absent;
  `updex`'s `make ci` hard-requires the exact pin. No repository has a
  strictly non-mutating `make verify`.
- Cockpit publishes three provider images (`oci/Containerfile`,
  `Claude.Containerfile`, `Copilot.Containerfile`) from
  `golang:1.26.6-bookworm`, none containing `golangci-lint`; launch is
  digest-pinned with `--pull=never`
  ([OCI workers spec](https://github.com/frostyard/snowcat-cockpit/blob/main/docs/specs/oci-workers.md)).
- ADR-0075 is Accepted with no implementing code in Snowcat, core, or
  Cockpit.
- **Cockpit exists only as a local checkout**: 43 commits on `main`, no
  remote, no `frostyard/snowcat-cockpit` repository on GitHub, no core
  declaration, so no Actions run, nothing publishes to GHCR, and every
  `github.com/frostyard/snowcat-cockpit/...` link in this plan and the
  reality report resolves only after Phase P.

## Dependency map

| Phase | Repository | Depends on | Unblocks |
| --- | --- | --- | --- |
| 0 — Cockpit hums today | snowcat-cockpit (local build), std, clix, updex | nothing | a working fleet while P–7 land |
| P — Publish Cockpit | snowcat-cockpit, core | nothing | 1 (Cockpit ADR merge), 2 (GHCR), 5 (Cockpit as queue work), every Cockpit link |
| 1 — Decide | snowcat, core, snowcat-cockpit | P for the Cockpit ADR only (draft in parallel; merge in order 0076 → core → Cockpit) | 2, 3 |
| 2 — Base image | snowcat-cockpit | P, 1 (Cockpit ADR) | 4 |
| 3 — Pilot `std` on mise | std | 1 (core ADR) | 4, 5 |
| 4 — Prep-time provisioning | snowcat-cockpit | 2, 3 | 5, 6 |
| 5 — Fleet adoption | clix, updex, snowcat, core, firn | 3, 4 | 6, 7 |
| 6 — Retire the stopgap | snowcat-cockpit, core | 5 | — |
| 7 — Pin-bump automation | snowcat (or core Renovate config) | 5 | — |

Phases 0, P, and 1 start the same day; P is small and must land before
anything in Cockpit is merged, published, or linked. Phases 2 and 3 run in
parallel. Nothing in P–7 is a prerequisite for Cockpit working; only Phase 0
is, and it builds images locally for exactly that reason.

## Phase 0 — Cockpit hums today (hours; stopgap)

The image lacks the one tool three gates need, and reviewers are told to run
a mutating gate. Both are one-line fixes per file. Everything here is
retired by Phase 6; do not generalise it.

- [x] **Cockpit:** install `golangci-lint` **2.13.1** in all three
  Containerfiles from the upstream release tarball with a pinned URL and
  per-architecture SHA256 (core
  [ADR-0023](https://github.com/frostyard/core/blob/main/docs/adr/0023-verified-pinned-downloads.md));
  one build stage per file, `COPY`'d into the final image at
  `/usr/local/bin/golangci-lint` (snowcat-cockpit#4). *The plan first said
  2.12.2: `std` had already bumped to 2.13.1 on 2026-08-23 (std#54) while
  `clix` and `updex` stayed on 2.12.2 — the fleet was split, so the bump
  rides along in their verify-gate PRs and one image serves all three.*
- [x] **Cockpit:** set `GOTOOLCHAIN=local` in every image `ENV`, so a
  `go.mod` the image's Go cannot satisfy fails loudly at the first `go`
  invocation instead of downloading a toolchain inside the lease
  (snowcat-cockpit#4). *This immediately bit: `std`'s `go.mod` requires
  1.26.7 and the image shipped 1.26.6, so the base moves to
  `golang:1.26.7-bookworm`. Rule until Phase 4: the image's Go tracks the
  highest `go` directive in the fleet.*
- [x] **Cockpit:** add both facts to the OCI workers spec's command baseline
  ("a new tool enters this list only after a repository contract or retained
  worker terminal demonstrates the need" — findings 5 and the lost-worker
  campaign are that record).
- [x] **Cockpit:** tag, let `worker-images.yml` publish (Phase P proved the
  path on `v0.1.0`), then roll the node. *`v0.1.1` published 2026-08-24;
  the node pulled all three by digest, `service.env` names them, and the
  service restarted with no live workers. `golangci-lint version --short`
  in the pulled Claude image reports 2.13.1.* The operator node runs the
  **Docker** adapter from local image IDs
  (`SNOWCAT_COCKPIT_DOCKER_{CODEX,CLAUDE,COPILOT}_IMAGE` in
  `~/.local/libexec/snowcat-cockpit/service.env`, the user service's
  `EnvironmentFile`): `docker pull` each published `name:tag@sha256`
  reference, set the variable to that exact reference (the spec's
  immutable form), `systemctl --user restart snowcat-cockpit`. A local
  `make docker-image` build remains the fallback if GHCR is slow.
- [x] **std, clix, updex:** add `make verify` — strictly non-mutating and
  credential-free: `go mod tidy -diff`, `test -z "$(gofmt -l …)"`, `go vet`,
  `golangci-lint run` (hard-required, exact pin), `go test`. `updex`'s
  `make ci` is the model minus its mutating `go mod tidy`; make `ci` call
  `verify`. Leave `make check` (`fmt lint test`) as the developer gate
  (std#60, clix#79, updex#390, all merged 2026-08-24; each verified locally under the pinned Go
  with `git status --porcelain` empty afterwards). *Finding: golangci-lint
  2.13.1 is built with Go 1.27 and embeds its gofmt, which formats one
  `updex` test file differently from Go 1.26's gofmt — and each rejects
  the other's form. The fix restructures the code so both agree; neither
  pin was wrong. This is the Go/lint mismatch in its purest form and the
  reason Phase 7 bumps the pair together.*
- [x] **std, clix:** `make lint` stops soft-skipping when the binary is absent
  — a missing linter fails, matching the PR template's "lint clean" claim.
  *Already landed upstream before this plan; `updex` gets it in #390.*
- [x] **Snowcat:** the reviewer instruction in
  [`src/queue/pull-request-review.ts`](../../src/queue/pull-request-review.ts)
  and the [`review-snowcat-queue`](../../.agents/skills/review-snowcat-queue/SKILL.md)
  skill name `make verify` as the read-only gate and forbid `make check`
  for `pr-review` work (ADR-0075 §4, which survives into Phase 1)
  (snowcat#215, merged 2026-08-24).
- **Done when:** a Cockpit campaign on `std`, `clix`, and `updex` completes
  one item per repository whose retained worker terminal shows
  `golangci-lint run` executing from the image (no `go install`, no
  "skipping"), and one `pr-review` item completes with `git status
  --porcelain` empty after `make verify`. *All inputs landed 2026-08-24;
  the campaign itself is the operator's next run.*

## Phase P — Publish Cockpit (hours)

Cockpit's contract documents, ADRs, images, and future queue work all assume
a GitHub repository that does not exist yet. This phase creates it the way
every other fleet repository is created and stops here — it does not enroll
Cockpit in Snowcat's fleet until Phase 5 needs that.

- [x] Create `frostyard/snowcat-cockpit` from the local checkout with the
  same visibility as `frostyard/snowcat` (public), push `main`, and add the
  `origin` remote. Confirm the commit the reality report pins for the OCI
  contract (`5ebc980…`) is on the pushed `main` so the existing links hold.
  *Done 2026-08-24; the pinned link resolves.*
- [x] Apply core's repository settings contract with
  `scripts/apply-repo-settings.sh` (core
  [ADR-0040](https://github.com/frostyard/core/blob/main/docs/adr/0040-publish-the-repository-settings-contract.md))
  and the default-branch merge queue (core
  [ADR-0042](https://github.com/frostyard/core/blob/main/docs/adr/0042-adopt-a-merge-queue-on-the-default-branch.md));
  a human runs both — Snowcat only reports drift. *Applied 2026-08-24 with
  required checks `Repository gate`, `Security scan`, `Docs integrity`,
  `Build (amd64)`, `Build (arm64)`; rulesets "frostyard: default branch"
  and "frostyard: release tags" are active and the merge queue is on, so
  merges go through `enqueuePullRequest`, never `gh pr merge`.*
- [x] Confirm `test.yml` is green on the first push. *It was not:
  `TestRunInstallKitThenProfiles` only passed on hosts with all three
  provider CLIs on `PATH` (fixed in snowcat-cockpit#1). The nightly
  `snapshot.yml` also fails until at least one `v*` tag exists.*
- [x] Confirm the release secrets reach the new repository. *`GORELEASER_KEY`
  and the `R2_*` secrets are org secrets with `visibility=all`, so a new
  repository needs no selection step; a `v*` tag runs both `release.yml`
  and `worker-images.yml`.*
- [x] Confirm `worker-images.yml` (`packages: write`, repository-scoped
  token) published `ghcr.io/frostyard/snowcat-cockpit-worker` from
  `v0.1.0` (tagged 2026-08-24 at the test-fix commit; the LICENSE landed on
  `main` after it) and set the GHCR package visibility deliberately.
  *Published and publicly pullable (anonymous manifest fetch returns 200,
  so nodes need no registry credential):*
  - `ghcr.io/frostyard/snowcat-cockpit-worker:codex-v0.1.0@sha256:16954b8e868e98c0a7f7a110c1687ab89e178c4c1fce199263b10bfca965a423`
  - `ghcr.io/frostyard/snowcat-cockpit-worker:claude-v0.1.0@sha256:5e3fe6a75a399daf1099e8d908ab803b3405f55b73764539552f2a18d9054a74`
  - `ghcr.io/frostyard/snowcat-cockpit-worker:copilot-v0.1.0@sha256:5ddb34fade19fa96a82d153c46a1bf8981ad99f12724e74828f353001adb6ac3`

  *These are the pre-Phase-0 images: no `golangci-lint`, no
  `GOTOOLCHAIN=local`. Phase 0 may now publish through this path instead of
  building locally.*
- [x] Add the MIT license the settings contract flags (snowcat-cockpit#2).
- [x] Add Cockpit to core's skills-sync targets (core ADR-0026) so it
  receives the shared skills like every other fleet repository
  (frostyard/core#107, merged 2026-08-24; the first sync PR opened in
  Cockpit the same hour).
- [ ] **Deferred to Phase 5:** a core declaration
  (`organization/repositories/frostyard/snowcat-cockpit.json`) and a
  `policies/agent-governance.json` in Cockpit, so Cockpit's own Phase 5–7
  changes can be Snowcat queue work. Not needed for Phases 0–4, which are
  operator-driven.
- **Done when:** `gh repo view frostyard/snowcat-cockpit` succeeds, `main`
  matches the local checkout, CI is green, one tagged build has published a
  digest-addressed image to GHCR, and every Cockpit link in this plan and
  the reality report resolves (`npm run check:docs` here only checks local
  links; verify the GitHub ones by hand once). **Reached 2026-08-24** — the
  deferred enrollment items remain for Phase 5.

## Phase 1 — Decide (one day; three ADRs, merged in order)

- [ ] **Snowcat ADR-0076** supersedes ADR-0075: keeps named gates, keeps
  "qualify before the lease, never inside it" and "absence is visible, never
  guessed", keeps credential scopes bound to paths (finding 13 — decide its
  home, see open questions); drops the core-owned `tools` schema, `optional`,
  `runtime`, and the enrollment-recorded profile. States the consumption
  contract: Snowcat's reviewer instructions name `make verify`; Snowcat
  records nothing about tools. Updates the **Execution profile** entry in the
  [ubiquitous language](../domain/ubiquitous-language.md), the "Decided:"
  pointers on findings 5, 7, and 13 in the [reality report](../design/reality.md),
  and the [work queue spec](../specs/work-queue.md) reviewer-instruction rule.
- [ ] **core ADR** (repository tooling convention; extends core
  [ADR-0022](https://github.com/frostyard/core/blob/main/docs/adr/0022-make-ci-gate-and-test-naming-filter.md)
  and [ADR-0023](https://github.com/frostyard/core/blob/main/docs/adr/0023-verified-pinned-downloads.md)):
  1. `mise.toml` + committed `mise.lock` at the repository root declare every
     executable the gates invoke beyond the published base-image baseline;
     `mise.lock` is the ADR-0023 checksum registry for tools.
  2. `go.mod` is the only Go pin, as a full `1.x.y`; mise reads it
     (`idiomatic_version_file_enable_tools = ["go"]`); no `go` entry in
     `mise.toml`.
  3. `make verify` is non-mutating and credential-free; `make check` is the
     developer gate; `make ci` calls `verify` (ADR-0022 lineage).
  4. No tool is optional: a gate that invokes a tool requires it.
  5. Bump order: a `golangci-lint` release built with Go N lands before
     `go.mod` moves to N; the two ship as one change.
  6. Worker image lineage: every executor image is
     `ghcr.io/frostyard/snowcat-worker-base` or `FROM` it; the baseline tool
     list is a versioned, published fact of that image.
  The surfaces contract does **not** gain an execution-profile schema.
- [ ] **Cockpit ADR:** one provider-collapsed base image; repository tools
  provisioned at target preparation from `mise.lock` into a per-repository
  cache mounted read-only; `mise ls --missing` non-empty or Go not satisfying
  `go.mod` ⇒ lane unready with the reason named. Supersedes the "generic
  baseline" posture of
  [Cockpit ADR-0005](https://github.com/frostyard/snowcat-cockpit/blob/main/docs/adr/0005-isolate-unattended-workers-in-rootless-oci.md)
  without weakening any isolation rule.
- **Done when:** all three ADRs are Accepted and cross-linked, ADR-0075 is
  marked Superseded, `npm run check` passes here, and the glossary's
  **Execution profile** entry describes the convention, not a schema.

## Phase 2 — Base image (snowcat-cockpit; one to two days)

- [ ] Collapse `oci/Containerfile`, `Claude.Containerfile`, and
  `Copilot.Containerfile` into one `oci/base.Containerfile` carrying all three
  provider CLIs (their pins unchanged) and one entrypoint that selects the
  provider from Cockpit's launch argument. The per-provider
  `SNOWCAT_COCKPIT_OCI_*_IMAGE` variables keep working and may all name the
  same digest, so a Phase 0 node configuration is not broken.
- [ ] Add `mise` (pinned release, SHA256-verified, ADR-0023) with
  `MISE_DATA_DIR` pointing at the read-only mount Phase 4 introduces and
  `MISE_YES=1`; keep `GOTOOLCHAIN=local`.
- [ ] Publish the baseline as data: `oci/baseline.json` listing every
  executable the base guarantees (shell utilities, git, gh, make, jq,
  ripgrep, go, gofmt, node, mise, the provider CLIs) with versions; the OCI
  workers spec references the file instead of restating the list. This is
  the "beyond the baseline" boundary the core ADR needs to be checkable.
- [ ] `worker-images.yml` publishes
  `ghcr.io/frostyard/snowcat-worker-base:<version>` with a recorded
  `@sha256` manifest digest, multi-architecture as today (first real GHCR
  publish — Phase 0 ran from local image IDs). Roll the nodes from local
  IDs to the published digest.
- **Done when:** Codex, Claude, and Copilot workers each complete a Snowcat
  item from the same base digest, and `oci/baseline.json` is the only place
  the baseline is enumerated.

## Phase 3 — Pilot `std` on mise (std; half a day)

`std` is the pilot because its gate soft-skips lint today — the exact
failure the convention exists to end.

- [ ] Add `mise.toml` (`[settings] idiomatic_version_file_enable_tools =
  ["go"]`; `[tools] golangci-lint = "2.12.2"`) and run `mise install` to
  produce `mise.lock`; commit both.
- [ ] Confirm mise resolves Go from `go.mod` and installs 1.26.6 exactly;
  record the result in the core ADR if it changes the convention (open
  question 1).
- [ ] Makefile: delete `GOLANGCI_LINT_VERSION`; `lint` invokes
  `mise exec -- golangci-lint run` (or relies on mise shims) and fails when
  the tool is missing; keep the Phase 0 `verify`.
- [ ] CI: replace the Makefile `sed` and `golangci-lint-action` with
  `jdx/mise-action` (SHA-pinned, core
  [ADR-0021](https://github.com/frostyard/core/blob/main/docs/adr/0021-sha-pinned-actions-and-least-privilege-ci.md))
  followed by `make ci`, so CI and workers install from the same two files.
- [ ] Add a `lint-version-check` style guard comparing `golangci-lint
  version`'s build Go against `go.mod`'s directive, so a Go bump ahead of
  lint fails with a one-line reason.
- **Done when:** `std` CI is green with no tool version stated anywhere but
  `go.mod` and `mise.toml`; on a fresh clone with mise and no other tools,
  `mise install && make verify` passes and `git status --porcelain` is
  empty; deleting the `golangci-lint` entry makes `make lint` fail rather
  than skip.

## Phase 4 — Prep-time provisioning (snowcat-cockpit; two days)

- [ ] In target preparation (`internal/worker/target.go`, before any lease
  exists — OCI workers spec rule 1 ordering), run `mise install --locked`
  in the checkout with `MISE_DATA_DIR` set to a per-repository cache under
  the node's state directory. Downloads are verified against `mise.lock`;
  a repository without `mise.toml` provisions nothing and is not unready
  (ADR-0076 "absence is visible, never guessed").
- [ ] Mount that cache read-only into the container at the path the base
  image's `MISE_DATA_DIR` names; the entrypoint activates mise for the
  provider's login shell. No other change to the mount posture.
- [ ] Readiness: `mise ls --missing` non-empty, or `go version` in the
  checkout failing under `GOTOOLCHAIN=local`, marks the lane unready with
  the tool or version named in inventory and the dashboard. Nothing is
  installed inside the container.
- [ ] Record the provisioned tool set (name, version, lock digest) as
  non-secret worker metadata beside the image digest.
- **Done when:** with `golangci-lint` still in the base (Phase 0), a `std`
  worker runs the lint from the mise cache (visible in the retained
  terminal's path), and a fixture repository whose `mise.lock` names a tool
  with a wrong checksum produces an unready lane naming that tool and no
  lease.

## Phase 5 — Fleet adoption (five repositories; one to two days of queue time)

Adoption is queue work: file one Snowcat issue per repository with the
[`write-snowcat-issues`](../../.agents/skills/write-snowcat-issues/SKILL.md)
skill (label `snowcat`, `requiredArtifact: pull-request`), and let Cockpit
lanes do it against the Phase 3 pattern. The Phase 4 node provisions from
whatever each repository declares, so a repository can adopt while others
have not.

- [ ] `clix` and `updex`: mirror Phase 3 exactly (both already pin 2.12.2).
- [ ] `snowcat`: `mise.toml` pins Node (today only `package.json`'s
  `engines` and the deploy runbook say which); `npm run check` is already
  the full gate — add `verify` as the credential-free subset (`typecheck`,
  `test`, `check:docs`) and document it in `AGENTS.md`.
- [ ] `core`: Node like `snowcat`; its `scripts/check-organization.mjs` is
  `verify`.
- [ ] `firn`: adopt per its build system (declare, do not infer — if it
  needs tools mise cannot install, it becomes the first Phase "Later"
  extension-image candidate rather than a partial adoption).
- [ ] `snowcat-cockpit`: land the Phase P deferred items (core declaration,
  agent-governance surface), enroll it, then adopt mise like the other Go
  repositories — its Makefile already hard-pins `golangci-lint` (2.13.1;
  align to the fleet pin or move the fleet, one change).
- [ ] Core distributes the shared pieces the same way it distributes
  skills (core
  [ADR-0026](https://github.com/frostyard/core/blob/main/docs/adr/0026-distribute-core-skills-via-sync-prs.md)):
  a `mise.toml` settings block, the `verify` Makefile snippet, and the
  mise CI step as templates.
- **Done when:** every enabled declaration's repository has `mise.toml`,
  `mise.lock`, `make verify`, and CI installing from those files; a Cockpit
  campaign across all six completes at least one item each with no
  in-lease tool install in any retained terminal.

## Phase 6 — Retire the stopgap (snowcat-cockpit, core; half a day)

- [ ] Remove `golangci-lint` from the base image and `oci/baseline.json`;
  workers now get it only from the mise cache. Republish, roll the digest.
- [ ] Remove every remaining Makefile `GOLANGCI_LINT_VERSION` and
  soft-skip across the fleet (Phase 5 should leave none; verify with a
  fleet grep).
- [ ] core: add the convention check to `check-organization.mjs` or the
  repository-surfaces conformance path — `mise.toml` and `mise.lock`
  present and parseable, `verify`/`check`/`ci` targets present — so a
  repository that drops the convention fails core's gate, not a worker's
  lease.
- [ ] Snowcat: a maintenance-program probe (catalog in
  [`src/queue/programs.ts`](../../src/queue/programs.ts)) that runs `make
  verify` on a clean checkout and proposes a `quality` item when the tree
  is dirty afterwards — the mechanical "a profile can lie" check ADR-0075
  wanted, now against a Makefile instead of a schema.
- **Done when:** the base image contains no repository-specific tool, and a
  deliberately dirty `verify` in a fixture repository yields one proposed
  Snowcat item naming the mutation.

## Phase 7 — Pin-bump automation (snowcat or core; one day)

- [ ] Extend [`sweepInternalDependencies`](../../src/queue/internal-dependencies.ts)
  (or adopt Renovate's native `mise` manager with a group that includes
  `go.mod`) so a new `golangci-lint` release proposes one `dependency-bump`
  item per enrolled repository, and a new Go release proposes the pair in
  the core ADR's order (lint first). Each proposal's CI is the compatibility
  proof; workers never see a pair CI has not passed.
- [ ] Wire `mise outdated` into the weekly cadence in [`deploy/`](../../deploy/)
  as the ADR-0023 update-check for the new pin registry.
- **Done when:** a golangci-lint release yields one proposed item per
  repository within a sweep cadence, and a Go release ahead of lint yields a
  proposal whose CI fails on golangci-lint's own version check rather than
  a worker lease.

## Later / ideas

- **Extension images** for repositories needing what mise cannot install
  (system packages for the bootc and image-building repositories): a
  `.snowcat/Containerfile` `FROM` the base, built by a core-distributed
  workflow, qualified by running `make check` under Cockpit's exact launch
  limits, resolved by `gh attestation verify` rather than a committed
  digest. Cockpit's `--pull=never` posture needs a per-repository digest
  source before this can land.
- **Credential scopes on items** (finding 13): ADR-0076 chooses the home;
  the queue-side surfacing ("this item touches `.github/workflows/**`,
  needs `github:workflow`") is its own phase in the recovery plan once
  the governance-policy shape is decided.
- **Runtime floors** (PIDs, memory): dropped from the declaration; if a
  repository trips Cockpit's 1024-PID or 2 GiB limits again, the extension
  image's qualification run is where it surfaces, and a floor can be added
  then.

## Open questions

- **Does mise reliably read `go.mod` as the Go version source?** Decided by
  the Phase 3 pilot. If not, fallback is `GOTOOLCHAIN=auto` with a
  prep-time `go version` warm in Phase 4 (sumdb-verified, ADR-0023-clean)
  and the core ADR's rule 2 changes to "Go is provisioned by Go".
- **Is `mise.lock` stable enough to be the ADR-0023 checksum registry?**
  Decided by Phase 3 (the lock must record URL and SHA256 for every tool and
  `mise install --locked` must refuse a mismatch). If not, the core ADR
  pins tools by `mise.toml` plus a sibling checksum file until it is.
- **Where do credential scopes live — `policies/agent-governance.json` or a
  thin execution profile?** Decided in ADR-0076 (Phase 1) after a
  [`model-snowcat-domain`](../../.agents/skills/model-snowcat-domain/SKILL.md)
  pass; governance already indexes paths, which is the argument for it.
- **Which repository owns the base image?** Phase 2 assumes
  `snowcat-cockpit/oci/` because Cockpit owns the launch contract
  ([ADR-0003](../adr/0003-separate-work-coordination-from-execution.md)
  keeps it out of Snowcat); a separate `worker-images` repository is the
  alternative if non-Cockpit executors need it.
- **Does Snowcat record the image digest or tool set a completed item ran
  under?** Decided by Phase 4: Cockpit records it as worker metadata today;
  Snowcat records it only if a recovery-plan phase consumes it.

## References

- Implements: [design/reality.md](../design/reality.md) (findings 5, 7, 13;
  remediation step 3),
  [design/how-snowcat-works.md](../design/how-snowcat-works.md),
  [specs/work-queue.md](../specs/work-queue.md) (reviewer-instruction rule)
- Replaces the execution path of:
  [ADR-0075](../adr/0075-declare-a-repository-execution-profile-in-core.md)
  (superseded by ADR-0076 in Phase 1)
- Runs beside: [plans/recover.md](recover.md),
  [plans/maintenance-programs.md](maintenance-programs.md)
- External contracts: Cockpit
  [OCI workers spec](https://github.com/frostyard/snowcat-cockpit/blob/main/docs/specs/oci-workers.md);
  core [ADR-0022](https://github.com/frostyard/core/blob/main/docs/adr/0022-make-ci-gate-and-test-naming-filter.md),
  [ADR-0023](https://github.com/frostyard/core/blob/main/docs/adr/0023-verified-pinned-downloads.md),
  [ADR-0026](https://github.com/frostyard/core/blob/main/docs/adr/0026-distribute-core-skills-via-sync-prs.md)
