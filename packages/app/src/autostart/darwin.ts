import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { AutostartInstallOptions } from './index.js';

const defaultExec = promisify(execFile);

const LABEL = 'com.bendyline.gezel';

/**
 * Longer than launchd's 20s default ExitTimeOut, after which it SIGKILLs the
 * job itself, so an unload that is still pending at this deadline is stuck.
 */
const UNLOAD_WAIT_MS = 25_000;
const UNLOAD_POLL_MS = 250;

/** Test seam: inject exec + LaunchAgents dir + uid; production uses the real ones. */
export interface DarwinAutostartDeps {
  exec?: (command: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
  launchAgentsDir?: string;
  uid?: number;
  unloadWaitMs?: number;
  pollMs?: number;
}

function launchAgentsDir(deps?: DarwinAutostartDeps): string {
  return deps?.launchAgentsDir ?? join(homedir(), 'Library', 'LaunchAgents');
}

function plistPath(deps?: DarwinAutostartDeps): string {
  return join(launchAgentsDir(deps), `${LABEL}.plist`);
}

export function buildPlist(opts: AutostartInstallOptions): string {
  // Plain XML — no external dep needed. Escape user-supplied strings
  // defensively; `home` paths have historically contained apostrophes.
  const escapeXml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // KeepAlive restarts only an unsuccessful exit. A bare `true` also
  // relaunched a daemon that exited 0 because another daemon owned the home,
  // so for as long as the app's own daemon lived, launchd booted this one
  // every ten seconds to be refused again. SIGTERM shutdowns exit 0 too,
  // which lets `gezel stop` actually stop an autostarted daemon.
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
    <key>GEZEL_AUTOSTART</key>
    <string>1</string>
  </dict>
  <key>WorkingDirectory</key>
  <string>${escapeXml(opts.gezelHome)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(opts.gezelHome, 'logs', 'launchd-stdout.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(opts.gezelHome, 'logs', 'launchd-stderr.log'))}</string>
</dict>
</plist>
`;
}

function domain(deps?: DarwinAutostartDeps): string {
  // `launchctl` uses `gui/$UID` as the per-user domain. `process.getuid()`
  // is the right source on POSIX; Electron main always runs as the user.
  return `gui/${deps?.uid ?? process.getuid?.() ?? 0}`;
}

async function isLoaded(deps?: DarwinAutostartDeps): Promise<boolean> {
  const exec = deps?.exec ?? defaultExec;
  try {
    await exec('launchctl', ['print', `${domain(deps)}/${LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Unload the agent and wait until launchd has actually let it go. `bootout`
 * returns before the job has left the domain, and a `bootstrap` issued in that
 * window fails with "5: Input/output error" — the same race the PKG
 * postinstall polls around for the machine daemon.
 */
async function unloadAndWait(deps?: DarwinAutostartDeps): Promise<void> {
  const exec = deps?.exec ?? defaultExec;
  try {
    await exec('launchctl', ['bootout', `${domain(deps)}/${LABEL}`]);
  } catch {
    /* not loaded */
  }
  const deadline = Date.now() + (deps?.unloadWaitMs ?? UNLOAD_WAIT_MS);
  while (await isLoaded(deps)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `launchd did not unload ${LABEL} within ${deps?.unloadWaitMs ?? UNLOAD_WAIT_MS}ms`,
      );
    }
    await sleep(deps?.pollMs ?? UNLOAD_POLL_MS);
  }
}

async function load(deps?: DarwinAutostartDeps): Promise<void> {
  const exec = deps?.exec ?? defaultExec;
  await exec('launchctl', ['bootstrap', domain(deps), plistPath(deps)]);
}

export async function install(
  opts: AutostartInstallOptions,
  deps?: DarwinAutostartDeps,
): Promise<void> {
  await mkdir(launchAgentsDir(deps), { recursive: true });
  await writeFile(plistPath(deps), buildPlist(opts));
  await unloadAndWait(deps);
  await load(deps);
}

export async function uninstall(deps?: DarwinAutostartDeps): Promise<void> {
  try {
    await unloadAndWait(deps);
  } catch {
    /* best-effort */
  }
  if (existsSync(plistPath(deps))) await rm(plistPath(deps));
}

export async function isInstalled(deps?: DarwinAutostartDeps): Promise<boolean> {
  if (!existsSync(plistPath(deps))) return false;
  return isLoaded(deps);
}

/**
 * The `GEZEL_HOME` the registered plist serves, or null when no plist is
 * registered — whether or not launchd has it loaded right now.
 */
export async function registeredHome(deps?: DarwinAutostartDeps): Promise<string | null> {
  let plist: string;
  try {
    plist = await readFile(plistPath(deps), 'utf8');
  } catch {
    return null;
  }
  const match = /<key>GEZEL_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(plist);
  return match?.[1] === undefined ? null : unescapeXml(match[1]);
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** True when the registered plist is exactly what {@link install} would write. */
export async function isCurrent(
  opts: AutostartInstallOptions,
  deps?: DarwinAutostartDeps,
): Promise<boolean> {
  try {
    return (await readFile(plistPath(deps), 'utf8')) === buildPlist(opts);
  } catch {
    return false;
  }
}

/** Reload the agent, which RunAtLoad starts from the registered plist. */
export async function restart(deps?: DarwinAutostartDeps): Promise<void> {
  await unloadAndWait(deps);
  await load(deps);
}

/**
 * Stop the daemon until the next login. Unloading, rather than signalling the
 * process, is what keeps KeepAlive from relaunching it; the plist stays in
 * LaunchAgents, so the next login loads it again.
 */
export async function stop(deps?: DarwinAutostartDeps): Promise<void> {
  await unloadAndWait(deps);
}
