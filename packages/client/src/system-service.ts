import { readFile } from 'node:fs/promises';
import { join, posix, win32 } from 'node:path';

/** Canonical port reserved for the machine-wide Gezel service. */
export const SYSTEM_SERVICE_PORT = 6228;

/**
 * Platform-specific home used by the Electron-installed machine service.
 *
 * Only `runtime/` beneath this directory is readable by ordinary desktop
 * clients. The rest remains private to the restricted service identity.
 */
export function systemServiceHome(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform === 'win32') {
    const base = env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData';
    return win32.join(base, 'Gezel');
  }
  if (platform === 'darwin') return '/Library/Application Support/Gezel';
  if (platform === 'linux') return '/var/lib/gezel';
  return null;
}

/** Public, service-owned assets. This is not part of the daemon's private state API. */
export function systemSharedAssetsDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const home = systemServiceHome(platform, env);
  return home
    ? platform === 'win32'
      ? win32.join(home, 'assets')
      : posix.join(home, 'assets')
    : null;
}

/**
 * Conventional Electron payload locations used only as discovery hints.
 * Callers must fully verify a candidate before executing anything from it.
 */
export function electronNativeBinCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'win32') {
    const roots = [
      env.ProgramW6432,
      env.ProgramFiles,
      env.PROGRAMFILES,
      env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, 'Programs') : undefined,
    ].filter((value): value is string => !!value?.trim());
    return Array.from(
      new Set(
        roots.map((root) =>
          win32.join(root, 'Gezel', 'resources', 'app.asar.unpacked', 'native-bin'),
        ),
      ),
    );
  }
  if (platform === 'darwin') {
    return ['/Applications/Gezel.app/Contents/Resources/app.asar.unpacked/native-bin'];
  }
  if (platform === 'linux') {
    return [
      '/opt/Gezel/resources/app.asar.unpacked/native-bin',
      '/opt/gezel/resources/app.asar.unpacked/native-bin',
    ];
  }
  return [];
}

export interface SystemServiceEndpoint {
  port: number;
  baseUrl: string;
  /** Loopback TLS certificate PEM, or `null` for an explicitly insecure service. */
  cert: string | null;
  home: string;
}

export interface SystemServiceRuntime extends SystemServiceEndpoint {
  /**
   * Per-launch first-party desktop credential. The Electron supervisor needs
   * this; ordinary CLI connections deliberately use the revocable grant flow
   * instead of borrowing it.
   */
  token: string;
}

/**
 * Read only the public endpoint metadata needed to discover and authorize
 * against the machine service. No private service state is accessed.
 */
export async function readSystemServiceEndpoint(
  home: string | null = systemServiceHome(),
): Promise<SystemServiceEndpoint | null> {
  if (!home) return null;
  try {
    const portRaw = await readFile(join(home, 'runtime', 'port'), 'utf8');
    const port = Number.parseInt(portRaw.trim(), 10);
    if (!Number.isFinite(port) || port < 1 || port > 65_535) return null;
    let cert: string | null = null;
    try {
      cert = await readFile(join(home, 'runtime', 'cert.pem'), 'utf8');
    } catch {
      cert = null;
    }
    return {
      port,
      baseUrl: `${cert ? 'https' : 'http'}://127.0.0.1:${port}`,
      cert,
      home,
    };
  } catch {
    return null;
  }
}

/**
 * Electron's trusted supervisor path: endpoint metadata plus the scoped
 * desktop credential. Kept alongside endpoint discovery so the CLI and app
 * cannot drift on platform paths or TLS handling.
 */
export async function readSystemServiceRuntime(
  home: string | null = systemServiceHome(),
): Promise<SystemServiceRuntime | null> {
  const endpoint = await readSystemServiceEndpoint(home);
  if (!endpoint) return null;
  try {
    const token = (await readFile(join(endpoint.home, 'runtime', 'auth-token'), 'utf8')).trim();
    if (!token) return null;
    return { ...endpoint, token };
  } catch {
    return null;
  }
}
