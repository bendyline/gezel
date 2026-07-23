import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AutostartInstallOptions } from './index.js';

const exec = promisify(execFile);

const UNIT_NAME = 'gezeld.service';

function unitPath(): string {
  return join(homedir(), '.config', 'systemd', 'user', UNIT_NAME);
}

function buildUnit(opts: AutostartInstallOptions): string {
  // user-level unit — `systemctl --user`. No `After=network-online.target`
  // because user-level services start before that target.
  return `[Unit]
Description=Gezel service (user)
After=default.target

[Service]
Type=simple
ExecStart=${opts.nodePath} ${opts.gezeldPath}
Environment=GEZEL_HOME=${opts.gezelHome}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
`;
}

export async function install(opts: AutostartInstallOptions): Promise<void> {
  await mkdir(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  await writeFile(unitPath(), buildUnit(opts));
  await exec('systemctl', ['--user', 'daemon-reload']);
  await exec('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
}

export async function uninstall(): Promise<void> {
  try {
    await exec('systemctl', ['--user', 'disable', '--now', UNIT_NAME]);
  } catch {
    /* not enabled */
  }
  if (existsSync(unitPath())) await rm(unitPath());
  try {
    await exec('systemctl', ['--user', 'daemon-reload']);
  } catch {
    /* best-effort */
  }
}

export async function isInstalled(): Promise<boolean> {
  if (!existsSync(unitPath())) return false;
  try {
    await exec('systemctl', ['--user', 'is-enabled', UNIT_NAME]);
    return true;
  } catch {
    return false;
  }
}
