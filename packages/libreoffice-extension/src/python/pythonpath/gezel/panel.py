"""The Gezel sidebar panel: connection state, a transcript, an input, a gezel
picker, and "Allow edits". Everything network-bound runs on worker threads;
every UI change goes through dispatch.MainThread."""

from __future__ import annotations

import threading

import uno
import unohelper
from com.sun.star.awt import Selection, XActionListener, XItemListener, XWindowListener
from com.sun.star.awt.PosSize import POSSIZE
from com.sun.star.lang import XComponent
from com.sun.star.ui import LayoutSize, XSidebarPanel, XToolPanel, XUIElement
from com.sun.star.ui.UIElementType import TOOLPANEL

from .chat import ChatThread
from .client import GezelHttp, HttpError
from .consent import ConsentError, TokenStore, ensure_token
from .discovery import DaemonNotRunning, gezel_home
from .dispatch import MainThread
from .log import get_logger
from .project import infer_project, list_gezels, pick_default_gezel
from .relay import Relay
from .toolspec import tools_for
from .uno_docs import adapter_for, document_kind, document_path

KIND_LABELS = {"writer": "Writer", "calc": "Calc", "impress": "Impress"}
PAD = 6
ROW = 26


def _service(ctx, name):
    return ctx.ServiceManager.createInstanceWithContext(name, ctx)


class _Action(unohelper.Base, XActionListener):
    def __init__(self, fn):
        self._fn = fn

    def actionPerformed(self, _event):
        self._fn()

    def disposing(self, _event):
        pass


class _Item(unohelper.Base, XItemListener):
    def __init__(self, fn):
        self._fn = fn

    def itemStateChanged(self, _event):
        self._fn()

    def disposing(self, _event):
        pass


class _Resize(unohelper.Base, XWindowListener):
    def __init__(self, fn):
        self._fn = fn

    def windowResized(self, _event):
        self._fn()

    def windowMoved(self, _event):
        pass

    def windowShown(self, _event):
        self._fn()

    def windowHidden(self, _event):
        pass

    def disposing(self, _event):
        pass


class PanelView:
    """The controls, laid out top to bottom, resized with the sidebar."""

    def __init__(self, ctx, parent_window):
        self.ctx = ctx
        self.parent = parent_window
        toolkit = _service(ctx, "com.sun.star.awt.Toolkit")
        self.container = _service(ctx, "com.sun.star.awt.UnoControlContainer")
        self.container.setModel(_service(ctx, "com.sun.star.awt.UnoControlContainerModel"))
        self.container.createPeer(toolkit, parent_window)
        self.controls = {}
        self._add("status", "FixedText", Label="", MultiLine=True)
        self._add("code", "Edit", Text="", ReadOnly=True, Align=1)
        self._add("copy", "Button", Label="Copy code")
        self._add("connect", "Button", Label="Connect to Gezel")
        self._add("gezel", "ListBox", Dropdown=True)
        self._add("edits", "CheckBox", Label="Allow edits", State=1)
        self._add("transcript", "Edit", Text="", MultiLine=True, ReadOnly=True, VScroll=True, AutoVScroll=True)
        self._add("input", "Edit", Text="", MultiLine=True, VScroll=True, AutoVScroll=True)
        self._add("send", "Button", Label="Send")
        self.parent.addWindowListener(_Resize(self.layout))
        self.layout()

    def _add(self, name, kind, **props):
        model = _service(self.ctx, f"com.sun.star.awt.UnoControl{kind}Model")
        for key, value in props.items():
            setattr(model, key, value)
        control = _service(self.ctx, f"com.sun.star.awt.UnoControl{kind}")
        control.setModel(model)
        self.container.addControl(name, control)
        self.controls[name] = control

    def model(self, name):
        return self.controls[name].getModel()

    def show(self, name, visible):
        self.controls[name].setVisible(visible)

    def layout(self):
        size = self.parent.getPosSize()
        width = max(size.Width, 200)
        height = max(size.Height, 300)
        self.container.setPosSize(0, 0, width, height, POSSIZE)
        inner = width - 2 * PAD
        y = PAD
        self.controls["status"].setPosSize(PAD, y, inner, 2 * ROW, POSSIZE)
        y += 2 * ROW + PAD
        # The code row and the Connect button share a row; only one is ever shown.
        self.controls["code"].setPosSize(PAD, y, inner - 90, ROW, POSSIZE)
        self.controls["copy"].setPosSize(PAD + inner - 84, y, 84, ROW, POSSIZE)
        self.controls["connect"].setPosSize(PAD, y, inner, ROW, POSSIZE)
        y += ROW + PAD
        self.controls["gezel"].setPosSize(PAD, y, inner - 110, ROW, POSSIZE)
        self.controls["edits"].setPosSize(PAD + inner - 104, y, 104, ROW, POSSIZE)
        y += ROW + PAD
        input_h = 3 * ROW
        transcript_h = max(height - y - input_h - ROW - 3 * PAD, 3 * ROW)
        self.controls["transcript"].setPosSize(PAD, y, inner, transcript_h, POSSIZE)
        y += transcript_h + PAD
        self.controls["input"].setPosSize(PAD, y, inner, input_h, POSSIZE)
        y += input_h + PAD
        self.controls["send"].setPosSize(PAD + inner - 90, y, 90, ROW, POSSIZE)

    def set_status(self, text):
        self.model("status").Label = text

    def append(self, text):
        model = self.model("transcript")
        model.Text = model.Text + text
        length = len(model.Text)
        try:
            self.controls["transcript"].setSelection(Selection(length, length))
        except Exception:  # noqa: BLE001
            pass

    def set_gezels(self, names, selected_index):
        model = self.model("gezel")
        model.StringItemList = tuple(names)
        if names:
            uno.invoke(model, "setPropertyValue", ("SelectedItems", uno.Any("[]short", (selected_index,))))

    def selected_gezel_index(self):
        items = self.model("gezel").SelectedItems
        return items[0] if items else -1

    def dispose(self):
        try:
            self.container.dispose()
        except Exception:  # noqa: BLE001
            pass


class PanelSession:
    """Connect, chat, and offer document tools for one document window."""

    def __init__(self, ctx, frame, view: PanelView):
        self.ctx = ctx
        self.frame = frame
        self.view = view
        self.main = MainThread(ctx)
        self.log = get_logger()
        self.model = frame.getController().getModel() if frame is not None else None
        self.kind = document_kind(self.model)
        self.path = document_path(self.model)
        self.home = gezel_home()
        self.http = GezelHttp(self.home)
        self.store = TokenStore.for_home(self.home)
        self.token = None
        self.project = None
        self.roster = []
        self.gezel_id = None
        self.edits = True
        self.chat = None
        self.relay = None
        self.relay_status = "closed"
        self.busy = False
        self.cancel = threading.Event()

        view.controls["connect"].addActionListener(_Action(self.connect))
        view.controls["send"].addActionListener(_Action(self.send))
        view.controls["copy"].addActionListener(_Action(self.copy_code))
        view.controls["gezel"].addItemListener(_Item(self.on_gezel_changed))
        view.controls["edits"].addItemListener(_Item(self.on_edits_changed))
        self._show_connect()
        if self.kind is None:
            view.set_status("Open Gezel from Writer, Calc, or Impress.")
            view.show("connect", False)
        elif self.store.load():
            self.connect()

    # ── states ──────────────────────────────────────────────────────────
    def _show_connect(self, message="Connect this document to Gezel to chat with your gezels about it."):
        self.view.set_status(message)
        for name, visible in (("connect", True), ("code", False), ("copy", False), ("gezel", False), ("edits", False), ("send", False), ("input", False), ("transcript", False)):
            self.view.show(name, visible)

    def _show_code(self, code):
        self.view.set_status("In the Gezel app, approve LibreOffice and enter this code. You only do this once.")
        self.view.model("code").Text = code
        for name, visible in (("connect", False), ("code", True), ("copy", True)):
            self.view.show(name, visible)

    def _show_ready(self):
        project = self.project or {}
        suffix = " (read-only folder: gezels edit this document through the panel)" if project.get("readOnly") else ""
        self.view.set_status(f"Project: {project.get('name', 'Default')}{suffix}")
        for name, visible in (("connect", False), ("code", False), ("copy", False), ("gezel", True), ("edits", True), ("send", True), ("input", True), ("transcript", True)):
            self.view.show(name, visible)
        names = [g.get("name", g.get("id", "?")) for g in self.roster]
        index = next((i for i, g in enumerate(self.roster) if g.get("id") == self.gezel_id), 0)
        self.view.set_gezels(names, index)
        self.view.layout()

    # ── actions ─────────────────────────────────────────────────────────
    def connect(self):
        if self.busy:
            return
        self.busy = True
        self.view.set_status("Connecting to Gezel…")
        self.view.show("connect", False)

        def work():
            try:
                token = ensure_token(
                    self.http,
                    self.store,
                    on_code=lambda code: self.main.post(lambda: self._show_code(code)),
                    cancel=self.cancel,
                )
                project = infer_project(self.http, token, self.path)
                roster = list_gezels(self.http, token)
                config = self.http.request_json("GET", "/api/config", token=token)
                gezel_id = pick_default_gezel(project, roster, config.get("meesterGezelId"))

                def ready():
                    self.token, self.project, self.roster, self.gezel_id = token, project, roster, gezel_id
                    self.chat = ChatThread(self.http, token, project["id"], gezel_id)
                    self._show_ready()
                    self._start_relay()

                self.main.post(ready)
            except ConsentError as err:
                self.main.post(lambda: self._show_connect(str(err)))
            except DaemonNotRunning:
                self.main.post(lambda: self._show_connect("Gezel is not running. Start Gezel, then connect."))
            except HttpError as err:
                if err.status in (401, 403):
                    self.store.clear()
                self.main.post(lambda: self._show_connect(f"Could not connect: {err}"))
            except Exception as err:  # noqa: BLE001
                self.log.exception("connect failed")
                self.main.post(lambda: self._show_connect(f"Could not connect: {err}"))
            finally:
                self.busy = False

        threading.Thread(target=work, name="gezel-connect", daemon=True).start()

    def copy_code(self):
        try:
            from com.sun.star.datatransfer import XTransferable, DataFlavor

            text = self.view.model("code").Text

            class _Text(unohelper.Base, XTransferable):
                def getTransferData(self, _flavor):
                    return text

                def getTransferDataFlavors(self):
                    return (DataFlavor("text/plain;charset=utf-16", "Unicode-Text", uno.getTypeByName("string")),)

                def isDataFlavorSupported(self, flavor):
                    return flavor.MimeType.startswith("text/plain")

            clipboard = _service(self.ctx, "com.sun.star.datatransfer.clipboard.SystemClipboard")
            clipboard.setContents(_Text(), None)
            self.view.model("copy").Label = "Copied"
        except Exception:  # noqa: BLE001 - the code stays visible to type by hand
            self.log.exception("copy failed")

    def send(self):
        if not self.chat:
            return
        message = self.view.model("input").Text.strip()
        if not message:
            return
        self.view.model("input").Text = ""
        self.view.model("send").Enabled = False
        name = next((g.get("name") for g in self.roster if g.get("id") == self.gezel_id), "Gezel")
        self.view.append(f"You: {message}\n\n{name}: ")

        def on_delta(text):
            self.main.post(lambda: self.view.append(text))

        def on_tool(tool):
            self.main.post(lambda: self.view.append(f"\n[{tool}]\n"))

        def on_done():
            self.main.post(self._turn_ended)

        def on_error(error):
            self.main.post(lambda: (self.view.append(f"\n(Error: {error})"), self._turn_ended()))

        self.chat.send(message, on_delta, on_tool, on_done, on_error)

    def _turn_ended(self):
        self.view.append("\n\n")
        self.view.model("send").Enabled = True

    def on_gezel_changed(self):
        index = self.view.selected_gezel_index()
        if index < 0 or index >= len(self.roster):
            return
        chosen = self.roster[index].get("id")
        if chosen == self.gezel_id or not self.project:
            return
        self.gezel_id = chosen
        if self.chat:
            self.chat.close()
        self.chat = ChatThread(self.http, self.token, self.project["id"], chosen)
        self.view.append(f"(Now talking with {self.roster[index].get('name', chosen)}.)\n\n")

    def on_edits_changed(self):
        self.edits = self.view.model("edits").State == 1
        if self.relay:
            tools = self._tools()
            threading.Thread(target=lambda: self.relay.update(tools), daemon=True).start()

    # ── document tools ──────────────────────────────────────────────────
    def _describe(self):
        return {
            "host": KIND_LABELS.get(self.kind, "LibreOffice"),
            "title": (self.path or "Untitled document").replace("\\", "/").split("/")[-1],
            "path": self.path,
            "projectId": (self.project or {}).get("id"),
            "projectName": (self.project or {}).get("name"),
            "projectReadOnly": bool((self.project or {}).get("readOnly")),
            "editsEnabled": self.edits,
        }

    def _tools(self):
        adapter = adapter_for(self.kind, self.model)
        return tools_for(self.kind, self.edits, self._describe, adapter.selection_text, adapter)

    def _start_relay(self):
        def on_status(status):
            self.relay_status = status
            if status == "unauthorized":
                self.store.clear()
                self.main.post(lambda: self._show_connect("Gezel removed this connection. Connect again."))

        label = f"{KIND_LABELS.get(self.kind, 'LibreOffice')}: {self._describe()['title']}"
        self.relay = Relay(
            self.http,
            self.token,
            self.project["id"],
            label,
            self._tools(),
            run_on_main=lambda fn: self.main.call(fn, timeout=55),
            on_status=on_status,
        )
        self.relay.start()

    def dispose(self):
        self.cancel.set()
        if self.chat:
            self.chat.close()
        if self.relay:
            relay = self.relay
            threading.Thread(target=relay.stop, daemon=True).start()
        self.view.dispose()


class GezelPanel(unohelper.Base, XUIElement, XToolPanel, XSidebarPanel, XComponent):
    """The sidebar's UI element. LibreOffice reads Frame, ResourceURL, Type
    and Window as attributes."""

    def __init__(self, ctx, frame, parent_window, url):
        self.ctx = ctx
        self.Frame = frame
        self.ResourceURL = url
        self.Type = TOOLPANEL
        self.view = PanelView(ctx, parent_window)
        self.Window = self.view.container
        self.session = None
        try:
            self.session = PanelSession(ctx, frame, self.view)
        except Exception:  # noqa: BLE001
            get_logger().exception("panel session failed to start")
            self.view.set_status("Gezel could not start here. See ~/.gezel/logs/libreoffice-extension.log.")

    # XUIElement
    def getRealInterface(self):
        return self

    # XToolPanel
    def createAccessible(self, _parent):
        return self.Window.getAccessibleContext() if hasattr(self.Window, "getAccessibleContext") else None

    # XSidebarPanel
    def getHeightForWidth(self, _width):
        return LayoutSize(360, -1, 600)

    def getMinimalWidth(self):
        return 260

    # XComponent
    def dispose(self):
        if self.session:
            self.session.dispose()
        else:
            self.view.dispose()

    def addEventListener(self, _listener):
        pass

    def removeEventListener(self, _listener):
        pass
