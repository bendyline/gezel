import { access, copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ExecFailure, type ExecFn, defaultExec, isProcessRunning, system32Tool } from './exec.js';

/**
 * Register gezel's add-in manifests with Word, Excel and PowerPoint for the
 * current user — Microsoft's documented per-user ("sideload") locations,
 * which need no store and no tenant:
 *
 *   Windows  HKCU\Software\Microsoft\Office\16.0\WEF\Developer
 *            one REG_SZ per manifest: name = add-in GUID, data = manifest path.
 *   macOS    a copy of the manifest in each app's sandbox container,
 *            ~/Library/Containers/com.microsoft.<App>/Data/Documents/wef/.
 *
 * Office reads both at launch, so a change shows after the app restarts.
 */

export type OfficeApp = 'word' | 'excel' | 'powerpoint';

export interface OfficeRegistration {
  app: OfficeApp;
  /** Add-in GUID from the manifest. */
  manifestId: string;
  manifestPath: string;
}

export interface OfficeRegisterDeps {
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  homedir?: string;
  env?: NodeJS.ProcessEnv;
}

export const WEF_DEVELOPER_KEY = 'HKCU\\Software\\Microsoft\\Office\\16.0\\WEF\\Developer';

const MAC_CONTAINERS: Record<OfficeApp, string> = {
  word: 'com.microsoft.Word',
  excel: 'com.microsoft.Excel',
  powerpoint: 'com.microsoft.Powerpoint',
};

const MAC_PROCESS_NAMES: Record<OfficeApp, string> = {
  word: 'Microsoft Word',
  excel: 'Microsoft Excel',
  powerpoint: 'Microsoft PowerPoint',
};

const WINDOWS_IMAGE_NAMES: Record<OfficeApp, string> = {
  word: 'WINWORD.EXE',
  excel: 'EXCEL.EXE',
  powerpoint: 'POWERPNT.EXE',
};

export const OFFICE_APP_NAMES: Record<OfficeApp, string> = {
  word: 'Word',
  excel: 'Excel',
  powerpoint: 'PowerPoint',
};

export function officeRegisterSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

export function macContainerDataDir(app: OfficeApp, home: string): string {
  return join(home, 'Library', 'Containers', MAC_CONTAINERS[app], 'Data');
}

export function macWefDir(app: OfficeApp, home: string): string {
  return join(macContainerDataDir(app, home), 'Documents', 'wef');
}

/** Named by GUID so a development home and an installed home never overwrite each other. */
export function macManifestCopyPath(app: OfficeApp, manifestId: string, home: string): string {
  return join(macWefDir(app, home), `gezel-${manifestId}.xml`);
}

export function buildRegAddArgs(manifestId: string, manifestPath: string): string[] {
  return ['add', WEF_DEVELOPER_KEY, '/v', manifestId, '/t', 'REG_SZ', '/d', manifestPath, '/f'];
}

export function buildRegDeleteArgs(manifestId: string): string[] {
  return ['delete', WEF_DEVELOPER_KEY, '/v', manifestId, '/f'];
}

export function buildRegQueryArgs(manifestId: string): string[] {
  return ['query', WEF_DEVELOPER_KEY, '/v', manifestId];
}

/** The REG_SZ data for `name` in `reg query` output, or null. */
export function parseRegQueryValue(stdout: string, name: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(.+?)\s{2,}REG_SZ\s{2,}(.*?)\s*$/.exec(line);
    if (m && m[1]!.toLowerCase() === name.toLowerCase()) return m[2]!;
  }
  return null;
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

export class OfficeRegisterError extends Error {
  constructor(
    message: string,
    readonly code: 'app-never-opened' | 'app-data-denied' | 'failed',
  ) {
    super(message);
    this.name = 'OfficeRegisterError';
  }
}

export async function registerOfficeAddin(
  reg: OfficeRegistration,
  deps: OfficeRegisterDeps = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    const exec = deps.exec ?? defaultExec;
    await exec(
      system32Tool('reg.exe', deps.env),
      buildRegAddArgs(reg.manifestId, reg.manifestPath),
    );
    return;
  }
  if (platform === 'darwin') {
    const home = deps.homedir ?? homedir();
    // Office creates its container on first launch. Creating one ourselves
    // would leave a container without the metadata macOS expects.
    if (!(await exists(macContainerDataDir(reg.app, home)))) {
      throw new OfficeRegisterError(
        `Open ${OFFICE_APP_NAMES[reg.app]} once, then try again.`,
        'app-never-opened',
      );
    }
    try {
      await mkdir(macWefDir(reg.app, home), { recursive: true });
      await copyFile(reg.manifestPath, macManifestCopyPath(reg.app, reg.manifestId, home));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') {
        throw new OfficeRegisterError(
          `macOS blocked Gezel from adding itself to ${OFFICE_APP_NAMES[reg.app]}. Allow Gezel to access data from other apps in System Settings > Privacy & Security, then try again.`,
          'app-data-denied',
        );
      }
      throw err;
    }
    return;
  }
  throw new Error(`Office add-ins are not supported on ${platform}.`);
}

export async function unregisterOfficeAddin(
  reg: Pick<OfficeRegistration, 'app' | 'manifestId'>,
  deps: OfficeRegisterDeps = {},
): Promise<void> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    const exec = deps.exec ?? defaultExec;
    await exec(system32Tool('reg.exe', deps.env), buildRegDeleteArgs(reg.manifestId)).catch(
      (err) => {
        // Absent already is the goal state.
        if (err instanceof ExecFailure && err.exitCode === 1) return;
        throw err;
      },
    );
    return;
  }
  if (platform === 'darwin') {
    await rm(macManifestCopyPath(reg.app, reg.manifestId, deps.homedir ?? homedir()), {
      force: true,
    });
  }
}

export async function isOfficeAddinRegistered(
  reg: OfficeRegistration,
  deps: OfficeRegisterDeps = {},
): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') {
    const exec = deps.exec ?? defaultExec;
    const { stdout } = await exec(
      system32Tool('reg.exe', deps.env),
      buildRegQueryArgs(reg.manifestId),
    ).catch(() => ({ stdout: '', stderr: '' }));
    const data = parseRegQueryValue(stdout, reg.manifestId);
    return data !== null && data.toLowerCase() === reg.manifestPath.toLowerCase();
  }
  if (platform === 'darwin') {
    const copy = macManifestCopyPath(reg.app, reg.manifestId, deps.homedir ?? homedir());
    const [installed, source] = await Promise.all([
      readFile(copy, 'utf8').catch(() => null),
      readFile(reg.manifestPath, 'utf8').catch(() => null),
    ]);
    return installed !== null && installed === source;
  }
  return false;
}

export async function isOfficeAppRunning(
  app: OfficeApp,
  deps: OfficeRegisterDeps = {},
): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const name = platform === 'win32' ? WINDOWS_IMAGE_NAMES[app] : MAC_PROCESS_NAMES[app];
  return isProcessRunning([name], { exec: deps.exec, platform });
}

/** Folders Office keeps add-in caches in; clearing them makes it re-read manifests. */
export function officeCacheDirs(deps: OfficeRegisterDeps = {}): string[] {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const home = deps.homedir ?? homedir();
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return [join(local, 'Microsoft', 'Office', '16.0', 'Wef')];
  }
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Containers', 'com.Microsoft.OsfWebHost', 'Data')];
  }
  return [];
}

/**
 * Clear Office's add-in cache. Refuses while Word, Excel or PowerPoint is
 * running, because Office holds those files open and rewrites them on exit.
 * On macOS this also drops the add-ins' web storage (the pane's saved
 * sign-in); the pane asks for a connection code again.
 */
export async function clearOfficeAddinCache(deps: OfficeRegisterDeps = {}): Promise<void> {
  for (const app of Object.keys(OFFICE_APP_NAMES) as OfficeApp[]) {
    if (await isOfficeAppRunning(app, deps)) {
      throw new Error(`Close ${OFFICE_APP_NAMES[app]} first, then clear the cache.`);
    }
  }
  for (const dir of officeCacheDirs(deps)) {
    await rm(dir, { recursive: true, force: true });
  }
}
