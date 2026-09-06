import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { requestDaemonHealth } from '@bendyline/gezel-client/node';
import { type SdkTransport, createSdkTransport } from './tls.js';
import type { DetectResult } from './types.js';

/**
 * Locate gezel's runtime files on disk and probe whether the daemon
 * is currently running. Used as the bootstrap of `connect()` and as
 * a standalone "is gezel installed?" check.
 *
 * `GEZEL_HOME` overrides the default `~/.gezel` for testing and for
 * users who relocated the gezel home.
 */
export interface DetectGezelOptions {
  home?: string;
  /** Override the fetch used for the health probe (tests inject). */
  fetch?: typeof fetch;
  /** Health headers + body budget in awake milliseconds. Defaults to 5,000. */
  timeoutMs?: number;
}

interface RuntimeFiles {
  baseUrl: string;
  cert: string | null;
}

async function readRuntimeFiles(home: string): Promise<RuntimeFiles | null> {
  const runtimeDir = join(home, 'runtime');
  try {
    const portRaw = await readFile(join(runtimeDir, 'port'), 'utf8');
    const port = Number.parseInt(portRaw.trim(), 10);
    if (!Number.isFinite(port)) return null;
    let cert: string | null = null;
    try {
      cert = await readFile(join(runtimeDir, 'cert.pem'), 'utf8');
    } catch {
      cert = null;
    }
    const scheme = cert ? 'https' : 'http';
    return {
      baseUrl: `${scheme}://127.0.0.1:${port}`,
      cert,
    };
  } catch {
    return null;
  }
}

export async function detectGezel(opts: DetectGezelOptions = {}): Promise<DetectResult> {
  const home = opts.home ?? process.env.GEZEL_HOME ?? join(homedir(), '.gezel');
  const runtime = await readRuntimeFiles(home);
  if (!runtime) {
    return { installed: false, running: false };
  }

  const transport = createSdkTransport(runtime.cert, opts.fetch);
  let running = false;
  let failed = false;
  let version: string | undefined;
  try {
    const res = await requestDaemonHealth(runtime.baseUrl, {
      fetch: transport.fetch,
      timeoutMs: opts.timeoutMs,
    });
    if (res.ok) {
      running = true;
      if (
        res.body &&
        typeof res.body === 'object' &&
        'version' in res.body &&
        typeof res.body.version === 'string'
      )
        version = res.body.version;
    }
  } catch {
    running = false;
    failed = true;
  } finally {
    if (failed && transport.destroy) await transport.destroy();
    else await transport.close?.();
  }

  return {
    installed: true,
    running,
    baseUrl: runtime.baseUrl,
    ...(version ? { version } : {}),
  };
}

/**
 * Used internally by `connect()` to grab the cert and build a fetch
 * without re-running the health probe. Returns the cert + the
 * resolved fetch.
 */
export async function readRuntimeForConnect(
  home?: string,
  fetchOverride?: typeof fetch,
): Promise<({ baseUrl: string; cert: string | null } & SdkTransport) | null> {
  const resolvedHome = home ?? process.env.GEZEL_HOME ?? join(homedir(), '.gezel');
  const runtime = await readRuntimeFiles(resolvedHome);
  if (!runtime) return null;
  return {
    baseUrl: runtime.baseUrl,
    cert: runtime.cert,
    ...createSdkTransport(runtime.cert, fetchOverride),
  };
}
