"""Offer the extension's document tools to the project's gezels while the
panel is open, through the daemon's app-tool relay (ADR 0013). Calls arrive
on a background thread; `run_on_main` executes each handler where UNO
document calls are safe."""

from __future__ import annotations

import json
import threading
import time
import urllib.parse

from .client import HttpError


class Relay:
    def __init__(self, http, token, project_id, label, tools, run_on_main, on_status=None, sleep=time.sleep):
        """`tools` is a list of {name, description, inputSchema, timeoutMs?, handler}."""
        self.http = http
        self.token = token
        self.project_id = project_id
        self.label = label
        self._tools = {t["name"]: t for t in tools}
        self._run_on_main = run_on_main
        self._on_status = on_status or (lambda status: None)
        self._sleep = sleep
        self._stop = threading.Event()
        self._relay_id = None
        self._thread = None
        self._lock = threading.Lock()

    # ── wire ────────────────────────────────────────────────────────────
    def _open(self):
        body = {"label": self.label[:80]} if self.label else {}
        opened = self.http.request_json("POST", "/api/app-tools/relays", body, token=self.token)
        return opened["relayId"]

    def _publish(self, relay_id):
        definitions = []
        for tool in self._tools.values():
            d = {"name": tool["name"], "description": tool["description"], "inputSchema": tool["inputSchema"]}
            if tool.get("timeoutMs"):
                d["timeoutMs"] = tool["timeoutMs"]
            definitions.append(d)
        self.http.request_json(
            "PUT",
            f"/api/app-tools/relays/{urllib.parse.quote(relay_id)}/tools",
            {"projectId": self.project_id, "tools": definitions},
            token=self.token,
        )

    def _answer(self, relay_id, call):
        tool = self._tools.get(call.get("tool"))
        if tool is None:
            result = {"ok": False, "error": f'this panel no longer offers "{call.get("tool")}"'}
        else:
            try:
                output = self._run_on_main(lambda: tool["handler"](call.get("arguments") or {}))
                result = {"ok": True, "content": output if isinstance(output, str) else json.dumps(output)}
            except Exception as err:  # noqa: BLE001 - an ordinary tool failure
                result = {"ok": False, "error": str(err)[:3900] or "The tool failed."}
        try:
            self.http.request_json(
                "POST",
                f"/api/app-tools/relays/{urllib.parse.quote(relay_id)}/calls/{urllib.parse.quote(call['callId'])}/result",
                result,
                token=self.token,
            )
        except HttpError as err:
            if err.status != 404:  # 404: the daemon gave up waiting
                raise

    # ── lifecycle ───────────────────────────────────────────────────────
    def start(self):
        self._thread = threading.Thread(target=self._pump, name="gezel-relay", daemon=True)
        self._thread.start()

    def _pump(self):
        backoff = 0.5
        while not self._stop.is_set():
            try:
                with self._lock:
                    if not self._relay_id:
                        self._relay_id = self._open()
                        self._publish(self._relay_id)
                relay_id = self._relay_id
                self._on_status("connected")
                backoff = 0.5
                path = f"/api/app-tools/relays/{urllib.parse.quote(relay_id)}/events"
                for data in self.http.events(path, token=self.token, timeout=60, stop=self._stop):
                    if not data:
                        continue
                    try:
                        event = json.loads(data)
                    except ValueError:
                        continue
                    if event.get("type") == "tool_call":
                        threading.Thread(target=self._answer, args=(relay_id, event), daemon=True).start()
                    elif event.get("type") == "closed":
                        self._relay_id = None
                        break
            except HttpError as err:
                if err.status == 404:
                    self._relay_id = None
                    continue
                if err.status == 401:
                    self._on_status("unauthorized")
                    return
            except Exception:  # noqa: BLE001 - reconnect with backoff
                pass
            if self._stop.is_set():
                break
            self._on_status("reconnecting")
            self._sleep(backoff)
            backoff = min(backoff * 2, 8.0)
        self._on_status("closed")

    def update(self, tools):
        self._tools = {t["name"]: t for t in tools}
        with self._lock:
            if self._relay_id:
                self._publish(self._relay_id)

    def stop(self):
        self._stop.set()
        relay_id = self._relay_id
        self._relay_id = None
        if relay_id:
            try:
                self.http.request_json(
                    "DELETE", f"/api/app-tools/relays/{urllib.parse.quote(relay_id)}", token=self.token, timeout=5
                )
            except Exception:  # noqa: BLE001 - the daemon's grace window cleans up
                pass
