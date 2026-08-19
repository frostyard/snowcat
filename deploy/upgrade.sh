#!/usr/bin/env bash
# Upgrade the operator's Snowcat checkout in place and restart the timers.
#
#   deploy/upgrade.sh          (as the operator user; timers restart via sudo
#                               when not root — set SNOWCAT_SYSTEMCTL to override)
#
# Steps: `git pull --ff-only`, `npm ci`, `npm run check`, restart the six
# timers, then remind you to restart every MCP client. If `check` fails the
# script exits non-zero and leaves the checkout on the new commit so you can
# inspect it; the timers are not restarted. If the pull changed anything under
# deploy/systemd/ or deploy/env.example, it tells you to re-run
# `sudo deploy/install.sh` so /etc/systemd/system matches the checkout.
#
# Run this only in the operator's checkout named by SNOWCAT_HOME in
# /etc/snowcat/env — never in a worker's checkout, and never with a feature
# branch checked out: `git pull --ff-only` refuses to move a diverged branch.
#
# The body lives in main() so bash parses the whole file before the pull
# rewrites it underneath the running process, and when the pull changes this
# script itself the new version is exec'd once (SNOWCAT_UPGRADE_REEXEC guards
# against loops) so the steps after the pull are the new commit's, not a mix.
set -euo pipefail

main() {
snowcat_home="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$snowcat_home"

if [[ -n ${SNOWCAT_SYSTEMCTL:-} ]]; then
  read -r -a systemctl <<< "$SNOWCAT_SYSTEMCTL"
elif [[ $EUID -eq 0 ]]; then
  systemctl=(systemctl)
else
  systemctl=(sudo systemctl)
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
# After a re-exec, `before` is the commit the first run started from, so the
# summary and the deploy/ diff below still describe the whole upgrade.
before="${SNOWCAT_UPGRADE_BEFORE:-$(git rev-parse HEAD)}"
echo "upgrade: $snowcat_home on $branch at ${before:0:12}"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "upgrade: the checkout has local modifications; commit, stash, or discard them first" >&2
  exit 1
fi

git pull --ff-only
after="$(git rev-parse HEAD)"
if [[ $before == "$after" ]]; then
  echo "upgrade: already at ${after:0:12}; re-checking and restarting timers anyway"
else
  echo "upgrade: ${before:0:12} -> ${after:0:12}"
  if [[ -z ${SNOWCAT_UPGRADE_REEXEC:-} ]] && [[ -n "$(git diff --name-only "$before" "$after" -- deploy/upgrade.sh)" ]]; then
    echo "upgrade: deploy/upgrade.sh changed in this pull; continuing with the new version"
    SNOWCAT_UPGRADE_REEXEC=1 SNOWCAT_UPGRADE_BEFORE="$before" exec bash "$snowcat_home/deploy/upgrade.sh" "$@"
  fi
fi

npm ci
if ! npm run check; then
  echo "upgrade: npm run check FAILED at ${after:0:12}; the checkout stays on this commit for inspection." >&2
  echo "upgrade: timers were NOT restarted. Fix or roll back (git checkout ${before:0:12}) and re-run." >&2
  exit 1
fi

timers=(snowcat-seed-dogfood.timer snowcat-import-issues.timer snowcat-sweep-dependencies.timer snowcat-sweep-settings.timer snowcat-verify.timer snowcat-backup.timer)
"${systemctl[@]}" daemon-reload
"${systemctl[@]}" restart "${timers[@]}"
echo "upgrade: restarted ${timers[*]}"
# The surface serves the built bundle (npm run check already built it); restart
# it only where it is installed and enabled — a laptop running `npm run serve`
# by hand is left alone.
if "${systemctl[@]}" is-enabled --quiet snowcat-surface.service 2>/dev/null; then
  "${systemctl[@]}" restart snowcat-surface.service
  echo "upgrade: restarted snowcat-surface.service"
fi

if [[ $before != "$after" ]] && [[ -n "$(git diff --name-only "$before" "$after" -- deploy/systemd deploy/env.example deploy/install.sh)" ]]; then
  echo "upgrade: deploy/ changed in this upgrade — run 'sudo $snowcat_home/deploy/install.sh' to refresh the installed units and drop-ins."
fi

cat <<'REMINDER'
upgrade: done. Now restart every MCP client (Claude Code, Codex, ...) that has the
upgrade: snowcat server open: an already-running server refuses its next write once
upgrade: the queue schema moves forward (work-queue spec, rule 21).
REMINDER
}

main "$@"
