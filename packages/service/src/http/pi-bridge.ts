import { createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import type { ServiceContext } from './context.js';
import {
  EXTERNAL_PROJECT_HEADER,
  EXTERNAL_WORKING_DIRECTORY_HEADER,
} from './external-conversation-headers.js';
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
import { v1ChatRoutes } from './routes/v1-chat.js';
import { v1ModelsRoutes } from './routes/v1-models.js';
import { opaqueServerErrors } from './server.js';

/** Header used to identify an existing bridge during a port-conflict probe. */
export const PI_BRIDGE_MARKER_HEADER = 'x-gezel-pi-bridge';

const PI_BRIDGE_IDENTITY: LocalBridgeIdentity = {
  label: 'pi',
  channel: 'pi-bridge',
  markerHeader: PI_BRIDGE_MARKER_HEADER,
};

const log = createLogger(PI_BRIDGE_IDENTITY.channel);
const PI_STREAM_KEEPALIVE_INTERVAL_MS = 15_000;

export interface PiBridgeAppOptions {
  /** Test seam; production uses a 15-second body-idle keepalive. */
  keepaliveIntervalMs?: number;
}

/**
 * The inference surface pi talks to, on its own fixed loopback address.
 *
 * pi registers the provider with `api: "openai-completions"`, so this serves
 * the ordinary chat-completions pair and nothing else — no product `/api/*`
 * route is reachable from here, and the credential carries only the `openai`
 * scope. A separate listener and credential per harness is what lets the user
 * revoke pi without disturbing Codex or OpenCode.
 */
export function buildPiBridgeApp(ctx: ServiceContext, opts: PiBridgeAppOptions = {}): Hono {
  const app = new Hono();

  // Hardening first: its marker and security headers must reach the host
  // guard's own 403, which is how a port-conflict probe recognizes this bridge.
  app.use('*', localBridgeHardening(PI_BRIDGE_IDENTITY));
  app.use('*', opaqueServerErrors(log));
  app.use('*', hostGuard());

  mountAuthenticatedRoute(app, '/v1/chat', ctx);
  mountAuthenticatedRoute(app, '/v1/models', ctx);
  // pi's OpenAI-completions adapter turns `delta.reasoning_content` into
  // live thinking blocks. Keep this extension scoped to the dedicated pi
  // listener so the general /v1 and OpenCode contracts remain unchanged.
  app.route(
    '/v1/chat',
    v1ChatRoutes(ctx, {
      includeReasoning: true,
      keepaliveIntervalMs: opts.keepaliveIntervalMs ?? PI_STREAM_KEEPALIVE_INTERVAL_MS,
      externalConversation: {
        sourceId: 'pi',
        sourceName: 'Pi',
        sessionIdHeaders: [
          'x-session-affinity',
          'x-client-request-id',
          'session_id',
          'x-session-id',
        ],
        workingDirectoryHeader: EXTERNAL_WORKING_DIRECTORY_HEADER,
        projectHeader: EXTERNAL_PROJECT_HEADER,
      },
    }),
  );
  app.route('/v1/models', v1ModelsRoutes(ctx));

  app.all('*', (c) =>
    c.json(
      {
        error: {
          message:
            'This address serves Gezel inference for pi. Only /v1/chat/completions and /v1/models are available here.',
          type: 'invalid_request_error',
          code: 'not_found',
        },
      },
      404,
    ),
  );
  return app;
}

export type PiBridgeController = LocalBridgeController;

export function createPiBridgeController(opts: {
  fetch: () => LocalBridgeFetch;
  port: number;
}): PiBridgeController {
  return createLocalBridgeController({
    identity: PI_BRIDGE_IDENTITY,
    fetch: opts.fetch,
    port: opts.port,
  });
}
