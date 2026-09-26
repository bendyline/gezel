"""Run work on LibreOffice's main thread. UNO document and UI calls from a
worker thread can deadlock against the application's own lock, so every
HTTP-driven callback (chat deltas, tool calls) comes through here."""

from __future__ import annotations

import threading

import unohelper
from com.sun.star.awt import XCallback


class _Callback(unohelper.Base, XCallback):
    def __init__(self, fn):
        self._fn = fn

    def notify(self, _data):
        self._fn()


class MainThread:
    def __init__(self, ctx):
        self._async = ctx.ServiceManager.createInstanceWithContext("com.sun.star.awt.AsyncCallback", ctx)
        self._main = threading.current_thread()

    def post(self, fn):
        """Fire and forget."""
        if threading.current_thread() is self._main:
            fn()
            return
        self._async.addCallback(_Callback(fn), None)

    def call(self, fn, timeout=60.0):
        """Run `fn` on the main thread and return its result (or raise)."""
        if threading.current_thread() is self._main:
            return fn()
        done = threading.Event()
        box = {}

        def run():
            try:
                box["value"] = fn()
            except BaseException as err:  # noqa: BLE001 - re-raised on the caller's thread
                box["error"] = err
            finally:
                done.set()

        self._async.addCallback(_Callback(run), None)
        if not done.wait(timeout):
            raise TimeoutError("LibreOffice did not answer in time.")
        if "error" in box:
            raise box["error"]
        return box.get("value")
