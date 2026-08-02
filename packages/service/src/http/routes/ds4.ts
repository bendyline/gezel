import { gezelPaths } from '@bendyline/gezel/paths';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { tailLatestEngineLog } from '../../providers/llama-cpp/log.js';
import type { ServiceContext } from '../context.js';
import { subscribeToInstallSse } from './install-sse.js';
import { invalidateModelsCache } from './models.js';

/**
 * ds4 (DwarfStar / DeepSeek-V4) local model management — install / list /
 * delete the antirez DeepSeek-V4 GGUFs from the chat-model catalog. ds4's
 * GGUFs are structurally identical to llama.cpp's, so this mirrors
 * `llama-cpp.ts` and funnels through the same `LlamaCppModelManager`
 * (constructed with `engine: 'ds4'`, so it reads the catalog `ds4` source
 * block and stores under `engines/ds4/models`). The chat provider lives in
 * the ds4 provider; this file only sources weights from Hugging Face.
 *
 * Mounted under `/api/ds4` from `http/server.ts`.
 */
export function ds4Routes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/models', async (c) => {
    const models = await ctx.ds4Models.listInstalled();
    return c.json({ models });
  });

  /** Polled snapshot of installs currently running (mirrors llama-cpp). */
  app.get('/active-installs', (c) => {
    return c.json({ installs: ctx.ds4Models.getActiveInstalls() });
  });

  /**
   * Install a chat-model entry's ds4 source. The install runs as a
   * background job owned by {@link ServiceContext.chatInstalls}; this SSE
   * is just a subscriber, so a client disconnect does not abandon the
   * download. That matters doubly here — these are large (~81–153 GB)
   * DeepSeek-V4 quants. Idempotent: a second `POST` for a running id
   * attaches to the in-flight install. Cancel is the explicit `DELETE`.
   */
  app.post('/models/:catalogId/install', async (c) => {
    const catalogId = c.req.param('catalogId');
    const skipShaRaw = c.req.query('skipSha');
    const skipSha =
      skipShaRaw != null && skipShaRaw !== '' && skipShaRaw !== '0' && skipShaRaw !== 'false';
    ctx.chatInstalls.ds4.start(catalogId, { skipSha, includeMmproj: false });
    return streamSSE(c, (stream) => subscribeToInstallSse(ctx.chatInstalls.ds4, catalogId, stream));
  });

  /** Explicitly cancel an in-flight install. Disconnect alone does not cancel. */
  app.delete('/models/:catalogId/install', (c) => {
    const catalogId = c.req.param('catalogId');
    return c.json({ aborted: ctx.chatInstalls.ds4.cancel(catalogId) });
  });

  app.delete('/models/:id', async (c) => {
    const id = c.req.param('id');
    try {
      await ctx.ds4Models.delete(id);
      invalidateModelsCache('ds4');
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** Tail the supervised ds4-server log retained under GEZEL_HOME/logs. */
  app.get('/log', async (c) => {
    const raw = c.req.query('bytes');
    const requested = raw ? Number.parseInt(raw, 10) : 4096;
    const bytes = Number.isFinite(requested) ? Math.min(Math.max(requested, 256), 65_536) : 4096;
    const provider = ctx.chat.getProviderIfReady('ds4');
    const logFile = (
      provider as unknown as {
        getLogFile?: () => {
          tail: (n: number) => Promise<string>;
          currentFile: () => string | null;
        };
      } | null
    )?.getLogFile?.();
    if (logFile) {
      return c.json({ path: logFile.currentFile(), tail: await logFile.tail(bytes) });
    }
    // Pool-managed providers are not stored in ChatManager's singleton map,
    // and after a force-quit there is no live provider at all. Fall back to
    // the retained file so the diagnostic survives both cases.
    return c.json(await tailLatestEngineLog(gezelPaths(ctx.home).logs, 'ds4-server', bytes));
  });

  return app;
}
