"""One chat thread with one gezel in one project, streamed as plain text."""

from __future__ import annotations

import json
import threading
import urllib.parse

from .client import HttpError


class ChatThread:
    """Send a message and receive the reply as callbacks, from a worker
    thread. Callers marshal UI work to the main thread themselves."""

    def __init__(self, http, token, project_id, gezel_id):
        self.http = http
        self.token = token
        self.project_id = project_id
        self.gezel_id = gezel_id
        self.session_id = None
        self._stop = threading.Event()

    def _ensure_session(self):
        if self.session_id:
            return self.session_id
        created = self.http.request_json(
            "POST", "/api/sessions", {"gezelId": self.gezel_id, "projectId": self.project_id}, token=self.token
        )
        self.session_id = created["id"]
        return self.session_id

    def send(self, message, on_delta, on_tool, on_done, on_error):
        """Start a turn. Returns the worker thread."""

        def work():
            try:
                session_id = self._ensure_session()
                events_path = f"/events/chat?session={urllib.parse.quote(session_id)}"
                ready = threading.Event()
                failure = []

                def reader():
                    try:
                        stream = self.http.events(events_path, token=self.token, stop=self._stop)
                        ready.set()
                        for data in stream:
                            if not data:
                                continue
                            try:
                                event = json.loads(data)
                            except ValueError:
                                continue
                            kind = event.get("type")
                            if kind == "delta":
                                on_delta(event.get("content", ""))
                            elif kind == "tool":
                                on_tool(event.get("name", ""))
                            elif kind == "error":
                                on_error(event.get("error", "The turn failed."))
                                return
                            elif kind in ("done", "complete"):
                                on_done()
                                return
                    except Exception as err:  # noqa: BLE001 - surfaced to the panel
                        failure.append(err)
                        ready.set()

                listener = threading.Thread(target=reader, name="gezel-chat-events", daemon=True)
                listener.start()
                ready.wait(15)
                if failure:
                    raise failure[0]
                self.http.request_json(
                    "POST", f"/api/sessions/{urllib.parse.quote(session_id)}/send", {"message": message}, token=self.token
                )
                listener.join()
            except HttpError as err:
                on_error(str(err))
            except Exception as err:  # noqa: BLE001
                on_error(str(err))

        thread = threading.Thread(target=work, name="gezel-chat-send", daemon=True)
        thread.start()
        return thread

    def close(self):
        self._stop.set()
