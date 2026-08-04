import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPatientFetch, createTrustingFetch } from './tls.js';
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

/**
 * Default fetch factory: returns the cert-trusting fetch when a cert
 * is available, the patient HTTP fetch otherwise. Apps can pass their
 * own via `opts.fetch` (tests use this to inject a stub).
 */
function defaultFetch(cert: string | null): typeof fetch {
  return cert ? createTrustingFetch({ cert }) : createPatientFetch();
}

export async function detectGezel(opts: DetectGezelOptions = {}): Promise<DetectResult> {
  const home = opts.home ?? process.env.GEZEL_HOME ?? join(homedir(), '.gezel');
  const runtime = await readRuntimeFiles(home);
  if (!runtime) {
    return { installed: false, running: false };
  }

  const f = opts.fetch ?? defaultFetch(runtime.cert);
  let running = false;
  let version: string | undefined;
  try {
    const res = await f(`${runtime.baseUrl}/api/health`);
    if (res.ok) {
      running = true;
      try {
        const body = (await res.json()) as { version?: string };
        if (body.version) version = body.version;
      } catch {
        /* no body — still alive */
      }
    }
  } catch {
    running = false;
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
): Promise<{ baseUrl: string; cert: string | null; fetch: typeof fetch } | null> {
  const resolvedHome = home ?? process.env.GEZEL_HOME ?? join(homedir(), '.gezel');
  const runtime = await readRuntimeFiles(resolvedHome);
  if (!runtime) return null;
  return {
    baseUrl: runtime.baseUrl,
    cert: runtime.cert,
    fetch: defaultFetch(runtime.cert),
  };
}
