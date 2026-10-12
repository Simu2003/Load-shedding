"""Server: `python app.py`  ->  http://localhost:8000   (set PORT to change).
Only the Python standard library is used; no internet needed."""
import json
import os
import sys
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import solver

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "8000"))
MAX_BODY = 1_000_000
TYPES = {".html": "text/html; charset=utf-8", ".js": "application/javascript",
         ".css": "text/css", ".json": "application/json"}


def roster_endpoint(raw: bytes):
    """body bytes -> (http_status, dict).  Shared by the server and the tests."""
    try:
        data = json.loads(raw.decode("utf-8"), parse_float=Decimal)
    except Exception as e:
        return 400, {"status": "invalid_input", "message": f"body: not valid JSON ({e})"}
    try:
        return 200, solver.solve(data)
    except solver.InvalidInput as e:
        return 400, {"status": "invalid_input", "message": str(e)}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body: bytes, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path.split("?")[0] != "/api/roster":
            return self._send(404, b'{"message":"not found"}', "application/json")
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            code, out = 400, {"status": "invalid_input", "message": "body: too large"}
        else:
            code, out = roster_endpoint(self.rfile.read(n))
        self._send(code, json.dumps(out, ensure_ascii=False).encode("utf-8"), "application/json")

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/":
            p = "/static/index.html"
        if p.startswith("/static/") or p.startswith("/examples/"):
            f = os.path.normpath(os.path.join(ROOT, p.lstrip("/")))
            if f.startswith(ROOT) and os.path.isfile(f):
                with open(f, "rb") as fh:
                    return self._send(200, fh.read(), TYPES.get(os.path.splitext(f)[1], "application/octet-stream"))
        self._send(404, b"not found", "text/plain")

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Who Stays On? running on http://localhost:{PORT}  (POST /api/roster)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
