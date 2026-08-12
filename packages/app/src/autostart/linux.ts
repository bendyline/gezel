import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AutostartInstallOptions } from './index.js';

const defaultExec = promisify(execFile);

/**
 * User-scope unit name. Deliberately NOT `gezeld.service`: the machine
 * installer owns system-scope `/etc/systemd/system/gezeld.service`, and a
 * user unit with the identical name made every unscoped `systemctl` mention
 * of "gezeld.service" ambiguous. The legacy name is still migrated/removed
 * below for installs that enabled autostart before the rename.
 */
const UNIT_NAME = 'gezeld-user.service';
const LEGACY_UNIT_NAME = 'gezeld.service';

/** Test seam: inject exec + config dir; production uses the real ones. */
export interface LinuxAutostartDeps {
  exec?: (command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
  configDir?: string;
}

function userUnitDir(deps?: LinuxAutostartDeps): string {
  return deps?.configDir ?? join(homedir(), '.config', 'systemd', 'user');
}

function unitPath(deps?: LinuxAutostartDeps): string {
  return join(userUnitDir(deps), UNIT_NAME);
}

function legacyUnitPath(deps?: LinuxAutostartDeps): string {
  return join(userUnitDir(deps), LEGACY_UNIT_NAME);
}

function quoteSystemd(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildUnit(opts: AutostartInstallOptions): string {
  // user-level unit — `systemctl --user`. No `After=network-online.target`
  // because user-level services start before that target.
  return `[Unit]
Description=Gezel service (user)
After=default.target

[Service]
Type=simple
ExecStart=${quoteSystemd(opts.nodePath)} ${quoteSystemd(opts.gezeldPath)}
Environment=${quoteSystemd(`GEZEL_HOME=${opts.gezelHome}`)}
Environment=${quoteSystemd(`GEZEL_NODE_PATH=${opts.nodePath}`)}
${opts.pnpmPath ? `Environment=${quoteSystemd(`GEZEL_PNPM_PATH=${opts.pnpmPath}`)}` : ''}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

export async function install(
  opts: AutostartInstallOptions,
  deps?: LinuxAutostartDeps,
): Promise<void> {
  const exec = deps?.exec ?? defaultExec;
  await mkdir(userUnitDir(deps), { recursive: true });
  await writeFile(unitPath(deps), buildUnit(opts));
  await exec('systemctl', ['--user', 'daemon-reload']);
  await exec('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
  // Migrate the pre-rename USER unit (never the system-scope unit of the
  // same legacy name) only after the replacement is enabled, so a failure
  // above can't leave the user with no autostart at all.
  if (existsSync(legacyUnitPath(deps))) {
    try {
      await exec('systemctl', ['--user', 'disable', '--now', LEGACY_UNIT_NAME]);
    } catch {
      /* not enabled */
    }
    await rm(legacyUnitPath(deps)).catch(() => undefined);
    try {
      await exec('systemctl', ['--user', 'daemon-reload']);
    } catch {
      /* best-effort */
    }
  }
}

export async function uninstall(deps?: LinuxAutostartDeps): Promise<void> {
  const exec = deps?.exec ?? defaultExec;
  // Remove BOTH names: users who enabled autostart before the rename and
  // toggle it off afterwards still carry the legacy user unit.
  for (const [name, path] of [
    [UNIT_NAME, unitPath(deps)],
    [LEGACY_UNIT_NAME, legacyUnitPath(deps)],
  ] as const) {
    try {
      await exec('systemctl', ['--user', 'disable', '--now', name]);
    } catch {
      /* not enabled */
    }
    if (existsSync(path)) await rm(path).catch(() => undefined);
  }
  try {
    await exec('systemctl', ['--user', 'daemon-reload']);
  } catch {
    /* best-effort */
  }
}

export async function isInstalled(deps?: LinuxAutostartDeps): Promise<boolean> {
  const exec = deps?.exec ?? defaultExec;
  // Either name counts so the Settings toggle stays truthful before the
  // migration in install() has run.
  for (const [name, path] of [
    [UNIT_NAME, unitPath(deps)],
    [LEGACY_UNIT_NAME, legacyUnitPath(deps)],
  ] as const) {
    if (!existsSync(path)) continue;
    try {
      await exec('systemctl', ['--user', 'is-enabled', name]);
      return true;
    } catch {
      /* fall through to the other name */
    }
  }
  return false;
}
