import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AmbientCapability, SavedWallpaper } from './index.js';

const defaultExec = promisify(execFile);

const EXEC_TIMEOUT_MS = 15_000;

/** Test seam: inject exec; production uses the real one. */
export interface Win32AmbientDeps {
  exec?: (
    command: string,
    args: readonly string[],
    opts?: { timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

/**
 * Same quoting rule as the service's local-harness `powershellLiteral`
 * (single quotes double inside single-quoted PS strings). Replicated
 * because the app must not import the service; parity is pinned by a
 * unit test.
 */
export function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function windowsPowerShellPath(): string {
  const root = process.env.SystemRoot?.trim();
  const rel = join('WindowsPowerShell', 'v1.0', 'powershell.exe');
  return root ? join(root, 'System32', rel) : 'powershell.exe';
}

/**
 * SPI_SETDESKWALLPAPER (20) with SPIF_UPDATEINIFILE | SPIF_SENDCHANGE
 * (3): the stable, per-user, no-admin path. Style registry values are
 * set first so the image renders Fill (10) instead of whatever the
 * previous wallpaper used. All monitors get the same image — SPI
 * semantics; per-monitor needs the IDesktopWallpaper COM API and is
 * deliberately out of scope.
 */
export function buildSetWallpaperPs(imagePath: string): string {
  return [
    `Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name WallpaperStyle -Value 10`,
    `Set-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name TileWallpaper -Value 0`,
    `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class GezelWallpaper { [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni); }'`,
    `$ok = [GezelWallpaper]::SystemParametersInfo(20, 0, ${powershellLiteral(imagePath)}, 3)`,
    `if ($ok -eq 0) { throw 'SystemParametersInfo failed to set the wallpaper.' }`,
  ].join('; ');
}

/** Registry read is more reliable than SPI_GET from a fresh process. */
export function buildGetWallpaperPs(): string {
  return `(Get-ItemProperty -Path 'HKCU:\\Control Panel\\Desktop' -Name WallPaper).WallPaper`;
}

async function runPs(script: string, deps?: Win32AmbientDeps): Promise<string> {
  const exec = deps?.exec ?? defaultExec;
  const { stdout } = await exec(
    windowsPowerShellPath(),
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: EXEC_TIMEOUT_MS },
  );
  return stdout;
}

export async function capability(_deps?: Win32AmbientDeps): Promise<AmbientCapability> {
  return { supported: true, canRestore: true };
}

export async function getCurrentWallpaper(
  deps?: Win32AmbientDeps,
): Promise<SavedWallpaper['value'] | null> {
  try {
    const value = (await runPs(buildGetWallpaperPs(), deps)).trim();
    return value || null;
  } catch {
    return null;
  }
}

export async function setWallpaper(imagePath: string, deps?: Win32AmbientDeps): Promise<void> {
  await runPs(buildSetWallpaperPs(imagePath), deps);
}

export async function restoreWallpaper(
  saved: SavedWallpaper,
  deps?: Win32AmbientDeps,
): Promise<void> {
  if (typeof saved.value !== 'string') return;
  await setWallpaper(saved.value, deps);
}
