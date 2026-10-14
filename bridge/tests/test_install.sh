#!/usr/bin/env bash
# Installer test: fresh install, re-run (upgrade) keeps settings, uninstall. Runs in a temporary HOME with
# stand-in tailscale/systemctl/sudo on PATH and BRIDGE_DRYRUN=1 — it never touches the real system.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/bin"
cat > "$T/bin/tailscale" <<'EOF'
#!/bin/sh
[ "$1" = status ] && echo '{"Self":{"DNSName":"test-host.example-tailnet.ts.net."}}'
exit 0
EOF
for cmd in systemctl sudo; do printf '#!/bin/sh\necho "STAND-IN %s $*" >> "$HOME/calls.log"\n' "$cmd" > "$T/bin/$cmd"; done
chmod +x "$T/bin/"*
export HOME="$T/home" PATH="$T/bin:$PATH" BRIDGE_DRYRUN=1 BRIDGE_SRC="$HERE" XDG_CONFIG_HOME="$T/home/.config"
ENV="$HOME/.config/scriptbridge.env"
fails=0
check(){ if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }

echo "1) fresh install"
out=$(BRIDGE_SCRIPTS_DIR_OVERRIDE="$HOME/MyScripts" bash "$HERE/install.sh" </dev/null 2>&1)
check "env file written with mode 600" '[ "$(stat -c %a "$ENV")" = 600 ]'
check "password generated" 'grep -qE "^BRIDGE_TOKEN=sb_.{20,}" "$ENV"'
check "binds loopback only" 'grep -qx "BRIDGE_BIND=127.0.0.1" "$ENV"'
check "scripts folder saved and created" 'grep -qx "BRIDGE_SCRIPTS_DIR=$HOME/MyScripts" "$ENV" && [ -d "$HOME/MyScripts" ]'
check "bridge copied" '[ -f "$HOME/.local/share/scriptbridge/scriptbridge.py" ]'
check "service unit points at it" 'grep -q "scriptbridge/scriptbridge.py" "$HOME/.config/systemd/user/scriptbridge.service"'
check "serve on :8447 → 8795 (dry-run)" 'grep -q "tailscale serve --bg --https=8447 8795" <<<"$out"'
check "prints the address" 'grep -q "https://test-host.example-tailnet.ts.net:8447" <<<"$out"'
TOKEN1=$(sed -n 's/^BRIDGE_TOKEN=//p' "$ENV")
check "prints the password" 'grep -qF "$TOKEN1" <<<"$out"'
check "touched no real systemctl/sudo" '[ ! -f "$HOME/calls.log" ]'

echo "2) re-run (upgrade) keeps settings"
echo "MY_EXTRA=1" >> "$ENV"
bash "$HERE/install.sh" </dev/null >/dev/null 2>&1
check "same password" '[ "$(sed -n "s/^BRIDGE_TOKEN=//p" "$ENV")" = "$TOKEN1" ]'
check "same scripts folder" 'grep -qx "BRIDGE_SCRIPTS_DIR=$HOME/MyScripts" "$ENV"'
check "extra setting kept" 'grep -qx "MY_EXTRA=1" "$ENV"'
check "still mode 600" '[ "$(stat -c %a "$ENV")" = 600 ]'

echo "3) a scripts folder of \"-\" means none"
rm -f "$ENV"
BRIDGE_SCRIPTS_DIR_OVERRIDE=- bash "$HERE/install.sh" </dev/null >/dev/null 2>&1
check "no folder set" 'grep -qx "BRIDGE_SCRIPTS_DIR=" "$ENV"'

echo "4) uninstall"
out=$(bash "$HERE/install.sh" --uninstall 2>&1)
check "env removed" '[ ! -f "$ENV" ]'
check "unit removed" '[ ! -f "$HOME/.config/systemd/user/scriptbridge.service" ]'
check "bridge removed" '[ ! -d "$HOME/.local/share/scriptbridge" ]'
check "tailnet address turned off (dry-run)" 'grep -q "tailscale serve --https=8447 off" <<<"$out"'

[ "$fails" = 0 ] && echo "ALL PASSED" || { echo "$fails FAILED"; exit 1; }
