// Electron's `electron` module is injected by its patched CJS loader, so —
// as in main.ts — we pull the API through `createRequire` rather than an
// ESM `import`, which would see an empty wrapper on Node 22+.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { GezelClient } from '@bendyline/gezel-client/node';

const require = createRequire(import.meta.url);
// biome-ignore format: `typeof import(...)` cannot be broken across lines
const { Tray, Menu, nativeImage, systemPreferences } = require('electron') as typeof import('electron');

const WORKING_FRAME_COUNT = 5;
const WORKING_FRAME_MS = 240;

/**
 * Gezel's AI engagement mode, mirrored from `GezelConfig.aiEngagementMode`
 * (packages/core/src/engagement.ts). Inlined here so the tray module
 * doesn't pull in a core dependency just for the union.
 */
export type EngagementMode = 'proactive' | 'scheduled' | 'reactive' | 'off';

const MODE_LABELS: Record<EngagementMode, string> = {
  proactive: 'Proactive',
  scheduled: 'Scheduled',
  reactive: 'Reactive only',
  off: 'Off',
};

const MODES: EngagementMode[] = ['proactive', 'scheduled', 'reactive', 'off'];

export interface TrayDeps {
  /** Show/focus the main window, recreating it if it was closed. */
  ensureWindow: () => void | Promise<void>;
  /** The cert-aware GezelClient from main, or null before connect. */
  getClient: () => GezelClient | null;
  /** Send the renderer to a named view (reuses `gezel:navigate`). */
  navigate: (view: string) => void;
  /** Push the new mode to the renderer so the header menu stays in sync. */
  notifyRendererMode: (mode: EngagementMode) => void;
  /** Begin a real app quit (sets the quitting flag, then `app.quit()`). */
  onQuit: () => void;
  /** Whether this is a packaged build — gates "Check for updates". */
  packaged: boolean;
  /** Trigger an update check (packaged only). */
  checkForUpdates?: () => void;
  /** Directory holding the tray icon assets (packages/app/assets). */
  assetsDir: string;
}

/**
 * Owns the system-tray / menu-bar icon and its context menu. The tray is
 * the resident locus for status, notifications, and the engagement-mode
 * toggle. Created and torn down by main.ts in response to the
 * `showSystemTray` preference; mode changes flow both ways (tray → service
 * via the GezelClient, and UI → tray via `setMode`).
 */
export class TrayController {
  private tray: Electron.Tray | null = null;
  private mode: EngagementMode = 'proactive';
  private working = false;
  private workingFrames: Electron.NativeImage[] | null = null;
  private animationTimer: ReturnType<typeof setInterval> | null = null;
  private animationFrame = 0;

  constructor(private readonly deps: TrayDeps) {}

  /** True while the tray icon is installed. */
  get active(): boolean {
    return this.tray !== null;
  }

  /** Create the tray (or, if it already exists, just sync the mode). */
  create(mode: EngagementMode): void {
    if (this.tray) {
      this.setMode(mode);
      return;
    }
    this.mode = mode;
    this.tray = new Tray(this.trayImage());
    this.tray.setToolTip(this.tooltip());
    // Left-click toggles the window on Windows/Linux; on macOS a click
    // opens the context menu (the platform default once a menu is set).
    this.tray.on('click', () => {
      void this.deps.ensureWindow();
    });
    this.rebuildMenu();
    this.syncWorkingImage();
  }

  /** Reflect a mode change (from the UI or the tray itself). */
  setMode(mode: EngagementMode): void {
    this.mode = mode;
    if (!this.tray) return;
    this.tray.setToolTip(this.tooltip());
    this.rebuildMenu();
  }

  /** Override the tooltip transiently (e.g. "downloading update…"). */
  setTooltip(text: string): void {
    this.tray?.setToolTip(text);
  }

  /** Animate the macOS menu-bar bench while at least one gezel is mid-turn. */
  setWorking(working: boolean): void {
    if (working === this.working) return;
    this.working = working;
    this.syncWorkingImage();
  }

  destroy(): void {
    if (!this.tray) return;
    this.stopAnimation();
    this.tray.destroy();
    this.tray = null;
  }

  private tooltip(): string {
    return `Gezel — ${MODE_LABELS[this.mode]}`;
  }

  private async selectMode(next: EngagementMode): Promise<void> {
    if (next === this.mode) return;
    const client = this.deps.getClient();
    if (!client) return;
    try {
      await client.updateConfig({ aiEngagementMode: next });
      this.setMode(next);
      this.deps.notifyRendererMode(next);
    } catch {
      // Swallow — the radio stays on the previous mode and the user can
      // retry. setMode is only called on success, so the menu never lies.
    }
  }

  private rebuildMenu(): void {
    if (!this.tray) return;
    const modeItems: Electron.MenuItemConstructorOptions[] = MODES.map((m) => ({
      label: MODE_LABELS[m],
      type: 'radio',
      checked: this.mode === m,
      click: () => {
        void this.selectMode(m);
      },
    }));

    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'Open Gezel',
        click: () => {
          void this.deps.ensureWindow();
        },
      },
      { type: 'separator' },
      { label: 'Engagement mode', submenu: modeItems },
      {
        label: 'Settings…',
        click: () => {
          void this.deps.ensureWindow();
          this.deps.navigate('settings');
        },
      },
      ...(this.deps.packaged && this.deps.checkForUpdates
        ? ([
            {
              label: 'Check for updates…',
              click: () => this.deps.checkForUpdates?.(),
            },
          ] as Electron.MenuItemConstructorOptions[])
        : []),
      { type: 'separator' },
      { label: 'Quit Gezel', click: () => this.deps.onQuit() },
    ];

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  private syncWorkingImage(): void {
    if (!this.tray) return;
    this.stopAnimation();

    if (!this.working || process.platform !== 'darwin') {
      this.tray.setImage(this.trayImage());
      return;
    }

    const frames = this.trayWorkingImages();
    if (frames.length === 0) return;

    // Reduced Motion still gets a distinct, half-filled working state; only
    // the cycling is suppressed. Re-evaluated on each turn so changing the
    // system preference does not require an app restart.
    let reduceMotion = false;
    try {
      reduceMotion = systemPreferences.getAnimationSettings().prefersReducedMotion;
    } catch {
      /* unavailable on an older Electron/platform — animate normally */
    }
    if (reduceMotion) {
      this.tray.setImage(frames[Math.floor(frames.length / 2)]!);
      return;
    }

    this.animationFrame = 0;
    this.tray.setImage(frames[0]!);
    this.animationTimer = setInterval(() => {
      if (!this.tray || !this.working) return;
      this.animationFrame = (this.animationFrame + 1) % frames.length;
      this.tray.setImage(frames[this.animationFrame]!);
    }, WORKING_FRAME_MS);
    this.animationTimer.unref?.();
  }

  private stopAnimation(): void {
    if (this.animationTimer) clearInterval(this.animationTimer);
    this.animationTimer = null;
    this.animationFrame = 0;
  }

  private trayWorkingImages(): Electron.NativeImage[] {
    if (this.workingFrames) return this.workingFrames;
    const frames: Electron.NativeImage[] = [];
    for (let i = 1; i <= WORKING_FRAME_COUNT; i += 1) {
      // Each base PNG has an adjacent @2x representation; Electron folds the
      // pair into one NativeImage and macOS chooses for the current display.
      const p = join(this.deps.assetsDir, `trayWorking${i}Template.png`);
      if (!existsSync(p)) continue;
      const img = nativeImage.createFromPath(p);
      if (img.isEmpty()) continue;
      img.setTemplateImage(true);
      frames.push(img);
    }
    this.workingFrames = frames;
    return frames;
  }

  private trayImage(): Electron.NativeImage {
    if (process.platform === 'darwin') {
      // A `…Template` filename tells Electron to treat the image as a
      // monochrome template that adapts to light/dark menu bars; the
      // `@2x` variant is picked up automatically.
      const p = join(this.deps.assetsDir, 'trayTemplate.png');
      if (existsSync(p)) {
        const img = nativeImage.createFromPath(p);
        img.setTemplateImage(true);
        return img;
      }
    }
    // Windows/Linux (and macOS fallback): a small color icon derived from
    // the app icon. Resized down so the full-resolution logo doesn't get
    // squashed by the platform at draw time.
    const png = join(this.deps.assetsDir, 'icon.png');
    if (existsSync(png)) {
      const size = process.platform === 'win32' ? 16 : 22;
      return nativeImage.createFromPath(png).resize({ width: size, height: size });
    }
    return nativeImage.createEmpty();
  }
}
