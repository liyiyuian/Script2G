"""Bridge tests: real HTTP against a local target server (no internet).  python3 -m unittest discover tests"""
import base64
import importlib.util
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN = "test-token-123"
SCRIPTS = tempfile.mkdtemp()
with open(os.path.join(SCRIPTS, "hello.js"), "w") as f:
    f.write("console.log('hi')")
with open(os.path.join(SCRIPTS, "notes.txt"), "w") as f:
    f.write("not a script")
os.environ.update(BRIDGE_TOKEN=TOKEN, BRIDGE_SCRIPTS_DIR=SCRIPTS)
spec = importlib.util.spec_from_file_location("scriptbridge", os.path.join(HERE, "..", "scriptbridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class Target(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        code = 404 if self.path == "/missing" else 200
        body = json.dumps({"path": self.path, "ua": self.headers.get("user-agent"), "x": self.headers.get("x-test")}).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        data = self.rfile.read(int(self.headers.get("content-length") or 0))
        self.send_response(201)
        self.send_header("content-type", "text/plain")
        self.end_headers()
        self.wfile.write(b"got:" + data)


def serve(handler):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


TARGET, TARGET_URL = serve(Target)
BRIDGE, BRIDGE_URL = serve(bridge.Handler)


def call(path, body=None, token=TOKEN, method=None):
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    req = urllib.request.Request(BRIDGE_URL + path, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, dict(r.headers), json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), json.loads(e.read() or b"null")


class BridgeTests(unittest.TestCase):
    def test_health_needs_no_password_but_everything_else_does(self):
        self.assertEqual(call("/api/health", token=None)[0], 200)
        for path in ("/api/ping", "/api/scripts", "/api/scripts/hello"):
            self.assertEqual(call(path, token=None)[0], 401, path)
            self.assertEqual(call(path, token="wrong")[0], 401, path)
        self.assertEqual(call("/api/fetch", {"url": TARGET_URL}, token=None)[0], 401)
        self.assertEqual(call("/api/ping")[0], 200)

    def test_cors_on_responses_and_preflight(self):
        status, headers, _ = call("/api/ping", token="wrong")
        self.assertEqual(headers.get("access-control-allow-origin"), "*")
        status, headers, _ = call("/api/fetch", method="OPTIONS", token=None)
        self.assertEqual(status, 204)
        self.assertIn("authorization", headers.get("access-control-allow-headers", ""))

    def test_fetch_get_passes_headers_and_returns_body(self):
        status, _, r = call("/api/fetch", {"url": TARGET_URL + "/x?y=1", "method": "GET", "headers": {"X-Test": "1"}, "timeoutSec": 5})
        self.assertEqual(status, 200)
        self.assertEqual(r["status"], 200)
        body = json.loads(base64.b64decode(r["bodyBase64"]))
        self.assertEqual(body["path"], "/x?y=1")
        self.assertEqual(body["x"], "1")
        self.assertTrue(body["ua"].startswith("scriptbridge/"))

    def test_fetch_post_body_and_error_status_are_relayed(self):
        _, _, r = call("/api/fetch", {"url": TARGET_URL, "method": "POST", "bodyBase64": base64.b64encode(b"hello").decode(), "timeoutSec": 5})
        self.assertEqual((r["status"], base64.b64decode(r["bodyBase64"])), (201, b"got:hello"))
        _, _, r = call("/api/fetch", {"url": TARGET_URL + "/missing", "timeoutSec": 5})
        self.assertEqual(r["status"], 404)

    def test_fetch_rejects_other_schemes_and_reports_unreachable(self):
        self.assertEqual(call("/api/fetch", {"url": "file:///etc/passwd"})[0], 400)
        self.assertEqual(call("/api/fetch", {"url": "http://127.0.0.1:9/", "timeoutSec": 3})[0], 502)

    def test_scripts_folder_lists_only_js_and_blocks_paths(self):
        _, _, r = call("/api/scripts")
        self.assertEqual([s["name"] for s in r["scripts"]], ["hello"])
        _, _, r = call("/api/scripts/hello")
        self.assertEqual(r["source"], "console.log('hi')")
        for bad in ("/api/scripts/..%2Fetc%2Fpasswd", "/api/scripts/notes", "/api/scripts/%2Fetc%2Fhosts"):
            self.assertEqual(call(bad)[0], 404, bad)


if __name__ == "__main__":
    unittest.main()
