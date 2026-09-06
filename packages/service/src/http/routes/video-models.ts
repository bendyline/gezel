import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SSEStreamingApi } from 'hono/streaming';
import {
  INVALID_MODEL_ID_CODE,
  INVALID_MODEL_ID_MESSAGE,
  isSafeModelId,
} from '../../models/model-id.js';
import { ReadOnlyModelError } from '../../models/storage-roots.js';
import { UnknownVideoModelError } from '../../providers/video/pull-registry.js';
import type { EngineContext } from '../engine-context.js';
import { machineEngineProxy } from './machine-engine-proxy.js';

export function videoModelRoutes(ctx: EngineContext): Hono {
  const app = new Hono();
  const proxy = machineEngineProxy(ctx, '/api/video-gen', '/v1/remote/manage/video-gen', []);

  app.get('/models', proxy, async (c) => {
    const provider = await ctx.videoProvider.current();
    const models = await provider.listInstalledModels();
    const kind = providerKind(provider.name);
    return c.json({ models: models.map((m) => ({ ...m, kind })) });
  });

  app.get('/engine-status', proxy, async (c) => {
    const provider = await ctx.videoProvider.current();
    const [engine, models] = await Promise.all([provider.health(), provider.listInstalledModels()]);
    return c.json({
      engine: {
        ...engine,
        kind: providerKind(provider.name),
        provider: provider.name,
      },
      modelCount: models.length,
    });
  });

  app.post('/models/:id/pull', proxy, async (c) => {
    const id = c.req.param('id');
    try {
      await ctx.videoPulls.start(id);
    } catch (err) {
      if (err instanceof UnknownVideoModelError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
    return streamSSE(c, (stream) => subscribeToPullSse(ctx, id, stream));
  });

  app.get('/pulls', proxy, (c) => {
    return c.json({ pulls: ctx.videoPulls.list() });
  });

  app.get('/pulls/:id/events', proxy, (c) => {
    const id = c.req.param('id');
    if (!ctx.videoPulls.get(id)) {
      return c.json({ error: `no active pull for video-model: ${id}` }, 404);
    }
    return streamSSE(c, (stream) => subscribeToPullSse(ctx, id, stream));
  });

  app.delete('/pulls/:id', proxy, (c) => {
    const id = c.req.param('id');
    const aborted = ctx.videoPulls.cancel(id);
    return c.json({ aborted });
  });

  app.delete('/models/:id', proxy, async (c) => {
    const id = c.req.param('id');
    if (!isSafeModelId(id)) {
      return c.json({ error: INVALID_MODEL_ID_MESSAGE, code: INVALID_MODEL_ID_CODE }, 400);
    }
    const provider = await ctx.videoProvider.current();
    try {
      await provider.deleteModel(id);
    } catch (err) {
      if (err instanceof ReadOnlyModelError) {
        return c.json({ error: err.message, code: err.code }, 409);
      }
      throw err;
    }
    return c.json({ ok: true as const });
  });
  return app;
}

async function subscribeToPullSse(
  ctx: EngineContext,
  id: string,
  stream: SSEStreamingApi,
): Promise<void> {
  let done = false;
  const { promise, resolve } = withResolvers<void>();
  const unsubscribe = ctx.videoPulls.subscribe(id, (event) => {
    if (done) return;
    const write = stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
    if (event.type === 'done' || event.type === 'error') {
      done = true;
      // Flush the terminal frame BEFORE resolving — resolving lets the
      // streamSSE handler return, which tears down the response. Without
      // awaiting the write, Hono can close the socket before the `done`
      // bytes flush, so the client never receives it and the UI's
      // progress card sits frozen at 100% even though the install
      // finished. (The multi-file verify phase makes the window wide.)
      void write.then(() => resolve());
    }
  });
  if (!unsubscribe) return;
  stream.onAbort(() => {
    if (done) return;
    done = true;
    resolve();
  });
  await promise;
  unsubscribe();
}
function withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
function providerKind(name: string): 'local' | 'cloud' {
  // Only local engines today; the helper mirrors the image route so a
  // future cloud video provider slots in here.
  return name === 'cloud' ? 'cloud' : 'local';
}
