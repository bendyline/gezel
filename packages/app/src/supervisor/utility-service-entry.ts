/**
 * Entry point for the service when the supervisor hosts it in an Electron
 * utility process (`GEZEL_SERVICE_HOST=utility`) instead of in the main
 * process.
 *
 * Electron's main process is Chromium's browser process: the same thread runs
 * the OS window, input routing, menus, the tray and every `ipcMain` handler.
 * An in-process service therefore freezes the window whenever it blocks or
 * collects garbage, and a native crash in it takes the whole app down. Here
 * the service gets its own process and V8 heap, still inside the app bundle,
 * so store builds can use it without spawning a separate Node binary.
 *
 * The protocol is deliberately tiny and mirrors what `startEmbeddedRaw`
 * returns: an optional early `preload` (import the tree while the supervisor
 * prepares), one `start` carrying the final environment, one `ready` carrying
 * the connection, a `stop`, and the service's own restart requests. See
 * utility-host.ts for the parent side.
 */
import type { UtilityChildMessage, UtilityParentMessage } from './utility-host.js';

type ServiceModule = {
  startService: (o?: Record<string, unknown>) => Promise<{
    port: number;
    context: { token: string };
    clientToken?: string;
    cert: { certPem: string } | null;
    stop: () => Promise<void>;
  }>;
};

const parent = process.parentPort;

function send(message: UtilityChildMessage): void {
  parent.postMessage(message);
}

let stopService: (() => Promise<void>) | null = null;
let stopping = false;
let preloaded: { url: string | null; module: Promise<ServiceModule> } | null = null;

parent.on('message', (event) => {
  const message = event.data as UtilityParentMessage;
  if (message.type === 'preload') preload(message.serviceModuleUrl);
  else if (message.type === 'start') void start(message);
  else if (message.type === 'stop') void stop();
});

// The dev fallback resolves the workspace package from packages/app's
// node_modules, exactly as the in-process import does; packaged builds
// hand over the file URL of the adopted or extracted service tree.
function importService(url: string | null): Promise<ServiceModule> {
  return import(url ?? '@bendyline/gezel-service') as Promise<ServiceModule>;
}

function preload(url: string | null): void {
  const startedAt = performance.now();
  const module = importService(url);
  preloaded = { url, module };
  // A failed preload is retried by `start`, which reports it if it fails again.
  module.then(
    () => send({ type: 'preloaded', importMs: Math.round(performance.now() - startedAt) }),
    () => {},
  );
}

/** Mirror the environment the supervisor finished preparing after this process forked. */
function adoptEnvironment(env: Record<string, string>, unset: string[]): void {
  for (const key of unset) delete process.env[key];
  Object.assign(process.env, env);
}

async function start(message: Extract<UtilityParentMessage, { type: 'start' }>): Promise<void> {
  const startedAt = performance.now();
  try {
    adoptEnvironment(message.env, message.unset);
    const url = message.serviceModuleUrl;
    const warm = preloaded?.url === url ? preloaded.module : null;
    const mod = warm ? await warm.catch(() => importService(url)) : await importService(url);
    const running = await mod.startService({
      ...message.options,
      onRestartRequested: (reason: string) => send({ type: 'restart-requested', reason }),
    });
    stopService = () => running.stop();
    send({
      type: 'ready',
      port: running.port,
      token: running.clientToken ?? running.context.token,
      cert: running.cert?.certPem ?? null,
      bootMs: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    send({
      type: 'start-failed',
      message: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    process.exit(1);
  }
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    await stopService?.();
  } finally {
    process.exit(0);
  }
}
