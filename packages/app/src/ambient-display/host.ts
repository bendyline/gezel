// Electron's `electron` module is injected by its patched CJS loader, so —
// as in main.ts — we pull the API through `createRequire` rather than an
// ESM `import`, which would see an empty wrapper on Node 22+.
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type GezelClient, streamAllChatEvents } from '@bendyline/gezel-client/node';
import { ambientDir } from '@bendyline/gezel/paths';
import type { IpcMain } from 'electron';
import { waitForTrayActivityRetry } from '../tray-activity.js';
import { ambientDashboardDisplayTarget } from './display-target.js';
import { ambientDisplay } from './index.js';
import {
  disable as ambientDisable,
  enable as ambientEnable,
  applyLatest,
  newestDatedImage,
  readDisplayState,
} from './runtime.js';

const require = createRequire(import.meta.url);
// biome-ignore format: `typeof import(...)` cannot be broken across lines
const { powerMonitor, screen, shell } = require('electron') as typeof import('electron');

// ── Ambient display (wallpaper) ──────────────────────────────────────
//
// The daemon's AmbientDashboardGenerator writes PNGs under
// `~/.gezel/ambient/`; when the user opts in
// (`config.ambientDisplay.applyWallpaper`), the main process keeps the
// desktop wallpaper set to the newest one. Wallpaper APIs are
// user-session-only, which is why this lives here and not in gezeld
// (docs/service-boundaries.md).

/** Resolves the live connection's client, which rotates with each daemon restart. */
export type AmbientClientSource = () => GezelClient | null;

/** Set by {@link registerAmbientDisplayIpc}; the IPC handlers and the monitor both read it. */
let getClient: AmbientClientSource = () => null;
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

export function setAmbientApplyEnabled(next: boolean): void {
  const was = ambientApplyEnabled;
  ambientApplyEnabled = next;
  if (!was && next) scheduleAmbientApply();
  if (was && !next && ambientDebounceTimer) {
    clearTimeout(ambientDebounceTimer);
    ambientDebounceTimer = null;
  }
}

async function syncPrimaryDisplayTarget(): Promise<void> {
  const client = getClient();
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

export function startAmbientMonitoring(): void {
  stopAmbientMonitoring();
  const client = getClient();
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

export function stopAmbientMonitoring(): void {
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

// ── Ambient display IPC ─────────────────────────────────────────────
// Paths are computed main-side from GEZEL_HOME — the renderer never
// supplies one (same posture as gezel:open-logs-folder).
export function registerAmbientDisplayIpc(ipcMain: IpcMain, clientSource: AmbientClientSource) {
  getClient = clientSource;

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
        const cfg = await getClient()?.getConfig();
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
    if (!getClient()) return { ok: false, error: 'service is unavailable' };
    try {
      // OS action first: the macOS Automation (TCC) prompt then fires in
      // the context of the user's click, not from a background timer.
      const result = await ambientEnable(ambientRuntimeDeps());
      await getClient()!.updateConfig({ ambientDisplay: { applyWallpaper: true } });
      setAmbientApplyEnabled(true);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('gezel:ambient:disable', async () => {
    if (!getClient()) return { ok: false, error: 'service is unavailable' };
    try {
      const result = await ambientDisable(ambientRuntimeDeps());
      await getClient()!.updateConfig({ ambientDisplay: { applyWallpaper: false } });
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
}
