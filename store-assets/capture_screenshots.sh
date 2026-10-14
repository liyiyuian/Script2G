#!/usr/bin/env bash
# Store screenshots from the REAL Even Hub simulator (576x288), using only the demo scripts in
# demo-scripts/ (made-up data). It builds the self-test build, serves it on loopback, runs a throwaway
# bridge that shares demo-scripts/, drives the simulator, and writes screenshots/*.png.
# It stops only the processes it started (other apps' simulators keep running).   ./capture_screenshots.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
G="$HERE/../glasses"; B="$HERE/../bridge"; OUT="$HERE/screenshots"
PORT_WEB=15199; PORT_BRIDGE=18795; PORT_AUTO=19911
A="http://127.0.0.1:$PORT_AUTO"
TMP="$(mktemp -d)"; GROUPS_STARTED=()
cleanup(){ for g in "${GROUPS_STARTED[@]}"; do kill -- "-$g" 2>/dev/null || true; done; rm -rf "$TMP"; }
trap cleanup EXIT
start(){ setsid "$@" >>"$TMP/log" 2>&1 & GROUPS_STARTED+=($!); }   # own process group, so cleanup gets its children
inp(){ curl -s -X POST "$A/api/input" -H 'Content-Type: application/json' -d "{\"action\":\"$1\"}" >/dev/null; sleep "${2:-1.6}"; }
shot(){ curl -s "$A/api/screenshot/glasses" -o "$OUT/$1"; echo "  -> screenshots/$1"; }

TOKEN="$(python3 -c 'import secrets;print(secrets.token_urlsafe(18))')"
(cd "$G" && npm run --silent build:selftest >/dev/null)
start env BRIDGE_TOKEN="$TOKEN" BRIDGE_PORT=$PORT_BRIDGE BRIDGE_SCRIPTS_DIR="$HERE/demo-scripts" python3 "$B/scriptbridge.py"
start "$G/node_modules/.bin/vite" preview "$G" --outDir "$G/dist-selftest" --host 127.0.0.1 --port $PORT_WEB --strictPort
curl -s --retry 30 --retry-connrefused --retry-delay 1 -o /dev/null "http://127.0.0.1:$PORT_WEB/"
mkdir -p "$TMP/xdg" "$OUT"
start env XDG_DATA_HOME="$TMP/xdg" WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  xvfb-run -a "$G/node_modules/.bin/evenhub-simulator" \
  "http://127.0.0.1:$PORT_WEB/?importall&bridge=http://127.0.0.1:$PORT_BRIDGE&token=$TOKEN" --automation-port $PORT_AUTO
curl -s --retry 40 --retry-connrefused --retry-delay 1 "$A/api/ping" >/dev/null
sleep 10   # the page imports the demo scripts from the bridge

# List order (alphabetical): Countdown, Day progress, Packing list, Space launches, Weather demo.
shot 1-script-list.png
inp down; inp click 3;              shot 2-widget.png          # Day progress (a widget, as text)
inp double_click; inp down 0.8; inp down; inp click 3; shot 3-choice.png   # Packing list (UITable)
inp double_click 2.5; inp double_click
inp down 0.8; inp down 0.8; inp down; inp click 3; shot 4-long-list.png    # Space launches (scrolls)
inp double_click; inp down 0.8; inp down 0.8; inp down 0.8; inp down; inp click 3; shot 5-weather.png
errors="$(curl -s "$A/api/console" | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(1 for e in d['entries'] if e['level']=='error' or 'uncaught' in e['message'] or 'rejection' in e['message']))")"
echo "console errors: $errors"
