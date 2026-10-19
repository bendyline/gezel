import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redirectAsarToUnpacked } from './extract-bundle.js';

/** Options forwarded to `startService` in the child. Must stay structured-clonable. */
export interface UtilityServiceStartOptions {
  uiDir?: string;
  home?: string;
  preferCanonicalPort?: boolean;
  role?: 'user' | 'machine-engine' | 'legacy-full';
  machineEngineDiscovery?: boolean;
}

export type UtilityParentMessage =
  | { type: 'preload'; serviceModuleUrl: string | null }
  | {
      type: 'start';
      serviceModuleUrl: string | null;
      options: UtilityServiceStartOptions;
      /** The environment the service must see: `env` set, `unset` removed. */
      env: Record<string, string>;
      unset: string[];
    }
  | { type: 'stop' };

export type UtilityChildMessage =
  | { type: 'preloaded'; importMs: number }
  | { type: 'ready'; port: number; token: string; cert: string | null; bootMs: number }
  | { type: 'restart-requested'; reason: string }
  | { type: 'start-failed'; message: string };

/** The subset of Electron's `UtilityProcess` this module drives, so tests can fake it. */
export interface UtilityChild {
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  postMessage(message: UtilityParentMessage): void;
  kill(): boolean;
  on(event: 'message', listener: (message: UtilityChildMessage) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
}

export type UtilityFork = (
  modulePath: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: 'pipe'; serviceName: string },
) => UtilityChild;

export interface UtilityHostedService {
  baseUrl: string;
  token: string;
  cert: string | null;
  pid: number | undefined;
  bootMs: number;
  /** Set when a prewarmed process was used: its import time, or null if the start had to wait for it. */
  prewarm: { importMs: number | null } | null;
  /** Ask the service to shut down, killing it if it does not exit in time. */
  stop: () => Promise<void>;
  /** End the process now: for a service that crashed or stopped answering. */
  kill: () => Promise<void>;
}

export interface StartUtilityHostedServiceOptions {
  /** Absolute path of the built utility-service-entry.js. */
  entryPath: string;
  /** File URL of the service's `dist/index.js`, or null to let the child resolve the workspace package. */
  serviceModuleUrl: string | null;
  startOptions: UtilityServiceStartOptions;
  env: NodeJS.ProcessEnv;
  /** The service asked for a restart (a settings change); the user decides when. */
  onRestartRequested?: (reason: string) => void;
  /** The ready service's process died without being asked to stop. */
  onUnexpectedExit?: (reason: string) => void;
  onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  fork?: UtilityFork;
  /** A child that already imported the service; used when it loaded the same module. */
  prewarmed?: PrewarmedUtilityService | null;
  /** Generous: a cold packaged boot imports a large tree before it can answer. */
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** How long a kill waits on SIGTERM before SIGKILL. */
  killGraceMs?: number;
  /** Test seam for the SIGKILL escalation. */
  forceKill?: (pid: number) => void;
}

/**
 * A utility process forked before the supervisor finished preparing, already
 * importing the service. Importing the tree is most of a service boot, and the
 * supervisor spends seconds verifying native binaries before it knows the
 * mode; doing both at once hides the cost of the separate process.
 */
export interface PrewarmedUtilityService {
  readonly serviceModuleUrl: string | null;
  /** Hand the child to a start, or null if it has died (the start then forks its own). */
  take(): { child: UtilityChild; forkEnv: NodeJS.ProcessEnv; importMs: number | null } | null;
  /** Kill the child unless a start took it. */
  dispose(): void;
}

export type ServiceHost = 'in-process' | 'utility';

/** `GEZEL_SERVICE_HOST=utility` opts into the utility-process host; anything else keeps the in-process service. */
export function serviceHostFromEnv(env: NodeJS.ProcessEnv = process.env): ServiceHost {
  return env.GEZEL_SERVICE_HOST === 'utility' ? 'utility' : 'in-process';
}

/**
 * The entry sits beside main.js in dist/, whichever module asks. Packaged, that
 * is inside app.asar; the entry ships unpacked (electron-builder.yml), so point
 * at the real file rather than lean on the forked process's asar support.
 */
export function defaultUtilityEntryPath(fromUrl: string): string {
  return redirectAsarToUnpacked(
    join(fileURLToPath(new URL('.', fromUrl)), 'utility-service-entry.js'),
  );
}

type ElectronModule = typeof import('electron');

function electronFork(): UtilityFork {
  const { utilityProcess } = createRequire(import.meta.url)('electron') as ElectronModule;
  return (modulePath, args, options) =>
    utilityProcess.fork(modulePath, args, options) as unknown as UtilityChild;
}

function childEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key !== 'ELECTRON_RUN_AS_NODE' && value !== undefined) out[key] = value;
  }
  return out;
}

function forkServiceChild(fork: UtilityFork, entryPath: string, env: Record<string, string>) {
  return fork(entryPath, [], { env, stdio: 'pipe', serviceName: 'Gezel Service' });
}

export function prewarmUtilityService(opts: {
  entryPath: string;
  serviceModuleUrl: string | null;
  env: NodeJS.ProcessEnv;
  fork?: UtilityFork;
}): PrewarmedUtilityService {
  const forkEnv = childEnv(opts.env);
  const child = forkServiceChild(opts.fork ?? electronFork(), opts.entryPath, forkEnv);
  let exited = false;
  let taken = false;
  let importMs: number | null = null;
  child.on('exit', () => {
    exited = true;
  });
  child.on('message', (message) => {
    if (message.type === 'preloaded') importMs = message.importMs;
  });
  child.postMessage({ type: 'preload', serviceModuleUrl: opts.serviceModuleUrl });
  return {
    serviceModuleUrl: opts.serviceModuleUrl,
    take() {
      if (exited || taken) return null;
      taken = true;
      return { child, forkEnv, importMs };
    },
    dispose() {
      if (!taken && !exited) child.kill();
    },
  };
}

export async function startUtilityHostedService(
  opts: StartUtilityHostedServiceOptions,
): Promise<UtilityHostedService> {
  const env = childEnv(opts.env);
  const warm =
    opts.prewarmed?.serviceModuleUrl === opts.serviceModuleUrl ? opts.prewarmed.take() : null;
  if (!warm) opts.prewarmed?.dispose();
  const child = warm?.child ?? forkServiceChild(opts.fork ?? electronFork(), opts.entryPath, env);
  // A prewarmed child was forked before the supervisor finished setting up the
  // environment, which also removes values it cannot vouch for (an inherited
  // GEZEL_NODE_PATH in packaged mode). Mirror both directions.
  const unset = warm ? Object.keys(warm.forkEnv).filter((key) => !(key in env)) : [];

  child.stdout?.on('data', (chunk: Buffer | string) => opts.onOutput?.(chunk.toString(), 'stdout'));
  child.stderr?.on('data', (chunk: Buffer | string) => opts.onOutput?.(chunk.toString(), 'stderr'));

  let ready = false;
  let stopRequested = false;
  let exited = false;
  const exitWaiters: Array<() => void> = [];

  const connection = await new Promise<Extract<UtilityChildMessage, { type: 'ready' }>>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(
          new Error(
            `service process did not become ready within ${opts.readyTimeoutMs ?? 120_000}ms`,
          ),
        );
      }, opts.readyTimeoutMs ?? 120_000);

      child.on('message', (message) => {
        if (message.type === 'ready' && !ready) {
          ready = true;
          clearTimeout(timer);
          resolve(message);
        } else if (message.type === 'start-failed') {
          clearTimeout(timer);
          reject(new Error(`service process failed to start: ${message.message}`));
        } else if (message.type === 'restart-requested') {
          opts.onRestartRequested?.(message.reason);
        }
      });

      child.on('exit', (code) => {
        exited = true;
        for (const wake of exitWaiters.splice(0)) wake();
        if (!ready) {
          clearTimeout(timer);
          reject(new Error(`service process exited with code ${code} before it was ready`));
        } else if (!stopRequested) {
          // Without this the app would keep a window pointed at a dead port:
          // the in-process service could never die alone, so nothing else
          // watches for it. Not a restart request: those wait for the user.
          opts.onUnexpectedExit?.(`service process exited unexpectedly (code ${code})`);
        }
      });

      child.postMessage({
        type: 'start',
        serviceModuleUrl: opts.serviceModuleUrl,
        options: opts.startOptions,
        env,
        unset,
      });
    },
  );

  const stop = async (): Promise<void> => {
    if (exited) return;
    stopRequested = true;
    const gone = new Promise<void>((resolve) => exitWaiters.push(resolve));
    child.postMessage({ type: 'stop' });
    const timedOut = await Promise.race([
      gone.then(() => false),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), opts.stopTimeoutMs ?? 30_000);
        void gone.then(() => clearTimeout(timer));
      }),
    ]);
    if (timedOut) await kill();
  };

  async function kill(): Promise<void> {
    if (exited) return;
    stopRequested = true;
    const gone = new Promise<void>((resolve) => exitWaiters.push(resolve));
    child.kill();
    // Electron's kill is SIGTERM, which a stopped or wedged process may never
    // act on; waiting on its exit alone left a restart hanging forever.
    let grace: ReturnType<typeof setTimeout> | undefined;
    const exitedInTime = await Promise.race([
      gone.then(() => true),
      new Promise<boolean>((resolve) => {
        grace = setTimeout(() => resolve(false), opts.killGraceMs ?? 2_000);
      }),
    ]);
    clearTimeout(grace);
    if (!exitedInTime && child.pid !== undefined) {
      try {
        (opts.forceKill ?? ((pid) => process.kill(pid, 'SIGKILL')))(child.pid);
      } catch {
        /* already gone */
      }
      await gone;
    }
  }

  const scheme = connection.cert ? 'https' : 'http';
  return {
    baseUrl: `${scheme}://127.0.0.1:${connection.port}`,
    token: connection.token,
    cert: connection.cert,
    pid: child.pid,
    bootMs: connection.bootMs,
    prewarm: warm ? { importMs: warm.importMs } : null,
    stop,
    kill,
  };
}
