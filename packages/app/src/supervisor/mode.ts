import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isProcessAlive, readRuntime } from '@bendyline/gezel-client/node';
import { readSystemServiceRuntime, systemServiceHome } from './system-service.js';

export type Mode =
  | { kind: 'remote'; baseUrl: string; token: string; cert: string | null }
  | {
      kind: 'system-service';
      baseUrl: string;
      token: string;
      cert: string | null;
      serviceHome: string;
    }
  | { kind: 'local-adopt'; baseUrl: string; token: string; cert: string | null; pid: number }
  | { kind: 'local-spawn-packaged' }
  | { kind: 'local-spawn-dev' }
  | { kind: 'embedded' };

export interface ResolveModeOptions {
  home: string;
  /** `app.isPackaged` — informational for branch selection in later chunks. */
  packaged: boolean;
  /** When true, dev mode opts into spawn. Ignored in chunk 2 (spawn lands later). */
  devSpawn: boolean;
  /** Forces embedded regardless of everything else. */
  forceEmbedded: boolean;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void };
}

/**
 * Resolve which mode the supervisor should run in. Ordered per the plan's
 * decision tree. In chunk 2, spawn branches (4 and 5) aren't implemented —
 * everything that isn't remote, adopt, or embedded falls through to embedded
 * so today's `pnpm app` behavior is preserved bit-for-bit.
 */
export async function resolveMode(opts: ResolveModeOptions): Promise<Mode> {
  const { home, forceEmbedded, logger } = opts;

  // Branch 3 pre-empt: explicit embedded override wins. Matches
  // `GEZEL_EMBEDDED=1` and the dev-mode default.
  if (forceEmbedded) {
    logger?.info?.('[supervisor] mode=embedded (forced)');
    return { kind: 'embedded' };
  }

  // Branch 1: user-configured remote service.
  const remote = await readRemoteConfig(home);
  if (remote) {
    logger?.info?.(`[supervisor] mode=remote url=${remote.baseUrl}`);
    // Remote daemons are user-managed — they bring their own TLS chain
    // (or none). We never ship a cert pin for a URL we didn't generate.
    return { kind: 'remote', ...remote, cert: null };
  }

  // Branch 1.5: system service (Windows installer registers GezelService;
  // macOS/Linux land in later Pass 2 chunks). Probe the platform-scope
  // runtime dir; if found, we connect to that service rather than spawning
  // our own. Only enabled in packaged mode — in dev we want fast-iteration
  // embedded mode, not a stale background service from a prior install.
  if (opts.packaged) {
    const sysHome = systemServiceHome();
    if (sysHome) {
      const sys = await readSystemServiceRuntime(sysHome);
      if (sys) {
        logger?.info?.(`[supervisor] mode=system-service home=${sys.home} port=${sys.port}`);
        return {
          kind: 'system-service',
          baseUrl: sys.baseUrl,
          token: sys.token,
          cert: sys.cert,
          serviceHome: sys.home,
        };
      }
    }
  }

  // Branch 2: live local daemon we can adopt.
  const runtime = await readRuntime(home);
  if (runtime && isProcessAlive(runtime.pid)) {
    logger?.info?.(`[supervisor] mode=local-adopt pid=${runtime.pid} port=${runtime.port}`);
    return {
      kind: 'local-adopt',
      baseUrl: runtime.baseUrl,
      token: runtime.token,
      cert: runtime.cert,
      pid: runtime.pid,
    };
  }

  // Branch 4: packaged mode always spawns out-of-process (after extracting
  // the shipped bundle if needed). Embedded stays available via the
  // `GEZEL_EMBEDDED=1` env flag handled above.
  if (opts.packaged) {
    logger?.info?.('[supervisor] mode=local-spawn-packaged');
    return { kind: 'local-spawn-packaged' };
  }

  // Branch 5: dev-mode opt-in spawn.
  if (opts.devSpawn) {
    logger?.info?.('[supervisor] mode=local-spawn-dev (GEZEL_SPAWN=1)');
    return { kind: 'local-spawn-dev' };
  }

  logger?.info?.('[supervisor] mode=embedded (default fallback)');
  return { kind: 'embedded' };
}

/**
 * Bare-JSON read of the remote-service config from `~/.gezel/config.json`.
 * This runs before the `Store` exists, so we don't go through the normal
 * Zod-validated read path — we just pull the one field we need and fall
 * through silently on any I/O or shape error.
 */
async function readRemoteConfig(home: string): Promise<{ baseUrl: string; token: string } | null> {
  try {
    const raw = await readFile(join(home, 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as { service?: { url?: unknown; token?: unknown } };
    const url = parsed.service?.url;
    const token = parsed.service?.token;
    if (typeof url !== 'string' || typeof token !== 'string') return null;
    if (url.trim() === '' || token.trim() === '') return null;
    return { baseUrl: url.replace(/\/+$/, ''), token };
  } catch {
    return null;
  }
}
