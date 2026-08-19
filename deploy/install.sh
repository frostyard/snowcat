#!/usr/bin/env bash
# Install or refresh the Snowcat v1 single-host deployment. Idempotent: run it
# again after `git pull` or to repair a host; it reports what it created and
# what it kept.
#
#   sudo deploy/install.sh [--user OPERATOR]
#
# What it does (and nothing else):
#   1. creates /var/lib/snowcat and /var/backups/snowcat (0750, owned by the
#      operator user — --user, else the sudo caller, else the invoking user);
#   2. writes /etc/snowcat/env (0600) from deploy/env.example ONLY IF ABSENT,
#      with SNOWCAT_HOME set to this checkout and the database paths under
#      /var/lib/snowcat; an existing file is never modified;
#   3. installs deploy/systemd/*.service and *.timer into /etc/systemd/system
#      plus one drop-in per service (10-install.conf) that sets User=, an
#      absolute ExecStart= for the npm found on PATH (systemd's fixed search
#      path does not include version managers such as Homebrew or nvm), a
#      PATH= that lets that npm find its node, and ReadWritePaths= for the
#      real SNOWCAT_HOME;
#   4. `systemctl daemon-reload`, then enables and starts the six timers.
#
# It never runs `core -- activate`, never opens or moves a database, and never
# touches the operator's shell configuration.
#
# Knobs:
#   SNOWCAT_NPM=/path/to/npm    npm to run from the units (default: the operator
#   SNOWCAT_NODE=/path/to/node  user's login-shell `command -v npm`/`node`)
#   SNOWCAT_INSTALL_ROOT=<dir>  install under <dir> instead of / (no root needed;
#                              systemctl is skipped unless SNOWCAT_SYSTEMCTL is set)
#   SNOWCAT_SYSTEMCTL=<cmd>     command used instead of systemctl (e.g. `true`)
set -euo pipefail

usage() {
  echo "usage: sudo deploy/install.sh [--user OPERATOR]" >&2
  exit 2
}

install_user=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      [[ $# -ge 2 ]] || usage
      install_user="$2"
      shift 2
      ;;
    -h | --help) usage ;;
    *) usage ;;
  esac
done

snowcat_home="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
root="${SNOWCAT_INSTALL_ROOT:-}"
root="${root%/}"
if [[ -z $root && $EUID -ne 0 ]]; then
  echo "install: run as root (sudo deploy/install.sh) or set SNOWCAT_INSTALL_ROOT for a dry run" >&2
  exit 1
fi
if [[ -z $install_user ]]; then
  install_user="${SUDO_USER:-$(id -un)}"
fi
if ! id "$install_user" > /dev/null 2>&1; then
  echo "install: user $install_user does not exist" >&2
  exit 1
fi
install_group="$(id -gn "$install_user")"
if [[ $install_user == root ]]; then
  echo "install: warning: units will run as root; pass --user OPERATOR to use the operator account" >&2
fi

# resolve_tool <name> <override-variable>: the override, else the first
# executable absolute path among: the tool as the operator user's login shell
# sees it (sudo resets PATH, and version managers such as Homebrew or nvm live
# in the user's profile); the same through an interactive login shell (Homebrew's
# `brew shellenv` commonly sits in ~/.bashrc behind an "if not interactive,
# return" guard, so a plain login shell never sees it); our own PATH; and the
# well-known Homebrew prefixes.
resolve_tool() {
  local name="$1" override="${2:-}" candidate found="" home prefix
  local -a candidates=()
  if [[ -n $override ]]; then
    candidates+=("$override")
  else
    if [[ $install_user != "$(id -un)" ]]; then
      candidates+=("$(sudo -u "$install_user" -i sh -c "command -v $name" 2> /dev/null | tail -n 1 || true)")
      candidates+=("$(sudo -u "$install_user" -i bash -lic "command -v $name" 2> /dev/null | tail -n 1 || true)")
    fi
    candidates+=("$(command -v "$name" || true)")
    home="$(getent passwd "$install_user" | cut -d: -f6)"
    for prefix in /home/linuxbrew/.linuxbrew "${home:-/nonexistent}/.linuxbrew" /opt/homebrew /usr/local; do
      candidates+=("$prefix/bin/$name")
    done
  fi
  for candidate in "${candidates[@]}"; do
    if [[ -n $candidate && $candidate == /* && -x $candidate ]]; then
      found="$candidate"
      break
    fi
  done
  if [[ -z $found ]]; then
    echo "install: cannot find an executable $name for user $install_user; install Node 24+ or set SNOWCAT_${name^^}=/path/to/$name" >&2
    exit 1
  fi
  printf '%s\n' "$found"
}
npm_path="$(resolve_tool npm "${SNOWCAT_NPM:-}")"
node_path="$(resolve_tool node "${SNOWCAT_NODE:-}")"
npm_dir="$(dirname "$npm_path")"
node_dir="$(dirname "$node_path")"
service_path="$npm_dir"
[[ $node_dir == "$npm_dir" ]] || service_path="$npm_dir:$node_dir"
service_path="$service_path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

if [[ -n ${SNOWCAT_SYSTEMCTL:-} ]]; then
  read -r -a systemctl <<< "$SNOWCAT_SYSTEMCTL"
elif [[ -n $root ]]; then
  systemctl=()
else
  systemctl=(systemctl)
fi

state_dir="$root/var/lib/snowcat"
backup_dir="$root/var/backups/snowcat"
env_dir="$root/etc/snowcat"
env_file="$env_dir/env"
unit_dir="$root/etc/systemd/system"
env_example="$snowcat_home/deploy/env.example"
units_source="$snowcat_home/deploy/systemd"

# Owner arguments only when we can actually change ownership.
chown_args=()
if [[ $EUID -eq 0 ]]; then chown_args=(-o "$install_user" -g "$install_group"); fi

report() { echo "install: $*"; }

# ensure_dir <path> <mode> [owned]: create if missing, always converge mode
# (and ownership when running as root and "owned" is given).
ensure_dir() {
  local path="$1" mode="$2" owned="${3:-}"
  if [[ -d $path ]]; then
    report "kept $path"
  else
    mkdir -p "$path"
    report "created $path"
  fi
  chmod "$mode" "$path"
  if [[ -n $owned && $EUID -eq 0 ]]; then chown "$install_user:$install_group" "$path"; fi
}

# install_file <source> <target> <mode> [owned]: write only when content differs.
install_file() {
  local source="$1" target="$2" mode="$3" owned="${4:-}"
  local args=(-m "$mode")
  if [[ -n $owned ]]; then args+=("${chown_args[@]}"); fi
  if [[ -f $target ]] && cmp -s "$source" "$target"; then
    report "kept $target"
  else
    if [[ -f $target ]]; then report "updated $target"; else report "created $target"; fi
    install "${args[@]}" "$source" "$target"
  fi
}

# 0. Snowcat ADR-0064: a host installed under the old name (Fluent) is
# migrated in place, once — directories are MOVED (never copied), the env
# file is rewritten with SNOWCAT_* keys and the new paths, and the old timers
# are stopped and their unit files removed after the new ones exist. Nothing
# happens when the legacy paths are absent or the new ones already exist.
legacy_state_dir="$root/var/lib/fluent"
legacy_backup_dir="$root/var/backups/fluent"
legacy_env_file="$root/etc/fluent/env"
legacy_migrated=0
if [[ -d $legacy_state_dir && ! -e $state_dir ]]; then
  mv "$legacy_state_dir" "$state_dir"
  report "moved $legacy_state_dir -> $state_dir (Fluent -> Snowcat)"
  legacy_migrated=1
fi
if [[ -d $legacy_backup_dir && ! -e $backup_dir ]]; then
  mv "$legacy_backup_dir" "$backup_dir"
  report "moved $legacy_backup_dir -> $backup_dir"
  legacy_migrated=1
fi
if [[ -f $legacy_env_file && ! -e $env_file ]]; then
  ensure_dir "$env_dir" 0755
  rendered="$(mktemp)"
  sed -e 's/^FLUENT_/SNOWCAT_/' \
    -e "s|/var/lib/fluent|/var/lib/snowcat|g" \
    -e "s|/var/backups/fluent|/var/backups/snowcat|g" \
    -e "s|/etc/fluent|/etc/snowcat|g" \
    "$legacy_env_file" > "$rendered"
  install -m 0600 "${chown_args[@]}" "$rendered" "$env_file"
  rm -f "$rendered"
  report "migrated $legacy_env_file -> $env_file (SNOWCAT_* keys, new paths; the old file is kept until you remove it)"
  legacy_migrated=1
fi

# 1. Data directories.
ensure_dir "$state_dir" 0750 owned
ensure_dir "$backup_dir" 0750 owned

# 2. Environment file, only if absent.
ensure_dir "$env_dir" 0755
if [[ -e $env_file ]]; then
  report "kept existing $env_file (not modified)"
else
  rendered="$(mktemp)"
  sed \
    -e "s|^SNOWCAT_HOME=.*|SNOWCAT_HOME=$snowcat_home|" \
    -e "s|^SNOWCAT_QUEUE_DB=.*|SNOWCAT_QUEUE_DB=$state_dir/queue.db|" \
    -e "s|^SNOWCAT_CONTROL_DB=.*|SNOWCAT_CONTROL_DB=$state_dir/control-plane.db|" \
    "$env_example" > "$rendered"
  install -m 0600 "${chown_args[@]}" "$rendered" "$env_file"
  rm -f "$rendered"
  report "created $env_file from deploy/env.example — fill in SNOWCAT_GITHUB_TOKEN"
fi

# 3. Units and per-service drop-ins.
ensure_dir "$unit_dir" 0755
for unit in "$units_source"/*.service "$units_source"/*.timer; do
  install_file "$unit" "$unit_dir/$(basename "$unit")" 0644
done

# write_dropin <service> <rw-paths> <exec-start>...: one ExecStart= per
# command, in order (a oneshot unit runs them sequentially and stops at the
# first failure), after clearing the unit's own ExecStart=.
write_dropin() {
  local service="$1" rw_paths="$2"
  shift 2
  local dir="$unit_dir/$service.d"
  ensure_dir "$dir" 0755
  local exec_lines="" exec_start
  for exec_start in "$@"; do
    exec_lines+="ExecStart=$exec_start"$'\n'
  done
  local rendered
  rendered="$(mktemp)"
  cat > "$rendered" <<DROPIN
# Written by deploy/install.sh for SNOWCAT_HOME=$snowcat_home; re-run it to
# regenerate. Edit deploy/systemd/ in the checkout, not this file.
[Service]
User=$install_user
Environment=PATH=$service_path
ExecStart=
${exec_lines}ReadWritePaths=
ReadWritePaths=$rw_paths
DROPIN
  install_file "$rendered" "$dir/10-install.conf" 0644
  rm -f "$rendered"
}

write_dropin snowcat-seed-dogfood.service \
  "$state_dir -$snowcat_home/data" \
  "$npm_path --prefix $snowcat_home run --silent queue -- seed-dogfood --enrolled"
write_dropin snowcat-import-issues.service \
  "$state_dir -$snowcat_home/data" \
  "$npm_path --prefix $snowcat_home run --silent queue -- import-issues --enrolled --label snowcat"
write_dropin snowcat-sweep-dependencies.service \
  "$state_dir -$snowcat_home/data" \
  "$npm_path --prefix $snowcat_home run --silent queue -- sweep-dependencies --enrolled"
write_dropin snowcat-sweep-settings.service \
  "$state_dir -$snowcat_home/data" \
  "$npm_path --prefix $snowcat_home run --silent queue -- sweep-repository-settings --enrolled"
write_dropin snowcat-verify.service \
  "$state_dir -$snowcat_home/data" \
  "$npm_path --prefix $snowcat_home run --silent queue -- verify-artifacts"
write_dropin snowcat-surface.service \
  "$state_dir -$snowcat_home/data" \
  "$npm_path --prefix $snowcat_home run --silent serve"
write_dropin snowcat-backup.service \
  "$state_dir $backup_dir -$snowcat_home/data" \
  "/bin/bash $snowcat_home/deploy/bin/snowcat-backup"

# 3b. Retire units this installer used to write and no longer ships, after
# the current ones exist: the Fluent-named trio, and the combined
# snowcat-feed pair that the four per-command feeder units replaced. Stop and
# disable, then remove the unit files and their drop-ins. Only files under
# this installer's control are touched.
legacy_units=()
for legacy in fluent-feed fluent-verify fluent-backup snowcat-feed; do
  for suffix in timer service; do
    if [[ -e $unit_dir/$legacy.$suffix ]]; then legacy_units+=("$legacy.$suffix"); fi
  done
done
if [[ ${#legacy_units[@]} -gt 0 ]]; then
  if [[ ${#systemctl[@]} -gt 0 ]]; then
    "${systemctl[@]}" disable --now fluent-feed.timer fluent-verify.timer fluent-backup.timer snowcat-feed.timer 2>/dev/null || true
  fi
  for legacy in "${legacy_units[@]}"; do
    rm -f "$unit_dir/$legacy"
    rm -rf "$unit_dir/$legacy.d"
  done
  report "removed legacy units ${legacy_units[*]} (replaced by the current snowcat-* units)"
  case " ${legacy_units[*]} " in *" fluent-"*) legacy_migrated=1 ;; esac
fi

# 4. Reload, enable the timers, and enable (not start) the surface: it needs a
# built bundle (`npm run build`) and either SNOWCAT_APP_TOKEN or the Access
# variables in /etc/snowcat/env first; `systemctl start snowcat-surface` when
# both are in place, and again after every upgrade + build.
timers=(snowcat-seed-dogfood.timer snowcat-import-issues.timer snowcat-sweep-dependencies.timer snowcat-sweep-settings.timer snowcat-verify.timer snowcat-backup.timer)
if [[ ${#systemctl[@]} -eq 0 ]]; then
  report "skipped systemctl (SNOWCAT_INSTALL_ROOT is set and SNOWCAT_SYSTEMCTL is not)"
else
  "${systemctl[@]}" daemon-reload
  "${systemctl[@]}" enable --now "${timers[@]}"
  "${systemctl[@]}" enable snowcat-surface.service
  report "enabled and started ${timers[*]}; enabled snowcat-surface.service (start it after npm run build and the env is complete)"
fi
if [[ $legacy_migrated -eq 1 ]]; then
  report "Fluent -> Snowcat migration done: restart any MCP client and the operator surface; export SNOWCAT_* in your shell (FLUENT_* is read for one more release)"
fi

cat <<NEXT
install: done. SNOWCAT_HOME=$snowcat_home, units run as $install_user, npm=$npm_path
install: next: set -a; . $env_file; set +a
install:       npm --prefix $snowcat_home run --silent queue -- metadata
install:       systemctl list-timers 'snowcat-*'
NEXT
