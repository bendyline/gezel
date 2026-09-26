import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OfficeApp } from '@bendyline/gezel';

/**
 * Best-effort "is Word / Excel / PowerPoint installed?" for the Settings
 * card. A miss only changes copy — setup still proceeds, because Office may
 * be installed somewhere this probe does not look.
 */

export interface OfficeDetection {
  hostSupported: boolean;
  apps: Record<OfficeApp, boolean>;
}

const MAC_BUNDLES: Record<OfficeApp, string> = {
  word: 'Microsoft Word.app',
  excel: 'Microsoft Excel.app',
  powerpoint: 'Microsoft PowerPoint.app',
};

const WINDOWS_EXES: Record<OfficeApp, string> = {
  word: 'WINWORD.EXE',
  excel: 'EXCEL.EXE',
  powerpoint: 'POWERPNT.EXE',
};

export type RegKeyExists = (key: string) => Promise<boolean>;

/** `reg.exe query <key> /ve`: exit 0 when the key exists. */
export const regKeyExists: RegKeyExists = (key) =>
  new Promise((resolve) => {
    execFile('reg.exe', ['query', key, '/ve'], { windowsHide: true, timeout: 5_000 }, (err) =>
      resolve(!err),
    );
  });

async function pathExists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

export async function detectOffice(
  opts: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    home?: string;
    exists?: (path: string) => Promise<boolean>;
    regKeyExists?: RegKeyExists;
  } = {},
): Promise<OfficeDetection> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? pathExists;
  const apps: Record<OfficeApp, boolean> = { word: false, excel: false, powerpoint: false };
  if (platform === 'darwin') {
    const home = opts.home ?? homedir();
    for (const app of Object.keys(MAC_BUNDLES) as OfficeApp[]) {
      apps[app] =
        (await exists(join('/Applications', MAC_BUNDLES[app]))) ||
        (await exists(join(home, 'Applications', MAC_BUNDLES[app])));
    }
    return { hostSupported: true, apps };
  }
  if (platform === 'win32') {
    const reg = opts.regKeyExists ?? regKeyExists;
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)']].filter(
      (r): r is string => typeof r === 'string' && r.length > 0,
    );
    for (const app of Object.keys(WINDOWS_EXES) as OfficeApp[]) {
      const exe = WINDOWS_EXES[app];
      const appPath = `SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`;
      let found = (await reg(`HKLM\\${appPath}`)) || (await reg(`HKCU\\${appPath}`));
      for (const root of roots) {
        if (found) break;
        found =
          (await exists(join(root, 'Microsoft Office', 'root', 'Office16', exe))) ||
          (await exists(join(root, 'Microsoft Office', 'Office16', exe)));
      }
      apps[app] = found;
    }
    return { hostSupported: true, apps };
  }
  return { hostSupported: false, apps };
}
