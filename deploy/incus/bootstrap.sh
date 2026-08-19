#!/usr/bin/env bash
# Bootstrap (or refresh) a Snowcat host inside the Incus instance created from
# deploy/incus/snowcat.profile.yaml. Run it as root inside the instance:
#
#   incus exec <remote>:snowcat -- bash -s -- [--ref <git ref>] < deploy/incus/bootstrap.sh
#
# Steps, all idempotent: clone or fast-forward /opt/snowcat as the `snowcat`
# user (SNOWCAT_GIT_URL, default the public GitHub URL; set
# SNOWCAT_GIT_TOKEN for a private clone — it is used once and not stored),
# `npm ci`, then deploy/install.sh --user snowcat (directories, /etc/snowcat/env
# from env.example if absent, units, timers), then `npm run build`. On a host
# whose /var/lib/snowcat holds no queue database yet, it stops the timers again
# (still enabled) so a host that is about to receive restored databases never
# feeds an empty queue; the operator starts them at cutover. It prints what is
# still the operator's: filling SNOWCAT_GITHUB_TOKEN, restoring databases,
# starting the surface and timers, the tunnel, and Access. Never writes a
# secret it was not given.
set -euo pipefail

ref="main"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) ref="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ $EUID -eq 0 ]] || { echo "bootstrap: run as root inside the instance" >&2; exit 1; }
id snowcat >/dev/null 2>&1 || { echo "bootstrap: no snowcat user — was the instance created from deploy/incus/snowcat.profile.yaml?" >&2; exit 1; }
command -v node >/dev/null || { echo "bootstrap: node not installed yet (cloud-init still running? check: cloud-init status --wait)" >&2; exit 1; }

home=/opt/snowcat
url="${SNOWCAT_GIT_URL:-https://github.com/frostyard/snowcat.git}"
if [[ -n ${SNOWCAT_GIT_TOKEN:-} ]]; then
  url="${url/https:\/\//https://x-access-token:${SNOWCAT_GIT_TOKEN}@}"
fi
if [[ ! -d $home/.git ]]; then
  echo "bootstrap: cloning into $home ($ref)"
  sudo -u snowcat git clone --quiet --branch "$ref" "$url" "$home"
  # Never leave a token in the remote URL.
  sudo -u snowcat git -C "$home" remote set-url origin "https://github.com/frostyard/snowcat.git"
else
  echo "bootstrap: fast-forwarding $home to $ref"
  sudo -u snowcat git -C "$home" fetch --quiet origin
  sudo -u snowcat git -C "$home" checkout --quiet "$ref"
  sudo -u snowcat git -C "$home" pull --quiet --ff-only || true
fi
echo "bootstrap: npm ci"
sudo -u snowcat bash -lc "cd $home && npm ci --silent"
echo "bootstrap: deploy/install.sh --user snowcat"
"$home/deploy/install.sh" --user snowcat
echo "bootstrap: build the surface bundle"
sudo -u snowcat bash -lc "cd $home && npm run --silent build"

# shellcheck disable=SC1091
queue_db="$(. /etc/snowcat/env >/dev/null 2>&1; echo "${SNOWCAT_QUEUE_DB:-/var/lib/snowcat/queue.db}")"
if [[ ! -s $queue_db ]]; then
  echo "bootstrap: no queue database at $queue_db yet — stopping the timers (still enabled) until the databases are restored"
  systemctl stop snowcat-feed.timer snowcat-verify.timer snowcat-backup.timer
fi

cat <<NEXT
bootstrap: done. Still yours, in this order (docs/design/queue-operations.md → "Moving the host to a new machine"):
  1. Put a GitHub token for this host in /etc/snowcat/env (SNOWCAT_GITHUB_TOKEN=…); the file stays mode 0600.
  2. Restore the databases: push verified backups to $queue_db and the control-plane path in the env (owner snowcat, mode 0600),
     then verify them here with \`queue -- verify-backup\` and \`control -- verify-backup\`.
  3. systemctl start snowcat-surface.service   (it serves 127.0.0.1:3100; check journalctl -u snowcat-surface)
  4. At cutover — the old host's timers already disabled — systemctl start snowcat-feed.timer snowcat-verify.timer snowcat-backup.timer
  5. Reach it: either \`tailscale up\` + \`tailscale serve --bg 3100\` (private mesh, local mode) or the tunnel + Access
     (ADR-0063: SNOWCAT_ACCESS_TEAM_DOMAIN/SNOWCAT_ACCESS_AUD, restart the surface). Runbook: "A private mesh instead of Access".
NEXT
