import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ServiceContext } from '../context.js';
import { subscribeToInstallSse } from './install-sse.js';
import { machineEngineProxy } from './machine-engine-proxy.js';
import { invalidateModelsCache } from './models.js';

/**
 * llama.cpp local model management — install / list / delete GGUF
 * models from the bundled chat-model catalog. The provider itself
 * (chat) lives in `chat-events.ts`; this file only deals with
 * sourcing the weights from Hugging Face.
 *
 * Mounted under `/api/llama-cpp` from `http/server.ts`.
 */
export function llamaCppRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  app.use('*', machineEngineProxy(ctx, '/api/llama-cpp', '/v1/remote/manage/llama-cpp'));

  app.get('/models', async (c) => {
    const models = await ctx.llamaCppModels.listInstalled();
    return c.json({ models });
  });

  /**
   * Polled snapshot of installs currently running. Both the user-
   * triggered install (from Settings) and the first-run bootstrap
   * funnel through `LlamaCppModelManager.install()`, which registers
   * each in-flight catalog id here. The Settings catalog view polls
   * this endpoint so a background-driven install (the bootstrap one)
   * lights up the same progress bar a click-driven install would
   * have shown via SSE.
   */
  app.get('/active-installs', (c) => {
    return c.json({ installs: ctx.llamaCppModels.getActiveInstalls() });
  });

  /**
   * Incomplete downloads: interrupted or unverified downloads that hold
   * bytes on disk but have no `manifest.json`, so they never appear in
   * `/models`. The Settings UI surfaces these so the user can resume or
   * delete them instead of losing GBs to the silent 7-day reclaim sweep.
   */
  app.get('/incomplete', async (c) => {
    const incomplete = await ctx.llamaCppModels.listIncomplete();
    return c.json({ incomplete });
  });

  /**
   * Install a chat-model entry's llama.cpp source. The install itself runs
   * as a background job owned by {@link ServiceContext.chatInstalls} — this
   * SSE is just a subscriber, so a client disconnect detaches the consumer
   * without abandoning the download. Idempotent: a second `POST` for a
   * running id attaches to the in-flight install rather than starting (or
   * erroring on) a parallel one. Cancel is the explicit `DELETE` below.
   * The companion image-reader pull rides the same background job.
   */
  app.post('/models/:catalogId/install', async (c) => {
    const catalogId = c.req.param('catalogId');
    // `?skipSha=1` bypasses sha256 verification — the UI sends this on
    // the user's explicit "Download anyway" retry after they've seen a
    // catalog-vs-Hugging-Face mismatch banner. Any non-empty value
    // other than 'false'/'0' is treated as truthy.
    const skipShaRaw = c.req.query('skipSha');
    const skipSha =
      skipShaRaw != null && skipShaRaw !== '' && skipShaRaw !== '0' && skipShaRaw !== 'false';
    // Only fetch the vision projector when the user has opted this model into
    // native image support. Re-running the install after flipping the toggle
    // picks up just the missing file — completed files are skipped.
    const config = await ctx.store.readConfig().catch(() => null);
    const includeMmproj = config?.nativeVision?.[catalogId] === true;
    ctx.chatInstalls.llamaCpp.start(catalogId, { skipSha, includeMmproj });
    return streamSSE(c, (stream) =>
      subscribeToInstallSse(ctx.chatInstalls.llamaCpp, catalogId, stream),
    );
  });

  /** Explicitly cancel an in-flight install. Disconnect alone does not cancel. */
  app.delete('/models/:catalogId/install', (c) => {
    const catalogId = c.req.param('catalogId');
    return c.json({ aborted: ctx.chatInstalls.llamaCpp.cancel(catalogId) });
  });

  app.delete('/models/:id', async (c) => {
    const id = c.req.param('id');
    try {
      await ctx.llamaCppModels.delete(id);
      invalidateModelsCache('llama-cpp');
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /**
   * Tail the supervised llama-server's rolling log. Query param
   * `bytes` caps the returned tail (default 4096, max 65536). Returns
   * `{ path, tail }` — `path` is the absolute file path for the
   * settings UI to surface; `tail` is the trailing window of the
   * current day's file. Returns empty strings when the provider
   * hasn't been initialized or runs via an external baseUrl (no
   * supervised process, no log).
   */
  app.get('/log', async (c) => {
    const raw = c.req.query('bytes');
    const requested = raw ? Number.parseInt(raw, 10) : 4096;
    const bytes = Number.isFinite(requested) ? Math.min(Math.max(requested, 256), 65_536) : 4096;
    const provider = ctx.chat.getProviderIfReady('llama-cpp');
    // The provider exposes `getLogFile()`; use duck typing so this
    // route doesn't need to import LlamaCppProvider (keeps the route
    // agnostic of provider-internal types).
    const logFile = (
      provider as unknown as {
        getLogFile?: () => {
          tail: (n: number) => Promise<string>;
          currentFile: () => string | null;
        };
      } | null
    )?.getLogFile?.();
    if (!logFile) {
      return c.json({ path: null, tail: '' });
    }
    const tail = await logFile.tail(bytes);
    return c.json({ path: logFile.currentFile(), tail });
  });

  return app;
}
