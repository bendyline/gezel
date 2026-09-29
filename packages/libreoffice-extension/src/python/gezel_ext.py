"""UNO component entry for the Gezel extension.

LibreOffice adds the `pythonpath/` folder beside this file to `sys.path`,
which is where the `gezel` package lives. Two services:

  com.bendyline.gezel.ProtocolHandler   Tools > Gezel (`com.bendyline.gezel:open`)
  com.bendyline.gezel.PanelFactory      the sidebar panel
"""

import unohelper
from com.sun.star.frame import XDispatch, XDispatchProvider
from com.sun.star.lang import XInitialization, XServiceInfo
from com.sun.star.ui import XUIElementFactory

PROTOCOL = "com.bendyline.gezel:"
DECK_ID = "GezelDeck"


class ProtocolHandler(unohelper.Base, XDispatchProvider, XDispatch, XInitialization, XServiceInfo):
    IMPLEMENTATION = "com.bendyline.gezel.ProtocolHandler"
    SERVICES = ("com.sun.star.frame.ProtocolHandler",)

    def __init__(self, ctx, *args):
        self.ctx = ctx
        self.frame = None

    # XInitialization
    def initialize(self, args):
        if args:
            self.frame = args[0]

    # XDispatchProvider
    def queryDispatch(self, url, _target, _flags):
        return self if url.Protocol == PROTOCOL else None

    def queryDispatches(self, requests):
        return tuple(self.queryDispatch(r.FeatureURL, r.FrameName, r.SearchFlags) for r in requests)

    # XDispatch
    def dispatch(self, url, _args):
        if url.Path != "open" or self.frame is None:
            return
        try:
            sidebar = self.frame.getController().getSidebar()
            sidebar.setVisible(True)
            sidebar.getDecks().getByName(DECK_ID).activate(True)
            return
        except Exception:  # noqa: BLE001 - older builds: fall back to the dispatch command
            pass
        helper = self.ctx.ServiceManager.createInstanceWithContext("com.sun.star.frame.DispatchHelper", self.ctx)
        helper.executeDispatch(self.frame, f".uno:SidebarDeck.{DECK_ID}", "", 0, ())

    def addStatusListener(self, _listener, _url):
        pass

    def removeStatusListener(self, _listener, _url):
        pass

    # XServiceInfo
    def getImplementationName(self):
        return self.IMPLEMENTATION

    def supportsService(self, name):
        return name in self.SERVICES

    def getSupportedServiceNames(self):
        return self.SERVICES


class PanelFactory(unohelper.Base, XUIElementFactory, XServiceInfo):
    IMPLEMENTATION = "com.bendyline.gezel.PanelFactory"
    SERVICES = ("com.sun.star.ui.UIElementFactory",)

    def __init__(self, ctx, *args):
        self.ctx = ctx

    def createUIElement(self, url, args):
        frame = None
        parent = None
        for prop in args:
            if prop.Name == "Frame":
                frame = prop.Value
            elif prop.Name == "ParentWindow":
                parent = prop.Value
        # Imported lazily: a failure here must not stop LibreOffice
        # registering the rest of the extension.
        from gezel.panel import GezelPanel

        return GezelPanel(self.ctx, frame, parent, url)

    def getImplementationName(self):
        return self.IMPLEMENTATION

    def supportsService(self, name):
        return name in self.SERVICES

    def getSupportedServiceNames(self):
        return self.SERVICES


g_ImplementationHelper = unohelper.ImplementationHelper()
g_ImplementationHelper.addImplementation(ProtocolHandler, ProtocolHandler.IMPLEMENTATION, ProtocolHandler.SERVICES)
g_ImplementationHelper.addImplementation(PanelFactory, PanelFactory.IMPLEMENTATION, PanelFactory.SERVICES)
