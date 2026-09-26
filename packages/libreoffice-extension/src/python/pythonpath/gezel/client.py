"""A small HTTP client for the daemon: JSON requests and server-sent events,
over TLS pinned to the certificate the daemon published for this launch.

The certificate rotates every time Gezel starts, so the SSL context is built
per connection from runtime/cert.pem, and one verification failure re-reads
the endpoint and retries once.
"""

from __future__ import annotations

import http.client
import json
import ssl

from .discovery import DaemonNotRunning, Endpoint, discover


class HttpError(Exception):
    def __init__(self, status: int, body):
        self.status = status
        self.body = body
        message = body.get("message") or body.get("error") if isinstance(body, dict) else None
        super().__init__(message or f"Gezel answered {status}.")

    @property
    def code(self):
        return self.body.get("error") if isinstance(self.body, dict) else None


def _context(endpoint: Endpoint):
    if endpoint.scheme != "https":
        return None
    ctx = ssl.create_default_context(cafile=endpoint.cert_path)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx


class GezelHttp:
    def __init__(self, home=None, discover_fn=discover):
        self._home = home
        self._discover = discover_fn
        self._endpoint = None

    def endpoint(self, refresh=False) -> Endpoint:
        if refresh or self._endpoint is None:
            self._endpoint = self._discover(self._home)
        return self._endpoint

    def _connection(self, endpoint: Endpoint, timeout: float):
        if endpoint.scheme == "https":
            return http.client.HTTPSConnection(
                endpoint.host, endpoint.port, timeout=timeout, context=_context(endpoint)
            )
        return http.client.HTTPConnection(endpoint.host, endpoint.port, timeout=timeout)

    def _open(self, method, path, body, token, timeout, accept):
        headers = {"Accept": accept}
        payload = None
        if body is not None:
            payload = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = f"Bearer {token}"
        last = None
        for attempt in range(2):
            endpoint = self.endpoint(refresh=attempt > 0)
            conn = self._connection(endpoint, timeout)
            try:
                conn.request(method, path, body=payload, headers=headers)
                return conn, conn.getresponse()
            except ssl.SSLError as err:
                # Gezel restarted with a new certificate (or a new port).
                conn.close()
                last = err
            except (ConnectionRefusedError, OSError) as err:
                conn.close()
                last = err
        if isinstance(last, ssl.SSLError):
            raise DaemonNotRunning("Could not verify Gezel's connection. Restart Gezel and try again.") from last
        raise DaemonNotRunning("Gezel is not running.") from last

    def request_json(self, method, path, body=None, token=None, timeout=30.0):
        conn, res = self._open(method, path, body, token, timeout, "application/json")
        try:
            raw = res.read()
        finally:
            conn.close()
        try:
            data = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            data = {"error": raw.decode("utf-8", "replace")[:500]}
        if res.status >= 400:
            raise HttpError(res.status, data)
        return data

    def events(self, path, token=None, timeout=90.0, stop=None):
        """Yield each SSE `data:` payload (a str) until the stream ends or
        `stop` (a threading.Event) is set."""
        conn, res = self._open("GET", path, None, token, timeout, "text/event-stream")
        try:
            if res.status >= 400:
                raw = res.read()
                try:
                    body = json.loads(raw.decode("utf-8"))
                except ValueError:
                    body = {"error": raw.decode("utf-8", "replace")[:500]}
                raise HttpError(res.status, body)
            yield from parse_sse_lines(res, stop)
        finally:
            conn.close()


def parse_sse_lines(stream, stop=None):
    """Yield the data of each event from a readline()-able byte stream.
    Multi-line `data:` fields join with newlines; comments and other fields
    are skipped; CRLF and LF both end lines."""
    data = []
    while True:
        if stop is not None and stop.is_set():
            return
        line = stream.readline()
        if not line:
            if data:
                yield "\n".join(data)
            return
        text = line.decode("utf-8", "replace").rstrip("\r\n")
        if text == "":
            if data:
                yield "\n".join(data)
                data = []
            continue
        if text.startswith(":"):
            continue
        field, _, value = text.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if field == "data":
            data.append(value)
