import { startService as startInferenceService } from '@bendyline/gezel-inference';
import { gezelPaths } from '@bendyline/gezel/paths';
import { Hono } from 'hono';
import { type LoopbackCert, generateLoopbackCert } from './http/cert.js';
import { closeListener } from './http/close-listener.js';
import { hostGuard } from './http/host-guard.js';
import { bindMainListener } from './http/main-listener.js';
import { writeRuntime } from './runtime-discovery.js';
import type { ServiceServer, StartServiceOptions } from './service-options.js';

/** What `startService({ embeddedInferenceOnly: true })` returns. */
export interface RunningInferenceOnlyService {
  profile: 'embedded-inference';
  server: ServiceServer;
  port: number;
  /** The inference host's bearer credential, also written to `runtime/auth-token`. */
  clientToken: string;
  cert: LoopbackCert | null;
  webUiToken: null;
  /** Direct authenticated transport, for in-process embedders. */
  fetch: typeof fetch;
  stop: () => Promise<void>;
}

/**
 * The inference-only profile, owned by `@bendyline/gezel-inference`.
 *
 * The inference package serves the profile's routes and keeps its state; it
 * opens no listener, so an app hosting it in-process talks to it through
 * `fetch`. A `gezeld` child (and any caller of the service's own
 * `startService`) also needs the daemon's loopback contract, which only the
 * service has: the host guard, the TLS listener, and the runtime files
 * `discoverOrSpawn` reads. This wraps one in the other, so both host modes
 * serve the same surface.
 */
export async function startInferenceOnlyService(
  opts: StartServiceOptions & { home: string },
): Promise<RunningInferenceOnlyService> {
  const inference = await startInferenceService({
    home: opts.home,
    // startService has already routed records; a 'file' route writes through
    // a sink and leaves the streams on stderr.
    logOutput: opts.logOutput === 'split' ? 'split' : 'stderr',
    ...(opts.onUnexpectedHttpError ? { onUnexpectedHttpError: opts.onUnexpectedHttpError } : {}),
  });
  let server: ServiceServer | undefined;
  try {
    const cert = process.env.GEZEL_INSECURE_TRANSPORT === '1' ? null : await generateLoopbackCert();
    const app = new Hono();
    app.use('*', hostGuard());
    app.all('*', (c) => inference.fetch(c.req.raw));
    const bound = await bindMainListener(app.fetch, cert, opts);
    server = bound.server;
    await writeRuntime({
      paths: gezelPaths(opts.home),
      port: bound.port,
      token: inference.clientToken,
      pid: process.pid,
      cert,
      webUiToken: null,
      serviceRole: 'user',
    });
    const listener = bound.server;
    let stopping: Promise<void> | undefined;
    return {
      profile: 'embedded-inference',
      server: listener,
      port: bound.port,
      clientToken: inference.clientToken,
      cert,
      webUiToken: null,
      fetch: inference.fetch,
      stop: () => {
        // Inference first: it aborts in-flight requests, so open streams end
        // and the listener has nothing left to wait for.
        stopping ??= inference.stop().finally(() => closeListener(listener));
        return stopping;
      },
    };
  } catch (err) {
    if (server) await closeListener(server);
    await inference.stop().catch(() => {});
    throw err;
  }
}
