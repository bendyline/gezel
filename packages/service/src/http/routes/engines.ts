import { Hono } from 'hono';
import { type SSEStreamingApi, streamSSE } from 'hono/streaming';
import { isKnownEngine } from '../../engines/registry.js';
import type { ServiceContext } from '../context.js';

/**
 * `/api/engines` — runtime view of the local-engine pool. The
 * Settings → Local Models page polls `/status` every 2s to keep the
 * memory-budget bar and per-clone resident column live.
 *
 * Also hosts the native engine-binary resolver endpoints (`/binaries/*`)
 * that download + verify a missing engine from the pinned release.
 *
 * Mounted under `/api/engines` from `http/server.ts`.
 */
export function enginesRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  /**
   * Start (or attach to) a download+verify of `engine` (optionally a GPU
   * `?variant=cuda|vulkan|metal|cpu`) and stream progress as SSE. The
   * manual trigger behind Settings → On-device → "Download engine". The
   * lazy on-device-chat path uses the same registry. Idempotent — a
   * second call while one is in flight attaches to the running job.
   */
  app.post('/binaries/:engine/ensure', (c) => {
    const engine = c.req.param('engine');
    if (!isKnownEngine(engine)) {
      return c.json({ error: `unknown engine '${engine}'` }, 400);
    }
    const variant = c.req.query('variant') || undefined;
    const { key } = ctx.engineBinaries.ensure(engine, variant);
    return streamSSE(c, (stream) => subscribeEngineSse(ctx, key, stream));
  });

  /** Snapshot of in-flight + recently-finished engine resolves. */
  app.get('/binaries', (c) => {
    return c.json({ binaries: ctx.engineBinaries.list() });
  });

  /** Cancel an in-flight resolve. `?variant=` must match the `ensure` call. */
  app.delete('/binaries/:engine', (c) => {
    const engine = c.req.param('engine');
    if (!isKnownEngine(engine)) {
      return c.json({ error: `unknown engine '${engine}'` }, 400);
    }
    const variant = c.req.query('variant') || undefined;
    const aborted = ctx.engineBinaries.cancel(ctx.engineBinaries.key(engine, variant));
    return c.json({ aborted });
  });

  /**
   * Live pool snapshot: committed bytes, budget, and the resident
   * set keyed by `${provider}:${modelId}:${replicaIdx}`. Returns
   * `enforced: false` on cloud-only installs (no router) — UI hides
   * the bar in that case.
   */
  app.get('/status', async (c) => {
    const snap = await ctx.chat.engineStatus();
    if (!snap) {
      return c.json({
        enforced: false,
        budgetBytes: 0,
        committedBytes: 0,
        entries: [],
      });
    }
    return c.json(snap);
  });

  /**
   * Apply a new clone-count target to a local provider. Body shape:
   *   { provider: 'llama-cpp' | 'mlx', clones: { [modelId]: number } }
   *
   * The chat manager's `reconcileEnginePool` diffs the resident set
   * against the target, evicts excess replicas (with their cache
   * flush) and pre-spawns missing ones up to capacity. The capacity
   * broker is the final arbiter — out-of-budget requests are
   * silently capped; the resulting `/status` snapshot reflects what
   * actually loaded.
   */
  app.post('/reconcile', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      provider?: unknown;
      clones?: unknown;
    } | null;
    const provider = body?.provider;
    if (provider !== 'llama-cpp' && provider !== 'mlx' && provider !== 'ds4') {
      return c.json({ error: 'provider must be "llama-cpp", "mlx", or "ds4"' }, 400);
    }
    const clonesRaw = body?.clones;
    if (clonesRaw === null || typeof clonesRaw !== 'object') {
      return c.json({ error: 'clones must be an object { modelId: count }' }, 400);
    }
    const clones: Record<string, number> = {};
    for (const [k, v] of Object.entries(clonesRaw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 16) {
        clones[k] = v;
      }
    }
    await ctx.chat.reconcileEnginePool(provider, clones);
    const snap = await ctx.chat.engineStatus();
    return c.json({ ok: true, status: snap });
  });

  return app;
}

/**
 * Stream an engine resolve's events as SSE. Unsubscribes on client
 * disconnect WITHOUT cancelling the download (that's the registry design);
 * terminates after the terminal event so the client loop exits. Mirrors
 * `subscribeToPullSse` in image-gen.ts.
 */
async function subscribeEngineSse(
  ctx: ServiceContext,
  key: string,
  stream: SSEStreamingApi,
): Promise<void> {
  let done = false;
  let resolveDone!: () => void;
  const finished = new Promise<void>((r) => {
    resolveDone = r;
  });
  const unsubscribe = ctx.engineBinaries.subscribe(key, (event) => {
    if (done) return;
    void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
    if (event.type === 'done' || event.type === 'error') {
      done = true;
      resolveDone();
    }
  });
  if (!unsubscribe) {
    // The resolve finished + was GC'd between ensure() and subscribe().
    return;
  }
  stream.onAbort(() => {
    if (done) return;
    done = true;
    resolveDone();
  });
  await finished;
  unsubscribe();
}
