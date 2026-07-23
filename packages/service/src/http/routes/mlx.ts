import { createLogger } from '@bendyline/gezel';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ServiceContext } from '../context.js';
import { invalidateModelsCache } from './models.js';

const log = createLogger('mlx-install');

/**
 * MLX local model management — install / list / delete MLX-format
 * models from the bundled chat-model catalog's `mlx` source block,
 * and expose the Python-runtime status block so Settings can show
 * which Python / uv powers the venv.
 *
 * The provider itself (chat + tool calls) lives in `chat-events.ts`;
 * this file only deals with model-directory lifecycle and venv
 * introspection.
 *
 * Mounted under `/api/mlx` from `http/server.ts`.
 */
export function mlxRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/models', async (c) => {
    const models = await ctx.mlxModels.listInstalled();
    return c.json({ models });
  });

  /**
   * Polled snapshot of installs currently running. See the matching
   * route on the llama-cpp side — same rationale: the first-run
   * bootstrap fires the install server-side, and the Settings UI
   * needs a way to discover it without its own SSE controller.
   */
  app.get('/active-installs', (c) => {
    return c.json({ installs: ctx.mlxModels.getActiveInstalls() });
  });

  /**
   * Install an MLX model directory from HuggingFace. Same SSE shape as
   * the llama-cpp install endpoint; event body carries `fileIndex` +
   * `fileCount` so the UI can render per-file progress inside the
   * overall model install.
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
      // Track the terminal frame we stream so a silent close (the install
      // generator unwinding, or the SSE connection dropping, without a
      // `done`/`error`) is visible in the logs — that's the failure mode
      // where the catalog card reverts to "Download" with no explanation.
      let terminal: 'done' | 'error' | null = null;
      try {
        for await (const event of ctx.mlxModels.install(catalogId, { skipSha })) {
          if (event.type === 'error') {
            terminal = 'error';
            log.warn(`install "${catalogId}" failed: ${event.error}`);
          } else if (event.type === 'done') {
            terminal = 'done';
          }
          await stream.writeSSE({ data: JSON.stringify(event) });
        }
        invalidateModelsCache('mlx');
        if (terminal === null) {
          log.warn(
            `install "${catalogId}" stream ended without a terminal done/error event — client will see an interrupted install`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`install "${catalogId}" threw mid-stream: ${message}`);
        await stream.writeSSE({
          data: JSON.stringify({ type: 'error', error: message }),
        });
      }
    });
  });

  app.delete('/models/:id', async (c) => {
    const id = c.req.param('id');
    try {
      await ctx.mlxModels.delete(id);
      invalidateModelsCache('mlx');
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /**
   * Describe the Python runtime that backs the MLX venv. Read-only; used
   * by Settings to show which Python + uv is in play and surface a
   * "reset venv" affordance when something looks off.
   */
  app.get('/runtime', async (c) => {
    const info = await ctx.uvRuntime.describeRuntime();
    return c.json(info);
  });

  /**
   * Delete the `mlx` venv directory. Next chat turn re-provisions via
   * `UvRuntime.ensureVenv`. Handy when a user wants to force a Python
   * upgrade or a clean mlx-lm reinstall without deleting models.
   */
  app.post('/runtime/reset', async (c) => {
    try {
      await ctx.uvRuntime.removeVenv('mlx');
      // Reflect the wipe immediately so the UI pill flips back to idle
      // without waiting for the next chat turn.
      ctx.mlxRuntimeStatus.publish({ phase: 'idle' });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /**
   * Current MLX venv lifecycle phase — one-shot snapshot. The UI pill
   * uses this on initial mount; SSE keeps it live across transitions.
   */
  app.get('/runtime/status', (c) => {
    return c.json(ctx.mlxRuntimeStatus.current);
  });

  /**
   * Live stream of MLX venv lifecycle transitions (idle → provisioning
   * → ready / error). Mirrors `/api/system-toolsets/status/stream`.
   */
  app.get('/runtime/status/stream', (c) => {
    return streamSSE(c, async (stream) => {
      let closed = false;
      const unsubscribe = ctx.mlxRuntimeStatus.subscribe((status) => {
        if (closed) return;
        void stream.writeSSE({ data: JSON.stringify(status) }).catch(() => {
          /* stream closed */
        });
      });
      stream.onAbort(() => {
        closed = true;
        unsubscribe();
      });
      while (!closed) {
        await stream.sleep(5000);
        try {
          await stream.writeSSE({ event: 'ping', data: '' });
        } catch {
          closed = true;
        }
      }
      unsubscribe();
    });
  });

  return app;
}
