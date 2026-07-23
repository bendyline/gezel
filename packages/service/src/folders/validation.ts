import { access, mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, normalize, sep } from 'node:path';
import { type ExternalFolders, gezelHome } from '@bendyline/gezel/paths';
import type { FolderScope } from './scope.js';

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

const RESERVED_WIN_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

const SYSTEM_PATHS_DENY = [
  '/',
  '/etc',
  '/var',
  '/tmp',
  '/private',
  '/System',
  '/Library',
  '/Applications',
  '/bin',
  '/sbin',
  '/usr',
  '/dev',
  '/proc',
  '/sys',
  '/Users',
  '/home',
  'C:\\',
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\Users',
];

/**
 * Validate a destination path for an externalization move.
 *
 * Rules:
 *  - Must be absolute.
 *  - Must not be inside `~/.gezel/` (or whatever home resolves to).
 *  - Must not be a parent of `~/.gezel/`.
 *  - Must not equal or contain another externalized scope's path.
 *  - Must not be the user's home directory itself.
 *  - Must not be in the system-paths denylist.
 *  - Path segments must not be Windows reserved names (CON, PRN, …).
 *  - Must be writable (probe: mkdir + writeFile + unlink).
 *  - If the path exists, it must be a directory.
 */
export async function validateExternalPath(
  scope: FolderScope,
  destPath: string,
  current: ExternalFolders | undefined,
): Promise<ValidationResult> {
  if (!destPath || typeof destPath !== 'string') {
    return { ok: false, reason: 'destination path is required' };
  }
  if (!isAbsolute(destPath)) {
    return { ok: false, reason: 'destination path must be absolute' };
  }
  const dest = normalize(destPath);
  const home = gezelHome();

  if (pathEq(dest, normalize(home)) || pathStartsWithDir(dest, normalize(home))) {
    return {
      ok: false,
      reason: `destination is inside ${home} — pick a folder outside the gezel directory`,
    };
  }
  if (pathStartsWithDir(normalize(home), dest)) {
    return { ok: false, reason: `destination contains the gezel home directory ${home}` };
  }

  const userHome = normalize(homedir());
  if (pathEq(dest, userHome)) {
    return { ok: false, reason: 'cannot use the user home directory itself; pick a subfolder' };
  }

  for (const denied of SYSTEM_PATHS_DENY) {
    if (pathEq(dest, normalize(denied))) {
      return { ok: false, reason: `${denied} is a system path; pick a folder you own` };
    }
  }

  // Reserved Windows segment check
  for (const seg of dest.split(sep)) {
    const upper = seg.toUpperCase().replace(/\..+$/, '');
    if (RESERVED_WIN_NAMES.has(upper)) {
      return { ok: false, reason: `path segment "${seg}" is a reserved system name` };
    }
  }

  // Overlap with another externalized scope
  if (current) {
    for (const otherScope of ['documents', 'gezels', 'projects'] as const) {
      if (otherScope === scope) continue;
      const other = current[otherScope];
      if (!other) continue;
      const otherNorm = normalize(other);
      if (pathEq(dest, otherNorm)) {
        return {
          ok: false,
          reason: `already used as the external folder for ${otherScope}`,
        };
      }
      if (pathStartsWithDir(dest, otherNorm) || pathStartsWithDir(otherNorm, dest)) {
        return {
          ok: false,
          reason: `overlaps with the ${otherScope} external folder (${other})`,
        };
      }
    }
  }

  // Existence + writability probe
  try {
    const st = await stat(dest);
    if (!st.isDirectory()) {
      return { ok: false, reason: 'destination exists but is not a directory' };
    }
  } catch {
    // Doesn't exist — try to create it.
    try {
      await mkdir(dest, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        reason: `cannot create destination: ${(err as Error).message}`,
      };
    }
  }
  try {
    await access(dest);
    const probe = `${dest}${sep}.gezel-write-probe`;
    await writeFile(probe, '');
    await unlink(probe);
  } catch (err) {
    return { ok: false, reason: `not writable: ${(err as Error).message}` };
  }

  return { ok: true };
}

function pathEq(a: string, b: string): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

function pathStartsWithDir(candidate: string, base: string): boolean {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return candidate.toLowerCase().startsWith(base.toLowerCase() + sep.toLowerCase());
  }
  return candidate.startsWith(base + sep);
}
