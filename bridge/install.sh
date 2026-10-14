#!/usr/bin/env bash
# scriptbridge installer — the optional computer side of EvenScriptable (G2 glasses), on YOUR machine.
#
#   curl -fsSL https://raw.githubusercontent.com/liyiyuian/evenScriptable/main/bridge/install.sh | bash
#   ... | bash -s -- --uninstall      (removes the service, the tailnet address and the settings)
#
# It: checks prerequisites, downloads the bridge, makes a password, asks for an optional folder of .js
# scripts to share with the phone app, installs a systemd --user service, publishes it on YOUR Tailscale
# network only (HTTPS, port 8447), and prints the address + password to enter in the phone app.
# Re-running it upgrades the bridge and keeps your password and settings.
#
# Anyone with the password can make this computer fetch any address it can reach (including services on
# this computer). It listens on 127.0.0.1 and is reachable only from your tailnet. Never share the password.
#
# Testing hooks (not for normal use):
#   BRIDGE_SRC=/path/to/dir           copy scriptbridge.py from a local dir instead of downloading
#   BRIDGE_DRYRUN=1                   don't touch systemd/tailscale/sudo (print the commands instead)
#   BRIDGE_SCRIPTS_DIR_OVERRIDE=…     answer the scripts-folder question ("-" = none)
set -euo pipefail

REPO="${BRIDGE_REPO:-liyiyuian/evenScriptable}"
RAW="https://raw.githubusercontent.com/${REPO}/main/bridge"
PORT="${BRIDGE_PORT:-8795}"
HTTPS_PORT="${BRIDGE_HTTPS_PORT:-8447}"   # the app whitelists *.ts.net:8447
INSTALL_DIR="${BRIDGE_DIR:-$HOME/.local/share/scriptbridge}"
ENV_FILE="${BRIDGE_ENV:-$HOME/.config/scriptbridge.env}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="scriptbridge.service"
DRY="${BRIDGE_DRYRUN:-0}"

c()  { printf '\033[36m%s\033[0m\n' "$*"; }
ok() { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn(){ printf '\033[33m! %s\033[0m\n' "$*"; }
die(){ printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
run(){ if [ "$DRY" = 1 ]; then echo "  [dry-run] $*"; else "$@"; fi; }

if [ "${1:-}" = "--uninstall" ]; then
  c "Removing scriptbridge"
  run systemctl --user disable --now "$UNIT" || true
  rm -f "$UNIT_DIR/$UNIT"
  run systemctl --user daemon-reload || true
  run sudo tailscale serve --https="$HTTPS_PORT" off || true
  rm -rf "$INSTALL_DIR" "$ENV_FILE"
  ok "removed the service, the tailnet address (:$HTTPS_PORT), $INSTALL_DIR and $ENV_FILE"
  exit 0
fi

c "scriptbridge installer"

# 1) prerequisites -----------------------------------------------------------
command -v python3 >/dev/null || die "python3 not found (need 3.10+). Install Python first."
PYV=$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])')
python3 -c 'import sys;exit(0 if sys.version_info[:2]>=(3,10) else 1)' || die "python3 $PYV too old; need 3.10+."
ok "python3 $PYV"
command -v tailscale >/dev/null && ok "tailscale" || die "tailscale not found. Install it and log in: https://tailscale.com/download"

# 2) download the bridge -----------------------------------------------------
[ -z "${BRIDGE_SRC:-}" ] && [ -f scriptbridge.py ] && BRIDGE_SRC="$(pwd)"   # run from a clone: use its file
mkdir -p "$INSTALL_DIR"
if [ -n "${BRIDGE_SRC:-}" ]; then cp "$BRIDGE_SRC/scriptbridge.py" "$INSTALL_DIR/scriptbridge.py"
else curl -fsSL "$RAW/scriptbridge.py" -o "$INSTALL_DIR/scriptbridge.py" || die "could not download scriptbridge.py from $RAW"; fi
python3 -m py_compile "$INSTALL_DIR/scriptbridge.py" || die "the downloaded bridge does not compile"
ok "bridge in $INSTALL_DIR"

# 3) settings: a re-run keeps everything already in the env file -------------
old(){ [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | head -1 || true; }
TOKEN=$(old BRIDGE_TOKEN)
if [ -z "$TOKEN" ]; then TOKEN="sb_$(python3 -c 'import secrets;print(secrets.token_urlsafe(24))')"; ok "made a new password"
else ok "keeping your password"; fi

if [ -n "${BRIDGE_SCRIPTS_DIR_OVERRIDE:-}" ]; then SCRIPTS="$BRIDGE_SCRIPTS_DIR_OVERRIDE"
elif [ -f "$ENV_FILE" ] && grep -q '^BRIDGE_SCRIPTS_DIR=' "$ENV_FILE"; then SCRIPTS=$(old BRIDGE_SCRIPTS_DIR); ok "keeping your scripts folder: ${SCRIPTS:-none}"
elif [ -r /dev/tty ]; then
  printf 'Folder of .js scripts the phone app may import (Enter = ~/Scripts, "-" = none): '
  read -r SCRIPTS </dev/tty || SCRIPTS=""
  SCRIPTS="${SCRIPTS:-$HOME/Scripts}"
else SCRIPTS="-"; fi
[ "$SCRIPTS" = "-" ] && SCRIPTS=""
SCRIPTS="${SCRIPTS/#\~/$HOME}"
if [ -n "$SCRIPTS" ]; then mkdir -p "$SCRIPTS"; ok "scripts folder: $SCRIPTS"; else ok "no scripts folder (you can paste scripts on the phone)"; fi

mkdir -p "$(dirname "$ENV_FILE")"
KEEP=$( [ -f "$ENV_FILE" ] && grep -vE '^(BRIDGE_TOKEN|BRIDGE_BIND|BRIDGE_PORT|BRIDGE_SCRIPTS_DIR)=' "$ENV_FILE" || true )
umask 177
{
  echo "BRIDGE_TOKEN=$TOKEN"
  echo "BRIDGE_BIND=127.0.0.1"
  echo "BRIDGE_PORT=$PORT"
  echo "BRIDGE_SCRIPTS_DIR=$SCRIPTS"
  [ -n "$KEEP" ] && printf '%s\n' "$KEEP"
  true
} > "$ENV_FILE.new"
mv "$ENV_FILE.new" "$ENV_FILE"
umask 022; chmod 600 "$ENV_FILE"
ok "wrote $ENV_FILE"

# 4) systemd --user service --------------------------------------------------
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/$UNIT" <<EOF
[Unit]
Description=scriptbridge (EvenScriptable bridge for G2 glasses, tailnet only)
After=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v python3) $INSTALL_DIR/scriptbridge.py
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
ok "wrote the service"
run systemctl --user daemon-reload
run systemctl --user enable "$UNIT"
run systemctl --user restart "$UNIT"   # restart, not start: a re-run upgrades a running bridge
[ "$DRY" = 1 ] || warn "to keep it running after you log out: sudo loginctl enable-linger $USER"

# 5) publish on your tailnet over HTTPS (port 8447; other apps can keep :443) --
run sudo tailscale serve --bg --https="$HTTPS_PORT" "$PORT"

# 6) summary ------------------------------------------------------------------
DNS=$(tailscale status --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)
URL="https://${DNS:-<your-computer>.<your-tailnet>.ts.net}:${HTTPS_PORT}"
echo
ok "scriptbridge is running."
c  "Address  : $URL"
c  "Password : $TOKEN"
echo
c  "On your phone: open EvenScriptable in the Even app → Computer → paste the address and password → Save → Test."
c  "Your phone must be on the same Tailscale network."
[ -z "$DNS" ] && warn "couldn't read your Tailscale name — run 'tailscale status' and use https://<name>.ts.net:${HTTPS_PORT}."
true
