import { execFile } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

/**
 * Locate LibreOffice's `soffice` and `unopkg`. `unopkg` always sits beside
 * `soffice` in the program directory, so a found `soffice` implies where to
 * look for it.
 */

export interface LibreOfficeDetection {
  sofficePath?: string;
  unopkgPath?: string;
  version?: string;
}

async function exists(p: string): Promise<boolean> {
  return access(p).then(
    () => true,
    () => false,
  );
}

function programDirCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/LibreOffice.app/Contents/MacOS',
      join(env.HOME ?? '', 'Applications', 'LibreOffice.app', 'Contents', 'MacOS'),
    ];
  }
  if (platform === 'win32') {
    return [env.ProgramFiles, env['ProgramFiles(x86)']]
      .filter((r): r is string => typeof r === 'string' && r.length > 0)
      .map((root) => join(root, 'LibreOffice', 'program'));
  }
  return [
    '/usr/lib/libreoffice/program',
    '/usr/lib64/libreoffice/program',
    '/snap/libreoffice/current/lib/libreoffice/program',
  ];
}

async function optLibreOfficeDirs(): Promise<string[]> {
  const entries = await readdir('/opt').catch(() => [] as string[]);
  return entries
    .filter((e) => e.toLowerCase().startsWith('libreoffice'))
    .sort()
    .reverse()
    .map((e) => join('/opt', e, 'program'));
}

async function onPath(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

const versionCache = new Map<string, Promise<string | undefined>>();

/** `soffice --version` → `LibreOffice 25.8.1.1 …` → `25.8.1.1`. Cached per binary. */
export function libreOfficeVersion(sofficePath: string): Promise<string | undefined> {
  let cached = versionCache.get(sofficePath);
  if (!cached) {
    cached = new Promise((resolve) => {
      execFile(
        sofficePath,
        ['--version'],
        { windowsHide: true, timeout: 15_000 },
        (err, stdout) => {
          if (err) return resolve(undefined);
          resolve(/LibreOffice\s+([\d.]+)/.exec(String(stdout))?.[1]);
        },
      );
    });
    versionCache.set(sofficePath, cached);
  }
  return cached;
}

export async function detectLibreOffice(
  opts: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    probeVersion?: (soffice: string) => Promise<string | undefined>;
  } = {},
): Promise<LibreOfficeDetection> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const exe = (name: string) => (platform === 'win32' ? `${name}.exe` : name);
  const dirs = [...programDirCandidates(platform, env)];
  if (platform === 'linux') dirs.push(...(await optLibreOfficeDirs()));
  for (const dir of dirs) {
    const soffice = join(dir, exe('soffice'));
    if (!(await exists(soffice))) continue;
    const unopkg = join(dir, exe('unopkg'));
    const version = await (opts.probeVersion ?? libreOfficeVersion)(soffice);
    return {
      sofficePath: soffice,
      ...((await exists(unopkg)) ? { unopkgPath: unopkg } : {}),
      ...(version ? { version } : {}),
    };
  }
  // Distribution packages put launchers on PATH (`/usr/bin/soffice`, `/usr/bin/unopkg`).
  const soffice = (await onPath(exe('soffice'), env)) ?? (await onPath(exe('libreoffice'), env));
  const unopkg = await onPath(exe('unopkg'), env);
  if (!soffice && !unopkg) return {};
  const version = soffice ? await (opts.probeVersion ?? libreOfficeVersion)(soffice) : undefined;
  return {
    ...(soffice ? { sofficePath: soffice } : {}),
    ...(unopkg ? { unopkgPath: unopkg } : {}),
    ...(version ? { version } : {}),
  };
}
