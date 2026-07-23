import { readFile } from 'node:fs/promises';
import { gezelPaths } from '@bendyline/gezel/paths';

export interface RuntimeInfo {
  port: number;
  token: string;
  pid: number;
  baseUrl: string;
  /**
   * PEM-encoded loopback TLS cert, when the daemon is serving HTTPS.
   * `null` if the daemon was started with `GEZEL_INSECURE_TRANSPORT=1`
   * or the cert file isn't present (older daemons, transitional state).
   * Callers building a fetch should pass this to `createTrustingFetch`.
   */
  cert: string | null;
}

/**
 * Read the daemon's runtime files from `~/.gezel/runtime/`. Returns null
 * if the daemon has never started — callers typically fall back to spawning
 * it on demand.
 *
 * The `cert` field is best-effort: callers that intend to speak HTTPS
 * should also check whether `baseUrl` reports `https://`. The URL scheme
 * is the source of truth for which transport the daemon is serving;
 * cert presence alone doesn't mean HTTPS is live (during the staged
 * rollout the daemon may write a cert file but still serve HTTP/1.1).
 */
export async function readRuntime(home?: string): Promise<RuntimeInfo | null> {
  const paths = gezelPaths(home);
  try {
    const [portRaw, tokenRaw, pidRaw] = await Promise.all([
      readFile(paths.runtime.port, 'utf8'),
      readFile(paths.runtime.token, 'utf8'),
      readFile(paths.runtime.pid, 'utf8'),
    ]);
    const port = Number.parseInt(portRaw.trim(), 10);
    const pid = Number.parseInt(pidRaw.trim(), 10);
    if (!Number.isFinite(port) || !Number.isFinite(pid)) return null;
    // Cert is best-effort — older daemons (and HTTPS-disabled runs) won't
    // have written one. Treat ENOENT as "no TLS"; any other read error
    // also degrades to no-TLS rather than failing discovery outright.
    let cert: string | null = null;
    try {
      cert = await readFile(paths.runtime.cert, 'utf8');
    } catch {
      cert = null;
    }
    // Cert presence is the truth of which transport the daemon is
    // actually serving. Plain HTTP fallback is opt-in via the operator
    // escape hatch (`GEZEL_INSECURE_TRANSPORT=1`); when no cert is
    // written we degrade gracefully so older daemons + the escape
    // hatch keep working.
    const scheme = cert ? 'https' : 'http';
    return {
      port,
      pid,
      token: tokenRaw.trim(),
      baseUrl: `${scheme}://127.0.0.1:${port}`,
      cert,
    };
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
