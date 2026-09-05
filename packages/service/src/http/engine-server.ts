import { randomUUID } from 'node:crypto';
import { createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import { ZodError } from 'zod';
import {
  bearerAuth,
  denyRemoteInferenceScope,
  requireInternalApiAccess,
  requireScope,
} from './auth.js';
import type { EngineContext } from './engine-context.js';
import {
  type UnexpectedHttpErrorHandler,
  notifyUnexpectedHttpError,
  opaqueServerErrors,
} from './errors.js';
import { hostGuard } from './host-guard.js';
import { mountMachineEngineHints } from './machine-engine-hints.js';
import { audioModelRoutes } from './routes/audio-models.js';
import { ds4Routes } from './routes/ds4.js';
import { engineCacheRoutes } from './routes/engine-cache.js';
import { engineQueueRoutes } from './routes/engine-queues.js';
import { enginesRoutes } from './routes/engines.js';
import { imageModelRoutes } from './routes/image-models.js';
import { llamaCppRoutes } from './routes/llama-cpp.js';
import { mlxRoutes } from './routes/mlx.js';
import { modelBundleRoutes } from './routes/model-bundles.js';
import { modelFitnessRoutes } from './routes/model-fitness.js';
import { remoteServingManageRoutes } from './routes/remote-serving-manage.js';
import { systemMemoryRoutes } from './routes/system-memory.js';
import { v1IdentityRoutes } from './routes/v1-identity.js';
import { v1KnowledgeAssetsRoutes } from './routes/v1-knowledge-assets.js';
import { v1ModelsEnsureRoutes } from './routes/v1-models-ensure.js';
import { v1RemoteRoutes } from './routes/v1-remote.js';
import { videoModelRoutes } from './routes/video-models.js';
/** Deliberately explicit capability table. Product routers are never imported here. */
export function buildEngineApp(
  ctx: EngineContext,
  options: { onUnexpectedHttpError?: UnexpectedHttpErrorHandler } = {},
): Hono {
  const app = new Hono();
  const log = createLogger('engine-http');
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    c.res.headers.set('x-content-type-options', 'nosniff');
    c.res.headers.set('referrer-policy', 'no-referrer');
    c.res.headers.set('x-frame-options', 'DENY');
    for (const key of [
      'connection',
      'keep-alive',
      'upgrade',
      'proxy-connection',
      'transfer-encoding',
    ])
      c.res.headers.delete(key);
  });
  app.use('*', opaqueServerErrors(log, options.onUnexpectedHttpError));
  app.use('*', hostGuard());
  app.use('/api/*', bearerAuth(ctx.tokenStore));
  app.use('/api/*', requireInternalApiAccess());
  app.use('/api/*', denyRemoteInferenceScope());
  app.onError((err, c) => {
    if (err instanceof ZodError)
      return c.json(
        { error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') },
        422,
      );
    const requestId = randomUUID();
    const detail = err.stack ?? err.message;
    log.error(detail);
    notifyUnexpectedHttpError(
      options.onUnexpectedHttpError,
      {
        kind: 'unhandled_exception',
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: 500,
        detail,
      },
      log,
    );
    return c.json({ error: 'internal_error', requestId }, 500);
  });
  app.route('/v1/identity', v1IdentityRoutes(ctx));
  app.use('/v1/remote/*', bearerAuth(ctx.tokenStore));
  app.use('/v1/remote/*', requireScope('remote-inference'));
  app.use('/v1/remote/models/ensure', requireScope('machine-models'));
  app.use('/v1/remote/models/ensure/*', requireScope('machine-models'));
  app.use('/v1/remote/manage/knowledge/*', requireScope('machine-knowledge-assets'));
  app.use('/v1/remote/manage/*', (c, next) => {
    if (c.req.path.startsWith('/v1/remote/manage/knowledge/')) return next();
    return requireScope('machine-models')(c, next);
  });
  app.route('/v1/remote/models/ensure', v1ModelsEnsureRoutes(ctx));
  app.route('/v1/remote/manage/knowledge', v1KnowledgeAssetsRoutes({ catalog: ctx.catalog }));
  app.route('/v1/remote/manage/llama-cpp', llamaCppRoutes(ctx));
  app.route('/v1/remote/manage/ds4', ds4Routes(ctx));
  app.route('/v1/remote/manage/mlx', mlxRoutes(ctx));
  app.route('/v1/remote/manage/engines', enginesRoutes(ctx));
  app.route('/v1/remote/manage/queues', engineQueueRoutes(ctx));
  app.route('/v1/remote/manage/cache', engineCacheRoutes(ctx));
  app.route('/v1/remote/manage/system/memory', systemMemoryRoutes(ctx));
  app.route('/v1/remote/manage/model-fitness', modelFitnessRoutes(ctx));
  app.route('/v1/remote/manage/model-bundles', modelBundleRoutes(ctx));
  app.route('/v1/remote/manage/image-gen', imageModelRoutes(ctx));
  app.route('/v1/remote/manage/video-gen', videoModelRoutes(ctx));
  app.route('/v1/remote/manage/audio', audioModelRoutes(ctx));
  app.route('/v1/remote/manage/serving', remoteServingManageRoutes(ctx));
  app.route('/v1/remote', v1RemoteRoutes(ctx));
  mountMachineEngineHints(app);
  app.all('*', (c) => c.json({ error: 'not_found', service: 'gezel-machine-engine' }, 404));
  return app;
}
