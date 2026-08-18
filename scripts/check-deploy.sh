#!/usr/bin/env bash
# `npm run check:deploy`: lint the host deployment files under deploy/.
#
# 1. `bash -n` and `shellcheck` on every script in deploy/bin/.
# 2. `systemd-analyze verify` on every unit in deploy/systemd/, run against a
#    throwaway --root that holds a stub /etc/fluent/env, stub `npm` and
#    `/bin/bash` executables, and stub default-dependency targets, so the
#    result is the same on any host with systemd and never depends on what is
#    installed there. Any diagnostic at all (error or warning) fails the check.
#
# Both tools are required: a missing tool fails the check rather than passing
# silently, so a local pass is a CI pass.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo"

for tool in shellcheck systemd-analyze; do
  if ! command -v "$tool" > /dev/null 2>&1; then
    echo "check:deploy: $tool is required but not installed" >&2
    exit 1
  fi
done

shopt -s nullglob
scripts=(deploy/bin/*)
units=(deploy/systemd/*.service deploy/systemd/*.timer)
shopt -u nullglob
if [[ ${#scripts[@]} -eq 0 || ${#units[@]} -eq 0 ]]; then
  echo "check:deploy: expected scripts in deploy/bin/ and units in deploy/systemd/" >&2
  exit 1
fi

for script in "${scripts[@]}"; do
  bash -n "$script"
  shellcheck "$script"
done
echo "check:deploy: shellcheck ok (${scripts[*]})"

root="$(mktemp -d "${TMPDIR:-/tmp}/fluent-check-deploy.XXXXXX")"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/etc/fluent" "$root/etc/systemd/system" "$root/usr/bin" "$root/bin"
cat > "$root/etc/fluent/env" <<'ENV'
FLUENT_HOME=/opt/fluent
FLUENT_QUEUE_DB=/var/lib/fluent/queue.db
FLUENT_CONTROL_DB=/var/lib/fluent/control-plane.db
FLUENT_GITHUB_TOKEN=stub
ENV
printf '#!/bin/sh\nexit 0\n' > "$root/usr/bin/npm"
printf '#!/bin/sh\nexit 0\n' > "$root/bin/bash"
chmod 0755 "$root/usr/bin/npm" "$root/bin/bash"
# Targets our units reach through default dependencies and [Install]; the
# stubs stand in for the host's real targets inside the verification root.
for target in sysinit basic shutdown timers time-sync time-set network-online; do
  printf '[Unit]\nDescription=stub %s.target\n' "$target" > "$root/etc/systemd/system/$target.target"
done
cp "${units[@]}" "$root/etc/systemd/system/"

names=()
for unit in "${units[@]}"; do names+=("$(basename "$unit")"); done
output="$(systemd-analyze --root="$root" verify "${names[@]}" 2>&1)" && status=0 || status=$?
if [[ $status -ne 0 || -n "$output" ]]; then
  echo "check:deploy: systemd-analyze verify reported problems (exit $status):" >&2
  printf '%s\n' "$output" >&2
  exit 1
fi
echo "check:deploy: systemd-analyze verify ok (${names[*]})"
