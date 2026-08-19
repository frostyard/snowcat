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
# from env.example if absent, units, timers). It prints what is still the
# operator's: filling SNOWCAT_GITHUB_TOKEN, restoring databases, the tunnel,
# and Access. Never writes a secret it was not given.
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

cat <<NEXT
bootstrap: done. Still yours, in this order (see docs/design/queue-operations.md → "Moving the host"):
  1. Put a GitHub token for this host in /etc/snowcat/env (SNOWCAT_GITHUB_TOKEN=…), mode 0600.
  2. Restore the databases: copy verified backups to /var/lib/snowcat/{queue,control-plane}.db (owner snowcat).
  3. Start the surface: sudo -u snowcat -i bash -lc 'set -a; . /etc/snowcat/env; set +a; cd $home && PORT=3100 node scripts/serve.mjs'
     (or install the shipped snowcat-surface.service once it exists).
  4. Tunnel + Access (ADR-0063): cloudflared service token, then SNOWCAT_ACCESS_TEAM_DOMAIN/SNOWCAT_ACCESS_AUD.
NEXT
