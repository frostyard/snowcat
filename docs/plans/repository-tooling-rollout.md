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
- [ ] **Cockpit:** re-vendor the embedded worker kit from snowcat `main`
  (snowcat-cockpit#5), release, and `node install` the new binary. *Found
  by the first Phase 0 campaign: the kit was locked at snowcat `3388b20`,
  all three canonical skills had moved (including #215's `make verify`
  wording), and `InstallKit` refuses to replace a drifted skill, so the
  snowcat lane failed at kit installation and the campaign ran
  `degraded`. Standing dependency until the Phase 1 Cockpit ADR resolves
  it: every Snowcat skill change requires a Cockpit release and node
  upgrade before the snowcat lane works — the kit should refresh from the
  source revision automatically or defer to the checkout when the
  repository is the canonical skill source.*
- [x] **Cockpit:** re-vendor done (snowcat-cockpit#5 merged; node at
  `dev-1-gcd34de3`). *The upgrade itself surfaced four more dependencies,
  each now known rather than rediscoverable:*
  1. *`node install` restarts the service, and a restart **stops the board
     campaign** (workers survive; the campaign must be re-`POST`ed to
     `/api/v1/campaign` with the same request).*
  2. *`InstallKit` also refuses to overwrite the node's own `worker-kit`
     state directory when it is drifted, so a kit-changing upgrade needs
     that directory replaced by hand before `install-kit` writes the new
     revision (`profiles` reads `kit=drifted` until then).*
  3. *Preflight receipts are bound to the kit revision: every provider reads
     "not structurally ready" after a kit change until `preflight` is
     re-run per provider, and the campaign backs the provider off for five
     minutes on its first failed refresh.*
  4. *Codex workers never start the projected lease-proxy MCP server (the
     entrypoint's `--config …args=[…]` override; snowcat-cockpit#6) — Codex
     reviewers block on "lifecycle tools not callable"; the campaign runs
     Claude reviewers (`opus` against `sonnet` implementers) until fixed.*
  *snowcat#218 (the `-discovery`-kind contract rule) edits a vendored skill
  and is held out of the merge queue until the next re-vendor cycle, so it
  does not drift the kit mid-campaign.*
- [x] **Evidence, first campaign (2026-08-24):** the `clix` implementer
  (`worker-f186215712b86be9`, image `claude-v0.1.1`) completed
  `quality-gap-fix` with `make check` green — lint is hard-required there,
  so the pass proves `golangci-lint` ran from the image — and opened draft
  clix#80; `std`'s discoverer noticed the new `make verify` target and
  filed the doc follow-up (re-filed as std#61 after the kind defect). One
  `std` follow-up looped three discoverer runs (the `-discovery` kind that
  owed a pull request; snowcat#218 refuses the shape).
- [x] **Evidence, second campaign (2026-08-24, Claude reviewers):** the
  `pr-review` of clix#80 (`worker-ba1f019c7ecad4f7`, `claude-v0.1.1`)
  returned `pass` in round 1 after `make verify` at the bound detached
  head — "tree stayed clean; `git status --short` empty, HEAD unchanged
  throughout"; `golangci-lint 2.13.1 → 0 issues`; `go test ./...` ok — and
  clix#80 merged the same hour. The snowcat lane, broken all morning by the
  kit lock, completed four discoveries on the re-vendored kit.
- **Done when:** a Cockpit campaign on `std`, `clix`, and `updex` completes
  one item per repository whose retained worker terminal shows
  `golangci-lint run` executing from the image (no `go install`, no
  "skipping"), and one `pr-review` item completes with `git status
  --porcelain` empty after `make verify`. **Met 2026-08-24.** *`clix`:
  implement → draft clix#80 → `pr-review` pass → merged. `std`: std#61
  admitted → implementer on `claude-v0.1.1` verified with `make verify` →
  draft std#62 → `pr-review` pass in round 1 at the bound detached head
  ("golangci-lint 2.13.1 at the exact pin `0 issues.` on both passes")
  → the gate marked it ready. `updex`: five discoverers and a reviewer
  (updex#388 round 2, pass) ran on the image the moment the repository
  joined the node's catalog.*
- [x] **Cockpit:** enroll `updex` in the node's managed catalog. *Found
  late: `updex` was fleet-enabled in Core and had queued work all day, but
  Cockpit's catalog (`POST /api/v1/repositories`, node-local state) never
  listed it, so no lane claimed anything there and the queue looked frozen.
  A campaign snapshots the catalog at start; adding a repository needs a
  campaign restart. Fifth item for the Phase 1 Cockpit ADR: the catalog
  should derive from Core's enabled declarations (or at least report the
  difference), because a repository Core enables and Snowcat enrolls that
  no node works is invisible to everyone.*

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

- [x] **Snowcat ADR-0076** supersedes ADR-0075 (landed 2026-08-24; credential scopes go on the governance protected boundary, §5): keeps named gates, keeps
  "qualify before the lease, never inside it" and "absence is visible, never
  guessed", keeps credential scopes bound to paths (finding 13 — decide its
  home, see open questions); drops the core-owned `tools` schema, `optional`,
  `runtime`, and the enrollment-recorded profile. States the consumption
  contract: Snowcat's reviewer instructions name `make verify`; Snowcat
  records nothing about tools. Updates the **Execution profile** entry in the
  [ubiquitous language](../domain/ubiquitous-language.md), the "Decided:"
  pointers on findings 5, 7, and 13 in the [reality report](../design/reality.md),
  and the [work queue spec](../specs/work-queue.md) reviewer-instruction rule.
- [x] **core ADR-0043** (repository tooling convention; merged 2026-08-24; extends core
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
- [x] **Cockpit ADR-0012** (snowcat-cockpit#8, merged 2026-08-24): one provider-collapsed base image; repository tools
  provisioned at target preparation from `mise.lock` into a per-repository
  cache mounted read-only; `mise ls --missing` non-empty or Go not satisfying
  `go.mod` ⇒ lane unready with the reason named; the worker kit stops
  being a release-time vendored copy of Snowcat's skills (Phase 0's
  `degraded` campaign) — refreshed from a recorded source revision, or
  deferred to the checkout where the repository is the canonical source;
  and the managed-repository catalog derives from (or reports drift
  against) Core's enabled declarations rather than living only as
  node-local state (Phase 0's unenrolled `updex`). *Landed the same day as
  the ADR, from the first campaigns: cleanup compares owned skills against
  the worker's recorded kit (snowcat-cockpit#19); the lease relay binds its
  own token into every lifecycle call so a provider model never has to echo
  it (#22, after two Copilot reviewers lost healthy leases to a mangled
  token). Still open, each with evidence: #17 (a lane relaunches for an
  item its own live worker holds), #20 (retained workspaces fill the tmpfs
  — 181 in one day; cleaned 191 by hand), #21 (the implementer lane counts
  `release-needed` as claimable while the prompt excludes it). Provider
  note: Copilot completed the Phase 2 proof but, of five reviews, mangled
  the lease token twice and once invented a `gh` limitation the image does
  not have; Codex returned clean verdicts every time, so the campaign
  reviewer lane runs Codex by default and the per-provider MCP server name
  (`snowcat-mcp` for Copilot) lives in the campaign request.* Supersedes the "generic
  baseline" posture of
  [Cockpit ADR-0005](https://github.com/frostyard/snowcat-cockpit/blob/main/docs/adr/0005-isolate-unattended-workers-in-rootless-oci.md)
  without weakening any isolation rule.
- **Done when:** all three ADRs are Accepted and cross-linked, ADR-0075 is
  marked Superseded, `npm run check` passes here, and the glossary's
  **Execution profile** entry describes the convention, not a schema.
  **Met 2026-08-24** (glossary term is now *Repository tooling
  convention*).

## Phase 2 — Base image (snowcat-cockpit; one to two days)

- [x] Collapse the three Containerfiles into one `oci/Containerfile`
  carrying all three provider CLIs (snowcat-cockpit#11). *Shape changed
  from ADR-0012's sketch: instead of one entrypoint selecting the provider
  from a launch argument (a Cockpit code and spec change), the file has one
  `base` stage and three provider **targets** that add only an entrypoint —
  the three images share every layer (21 of 21 locally), the per-provider
  image variables keep working unchanged, and the provider entrypoints stay
  separate files, which is what let Codex's relay fix (#10) land in
  parallel without a conflict.*
- [x] Add `mise` 2026.8.12 (pinned, SHA256-verified per arch) with
  `MISE_DATA_DIR=/var/lib/snowcat-cockpit/mise` and `MISE_YES=1`; keep
  `GOTOOLCHAIN=local` (snowcat-cockpit#11).
- [x] Publish the baseline as data: `oci/baseline.json`, shipped in the
  image at `/usr/local/share/snowcat-cockpit/baseline.json`; the OCI
  workers spec references it (snowcat-cockpit#11). The stopgap
  `golangci-lint` is listed under `stopgap` so Phase 6 knows what to remove.
- [x] `worker-images.yml` builds the three targets of the one file
  (snowcat-cockpit#11, merged 2026-08-24). *The first publish (`v0.1.3`)
  failed on arm64 and exposed a latent bug in every earlier Containerfile:
  `ARG TARGETARCH=amd64` overrides buildx's per-platform value, so arm64
  images had been shipping amd64 Claude and Copilot binaries unnoticed —
  nothing executed what it fetched until the new `fetch` stage did.
  snowcat-cockpit#13 drops the default; `v0.1.4` is the first correct
  multi-architecture publish.* The published names stay
  `ghcr.io/frostyard/snowcat-cockpit-worker:<provider>-<version>` (a
  rename to `snowcat-worker-base` would break every node's configured
  reference for no gain — the base is the shared layer set, not a fourth
  tag). First publish on the next tag after #11 merges; roll the node.
- [x] **Codex workers register the projected lease relay** (snowcat-cockpit#10,
  by Codex, merged 2026-08-24; `v0.1.2`): a mode-0600 `--profile` file in
  the tmpfs `CODEX_HOME` layers the relay server and disables the direct
  one — verified against the pinned CLI, which documents `--profile` as
  "layer `$CODEX_HOME/<name>.config.toml`". *Second cause, found on
  `v0.1.4` when every Codex reviewer died with "connection closed:
  initialize response": Codex starts MCP servers with a scrubbed
  environment, and the relay reads `SNOWCAT_MCP_URL`/`SNOWCAT_MCP_TOKEN`
  from its own. snowcat-cockpit#14 forwards the two names through
  `env_vars` (no value in the file); `v0.1.5`.* Codex reviewers return to
  the campaign request.
- **Done when:** Codex, Claude, and Copilot workers each complete a Snowcat
  item from the same base digest, and `oci/baseline.json` is the only place
  the baseline is enumerated. *Inputs landed 2026-08-24 (the three targets
  share every layer; the spec references `baseline.json`); the three-provider
  completion: Claude proved on `v0.1.4` (std#64–66); Codex proved on
  `v0.1.5` — three reviewers completed, one `pass` on std#65 after `make
  verify` at the bound head and one legitimate `block` on std#66 (spec not
  updated for the new guarantee) that admitted a `pr-review-fix`, so the
  full gate loop now runs on Codex; Copilot proved on `v0.1.6` once the
  reviewer lane was switched to it for a run — `pass` on std#67 with the
  provisioned tools (`gpt-5.6-luna`). Its preflight first failed with
  "provider returned no valid preflight proof" because the host's Copilot
  MCP config names the server `snowcat-mcp`, not `snowcat`; the campaign
  request carries that per-provider name, and the preflight receipt should
  say so instead of "no proof".* **Met 2026-08-24.**

## Phase 3 — Pilot `std` on mise (std; half a day)

`std` is the pilot because its gate soft-skips lint today — the exact
failure the convention exists to end.

- [x] Add `mise.toml` (`[settings] idiomatic_version_file_enable_tools =
  ["go"]`, `lockfile = true`; `[tools] golangci-lint = "2.13.1"`) and run
  `mise install` to produce `mise.lock`; commit both (std#63).
- [x] Confirm mise resolves Go from `go.mod`. *It does — from the
  `toolchain go1.x.y` line, not the `go` directive: mise 2026.8 deprecates
  reading `go` ("only a minimum compatible version"; removal 2026.11), and
  `go mod tidy` drops a `toolchain` line equal to the `go` line. The
  convention is therefore `go 1.x` (minimum) + `toolchain go1.x.y` (the
  exact pin mise, `setup-go`, and `GOTOOLCHAIN=local` all read). Core
  ADR-0043's "go.mod is the only Go pin" holds; its conformance check reads
  the toolchain line.*
- [x] Makefile: `GOLANGCI_LINT_VERSION` is now read from `mise.toml` and
  `GO_TOOLCHAIN` from `go.mod`, so no version literal exists outside those
  two files; `lint` fails naming `mise install` when the tool is missing;
  `verify` unchanged from Phase 0 (std#63).
- [x] CI: `jdx/mise-action` (SHA-pinned v4.2.5) installs the locked tools;
  the Makefile `sed` and `golangci-lint-action` are gone; Go still comes
  from `setup-go` reading the same `go.mod` (std#63).
- [x] Guard: `make verify` compares `golangci-lint version`'s build Go
  against the toolchain line and fails naming the bump order when the
  linter is older (tested with a fake `built with go1.25.0` binary).
- **Done when:** `std` CI is green with no tool version stated anywhere but
  `go.mod` and `mise.toml`; on a fresh clone with mise and no other tools,
  `mise install && make verify` passes and `git status --porcelain` is
  empty; deleting the `golangci-lint` entry makes `make lint` fail rather
  than skip. *Local half met 2026-08-24 (fresh `MISE_DATA_DIR`, `mise
  install`, `verify` green, tree clean, lint fails without the tool); CI
  half met when std#63 merged the same day — the fleet's first
  `jdx/mise-action` run (its first attempt failed on a `lint-version-check`
  target `std` did not have; added).* **Met 2026-08-24.**

## Phase 4 — Prep-time provisioning (snowcat-cockpit; two days)

- [x] Provision at `Launch`, before any lease exists (snowcat-cockpit#12):
  `mise install --locked` in a throwaway container of the same pinned
  image, workspace read-only, a per-repository cache keyed by the digest of
  `mise.toml`/`mise.lock`/`go.mod` read-write, no provider input, no
  credential names. *Two things the sketch got wrong, found by running it:
  `Launch` (`internal/worker/worker.go`) is where the runtime and image are
  known — `target.go` is the in-container ADR-0073 checkout step, too late;
  and `mise install` rewrites `mise.lock` even when unchanged, so mise runs
  from a tmpfs copy of the three pin files and the workspace is never
  written. `--locked` refuses any tool the lock does not pre-resolve.*
- [x] Mount the cache read-only at the image's `MISE_DATA_DIR`; the shims
  directory is first on `PATH` by ENV *and* `/etc/profile.d`, because
  providers run repository commands through a login shell and Debian's
  `/etc/profile` resets `PATH` (snowcat-cockpit#12). No other mount change.
- [x] Readiness: `mise.toml` without a lock, a tool absent from the lock, a
  checksum mismatch, or a tool still missing after install fails the launch
  as `ErrNotReady` with mise's own line in the worker record; no provider
  starts; the campaign backs the lane off and shows the reason. Go from
  `go.mod`'s toolchain line is provisioned by the same lock, so the
  `GOTOOLCHAIN=local` case is covered by the same path.
- [x] The worker record carries `provisioning` — lock digest, cache path,
  installed `tool@version` list, timestamp.
- **Done when:** with `golangci-lint` still in the base (Phase 0), a `std`
  worker runs the lint from the mise cache (visible in the retained
  terminal's path), and a fixture repository whose `mise.lock` names a tool
  with a wrong checksum produces an unready lane naming that tool and no
  lease. *Second half proven against the built image on 2026-08-24
  (tampered checksum and a tool absent from the lock both refuse with the
  reason; unit tests pin the no-provider-starts path). First half met on
  `v0.1.4` (`v0.1.3`'s publish failed, see Phase 2): the first `std` batch —
  four implementers and a reviewer — all carry `provisioning: go@1.26.7,
  golangci-lint@2.13.1` from one cache (`463df448…`, provisioned once and
  reused four times), and two implementers ran `make verify`/`make check`
  green with lint hard-required before opening std#64/#65/#66; the image's
  `PATH` puts the cache's shims first, so that lint was the provisioned
  binary.* **Met 2026-08-24.**
- [x] **Follow-up found by the same batch (snowcat-cockpit#15 → #16,
  `v0.1.6`):** Docker mounts the home tmpfs `noexec` (Podman does not), and
  the image kept `GOPATH`/`GOCACHE` under `/home/cockpit`, so `go tool
  covdata` and anything Go executes from the cache failed; three workers
  (two implementers and a Codex reviewer) rediscovered the workaround
  inside their leases. Both now live under `/tmp` (already `exec`); the
  spec sentence that placed them under home is amended.

## Phase 5 — Fleet adoption (five repositories; one to two days of queue time)

Adoption is queue work: file one Snowcat issue per repository with the
[`write-snowcat-issues`](../../.agents/skills/write-snowcat-issues/SKILL.md)
skill (label `snowcat`, `requiredArtifact: pull-request`), and let Cockpit
lanes do it against the Phase 3 pattern. The Phase 4 node provisions from
whatever each repository declares, so a repository can adopt while others
have not.

- [x] `clix` and `updex`: mirror Phase 3 exactly (clix#81, updex#391 filed
  2026-08-24 with the exact scope; both on 2.13.1 since Phase 0). *Done by
  Cockpit workers the same day — clix#82 (Codex review `pass`, CI green)
  and updex#395 (merged). Both first attempts finished the whole change,
  `make verify` green, and then **blocked on the push**: the fleet worker
  credential is the operator's `gh` login and had no `workflow` OAuth
  scope, so GitHub refused `.github/workflows/**`. Finding 13 live, twice.
  The operator added the scope (`gh auth refresh -s
  repo,admin:org,gist,workflow`), the node was restarted so its serve
  wrapper re-projected `GH_TOKEN`, and both items were `requeue`d; the
  second attempts pushed. Until ADR-0076 §5's scope declaration lands on
  the governance boundary, this is discovered inside a lease.*
- [x] `snowcat`: `mise.toml` pins Node; `npm run verify` is the
  credential-free subset (snowcat#232, merged 2026-08-24). *The CI half
  (snowcat#233 → #236, `jdx/mise-action`) is open and ready for human
  merge.*
- [x] `core`: Node like `snowcat`; its `scripts/check-organization.mjs` is
  `verify` (core#109). *Was not importable while core's own declaration
  had `fleet_state: disabled`; core enabled itself with its own
  governance surface on 2026-08-24 (core#111 — the "distinct reviewed
  organization decision" its design doc reserved), enrolled on core
  snapshot 180, and the same evening a Cockpit implementer delivered
  core#112 (`mise.toml`/`mise.lock`, `npm run verify`, `ci.yml` on
  mise-action) — Codex review round 1 `pass`, CI green, a human marked it
  ready across the workflow boundary (ADR-0074) and merged it.*
- [x] `firn`: `verify`, hard-fail lint, and the mise pins in one change
  (firn#69 → firn#70, merged 2026-08-24 by a Cockpit worker).
- [x] `snowcat-cockpit`: the Phase P deferred items landed 2026-08-24
  (core#110 declaration, snowcat-cockpit#23 governance surface — five
  review-required boundaries from the schema's closed id vocabulary),
  Cockpit enrolled on core snapshot 153, opted in with the review gate
  on, and the adoption issue (snowcat-cockpit#24, mirrors std#63, `oci/`
  left for Phase 6) was imported by the timer and delivered by a Cockpit
  implementer as snowcat-cockpit#27 the same hour: `mise.toml`,
  `mise.lock`, `toolchain go1.26.7`, `verify`, `test.yml` on mise-action
  with `Install pinned tools` visible in the `Repository gate` log; Codex
  review round 1 `pass`; human-marked ready across the workflow boundary
  and merged. Left over: the link-only repair to the sentence in Cockpit's
  ADR-0012 that names the Makefile pin (issue step 5) was not made.
- [ ] Core distributes the shared pieces the same way it distributes
  skills — *not yet needed: every adoption so far was a worker copying the
  `std` pilot from its issue text; revisit if a new Go repository joins*
  (core
  [ADR-0026](https://github.com/frostyard/core/blob/main/docs/adr/0026-distribute-core-skills-via-sync-prs.md)):
  a `mise.toml` settings block, the `verify` Makefile snippet, and the
  mise CI step as templates.
- **Done when:** every enabled declaration's repository has `mise.toml`,
  `mise.lock`, `make verify`, and CI installing from those files; a Cockpit
  campaign across all six completes at least one item each with no
  in-lease tool install in any retained terminal. **Met 2026-08-24
  evening:** all seven declarations are `enabled` and `enrolled`; `std`,
  `clix`, `updex`, `firn`, `snowcat` (#232 + #236), `core` (#112), and
  `snowcat-cockpit` (#27) each carry the pins and the `verify` gate with
  CI installing from the lock; the first campaign on the `v0.1.6` node
  completed at least one item per repository, and the last two (core#112,
  snowcat-cockpit#27) were built by lanes provisioned from the
  repository's own lock — the mise-action step is in their CI logs and
  no tool install appears in the lease. snowcat#241, a second worker's
  competing implementation of the `check.yml` change, was closed as
  superseded by #236 once the default-branch ruleset moved from `check
  (node 24)`/`check (node 26)` to `check`.

## Phase 6 — Retire the stopgap (snowcat-cockpit, core; half a day)

- [ ] Remove `golangci-lint` from the base image and `oci/baseline.json`;
  workers now get it only from the mise cache. Republish, roll the digest.
  *Queued 2026-08-24 as snowcat-cockpit#29; delivered by a Cockpit lane
  as snowcat-cockpit#33 (Containerfile ARG, fetch block, `COPY`, the
  `baseline.json` `stopgap` object, and the OCI workers spec) — Codex
  review round 1 `pass`, merged the same night. The tag and the digest
  roll stay with the operator (Cockpit's latest tag before this is
  `v0.2.0`).*
- [x] Remove every remaining Makefile `GOLANGCI_LINT_VERSION` and
  soft-skip across the fleet (Phase 5 should leave none; verify with a
  fleet grep). *Fleet grep 2026-08-24 evening: no version literal in any
  Makefile (all five Go repositories read
  `GOLANGCI_LINT_VERSION` from `mise.toml`), no workflow installs the
  linter outside mise-action, and the `command -v golangci-lint` branch
  in `std`/`clix`/`updex`/`firn` is ADR-0043's fail-with-install-command
  path ("provision every pinned tool with: mise install", exit 1), not a
  skip. Nothing to remove.*
- [ ] core: add the convention check to `check-organization.mjs` or the
  repository-surfaces conformance path — `mise.toml` and `mise.lock`
  present and parseable, `verify`/`check`/`ci` targets present — so a
  repository that drops the convention fails core's gate, not a worker's
  lease. *Queued 2026-08-24 as core#117 with the design fixed: a
  `scripts/check-fleet-conventions.mjs` that reads each enabled
  declaration's default-branch head through the GitHub contents API
  (presence only, never a version), Go repositories by Makefile targets
  and Node repositories by `package.json` scripts, run as its own
  `fleet-conventions` CI job rather than inside the offline `npm run
  check`; making it a required check is an operator step afterwards.
  Delivered as core#118 and merged 2026-08-25. Its first run found real
  drift — `clix` and `firn` had `verify`/`check` but no `ci:` target —
  fixed the same evening as clix#85 and firn#77 (firn's ruleset needed
  the same required-contexts repair as snowcat's when the worker
  consolidated jobs into one `Repository gate`). Two review rounds
  blocked on "CI not green": round 1 correctly, round 2 falsely — the
  reviewer read the pull request's stale body instead of the head's
  check runs (snowcat#248 is the instruction fix). The required-check
  step (`apply-repo-settings.sh frostyard/core --required-checks
  "docs-gate,scaffold-e2e,fleet-conventions"`) is still open.*
- [ ] Snowcat: a maintenance-program probe (catalog in
  [`src/queue/programs.ts`](../../src/queue/programs.ts)) that runs `make
  verify` on a clean checkout and proposes a `quality` item when the tree
  is dirty afterwards — the mechanical "a profile can lie" check ADR-0075
  wanted, now against a Makefile instead of a schema. *Queued 2026-08-24
  as snowcat#245: the `conformance` discovery root alone gains
  `run-tests`, runs `make verify`/`npm run verify` on its detached
  read-only checkout, and reports `git status --porcelain` afterwards;
  every other discovery root stays `read` + `create-followup`, no new
  program, no ADR. Delivered as snowcat#247, merged 2026-08-24 and
  deployed to the host 2026-08-25 (`0303dbe`).*
- [ ] **`make verify` everywhere (core ADR-0044, accepted 2026-08-24):**
  the false block on core#118 round 2 came from a reviewer running `make
  verify` in a Node repository that only had `npm run verify`; every
  consumer of the gate had grown a language branch. ADR-0044 widens
  ADR-0043's triad to every repository — Node Makefiles wrap the npm
  scripts — so instructions name `make verify` unconditionally. Queue
  work, in order: Makefiles for `snowcat` (snowcat#249) and `core`
  (core#120); then core's `check-fleet-conventions.mjs` drops its Node
  branch and the conformance program text drops "`npm run verify` where
  `package.json` declares it" (to file once the Makefiles land); the
  reviewer-instruction fix (snowcat#248: read the head's check runs, never
  the description; `make verify` unconditional, a missing target is a
  blocker) can land in parallel. *All merged 2026-08-25 early:
  core#121 and snowcat#254 (Makefiles), core#126 (check requires the
  triad everywhere), snowcat#261 (conformance text), snowcat#253
  (reviewer instructions), and snowcat#263 (workers fill the pull-request
  template — the description-only block that stalled four snowcat and
  four updex pull requests that night; Cockpit re-locks its kit in
  snowcat-cockpit#43). The host runs `7e939df`.*
- **Done when:** the base image contains no repository-specific tool, and a
  deliberately dirty `verify` in a fixture repository yields one proposed
  Snowcat item naming the mutation. **Met 2026-08-25:** the image published
  from snowcat-cockpit#33 carries no `golangci-lint` (baseline `stopgap`
  object gone) and the node's digest was rolled the same night; the
  `conformance` discovery root now runs `make verify` and reports `git
  status --porcelain` on every enrolled repository (snowcat#247, #261),
  which is the mechanism — the first deliberately dirty fixture is Phase
  7's job to stage, since every live repository's `verify` is clean today.
  Beyond the plan: `fleet-conventions` is a required check on core, and
  ADR-0044 made the three `make` targets universal.

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

## Where we stand — 2026-08-24, end of day

**Met:** Phases 0, P, 1, 2, 3, 4, 5, 6. Every fleet repository that Snowcat works
(`std`, `clix`, `updex`, `firn`, `snowcat`, `core`, `snowcat-cockpit`) pins
its tools in `mise.toml`/`mise.lock` and exposes the `verify` gate; Cockpit `v0.1.6`
builds one base image with three provider targets, provisions each worker's
tools from its repository's lock before the lease, and runs Claude, Codex,
and Copilot workers on it. The operator node is on the `v0.1.6` line with
the cleanup (#19) and relay (#22) fixes installed; the reviewer lane runs
Codex.

**Outstanding, in order:**

1. **Phase 5 closed 2026-08-24 evening** — #236 merged after the ruleset
   moved to `check`; core#110/#111 and snowcat-cockpit#23 merged; Cockpit
   and core enrolled, opted in, review-gated; core#112 and
   snowcat-cockpit#27 delivered, reviewed, and merged. The ADR-0012
   "loose end" was moot — that ADR names the `v0.1.1` stopgap image as
   history, not a Makefile pin, and accepted ADRs are immutable; the
   core-side presence check is Phase 6's third item, now core#117.
2. **Phase 6 met 2026-08-25 ~02:00 UTC** — image republished and rolled,
   fleet grep clean, `fleet-conventions` required on core, verify probe
   live, and the six ADR-0044 follow-ups merged; host at `7e939df`.
   Phase 7 (pin-bump automation) is next; its first act should be the
   dirty-`verify` fixture that proves the probe end to end.
3. **Phase 6 — retire the stopgap:** `golangci-lint` still ships in the base
   image and `oci/baseline.json` lists it under `stopgap`; with every
   enrolled repository now on `mise.lock`, remove it, republish, roll. The
   `verify`-cleanliness probe in the program catalog is unwritten.
4. **Phase 7 — pin-bump automation:** nothing built; the Go/lint pair-bump
   convention is enforced only by `lint-version-check` after the fact.
5. **Cockpit follow-ups with evidence:** #17 (lane relaunches for an item its
   own live worker holds — one wasted container start per five minutes per
   long item), #20 (retained workspaces on a tmpfs; cleanup is manual — 196
   cleaned by hand today), #21 (`release-needed` counted claimable while
   the prompt excludes it). ADR-0012 §5–6 (kit refreshed from its source;
   catalog derived from Core) remain design-only.
6. **ADR-0076 §5 — credential scopes on the boundary:** not started. The
   `workflow`-scope wall cost three leases today; until core's governance
   schema carries `github:workflow` on `.github/workflows/**` and the queue
   surfaces it, a worker discovers it inside the lease.
7. **Provider reliability, observed not fixed:** Copilot mangled the lease
   token twice (relay now immune) and once invented a `gh` limitation; keep
   it off the reviewer lane until a run shows otherwise. A Codex reviewer
   (`gpt-5.3-codex`, core#118 round 2) judged a CI criterion from the
   pull request's body rather than the head's check runs — the body was
   the author's claim from the previous head. snowcat#248 makes the
   instructions demand the check runs; until it lands, treat a "CI not
   green" blocker as unverified until the head's runs are read.

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

- ~~Does mise read `go.mod`?~~ Resolved in Phase 3: yes, via the
  `toolchain` line (see Phase 3).
- ~~Is `mise.lock` an ADR-0023-grade registry?~~ Resolved in Phase 3: yes —
  per-platform URL + SHA256, GitHub artifact attestations verified at
  install, and a tampered checksum is refused with expected/actual for
  both Go and golangci-lint (tested 2026-08-24).
- ~~Where do credential scopes live?~~ Resolved by
  [ADR-0076](../adr/0076-pin-repository-tools-in-the-repository-and-qualify-lanes-by-running-them.md)
  §5: on the governance surface's protected boundary.
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
