import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SSEStreamingApi } from 'hono/streaming';
import {
  INVALID_MODEL_ID_CODE,
  INVALID_MODEL_ID_MESSAGE,
  isSafeModelId,
} from '../../models/model-id.js';
import { ReadOnlyModelError } from '../../models/storage-roots.js';
import { resolveImg2ImgSupport } from '../../providers/image/img2img-support.js';
import { UnknownImageModelError } from '../../providers/image/pull-registry.js';
import type { EngineContext } from '../engine-context.js';
import { machineEngineProxy } from './machine-engine-proxy.js';

export function imageModelRoutes(ctx: EngineContext): Hono {
  const app = new Hono();
  const proxy = machineEngineProxy(ctx, '/api/image-gen', '/v1/remote/manage/image-gen', [], () =>
    ctx.imageProvider.usesMachineEngine(),
  );

  /** List installed image models (not the catalog — installed weights on disk). */
  app.get('/models', proxy, async (c) => {
    const provider = await ctx.imageProvider.current();
    const models = await provider.listInstalledModels();
    const kind = providerKind(provider.name);
    // Cloud image APIs are all edit-capable; local models resolve through
    // the explicit-field → assessment-map → weights-kind ladder so the UI
    // and MCP callers can tell which installed models can edit an image.
    return c.json({
      models: models.map((m) => ({
        ...m,
        kind,
        supportsImg2Img:
          kind === 'cloud'
            ? true
            : resolveImg2ImgSupport({
                modelId: m.id,
                explicit: m.supportsImg2Img,
                weightsKind: m.weightsKind,
              }).supported,
      })),
    });
  });

  /**
   * Engine readiness probe + installed model count, in one round-trip.
   * The Settings UI uses this to render an honest "Ready" pill: "Ready"
   * means the engine is reachable AND at least one model is installed.
   * The distinction between `unreachable` and `not-configured` lets the
   * UI surface different guidance: "set GEZEL_SD_SERVER_URL" vs "your
   * sd-server isn't responding". `kind` and `provider` are injected at
   * the route layer so the UI can branch (cloud → hide pull/delete).
   */
  app.get('/engine-status', proxy, async (c) => {
    const provider = await ctx.imageProvider.current();
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

  /**
   * Pull a catalog-resolved image model. `:id` must name an
   * `image-model` catalog entry; the manifest supplies downloadUrl +
   * sha256 + size. Cloud providers reject pull entirely.
   *
   * Backed by {@link ctx.imagePulls} — the registry owns the lifecycle
   * of the actual download so it survives the user navigating away from
   * Settings → Image generation. This SSE is just a subscriber: when
   * the client disconnects, the listener is detached but the pull
   * continues. Use `DELETE /pulls/:id` to actually abort. Idempotent —
   * a second `POST` for the same id while one is in flight returns the
   * same in-flight pull rather than starting a parallel one.
   */
  app.post('/models/:id/pull', proxy, async (c) => {
    const id = c.req.param('id');
    try {
      await ctx.imagePulls.start(id);
    } catch (err) {
      if (err instanceof UnknownImageModelError) {
        return c.json({ error: err.message }, 404);
      }
      throw err;
    }
    return streamSSE(c, (stream) => subscribeToPullSse(ctx, id, stream));
  });

  /**
   * Snapshot list of every in-flight (or recently-finished) pull. The
   * UI calls this on `ImageModelManager` mount so a returning user sees
   * an accurate progress bar without having to be the original kicker
   * of the pull. Finished pulls hang around briefly so the call
   * captures the terminal state.
   */
  app.get('/pulls', proxy, (c) => {
    return c.json({ pulls: ctx.imagePulls.list() });
  });

  /**
   * Subscribe to live events for an in-progress pull. The registry
   * replays the latest snapshot as a synthetic `progress` (and
   * `retrying` / `error` when applicable) on subscribe so the UI never
   * sees an empty bar while waiting for the next real event.
   *
   * Returns 404 when no pull exists for `:id` — the caller should fall
   * back to `POST /models/:id/pull` to start a new one.
   */
  app.get('/pulls/:id/events', proxy, (c) => {
    const id = c.req.param('id');
    if (!ctx.imagePulls.get(id)) {
      return c.json({ error: `no active pull for image-model: ${id}` }, 404);
    }
    return streamSSE(c, (stream) => subscribeToPullSse(ctx, id, stream));
  });

  /** Explicitly cancel an in-flight pull. Disconnect alone does not cancel. */
  app.delete('/pulls/:id', proxy, (c) => {
    const id = c.req.param('id');
    const aborted = ctx.imagePulls.cancel(id);
    return c.json({ aborted });
  });

  app.delete('/models/:id', proxy, async (c) => {
    const id = c.req.param('id');
    if (!isSafeModelId(id)) {
      return c.json({ error: INVALID_MODEL_ID_MESSAGE, code: INVALID_MODEL_ID_CODE }, 400);
    }
    const provider = await ctx.imageProvider.current();
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
  const unsubscribe = ctx.imagePulls.subscribe(id, (event) => {
    if (done) return;
    // A failed write means the socket is gone, which onAbort will also
    // fire — no need to surface it here.
    const write = stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
    if (event.type === 'done' || event.type === 'error') {
      done = true;
      // Flush the terminal frame before resolving — resolving lets the
      // handler return and Hono close the response; without the await
      // the `done` bytes can be dropped and the UI's progress card stays
      // stuck at 100%.
      void write.then(() => resolve());
    }
  });
  if (!unsubscribe) {
    // Pull vanished between the route's existence check and the
    // subscribe — treat as a clean terminal so the client moves on.
    return;
  }
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
export function providerKind(name: string): 'local' | 'cloud' {
  return name === 'google-ai' || name === 'openai' ? 'cloud' : 'local';
}
