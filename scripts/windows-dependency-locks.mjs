import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ELECTRON_LOCKED_ASSET = join('dist', 'resources', 'default_app.asar');

export function electronLockCandidates(repoRoot) {
  const virtualStore = join(repoRoot, 'node_modules', '.pnpm');
  if (!existsSync(virtualStore)) return [];

  return readdirSync(virtualStore, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('electron@'))
    .map((entry) =>
      join(virtualStore, entry.name, 'node_modules', 'electron', ELECTRON_LOCKED_ASSET),
    )
    .filter(existsSync);
}

function normalizeOwners(value, file) {
  const records = Array.isArray(value) ? value : value ? [value] : [];
  return records.map((owner) => ({
    file,
    processId: Number(owner.ProcessId),
    processName: owner.ProcessName || owner.AppName || 'unknown process',
    appName: owner.AppName || owner.ProcessName || 'unknown application',
  }));
}

/**
 * Ask Windows Restart Manager who holds Electron's lock-sensitive ASAR open.
 * A failed diagnostic never blocks the install; pnpm remains the authority.
 */
export function inspectWindowsDependencyLocks(repoRoot, options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') return [];

  const probeScript = join(repoRoot, 'scripts', 'find-windows-file-locks.ps1');
  if (!existsSync(probeScript)) return [];

  const spawnSyncFn = options.spawnSyncFn ?? spawnSync;
  const owners = [];
  for (const file of electronLockCandidates(repoRoot)) {
    const result = spawnSyncFn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        probeScript,
        '-Path',
        file,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.status !== 0 || !result.stdout?.trim()) continue;
    try {
      owners.push(...normalizeOwners(JSON.parse(result.stdout), file));
    } catch {
      // Diagnostic output must never make an otherwise valid install fail.
    }
  }
  return owners;
}
