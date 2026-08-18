import { type Logger, createLogger } from '@bendyline/gezel';
import { type ServerType, serve } from '@hono/node-server';
import type { Hono, MiddlewareHandler } from 'hono';
import { bearerAuth, requireScope } from './auth.js';
import type { ServiceContext } from './context.js';
import { openAiErrorEnvelope } from './openai-compat/error-envelope.js';
import { requireOpenAiEndpointsEnabled } from './openai-endpoints-gate.js';

/** The fetch handler shape `@hono/node-server` binds a listener to. */
export type LocalBridgeFetch = Parameters<typeof serve>[0]['fetch'];
type ServeFetch = LocalBridgeFetch;

/**
 * Shared machinery for Gezel's fixed-address loopback inference bridges.
 *
 * Every bridge exists for the same reason: an external agent harness cannot
 * pin the product daemon's per-launch self-signed certificate, and the daemon
 * port itself rotates. A bridge answers plain HTTP on a stable loopback
 * address while keeping bearer authentication mandatory, and mounts inference
 * routes only — `/api/*`, app grants, chat sessions, and files are absent by
 * construction rather than by filtering.
 *
 * Integration-specific route sets live in the per-integration modules
 * ({@link ./codex-bridge.js}, {@link ./opencode-bridge.js}); this file owns
 * the listener lifecycle and the response hardening they share.
 */

export interface LocalBridgeStatus {
  listening: boolean;
  port?: number;
}

export interface LocalBridgeController {
  status(): LocalBridgeStatus;
  /** Exact configured port (`0` only for callers deliberately requesting an ephemeral test port). */
  desiredPort(): number;
  /** Stable HTTP origin, or `null` before an ephemeral (`port: 0`) listener has bound. */
  baseUrl(): string | null;
  /** Bind the configured port exactly. Idempotent while already listening. */
  start(): Promise<LocalBridgeStatus>;
  /** Stop the listener. Idempotent when already stopped. */
  stop(): Promise<void>;
}

export interface LocalBridgeIdentity {
  /** Log prefix and the noun used in port-conflict messages, e.g. `Codex`. */
  label: string;
  /** Logger channel, e.g. `codex-bridge`. */
  channel: string;
  /** Header stamped on every response so a port probe can recognize our own listener. */
  markerHeader: string;
}

/**
 * Stamp the hardening headers and ownership marker every bridge response
 * carries — including auth failures and 404s. Hop-by-hop headers that Hono's
 * streaming helpers may add are stripped; Node owns those on an HTTP/1.1
 * listener.
 */
export function localBridgeHardening(identity: LocalBridgeIdentity): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.res.headers.delete('connection');
    c.res.headers.delete('keep-alive');
    c.res.headers.delete('upgrade');
    c.res.headers.delete('proxy-connection');
    c.res.headers.delete('transfer-encoding');
    c.res.headers.set('x-content-type-options', 'nosniff');
    c.res.headers.set('referrer-policy', 'no-referrer');
    c.res.headers.set('x-frame-options', 'DENY');
    c.res.headers.set(identity.markerHeader, '1');
  };
}

/**
 * Own the fixed-address loopback listener an integration's managed config
 * points at. Integration/config code decides when to start it and supplies the
 * app's fetch handler; this module deliberately does not mutate settings or
 * files.
 */
export function createLocalBridgeController(opts: {
  identity: LocalBridgeIdentity;
  fetch: () => ServeFetch;
  /** Exact loopback port. `0` is a test seam for an ephemeral bind. */
  port: number;
}): LocalBridgeController {
  const { identity } = opts;
  const log = createLogger(identity.channel);
  const desiredPort = opts.port;
  if (!Number.isInteger(desiredPort) || desiredPort < 0 || desiredPort > 65_535) {
    throw new Error(`Invalid ${identity.label} bridge port: ${desiredPort}`);
  }

  let server: ServerType | null = null;
  let current: LocalBridgeStatus = { listening: false };

  const stop = async (): Promise<void> => {
    const active = server;
    server = null;
    current = { listening: false };
    if (!active) return;
    await closeServer(active);
  };

  return {
    status: () => ({ ...current }),
    desiredPort: () => desiredPort,
    baseUrl: () => {
      const port = current.port ?? (desiredPort === 0 ? null : desiredPort);
      return port === null ? null : `http://127.0.0.1:${port}`;
    },

    async start() {
      if (server && current.listening) return { ...current };

      let bound: { server: ServerType; port: number };
      try {
        bound = await startServer({ port: desiredPort, fetch: opts.fetch(), log });
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE') {
          throw new Error(await describePortConflict(desiredPort, identity));
        }
        throw error;
      }

      server = bound.server;
      current = { listening: true, port: bound.port };
      const ownedServer = bound.server;
      ownedServer.once('close', () => {
        if (server !== ownedServer) return;
        server = null;
        current = { listening: false };
      });
      log.info(`[${identity.channel}] authenticated loopback listener on 127.0.0.1:${bound.port}`);
      return { ...current };
    },

    stop,
  };
}

async function describePortConflict(port: number, identity: LocalBridgeIdentity): Promise<string> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(750),
    });
    if (response.headers.get(identity.markerHeader) === '1') {
      return `Port ${port} is already in use by another Gezel ${identity.label} bridge. Stop the other Gezel service, then retry ${identity.label} setup.`;
    }
  } catch {
    // A raw/non-HTTP listener is still a conflict; use the generic message.
  }
  return `Port ${port} is already in use by another process, so the Gezel ${identity.label} bridge cannot start. Stop the process using it, then retry ${identity.label} setup.`;
}

async function startServer(opts: {
  port: number;
  fetch: ServeFetch;
  log: Logger;
}): Promise<{ server: ServerType; port: number }> {
  return await new Promise((resolve, reject) => {
    let listening = false;
    const server = serve(
      {
        fetch: opts.fetch,
        port: opts.port,
        hostname: '127.0.0.1',
      },
      (info) => {
        listening = true;
        resolve({ server, port: info.port });
      },
    );
    server.on('error', (error) => {
      if (!listening) reject(error);
      else opts.log.error(`listener error: ${error.message}`);
    });
  });
}

async function closeServer(server: ServerType): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.close(finish);
    const http1 = server as unknown as {
      closeAllConnections?: () => void;
      closeIdleConnections?: () => void;
    };
    http1.closeIdleConnections?.();
    http1.closeAllConnections?.();
    const timer = setTimeout(finish, 2_000);
    timer.unref?.();
  });
}

/**
 * Guard a bridge route the way every harness bridge needs it guarded.
 *
 * Hono distinguishes the exact mount path from its descendants. Apply the same
 * boundary to both so a retrieve form cannot bypass the scope check.
 */
export function mountAuthenticatedRoute(app: Hono, path: string, ctx: ServiceContext): void {
  for (const pattern of [path, `${path}/*`]) {
    app.use(pattern, openAiErrorEnvelope());
    app.use(pattern, requireOpenAiEndpointsEnabled(ctx));
    app.use(pattern, bearerAuth(ctx.tokenStore));
    app.use(pattern, requireScope('openai'));
  }
}
