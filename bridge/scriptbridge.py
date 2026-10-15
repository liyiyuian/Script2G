#!/usr/bin/env python3
"""scriptbridge — the optional computer side of Script2G (G2 glasses).

Scripts run on your phone, but the Even app only lets the plugin reach whitelisted addresses, and the
phone's WebView enforces CORS. This bridge runs on YOUR computer and fetches web requests for your
scripts, and can share a folder of .js files for the phone app to import.

Security: anyone with the password can make this computer fetch any address it can reach, including
services on the computer itself (that is how a script can read a local feed). So it listens on
127.0.0.1 only, is published to your own Tailscale network with `tailscale serve`, and refuses every
request without the password. Never expose it to the internet or share the password.

Environment:
  BRIDGE_TOKEN        required; the password the phone app sends (Authorization: Bearer ...)
  BRIDGE_BIND         default 127.0.0.1
  BRIDGE_PORT         default 8795
  BRIDGE_SCRIPTS_DIR  optional; a folder of .js files the phone app can import
Standard library only.
"""
import base64
import hmac
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "0.1.2"
TOKEN = os.environ.get("BRIDGE_TOKEN", "")
SCRIPTS_DIR = os.path.expanduser(os.environ.get("BRIDGE_SCRIPTS_DIR", ""))
MAX_BODY = 5 * 1024 * 1024        # request body from the phone
MAX_RESPONSE = 10 * 1024 * 1024   # response relayed back to the phone
MAX_TIMEOUT = 60
HOP_HEADERS = {"host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade",
               "proxy-authorization", "te", "trailer", "accept-encoding"}


REDIRECTS = (301, 302, 303, 307, 308)
WEB = ("http", "https")


def origin(url):
    u = urllib.parse.urlsplit(url)
    return u.scheme, u.hostname, u.port or {"http": 80, "https": 443}.get(u.scheme)


class Redirects(urllib.request.HTTPRedirectHandler):
    """Follow redirects like Scriptable's Request does, but without credentials when the origin (scheme, host or
    port) changes."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and origin(newurl) != origin(req.full_url):
            for h in ("Authorization", "Cookie"):
                new.remove_header(h)
        return new


class KeepErrorResponses(urllib.request.HTTPErrorProcessor):
    """Return 4xx/5xx responses as responses (a script wants to see the status), not exceptions. A redirect
    to http/https is followed; any other (ftp:, file:, …) comes back as the redirect response itself."""
    def http_response(self, request, response):
        target = urllib.parse.urljoin(request.full_url, response.headers.get("location", ""))
        if response.status in REDIRECTS and urllib.parse.urlsplit(target).scheme in WEB:
            return super().http_response(request, response)
        return response
    https_response = http_response


OPENER = urllib.request.build_opener(Redirects, KeepErrorResponses)


def relay(req):
    """Performs one RelayRequest (see the app's runtime/types.ts) and returns a RelayResponse."""
    if not isinstance(req, dict) or not isinstance(req.get("headers") or {}, dict):
        raise ValueError("the request must be a JSON object with an object of headers")
    url = str(req.get("url", ""))
    if not re.match(r"^https?://", url, re.I):
        raise ValueError("only http and https addresses can be fetched")
    body = base64.b64decode(req["bodyBase64"]) if req.get("bodyBase64") else None
    headers = {k: str(v) for k, v in (req.get("headers") or {}).items() if k.lower() not in HOP_HEADERS}
    headers.setdefault("User-Agent", f"scriptbridge/{VERSION}")
    method = str(req.get("method") or "GET").upper()
    timeout = max(1, min(float(req.get("timeoutSec") or 60), MAX_TIMEOUT))
    r = urllib.request.Request(url, data=body, headers=headers, method=method)
    with OPENER.open(r, timeout=timeout) as res:
        data = res.read(MAX_RESPONSE + 1)
        if len(data) > MAX_RESPONSE:
            raise ValueError(f"the response is larger than {MAX_RESPONSE // (1024 * 1024)} MB")
        return {
            "status": res.status,
            "url": res.geturl(),
            "headers": {k: v for k, v in res.headers.items()},
            "bodyBase64": base64.b64encode(data).decode(),
        }


def script_path(name):
    """A .js file directly inside BRIDGE_SCRIPTS_DIR, or None (no paths, no other files)."""
    if not SCRIPTS_DIR or not re.fullmatch(r"[^/\\\x00]+\.js", name) or name.startswith("."):
        return None
    path = os.path.join(SCRIPTS_DIR, name)
    return path if os.path.isfile(path) and os.path.dirname(os.path.realpath(path)) == os.path.realpath(SCRIPTS_DIR) else None


class Handler(BaseHTTPRequestHandler):
    timeout = 30  # slowloris guard
    server_version = "scriptbridge"
    sys_version = ""

    def log_message(self, fmt, *args):  # method, path and status only: relayed URLs and headers can carry secrets
        status = args[1] if fmt.startswith('"%s" %s') and len(args) > 1 else "-"
        line = f"{getattr(self, 'command', None) or '-'} {(getattr(self, 'path', None) or '-').split('?')[0]} {status}"
        sys.stderr.write(re.sub(r"[\x00-\x1f\x7f]", lambda m: f"\\x{ord(m[0]):02x}", line) + "\n")

    def _cors(self):
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
        self.send_header("access-control-allow-headers", "authorization, content-type")
        self.send_header("access-control-max-age", "600")

    def _json(self, code, obj):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def _authed(self):
        auth = self.headers.get("authorization", "")
        tok = auth[7:] if auth.lower().startswith("bearer ") else ""
        return bool(TOKEN) and hmac.compare_digest(tok.encode(), TOKEN.encode())

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/health":
            return self._json(200, {"ok": True, "app": "scriptbridge", "version": VERSION})
        if not self._authed():
            return self._json(401, {"error": "wrong or missing password"})
        if path == "/api/ping":
            return self._json(200, {"ok": True, "version": VERSION, "scripts": bool(SCRIPTS_DIR)})
        if path == "/api/scripts":
            if not SCRIPTS_DIR or not os.path.isdir(SCRIPTS_DIR):
                return self._json(200, {"scripts": [], "note": "no scripts folder is set on the computer"})
            names = sorted(n for n in os.listdir(SCRIPTS_DIR) if script_path(n))
            return self._json(200, {"scripts": [{"name": n[:-3], "size": os.path.getsize(script_path(n))} for n in names]})
        if path.startswith("/api/scripts/"):
            p = script_path(urllib.request.unquote(path[len("/api/scripts/"):]) + ".js")
            if not p:
                return self._json(404, {"error": "no such script"})
            try:
                with open(p, encoding="utf-8", errors="replace") as f:
                    return self._json(200, {"name": os.path.basename(p)[:-3], "source": f.read()})
            except OSError:
                return self._json(500, {"error": "the script could not be read"})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self._authed():
            return self._json(401, {"error": "wrong or missing password"})
        if self.path.split("?")[0] != "/api/fetch":
            return self._json(404, {"error": "not found"})
        try:
            n = int(self.headers.get("content-length") or 0)
            if not 0 <= n <= MAX_BODY:
                return self._json(413, {"error": "request too large"})
            req = json.loads(self.rfile.read(n) or b"{}")
            return self._json(200, relay(req))
        except (ValueError, KeyError, TypeError) as e:
            return self._json(400, {"error": str(e)})
        except (urllib.error.URLError, OSError) as e:  # DNS failure, refused, timeout…
            return self._json(502, {"error": f"could not fetch: {getattr(e, 'reason', e)}"})
        except Exception as e:  # anything else from the web (bad status line, …): answer, never log it
            return self._json(502, {"error": f"could not fetch: {type(e).__name__}: {e}"})


class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        # The default prints a traceback, which can hold relayed URLs or headers (secrets). One line instead.
        sys.stderr.write("a request failed\n")


def main():
    if not TOKEN:
        sys.exit("BRIDGE_TOKEN is not set; refusing to start without a password.")
    bind = os.environ.get("BRIDGE_BIND", "127.0.0.1")
    port = int(os.environ.get("BRIDGE_PORT", "8795"))
    print(f"scriptbridge {VERSION} on http://{bind}:{port} (scripts folder: {SCRIPTS_DIR or 'none'})", flush=True)
    Server((bind, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
