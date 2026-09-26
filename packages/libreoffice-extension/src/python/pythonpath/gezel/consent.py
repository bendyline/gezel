"""The extension's own connection to Gezel: a `product` grant for app id
`libreoffice`, approved by the user typing a connection code into Gezel.
The token is kept 0600 under the Gezel home, beside the other integrations."""

from __future__ import annotations

import os
import time
import urllib.parse

from . import APP_ID, APP_NAME
from .client import HttpError


class ConsentError(Exception):
    """kind: denied | expired | timeout | already-connected | refused"""

    def __init__(self, kind, message):
        self.kind = kind
        super().__init__(message)


class TokenStore:
    def __init__(self, path):
        self.path = path

    @classmethod
    def for_home(cls, home):
        return cls(os.path.join(home, "integrations", "libreoffice", "token"))

    def load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                token = f.read().strip()
                return token or None
        except OSError:
            return None

    def save(self, token):
        folder = os.path.dirname(self.path)
        os.makedirs(folder, mode=0o700, exist_ok=True)
        tmp = f"{self.path}.tmp-{os.getpid()}"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(token)
        os.replace(tmp, self.path)
        try:
            os.chmod(self.path, 0o600)
        except OSError:
            pass

    def clear(self):
        try:
            os.remove(self.path)
        except OSError:
            pass


def token_works(http, token):
    """True when the token still opens the product API."""
    try:
        http.request_json("GET", "/api/config", token=token, timeout=15)
        return True
    except HttpError as err:
        if err.status in (401, 403):
            return False
        raise


def ensure_token(http, store, on_code, cancel=None, timeout=300.0, clock=time.monotonic):
    """A working token: the stored one, or a new grant the user approves.
    `on_code(code)` is called with the connection code to show."""
    token = store.load()
    if token and token_works(http, token):
        return token
    if token:
        store.clear()
    try:
        registered = http.request_json(
            "POST",
            "/v1/apps/register",
            {"appId": APP_ID, "appName": APP_NAME, "scopes": ["product"]},
        )
    except HttpError as err:
        if err.status == 409 and err.code == "already_connected":
            raise ConsentError(
                "already-connected",
                "Gezel already has a LibreOffice connection this computer no longer holds. "
                "In Gezel, open Settings, then Connected Apps, remove LibreOffice, and connect again.",
            ) from err
        raise ConsentError("refused", str(err)) from err
    if registered.get("status") == "approved" and registered.get("token"):
        store.save(registered["token"])
        return registered["token"]
    grant_id = registered.get("grantRequestId")
    if not grant_id:
        raise ConsentError("refused", "Gezel returned an incomplete answer.")
    if registered.get("verificationCode"):
        on_code(registered["verificationCode"])
    deadline = clock() + timeout
    while clock() < deadline:
        if cancel is not None and cancel.is_set():
            raise ConsentError("timeout", "Connecting was cancelled.")
        wait = max(1, min(30, int(deadline - clock())))
        path = f"/v1/apps/grant/{urllib.parse.quote(grant_id)}?wait={wait}"
        try:
            state = http.request_json("GET", path, timeout=wait + 15)
        except HttpError as err:
            if err.status == 404:
                raise ConsentError("expired", "The connection request expired.") from err
            raise
        status = state.get("status")
        if status == "approved" and state.get("token"):
            store.save(state["token"])
            return state["token"]
        if status == "denied":
            raise ConsentError("denied", "The connection was declined in Gezel.")
        if status == "expired":
            raise ConsentError("expired", "The connection code expired.")
    raise ConsentError("timeout", "The connection was not approved in time.")
