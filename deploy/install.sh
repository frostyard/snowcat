#!/usr/bin/env bash
# Install or refresh the Fluent v1 single-host deployment. Idempotent: run it
# again after `git pull` or to repair a host; it reports what it created and
# what it kept.
#
#   sudo deploy/install.sh [--user OPERATOR]
#
# What it does (and nothing else):
#   1. creates /var/lib/fluent and /var/backups/fluent (0750, owned by the
#      operator user — --user, else the sudo caller, else the invoking user);
#   2. writes /etc/fluent/env (0600) from deploy/env.example ONLY IF ABSENT,
#      with FLUENT_HOME set to this checkout and the database paths under
#      /var/lib/fluent; an existing file is never modified;
#   3. installs deploy/systemd/*.service and *.timer into /etc/systemd/system
#      plus one drop-in per service (10-install.conf) that sets User=, an
#      absolute ExecStart= for the npm found on PATH (systemd's fixed search
#      path does not include version managers such as Homebrew or nvm), a
#      PATH= that lets that npm find its node, and ReadWritePaths= for the
#      real FLUENT_HOME;
#   4. `systemctl daemon-reload`, then enables and starts the three timers.
#
# It never runs `core -- activate`, never opens or moves a database, and never
# touches the operator's shell configuration.
#
# Knobs:
#   FLUENT_NPM=/path/to/npm    npm to run from the units (default: the operator
#   FLUENT_NODE=/path/to/node  user's login-shell `command -v npm`/`node`)
#   FLUENT_INSTALL_ROOT=<dir>  install under <dir> instead of / (no root needed;
#                              systemctl is skipped unless FLUENT_SYSTEMCTL is set)
#   FLUENT_SYSTEMCTL=<cmd>     command used instead of systemctl (e.g. `true`)
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

fluent_home="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
root="${FLUENT_INSTALL_ROOT:-}"
root="${root%/}"
if [[ -z $root && $EUID -ne 0 ]]; then
  echo "install: run as root (sudo deploy/install.sh) or set FLUENT_INSTALL_ROOT for a dry run" >&2
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

# resolve_tool <name> <override-variable>: the override, else the tool as the
# operator user's login shell sees it (sudo resets PATH, and version managers
# such as Homebrew or nvm live in the user's profile), else our own PATH.
resolve_tool() {
  local name="$1" override="${2:-}" found=""
  if [[ -n $override ]]; then
    found="$override"
  elif [[ $install_user != "$(id -un)" ]]; then
    found="$(sudo -u "$install_user" -i sh -c "command -v $name" 2> /dev/null | tail -n 1 || true)"
  fi
  if [[ -z $found ]]; then found="$(command -v "$name" || true)"; fi
  if [[ -z $found || $found != /* || ! -x $found ]]; then
    echo "install: cannot find an executable $name for user $install_user; install Node 24+ or set FLUENT_${name^^}=/path/to/$name" >&2
    exit 1
  fi
  printf '%s\n' "$found"
}
npm_path="$(resolve_tool npm "${FLUENT_NPM:-}")"
node_path="$(resolve_tool node "${FLUENT_NODE:-}")"
npm_dir="$(dirname "$npm_path")"
node_dir="$(dirname "$node_path")"
service_path="$npm_dir"
[[ $node_dir == "$npm_dir" ]] || service_path="$npm_dir:$node_dir"
service_path="$service_path:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

if [[ -n ${FLUENT_SYSTEMCTL:-} ]]; then
  read -r -a systemctl <<< "$FLUENT_SYSTEMCTL"
elif [[ -n $root ]]; then
  systemctl=()
else
  systemctl=(systemctl)
fi

state_dir="$root/var/lib/fluent"
backup_dir="$root/var/backups/fluent"
env_dir="$root/etc/fluent"
env_file="$env_dir/env"
unit_dir="$root/etc/systemd/system"
env_example="$fluent_home/deploy/env.example"
units_source="$fluent_home/deploy/systemd"

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
    -e "s|^FLUENT_HOME=.*|FLUENT_HOME=$fluent_home|" \
    -e "s|^FLUENT_QUEUE_DB=.*|FLUENT_QUEUE_DB=$state_dir/queue.db|" \
    -e "s|^FLUENT_CONTROL_DB=.*|FLUENT_CONTROL_DB=$state_dir/control-plane.db|" \
    "$env_example" > "$rendered"
  install -m 0600 "${chown_args[@]}" "$rendered" "$env_file"
  rm -f "$rendered"
  report "created $env_file from deploy/env.example — fill in FLUENT_GITHUB_TOKEN"
fi

# 3. Units and per-service drop-ins.
ensure_dir "$unit_dir" 0755
for unit in "$units_source"/*.service "$units_source"/*.timer; do
  install_file "$unit" "$unit_dir/$(basename "$unit")" 0644
done

write_dropin() {
  local service="$1" exec_start="$2" rw_paths="$3"
  local dir="$unit_dir/$service.d"
  ensure_dir "$dir" 0755
  local rendered
  rendered="$(mktemp)"
  cat > "$rendered" <<DROPIN
# Written by deploy/install.sh for FLUENT_HOME=$fluent_home; re-run it to
# regenerate. Edit deploy/systemd/ in the checkout, not this file.
[Service]
User=$install_user
Environment=PATH=$service_path
ExecStart=
ExecStart=$exec_start
ReadWritePaths=
ReadWritePaths=$rw_paths
DROPIN
  install_file "$rendered" "$dir/10-install.conf" 0644
  rm -f "$rendered"
}

write_dropin fluent-feed.service \
  "$npm_path --prefix $fluent_home run --silent queue -- seed-dogfood --enrolled" \
  "$state_dir -$fluent_home/data"
write_dropin fluent-verify.service \
  "$npm_path --prefix $fluent_home run --silent queue -- verify-artifacts" \
  "$state_dir -$fluent_home/data"
write_dropin fluent-backup.service \
  "/bin/bash $fluent_home/deploy/bin/fluent-backup" \
  "$state_dir $backup_dir -$fluent_home/data"

# 4. Reload and enable the timers.
timers=(fluent-feed.timer fluent-verify.timer fluent-backup.timer)
if [[ ${#systemctl[@]} -eq 0 ]]; then
  report "skipped systemctl (FLUENT_INSTALL_ROOT is set and FLUENT_SYSTEMCTL is not)"
else
  "${systemctl[@]}" daemon-reload
  "${systemctl[@]}" enable --now "${timers[@]}"
  report "enabled and started ${timers[*]}"
fi

cat <<NEXT
install: done. FLUENT_HOME=$fluent_home, units run as $install_user, npm=$npm_path
install: next: set -a; . $env_file; set +a
install:       npm --prefix $fluent_home run --silent queue -- metadata
install:       systemctl list-timers 'fluent-*'
NEXT
