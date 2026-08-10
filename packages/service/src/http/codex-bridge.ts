import { createLogger } from '@bendyline/gezel';
import { type ServerType, serve } from '@hono/node-server';
import { Hono } from 'hono';
import { bearerAuth, requireScope } from './auth.js';
import type { ServiceContext } from './context.js';
import { hostGuard } from './host-guard.js';
import { openAiErrorEnvelope } from './openai-compat/error-envelope.js';
import { requireOpenAiEndpointsEnabled } from './openai-endpoints-gate.js';
import { v1ResponsesRoutes } from './routes/v1-responses.js';
import { opaqueServerErrors } from './server.js';

const log = createLogger('codex-bridge');
type ServeFetch = Parameters<typeof serve>[0]['fetch'];

/**
 * Standalone-controller fallback. The product service supplies a stable port
 * derived from its canonical Gezel home so multiple OS users do not contend
 * for this address. Callers may supply another exact port (or `0` in tests).
 */
export const CODEX_BRIDGE_PORT = 11_435;

/** Header used to identify an existing bridge during a port-conflict probe. */
export const CODEX_BRIDGE_MARKER_HEADER = 'x-gezel-codex-bridge';

/**
 * Build the deliberately tiny HTTP app served by the Codex bridge listener.
 * It is plain HTTP on loopback because Codex cannot pin the product daemon's
 * self-signed TLS certificate. Authentication remains mandatory.
 *
 * This app is assembled independently from the product app so `/api/*`, app
 * grants, chat sessions, files, and every other internal route are absent by
 * construction. Codex owns its tools and invokes only the Responses API.
 */
export function buildCodexBridgeApp(
  ctx: ServiceContext,
  opts: { models?: () => Promise<unknown[]> } = {},
): Hono {
  const app = new Hono();

  // Security headers and the ownership marker ride on every response,
  // including auth failures and 404s. Strip hop-by-hop headers that Hono's
  // streaming helpers may add; Node owns those on this HTTP/1.1 listener.
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.delete('connection');
    c.res.headers.delete('keep-alive');
    c.res.headers.delete('upgrade');
    c.res.headers.delete('proxy-connection');
    c.res.headers.delete('transfer-encoding');
    c.res.headers.set('x-content-type-options', 'nosniff');
    c.res.headers.set('referrer-policy', 'no-referrer');
    c.res.headers.set('x-frame-options', 'DENY');
    c.res.headers.set(CODEX_BRIDGE_MARKER_HEADER, '1');
  });
  app.use('*', opaqueServerErrors(log));
  app.use('*', hostGuard());

  mountAuthenticatedRoute(app, '/v1/responses', ctx);
  app.route('/v1/responses', v1ResponsesRoutes(ctx));

  const getModels = opts.models;
  if (getModels) {
    mountAuthenticatedRoute(app, '/v1/models', ctx);
    // Codex's provider catalog shape is `{ models: [...] }`, not OpenAI's
    // `{ object: "list", data: [...] }`. The setup manager owns descriptors
    // because they include the selected local model's effective context cap.
    app.get('/v1/models', async (c) => c.json({ models: await getModels() }));
  }

  app.all('*', (c) =>
    c.json(
      {
        error: {
          message: 'This Gezel listener exposes only the Codex inference bridge.',
          type: 'invalid_request_error',
          code: 'not_found',
        },
      },
      404,
    ),
  );

  return app;
}

function mountAuthenticatedRoute(app: Hono, path: string, ctx: ServiceContext): void {
  // Hono distinguishes the exact mount path from its descendants. Apply the
  // same boundary to both so a retrieve form cannot bypass the scope check.
  for (const pattern of [path, `${path}/*`]) {
    app.use(pattern, openAiErrorEnvelope());
    app.use(pattern, requireOpenAiEndpointsEnabled(ctx));
    app.use(pattern, bearerAuth(ctx.tokenStore));
    app.use(pattern, requireScope('openai'));
  }
}

export interface CodexBridgeStatus {
  listening: boolean;
  port?: number;
}

export interface CodexBridgeController {
  status(): CodexBridgeStatus;
  /** Exact configured port (`0` only for callers deliberately requesting an ephemeral test port). */
  desiredPort(): number;
  /** Stable HTTP origin, or `null` before an ephemeral (`port: 0`) listener has bound. */
  baseUrl(): string | null;
  /** Bind the configured port exactly. Idempotent while already listening. */
  start(): Promise<CodexBridgeStatus>;
  /** Stop the listener. Idempotent when already stopped. */
  stop(): Promise<void>;
}

/**
 * Own the fixed-address loopback listener a Codex profile points at.
 * Integration/config code decides when to start it and supplies the app's
 * fetch handler; this module deliberately does not mutate settings or files.
 */
export function createCodexBridgeController(opts: {
  fetch: () => ServeFetch;
  /** Exact loopback port. Defaults to {@link CODEX_BRIDGE_PORT}; `0` is a test seam. */
  port?: number;
}): CodexBridgeController {
  const desiredPort = opts.port ?? CODEX_BRIDGE_PORT;
  if (!Number.isInteger(desiredPort) || desiredPort < 0 || desiredPort > 65_535) {
    throw new Error(`Invalid Codex bridge port: ${desiredPort}`);
  }

  let server: ServerType | null = null;
  let current: CodexBridgeStatus = { listening: false };

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
        bound = await startServer({ port: desiredPort, fetch: opts.fetch() });
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE') {
          throw new Error(await describePortConflict(desiredPort));
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
      log.info(`[codex-bridge] authenticated loopback listener on 127.0.0.1:${bound.port}`);
      return { ...current };
    },

    stop,
  };
}

async function describePortConflict(port: number): Promise<string> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(750),
    });
    if (response.headers.get(CODEX_BRIDGE_MARKER_HEADER) === '1') {
      return `Port ${port} is already in use by another Gezel Codex bridge. Stop the other Gezel service, then retry Codex setup.`;
    }
  } catch {
    // A raw/non-HTTP listener is still a conflict; use the generic message.
  }
  return `Port ${port} is already in use by another process, so the Gezel Codex bridge cannot start. Stop the process using it, then retry Codex setup.`;
}

async function startServer(opts: {
  port: number;
  fetch: ServeFetch;
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
      else log.error(`[codex-bridge] listener error: ${error.message}`);
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
