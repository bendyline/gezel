import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isProcessAlive, readRuntime } from '@bendyline/gezel-client/node';
import { type HostingPin, readHostingPin } from './home-signals.js';
import { type MachineServiceState, queryMachineServiceState } from './service-registration.js';
import { readSystemServiceRuntime, systemServiceHome } from './system-service.js';
import type { SystemServiceRuntime } from './system-service.js';

export type Mode =
  | { kind: 'remote'; baseUrl: string; token: string; cert: string | null }
  | {
      kind: 'system-service';
      serviceHome: string;
      /**
       * Runtime files as of mode resolution — evidence, not the connection
       * contract. The connect path re-reads them (and re-reads while
       * waiting): the auth token rotates on every service start, so a
       * snapshot taken during startup can be one generation stale.
       */
      runtime: SystemServiceRuntime | null;
      /**
       * True when the service manager reports the service running or
       * starting — the connect path polls for healthy runtime metadata
       * instead of failing on the first read. This is what closes the
       * install-time race: the installer launches the app seconds after
       * enabling the service, 20-30s before the service publishes its
       * runtime files. Without the wait the supervisor spawned a second,
       * per-user daemon alongside the machine service.
       */
      waitForStartup: boolean;
      /** The user's hosting pin at resolution time (never `'per-user'` here). */
      hostingPin: Exclude<HostingPin, 'per-user'>;
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
  /** Test seam for the OS service-manager query. */
  queryMachineService?: () => Promise<MachineServiceState>;
  /** Test seam for runtime-file discovery. */
  readSystemRuntime?: (home: string) => Promise<SystemServiceRuntime | null>;
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

  // Branch 1.5: system service (the default packaged path on every
  // supported OS). Ask the OS service manager FIRST — it answers
  // "registered? running?" immediately and authoritatively, where the
  // runtime files only appear once the daemon has fully booted. Deciding
  // from the files alone is the race that produced two daemons on fresh
  // installs (installer enables the service, launches the app 4s later,
  // files appear 20-30s after that). Only enabled in packaged mode — in
  // dev we want fast-iteration embedded mode, not a stale background
  // service from a prior install.
  if (opts.packaged) {
    const sysHome = systemServiceHome();
    if (sysHome) {
      const pin = await readHostingPin(home);
      if (pin === 'per-user') {
        // The user (or a prior auto-decision, surfaced in Settings) chose
        // the per-user daemon. Skip the machine service entirely — no SCM
        // query, no wait.
        logger?.info?.('[supervisor] hosting pin=per-user — skipping the machine service');
      } else {
        const readRuntimeFiles = opts.readSystemRuntime ?? readSystemServiceRuntime;
        const registration = await (opts.queryMachineService ?? queryMachineServiceState)();
        const runtime = await readRuntimeFiles(sysHome);
        const startingOrUp =
          registration.status === 'running' || registration.status === 'start-pending';
        if (startingOrUp || (registration.status === 'unknown' && runtime)) {
          // `unknown` (SCM unqueryable) preserves the pre-SCM behavior:
          // files present → connect, single health check, no wait.
          logger?.info?.(
            `[supervisor] mode=system-service home=${sysHome} service=${registration.status}` +
              `${runtime ? ` port=${runtime.port}` : ' (runtime not published yet)'}`,
          );
          return {
            kind: 'system-service',
            serviceHome: sysHome,
            runtime,
            waitForStartup: startingOrUp,
            hostingPin: pin,
          };
        }
        if (runtime) {
          // Files without a live registration are leftovers — from an
          // uninstalled service or one the SCM has stopped. Connecting to
          // them health-fails into the embedded fallback; the per-user
          // paths below are the supported production answer.
          logger?.warn?.(
            `[supervisor] ignoring stale machine-service runtime files at ${sysHome} ` +
              `(service is ${registration.status}${registration.detail ? `: ${registration.detail}` : ''})`,
          );
        } else if (registration.status !== 'not-installed') {
          logger?.info?.(
            `[supervisor] machine service is ${registration.status}; using per-user paths`,
          );
        }
      }
    }
  }

  return resolvePerUserMode(opts);
}

/**
 * Branches 2/4/5/embedded — the per-user tail of the decision tree.
 * Exported separately so the connect path can re-enter it when a
 * machine-service connection is deliberately declined (fresh machine home,
 * established user home) without re-running the machine-service branch.
 */
export async function resolvePerUserMode(opts: ResolveModeOptions): Promise<Mode> {
  const { home, logger } = opts;

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
