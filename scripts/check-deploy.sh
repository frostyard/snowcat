#!/usr/bin/env bash
# `npm run check:deploy`: lint the host deployment files under deploy/.
#
# 1. `bash -n` and `shellcheck` on every script in deploy/bin/ and deploy/*.sh.
# 2. `systemd-analyze verify` on every unit in deploy/systemd/, run against a
#    throwaway --root that holds a stub /etc/fluent/env, stub `npm` and
#    `/bin/bash` executables, and stub default-dependency targets, so the
#    result is the same on any host with systemd and never depends on what is
#    installed there. Any diagnostic at all (error or warning) fails the check.
# 3. deploy/install.sh twice against FLUENT_INSTALL_ROOT=$(mktemp -d) with
#    systemctl stubbed (FLUENT_SYSTEMCTL=true): the second run must change
#    nothing (`diff -r` of the root before/after) and must leave a pre-existing
#    /etc/fluent/env untouched; then the installed units plus their drop-ins
#    are verified in that root the same way.
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
scripts=(deploy/bin/* deploy/*.sh)
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
install_root="$(mktemp -d "${TMPDIR:-/tmp}/fluent-check-install.XXXXXX")"
install_snapshot="$(mktemp -d "${TMPDIR:-/tmp}/fluent-check-install-snapshot.XXXXXX")"
trap 'rm -rf "$root" "$install_root" "$install_snapshot"' EXIT

# Stub default-dependency targets our units reach through DefaultDependencies
# and [Install]; they stand in for the host's real targets inside a
# verification root.
stub_targets() {
  local dir="$1" target
  for target in sysinit basic shutdown timers time-sync time-set network-online; do
    printf '[Unit]\nDescription=stub %s.target\n' "$target" > "$dir/$target.target"
  done
}

# verify_root <root> <label> <unit-name>...: systemd-analyze verify inside
# <root>; any output at all is a failure.
verify_root() {
  local verify_dir="$1" label="$2"
  shift 2
  local output status=0
  output="$(systemd-analyze --root="$verify_dir" verify "$@" 2>&1)" || status=$?
  if [[ $status -ne 0 || -n $output ]]; then
    echo "check:deploy: systemd-analyze verify ($label) reported problems (exit $status):" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
  echo "check:deploy: systemd-analyze verify ok ($label: $*)"
}

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
stub_targets "$root/etc/systemd/system"
cp "${units[@]}" "$root/etc/systemd/system/"

names=()
for unit in "${units[@]}"; do names+=("$(basename "$unit")"); done
verify_root "$root" "shipped units" "${names[@]}"

# Install dry run, twice. FLUENT_SYSTEMCTL=true stubs systemctl so the
# enable/start path is exercised without touching the host.
FLUENT_INSTALL_ROOT="$install_root" FLUENT_SYSTEMCTL=true deploy/install.sh > "$install_root.first.log"
env_file="$install_root/etc/fluent/env"
[[ -f $env_file ]] || { echo "check:deploy: install.sh did not create etc/fluent/env" >&2; exit 1; }
marker="# check:deploy marker $(basename "$install_root")"
printf '%s\n' "$marker" >> "$env_file"
cp -a "$install_root/." "$install_snapshot/"
FLUENT_INSTALL_ROOT="$install_root" FLUENT_SYSTEMCTL=true deploy/install.sh > "$install_root.second.log"
if ! diff -r "$install_snapshot" "$install_root" > "$install_root.diff"; then
  echo "check:deploy: second install.sh run changed the install root:" >&2
  cat "$install_root.diff" >&2
  exit 1
fi
if ! grep -qxF "$marker" "$env_file"; then
  echo "check:deploy: install.sh overwrote an existing etc/fluent/env" >&2
  exit 1
fi
if grep -q "created\|updated" "$install_root.second.log"; then
  echo "check:deploy: second install.sh run reported changes:" >&2
  cat "$install_root.second.log" >&2
  exit 1
fi
rm -f "$install_root.first.log" "$install_root.second.log" "$install_root.diff"
echo "check:deploy: install.sh double run ok (no changes on second run; existing env preserved)"

# The installed units plus their drop-ins verify inside the install root:
# stub the absolute npm the drop-ins name, /bin/bash, and the targets.
npm_path="$(command -v npm)"
mkdir -p "$install_root$(dirname "$npm_path")" "$install_root/bin"
printf '#!/bin/sh\nexit 0\n' > "$install_root$npm_path"
printf '#!/bin/sh\nexit 0\n' > "$install_root/bin/bash"
chmod 0755 "$install_root$npm_path" "$install_root/bin/bash"
stub_targets "$install_root/etc/systemd/system"
verify_root "$install_root" "installed units with drop-ins" "${names[@]}"
