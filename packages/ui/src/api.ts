import type { GezmodelEngine, GezmodelImportReview } from '@bendyline/gezel';
import { GezelClient } from '@bendyline/gezel-client';

/**
 * Build a client against the daemon that served this HTML. When the Electron
 * shell hosts us, it injects a preload variable with the token; otherwise we
 * fall back to a `?token=` query-string parameter (handy for local dev).
 */
declare global {
  interface Window {
    __GEZEL__?: {
      token: string;
      baseUrl?: string;
      platform?: 'darwin' | 'win32' | 'linux' | string;
      /**
       * Set by the Electron supervisor when it fell back to embedded mode
       * after repeated spawn failures. The UI shows a persistent banner so
       * the user understands why packaged-mode behavior degraded.
       */
      fallbackReason?: string | null;
      /**
       * How the Electron shell connected to gezeld this launch. "Cold"
       * modes (embedded, local-spawn-*) mean the service just booted and
       * initial probes may lag; "warm" modes (remote, local-adopt,
       * system-service) are already up and should respond quickly. Null
       * when running outside Electron (browser dev harness).
       */
      mode?:
        | 'remote'
        | 'system-service'
        | 'local-adopt'
        | 'local-spawn-packaged'
        | 'local-spawn-dev'
        | 'embedded'
        | null;
      selectDirectory?: (opts?: {
        title?: string;
        defaultPath?: string;
      }) => Promise<string | null>;
      /**
       * Mailbox OAuth (desktop shell). `mailOAuthListen` opens a loopback
       * redirect listener and returns its URI to feed into the service's
       * `/mail/oauth/start`; `mailOAuthAwait` opens the consent page in the
       * browser and resolves the captured authorization `code` + `state`.
       * Absent outside Electron — the renderer falls back to finishing the
       * link from the project's Mail tab.
       */
      mailOAuthListen?: () => Promise<{ requestId: string; redirectUri: string }>;
      mailOAuthAwait?: (
        requestId: string,
        authUrl: string,
      ) => Promise<{ code: string; state: string } | { error: string }>;
      autostart?: {
        status(): Promise<{ ok: true; installed: boolean } | { ok: false; error: string }>;
        install(): Promise<{ ok: true } | { ok: false; error: string }>;
        uninstall(): Promise<{ ok: true } | { ok: false; error: string }>;
      };
      /**
       * Open the service's `~/.gezel/logs/` folder in the OS file
       * manager. Returns an empty string on success, an error message
       * otherwise (matches Electron's `shell.openPath` semantics).
       */
      openLogsFolder?: () => Promise<string>;
      /**
       * Open an arbitrary folder in the OS file manager. Returns an empty
       * string on success, an error message otherwise (matches Electron's
       * `shell.openPath` semantics).
       */
      openPath?: (target: string) => Promise<string>;
      onNavigate?: (callback: (view: string) => void) => void;
      /** Stream an installed local model into a user-selected `.gezmodel` file. */
      exportModelBundle?: (
        engine: GezmodelEngine,
        id: string,
      ) => Promise<{ ok: true; path?: string } | { ok: false; error: string }>;
      /**
       * Scan an OS-opened bundle identified by an opaque main-process request
       * id. The renderer never receives an arbitrary local filesystem path.
       */
      scanOpenedModelBundle?: (
        requestId: string,
      ) => Promise<{ ok: true; review: GezmodelImportReview } | { ok: false; error: string }>;
      /** Receive `.gezmodel` double-click/open-file handoffs from the OS. */
      onOpenModelBundle?: (
        callback: (request: { requestId: string; filename: string }) => void,
      ) => void;
      /**
       * Restart the gezel service. Used by Settings → Folders after a
       * successful externalization move. The supervisor handles
       * embedded vs. spawned modes; the BrowserWindow auto-reloads
       * when the service comes back up.
       */
      restartService?: (reason?: string) => Promise<{ ok: true } | { ok: false; error: string }>;
      /**
       * Push the latest config to the Electron main process so the system
       * tray's engagement-mode radio stays in sync and the tray is
       * created/destroyed when `showSystemTray` flips. No-op outside the
       * desktop shell.
       */
      syncConfig?: (cfg: {
        aiEngagementMode?: 'proactive' | 'scheduled' | 'reactive' | 'off';
        showSystemTray?: boolean;
        quitOnClose?: boolean;
      }) => void;
      /**
       * Register a callback fired when the engagement mode is changed from
       * the tray menu, so the in-app UI can reflect it. Mirrors
       * `onNavigate`.
       */
      onEngagementModeChanged?: (
        callback: (mode: 'proactive' | 'scheduled' | 'reactive' | 'off') => void,
      ) => void;
      /**
       * Raise an OS notification (e.g. when Gezel needs input while the
       * window is backgrounded). Resolves to whether it was shown.
       */
      notify?: (opts: { title: string; body?: string; view?: string }) => Promise<boolean>;
      /**
       * Screenshot a region of the renderer page (CSS/DIP pixels, matching
       * `getBoundingClientRect`) as a PNG data URL. The output pane uses
       * this to capture its sandboxed preview iframe — the iframe runs
       * null-origin so the renderer can't rasterize it directly, but it's
       * composited into the page, so a region capture grabs its pixels.
       * Omit `rect` to capture the whole page. No-op outside the desktop
       * shell (undefined).
       */
      capturePageRegion?: (rect?: {
        x: number;
        y: number;
        width: number;
        height: number;
      }) => Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }>;
      /**
       * Optional `fetch` impl injected by an embedding host. Used by the
       * VS Code extension's chat webview to route every daemon call
       * through a postMessage RPC bridge — the webview can't accept the
       * daemon's per-launch self-signed cert directly, but the
       * extension host owns a TLS-trusting undici fetch and proxies on
       * the webview's behalf. Absent for the desktop SPA, which uses
       * the browser's native fetch.
       */
      fetch?: typeof fetch;
      /**
       * Pre-selected project for embedded surfaces (VS Code webview).
       * The desktop SPA derives this from its own navigation; embedded
       * hosts pass it explicitly via the boot contract so the chat
       * panel can mount on the right project without an extra hop.
       */
      projectId?: string;
      /** Pre-selected gezel for embedded surfaces. See `projectId`. */
      gezelId?: string;
      /**
       * Ask an embedding editor to open a workspace-relative file. VS Code
       * supplies this through its webview bridge; standalone/Electron builds
       * omit it and keep using Gezel's in-app file viewer.
       */
      openWorkspaceFile?: (path: string, line?: number) => void;
    };
  }
}

function resolveToken(): string {
  const injected = window.__GEZEL__?.token;
  if (injected) return injected;
  const fromQuery = new URLSearchParams(window.location.search).get('token');
  if (fromQuery) {
    // One-time token URL — `gezel start --web` prints
    // `http://127.0.0.1:6228/?token=…`. Persist it so reloads and
    // client-side navigation stay authed (the fixed canonical port gives
    // a stable origin, so localStorage survives across launches), then
    // scrub it from the URL so the secret doesn't linger in the address
    // bar / browser history.
    try {
      window.localStorage.setItem('gezel:token', fromQuery);
    } catch {
      /* private mode / storage disabled — fall through to in-memory use */
    }
    scrubTokenFromUrl();
    return fromQuery;
  }
  const fromStorage = window.localStorage.getItem('gezel:token');
  if (fromStorage) return fromStorage;
  return '';
}

function scrubTokenFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('token')) return;
    url.searchParams.delete('token');
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    /* replaceState unavailable (non-browser/test env) — best-effort */
  }
}

function resolveBaseUrl(): string {
  return window.__GEZEL__?.baseUrl ?? window.location.origin;
}

export const api = new GezelClient({
  baseUrl: resolveBaseUrl(),
  token: resolveToken(),
  fetch: window.__GEZEL__?.fetch,
});
