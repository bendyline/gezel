import type { MiddlewareHandler } from 'hono';
import type { ServiceContext } from './context.js';

/**
 * Master switch for the public OpenAI-compatible facade, driven by
 * `config.openaiEndpoints.enabled` (Settings → Connected Apps).
 *
 * Mounted BEFORE bearerAuth on `/v1/chat`, `/v1/models`,
 * `/v1/embeddings`, `/v1/gezels`, `/ollama/v1/*`, and
 * `/v1/apps/register` — when the user flips the switch off, nothing on
 * those surfaces answers, valid token or not, and no new app can even
 * request a grant. The rest of `/v1/apps/*` (list, approve, revoke)
 * stays reachable so the Connected Apps panel keeps working while the
 * facade is off. `/v1/remote/*` is deliberately not gated — remote
 * model serving has its own `remoteServing.enabled` switch.
 *
 * Unset means ON: the per-app consent flow remains the primary gate,
 * and defaulting off would add a second hoop to every first-time app
 * connection.
 *
 * The 403 body uses the OpenAI error envelope so SDK callers surface an
 * actionable message instead of a bare status code.
 */
export function requireOpenAiEndpointsEnabled(ctx: ServiceContext): MiddlewareHandler {
  return async (c, next) => {
    const config = await ctx.store
      .readConfig()
      .catch(() => ({}) as { openaiEndpoints?: { enabled?: boolean } });
    if (config.openaiEndpoints?.enabled === false) {
      return c.json(
        {
          error: {
            message:
              'OpenAI-compatible endpoints are turned off in Gezel. Enable them under Settings → Connected Apps.',
            type: 'invalid_request_error',
            code: 'openai_endpoints_disabled',
          },
        },
        403,
      );
    }
    return next();
  };
}
