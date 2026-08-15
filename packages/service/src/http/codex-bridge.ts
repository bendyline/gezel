import { createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import { bearerAuth, requireScope } from './auth.js';
import type { ServiceContext } from './context.js';
import { hostGuard } from './host-guard.js';
import {
  type LocalBridgeController,
  type LocalBridgeFetch,
  type LocalBridgeIdentity,
  type LocalBridgeStatus,
  createLocalBridgeController,
  localBridgeHardening,
} from './local-bridge.js';
import { openAiErrorEnvelope } from './openai-compat/error-envelope.js';
import { requireOpenAiEndpointsEnabled } from './openai-endpoints-gate.js';
import { v1ResponsesRoutes } from './routes/v1-responses.js';
import { opaqueServerErrors } from './server.js';

/**
 * Standalone-controller fallback. The product service supplies a stable port
 * derived from its canonical Gezel home so multiple OS users do not contend
 * for this address. Callers may supply another exact port (or `0` in tests).
 */
export const CODEX_BRIDGE_PORT = 11_435;

/** Header used to identify an existing bridge during a port-conflict probe. */
export const CODEX_BRIDGE_MARKER_HEADER = 'x-gezel-codex-bridge';

const CODEX_BRIDGE_IDENTITY: LocalBridgeIdentity = {
  label: 'Codex',
  channel: 'codex-bridge',
  markerHeader: CODEX_BRIDGE_MARKER_HEADER,
};

const log = createLogger(CODEX_BRIDGE_IDENTITY.channel);

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

  app.use('*', localBridgeHardening(CODEX_BRIDGE_IDENTITY));
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

export type CodexBridgeStatus = LocalBridgeStatus;
export type CodexBridgeController = LocalBridgeController;

/**
 * Own the fixed-address loopback listener a Codex profile points at.
 * Integration/config code decides when to start it and supplies the app's
 * fetch handler; this module deliberately does not mutate settings or files.
 */
export function createCodexBridgeController(opts: {
  fetch: () => LocalBridgeFetch;
  /** Exact loopback port. Defaults to {@link CODEX_BRIDGE_PORT}; `0` is a test seam. */
  port?: number;
}): CodexBridgeController {
  return createLocalBridgeController({
    identity: CODEX_BRIDGE_IDENTITY,
    fetch: opts.fetch,
    port: opts.port ?? CODEX_BRIDGE_PORT,
  });
}
