import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AutostartInstallOptions } from './index.js';

const exec = promisify(execFile);

const LABEL = 'com.bendyline.gezel';

function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

export function buildPlist(opts: AutostartInstallOptions): string {
  // Plain XML — no external dep needed. Escape user-supplied strings
  // defensively; `home` paths have historically contained apostrophes.
  const escapeXml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(opts.nodePath)}</string>
    <string>${escapeXml(opts.gezeldPath)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>GEZEL_HOME</key>
    <string>${escapeXml(opts.gezelHome)}</string>
    <key>GEZEL_NODE_PATH</key>
    <string>${escapeXml(opts.nodePath)}</string>
    ${
      opts.pnpmPath
        ? `<key>GEZEL_PNPM_PATH</key>
    <string>${escapeXml(opts.pnpmPath)}</string>`
        : ''
    }
  </dict>
  <key>WorkingDirectory</key>
  <string>${escapeXml(opts.gezelHome)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(opts.gezelHome, 'logs', 'launchd-stdout.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(opts.gezelHome, 'logs', 'launchd-stderr.log'))}</string>
</dict>
</plist>
`;
}

async function launchctlDomain(): Promise<string> {
  // `launchctl` uses `gui/$UID` as the per-user domain. `process.getuid()`
  // is the right source on POSIX; Electron main always runs as the user.
  const uid = process.getuid?.() ?? 0;
  return `gui/${uid}`;
}

export async function install(opts: AutostartInstallOptions): Promise<void> {
  const p = plistPath();
  await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  await writeFile(p, buildPlist(opts));
  // `bootout` may fail if not already bootstrapped — ignore errors.
  const domain = await launchctlDomain();
  try {
    await exec('launchctl', ['bootout', `${domain}/${LABEL}`]);
  } catch {
    /* not loaded yet */
  }
  await exec('launchctl', ['bootstrap', domain, p]);
}

export async function uninstall(): Promise<void> {
  const p = plistPath();
  const domain = await launchctlDomain();
  try {
    await exec('launchctl', ['bootout', `${domain}/${LABEL}`]);
  } catch {
    /* best-effort */
  }
  if (existsSync(p)) await rm(p);
}

export async function isInstalled(): Promise<boolean> {
  if (!existsSync(plistPath())) return false;
  const domain = await launchctlDomain();
  try {
    await exec('launchctl', ['print', `${domain}/${LABEL}`]);
    return true;
  } catch {
    return false;
  }
}
