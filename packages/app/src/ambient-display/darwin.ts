import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AmbientCapability, SavedWallpaper } from './index.js';

const defaultExec = promisify(execFile);

const OSASCRIPT = '/usr/bin/osascript';
const EXEC_TIMEOUT_MS = 10_000;

/** Test seam: inject exec; production uses the real one. */
export interface DarwinAmbientDeps {
  exec?: (
    command: string,
    args: readonly string[],
    opts?: { timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

export function escapeAppleScript(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * "every desktop" covers each display's *current* Space; other Spaces
 * pick the image up when visited — self-healing since we re-apply on
 * every new render. The macOS lock screen follows the desktop
 * wallpaper (Sonoma+), so this is the lock-screen integration too.
 */
export function buildSetScript(imagePath: string): string {
  return `tell application "System Events" to set picture of every desktop to POSIX file "${escapeAppleScript(imagePath)}"`;
}

export function buildGetScript(): string {
  return `tell application "System Events" to get picture of first desktop`;
}

/**
 * Automation (TCC) denial. The user has to flip Gezel on under System
 * Settings → Privacy & Security → Automation; retrying without that
 * re-prompts or silently fails, so callers must not retry-loop.
 */
export function isAutomationDenied(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes('-1743') || text.includes('Not authorized to send Apple events');
}

const AUTOMATION_HELP =
  'Gezel is not allowed to control System Events. Allow it under System Settings → Privacy & Security → Automation, then try again.';

export async function capability(_deps?: DarwinAmbientDeps): Promise<AmbientCapability> {
  return { supported: true, canRestore: true };
}

export async function getCurrentWallpaper(
  deps?: DarwinAmbientDeps,
): Promise<SavedWallpaper['value'] | null> {
  const exec = deps?.exec ?? defaultExec;
  try {
    const { stdout } = await exec(OSASCRIPT, ['-e', buildGetScript()], {
      timeout: EXEC_TIMEOUT_MS,
    });
    const value = stdout.trim();
    // `missing value` = the current wallpaper is an OS rotation or a
    // dynamic image with no single file path to restore to.
    if (!value || value === 'missing value') return null;
    return value;
  } catch {
    return null;
  }
}

export async function setWallpaper(imagePath: string, deps?: DarwinAmbientDeps): Promise<void> {
  const exec = deps?.exec ?? defaultExec;
  try {
    await exec(OSASCRIPT, ['-e', buildSetScript(imagePath)], { timeout: EXEC_TIMEOUT_MS });
  } catch (error) {
    if (isAutomationDenied(error)) throw new Error(AUTOMATION_HELP);
    throw error;
  }
}

export async function restoreWallpaper(
  saved: SavedWallpaper,
  deps?: DarwinAmbientDeps,
): Promise<void> {
  if (typeof saved.value !== 'string') return;
  await setWallpaper(saved.value, deps);
}
