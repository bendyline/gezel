// Electron's `electron` module is a special CommonJS module whose API is
// injected at runtime; importing named bindings with ESM statics doesn't
// work, and default-interop gives an empty wrapper on Node 22+. A dynamic
// `import()` round-trips through the CJS loader and produces a real module
// record with working bindings.
// Electron's `require('electron')` is injected by its custom module loader;
// the ESM `import` statement doesn't see the injection. Pull the API through
// `createRequire` so we go through Electron's patched CJS loader.
const require = createRequire(import.meta.url);
// biome-ignore format: `typeof import(...)` cannot be broken across lines
const { app, BrowserWindow, Menu, Notification, dialog, ipcMain, nativeTheme, powerMonitor, powerSaveBlocker, screen, session, shell } = require('electron') as typeof import('electron');
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  type FatalProcessErrorSource,
  type GezmodelImportProgress,
  type ReferenceFileLocationRequest,
  ReferenceFileLocationRequestSchema,
  installProcessErrorHandlers,
  writeProcessOutput,
} from '@bendyline/gezel';
import {
  GezelClient,
  createTrustingFetch,
  streamAllChatEvents,
} from '@bendyline/gezel-client/node';
import { ambientDir } from '@bendyline/gezel/paths';
import { ambientDashboardDisplayTarget } from './ambient-display/display-target.js';
import { ambientDisplay } from './ambient-display/index.js';
import {
  disable as ambientDisable,
  enable as ambientEnable,
  applyLatest,
  newestDatedImage,
  readDisplayState,
} from './ambient-display/runtime.js';
import { autostart } from './autostart/index.js';
import { resolveAutostartNodePath, resolveAutostartPnpmPath } from './autostart/runtime.js';
import {
  PREVIEW_FRAME_INDETERMINATE,
  daemonEntrypointArgument,
  isAllowedPreviewNavigation,
  isAllowedPreviewResourceRequest,
  isAllowedTopLevelNavigation,
  isExactApprovedPath,
  isExternalRendererNetworkRequest,
  isPreviewDocumentUrl,
  normalizedDocumentUrl,
  previewExternalServicesForFrame,
} from './electron-boundaries.js';
import { mainProcessIssueUrl } from './main-process-errors.js';
import {
  modelBytesFromResponse,
  verifyModelBundleArchive,
  writeModelBundleResponse,
} from './model-bundle-export.js';
import { findGezmodelArguments, portableGezmodelFilename } from './model-bundle-files.js';
import { QuitCoordinator } from './quit-coordinator.js';
import { rendererConnectionSnapshot } from './renderer-connection.js';
import { resolveRendererNetworkPermission } from './renderer-network-policy.js';
import { splashStage } from './splash-stage.js';
import { redirectAsarToUnpacked } from './supervisor/extract-bundle.js';
import { type Connection, connectOrStart } from './supervisor/index.js';
import { updateActiveTraySessions } from './tray-activity.js';
import { type EngagementMode, TrayController } from './tray.js';
import { parseMacUninstallSelection, scheduleMacUninstall } from './uninstaller/macos.js';
import { type UpdaterPermission, resolveUpdaterPermission } from './updater-policy.js';
import {
  type PublishedAppRelease,
  appReleaseFeedConfiguration,
  discoverLatestAppRelease,
} from './updater/app-release.js';
import {
  type UpdateState,
  downloadingUpdateState,
  shouldPublishDownloadState,
  updateErrorStage,
} from './updater/update-state.js';

/**
 * Electron's OS-integration boundary. Product state and model execution stay
 * in `gezeld`, while this process coordinates the supervisor, windows and
 * navigation policy, TLS trust, scoped preload IPC, native dialogs, OAuth,
 * import/export, autostart, updates, tray state, and orderly shutdown.
 *
 * Keep domain behavior behind the typed service client and keep IPC handlers
 * narrow: every hosting mode must behave the same whether `gezeld` is remote,
 * machine-wide, per-user, or embedded.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

let connection: Connection | null = null;
let mainWindow: Electron.BrowserWindow | null = null;
/** Permission snapshot carried by each capability URL's last HTML response. */
const previewDocumentExternalServices = new Map<string, boolean>();
const MAX_TRACKED_PREVIEW_DOCUMENTS = 512;
const PREVIEW_EXTERNAL_SERVICES_HEADER = 'x-gezel-preview-external-services';
/** True while the window is showing splash.html rather than the daemon UI. */
let splashShowing = false;
// The system tray (locus for notifications, status, and the engagement-mode
// toggle). Created/destroyed in response to the `showSystemTray` preference;
// null when disabled. See ./tray.ts.
let tray: TrayController | null = null;
// Main-process activity state keeps the menu-bar animation alive even when
// macOS has closed the last renderer window. The global chat SSE replays any
// in-flight turn when this process reconnects, so daemon restarts recover too.
const trayActiveSessions = new Set<string>();
let trayActivityAbort: AbortController | null = null;
// Cert-aware client for talking to the service from the main process —
// rebuilt whenever the supervisor rotates the token/cert on restart.
let apiClient: GezelClient | null = null;
const activeModelBundleExports = new Map<
  string,
  { controller: AbortController; webContentsId: number }
>();
const activeModelBundleImports = new Map<
  string,
  { controller: AbortController; webContentsId: number }
>();
let rendererNetworkPolicyEpoch = 0;
let rendererNetworkPermissionRead: {
  epoch: number;
  promise: ReturnType<typeof resolveRendererNetworkPermission>;
} | null = null;
let fatalMainProcessErrorInFlight = false;

function invalidateRendererNetworkPermission(): void {
  rendererNetworkPolicyEpoch += 1;
  rendererNetworkPermissionRead = null;
}

/**
 * Read the authoritative daemon config at the request sink. Simultaneous
 * subresource requests share one read, but settled decisions are not cached:
 * the next batch observes policy changes even if renderer IPC is compromised.
 */
async function rendererExternalNetworkAllowed(): Promise<boolean> {
  const epoch = rendererNetworkPolicyEpoch;
  let pending = rendererNetworkPermissionRead;
  if (!pending || pending.epoch !== epoch) {
    const client = apiClient;
    pending = {
      epoch,
      promise: resolveRendererNetworkPermission(client ? () => client.getConfig() : undefined),
    };
    rendererNetworkPermissionRead = pending;
  }

  const permission = await pending.promise;
  if (rendererNetworkPermissionRead === pending) rendererNetworkPermissionRead = null;
  if (rendererNetworkPolicyEpoch !== epoch) return rendererExternalNetworkAllowed();
  return permission.allowed;
}
// OS-opened files are represented in the renderer by opaque random ids. Only
// paths placed in this map by command-line/open-file handling can be scanned;
// a compromised renderer cannot turn the IPC method into arbitrary file read.
const openedModelBundles = new Map<string, { path: string; filename: string }>();
const queuedModelBundleOpens: Array<{ requestId: string; filename: string }> = [];
// Set true once a real quit is underway (tray "Quit", app menu, before-quit)
// so the close-to-tray handler lets the window actually close.
let isQuitting = false;
// When the tray is enabled, whether the window's close button quits the whole
// app (removing the tray icon) instead of hiding to the tray. Off by default
// (close-to-tray). Mirrors the `quitOnClose` preference; synced from config.
let quitOnClose = false;
/** Prevent duplicate administrator prompts while an uninstall is being scheduled. */
let macUninstallInFlight = false;
/** Native-menu request held while the branded startup splash is still active. */
let macUninstallDialogRequested = false;
// Held so the tray's "Check for updates" item can re-trigger a check.
let autoUpdaterRef: import('electron-updater').AppUpdater | null = null;
/** The exact app-tagged release selected for the current update check. */
let appUpdateRelease: PublishedAppRelease | null = null;
/** Latest updater lifecycle snapshot pushed to every renderer over IPC. */
let updateState: UpdateState | null = null;
/** Verified installer staged by the macOS update flow, awaiting the user. */
let macUpdatePkgPath: string | null = null;
const quitCoordinator = new QuitCoordinator({
  shutdown: async () => {
    if (connection) await connection.shutdown();
  },
  quitAgain: () => app.quit(),
  onError: (error) => console.warn('[app] service shutdown failed:', error),
});
const packagedSmoke =
  process.env.GEZEL_PACKAGED_SMOKE === '1' || process.argv.includes('--gezel-packaged-smoke');
const packagedSmokeHome = process.argv
  .find((arg) => arg.startsWith('--gezel-home='))
  ?.slice('--gezel-home='.length);
const packagedSmokeExpectedVersion =
  process.argv
    .find((arg) => arg.startsWith('--gezel-expected-version='))
    ?.slice('--gezel-expected-version='.length) || process.env.GEZEL_EXPECTED_VERSION;

// Electron otherwise turns these into its stock "A JavaScript error occurred
// in the main process" dialog, including a raw stack and internal paths. Keep
// both Node failure channels on Gezel's own final-error surface. The handler is
// installed before the ready/bootstrap chain so failures there are covered too.
installProcessErrorHandlers(process, handleFatalMainProcessError);

// Stable app identity. Set before app.whenReady() so platform shells
// pick it up while the first window is being created — anything we
// defer to ready will miss the initial taskbar/dock registration.
//
// Keep the runtime name explicit as well as declaring `productName` in
// package.json. Falling back to the scoped npm `name`
// (`@bendyline/gezel-app`) produces the unpolished `bendyline-gezel-app`
// label in Linux shells and can also change Electron's user-data identity.
app.setName('Gezel');

// A Linux desktop shell associates a live window with its .desktop entry by
// app_id (Wayland) or WM_CLASS (X11), not by the human-readable product name.
// Keep those identifiers aligned with package.json `desktopName` and
// electron-builder's `linux.syncDesktopName`. Dev gets a separate id so its
// launcher can coexist with an installed Gezel package without either dock
// entry stealing the other's windows.
const linuxDesktopId = app.isPackaged ? 'com.bendyline.gezel' : 'com.bendyline.gezel.dev';
if (process.platform === 'linux') {
  app.setDesktopName(`${linuxDesktopId}.desktop`);
  app.commandLine.appendSwitch('class', linuxDesktopId);
}

// We were handed the daemon entrypoint but booted as an application, which
// means whoever spawned us forgot `ELECTRON_RUN_AS_NODE=1` (see
// `daemonSpawnEnv` in @bendyline/gezel-client). Electron silently ignores a
// script argument in app mode, so without this the supervisor's spawn branch
// starts a second Gezel instead of gezeld: it never writes runtime files, the
// parent burns its whole startup budget waiting, falls back to embedded, and
// this copy spawns a third before anyone gives up. Fail immediately and name
// the cause instead.
const daemonEntryArgument = daemonEntrypointArgument(process.argv);
if (daemonEntryArgument) {
  console.error(
    `[app] refusing to boot: launched as an application with the daemon entrypoint ${daemonEntryArgument}. Spawn gezeld with ELECTRON_RUN_AS_NODE=1 in the child environment.`,
  );
  app.exit(1);
}

if (packagedSmoke) {
  writeProcessOutput(process.stderr, '[packaged-smoke] main module imported\n');
}

// Group every Gezel window under one taskbar button on Windows. Without
// this, launches are tagged with Electron's default AppUserModelID
// (`com.electron.<random>`) and Windows treats each launch as a
// distinct app — every window gets its own taskbar entry instead of
// stacking under the Gezel icon, the jump-list pinned-recent list shows
// duplicates, and the install-time pinned shortcut doesn't match the
// running process. The id must equal the `appId` in electron-builder.yml.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.bendyline.gezel');
}

// E2E/release-smoke isolation: redirect Chromium's userData dir into the
// test's `GEZEL_HOME` temp dir BEFORE the singleton-lock check. Electron stores
// `SingletonLock` (and Cache/, Cookies, blob_storage/, …) under
// userData, defaulting to `~/Library/Application Support/Gezel/` —
// shared with any installed `/Applications/Gezel.app`. Without this
// override, every Playwright launch hits the same lock file, sees the
// installed app's PID as alive, and `app.exit(0)`s before the window
// opens (clean exit, empty stderr — symptom is `electron.launch`
// failing with the ws disconnecting immediately after attach). Each
// e2e test passes a fresh tmpdir as GEZEL_HOME, so this scopes the
// lock per-test-run and lets the dev/test instance coexist with a
// production Gezel install.
if (process.env.GEZEL_E2E === '1' || packagedSmoke) {
  const isolatedHome = packagedSmokeHome || process.env.GEZEL_HOME;
  if (isolatedHome) app.setPath('userData', join(isolatedHome, '.electron-userdata'));
}

// Dev↔packaged coexistence. A dev launch (`electron .`) and an installed
// `/Applications/Gezel.app` both default Electron's `userData` — and thus the
// Chromium `SingletonLock` that `requestSingleInstanceLock()` checks just
// below — to the same `…/Application Support/Gezel/` dir, because they share
// productName "Gezel". The effect: starting the dev app while the packaged one
// runs (or vice-versa) makes the second launch see the first's lock, treat
// itself as a duplicate, and `app.exit(0)` before a window ever opens. The
// service layer is already isolated (dev → `~/.gezel-dev`, packaged →
// `~/.gezel`; see resolveLaunch), so scoping dev's `userData` to its own home
// is the only remaining piece needed to let the two run side by side. The
// E2E/smoke branch above is the same move for tests; this extends it to ordinary
// `pnpm app` dev runs. Skipped when E2E already scoped userData.
if (!app.isPackaged && process.env.GEZEL_E2E !== '1') {
  app.setPath('userData', join(resolveLaunch().home, '.electron-userdata'));
}

// Single-instance lock. Without it, every double-click of the exe (or
// every shortcut click while the app is launching but not yet visible)
// spawns a fresh main process — each with its own splash window, its
// own supervisor, its own embedded service boot. Users see a stack of
// "Gezel" windows in the taskbar and a few minutes of dueling sd-server
// orphans. With the lock, the second invocation exits immediately and
// the running instance focuses its window.
const gotPrimaryLock = app.requestSingleInstanceLock();
if (!gotPrimaryLock) {
  // `app.quit()` waits for `before-quit` handlers; on a duplicate
  // launch we have nothing to flush, so exit hard to avoid showing a
  // half-built splash window for the millisecond the quit takes.
  app.exit(0);
}
app.on('second-instance', (_event, commandLine, workingDirectory) => {
  for (const path of findGezmodelArguments(commandLine, workingDirectory || process.cwd())) {
    void queueOpenedModelBundle(path);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// macOS sends Finder double-clicks through open-file, sometimes before ready.
app.on('open-file', (event, path) => {
  event.preventDefault();
  void queueOpenedModelBundle(path);
});

for (const path of findGezmodelArguments(process.argv, process.cwd())) {
  void queueOpenedModelBundle(path);
}

async function queueOpenedModelBundle(candidate: string): Promise<void> {
  try {
    const path = await realpath(candidate);
    if (!path.toLowerCase().endsWith('.gezmodel') || !(await stat(path)).isFile()) return;
    const request = { requestId: randomUUID(), filename: basename(path) };
    openedModelBundles.set(request.requestId, { path, filename: request.filename });
    queuedModelBundleOpens.push(request);
    flushOpenedModelBundles();
  } catch {
    // A stale recent-file entry or a path that vanished before launch is not
    // actionable. The in-app Import button remains available.
  }
}

function flushOpenedModelBundles(): void {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return;
  while (queuedModelBundleOpens.length > 0) {
    const request = queuedModelBundleOpens.shift();
    if (request) mainWindow.webContents.send('gezel:open-model-bundle', request);
  }
}

interface ResolvedLaunch {
  home: string;
  forceEmbeddedFromCli: boolean;
}

/**
 * Resolve which GEZEL_HOME to use for this launch.
 *
 * Priority:
 *   1. `--gezel-home=<path>` CLI arg — also forces embedded mode so sandbox
 *      instances don't race each other on the local-adopt pid file.
 *   2. `GEZEL_HOME` env var (existing contract for tests and advanced users).
 *   3. Dev launches (`!app.isPackaged`) default to `~/.gezel-dev` so they
 *      don't pollute the real packaged-app data under `~/.gezel`.
 *   4. Packaged default — `~/.gezel`.
 */
function resolveLaunch(): ResolvedLaunch {
  const cliHomeArg = process.argv.find((a) => a.startsWith('--gezel-home='));
  if (cliHomeArg) {
    const home = cliHomeArg.slice('--gezel-home='.length);
    if (home.length > 0) return { home, forceEmbeddedFromCli: true };
  }
  if (process.env.GEZEL_HOME && process.env.GEZEL_HOME.length > 0) {
    return { home: process.env.GEZEL_HOME, forceEmbeddedFromCli: false };
  }
  if (!app.isPackaged) {
    return { home: join(homedir(), '.gezel-dev'), forceEmbeddedFromCli: false };
  }
  return { home: join(homedir(), '.gezel'), forceEmbeddedFromCli: false };
}

function resolveBundledUi(): string | undefined {
  // `dist/ui/index.html` is produced when the Electron app is packaged
  // (tsup's onSuccess copies the workspace UI bundle into place); in dev
  // we fall back to the workspace UI dist directory so `pnpm dev` works
  // without the copy step.
  //
  // The asar→asar.unpacked rewrite matters because the UI is shipped
  // asar-unpacked: Hono inside the spawned daemon reads `index.html` via
  // plain Node fs (no Electron asar patch), and `existsSync` returning
  // true for an asar path doesn't mean a child process can read the
  // underlying file.
  const candidates = [
    redirectAsarToUnpacked(join(__dirname, 'ui')),
    redirectAsarToUnpacked(resolve(__dirname, '..', 'ui')),
    resolve(__dirname, '..', '..', 'ui', 'dist'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c;
  }
  return undefined;
}

function iconPath(): string | undefined {
  // __dirname is packages/app/dist/ when bundled; assets live one up.
  const assets = resolve(__dirname, '..', 'assets');
  const file =
    process.platform === 'win32'
      ? 'icon.ico'
      : process.platform === 'darwin'
        ? 'icon.icns'
        : 'icon.png';
  const p = join(assets, file);
  return existsSync(p) ? p : undefined;
}

function splashPath(): string | undefined {
  const p = resolve(__dirname, '..', 'assets', 'splash.html');
  return existsSync(p) ? p : undefined;
}

/** Schemes we'll hand to the OS via shell.openExternal. Everything else
 *  (file://, smb://, custom app handlers, javascript:) is refused. */
function isSafeExternalUrl(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === 'https:' || p === 'http:' || p === 'mailto:' || p === 'tel:';
  } catch {
    return false;
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function responseHeaderValue(
  headers: Record<string, string[]> | undefined,
  wanted: string,
): string | null {
  if (!headers) return null;
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === wanted);
  return entry?.[1]?.[0]?.trim().toLowerCase() ?? null;
}

function rememberPreviewDocument(candidate: string, allowExternalServices: boolean): void {
  const key = normalizedDocumentUrl(candidate);
  if (!key) return;
  // Refresh insertion order when the same lease reloads under a new policy.
  previewDocumentExternalServices.delete(key);
  previewDocumentExternalServices.set(key, allowExternalServices);
  while (previewDocumentExternalServices.size > MAX_TRACKED_PREVIEW_DOCUMENTS) {
    const oldest = previewDocumentExternalServices.keys().next().value as string | undefined;
    if (!oldest) break;
    previewDocumentExternalServices.delete(oldest);
  }
}

/**
 * Renderer Content-Security-Policy. The UI is same-origin (served by the
 * loopback daemon) and loads no remote scripts, so a strict policy is
 * safe — and it is the real backstop against injected markup (e.g. a
 * model-authored inline SVG icon): with `script-src 'self'` an injected
 * <script> or on*= handler cannot execute even if it slips past the SVG
 * sanitizer. Styles keep 'unsafe-inline' (React inline styles); images
 * allow only self/data:/blob:. Remote passive resources are deliberately
 * excluded: images and media can still disclose user state through URLs even
 * when they cannot execute. connect-src is 'self' (the API is same-origin).
 *
 * `frame-src 'self'` lets the renderer embed the same-origin sandboxed
 * preview iframes (the output pane's live HTML preview, chat references).
 * Those documents are served by the loopback daemon under `/preview/*`
 * and carry their OWN deliberately-different, hardened CSP — see
 * {@link previewRoutes}; this renderer CSP must NOT be stamped over them
 * (the `onHeadersReceived` hook below skips `/preview/*` for that reason).
 */
const GEZEL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // Chromium does not yet implement the draft CSP `webrtc` directive. Do not
  // emit it: Chromium reports it as a renderer error and ignores it anyway.
].join('; ');

/**
 * Create the main window, paint the splash, and — when the daemon is already
 * up — load the UI.
 *
 * Safe to call before `connection` exists, and on first launch that is the
 * point: `connectOrStart` has to unpack the service bundle and provision the
 * bundled Node/pnpm runtimes before it resolves, which on a cold machine took
 * ~135s in the v1.26211.26 audit. Blocking window creation on that meant the
 * app showed *nothing at all* for over two minutes after the user launched it.
 * The window now comes up immediately with the splash, and
 * {@link navigateToApp} swaps in the real UI once the daemon answers.
 */
async function createWindow(): Promise<void> {
  const icon = iconPath();
  // E2E headless-ish mode: when `GEZEL_E2E=1`, the window is parked far off
  // every physical display and shown *inactive* (see `showInactive()` below),
  // so it never appears on screen, never becomes the key window, and can't
  // steal focus or be clicked mid-test. It's still a real GPU-composited
  // surface, so Playwright screenshots keep working — unlike `show: false`,
  // which stops the window compositing and blanks captures. Pairs with the
  // `accessory` activation policy set in `whenReady` (suppresses the dock).
  const e2e = process.env.GEZEL_E2E === '1' || packagedSmoke;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'Gezel',
    backgroundColor: '#667f62',
    // Auto-show activates the window on creation (→ focus theft). In E2E we
    // suppress it and call `showInactive()` after construction instead.
    show: !e2e,
    // Park the window off every display in E2E so it's never visible.
    ...(e2e ? { x: -32000, y: -32000 } : {}),
    ...(icon ? { icon } : {}),
    // Frameless window with platform-appropriate window controls. On macOS
    // `hiddenInset` keeps the traffic lights positioned natively; on
    // Windows/Linux we render the overlay controls ourselves — matched to
    // the brand sage so the header reads as one continuous strip.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform !== 'darwin'
      ? {
          titleBarOverlay: {
            color: '#667f62',
            symbolColor: '#f3ede0',
            height: 39,
          },
        }
      : {}),
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 12 } : undefined,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      // Keep the OS-level renderer sandbox on. The preload only uses
      // contextBridge + ipcRenderer, both of which work sandboxed, so
      // there's no reason to drop the containment layer.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // An off-screen / occluded window otherwise gets its requestAnimationFrame
      // and timers throttled by Chromium, which slows and flakes E2E. Prod keeps
      // the default (throttle in the background) to save power.
      ...(e2e ? { backgroundThrottling: false } : {}),
      // Startup hint only, and absent when the window is created ahead of the
      // daemon. preload.cjs prefers the synchronous `gezel:current-connection`
      // IPC bridge and falls back to this, so a window built before the
      // connection exists still resolves the right base URL once it loads the
      // UI — and picks up a rotated port on restart, which a baked-in argv
      // value could not.
      ...(connection?.state === 'ready'
        ? { additionalArguments: [`--gezel-url=${connection.baseUrl}`] }
        : {}),
    },
  });

  // Make the E2E window visible-but-inactive so it composites for screenshots
  // without ever becoming key or jumping to the foreground.
  if (e2e) mainWindow.showInactive();

  // Only ever hand a vetted scheme to the OS. `openExternal` will launch
  // handlers for file://, smb://, custom app schemes, javascript:, etc. —
  // a phishing/RCE-assist primitive if a model-authored link reaches here.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Pin the renderer to the daemon origin. A top-level navigation (an
  // injected link, window.location, or form submit) would otherwise load
  // an attacker origin INTO the window that holds the preload bridge and
  // the bearer token. Same-origin navigations pass; the splash file://
  // handoff passes; everything else is cancelled and, if it's a safe
  // external scheme, opened in the user's browser instead.
  const allowedSplashPath = splashPath();
  const allowedSplashUrl = allowedSplashPath ? pathToFileURL(allowedSplashPath).href : null;
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Resolved per navigation, not captured at construction. The window can
    // now outlive the connection it was born with — it is created before the
    // daemon exists, and an embedded restart can come back on a different
    // port. A captured origin would pin the guard to a stale (or null) value
    // and start refusing the daemon's own URL. Null denies every http(s)
    // navigation and permits only the splash file, so the pre-connection
    // window is locked down rather than open.
    const allowedOrigin = connection?.state === 'ready' ? safeOrigin(connection.baseUrl) : null;
    if (isAllowedTopLevelNavigation(url, allowedOrigin, allowedSplashUrl)) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
  });

  // The iframe sandbox blocks popups and top-level navigation, but it still
  // permits a preview to replace its own document. Keep subframes pinned to
  // capability-bearing `/preview/*` URLs even when External services is on;
  // that permission is for dependencies and APIs, not document navigation.
  const guardPreviewFrameNavigation = (details: {
    url: string;
    isMainFrame: boolean;
    frame: Electron.WebFrameMain | null;
    initiator?: Electron.WebFrameMain | null;
    preventDefault(): void;
  }) => {
    if (details.isMainFrame) return;
    const allowedOrigin = connection?.state === 'ready' ? safeOrigin(connection.baseUrl) : null;
    const originatesInPreview =
      previewExternalServicesForFrame(
        details.frame,
        allowedOrigin,
        previewDocumentExternalServices,
      ) !== null ||
      previewExternalServicesForFrame(
        details.initiator,
        allowedOrigin,
        previewDocumentExternalServices,
      ) !== null;
    if (!originatesInPreview || isAllowedPreviewNavigation(details.url, allowedOrigin)) return;
    details.preventDefault();
  };
  mainWindow.webContents.on('will-frame-navigate', (details) => {
    guardPreviewFrameNavigation(details);
  });
  mainWindow.webContents.on('will-redirect', (details) => {
    guardPreviewFrameNavigation(details);
  });

  // Dev-mode visibility: forward renderer console + crash signals to the
  // main-process stderr so a `pnpm app` terminal sees React render errors,
  // unhandled rejections, and renderer crashes without the user having to
  // open DevTools. Off in packaged mode — those builds ship without a
  // terminal anyway, and forwarding adds noise to crash reports.
  if (!app.isPackaged) {
    const wc = mainWindow.webContents;
    wc.on('console-message', (event) => {
      const level = event.level;
      const tag =
        level === 'error'
          ? 'ERROR'
          : level === 'warning'
            ? 'WARN'
            : level === 'info'
              ? 'INFO'
              : 'LOG';
      const location = event.sourceId ? ` (${event.sourceId}:${event.lineNumber})` : '';
      writeProcessOutput(process.stderr, `[renderer ${tag}] ${event.message}${location}\n`);
    });
    wc.on('render-process-gone', (_e, details) => {
      writeProcessOutput(
        process.stderr,
        `[renderer CRASH] reason=${details.reason} exitCode=${details.exitCode}\n`,
      );
    });
    wc.on('preload-error', (_e, preloadPath, err) => {
      writeProcessOutput(
        process.stderr,
        `[renderer PRELOAD] ${preloadPath}: ${err.stack ?? err.message}\n`,
      );
    });
    wc.on('did-fail-load', (_e, code, desc, url) => {
      // -3 = ERR_ABORTED, fires on the intentional splash→app handoff; skip it.
      if (code === -3) return;
      writeProcessOutput(process.stderr, `[renderer LOAD-FAIL] ${code} ${desc} url=${url}\n`);
    });
    wc.on('did-finish-load', () => {
      // Hook window-level error events so unhandled exceptions /
      // promise rejections that don't go through console.error still
      // surface to the terminal.
      void wc
        .executeJavaScript(
          `
          window.addEventListener('error', (e) => {
            try {
              console.error('[unhandled]', e.message, e.error?.stack ?? '');
            } catch {}
          });
          window.addEventListener('unhandledrejection', (e) => {
            try {
              console.error('[unhandled-rejection]', e.reason?.stack ?? e.reason ?? '(unknown)');
            } catch {}
          });
          `,
        )
        .catch(() => {});
    });
  }

  // Close-to-tray: when the tray is active, the window's X button hides
  // the window and keeps Gezel resident (so the tray stays a live locus
  // for notifications). macOS already keeps the app alive on
  // window-all-closed, so this only applies to Windows/Linux. With the
  // tray disabled — or under the E2E harness, which never creates one —
  // close falls through to the normal quit-on-close path. The `quitOnClose`
  // preference also opts out: the user wants the X to quit Gezel outright
  // and drop the tray icon, so we let the close proceed (window-all-closed
  // then quits the app, removing the tray when the process exits).
  mainWindow.on('close', (event) => {
    if (!isQuitting && tray?.active && !quitOnClose && process.platform !== 'darwin') {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Show the branded splash immediately so the user sees the Gezel logo
  // during the gap between window creation and the UI's first paint. Fails
  // silently if the asset is missing — the sage backgroundColor is an
  // acceptable fallback.
  const splash = splashPath();
  if (splash) {
    splashShowing = true;
    try {
      await mainWindow.loadFile(splash);
    } catch {
      splashShowing = false;
      /* swallow — fall through to the real load */
    }
    // Say something before the supervisor's first log line: on a cold install
    // the gap ahead of "extracting service bundle" is itself several seconds.
    if (!connection) setSplashStatus('Starting Gezel');
  }

  // Already connected — the `activate` and post-boot call sites. On the cold
  // path `connection` is still null here and whenReady calls navigateToApp
  // once the daemon answers.
  if (connection) await navigateToApp();
}

/**
 * Swap the splash for the daemon-served UI. Separate from {@link createWindow}
 * so the window can be painted before the service exists.
 */
async function navigateToApp(): Promise<void> {
  if (connection?.state !== 'ready' || !mainWindow || mainWindow.isDestroyed()) return;
  await loadAppUrl(mainWindow, `${connection.baseUrl}/`);
  splashShowing = false;
  flushOpenedModelBundles();
  flushMacUninstallDialogRequest();
}

/**
 * Write a stage line onto the splash while the daemon starts.
 *
 * Injected rather than shipped as an inline `<script>` in splash.html: the
 * renderer CSP forbids inline script, and keeping the asset script-free means
 * the splash cannot execute anything of its own. No-ops once the real UI has
 * loaded, so a late supervisor log can't scribble on the app.
 */
function setSplashStatus(message: string): void {
  if (!splashShowing || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents
    .executeJavaScript(
      `(() => { const el = document.getElementById('gezel-splash-status'); if (el) el.textContent = ${JSON.stringify(message)}; })()`,
    )
    .catch(() => {
      /* window closed or navigated mid-write */
    });
}

/**
 * Load the daemon URL into the window with a bounded retry, then a visible
 * error page on exhaustion. The supervisor health-checks the service before
 * `connectOrStart` returns, but there's still a small window where the daemon
 * can stop listening between that check and this load — an embedded boot that
 * dies, or a previously-running daemon we adopted that exits as we connect. A
 * bare `loadURL` turns that race into a permanently green window plus the
 * `UnhandledPromiseRejectionWarning` the user sees in the terminal; instead we
 * retry briefly (covers the transient case), and if it's truly down we paint a
 * real error page with a Reconnect button rather than leaving a green void.
 */
async function loadAppUrl(win: Electron.BrowserWindow, url: string): Promise<void> {
  const ATTEMPTS = 12;
  const DELAY_MS = 350;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    if (win.isDestroyed()) return;
    try {
      await win.loadURL(url);
      return;
    } catch (err) {
      // ERR_ABORTED (-3) means a newer load superseded this one — the
      // supervisor's restart-driven reload, or the user navigating. That's
      // not a failure to recover from; let the superseding load win.
      if ((err as { code?: string }).code === 'ERR_ABORTED') return;
      if (attempt < ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
        continue;
      }
      console.error(
        `[app] failed to load ${url} after ${ATTEMPTS} attempts: ${(err as Error).message}`,
      );
      if (!win.isDestroyed()) await showConnectionError(win, url, err as Error);
    }
  }
}

/**
 * The service never came up at all, so there is nothing to reconnect to.
 *
 * Distinct from {@link showConnectionError}: that one recovers a window whose
 * daemon went away mid-session, and its Reconnect button bounces a supervisor
 * that exists. Here `connectOrStart` rejected, there is no connection to
 * restart, and offering a button that cannot work would be worse than
 * offering none. Relaunching is the only real remedy, so the copy says that.
 */
interface StartupErrorOptions {
  kind?: 'service-startup' | 'main-process';
  source?: FatalProcessErrorSource;
}

async function showStartupError(
  win: Electron.BrowserWindow | null,
  err: Error,
  options: StartupErrorOptions = {},
): Promise<void> {
  if (options.kind === 'main-process') {
    const messageBoxOptions: Electron.MessageBoxOptions = {
      type: 'error',
      title: 'Gezel hit a problem',
      message: 'Gezel hit an unexpected problem and needs to close.',
      detail:
        'Nothing has been lost — your gezellen, projects, and chats are still on disk. ' +
        'No report is sent automatically. “Report on GitHub…” only opens an editable issue in your browser.',
      buttons: ['Close Gezel', 'Report on GitHub…'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const result =
      win && !win.isDestroyed()
        ? await dialog.showMessageBox(win, messageBoxOptions)
        : await dialog.showMessageBox(messageBoxOptions);
    if (result.response === 1) {
      const issueUrl = mainProcessIssueUrl({
        error: err,
        source: options.source ?? 'uncaughtException',
        version: app.getVersion(),
        electronVersion: process.versions.electron ?? 'unknown',
        nodeVersion: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      });
      await shell.openExternal(issueUrl);
    }
    return;
  }

  if (!win || win.isDestroyed()) return;
  const escapeHtml = (s: string) => s.replace(/[<>&]/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Gezel — could not start</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; }
  body { background: #667f62; color: #f3ede0; display: flex; align-items: center;
    justify-content: center; font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-user-select: none; -webkit-app-region: drag; }
  main { max-width: 460px; padding: 32px; text-align: center; }
  h1 { font-size: 19px; font-weight: 650; margin: 0 0 10px; }
  p { margin: 0 0 14px; opacity: 0.92; }
  .detail { font-size: 12px; opacity: 0.7; word-break: break-word; }
</style></head><body><main>
  <h1>Gezel couldn't start its background service</h1>
  <p>Nothing has been lost — your gezellen, projects, and chats are still on disk.</p>
  <p>Open Gezel again. If it keeps happening, restart your computer — a
     background service from a previous version may still be holding on.</p>
  <div class="detail">${escapeHtml(err.message)}</div>
</main></body></html>`;
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  } catch {
    /* nothing more we can do — the sage background remains */
  }
}

/**
 * Final main-process boundary. Node explicitly warns against resuming normal
 * work after an uncaught exception, so the dialog is followed by a hard exit.
 * The daemon's parent pipe closes with us and its ordinary EOF shutdown path
 * performs service cleanup.
 */
async function handleFatalMainProcessError(
  err: Error,
  source: FatalProcessErrorSource,
): Promise<void> {
  if (fatalMainProcessErrorInFlight) {
    app.exit(1);
    return;
  }
  fatalMainProcessErrorInFlight = true;
  isQuitting = true;

  // Local diagnostics may retain the stack; the user-facing dialog and issue
  // URL do not. This write is itself safe when a launcher closed the pipe.
  try {
    writeProcessOutput(process.stderr, `[app] ${source}: ${err.stack ?? err.message}\n`);
  } catch {
    /* the final error surface must not depend on a working terminal */
  }

  if (packagedSmoke) {
    app.exit(1);
    return;
  }

  try {
    if (!app.isReady()) await app.whenReady();
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    await showStartupError(parent, err, { kind: 'main-process', source });
  } catch {
    /* Dialog or browser launch failed; exiting is still the safe recovery. */
  } finally {
    app.exit(1);
  }
}

/**
 * Last-resort UI when the daemon URL won't load. Painted from a `data:` URL so
 * it works even with the service fully down (no loopback origin to serve it).
 * The preload still runs here, so the Reconnect button can call
 * `restartService` — which bounces the supervisor and, via the `onRestart`
 * listener, re-runs {@link loadAppUrl} against the (possibly rotated) baseUrl.
 */
async function showConnectionError(
  win: Electron.BrowserWindow,
  url: string,
  err: Error,
): Promise<void> {
  const detail = `${err.message} — ${url}`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Gezel — connection problem</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; }
  body { background: #667f62; color: #f3ede0; display: flex; align-items: center;
    justify-content: center; font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    -webkit-user-select: none; }
  main { max-width: 460px; padding: 32px; text-align: center; }
  h1 { font-size: 19px; font-weight: 650; margin: 0 0 10px; }
  p { margin: 0 0 14px; opacity: 0.92; }
  .detail { font-size: 12px; opacity: 0.7; word-break: break-all; margin-bottom: 22px; }
  button { font: inherit; font-weight: 600; color: #2f3a2c; background: #f3ede0;
    border: 0; border-radius: 8px; padding: 9px 20px; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
</style></head><body><main>
  <h1>Couldn't reach the Gezel service</h1>
  <p>The local service isn't responding. This usually clears up on a reconnect.
     If it persists, fully quit Gezel and relaunch a single instance.</p>
  <div class="detail">${detail.replace(/[<>&]/g, (c) => `&#${c.charCodeAt(0)};`)}</div>
  <button id="reconnect" type="button">Reconnect</button>
</main>
<script>
  var btn = document.getElementById('reconnect');
  btn.addEventListener('click', function () {
    btn.disabled = true;
    btn.textContent = 'Reconnecting…';
    var bridge = window.__GEZEL__;
    if (bridge && typeof bridge.restartService === 'function') {
      // The main-process onRestart listener reloads the window once a verified
      // service is back. Keep this page persistent on failure: navigating to
      // A direct URL load would revisit a dead generation without credentials.
      Promise.resolve(bridge.restartService('reconnect from error page')).then(function (result) {
        if (result && result.ok === true) return;
        btn.disabled = false;
        btn.textContent = 'Try again';
        var detail = document.querySelector('.detail');
        if (detail && result && result.error) detail.textContent = result.error;
      }).catch(function (error) {
        btn.disabled = false;
        btn.textContent = 'Try again';
        var detail = document.querySelector('.detail');
        if (detail) detail.textContent = error && error.message ? error.message : String(error);
      });
    } else {
      btn.disabled = false;
      btn.textContent = 'Reconnect unavailable';
    }
  });
</script></body></html>`;
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  } catch {
    /* nothing more we can do — the sage background remains */
  }
}

// Preload hits this synchronously on every page load to get the current
// token/baseUrl/fallbackReason. Synchronous so the renderer can build its
// API client before any other code runs — keeps the app.ts "api" singleton
// simple and avoids a first-render flicker.
ipcMain.on('gezel:current-connection', (event) => {
  event.returnValue = rendererConnectionSnapshot(connection);
});

// Update IPC. `gezel:update-state` is pushed on every transition; this pull
// covers a renderer that mounted (or reloaded after a supervisor restart)
// while an update was already staged.
ipcMain.handle('gezel:update:state', () => updateState);
ipcMain.handle('gezel:update:install', async () => {
  if (process.platform !== 'darwin') {
    // Windows and Linux keep electron-updater's own installer handoff, which
    // already elevates via elevate.exe / pkexec.
    if (!autoUpdaterRef || updateState?.kind !== 'ready') {
      return { ok: false as const, error: 'No downloaded update is ready to install.' };
    }
    try {
      // quitAndInstall starts closing windows before Electron's ordinary quit
      // sequence on some updater/platform combinations. Let close-to-tray know
      // this is a real quit so it cannot hide the last window mid-handoff.
      isQuitting = true;
      // Match the automatic NSIS-on-quit path (`/S`) while opting back into a
      // restart because this action was explicitly chosen by the user.
      autoUpdaterRef.quitAndInstall(true, true);
      return { ok: true as const };
    } catch (err) {
      isQuitting = false;
      const message = err instanceof Error ? err.message : String(err);
      setUpdateState({
        kind: 'error',
        stage: 'install',
        version: updateState.version,
        message,
      });
      return { ok: false as const, error: message };
    }
  }
  const result = await installStagedMacUpdate();
  if (result.ok) return { ok: true as const };
  setUpdateState({
    kind: 'error',
    stage: 'install',
    version: updateState?.kind === 'ready' ? updateState.version : appUpdateRelease?.version,
    message: result.error ?? 'The verified installer could not be opened.',
  });
  return { ok: false as const, error: result.error };
});

// Autostart IPC — the UI's Service section toggles this on/off. Platform-
// level unit writes happen in `./autostart/<platform>.ts`; we just resolve
// the bundled runtime and the gezeld entry path from here.
ipcMain.handle('gezel:autostart:status', async () => {
  try {
    return { ok: true as const, installed: await autostart.isInstalled() };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message };
  }
});
ipcMain.handle('gezel:autostart:install', async () => {
  try {
    const gezelHome = process.env.GEZEL_HOME || join(homedir(), '.gezel');
    const nodePath = await resolveAutostartNodePath({
      packaged: app.isPackaged,
      home: gezelHome,
      bundledNodePath: process.env.GEZEL_NODE_PATH,
    });
    const pnpmPath = await resolveAutostartPnpmPath({
      packaged: app.isPackaged,
      home: gezelHome,
      bundledPnpmPath: process.env.GEZEL_PNPM_PATH,
    });
    const gezeldPath = resolveInstalledGezeld();
    await autostart.install({
      nodePath,
      pnpmPath,
      gezeldPath,
      gezelHome,
    });
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message };
  }
});
ipcMain.handle('gezel:autostart:uninstall', async () => {
  try {
    await autostart.uninstall();
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message };
  }
});

// macOS PKG installs own a machine LaunchDaemon, service account, and shared
// storage, so moving the .app to Trash is not a complete uninstall. The
// renderer may choose only documented data scopes; this boundary resolves the
// signed bundled script and performs the administrator-authenticated handoff.
ipcMain.handle('gezel:uninstall:start', async (_event, payload: unknown) => {
  if (macUninstallInFlight) {
    return { ok: false as const, error: 'Gezel is already preparing to uninstall.' };
  }
  const selection = parseMacUninstallSelection(payload);
  if (!selection) return { ok: false as const, error: 'Invalid uninstall choices.' };

  macUninstallInFlight = true;
  const result = await scheduleMacUninstall({
    resourcesPath: process.resourcesPath,
    appPid: process.pid,
    userUid: process.getuid?.() ?? 0,
    selection,
    isPackaged: app.isPackaged,
  });
  if (!result.ok) {
    macUninstallInFlight = false;
    return result;
  }

  // The privileged script staged a detached, root-owned copy and is waiting
  // for this PID to exit. A normal app.quit() lets QuitCoordinator stop the
  // per-user daemon before that copy removes any selected user data.
  setTimeout(() => {
    isQuitting = true;
    app.quit();
  }, 200);
  return result;
});

// Folders externalization: after a successful move the renderer offers
// "Restart now" so the new path config takes effect. Forwards to the
// supervisor, which routes embedded vs. spawned restart correctly.
// `connection.onRestart` already handles the renderer reload after the
// service comes back up.
ipcMain.handle('gezel:restart-service', async (_event, reason?: string) => {
  if (!connection) return { ok: false as const, error: 'no active connection' };
  try {
    await connection.restart(reason ?? 'user-requested');
    return { ok: true as const };
  } catch (err) {
    return { ok: false as const, error: (err as Error).message };
  }
});

function resolveInstalledGezeld(): string {
  const home = process.env.GEZEL_HOME || join(homedir(), '.gezel');
  const p = join(home, 'service', 'dist', 'bin', 'gezeld.js');
  if (!existsSync(p)) {
    throw new Error(
      `Gezel service has not been extracted yet (expected ${p}). Restart Gezel once in packaged mode so the bundle lands, then try again.`,
    );
  }
  return p;
}

// Native folder picker, exposed to the renderer via preload.cjs.
ipcMain.handle(
  'dialog:selectDirectory',
  async (event, opts?: { title?: string; defaultPath?: string }): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const result = await dialog.showOpenDialog(win as Electron.BrowserWindow, {
      title: opts?.title ?? 'Choose a folder',
      defaultPath: opts?.defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  },
);

type DesktopReferenceFileRequest = ReferenceFileLocationRequest & { projectId: string };

function parseDesktopReferenceFileRequest(value: unknown): DesktopReferenceFileRequest | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.projectId !== 'string' ||
    candidate.projectId.length === 0 ||
    candidate.projectId.length > 255
  ) {
    return null;
  }
  const parsed = ReferenceFileLocationRequestSchema.safeParse({
    kind: candidate.kind,
    path: candidate.path,
  });
  return parsed.success ? { projectId: candidate.projectId, ...parsed.data } : null;
}

async function fetchReferenceBlob(request: DesktopReferenceFileRequest): Promise<Blob> {
  if (!apiClient) throw new Error('service is unavailable');
  if (request.kind === 'artifact') {
    return apiClient.fetchProjectArtifactBlob(request.projectId, request.path);
  }
  if (request.kind === 'workspace') {
    return apiClient.fetchProjectWorkspaceBlob(request.projectId, request.path);
  }
  return apiClient.fetchDocumentBlob(request.path);
}

ipcMain.handle(
  'gezel:save-reference-copy',
  async (
    event,
    value: unknown,
  ): Promise<{ ok: true; path?: string } | { ok: false; error: string }> => {
    const request = parseDesktopReferenceFileRequest(value);
    if (!request) return { ok: false, error: 'invalid reference file request' };
    if (!apiClient) return { ok: false, error: 'service is unavailable' };
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const filename = basename(request.path.replaceAll('\\', '/')) || 'reference';
    const picked = await dialog.showSaveDialog(win as Electron.BrowserWindow, {
      title: 'Save copy as',
      defaultPath: filename,
    });
    if (picked.canceled || !picked.filePath) return { ok: true };
    const partial = `${picked.filePath}.partial-${randomUUID()}`;
    try {
      const blob = await fetchReferenceBlob(request);
      await pipeline(
        Readable.fromWeb(blob.stream() as import('node:stream/web').ReadableStream<Uint8Array>),
        createWriteStream(partial, { flags: 'wx' }),
      );
      await rm(picked.filePath, { force: true });
      await rename(partial, picked.filePath);
      return { ok: true, path: picked.filePath };
    } catch (err) {
      await rm(partial, { force: true }).catch(() => {});
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);

/**
 * Where should a content backup be written, or read from?
 *
 * These only resolve a path. The daemon streams the archive itself, because
 * pushing tens of gigabytes through the renderer to save a file is the
 * fragile way to do it — and the daemon already has the content open.
 */
ipcMain.handle(
  'gezel:backup:choose-save-path',
  async (event, defaultName: unknown): Promise<{ path?: string }> => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const suggested =
      typeof defaultName === 'string' && defaultName.length > 0 ? defaultName : 'gezel-backup.zip';
    const picked = await dialog.showSaveDialog(win as Electron.BrowserWindow, {
      title: 'Save Gezel backup',
      defaultPath: suggested,
      filters: [{ name: 'Gezel backup', extensions: ['zip'] }],
    });
    if (picked.canceled || !picked.filePath) return {};
    return { path: picked.filePath };
  },
);

ipcMain.handle('gezel:backup:choose-open-path', async (event): Promise<{ path?: string }> => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const picked = await dialog.showOpenDialog(win as Electron.BrowserWindow, {
    title: 'Open Gezel backup',
    properties: ['openFile'],
    filters: [{ name: 'Gezel backup', extensions: ['zip'] }],
  });
  if (picked.canceled || picked.filePaths.length === 0) return {};
  return { path: picked.filePaths[0] };
});

// Knowledge catalog install: the renderer only asks where the .gezk lives;
// the daemon reads, verifies, and extracts it — the archive never travels
// through the renderer (the backup-file pattern).
ipcMain.handle('gezel:knowledge:choose-archive', async (event): Promise<{ path?: string }> => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const picked = await dialog.showOpenDialog(win as Electron.BrowserWindow, {
    title: 'Install knowledge catalog',
    properties: ['openFile'],
    filters: [{ name: 'Knowledge catalog', extensions: ['gezk'] }],
  });
  if (picked.canceled || picked.filePaths.length === 0) return {};
  return { path: picked.filePaths[0] };
});

ipcMain.handle(
  'gezel:show-reference-in-folder',
  async (_event, value: unknown): Promise<{ ok: true } | { ok: false; error: string }> => {
    const request = parseDesktopReferenceFileRequest(value);
    if (!request) return { ok: false, error: 'invalid reference file request' };
    if (!apiClient) return { ok: false, error: 'service is unavailable' };
    if (connection?.mode === 'remote') {
      return { ok: false, error: 'Containing folders are unavailable for remote projects.' };
    }
    try {
      const location = await apiClient.resolveReferenceFileLocation(request.projectId, request);
      shell.showItemInFolder(location.path);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);

// Portable model bundles: Electron streams the service response into a partial
// file instead of materializing the multi-GB model in the renderer. Opaque
// open-file ids keep renderer code away from arbitrary local paths.
ipcMain.handle(
  'gezel:export-model-bundle',
  async (
    event,
    args?: {
      engine?: 'llama-cpp' | 'mlx' | 'ds4';
      id?: string;
      exportId?: string;
    },
  ): Promise<
    | { ok: true; canceled: true }
    | { ok: true; canceled?: false; path: string; bytesWritten: number; verified: true }
    | { ok: false; error: string }
  > => {
    const engines = new Set(['llama-cpp', 'mlx', 'ds4']);
    if (
      !args?.engine ||
      !engines.has(args.engine) ||
      !args.id ||
      args.id.length > 64 ||
      !args.exportId ||
      !/^[a-zA-Z0-9-]{1,80}$/.test(args.exportId)
    ) {
      return { ok: false, error: 'invalid model export request' };
    }
    const client = apiClient;
    if (!client) return { ok: false, error: 'service is unavailable' };
    if (activeModelBundleExports.has(args.exportId)) {
      return { ok: false, error: 'model export request is already active' };
    }
    const controller = new AbortController();
    const activeExport = { controller, webContentsId: event.sender.id };
    activeModelBundleExports.set(args.exportId, activeExport);
    const abortOnRendererClose = () => controller.abort();
    event.sender.once('destroyed', abortOnRendererClose);
    let partial: string | undefined;
    try {
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const picked = await dialog.showSaveDialog(win as Electron.BrowserWindow, {
        title: 'Export model',
        defaultPath: portableGezmodelFilename(args.id),
        filters: [{ name: 'Gezel model bundle', extensions: ['gezmodel'] }],
      });
      if (picked.canceled || !picked.filePath) return { ok: true, canceled: true };
      controller.signal.throwIfAborted();
      partial = `${picked.filePath}.partial-${randomUUID()}`;
      let lastProgressAt = 0;
      let lastProgressPhase = '';
      const publishProgress = (
        progress:
          | { phase: 'preparing'; filename: string }
          | {
              phase: 'writing' | 'verifying';
              filename: string;
              bytesCompleted: number;
              bytesTotal?: number;
            },
        force = false,
      ) => {
        const now = Date.now();
        if (!force && progress.phase === lastProgressPhase && now - lastProgressAt < 200) return;
        lastProgressAt = now;
        lastProgressPhase = progress.phase;
        if (!event.sender.isDestroyed()) {
          event.sender.send('gezel:model-bundle-export-progress', {
            exportId: args.exportId,
            ...progress,
          });
        }
      };
      const filename = basename(picked.filePath);
      publishProgress({ phase: 'preparing', filename }, true);
      const response = await client.exportModelBundle(args.engine, args.id, controller.signal);
      const modelBytes = modelBytesFromResponse(response);
      const bytesWritten = await writeModelBundleResponse(
        response,
        partial,
        (progress) => {
          publishProgress({ phase: 'writing', filename, ...progress });
        },
        controller.signal,
      );
      publishProgress(
        {
          phase: 'writing',
          filename,
          bytesCompleted: bytesWritten,
          ...(modelBytes === undefined ? {} : { bytesTotal: modelBytes }),
        },
        true,
      );

      publishProgress(
        {
          phase: 'verifying',
          filename,
          bytesCompleted: 0,
          ...(modelBytes === undefined ? {} : { bytesTotal: modelBytes }),
        },
        true,
      );
      let latestVerified = { bytesCompleted: 0, bytesTotal: modelBytes };
      await verifyModelBundleArchive(
        partial,
        (progress) => {
          latestVerified = progress;
          publishProgress({ phase: 'verifying', filename, ...progress });
        },
        controller.signal,
      );
      publishProgress({ phase: 'verifying', filename, ...latestVerified }, true);

      // Keep an existing export recoverable until the verified replacement is
      // in place. Renaming the backup is cheap even for an 80 GB bundle.
      controller.signal.throwIfAborted();
      const backup = `${picked.filePath}.backup-${randomUUID()}`;
      let backedUp = false;
      try {
        backedUp = (await stat(picked.filePath)).isFile();
      } catch {
        backedUp = false;
      }
      if (backedUp) await rename(picked.filePath, backup);
      try {
        controller.signal.throwIfAborted();
        await rename(partial, picked.filePath);
      } catch (error) {
        if (backedUp) await rename(backup, picked.filePath).catch(() => {});
        throw error;
      }
      if (backedUp) await rm(backup, { force: true }).catch(() => {});
      return { ok: true, path: picked.filePath, bytesWritten, verified: true };
    } catch (err) {
      if (partial) await rm(partial, { force: true }).catch(() => {});
      if (controller.signal.aborted) return { ok: true, canceled: true };
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      event.sender.removeListener('destroyed', abortOnRendererClose);
      if (activeModelBundleExports.get(args.exportId) === activeExport) {
        activeModelBundleExports.delete(args.exportId);
      }
    }
  },
);

ipcMain.handle(
  'gezel:cancel-model-bundle-export',
  (event, exportId?: string): { ok: true } | { ok: false; error: string } => {
    if (!exportId || !/^[a-zA-Z0-9-]{1,80}$/.test(exportId)) {
      return { ok: false, error: 'invalid model export cancellation request' };
    }
    const active = activeModelBundleExports.get(exportId);
    if (active?.webContentsId === event.sender.id) active.controller.abort();
    return { ok: true };
  },
);

ipcMain.handle(
  'gezel:scan-opened-model-bundle',
  async (
    event,
    args: { requestId?: string; scanId?: string },
  ): Promise<
    | { ok: true; review: Awaited<ReturnType<GezelClient['scanModelBundle']>> }
    | { ok: true; canceled: true }
    | { ok: false; error: string }
  > => {
    const client = apiClient;
    if (!client) return { ok: false, error: 'service is unavailable' };
    if (!args?.scanId || !/^[0-9a-f-]{36}$/i.test(args.scanId)) {
      return { ok: false, error: 'model bundle scan request is invalid' };
    }
    const opened = args.requestId ? openedModelBundles.get(args.requestId) : undefined;
    if (!opened) return { ok: false, error: 'model bundle open request is invalid or expired' };
    if (activeModelBundleImports.has(args.scanId)) {
      return { ok: false, error: 'model bundle scan request is already active' };
    }
    openedModelBundles.delete(args.requestId!);
    const controller = new AbortController();
    const activeImport = { controller, webContentsId: event.sender.id };
    activeModelBundleImports.set(args.scanId, activeImport);
    const abortOnRendererClose = () => controller.abort();
    event.sender.once('destroyed', abortOnRendererClose);
    try {
      const info = await stat(opened.path);
      const stream = Readable.toWeb(createReadStream(opened.path)) as ReadableStream<Uint8Array>;
      const publishProgress = (progress: GezmodelImportProgress) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('gezel:model-bundle-import-progress', {
            scanId: args.scanId,
            filename: opened.filename,
            ...progress,
          });
        }
      };
      const review = await client.scanModelBundle(stream, {
        scanId: args.scanId,
        totalBytes: info.size,
        signal: controller.signal,
        onProgress: publishProgress,
      });
      return { ok: true, review };
    } catch (err) {
      if (controller.signal.aborted) return { ok: true, canceled: true };
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      event.sender.removeListener('destroyed', abortOnRendererClose);
      if (activeModelBundleImports.get(args.scanId) === activeImport) {
        activeModelBundleImports.delete(args.scanId);
      }
    }
  },
);

ipcMain.handle(
  'gezel:cancel-model-bundle-import',
  async (event, scanId?: string): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (!scanId || !/^[0-9a-f-]{36}$/i.test(scanId)) {
      return { ok: false, error: 'invalid model bundle import cancellation request' };
    }
    const active = activeModelBundleImports.get(scanId);
    if (!active || active.webContentsId !== event.sender.id) return { ok: true };
    try {
      await apiClient?.cancelModelBundleImport(scanId);
      active.controller.abort();
      return { ok: true };
    } catch (err) {
      active.controller.abort();
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);

// ── Mailbox OAuth: loopback redirect capture ─────────────────────────────
// The desktop half of the cloud-mail OAuth flow. `mail:oauth-listen` stands up
// an ephemeral 127.0.0.1 listener and returns its redirect URI; the renderer
// hands that to the service's /mail/oauth/start to build the consent URL, then
// calls `mail:oauth-await`, which opens the browser and resolves the captured
// `code`/`state`. The listener is torn down as soon as the redirect lands (or
// after a timeout) so no port lingers.
const oauthSessions = new Map<
  string,
  {
    server: import('node:http').Server;
    done: Promise<{ code: string; state: string }>;
    settle: (v: { code?: string; state?: string; error?: string }) => void;
  }
>();

ipcMain.handle(
  'mail:oauth-listen',
  async (
    _event,
    opts?: { port?: number } | null,
  ): Promise<{ requestId: string; redirectUri: string }> => {
    const http = require('node:http') as typeof import('node:http');
    const { randomUUID } = require('node:crypto') as typeof import('node:crypto');
    // Providers that match redirect URIs exactly (X, Meta) need the same port
    // every time; the connector manifest declares it and the renderer passes
    // it through. Absent, the OS picks an ephemeral port (RFC 8252 loopback —
    // Google/Microsoft accept any).
    const requestedPort = opts?.port;
    if (
      requestedPort !== undefined &&
      (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535)
    ) {
      throw new Error('OAuth redirect port must be an integer between 1024 and 65535.');
    }
    const requestId = randomUUID();
    let settle!: (v: { code?: string; state?: string; error?: string }) => void;
    const done = new Promise<{ code: string; state: string }>((resolve, reject) => {
      settle = (v) => {
        if (v.code) resolve({ code: v.code, state: v.state ?? '' });
        else reject(new Error(v.error ?? 'authorization failed'));
      };
    });
    const server = http.createServer((req, res) => {
      let u: URL;
      try {
        u = new URL(req.url ?? '/', 'http://127.0.0.1');
      } catch {
        res.statusCode = 400;
        res.end('bad request');
        return;
      }
      if (u.pathname !== '/callback') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(
        '<!doctype html><meta charset="utf-8"><title>Gezel</title><body style="font-family:system-ui;padding:3rem;text-align:center"><h2>Mailbox connected</h2><p>You can close this tab and return to Gezel.</p></body>',
      );
      const error = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state') ?? '';
      if (error) settle({ error });
      else if (code) settle({ code, state });
      else settle({ error: 'no authorization code in redirect' });
    });
    if (requestedPort !== undefined) {
      // A previous abandoned flow (start failed, user closed the consent tab)
      // may still hold this exact port until its reap timer fires. It's our
      // own listener — reclaim it rather than failing the retry.
      for (const [staleId, stale] of oauthSessions) {
        const staleAddr = stale.server.address();
        if (typeof staleAddr === 'object' && staleAddr?.port === requestedPort) {
          oauthSessions.delete(staleId);
          try {
            stale.server.closeAllConnections();
          } catch {
            /* nothing to drop */
          }
          // Await the close so the re-listen below can't race the handle
          // release; closeAllConnections above keeps it from hanging on a
          // lingering keep-alive from the consent tab.
          await new Promise<void>((resolve) => {
            try {
              stale.server.close(() => resolve());
            } catch {
              resolve();
            }
          });
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      server.once('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        reject(
          code === 'EADDRINUSE' && requestedPort !== undefined
            ? new Error(
                `port ${requestedPort} is in use by another app — close it and retry, or wait a moment`,
              )
            : err,
        );
      });
      server.listen(requestedPort ?? 0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    oauthSessions.set(requestId, { server, done, settle });
    // Safety net: reclaim the port if the renderer abandons the flow.
    const reap = setTimeout(() => {
      if (oauthSessions.delete(requestId)) {
        try {
          server.close();
        } catch {
          /* already closed */
        }
      }
    }, 10 * 60_000);
    reap.unref?.();
    return { requestId, redirectUri: `http://127.0.0.1:${port}/callback` };
  },
);

ipcMain.handle(
  'mail:oauth-await',
  async (
    _event,
    args: { requestId: string; authUrl: string },
  ): Promise<{ code: string; state: string } | { error: string }> => {
    const session = oauthSessions.get(args.requestId);
    if (!session) return { error: 'oauth session not found (it may have expired)' };
    try {
      if (!isSafeExternalUrl(args.authUrl)) {
        return { error: 'refusing to open an unsafe authorization URL' };
      }
      await shell.openExternal(args.authUrl);
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timed out waiting for authorization')), 5 * 60_000),
      );
      return await Promise.race([session.done, timeout]);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      oauthSessions.delete(args.requestId);
      try {
        session.server.close();
      } catch {
        /* already closed */
      }
    }
  },
);

/**
 * Open the service's `~/.gezel/logs/` folder in the OS file manager.
 * Used by Settings → General's "Open logs folder" button when debug
 * mode is on. Resolves the path from the already-decided GEZEL_HOME
 * so the UI doesn't need to know it.
 */
ipcMain.handle('gezel:open-logs-folder', async (): Promise<string> => {
  const home = process.env.GEZEL_HOME || join(homedir(), '.gezel');
  const logsDir = join(home, 'logs');
  try {
    return await shell.openPath(logsDir);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
});

/**
 * Open an arbitrary folder in the OS file manager. Used by Settings →
 * Folders' "Open" buttons so the user can reveal each data folder.
 * Returns an empty string on success, an error message otherwise
 * (matches Electron's `shell.openPath` semantics).
 */
ipcMain.handle('gezel:open-path', async (_event, target: string): Promise<string> => {
  if (typeof target !== 'string' || target.length === 0 || target.length > 4096) {
    return 'invalid path';
  }
  try {
    if (!apiClient) return 'service is unavailable';
    const folderStatus = await apiClient.getFolders();
    const approved = await Promise.all(
      Object.values(folderStatus.current).map((path) => realpath(path)),
    );
    const targetPath = await realpath(target);
    if (!isExactApprovedPath(targetPath, approved)) return 'path is not an approved Gezel folder';
    if (!(await stat(targetPath)).isDirectory()) return 'path is not a directory';
    shell.showItemInFolder(targetPath);
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
});

// ── Ambient display IPC ─────────────────────────────────────────────
// Paths are computed main-side from GEZEL_HOME — the renderer never
// supplies one (same posture as gezel:open-logs-folder).

ipcMain.handle('gezel:ambient:status', async () => {
  try {
    const home = gezelHomeDir();
    const [capability, state, newest] = await Promise.all([
      ambientDisplay.capability(),
      readDisplayState(home),
      newestDatedImage(home),
    ]);
    let enabled = ambientApplyEnabled;
    try {
      const cfg = await apiClient?.getConfig();
      if (cfg) enabled = cfg.ambientDisplay?.applyWallpaper === true;
    } catch {
      /* fall back to the mirrored flag */
    }
    return {
      ok: true,
      capability,
      enabled,
      folder: ambientDir(home),
      lastApplied: state.lastApplied ?? null,
      latestImageAt: newest ? new Date(newest.mtimeMs).toISOString() : null,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('gezel:ambient:enable', async () => {
  if (!apiClient) return { ok: false, error: 'service is unavailable' };
  try {
    // OS action first: the macOS Automation (TCC) prompt then fires in
    // the context of the user's click, not from a background timer.
    const result = await ambientEnable(ambientRuntimeDeps());
    await apiClient.updateConfig({ ambientDisplay: { applyWallpaper: true } });
    setAmbientApplyEnabled(true);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('gezel:ambient:disable', async () => {
  if (!apiClient) return { ok: false, error: 'service is unavailable' };
  try {
    const result = await ambientDisable(ambientRuntimeDeps());
    await apiClient.updateConfig({ ambientDisplay: { applyWallpaper: false } });
    setAmbientApplyEnabled(false);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('gezel:ambient:apply-now', async () => {
  try {
    const result = await applyLatest(ambientRuntimeDeps(), { force: true });
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle('gezel:ambient:open-folder', async (): Promise<string> => {
  const dir = ambientDir(gezelHomeDir());
  try {
    await mkdir(dir, { recursive: true });
    return await shell.openPath(dir);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
});

/**
 * Theme sync: hand the user's Light/Dark/System choice to Chromium itself.
 *
 * The app's own surfaces are themed by our CSS variables, but a project-type
 * page renders inside the preview iframe — a separate, null-origin document
 * that our stylesheet can never reach. Neither a `color-scheme` on the frame
 * element nor the page-API theme message helps: the first does not propagate
 * across the sandbox boundary, and the second only reaches pages that opted
 * into `window.gezel`. Setting `nativeTheme.themeSource` moves the browser's
 * own preference, so `prefers-color-scheme` inside every frame answers with
 * the user's gezel choice — which is what the shipped pages already key on.
 * It also brings native menus and dialogs along.
 *
 * `system` is Electron's default and hands control back to the OS.
 */
ipcMain.on('gezel:set-native-theme', (_event, pref?: string) => {
  if (pref === 'system' || pref === 'light' || pref === 'dark') {
    nativeTheme.themeSource = pref;
  }
});

// Tray sync: the renderer pushes the latest config after any change (it
// already dispatches a `gezel:config-updated` window event; the preload
// forwards it here). We mirror the engagement mode onto the tray's radio
// and create/destroy the tray when `showSystemTray` flips. This handler
// only mutates tray state — it never echoes back to the renderer, so
// there's no IPC loop with `gezel:tray:mode-set`.
ipcMain.on(
  'gezel:tray:sync-config',
  (
    _event,
    cfg?: {
      aiEngagementMode?: EngagementMode;
      showSystemTray?: boolean;
      quitOnClose?: boolean;
      securityPolicy?: unknown;
      ambientDisplay?: { applyWallpaper?: boolean };
    },
  ) => {
    if (!cfg) return;
    if (Object.hasOwn(cfg, 'securityPolicy')) invalidateRendererNetworkPermission();
    // Keep the wallpaper applier in sync when the toggle is flipped from
    // another client (e.g. the web UI) without an IPC round-trip.
    if (Object.hasOwn(cfg, 'ambientDisplay')) {
      setAmbientApplyEnabled(cfg.ambientDisplay?.applyWallpaper === true);
    }
    quitOnClose = cfg.quitOnClose === true;
    if (cfg.showSystemTray === false) {
      teardownTray();
      return;
    }
    ensureTray((cfg.aiEngagementMode ?? 'proactive') as EngagementMode);
  },
);

// Raise an OS notification on the renderer's behalf (e.g. "Gezel needs
// your input" when the window is backgrounded). Returns whether the
// platform could show it.
ipcMain.handle(
  'gezel:notify',
  (_event, opts: { title: string; body?: string; view?: string }): boolean => notify(opts),
);

// Capture a region of the calling renderer's page as a PNG and hand it
// back as a data URL. Used by the output pane's "debug frame" button to
// screenshot the sandboxed preview iframe: the iframe runs null-origin
// (`sandbox="allow-scripts"` without `allow-same-origin`), so the
// renderer can't reach into its DOM to rasterize it — but the iframe IS
// composited into this page, so a `capturePage(rect)` over its bounding
// box grabs the running app's pixels regardless of the origin wall.
// `rect` is in CSS/DIP pixels (matching getBoundingClientRect); omit it
// to capture the whole page.
ipcMain.handle(
  'gezel:capture-page-region',
  async (
    event,
    rect?: { x: number; y: number; width: number; height: number },
  ): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }> => {
    try {
      const round = (r: { x: number; y: number; width: number; height: number }) => ({
        x: Math.max(0, Math.round(r.x)),
        y: Math.max(0, Math.round(r.y)),
        width: Math.max(1, Math.round(r.width)),
        height: Math.max(1, Math.round(r.height)),
      });
      const image = rect
        ? await event.sender.capturePage(round(rect))
        : await event.sender.capturePage();
      if (image.isEmpty()) return { ok: false, error: 'Capture returned an empty image' };
      return { ok: true, dataUrl: image.toDataURL() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
);

/**
 * Install a minimal application menu so the platform's standard shortcuts
 * work: Cmd+R reload, Cmd+Opt+I DevTools, the usual edit-menu clipboard
 * shortcuts, and (on macOS) Cmd+Q. Without this, Electron still ships a
 * default menu but some shortcuts — notably reload — don't reliably bind
 * on macOS when the menu isn't explicitly installed.
 */
function navigateTo(view: string): void {
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send('gezel:navigate', view);
}

async function showMacUninstallDialog(): Promise<void> {
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  macUninstallDialogRequested = true;
  if (!mainWindow || mainWindow.isDestroyed()) await createWindow();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
  if (!connection || splashShowing) return;
  flushMacUninstallDialogRequest();
}

function flushMacUninstallDialogRequest(): void {
  if (!macUninstallDialogRequested || !mainWindow || mainWindow.isDestroyed()) return;
  macUninstallDialogRequested = false;
  mainWindow.webContents.send('gezel:show-uninstall');
}

/**
 * Build a cert-aware GezelClient for the live connection — the same shape
 * the supervisor uses for its own health checks (supervisor/index.ts). The
 * loopback daemon serves a per-launch self-signed cert; `createTrustingFetch`
 * trusts exactly that CA. Returns null before the supervisor has connected.
 */
function buildApiClient(): GezelClient | null {
  if (connection?.state !== 'ready' || !connection.token) return null;
  return connection.cert
    ? new GezelClient({
        baseUrl: connection.baseUrl,
        token: connection.token,
        fetch: createTrustingFetch({ cert: connection.cert }),
      })
    : new GezelClient({ baseUrl: connection.baseUrl, token: connection.token });
}

/** Keep the native tray's working state in sync with all live chat turns. */
function startTrayActivityMonitoring(): void {
  trayActivityAbort?.abort();
  trayActivityAbort = null;
  trayActiveSessions.clear();
  syncTrayActivity();
  if (process.platform !== 'darwin' || process.env.GEZEL_E2E === '1' || !tray?.active) return;

  const controller = new AbortController();
  trayActivityAbort = controller;

  const client = apiClient;
  if (!client) return;
  void monitorTrayActivity(client, controller.signal);
}

function stopTrayActivityMonitoring(): void {
  trayActivityAbort?.abort();
  trayActivityAbort = null;
  trayActiveSessions.clear();
  syncTrayActivity();
}

async function monitorTrayActivity(client: GezelClient, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      for await (const envelope of streamAllChatEvents({
        url: client.allEventsUrl(),
        headers: client.authHeader(),
        fetch: client.getFetch(),
        signal,
      })) {
        if (updateActiveTraySessions(trayActiveSessions, envelope)) syncTrayActivity();
      }
    } catch {
      // The keepalive-aware SSE reader rejects on daemon/socket loss. The
      // supervisor may reconnect independently; retry against this connection
      // until it rotates, at which point startTrayActivityMonitoring aborts us.
    }
    if (signal.aborted) return;
    trayActiveSessions.clear();
    syncTrayActivity();
    await waitForTrayActivityRetry(signal);
  }
}

function waitForTrayActivityRetry(signal: AbortSignal): Promise<void> {
  return new Promise((resolveRetry) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolveRetry();
    };
    const timer = setTimeout(finish, 1_500);
    signal.addEventListener('abort', finish, { once: true });
  });
}

function syncTrayActivity(): void {
  tray?.setWorking(trayActiveSessions.size > 0);
}

// ── Ambient display (wallpaper) ──────────────────────────────────────
//
// The daemon's AmbientDashboardGenerator writes PNGs under
// `~/.gezel/ambient/`; when the user opts in
// (`config.ambientDisplay.applyWallpaper`), the main process keeps the
// desktop wallpaper set to the newest one. Wallpaper APIs are
// user-session-only, which is why this lives here and not in gezeld
// (docs/service-boundaries.md).

let ambientMonitorAbort: AbortController | null = null;
let ambientApplyEnabled = false;
let ambientDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let ambientResumeHooked = false;
let ambientDisplayTargetTimer: ReturnType<typeof setTimeout> | null = null;
let ambientDisplayTargetHooksInstalled = false;

function gezelHomeDir(): string {
  return process.env.GEZEL_HOME || join(homedir(), '.gezel');
}

function ambientRuntimeDeps(): { home: string; module: typeof ambientDisplay } {
  return { home: gezelHomeDir(), module: ambientDisplay };
}

/**
 * Debounced so the SSE `ended` event and any catch-up check that fire
 * together produce one apply, not two.
 */
function scheduleAmbientApply(): void {
  if (!ambientApplyEnabled) return;
  if (ambientDebounceTimer) clearTimeout(ambientDebounceTimer);
  ambientDebounceTimer = setTimeout(() => {
    ambientDebounceTimer = null;
    void applyLatest(ambientRuntimeDeps()).catch((err) => {
      console.warn(`[ambient] wallpaper apply failed: ${err instanceof Error ? err.message : err}`);
    });
  }, 2_000);
}

function setAmbientApplyEnabled(next: boolean): void {
  const was = ambientApplyEnabled;
  ambientApplyEnabled = next;
  if (!was && next) scheduleAmbientApply();
  if (was && !next && ambientDebounceTimer) {
    clearTimeout(ambientDebounceTimer);
    ambientDebounceTimer = null;
  }
}

async function syncPrimaryDisplayTarget(): Promise<void> {
  const client = apiClient;
  if (!client || process.env.GEZEL_E2E === '1') return;
  try {
    const displayTarget = ambientDashboardDisplayTarget(screen.getPrimaryDisplay());
    await client.setAmbientDashboardDisplayTarget(displayTarget);
  } catch (err) {
    console.warn(
      `[ambient] primary display sync failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

function schedulePrimaryDisplayTargetSync(delayMs = 300): void {
  if (process.env.GEZEL_E2E === '1') return;
  if (ambientDisplayTargetTimer) clearTimeout(ambientDisplayTargetTimer);
  ambientDisplayTargetTimer = setTimeout(() => {
    ambientDisplayTargetTimer = null;
    void syncPrimaryDisplayTarget();
  }, delayMs);
}

/**
 * Persist the primary monitor's physical canvas + work-area-safe rectangle.
 * Hooks live for the app lifetime; daemon reconnects merely replace the API
 * client, and startAmbientMonitoring schedules a fresh sync for that client.
 */
function startPrimaryDisplayTargetSync(): void {
  if (process.env.GEZEL_E2E === '1') return;
  if (!ambientDisplayTargetHooksInstalled) {
    ambientDisplayTargetHooksInstalled = true;
    screen.on('display-added', () => schedulePrimaryDisplayTargetSync());
    screen.on('display-removed', () => schedulePrimaryDisplayTargetSync());
    screen.on('display-metrics-changed', () => schedulePrimaryDisplayTargetSync());
  }
  schedulePrimaryDisplayTargetSync(0);
}

function startAmbientMonitoring(): void {
  stopAmbientMonitoring();
  const client = apiClient;
  if (!client || process.env.GEZEL_E2E === '1') return;
  startPrimaryDisplayTargetSync();
  const controller = new AbortController();
  ambientMonitorAbort = controller;
  if (!ambientResumeHooked) {
    ambientResumeHooked = true;
    try {
      // A sleeping machine misses SSE events; check on wake.
      powerMonitor.on('resume', () => scheduleAmbientApply());
    } catch {
      /* powerMonitor unavailable (headless/test) */
    }
  }
  void (async () => {
    try {
      const cfg = await client.getConfig();
      setAmbientApplyEnabled(cfg?.ambientDisplay?.applyWallpaper === true);
    } catch {
      /* config unreadable — keep the current toggle state */
    }
    // Catch-up: a render may have landed while the app was closed.
    scheduleAmbientApply();
    await monitorAmbientEvents(client, controller.signal);
  })();
}

function stopAmbientMonitoring(): void {
  ambientMonitorAbort?.abort();
  ambientMonitorAbort = null;
  if (ambientDebounceTimer) {
    clearTimeout(ambientDebounceTimer);
    ambientDebounceTimer = null;
  }
  if (ambientDisplayTargetTimer) {
    clearTimeout(ambientDisplayTargetTimer);
    ambientDisplayTargetTimer = null;
  }
}

async function monitorAmbientEvents(client: GezelClient, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      for await (const envelope of streamAllChatEvents({
        url: client.allEventsUrl(),
        headers: client.authHeader(),
        fetch: client.getFetch(),
        signal,
      })) {
        const event = envelope.event;
        if (event.type === 'ambient_dashboard' && event.state === 'ended') {
          scheduleAmbientApply();
        }
      }
    } catch {
      // SSE reader rejects on daemon/socket loss; retry against this
      // connection until it rotates, at which point startAmbientMonitoring
      // aborts us.
    }
    if (signal.aborted) return;
    await waitForTrayActivityRetry(signal);
  }
}

let idleReportTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Poll the OS idle time and report it to the daemon every minute. Drives the
 * background enrichment loop's "computer is actually idle" gate. Idempotent
 * (clears any prior timer); best-effort (errors swallowed).
 */
function startIdleReporting(): void {
  if (idleReportTimer) clearInterval(idleReportTimer);
  const report = () => {
    try {
      const idleSeconds = powerMonitor.getSystemIdleTime();
      void apiClient?.reportSystemIdle(idleSeconds).catch(() => {});
    } catch {
      /* powerMonitor unavailable (headless/test) — ignore */
    }
  };
  report();
  idleReportTimer = setInterval(report, 60_000);
}

let nightShiftPowerTimer: ReturnType<typeof setInterval> | null = null;
let powerSaveBlockerId: number | null = null;
/** Last wake time we asked the OS to schedule, so we only re-arm on change. */
let scheduledWakeIso: string | null = null;
const execFileAsync = promisify(execFile);

/**
 * Poll the service's night-shift power intent and drive OS power:
 *   - `keepAwake` → hold a `prevent-app-suspension` power-save blocker so
 *     the machine doesn't sleep mid-shift (all platforms).
 *   - `wakeAtIso` → schedule an OS wake at the next window start so a
 *     sleeping machine comes up for the shift. macOS only (`pmset`); a
 *     no-op with a single log line elsewhere.
 *
 * Idempotent and best-effort; runs on a 30s cadence so "keep awake"
 * engages quickly once a shift starts.
 */
function startNightShiftPowerControl(): void {
  if (nightShiftPowerTimer) clearInterval(nightShiftPowerTimer);

  const applyKeepAwake = (keepAwake: boolean) => {
    if (keepAwake) {
      if (powerSaveBlockerId === null || !powerSaveBlocker.isStarted(powerSaveBlockerId)) {
        powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      }
    } else if (powerSaveBlockerId !== null) {
      if (powerSaveBlocker.isStarted(powerSaveBlockerId)) powerSaveBlocker.stop(powerSaveBlockerId);
      powerSaveBlockerId = null;
    }
  };

  const applyWake = (wakeAtIso: string | null) => {
    if (wakeAtIso === scheduledWakeIso) return; // nothing changed
    scheduledWakeIso = wakeAtIso;
    if (!wakeAtIso) return;
    if (process.platform !== 'darwin') {
      console.log('[night-shift] wakeOnStart is only supported on macOS; skipping');
      return;
    }
    // `pmset schedule wake "MM/dd/yy HH:mm:ss"` (local time). Requires the
    // app to be allowed; failures are non-fatal (logged).
    const d = new Date(wakeAtIso);
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${String(d.getFullYear()).slice(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
    void execFileAsync('pmset', ['schedule', 'wake', stamp]).catch((err: unknown) => {
      console.log(
        `[night-shift] pmset wake schedule failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };

  const poll = () => {
    void apiClient
      ?.getNightShiftPowerIntent()
      .then((intent) => {
        applyKeepAwake(intent.keepAwake);
        applyWake(intent.wakeAtIso);
      })
      .catch(() => {
        /* service not ready / endpoint missing — ignore */
      });
  };
  poll();
  nightShiftPowerTimer = setInterval(poll, 30_000);
}

/**
 * Show and focus the main window, recreating it if it was closed/destroyed.
 * Used by the tray "Open Gezel" item and notification clicks, and to rescue
 * the user from a hidden window when the tray is turned off.
 */
async function ensureWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  await createWindow();
}

/**
 * Raise an OS notification. Clicking it surfaces the window and, when a
 * target view is given, navigates there. No-ops where the platform reports
 * notifications unsupported.
 */
function notify(opts: { title: string; body?: string; view?: string }): boolean {
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title: opts.title, body: opts.body ?? '' });
  n.on('click', () => {
    void ensureWindow();
    if (opts.view) navigateTo(opts.view);
  });
  n.show();
  return true;
}

/**
 * Create the tray if absent, or sync its mode if it already exists. The
 * TrayController.create() call is idempotent in that respect.
 */
function ensureTray(mode: EngagementMode): void {
  if (process.env.GEZEL_E2E === '1') return;
  if (!tray) {
    tray = new TrayController({
      ensureWindow,
      getClient: () => apiClient,
      navigate: navigateTo,
      notifyRendererMode: (m) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('gezel:tray:mode-set', m);
        }
      },
      onQuit: () => {
        isQuitting = true;
        app.quit();
      },
      packaged: app.isPackaged,
      checkForUpdates: triggerUpdateCheck,
      assetsDir: resolve(__dirname, '..', 'assets'),
    });
  }
  tray.create(mode);
  syncTrayActivity();
  if (!trayActivityAbort) startTrayActivityMonitoring();
}

/** Tear down the tray and, if the window is hidden, bring it back so the
 *  user is never left with neither a window nor a tray. */
function teardownTray(): void {
  if (!tray) return;
  stopTrayActivityMonitoring();
  tray.destroy();
  tray = null;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
    void ensureWindow();
  }
}

/** Read config and create the tray when `showSystemTray` is on (default). */
async function initTray(): Promise<void> {
  let mode: EngagementMode = 'proactive';
  let enabled = true;
  try {
    const cfg = await apiClient?.getConfig();
    if (cfg) {
      mode = (cfg.aiEngagementMode ?? 'proactive') as EngagementMode;
      enabled = cfg.showSystemTray !== false;
      quitOnClose = cfg.quitOnClose === true;
    }
  } catch (err) {
    console.warn('[tray] could not read config; defaulting tray on:', err);
  }
  if (enabled) ensureTray(mode);
}

/**
 * Wire the auto-updater (packaged builds only). Beyond the silent
 * download, surface update-available / update-downloaded as OS
 * notifications so the tray is a real locus for updates.
 */
async function setupAutoUpdater(): Promise<void> {
  if (!app.isPackaged) return;
  // Honor both the dedicated launch-check preference and the centralized
  // security ceiling on app-level background egress. A later manual check
  // intentionally bypasses the launch preference, re-evaluates policy, and
  // can initialize the updater if authorization has changed. A successfully
  // loaded config with no policy resolves to the default `lockdown` posture
  // (which permits app updates); an unreadable or invalid config fails closed.
  const permission = await currentUpdaterPermission({ automatic: true });
  if (!permission.allowed) {
    logUpdaterDenied(permission);
    return;
  }
  const updater = ensureAutoUpdater();
  if (updater) await checkAppReleaseForUpdates(updater);
}

function triggerUpdateCheck(): void {
  void triggerAuthorizedUpdateCheck();
}

async function triggerAuthorizedUpdateCheck(): Promise<void> {
  // The security posture can change while Electron remains open. Authorize
  // every network attempt rather than relying on the startup decision.
  const permission = await currentUpdaterPermission();
  if (!permission.allowed) {
    logUpdaterDenied(permission);
    return;
  }
  // Policy/config may have been unavailable at startup. A later explicit
  // check can recover by wiring the updater only after authorization succeeds.
  const updater = ensureAutoUpdater();
  if (!updater) return;
  await checkAppReleaseForUpdates(updater);
}

/**
 * GitHub's repository-wide "latest" release may be a `native-v*` engine
 * release. Resolve the newest exact `v<semver>` application release first,
 * then give electron-updater a generic feed rooted at that immutable tag.
 */
async function checkAppReleaseForUpdates(
  updater: import('electron-updater').AppUpdater,
): Promise<void> {
  appUpdateRelease = null;
  setUpdateState({ kind: 'checking' });
  try {
    const release = await discoverLatestAppRelease({
      fetch: globalThis.fetch,
    });
    if (!release) {
      console.info('[updater] no published application release exists yet');
      setUpdateState({ kind: 'up-to-date', version: app.getVersion() });
      return;
    }
    appUpdateRelease = release;
    updater.setFeedURL(appReleaseFeedConfiguration(release));
    console.info(`[updater] checking application release ${release.tagName}`);
    await updater.checkForUpdates();
  } catch (err) {
    console.warn('[updater] check failed:', err);
    setUpdateState({
      kind: 'error',
      stage: 'check',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function ensureAutoUpdater(): import('electron-updater').AppUpdater | null {
  if (autoUpdaterRef) return autoUpdaterRef;
  try {
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error } as never;
    autoUpdater.on('checking-for-update', () => {
      setUpdateState({ kind: 'checking' });
    });
    autoUpdater.on('update-not-available', () => {
      setUpdateState({ kind: 'up-to-date', version: app.getVersion() });
      tray?.setTooltip('Gezel');
    });
    if (process.platform === 'darwin') {
      // Take the download away from MacUpdater. Its ZIP path cannot deliver a
      // complete macOS update for a machine-service install and cannot elevate
      // — see src/updater/mac-pkg.ts for the full reasoning. We keep
      // electron-updater purely as the version-check, then stage and verify
      // the signed PKG ourselves.
      autoUpdater.autoDownload = false;
      autoUpdater.on('update-available', (info) => {
        void handleMacUpdateAvailable(info.version);
      });
    } else {
      // Make the Windows NSIS/AppImage contract explicit rather than relying
      // on electron-updater's defaults: download in the background, then use
      // its silent install hook after a complete process quit.
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.on('update-available', (info) => {
        setUpdateState(downloadingUpdateState(info.version));
        notify({ title: 'Gezel update available', body: `Downloading version ${info.version}…` });
        tray?.setTooltip('Gezel — downloading update…');
      });
      autoUpdater.on('download-progress', (progress) => {
        const version =
          updateState?.kind === 'downloading'
            ? updateState.version
            : (appUpdateRelease?.version ?? app.getVersion());
        const next = downloadingUpdateState(version, progress);
        if (shouldPublishDownloadState(updateState, next)) setUpdateState(next);
      });
      autoUpdater.on('update-downloaded', (info) => {
        setUpdateState({ kind: 'ready', version: info.version });
        tray?.setTooltip('Gezel — update ready; quit to install');
        notify({
          title: 'Gezel update ready',
          body: `Version ${info.version} will install after you quit Gezel completely.`,
          view: 'home',
        });
      });
      autoUpdater.on('update-cancelled', (info) => {
        setUpdateState({
          kind: 'error',
          stage: 'download',
          version: info.version,
          message: 'The update download was cancelled before it finished.',
        });
        tray?.setTooltip('Gezel');
      });
    }
    autoUpdater.on('error', (err) => {
      console.warn('[updater] error:', err);
      const previous = updateState;
      setUpdateState({
        kind: 'error',
        stage: updateErrorStage(previous),
        version: appUpdateRelease?.version,
        message: err instanceof Error ? err.message : String(err),
      });
      tray?.setTooltip('Gezel');
    });
    autoUpdaterRef = autoUpdater;
    return autoUpdater;
  } catch (err) {
    console.warn('[updater] not available:', err);
    setUpdateState({
      kind: 'error',
      stage: 'check',
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * macOS update flow: fetch the release's signed PKG, verify it end to end,
 * then let the user hand it to Installer.app, which raises macOS's own
 * administrator prompt. We never elevate anything ourselves.
 */
async function handleMacUpdateAvailable(version: string): Promise<void> {
  if (
    updateState?.kind === 'downloading' ||
    (updateState?.kind === 'ready' && updateState.version === version)
  ) {
    return;
  }
  setUpdateState({ kind: 'downloading', version });
  notify({ title: 'Gezel update available', body: `Downloading version ${version}…` });
  tray?.setTooltip('Gezel — downloading update…');
  try {
    const { stageVerifiedMacPkg } = await import('./updater/mac-pkg.js');
    const run = promisify(execFile);
    const staged = await stageVerifiedMacPkg(version, {
      // Electron's per-user data dir, deliberately not GEZEL_HOME: on a
      // machine-service install that is the root-owned system directory.
      stagingDir: join(app.getPath('userData'), 'updates'),
      fetch: globalThis.fetch,
      execFile: async (file, args) => {
        const { stdout, stderr } = await run(file, args, { maxBuffer: 8 * 1024 * 1024 });
        return { stdout: String(stdout), stderr: String(stderr) };
      },
      logger: { info: console.log, warn: console.warn },
    });
    macUpdatePkgPath = staged.path;
    setUpdateState({ kind: 'ready', version });
    tray?.setTooltip('Gezel — update ready to install');
    notify({
      title: 'Gezel update ready',
      body: `Version ${version} is verified. Open Gezel to install it.`,
      view: 'home',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[updater] macOS package staging failed:', message);
    macUpdatePkgPath = null;
    setUpdateState({ kind: 'error', stage: 'download', version, message });
    tray?.setTooltip('Gezel');
  }
}

/**
 * Launch the staged installer. Installer.app authenticates the user itself,
 * replaces the root-owned bundle, and re-runs the postinstall that registers
 * the LaunchDaemon and refreshes the daemon's service tree — the parts a ZIP
 * swap silently skipped.
 */
async function installStagedMacUpdate(): Promise<{ ok: boolean; error?: string }> {
  if (!macUpdatePkgPath) return { ok: false, error: 'No verified update is staged.' };
  const failure = await shell.openPath(macUpdatePkgPath);
  if (failure) {
    console.warn('[updater] could not open staged package:', failure);
    return { ok: false, error: failure };
  }
  return { ok: true };
}

function setUpdateState(next: UpdateState): void {
  updateState = next;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('gezel:update-state', next);
  }
}

function currentUpdaterPermission(
  options: { automatic?: boolean } = {},
): Promise<UpdaterPermission> {
  const client = apiClient;
  return resolveUpdaterPermission(client ? () => client.getConfig() : undefined, options);
}

function logUpdaterDenied(permission: Exclude<UpdaterPermission, { allowed: true }>): void {
  if (permission.reason === 'preference-disabled') {
    console.log('[updater] automatic launch check disabled in settings');
    return;
  }
  if (permission.reason === 'policy-denied') {
    console.log('[updater] disabled by security policy (app network off)');
    return;
  }
  console.warn(
    `[updater] security policy unavailable; update checks are blocked${permission.error ? `: ${permission.error}` : ''}`,
  );
}

function installMenu(): void {
  const isMac = process.platform === 'darwin';

  const viewTabs: Array<{ label: string; view: string; key: string }> = [
    { label: 'Home', view: 'home', key: '1' },
    { label: 'Gezellen', view: 'gezels', key: '2' },
    { label: 'Chat', view: 'chat', key: '3' },
    { label: 'Projects', view: 'projects', key: '4' },
    { label: 'Documents', view: 'documents', key: '5' },
    { label: 'Tasks', view: 'tasks', key: '6' },
    { label: 'History', view: 'history', key: '7' },
    { label: 'Settings', view: 'settings', key: '8' },
  ];

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => navigateTo('settings'),
              },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        ...(!isMac
          ? ([
              { type: 'separator' },
              {
                label: 'Settings',
                accelerator: 'CmdOrCtrl+,',
                click: () => navigateTo('settings'),
              },
            ] as Electron.MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: 'View',
      submenu: [
        ...viewTabs.map(
          (t): Electron.MenuItemConstructorOptions => ({
            label: t.label,
            accelerator: `CmdOrCtrl+${t.key}`,
            click: () => navigateTo(t.view),
          }),
        ),
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'close' },
        ...(isMac
          ? ([{ type: 'separator' }, { role: 'front' }] as Electron.MenuItemConstructorOptions[])
          : []),
      ],
    },
    ...(isMac && app.isPackaged
      ? ([
          {
            label: 'Help',
            submenu: [
              {
                label: 'Uninstall Gezel…',
                click: () => void showMacUninstallDialog(),
              },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Pinned base64 SHA-256 of the daemon's loopback cert. Updated whenever
 * the supervisor swaps the underlying daemon (initial connect + every
 * restart). Compared against `request.certificate.fingerprint` (which
 * Chromium reports as `sha256/<base64>`) inside the verify proc. `null`
 * means "no daemon TLS to trust" — verifier rejects all loopback HTTPS.
 */
let pinnedLoopbackFingerprint: string | null = null;

function pinLoopbackCert(certPem: string | null): void {
  if (!certPem) {
    pinnedLoopbackFingerprint = null;
    return;
  }
  // Derive Chromium's fingerprint shape from the cert PEM. Chromium
  // reports `sha256/<base64-of-DER-digest>`; we strip the prefix in
  // the verifier and compare base64 to base64.
  const derBody = certPem
    .split('\n')
    .filter((l) => !l.startsWith('-----') && l.trim().length > 0)
    .join('');
  const der = Buffer.from(derBody, 'base64');
  pinnedLoopbackFingerprint = createHash('sha256').update(der).digest('base64');
}

app.whenReady().then(async () => {
  // Release CI launches the final electron-builder output with this flag.
  // The early assertions catch an unpacked/dev executable or a stale
  // electron-builder version immediately. The smoke run then continues
  // through an isolated embedded daemon and a real BrowserWindow below.
  if (packagedSmoke) {
    if (!app.isPackaged) {
      console.error('[packaged-smoke] refused: Electron is not running a packaged application');
      process.exit(1);
      return;
    }
    if (packagedSmokeExpectedVersion && app.getVersion() !== packagedSmokeExpectedVersion) {
      console.error(
        `[packaged-smoke] version mismatch: app=${app.getVersion()} expected=${packagedSmokeExpectedVersion}`,
      );
      process.exit(1);
      return;
    }
    // Never consult a developer's keychain or external model provider during
    // a release smoke. `--gezel-home` forces the packaged supervisor down its
    // embedded path, keeping all state inside the runner temp directory.
    process.env.GEZEL_SECRETS_BACKEND = 'file';
    process.env.GEZEL_MOCK_PROVIDER = '1';
    // The smoke must prove these came from the packaged, manifest-verified
    // payload rather than accepting an inherited developer/runner override.
    delete process.env.GEZEL_NODE_PATH;
    delete process.env.GEZEL_PNPM_PATH;
  }

  installMenu();

  // Trust the daemon's per-launch self-signed cert — and ONLY that cert,
  // ONLY on loopback. Any other origin (or the loopback origin presenting
  // a cert that doesn't match the current pin) is rejected. The pin is
  // populated below after `connectOrStart`; before then the verifier
  // refuses everything, which is what we want — no requests should fly
  // before the supervisor has resolved.
  session.defaultSession.setCertificateVerifyProc((req, callback) => {
    const isLoopback =
      req.hostname === '127.0.0.1' || req.hostname === '::1' || req.hostname === 'localhost';
    if (!isLoopback) {
      // Defer to Chromium's normal validation for any non-loopback host
      // — passing -3 means "use the default verification result".
      callback(-3);
      return;
    }
    if (!pinnedLoopbackFingerprint) {
      // Loopback request with no pin yet — refuse rather than trust
      // blindly. This window is tiny (closes once `connectOrStart`
      // returns) but a third-party page reaching our renderer during
      // it shouldn't get a free pass to talk to localhost.
      callback(-2);
      return;
    }
    const got = req.certificate.fingerprint.replace(/^sha256\//, '');
    callback(got === pinnedLoopbackFingerprint ? 0 : -2);
  });

  // CSP is the first renderer egress boundary. This hook is an independent,
  // daemon-authorized sink: even if authored markup finds a CSP bypass, no
  // renderer frame may emit off-daemon HTTP(S)/WebSocket traffic unless both
  // External services and App network are enabled. Preview leases add a
  // second, document-specific permission; navigation stays capability-pinned.
  const requestSplashPath = splashPath();
  const requestSplashUrl = requestSplashPath ? pathToFileURL(requestSplashPath).href : null;
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowedOrigin = connection?.state === 'ready' ? safeOrigin(connection.baseUrl) : null;
    const allowExternalServices = previewExternalServicesForFrame(
      details.frame,
      allowedOrigin,
      previewDocumentExternalServices,
    );

    // A disposed WebFrameMain is not safely inspectable. Deny every preview or
    // subresource-shaped request. The one useful exception is a top-level
    // navigation that independently passes the same exact daemon/splash
    // allowlist enforced by `will-navigate`; this keeps startup functional
    // when Chromium disposes the old main frame during the handoff.
    if (allowExternalServices === PREVIEW_FRAME_INDETERMINATE) {
      const allowedTopLevelRequest =
        details.resourceType === 'mainFrame' &&
        isAllowedTopLevelNavigation(details.url, allowedOrigin, requestSplashUrl);
      callback(allowedTopLevelRequest ? {} : { cancel: true });
      return;
    }

    if (allowExternalServices !== null && details.resourceType === 'subFrame') {
      callback(isAllowedPreviewNavigation(details.url, allowedOrigin) ? {} : { cancel: true });
      return;
    }

    if (
      allowExternalServices !== null &&
      !isAllowedPreviewResourceRequest(details.url, allowedOrigin, allowExternalServices)
    ) {
      callback({ cancel: true });
      return;
    }

    if (!isExternalRendererNetworkRequest(details.url, allowedOrigin)) {
      callback({});
      return;
    }

    void rendererExternalNetworkAllowed()
      .then((allowed) => callback(allowed ? {} : { cancel: true }))
      .catch(() => callback({ cancel: true }));
  });

  // Stamp the renderer CSP onto responses from the loopback origin. CSP
  // on non-document responses is ignored by the browser, so a blanket
  // hook is both safe and the simplest delivery point — EXCEPT for the
  // `/preview/*` routes, which serve untrusted, model-authored HTML
  // *documents* into sandboxed iframes and ship their OWN hardened CSP
  // (see previewRoutes). Stamping the renderer CSP over those would force
  // `frame-ancestors 'none'` onto the preview doc — making it refuse to
  // be embedded, so the output pane renders blank — and would also strip
  // the preview's deliberate CDN/img allowances. Leave preview responses
  // to their route-set CSP.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const allowedOrigin = connection?.state === 'ready' ? safeOrigin(connection.baseUrl) : null;
    if (isPreviewDocumentUrl(details.url, allowedOrigin)) {
      if (details.resourceType === 'subFrame') {
        const policyHeader = responseHeaderValue(
          details.responseHeaders,
          PREVIEW_EXTERNAL_SERVICES_HEADER,
        );
        // Only the exact trusted preview route reaches this branch. Missing or
        // malformed policy signals are deliberately interpreted as blocked.
        rememberPreviewDocument(details.url, policyHeader === 'allowed');
      }
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [GEZEL_CSP],
      },
    });
  });

  // Resolve the home directory for this launch and pin it into the
  // environment so every downstream read (autostart install,
  // `resolveInstalledGezeld`, spawned children via the supervisor) sees
  // the same value.
  const launch = resolveLaunch();
  process.env.GEZEL_HOME = launch.home;
  console.log(`[app] gezel home: ${launch.home}`);

  // Dev launches default to the encrypted file secret store instead of the OS
  // keyring. In dev the service runs embedded in this Electron process and
  // re-reads secrets on timers/polls; if the OS keyring is locked mid-session
  // — the common Linux trigger is gnome-keyring respawning without the login
  // password after a crash — every read of a stored-but-locked secret raises a
  // Secret Service "keyring did not get unlocked" prompt, pinging the developer
  // on a loop (the keyring-prompt incident). The file store lives under
  // the dev home (`~/.gezel-dev`) and never touches the OS keychain. Packaged
  // installs and tests are unaffected. Opt back into the real keychain for
  // keyring testing with `GEZEL_SECRETS_BACKEND=keyring`.
  if (!app.isPackaged && !process.env.GEZEL_SECRETS_BACKEND) {
    process.env.GEZEL_SECRETS_BACKEND = 'file';
  }

  // Dev-mode dock icon on macOS — the packaged .app gets its icon from the
  // bundle's Info.plist, but `electron .` shows the default Electron icon
  // until we explicitly set it.
  if (process.platform === 'darwin' && app.dock) {
    // Use the squircle-masked variant so the dev dock matches the packaged
    // .icns look; fall back to the flat square if it's missing.
    const assets = resolve(__dirname, '..', 'assets');
    const macIcon = join(assets, 'icon-mac.png');
    const fallback = join(assets, 'icon.png');
    const pick = existsSync(macIcon) ? macIcon : existsSync(fallback) ? fallback : null;
    if (pick) app.dock.setIcon(pick);
  }

  // E2E courtesy mode (macOS): when `GEZEL_E2E=1`, switch the activation
  // policy to `accessory`. The BrowserWindow still renders and Playwright
  // can drive it, but the app:
  //   - doesn't show in the dock
  //   - doesn't steal focus from whatever the developer's working in
  //   - doesn't pull the foreground app into the background each launch
  // This suppresses the dock/menu-bar presence; the window itself is kept
  // off-screen and shown inactive in `createWindow` (the `e2e` branch), so
  // between the two the window never appears or steals focus on any platform.
  if (
    process.platform === 'darwin' &&
    (process.env.GEZEL_E2E === '1' || packagedSmoke) &&
    app.dock
  ) {
    app.dock.hide();
    // setActivationPolicy is the load-bearing call — `dock.hide()` alone
    // doesn't prevent focus theft on window creation.
    if (typeof app.setActivationPolicy === 'function') {
      app.setActivationPolicy('accessory');
    }
  }

  // Paint the window before the daemon is asked for. connectOrStart unpacks
  // the service bundle and provisions the bundled runtimes on first launch,
  // which is minutes of work on a cold machine; doing this afterwards is what
  // made a fresh install look like it had failed to launch.
  await createWindow();

  try {
    connection = await connectOrStart({
      home: launch.home,
      packaged: app.isPackaged,
      devSpawn: process.env.GEZEL_SPAWN === '1',
      // In dev we default to embedded for fast iteration; the user opts into
      // the spawn path with `GEZEL_SPAWN=1`. `--gezel-home=<path>` also
      // forces embedded so sandbox instances stay isolated.
      forceEmbedded:
        launch.forceEmbeddedFromCli ||
        process.env.GEZEL_EMBEDDED === '1' ||
        (!app.isPackaged && process.env.GEZEL_SPAWN !== '1'),
      uiDir: resolveBundledUi(),
      logger: {
        info: (m) => {
          console.log(m);
          const stage = splashStage(m);
          if (stage) setSplashStatus(stage);
        },
        warn: (m) => console.warn(m),
        error: (m) => console.error(m),
      },
    });
  } catch (err) {
    console.error('Gezel service failed to start:', err);
    if (packagedSmoke) {
      app.exit(1);
      return;
    }
    // Explain, don't evaporate. Quitting here was survivable when the window
    // was created *after* connectOrStart — the user saw nothing appear and
    // read it as a launch that failed. Now the splash is already on screen,
    // so a bare app.quit() looks exactly like a crash a few seconds in. Paint
    // the failure instead and let the user close it themselves.
    if (mainWindow && !mainWindow.isDestroyed()) {
      splashShowing = false;
      await showStartupError(mainWindow, err as Error);
      return;
    }
    app.quit();
    return;
  }

  // Pin the daemon's TLS cert so the verify proc registered above will
  // accept the loopback HTTPS connection the renderer is about to open.
  pinLoopbackCert(connection.cert);

  // Build the main-process API client (used by the tray to read/write the
  // engagement mode). Cert-aware, mirroring the supervisor's own client.
  apiClient = buildApiClient();
  invalidateRendererNetworkPermission();
  startAmbientMonitoring();

  // Reload the BrowserWindow when the supervisor swaps the child or falls
  // back to embedded. The preload re-runs on reload, re-reads the token via
  // IPC, and the UI's GezelClient is rebuilt. One ~1s flicker; no persistent
  // state is lost because sessions live on disk. The cert may have rotated
  // too — re-pin before the reload so the new daemon's TLS chain is trusted
  // from the first request.
  connection.onRestart(() => {
    pinLoopbackCert(connection?.cert ?? null);
    // Token/cert rotated with the new daemon — rebuild the tray's client.
    apiClient = buildApiClient();
    invalidateRendererNetworkPermission();
    startTrayActivityMonitoring();
    startAmbientMonitoring();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    console.log('[app] reloading window after service restart');
    // Load the (possibly rotated) baseUrl rather than `reload()`: an embedded
    // restart can come back on a different port, which a same-URL reload would
    // miss, and this is also what lets the error page's Reconnect button climb
    // back out of the `data:` fallback once the service is healthy again.
    void loadAppUrl(mainWindow, `${connection?.baseUrl ?? ''}/`);
  });

  // If both the owned-daemon replacement and its embedded recovery fail, the
  // supervisor has already invalidated its token. Drop every main-process
  // consumer too, remove the TLS pin, and navigate to a persistent data: page.
  // Its fresh preload receives `null` from current-connection, so the stopped
  // daemon's bearer token cannot remain in the renderer generation.
  connection.onFatal((failure) => {
    pinLoopbackCert(null);
    apiClient = null;
    invalidateRendererNetworkPermission();
    stopTrayActivityMonitoring();
    stopAmbientMonitoring();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    console.error(`[app] service restart became unrecoverable: ${failure.message}`);
    void showConnectionError(
      mainWindow,
      `${connection?.baseUrl ?? ''}/`,
      new Error(failure.message),
    );
  });

  await navigateToApp();

  if (packagedSmoke) {
    try {
      if (!mainWindow || mainWindow.isDestroyed() || !apiClient || !connection) {
        throw new Error('main window, API client, or service connection was not created');
      }
      if (!process.env.GEZEL_NODE_PATH) {
        throw new Error('bundled Node runtime did not pass integrity verification and install');
      }
      if (!process.env.GEZEL_PNPM_PATH) {
        throw new Error('bundled pnpm runtime did not pass integrity verification and install');
      }
      const [health, renderer] = await Promise.all([
        apiClient.health(),
        mainWindow.webContents.executeJavaScript(
          '({ readyState: document.readyState, hasBody: Boolean(document.body?.childElementCount) })',
        ) as Promise<{ readyState: string; hasBody: boolean }>,
      ]);
      const loadedUrl = mainWindow.webContents.getURL();
      if (!loadedUrl.startsWith(connection.baseUrl)) {
        throw new Error(`renderer loaded unexpected URL ${loadedUrl}`);
      }
      if (health.ok !== true) throw new Error('daemon health response was not ok');
      if (packagedSmokeExpectedVersion && health.version !== packagedSmokeExpectedVersion) {
        throw new Error(
          `daemon health version=${health.version} expected=${packagedSmokeExpectedVersion}`,
        );
      }
      if (renderer.readyState !== 'complete' || !renderer.hasBody) {
        throw new Error(
          `renderer was not ready (readyState=${renderer.readyState}, hasBody=${renderer.hasBody})`,
        );
      }
      console.log(
        `[packaged-smoke] ready app=${app.getVersion()} daemon=${health.version} renderer=${loadedUrl}`,
      );
      isQuitting = true;
      mainWindow.destroy();
      await connection.shutdown();
      connection = null;
      app.exit(0);
    } catch (err) {
      console.error(
        `[packaged-smoke] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      app.exit(1);
    }
    return;
  }

  // Report OS idle time to the daemon so the background "boekwachter"
  // enrichment loop only runs heavy local-model work when the user is away.
  // Best-effort: failures are swallowed (the daemon treats a missing report as
  // "unknown" and falls back to the session-idle gate).
  startIdleReporting();

  // Drive OS power for Night Shift: hold a power-save blocker while a shift
  // runs (if enabled), and pre-arm an OS wake at the window start (macOS).
  startNightShiftPowerControl();

  // System tray (locus for notifications + the engagement-mode toggle).
  // Reads `showSystemTray` (default on); skipped under the E2E harness so
  // its window-close specs keep quitting. Non-fatal if it fails.
  await initTray();

  // Resolve the latest exact `v<semver>` app release, then point
  // electron-updater at that immutable release's metadata. This deliberately
  // excludes the repository's `native-v*` releases. Packaged builds only —
  // dev launches have no signed installer to update from.
  await setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on('window-all-closed', () => {
  // Non-macOS always quits when the last window closes. macOS keeps the app
  // resident by convention — unless the user opts into `quitOnClose`, which
  // makes the red X terminate Gezel outright (Windows-style). Off by default.
  if (process.platform !== 'darwin' || quitOnClose) {
    isQuitting = true;
    app.quit();
  }
});

app.on('before-quit', (event) => {
  // Let the close-to-tray handler know this is a real quit so it stops
  // intercepting the window close. Electron does not await an async event
  // listener, so prevent the first quit until the coordinator confirms the
  // owned service has stopped; its second app.quit() is allowed through.
  isQuitting = true;
  stopTrayActivityMonitoring();
  stopAmbientMonitoring();
  quitCoordinator.handleBeforeQuit(event);
});
