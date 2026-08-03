/**
 * Did the Windows installer manage to register GezelService?
 *
 * `customInstall` writes `MachineServiceInstalled` under
 * HKLM\Software\Bendyline\Gezel — 1 when the service registered, 0 when it hit
 * one of its `Goto SkipNssm` bail-outs and left the user on the per-user
 * daemon. The uninstaller deletes the key.
 *
 * The app needs this because that fallback is otherwise invisible. Per-user
 * spawn is a *supported* mode, so the supervisor emits no degraded-launch
 * report for it and Settings says "The background service is running
 * normally." True as far as it goes — a daemon is running — but the user
 * silently loses machine-wide background work, keeps paying first-launch
 * bundle extraction, and runs without the service's restricted SID and
 * private home. During a v1.26211.26 audit a machine sat in exactly that
 * state, and nothing in the product said so.
 *
 * It matters most on the path nobody watches: electron-updater runs the NSIS
 * installer with `/S`, and NSIS skips MessageBox entirely when silent. An
 * auto-update can therefore delete a working service, fail to replace it, and
 * show no dialog at all. This value is the only trace left.
 *
 * Registry rather than a marker file under the service home on purpose: the
 * failures worth recording are usually ACL or ownership problems in exactly
 * that directory, so it is the one place that cannot be trusted to accept the
 * write.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REGISTRY_KEY = 'HKLM\\Software\\Bendyline\\Gezel';
const REGISTRY_VALUE = 'MachineServiceInstalled';

/** Injectable so tests never touch the real registry. */
export type RegQuery = (key: string, value: string) => Promise<string>;

const defaultRegQuery: RegQuery = async (key, value) => {
  // `/reg:64` is explicit rather than incidental. The installer is a 32-bit
  // NSIS process and brackets its write with `SetRegView 64`, so the value
  // lives in the native view; a redirected read would silently find nothing
  // and we would report "installed" for a machine that has no service.
  // `windowsHide` is right HERE and nowhere in the daemon: this runs in the
  // Electron main process, an ordinary interactive session where
  // CREATE_NO_WINDOW just suppresses reg.exe's console flash. The daemon's
  // Session 0 has no console to hide — see windowsDetachedSpawnOptions.
  const { stdout } = await execFileAsync('reg.exe', ['query', key, '/v', value, '/reg:64'], {
    windowsHide: true,
  });
  return stdout;
};

/**
 * Parse `reg query` output for a REG_DWORD.
 *
 * Shape is `    MachineServiceInstalled    REG_DWORD    0x0`, with the radix
 * and column padding both varying by Windows build, so match on the type
 * token rather than position.
 */
export function parseRegDword(stdout: string, value: string): number | null {
  const line = stdout.split(/\r?\n/).find((l) => l.includes(value) && l.includes('REG_DWORD'));
  if (!line) return null;
  const hit = /REG_DWORD\s+(0x[0-9a-f]+|\d+)/i.exec(line);
  if (!hit) return null;
  const parsed = Number(hit[1]);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * True only when the installer positively recorded a failed registration.
 *
 * Deliberately not "true when the value is missing". A missing key is the
 * ordinary state for every install made before this breadcrumb existed, for
 * dev runs, and for non-Windows — reporting those as failures would put a
 * permanent, wrong notice in front of users we have no evidence about. Same
 * conservative stance `systemServiceVersionSkew` takes when bundle metadata
 * is unreadable: say nothing rather than guess.
 */
export async function machineServiceInstallFailed(
  options: { platform?: NodeJS.Platform; regQuery?: RegQuery } = {},
): Promise<boolean> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return false;
  const regQuery = options.regQuery ?? defaultRegQuery;
  try {
    // reg.exe exits non-zero when the key or value is absent, which promisified
    // execFile surfaces as a rejection — handled below as "no evidence".
    const stdout = await regQuery(REGISTRY_KEY, REGISTRY_VALUE);
    return parseRegDword(stdout, REGISTRY_VALUE) === 0;
  } catch {
    return false;
  }
}
