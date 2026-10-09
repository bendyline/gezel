import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** The argument a login launch carries on Windows and Linux. */
export const HIDDEN_LAUNCH_ARG = '--hidden';

const LINUX_ENTRY_NAME = 'gezel.desktop';

interface LoginItemApp {
  getLoginItemSettings(opts?: { args?: string[] }): {
    openAtLogin: boolean;
    wasOpenedAtLogin?: boolean;
  };
  setLoginItemSettings(settings: { openAtLogin: boolean; args?: string[] }): void;
}

export interface StartAtLoginDeps {
  platform: NodeJS.Platform;
  app: LoginItemApp;
  /** The executable a login launch runs: the AppImage itself, when there is one. */
  execPath: string;
  /** `$XDG_CONFIG_HOME`, else `~/.config`. Linux only. */
  configDir: string;
}

/**
 * Start Gezel when the person logs in, with no window: the app stays in the
 * tray (the menu bar on macOS) so the daemon it owns keeps running, and the
 * night shift has a machine to run on. This is the app, not the daemon-only
 * autostart in Settings → Daemon, so notifications and keep-awake work too.
 *
 * macOS and Windows use the OS login-item list. Electron has none for Linux,
 * so there it is an XDG autostart entry.
 */
export async function setStartAtLogin(deps: StartAtLoginDeps, enabled: boolean): Promise<void> {
  if (deps.platform === 'linux') {
    const path = linuxEntryPath(deps);
    if (!enabled) {
      await rm(path, { force: true });
      return;
    }
    await mkdir(join(deps.configDir, 'autostart'), { recursive: true });
    await writeFile(path, linuxAutostartEntry(deps.execPath), 'utf8');
    return;
  }
  deps.app.setLoginItemSettings({
    openAtLogin: enabled,
    // Ignored on macOS, which reports a login launch itself.
    ...(deps.platform === 'win32' ? { args: [HIDDEN_LAUNCH_ARG] } : {}),
  });
}

export function getStartAtLogin(deps: StartAtLoginDeps): boolean {
  if (deps.platform === 'linux') return existsSync(linuxEntryPath(deps));
  return deps.app.getLoginItemSettings(
    deps.platform === 'win32' ? { args: [HIDDEN_LAUNCH_ARG] } : undefined,
  ).openAtLogin;
}

/** Whether this launch came from the login item, so no window should open. */
export function launchedAtLogin(
  deps: Pick<StartAtLoginDeps, 'platform' | 'app'>,
  argv: readonly string[],
): boolean {
  if (argv.includes(HIDDEN_LAUNCH_ARG)) return true;
  if (deps.platform !== 'darwin') return false;
  try {
    return deps.app.getLoginItemSettings().wasOpenedAtLogin === true;
  } catch {
    return false;
  }
}

function linuxEntryPath(deps: Pick<StartAtLoginDeps, 'configDir'>): string {
  return join(deps.configDir, 'autostart', LINUX_ENTRY_NAME);
}

/** A desktop entry `Exec` argument, quoted per the XDG desktop entry spec. */
function quoteExec(value: string): string {
  return `"${value.replace(/([\\"`$])/g, '\\$1')}"`;
}

export function linuxAutostartEntry(execPath: string): string {
  return `[Desktop Entry]
Type=Application
Name=Gezel
Comment=Start Gezel in the background
Exec=${quoteExec(execPath)} ${HIDDEN_LAUNCH_ARG}
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
}
