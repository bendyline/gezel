import { createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
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
import { v1ChatRoutes } from './routes/v1-chat.js';
import { v1ModelsRoutes } from './routes/v1-models.js';
import { opaqueServerErrors } from './server.js';

export const VSCODE_BRIDGE_MARKER_HEADER = 'x-gezel-vscode-bridge';

const VSCODE_BRIDGE_IDENTITY: LocalBridgeIdentity = {
  label: 'VS Code',
  channel: 'vscode-bridge',
  markerHeader: VSCODE_BRIDGE_MARKER_HEADER,
};

const log = createLogger(VSCODE_BRIDGE_IDENTITY.channel);
const VSCODE_STREAM_KEEPALIVE_INTERVAL_MS = 15_000;

/** Narrow OpenAI chat-completions surface for VS Code's built-in endpoint. */
export function buildVSCodeBridgeApp(ctx: ServiceContext): Hono {
  const app = new Hono();
  app.use('*', localBridgeHardening(VSCODE_BRIDGE_IDENTITY));
  app.use('*', opaqueServerErrors(log));
  app.use('*', hostGuard());

  mountAuthenticatedRoute(app, '/v1/chat', ctx);
  mountAuthenticatedRoute(app, '/v1/models', ctx);
  app.route(
    '/v1/chat',
    v1ChatRoutes(ctx, {
      // VS Code's Custom Endpoint parser recognizes reasoning_content when
      // the generated model declares thinking support.
      includeReasoning: true,
      keepaliveIntervalMs: VSCODE_STREAM_KEEPALIVE_INTERVAL_MS,
      externalConversation: {
        sourceId: 'vscode',
        sourceName: 'VS Code',
        sessionIdHeaders: [],
      },
      // Native Custom Endpoint requests include the full transcript but no
      // stable chat id. Recover affinity from the persisted transcript and
      // use X-Request-Id only when this is a genuinely new thread.
      inferConversationFromTranscript: true,
    }),
  );
  app.route('/v1/models', v1ModelsRoutes(ctx));

  app.all('*', (c) =>
    c.json(
      {
        error: {
          message:
            'This address serves Gezel inference for VS Code. Only /v1/chat/completions and /v1/models are available here.',
          type: 'invalid_request_error',
          code: 'not_found',
        },
      },
      404,
    ),
  );
  return app;
}

export type VSCodeBridgeController = LocalBridgeController;

export function createVSCodeBridgeController(opts: {
  fetch: () => LocalBridgeFetch;
  port: number;
}): VSCodeBridgeController {
  return createLocalBridgeController({
    identity: VSCODE_BRIDGE_IDENTITY,
    fetch: opts.fetch,
    port: opts.port,
  });
}
