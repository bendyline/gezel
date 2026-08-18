import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { AmbientCapability, SavedWallpaper } from './index.js';

const defaultExec = promisify(execFile);

const EXEC_TIMEOUT_MS = 10_000;

/** Test seam: inject exec + env; production uses the real ones. */
export interface LinuxAmbientDeps {
  exec?: (
    command: string,
    args: readonly string[],
    opts?: { timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
  env?: Record<string, string | undefined>;
}

export type LinuxDesktopFamily =
  | { kind: 'gsettings'; schema: string; desktop: string }
  | { kind: 'plasma'; desktop: string }
  | { kind: 'unknown'; desktop: string };

/**
 * Conservative detection off `XDG_CURRENT_DESKTOP` (colon-separated,
 * e.g. `ubuntu:GNOME`). Only families with a known, safe single-image
 * command are supported — never guess-execute on an unknown desktop.
 */
export function detectDesktop(env: Record<string, string | undefined>): LinuxDesktopFamily {
  const raw = env.XDG_CURRENT_DESKTOP ?? '';
  const parts = raw.split(':').map((p) => p.trim().toLowerCase());
  const desktop = raw || '(unset)';
  if (parts.includes('gnome') || parts.includes('unity') || parts.includes('pantheon')) {
    return { kind: 'gsettings', schema: 'org.gnome.desktop.background', desktop };
  }
  if (parts.includes('x-cinnamon') || parts.includes('cinnamon')) {
    return { kind: 'gsettings', schema: 'org.cinnamon.desktop.background', desktop };
  }
  if (parts.includes('kde')) return { kind: 'plasma', desktop };
  return { kind: 'unknown', desktop };
}

function isCommandMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

export async function capability(deps?: LinuxAmbientDeps): Promise<AmbientCapability> {
  const family = detectDesktop(deps?.env ?? process.env);
  if (family.kind === 'unknown') {
    return {
      supported: false,
      reason: 'unknown-desktop',
      desktop: family.desktop,
      canRestore: false,
    };
  }
  const exec = deps?.exec ?? defaultExec;
  const probe: [string, string[]] =
    family.kind === 'plasma'
      ? ['plasma-apply-wallpaperimage', ['--help']]
      : ['gsettings', ['help']];
  try {
    await exec(probe[0], probe[1], { timeout: EXEC_TIMEOUT_MS });
  } catch (error) {
    if (isCommandMissing(error)) {
      return {
        supported: false,
        reason: 'command-missing',
        desktop: family.desktop,
        canRestore: false,
      };
    }
    // Non-ENOENT probe failures (e.g. --help exit codes) still mean the
    // binary exists.
  }
  // plasma-apply-wallpaperimage has no read-back — restore is impossible.
  return { supported: true, desktop: family.desktop, canRestore: family.kind !== 'plasma' };
}

export async function getCurrentWallpaper(
  deps?: LinuxAmbientDeps,
): Promise<SavedWallpaper['value'] | null> {
  const family = detectDesktop(deps?.env ?? process.env);
  if (family.kind !== 'gsettings') return null;
  const exec = deps?.exec ?? defaultExec;
  try {
    const light = await exec('gsettings', ['get', family.schema, 'picture-uri'], {
      timeout: EXEC_TIMEOUT_MS,
    });
    const dark = await exec('gsettings', ['get', family.schema, 'picture-uri-dark'], {
      timeout: EXEC_TIMEOUT_MS,
    }).catch(() => null);
    const lightUri = unquoteGVariant(light.stdout);
    if (!lightUri) return null;
    const darkUri = dark ? unquoteGVariant(dark.stdout) : null;
    return { light: lightUri, dark: darkUri ?? lightUri };
  } catch {
    return null;
  }
}

export async function setWallpaper(imagePath: string, deps?: LinuxAmbientDeps): Promise<void> {
  const family = detectDesktop(deps?.env ?? process.env);
  const exec = deps?.exec ?? defaultExec;
  if (family.kind === 'plasma') {
    await exec('plasma-apply-wallpaperimage', [imagePath], { timeout: EXEC_TIMEOUT_MS });
    return;
  }
  if (family.kind !== 'gsettings') {
    throw new Error(`Wallpaper control is not supported on desktop "${family.desktop}"`);
  }
  const uri = pathToFileURL(imagePath).href;
  await exec('gsettings', ['set', family.schema, 'picture-uri', uri], {
    timeout: EXEC_TIMEOUT_MS,
  });
  await exec('gsettings', ['set', family.schema, 'picture-uri-dark', uri], {
    timeout: EXEC_TIMEOUT_MS,
  }).catch(() => undefined);
  await exec('gsettings', ['set', family.schema, 'picture-options', 'zoom'], {
    timeout: EXEC_TIMEOUT_MS,
  }).catch(() => undefined);
  // Best-effort lock-screen mirror on GNOME; absent schema is fine.
  if (family.schema === 'org.gnome.desktop.background') {
    await exec('gsettings', ['set', 'org.gnome.desktop.screensaver', 'picture-uri', uri], {
      timeout: EXEC_TIMEOUT_MS,
    }).catch(() => undefined);
  }
}

export async function restoreWallpaper(
  saved: SavedWallpaper,
  deps?: LinuxAmbientDeps,
): Promise<void> {
  const family = detectDesktop(deps?.env ?? process.env);
  if (family.kind !== 'gsettings' || typeof saved.value === 'string') return;
  const exec = deps?.exec ?? defaultExec;
  await exec('gsettings', ['set', family.schema, 'picture-uri', saved.value.light], {
    timeout: EXEC_TIMEOUT_MS,
  });
  await exec('gsettings', ['set', family.schema, 'picture-uri-dark', saved.value.dark], {
    timeout: EXEC_TIMEOUT_MS,
  }).catch(() => undefined);
}

/** `gsettings get` prints GVariant strings: `'file:///…'`. */
function unquoteGVariant(raw: string): string | null {
  const trimmed = raw.trim();
  const match = trimmed.match(/^'(.*)'$/);
  return match ? (match[1] ?? null) : trimmed || null;
}
