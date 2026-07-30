import { createLogger } from '@bendyline/gezel';
import type { GezelConfig } from '@bendyline/gezel';
import { type ServerType, serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { ServiceContext } from './context.js';
import { hostGuard } from './host-guard.js';
import { ollamaCompatRoutes } from './routes/ollama-compat.js';
import { v1ChatRoutes } from './routes/v1-chat.js';
import { v1EmbeddingsRoutes } from './routes/v1-embeddings.js';
import { v1ModelsRoutes } from './routes/v1-models.js';
import { opaqueServerErrors } from './server.js';

const log = createLogger('ollama-emulation');
type ServeFetch = Parameters<typeof serve>[0]['fetch'];

/** Ollama's well-known port — the whole point of the emulation. */
export const OLLAMA_EMULATION_PORT = 11434;

/**
 * The app served on the emulation listener. **Unauthenticated by
 * design** — the Ollama ecosystem's contract is no-auth plain HTTP on
 * loopback, and stock clients send no bearer token. The security
 * posture compensates elsewhere:
 *
 *   - The listener exists only while the user's explicit opt-in
 *     (`openaiEndpoints.emulateOllama`, default OFF) is set.
 *   - Loopback bind only, plus {@link hostGuard} so a DNS-rebound
 *     hostname can't reach it from a browser page.
 *   - No CORS headers — drive-by web pages can fire requests but can
 *     never read a response.
 *   - Inference surfaces ONLY: tags/chat, OpenAI-compat chat, models,
 *     embeddings. No app registration, no `/api/*` product surface,
 *     nothing that reads or writes files, projects, or settings.
 *
 * Paths mirror real Ollama: `{host}/api/tags`, `{host}/api/chat`,
 * `{host}/api/version`, a root banner, and the OpenAI-compat `/v1/*`
 * Ollama also serves. The serving gezel, per-model tuning, and the
 * supporting-behaviors switch all apply — same engine as `/v1`.
 */
export function buildOllamaEmulationApp(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.use('*', async (c, next) => {
    await next();
    c.res.headers.delete('connection');
    c.res.headers.delete('keep-alive');
    c.res.headers.delete('upgrade');
    c.res.headers.delete('proxy-connection');
    c.res.headers.delete('transfer-encoding');
    c.res.headers.set('x-content-type-options', 'nosniff');
    c.res.headers.set('referrer-policy', 'no-referrer');
  });
  app.use('*', opaqueServerErrors(log));
  app.use('*', hostGuard());

  // Reachability probes stock clients use before their first real call.
  app.get('/', (c) => c.text('Ollama is running'));
  app.get('/api/version', (c) => c.json({ version: '0.5.0' }));

  // Ollama-native surface: /api/tags + /api/chat.
  app.route('/api', ollamaCompatRoutes(ctx));

  // Ollama also serves OpenAI-compat under /v1 — some "point me at
  // Ollama" integrations use it via the OpenAI SDK.
  app.route('/v1/chat', v1ChatRoutes(ctx));
  app.route('/v1/models', v1ModelsRoutes(ctx));
  app.route('/v1/embeddings', v1EmbeddingsRoutes(ctx));

  app.all('/*', (c) => c.json({ error: 'not supported by the gezel Ollama emulation' }, 404));

  return app;
}

export interface OllamaEmulationStatus {
  listening: boolean;
  port?: number;
}

export interface OllamaEmulationController {
  status(): OllamaEmulationStatus;
  /**
   * Bring the listener in line with config. Active only when the
   * facade master switch is on AND `emulateOllama` is set. Throws with
   * an actionable message when the port can't be bound (usually: real
   * Ollama is already running) — the config route reverts the toggle
   * and surfaces the message as a 409.
   */
  reconfigure(config: GezelConfig['openaiEndpoints']): Promise<OllamaEmulationStatus>;
  stop(): Promise<void>;
}

export function createOllamaEmulationController(opts: {
  fetch: () => ServeFetch;
  /** Test seam — bind an ephemeral port instead of 11434. */
  port?: number;
}): OllamaEmulationController {
  const desiredPort = opts.port ?? OLLAMA_EMULATION_PORT;
  let server: ServerType | null = null;
  let current: OllamaEmulationStatus = { listening: false };

  const stop = async (): Promise<void> => {
    const active = server;
    server = null;
    current = { listening: false };
    if (!active) return;
    await closeServer(active);
  };

  return {
    status: () => ({ ...current }),
    async reconfigure(config) {
      const wanted = config?.emulateOllama === true && config?.enabled !== false;
      if (!wanted) {
        await stop();
        return { ...current };
      }
      if (server && current.listening) return { ...current };

      let bound: { server: ServerType; port: number };
      try {
        bound = await startServer({ port: desiredPort, fetch: opts.fetch() });
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        if (code === 'EADDRINUSE') {
          throw new Error(await describePortConflict(desiredPort));
        }
        throw err;
      }
      server = bound.server;
      current = { listening: true, port: bound.port };
      const ownedServer = bound.server;
      ownedServer.once('close', () => {
        if (server !== ownedServer) return;
        server = null;
        current = { listening: false };
      });
      log.warn(
        `[ollama-emulation] UNAUTHENTICATED Ollama-compatible listener on 127.0.0.1:${bound.port} — any local process can run inference here (user opt-in).`,
      );
      return { ...current };
    },
    stop,
  };
}

/**
 * Distinguish "real Ollama owns the port" from "something else does" so
 * the refusal tells the user what to actually do.
 */
async function describePortConflict(port: number): Promise<string> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/version`, {
      signal: AbortSignal.timeout(1_000),
    });
    if (res.ok) {
      return `Port ${port} is already in use — Ollama itself appears to be running there. Stop Ollama first, or keep using it directly and leave emulation off.`;
    }
  } catch {
    /* not Ollama, or not answering — fall through to the generic message */
  }
  return `Port ${port} is already in use by another process, so the Ollama emulation cannot start.`;
}

async function startServer(opts: {
  port: number;
  fetch: ServeFetch;
}): Promise<{ server: ServerType; port: number }> {
  return await new Promise((resolve, reject) => {
    let listening = false;
    const server = serve(
      // Plain HTTP on loopback only — the Ollama ecosystem's transport.
      { fetch: opts.fetch, port: opts.port, hostname: '127.0.0.1' },
      (info) => {
        listening = true;
        resolve({ server, port: info.port });
      },
    );
    server.on('error', (err) => {
      if (!listening) reject(err);
      else log.error(`[ollama-emulation] listener error: ${err.message}`);
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
