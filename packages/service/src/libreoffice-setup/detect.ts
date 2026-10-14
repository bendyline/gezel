import { execFile } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
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

/** `VS_FIXEDFILEINFO.dwSignature` (0xFEEF04BD), as it sits in the file. */
const FIXED_FILE_INFO_SIGNATURE = Buffer.from([0xbd, 0x04, 0xef, 0xfe]);
const FIXED_FILE_INFO_STRUC_VERSION = 0x0001_0000;

/**
 * The product version a Windows executable declares in its version resource
 * (`26.8.1.1`), read from the file's `VS_FIXEDFILEINFO` block without running
 * it. Undefined when the file has no such block.
 */
export function windowsExecutableVersion(bytes: Buffer): string | undefined {
  let at = bytes.indexOf(FIXED_FILE_INFO_SIGNATURE);
  while (at >= 0 && at + 24 <= bytes.length) {
    if (bytes.readUInt32LE(at + 4) === FIXED_FILE_INFO_STRUC_VERSION) {
      const ms = bytes.readUInt32LE(at + 16);
      const ls = bytes.readUInt32LE(at + 20);
      return [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff].join('.');
    }
    at = bytes.indexOf(FIXED_FILE_INFO_SIGNATURE, at + 1);
  }
  return undefined;
}

/**
 * The installed LibreOffice's version, for display. Cached per binary.
 *
 * Windows reads it from `soffice.exe` instead of running it. There
 * `soffice.exe` is a windowed launcher: `--version` prints nothing to a
 * captured stdout, the timeout kills the launcher, and the `soffice.bin` it
 * started stays behind with no window, holding the LibreOffice profile.
 * Every daemon start left one, and the extension's install then refused with
 * "Close LibreOffice first" while no LibreOffice window was open
 * (2026-10-13). Elsewhere `soffice --version` prints `LibreOffice 25.8.1.1 …`
 * and exits.
 */
export function libreOfficeVersion(
  sofficePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  let cached = versionCache.get(sofficePath);
  if (!cached) {
    cached =
      platform === 'win32'
        ? readFile(sofficePath).then(windowsExecutableVersion, () => undefined)
        : new Promise((resolve) => {
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
