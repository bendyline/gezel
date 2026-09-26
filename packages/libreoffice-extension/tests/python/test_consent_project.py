import os
import stat
import tempfile
import unittest

import _path  # noqa: F401
from gezel.client import GezelHttp
from gezel.consent import ConsentError, TokenStore, ensure_token
from gezel.project import infer_project, pick_default_gezel
from stub_server import StubDaemon


class ConsentTests(unittest.TestCase):
    def setUp(self):
        self.daemon = StubDaemon()
        self.home = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.home, "runtime"))
        with open(os.path.join(self.home, "runtime", "port"), "w") as f:
            f.write(str(self.daemon.port))
        self.http = GezelHttp(self.home)
        self.store = TokenStore.for_home(self.home)

    def tearDown(self):
        self.daemon.close()

    def test_code_then_approval_stores_token_0600(self):
        codes = []
        self.daemon.routes[("POST", "/v1/apps/register")] = lambda body, _p, _h: (
            202,
            {"grantRequestId": "g1", "status": "pending", "verificationRequired": True, "verificationCode": "ABC123"},
        )
        self.daemon.routes[("GET", "/v1/apps/grant/g1")] = lambda *_: (200, {"status": "approved", "token": "tok"})
        token = ensure_token(self.http, self.store, codes.append)
        self.assertEqual(token, "tok")
        self.assertEqual(codes, ["ABC123"])
        self.assertEqual(self.store.load(), "tok")
        register_body = next(r[2] for r in self.daemon.requests if r[1] == "/v1/apps/register")
        self.assertEqual(register_body, {"appId": "libreoffice", "appName": "LibreOffice", "scopes": ["product"]})
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(os.stat(self.store.path).st_mode), 0o600)

    def test_reuses_a_working_token(self):
        self.store.save("kept")
        self.daemon.routes[("GET", "/api/config")] = lambda *_: (200, {})
        self.assertEqual(ensure_token(self.http, self.store, lambda _c: None), "kept")
        self.assertFalse(any(r[1] == "/v1/apps/register" for r in self.daemon.requests))

    def test_revoked_token_is_cleared_and_replaced(self):
        self.store.save("old")
        self.daemon.routes[("GET", "/api/config")] = lambda *_: (401, {"error": "unauthorized"})
        self.daemon.routes[("POST", "/v1/apps/register")] = lambda *_: (202, {"grantRequestId": "g", "status": "pending"})
        self.daemon.routes[("GET", "/v1/apps/grant/g")] = lambda *_: (200, {"status": "approved", "token": "new"})
        self.assertEqual(ensure_token(self.http, self.store, lambda _c: None), "new")

    def test_denied_and_already_connected(self):
        self.daemon.routes[("POST", "/v1/apps/register")] = lambda *_: (202, {"grantRequestId": "g", "status": "pending"})
        self.daemon.routes[("GET", "/v1/apps/grant/g")] = lambda *_: (200, {"status": "denied"})
        with self.assertRaises(ConsentError) as ctx:
            ensure_token(self.http, self.store, lambda _c: None)
        self.assertEqual(ctx.exception.kind, "denied")
        self.daemon.routes[("POST", "/v1/apps/register")] = lambda *_: (409, {"error": "already_connected"})
        with self.assertRaises(ConsentError) as ctx:
            ensure_token(self.http, self.store, lambda _c: None)
        self.assertEqual(ctx.exception.kind, "already-connected")

    def test_infers_the_project(self):
        self.daemon.routes[("POST", "/api/projects/infer-for-path")] = lambda body, _p, _h: (
            200,
            {"project": {"id": "docs", "name": "Documents"}, "readOnly": True, "matchedBy": "well-known", "echo": body},
        )
        project = infer_project(self.http, "t", "/Users/me/Documents/a.odt")
        self.assertEqual(project["id"], "docs")
        self.assertTrue(project["readOnly"])
        sent = next(r[2] for r in self.daemon.requests if r[1] == "/api/projects/infer-for-path")
        self.assertEqual(sent, {"kind": "document", "source": "libreoffice", "path": "/Users/me/Documents/a.odt"})

    def test_pick_default_gezel(self):
        roster = [{"id": "a"}, {"id": "b"}, {"id": "m"}]
        self.assertEqual(pick_default_gezel({"voormanGezelId": "a"}, roster, "m", "b"), "b")
        self.assertEqual(pick_default_gezel({"voormanGezelId": "a"}, roster, "m"), "a")
        self.assertEqual(pick_default_gezel({"gezelIds": ["x", "b"]}, roster, "m"), "b")
        self.assertEqual(pick_default_gezel({}, roster, "m"), "m")
        self.assertEqual(pick_default_gezel({}, [], None), "")


if __name__ == "__main__":
    unittest.main()
