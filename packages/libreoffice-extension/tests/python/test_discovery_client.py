import io
import os
import tempfile
import threading
import unittest

import _path  # noqa: F401
from gezel.client import GezelHttp, HttpError, parse_sse_lines
from gezel.discovery import DaemonNotRunning, _answers, discover, gezel_home
from stub_server import StubDaemon


def _publish(home, port, installed=False):
    os.makedirs(os.path.join(home, "runtime"), exist_ok=True)
    with open(os.path.join(home, "runtime", "port"), "w") as f:
        f.write(f"{port}\n")
    if installed:
        os.makedirs(os.path.join(home, "integrations", "libreoffice"), exist_ok=True)
        with open(os.path.join(home, "integrations", "libreoffice", "setup.json"), "w") as f:
            f.write("{}")


class DiscoveryTests(unittest.TestCase):
    def test_gezel_home_honors_env(self):
        self.assertEqual(gezel_home({"GEZEL_HOME": "/x/y"}), "/x/y")

    def test_installed_home_is_the_default_when_nothing_answers(self):
        with tempfile.TemporaryDirectory() as user:
            # A port file whose daemon is gone does not choose a home.
            _publish(os.path.join(user, ".gezel-dev"), 6228)
            home = gezel_home({}, answers=lambda _port: False, user_dir=user)
            self.assertEqual(home, os.path.join(user, ".gezel"))

    def test_finds_a_development_gezel(self):
        # LibreOffice starts without GEZEL_HOME, so a development build of the
        # desktop app (~/.gezel-dev) used to read as "Gezel is not running".
        with tempfile.TemporaryDirectory() as user:
            _publish(os.path.join(user, ".gezel-dev"), 6228)
            home = gezel_home({}, answers=lambda port: port == 6228, user_dir=user)
            self.assertEqual(home, os.path.join(user, ".gezel-dev"))

    def test_prefers_the_gezel_that_installed_this_extension(self):
        with tempfile.TemporaryDirectory() as user:
            _publish(os.path.join(user, ".gezel"), 6228)
            _publish(os.path.join(user, ".gezel-dev"), 6229, installed=True)
            answers = lambda _port: True  # noqa: E731
            self.assertEqual(
                gezel_home({}, answers=answers, user_dir=user), os.path.join(user, ".gezel-dev")
            )
            os.remove(os.path.join(user, ".gezel-dev", "integrations", "libreoffice", "setup.json"))
            self.assertEqual(gezel_home({}, answers=answers, user_dir=user), os.path.join(user, ".gezel"))

    def test_answers_means_something_is_listening(self):
        daemon = StubDaemon()
        try:
            self.assertTrue(_answers(daemon.port))
        finally:
            daemon.close()
        self.assertFalse(_answers(daemon.port))

    def test_reads_port_and_cert(self):
        with tempfile.TemporaryDirectory() as home:
            os.makedirs(os.path.join(home, "runtime"))
            with open(os.path.join(home, "runtime", "port"), "w") as f:
                f.write("6228\n")
            self.assertEqual(discover(home).base_url, "http://127.0.0.1:6228")
            with open(os.path.join(home, "runtime", "cert.pem"), "w") as f:
                f.write("PEM")
            endpoint = discover(home)
            self.assertEqual(endpoint.scheme, "https")
            self.assertTrue(endpoint.cert_path.endswith("cert.pem"))

    def test_missing_port_means_not_running(self):
        with tempfile.TemporaryDirectory() as home:
            with self.assertRaises(DaemonNotRunning):
                discover(home)


class SseTests(unittest.TestCase):
    def test_parses_frames_comments_and_multiline_data(self):
        raw = b": ping\r\n\r\ndata: {\"a\":1}\n\ndata: line1\ndata: line2\n\nevent: x\ndata: last\n"
        self.assertEqual(list(parse_sse_lines(io.BytesIO(raw))), ['{"a":1}', "line1\nline2", "last"])

    def test_stops_when_asked(self):
        stop = threading.Event()
        stop.set()
        self.assertEqual(list(parse_sse_lines(io.BytesIO(b"data: x\n\n"), stop)), [])


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.daemon = StubDaemon()
        self.home = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.home, "runtime"))
        with open(os.path.join(self.home, "runtime", "port"), "w") as f:
            f.write(str(self.daemon.port))
        self.http = GezelHttp(self.home)

    def tearDown(self):
        self.daemon.close()

    def test_json_round_trip_with_bearer(self):
        self.daemon.routes[("POST", "/echo")] = lambda body, _p, _h: (200, {"got": body})
        self.assertEqual(self.http.request_json("POST", "/echo", {"x": 1}, token="t"), {"got": {"x": 1}})
        self.assertEqual(self.daemon.requests[-1][3], "Bearer t")

    def test_errors_carry_status_and_code(self):
        self.daemon.routes[("GET", "/nope")] = lambda *_: (409, {"error": "already_connected"})
        with self.assertRaises(HttpError) as ctx:
            self.http.request_json("GET", "/nope")
        self.assertEqual(ctx.exception.status, 409)
        self.assertEqual(ctx.exception.code, "already_connected")

    def test_events_stream(self):
        self.daemon.routes[("GET", "/events")] = lambda *_: (200, ["data: one\n\n", "data: two\n\n"])
        self.assertEqual(list(self.http.events("/events")), ["one", "two"])

    def test_not_running(self):
        self.daemon.close()
        with self.assertRaises(DaemonNotRunning):
            self.http.request_json("GET", "/x", timeout=2)


if __name__ == "__main__":
    unittest.main()
