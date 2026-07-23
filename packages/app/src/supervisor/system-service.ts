import { readFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';

/**
 * Platform-specific path where the system-installed gezeld writes its
 * runtime files (port + auth-token). Returns null on platforms where we
 * don't currently install a system service.
 *
 * The directory is set by the per-platform installer:
 *   Windows:  installer/nsis-hooks.nsh sets GEZEL_HOME=C:\ProgramData\Gezel
 *   macOS:    PKG postinstall sets it to /Library/Application Support/Gezel  (Pass 2.3)
 *   Linux:    .deb/.rpm postinst sets it to /var/lib/gezel  (Pass 2.4)
 *
 * Every packaged platform prefers this machine-wide daemon. Windows runs it
 * under a restricted service identity; the runtime file contains a scoped
 * first-party client credential, never the process-local root credential.
 */
export function systemServiceHome(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform === 'win32') {
    const base = env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData';
    // This helper is also exercised while cross-building/testing on POSIX.
    // node:path.join follows the host OS, not the requested target platform,
    // and would produce `D:\\MachineData/Gezel` on Linux/macOS.
    return win32.join(base, 'Gezel');
  }
  if (platform === 'darwin') {
    // The PKG postinstall sets up GEZEL_HOME=/Library/Application Support/Gezel
    // for the LaunchDaemon. Per-user Electron reads from the same path.
    return '/Library/Application Support/Gezel';
  }
  if (platform === 'linux') {
    // The .deb/.rpm afterInstall hook sets up GEZEL_HOME=/var/lib/gezel
    // for the systemd unit (see installer/gezeld.service).
    return '/var/lib/gezel';
  }
  return null;
}

export interface SystemServiceRuntime {
  port: number;
  token: string;
  baseUrl: string;
  /**
   * Loopback TLS cert PEM if the system service is on HTTPS, `null`
   * otherwise. Used by the supervisor to wire the renderer's verify
   * proc + the Node-side health-probe dispatcher.
   */
  cert: string | null;
  /** The system-scope GEZEL_HOME the service was launched with. */
  home: string;
}

/**
 * Read port + auth-token from the system-service home. Returns null when
 * either file is missing — the typical "service isn't installed" case.
 *
 * We deliberately do NOT read the pid file: the system service runs as
 * LocalService / _gezeld / gezel, and a normal user's `process.kill(pid, 0)`
 * check would fail on Unix even when the process is alive. The caller
 * should validate liveness by hitting `/api/health` instead.
 */
export async function readSystemServiceRuntime(home: string): Promise<SystemServiceRuntime | null> {
  try {
    const [portRaw, tokenRaw] = await Promise.all([
      readFile(join(home, 'runtime', 'port'), 'utf8'),
      readFile(join(home, 'runtime', 'auth-token'), 'utf8'),
    ]);
    const port = Number.parseInt(portRaw.trim(), 10);
    if (!Number.isFinite(port)) return null;
    const token = tokenRaw.trim();
    if (token.length === 0) return null;
    // Cert presence in the system-service runtime dir indicates HTTPS;
    // its absence means an older daemon or `GEZEL_INSECURE_TRANSPORT=1`
    // installed run. Mirror the per-user `discovery.ts` logic so both
    // adoption paths behave the same.
    let cert: string | null = null;
    try {
      cert = await readFile(join(home, 'runtime', 'cert.pem'), 'utf8');
    } catch {
      cert = null;
    }
    const scheme = cert ? 'https' : 'http';
    return {
      port,
      token,
      baseUrl: `${scheme}://127.0.0.1:${port}`,
      cert,
      home,
    };
  } catch {
    return null;
  }
}
