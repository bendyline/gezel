const { contextBridge, ipcRenderer } = require('electron');

// Pull the live connection details from the main process synchronously at
// preload time. This re-runs on every page load, so a BrowserWindow.reload()
// after a supervisor restart naturally picks up the rotated token and any
// new port. Only the non-secret base URL has a CLI-arg fallback for E2E.
function readArg(prefix) {
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

let conn = null;
try {
  conn = ipcRenderer.sendSync('gezel:current-connection');
} catch {
  // First-run or test harness — fall through to CLI args.
}

const token = conn?.token ?? '';
const baseUrl = conn?.baseUrl ?? readArg('--gezel-url=') ?? '';
const fallbackReason = conn?.fallbackReason ?? null;
const fallbackCode = conn?.fallbackCode ?? null;
const mode = conn?.mode ?? null;

// Register at preload evaluation time so an OS open-file handoff sent as soon
// as the page finishes loading cannot race React's later effect registration.
const pendingModelBundleOpens = [];
let modelBundleOpenCallback = null;
ipcRenderer.on('gezel:open-model-bundle', (_event, request) => {
  if (modelBundleOpenCallback) modelBundleOpenCallback(request);
  else pendingModelBundleOpens.push(request);
});

const modelBundleExportProgressCallbacks = new Set();
ipcRenderer.on('gezel:model-bundle-export-progress', (_event, progress) => {
  for (const callback of modelBundleExportProgressCallbacks) callback(progress);
});
const modelBundleImportProgressCallbacks = new Set();
ipcRenderer.on('gezel:model-bundle-import-progress', (_event, progress) => {
  for (const callback of modelBundleImportProgressCallbacks) callback(progress);
});

// The native Help menu can be clicked after the page load finishes but before
// React's passive effects register the dialog callback. Buffer that one-shot
// request in preload so the menu is reliable during the first paint.
let pendingMacUninstallShow = false;
const macUninstallShowCallbacks = new Set();
ipcRenderer.on('gezel:show-uninstall', () => {
  if (macUninstallShowCallbacks.size === 0) {
    pendingMacUninstallShow = true;
    return;
  }
  for (const callback of macUninstallShowCallbacks) callback();
});

contextBridge.exposeInMainWorld('__GEZEL__', {
  token,
  baseUrl,
  platform: process.platform,
  fallbackReason,
  fallbackCode,
  mode,
  // Opens the native OS folder picker and resolves to the chosen absolute
  // path, or null if the user cancelled.
  selectDirectory: (opts) => ipcRenderer.invoke('dialog:selectDirectory', opts),
  // Mailbox OAuth: `mailOAuthListen` stands up a loopback redirect listener and
  // returns its URI; `mailOAuthAwait` opens the consent page and resolves the
  // captured authorization code. Used by the New Project dialog's email kind.
  // `opts.port` pins the listener to a fixed port for providers that match
  // redirect URIs exactly (X, Meta); omitted, the OS picks an ephemeral one.
  mailOAuthListen: (opts) => ipcRenderer.invoke('mail:oauth-listen', opts ?? null),
  mailOAuthAwait: (requestId, authUrl) =>
    ipcRenderer.invoke('mail:oauth-await', { requestId, authUrl }),
  autostart: {
    status: () => ipcRenderer.invoke('gezel:autostart:status'),
    install: () => ipcRenderer.invoke('gezel:autostart:install'),
    uninstall: () => ipcRenderer.invoke('gezel:autostart:uninstall'),
  },
  // Ambient display (wallpaper). The renderer never supplies paths — the
  // main process resolves everything from GEZEL_HOME.
  ambient: {
    status: () => ipcRenderer.invoke('gezel:ambient:status'),
    enable: () => ipcRenderer.invoke('gezel:ambient:enable'),
    disable: () => ipcRenderer.invoke('gezel:ambient:disable'),
    applyNow: () => ipcRenderer.invoke('gezel:ambient:apply-now'),
    openFolder: () => ipcRenderer.invoke('gezel:ambient:open-folder'),
  },
  // macOS PKG uninstall. The renderer sends only boolean data-retention
  // choices; the main process resolves the signed bundled script and owns the
  // administrator prompt. The menu uses the push callback to open the same
  // dialog as Settings → About.
  uninstall: {
    start: (selection) => ipcRenderer.invoke('gezel:uninstall:start', selection),
    onShowRequested: (callback) => {
      macUninstallShowCallbacks.add(callback);
      if (pendingMacUninstallShow) {
        pendingMacUninstallShow = false;
        queueMicrotask(callback);
      }
      return () => macUninstallShowCallbacks.delete(callback);
    },
  },
  // Content backups. The renderer only asks the OS where the file should go;
  // the daemon does the reading and writing, so a multi-gigabyte archive
  // never travels through the renderer.
  backupFile: {
    chooseSavePath: (defaultName) =>
      ipcRenderer.invoke('gezel:backup:choose-save-path', defaultName ?? null),
    chooseOpenPath: () => ipcRenderer.invoke('gezel:backup:choose-open-path'),
  },
  // Knowledge catalog install: pick a .gezk; the daemon does the reading.
  selectKnowledgeArchive: async () => {
    const result = await ipcRenderer.invoke('gezel:knowledge:choose-archive');
    return result?.path ?? null;
  },
  // App updates. `state` is the pull for a freshly-mounted renderer;
  // `onStateChanged` is the push for transitions while it is open. `install`
  // opens the verified installer on macOS (Installer.app raises the admin
  // prompt) and defers to the signed NSIS updater on Windows. Linux update
  // states are notification-only and never invoke `install`.
  update: {
    state: () => ipcRenderer.invoke('gezel:update:state'),
    install: () => ipcRenderer.invoke('gezel:update:install'),
    onStateChanged: (callback) => {
      ipcRenderer.on('gezel:update-state', (_event, state) => callback(state));
    },
  },
  // Open the service's `~/.gezel/logs/` folder in the OS file manager.
  // Used by Settings → General. Returns an error string (empty on
  // success) mirroring Electron's `shell.openPath` convention.
  openLogsFolder: () => ipcRenderer.invoke('gezel:open-logs-folder'),
  // Open an arbitrary folder in the OS file manager. Used by Settings →
  // Folders. Returns an error string (empty on success) mirroring
  // Electron's `shell.openPath` convention.
  openPath: (target) => ipcRenderer.invoke('gezel:open-path', target),
  // References-pane file actions stay behind main-process IPC: the renderer
  // identifies a daemon-scoped file, while Electron owns native dialogs and
  // OS file-manager integration.
  saveReferenceCopy: (request) => ipcRenderer.invoke('gezel:save-reference-copy', request),
  showReferenceInFolder: (request) => ipcRenderer.invoke('gezel:show-reference-in-folder', request),
  onNavigate: (callback) => {
    ipcRenderer.on('gezel:navigate', (_event, view) => callback(view));
  },
  exportModelBundle: (engine, id, exportId) =>
    ipcRenderer.invoke('gezel:export-model-bundle', { engine, id, exportId }),
  cancelModelBundleExport: (exportId) =>
    ipcRenderer.invoke('gezel:cancel-model-bundle-export', exportId),
  skipModelBundleExportVerification: (exportId) =>
    ipcRenderer.invoke('gezel:skip-model-bundle-export-verification', exportId),
  onModelBundleExportProgress: (callback) => {
    modelBundleExportProgressCallbacks.add(callback);
    return () => modelBundleExportProgressCallbacks.delete(callback);
  },
  scanOpenedModelBundle: (requestId, scanId) =>
    ipcRenderer.invoke('gezel:scan-opened-model-bundle', { requestId, scanId }),
  cancelModelBundleImport: (scanId) =>
    ipcRenderer.invoke('gezel:cancel-model-bundle-import', scanId),
  onModelBundleImportProgress: (callback) => {
    modelBundleImportProgressCallbacks.add(callback);
    return () => modelBundleImportProgressCallbacks.delete(callback);
  },
  onOpenModelBundle: (callback) => {
    modelBundleOpenCallback = callback;
    while (pendingModelBundleOpens.length > 0) callback(pendingModelBundleOpens.shift());
  },
  // Restart the gezel service. Used by the Folders settings tab after a
  // successful externalization move so the new path config takes
  // effect. The supervisor handles embedded vs. spawned modes; the
  // BrowserWindow auto-reloads via the existing supervisor-restart
  // listener once the service is back.
  restartService: (reason) => ipcRenderer.invoke('gezel:restart-service', reason),
  // Push the latest config to the main process so the system tray stays
  // in sync (engagement-mode radio) and is created/destroyed when the
  // showSystemTray preference flips. The renderer calls this whenever it
  // updates config; the main handler only mutates tray state (no echo
  // back), so there's no loop with the mode-set channel below.
  syncConfig: (cfg) => ipcRenderer.send('gezel:tray:sync-config', cfg),
  // Push the theme preference down to Chromium's own colour-scheme setting.
  // The sandboxed preview iframe is a null-origin document, so this is the
  // only route by which a project-type page learns the user picked Dark.
  setNativeTheme: (pref) => ipcRenderer.send('gezel:set-native-theme', pref),
  // Fired when the tray menu changes the engagement mode, so the in-app
  // header menu reflects it. Mirrors onNavigate's callback-proxy pattern
  // (DOM CustomEvents don't cross the contextIsolation boundary, so the
  // renderer registers a callback here instead).
  onEngagementModeChanged: (callback) => {
    ipcRenderer.on('gezel:tray:mode-set', (_event, mode) => callback(mode));
  },
  // Raise an OS notification on the renderer's behalf.
  notify: (opts) => ipcRenderer.invoke('gezel:notify', opts),
  // Screenshot a region of this page (CSS/DIP pixels) as a PNG data URL.
  // The output pane uses this to grab its sandboxed preview iframe, which
  // can't be rasterized from the renderer because it runs null-origin.
  capturePageRegion: (rect) => ipcRenderer.invoke('gezel:capture-page-region', rect),
});
