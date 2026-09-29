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

    def write_owner_token(self, token="OWNER"):
        with open(os.path.join(self.home, "runtime", "auth-token"), "w") as f:
            f.write(token + "\n")

    def test_owner_credential_connects_without_a_code(self):
        self.write_owner_token()
        codes = []
        self.daemon.routes[("POST", "/v1/apps/local-connect")] = lambda body, _p, headers: (
            (200, {"appId": "libreoffice", "token": "claimed"})
            if headers.get("Authorization") == "Bearer OWNER" and body == {"appId": "libreoffice"}
            else (400, {"error": "unexpected"})
        )
        token = ensure_token(self.http, self.store, codes.append, home=self.home)
        self.assertEqual(token, "claimed")
        self.assertEqual(self.store.load(), "claimed")
        self.assertEqual(codes, [])
        self.assertFalse(any(r[1] == "/v1/apps/register" for r in self.daemon.requests))

    def test_a_revoked_token_reconnects_as_the_owner(self):
        self.store.save("revoked")
        self.write_owner_token()
        self.daemon.routes[("GET", "/api/config")] = lambda *_: (401, {"error": "unauthorized"})
        self.daemon.routes[("POST", "/v1/apps/local-connect")] = lambda *_: (200, {"token": "fresh"})
        self.assertEqual(ensure_token(self.http, self.store, lambda _c: None, home=self.home), "fresh")

    def test_falls_back_to_the_code_when_the_daemon_declines(self):
        self.write_owner_token()
        codes = []
        self.daemon.routes[("POST", "/v1/apps/local-connect")] = lambda *_: (404, {"error": "not_found"})
        self.daemon.routes[("POST", "/v1/apps/register")] = lambda *_: (
            202,
            {"grantRequestId": "g", "status": "pending", "verificationCode": "XYZ789"},
        )
        self.daemon.routes[("GET", "/v1/apps/grant/g")] = lambda *_: (200, {"status": "approved", "token": "coded"})
        self.assertEqual(ensure_token(self.http, self.store, codes.append, home=self.home), "coded")
        self.assertEqual(codes, ["XYZ789"])

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
