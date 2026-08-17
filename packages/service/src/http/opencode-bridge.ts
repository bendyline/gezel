import { createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import { bearerAuth, requireScope } from './auth.js';
import type { ServiceContext } from './context.js';
import { hostGuard } from './host-guard.js';
import {
  type LocalBridgeController,
  type LocalBridgeFetch,
  type LocalBridgeIdentity,
  createLocalBridgeController,
  localBridgeHardening,
  mountAuthenticatedRoute,
} from './local-bridge.js';
import { openAiErrorEnvelope } from './openai-compat/error-envelope.js';
import { requireOpenAiEndpointsEnabled } from './openai-endpoints-gate.js';
import { v1ChatRoutes } from './routes/v1-chat.js';
import { v1ModelsRoutes } from './routes/v1-models.js';
import { opaqueServerErrors } from './server.js';

/** Header used to identify an existing bridge during a port-conflict probe. */
export const OPENCODE_BRIDGE_MARKER_HEADER = 'x-gezel-opencode-bridge';

const OPENCODE_BRIDGE_IDENTITY: LocalBridgeIdentity = {
  label: 'OpenCode',
  channel: 'opencode-bridge',
  markerHeader: OPENCODE_BRIDGE_MARKER_HEADER,
};

const log = createLogger(OPENCODE_BRIDGE_IDENTITY.channel);

/**
 * The deliberately tiny HTTP app served by the OpenCode bridge listener.
 *
 * Plain HTTP on loopback because OpenCode runs outside Electron and cannot pin
 * the product daemon's per-launch self-signed certificate. Authentication
 * remains mandatory — unlike Ollama emulation, nothing here is reachable
 * without the managed credential.
 *
 * OpenCode's `@ai-sdk/openai-compatible` provider speaks chat completions, so
 * this bridge mounts `/v1/chat/completions` where the Codex bridge mounts
 * `/v1/responses`. `/v1/models` is the ordinary OpenAI listing shape, not
 * Codex's `{ models: [...] }` catalog: OpenCode reads its model list from the
 * managed config file and only uses this route for liveness.
 *
 * Assembled independently from the product app, so `/api/*`, app grants, chat
 * sessions, files, and every other internal route are absent by construction.
 * OpenCode owns its own tools, sandbox, and conversation loop.
 */
export function buildOpenCodeBridgeApp(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.use('*', localBridgeHardening(OPENCODE_BRIDGE_IDENTITY));
  app.use('*', opaqueServerErrors(log));
  app.use('*', hostGuard());

  mountAuthenticatedRoute(app, '/v1/chat', ctx);
  app.route('/v1/chat', v1ChatRoutes(ctx));

  mountAuthenticatedRoute(app, '/v1/models', ctx);
  app.route('/v1/models', v1ModelsRoutes(ctx));

  app.all('*', (c) =>
    c.json(
      {
        error: {
          message: 'This Gezel listener exposes only the OpenCode inference bridge.',
          type: 'invalid_request_error',
          code: 'not_found',
        },
      },
      404,
    ),
  );

  return app;
}

export type OpenCodeBridgeController = LocalBridgeController;

/**
 * Own the fixed-address loopback listener the managed OpenCode config points
 * at. The setup manager decides when it should be running; this module
 * deliberately does not mutate settings or files.
 */
export function createOpenCodeBridgeController(opts: {
  fetch: () => LocalBridgeFetch;
  /** Exact loopback port; `0` is a test seam for an ephemeral bind. */
  port: number;
}): OpenCodeBridgeController {
  return createLocalBridgeController({
    identity: OPENCODE_BRIDGE_IDENTITY,
    fetch: opts.fetch,
    port: opts.port,
  });
}
