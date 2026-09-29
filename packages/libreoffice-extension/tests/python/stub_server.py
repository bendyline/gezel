"""A plain-HTTP stand-in for the Gezel daemon, for client and consent tests."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class StubDaemon:
    def __init__(self):
        self.routes = {}
        self.requests = []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def _handle(self, method):
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length)) if length else None
                path = self.path.split("?")[0]
                stub.requests.append((method, self.path, body, self.headers.get("Authorization")))
                route = stub.routes.get((method, path))
                if route is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                status, payload = route(body, self.path, self.headers)
                if isinstance(payload, list):  # SSE frames
                    self.send_response(status)
                    self.send_header("Content-Type", "text/event-stream")
                    self.end_headers()
                    for frame in payload:
                        self.wfile.write(frame.encode("utf-8"))
                    return
                data = json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

            def do_PUT(self):
                self._handle("PUT")

            def do_DELETE(self):
                self._handle("DELETE")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()
