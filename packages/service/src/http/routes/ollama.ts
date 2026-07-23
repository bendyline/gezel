import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { detectOllamaInstallation } from '../../providers/ollama-detect.js';
import { startOllamaIfPossible } from '../../providers/ollama-launch.js';
import { readNdjson } from '../../providers/ollama.js';
import {
  addPendingPull,
  listPendingPulls,
  removePendingPull,
} from '../../providers/pending-pulls.js';
import type { ServiceContext } from '../context.js';
import { invalidateModelsCache } from './models.js';

const PullRequestSchema = z.object({
  name: z.string().min(1),
});

const DEFAULT_BASE_URL = 'http://localhost:11434';

async function resolveBaseUrl(ctx: ServiceContext): Promise<string> {
  const config = await ctx.store.readConfig();
  return (config.ollamaBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

export function ollamaRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  /**
   * Is Ollama installed on this machine? Separate from /status because an
   * installed-but-not-running Ollama should produce a different UX than an
   * uninstalled one (offer to start vs. offer to download).
   */
  app.get('/detect', async (c) => {
    const detection = await detectOllamaInstallation();
    return c.json(detection);
  });

  /**
   * Launch a locally-installed Ollama if it isn't already running. Up to
   * three attempts, each followed by ~3s of polling. Surfaces the detection
   * result so the caller can distinguish "not installed" from "install found
   * but launch failed".
   */
  app.post('/start', async (c) => {
    const base = await resolveBaseUrl(ctx);
    const result = await startOllamaIfPossible(base);
    return c.json({ ...result, baseUrl: base });
  });

  /**
   * Quick liveness + model-count probe. Drives the UI's status pill. Always
   * returns 200 so the UI can show the failure inline instead of treating
   * unreachable-Ollama as an HTTP error.
   */
  app.get('/status', async (c) => {
    const base = await resolveBaseUrl(ctx);
    try {
      const res = await fetch(`${base}/api/tags`);
      if (!res.ok) {
        return c.json({
          ok: false as const,
          baseUrl: base,
          error: `${res.status} ${res.statusText}`,
        });
      }
      const { models } = (await res.json()) as { models?: unknown[] };
      const modelCount = Array.isArray(models) ? models.length : 0;
      return c.json({ ok: true as const, baseUrl: base, modelCount });
    } catch (err) {
      return c.json({
        ok: false as const,
        baseUrl: base,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * Live probe: hit Ollama's `/api/ps` and surface what's actually
   * loaded right now. Used by the UI's slow-banner "Check Ollama"
   * action — when a turn has gone silent, this answers "is Ollama
   * up + is the model still loaded?" in one click. Times out at 5s
   * so a hung Ollama process doesn't block the UI.
   */
  app.get('/probe', async (c) => {
    const base = await resolveBaseUrl(ctx);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const start = Date.now();
    try {
      const res = await fetch(`${base}/api/ps`, { signal: ctrl.signal });
      const elapsedMs = Date.now() - start;
      if (!res.ok) {
        return c.json({
          ok: false as const,
          baseUrl: base,
          elapsedMs,
          error: `${res.status} ${res.statusText}`,
        });
      }
      const json = (await res.json()) as {
        models?: Array<{
          name?: string;
          model?: string;
          size_vram?: number;
          expires_at?: string;
        }>;
      };
      const loaded = (json.models ?? []).map((m) => ({
        name: m.name ?? m.model ?? '(unknown)',
        sizeVram: m.size_vram ?? 0,
        expiresAt: m.expires_at,
      }));
      return c.json({
        ok: true as const,
        baseUrl: base,
        elapsedMs,
        loaded,
      });
    } catch (err) {
      const elapsedMs = Date.now() - start;
      const aborted = err instanceof Error && err.name === 'AbortError';
      return c.json({
        ok: false as const,
        baseUrl: base,
        elapsedMs,
        error: aborted
          ? 'unreachable within 5s — Ollama process may be hung or restarting'
          : err instanceof Error
            ? err.message
            : String(err),
      });
    } finally {
      clearTimeout(timer);
    }
  });

  /**
   * Pull a model from the Ollama registry and stream the progress as SSE.
   * Ollama's own response is NDJSON with per-chunk `{status, digest?,
   * total?, completed?}` events. We forward each line as a JSON SSE event
   * and emit a terminal `{type:'done'}` when the stream completes.
   */
  app.post('/pull', async (c) => {
    const body = PullRequestSchema.parse(await c.req.json());
    const base = await resolveBaseUrl(ctx);

    // Record the pull intent before we start streaming. If the app dies
    // mid-pull, next launch finds this entry and auto-resumes. We remove
    // it only on explicit success (Ollama emits `status: "success"`) or
    // when the UI calls `DELETE /pending-pulls/:name` (user cancel).
    await addPendingPull(ctx.home, body.name).catch(() => {
      /* best-effort */
    });

    return streamSSE(c, async (stream) => {
      try {
        const res = await fetch(`${base}/api/pull`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: body.name, stream: true }),
        });
        if (!res.ok || !res.body) {
          const txt = await res.text().catch(() => '');
          await stream.writeSSE({
            data: JSON.stringify({
              type: 'error',
              error: `Ollama /api/pull returned ${res.status} ${res.statusText}: ${txt.slice(0, 200)}`,
            }),
          });
          await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) });
          return;
        }

        let sawSuccess = false;
        for await (const chunk of readNdjson(res.body)) {
          if (
            chunk &&
            typeof chunk === 'object' &&
            (chunk as { status?: unknown }).status === 'success'
          ) {
            sawSuccess = true;
          }
          await stream.writeSSE({
            data: JSON.stringify({ type: 'progress', chunk }),
          });
        }
        invalidateModelsCache('ollama');
        if (sawSuccess) {
          await removePendingPull(ctx.home, body.name).catch(() => {});
        }
        await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) });
      } catch (err) {
        await stream.writeSSE({
          data: JSON.stringify({
            type: 'error',
            error: err instanceof Error ? err.message : String(err),
          }),
        });
        await stream.writeSSE({ data: JSON.stringify({ type: 'done' }) });
      }
    });
  });

  /**
   * Pulls the user has asked for that haven't successfully completed.
   * On app boot the UI reads this, re-initiates each one, and presents
   * the resumed download in its "Downloading…" panel without requiring a
   * second click.
   */
  app.get('/pending-pulls', async (c) => {
    const pulls = await listPendingPulls(ctx.home);
    return c.json({ pulls });
  });

  /** Remove a pending pull entry — called by the UI on explicit cancel. */
  app.delete('/pending-pulls/:name{.+}', async (c) => {
    const name = c.req.param('name');
    await removePendingPull(ctx.home, name);
    return c.json({ ok: true });
  });

  /** Remove a local model. */
  app.delete('/models/:name{.+}', async (c) => {
    const name = c.req.param('name');
    const base = await resolveBaseUrl(ctx);
    const res = await fetch(`${base}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return c.json(
        {
          error: `Ollama /api/delete returned ${res.status} ${res.statusText}: ${txt.slice(0, 200)}`,
        },
        500,
      );
    }
    invalidateModelsCache('ollama');
    return c.json({ ok: true });
  });

  return app;
}
