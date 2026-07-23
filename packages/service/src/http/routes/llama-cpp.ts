import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ServiceContext } from '../context.js';
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
   * Install a chat-model entry's llama.cpp source. SSE-streams the
   * progress events the model manager yields so the UI can render a
   * live progress bar with sha256-verify and metadata-extract phases
   * called out separately.
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
    return streamSSE(c, async (stream) => {
      try {
        for await (const event of ctx.llamaCppModels.install(catalogId, { skipSha })) {
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
        // listModels caches per-provider results — bust the llama-cpp
        // entry so the next /api/models call picks up the new install.
        invalidateModelsCache('llama-cpp');
      } catch (err) {
        await stream.writeSSE({
          data: JSON.stringify({
            type: 'error',
            error: err instanceof Error ? err.message : String(err),
          }),
        });
      }
    });
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
