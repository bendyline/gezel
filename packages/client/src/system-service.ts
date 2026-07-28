import { readFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';

/** Canonical port reserved for the machine-wide Gezel service. */
export const SYSTEM_SERVICE_PORT = 43935;

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
