import * as darwin from './darwin.js';
import * as linux from './linux.js';
import * as win32 from './win32.js';

/**
 * Per-OS wallpaper application for the ambient dashboard. Gezel acts as
 * the rotator: no desktop OS exposes an admin-free API for configuring
 * folder-slideshow rotation, but setting a single image is stable on
 * all three, so the shell re-applies the newest PNG whenever the
 * generator produces one. Everything here runs in the Electron main
 * process — a user-session context is required (see
 * docs/service-boundaries.md; the machine broker can never do this).
 */

export interface AmbientCapability {
  supported: boolean;
  reason?: 'unsupported-platform' | 'unknown-desktop' | 'command-missing';
  /** Detected desktop environment on Linux (informational). */
  desktop?: string;
  /** False where the previous wallpaper cannot be read back (KDE). */
  canRestore: boolean;
}

/**
 * Whatever `getCurrentWallpaper` captured before the first apply.
 * `value` is platform-shaped: a path/URI on macOS/Windows, and both
 * light and dark URIs on GNOME-family desktops.
 */
export interface SavedWallpaper {
  platform: string;
  capturedAt: string;
  value: string | { light: string; dark: string };
}

export interface AmbientDisplayModule {
  capability(): Promise<AmbientCapability>;
  /** Best-effort read of the current wallpaper; null when unreadable. */
  getCurrentWallpaper(): Promise<SavedWallpaper['value'] | null>;
  setWallpaper(imagePath: string): Promise<void>;
  restoreWallpaper(saved: SavedWallpaper): Promise<void>;
}

const UNSUPPORTED: AmbientDisplayModule = {
  capability: async () => ({
    supported: false,
    reason: 'unsupported-platform',
    canRestore: false,
  }),
  getCurrentWallpaper: async () => null,
  setWallpaper: async () => {
    throw new Error(`Wallpaper control is not supported on ${process.platform}`);
  },
  restoreWallpaper: async () => undefined,
};

function impl(): AmbientDisplayModule {
  if (process.platform === 'darwin') return darwin;
  if (process.platform === 'linux') return linux;
  if (process.platform === 'win32') return win32;
  return UNSUPPORTED;
}

export const ambientDisplay: AmbientDisplayModule = {
  capability: () => impl().capability(),
  getCurrentWallpaper: () => impl().getCurrentWallpaper(),
  setWallpaper: (imagePath) => impl().setWallpaper(imagePath),
  restoreWallpaper: (saved) => impl().restoreWallpaper(saved),
};
