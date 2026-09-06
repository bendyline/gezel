import { existsSync } from 'node:fs';
import {
  DEFAULT_LOCAL_ENGINE_IDLE_TIMEOUT_MS,
  LlamaCppContextSizingResponseSchema,
  ModelContextOverrideUpdateSchema,
  type NativeEngineName,
  createLogger,
} from '@bendyline/gezel';
import { resolvePlatformKey } from '@bendyline/gezel/native';
import { Hono } from 'hono';
import { type SSEStreamingApi, streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { effectiveEngineRelease, isEnginePinned } from '../../engines/native-manifest.js';
import { KNOWN_ENGINES, isKnownEngine } from '../../engines/registry.js';
import { EngineBusyError } from '../../providers/native/capacity-broker.js';
import type { EngineContext } from '../engine-context.js';
import { isMachineEngineProvider, machineEngineProxy } from './machine-engine-proxy.js';
import { invalidateModelsCache } from './models.js';

const log = createLogger('engines');

const ENGINE_ENV_VAR: Record<NativeEngineName, string> = {
  'llama-server': 'GEZEL_LLAMA_SERVER_BIN',
  'ds4-server': 'GEZEL_DS4_SERVER_BIN',
  'sd-server': 'GEZEL_SD_SERVER_BIN',
  'whisper-server': 'GEZEL_WHISPER_SERVER_BIN',
  uv: 'GEZEL_UV_BIN',
  duckdb: 'GEZEL_DUCKDB_BIN',
};

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
export function enginesRoutes(ctx: EngineContext): Hono {
  const app = new Hono();
  app.use('*', machineEngineProxy(ctx, '/api/engines', '/v1/remote/manage/engines'));

  /**
   * Source pin + executable availability for first-run clients. This is a
   * daemon-runtime view: an executable only reads installed when its resolved
   * path exists and has been stamped into this process.
   */
  app.get('/binaries/status', (c) => {
    const backendRaw =
      process.env.GEZEL_LLAMA_SERVER_BACKEND ?? process.env.GEZEL_LLAMA_DETECTED_BACKEND;
    const llamaBackend = ['cuda', 'vulkan', 'metal', 'cpu'].find((value) => value === backendRaw) as
      | 'cuda'
      | 'vulkan'
      | 'metal'
      | 'cpu'
      | undefined;
    return c.json({
      release: effectiveEngineRelease(),
      pinned: isEnginePinned(),
      platformKey: resolvePlatformKey(),
      ...(llamaBackend ? { llamaBackend } : {}),
      engines: KNOWN_ENGINES.map((name) => {
        const path = process.env[ENGINE_ENV_VAR[name]];
        return {
          name,
          installed: !!path && existsSync(path),
          ...(path ? { path } : {}),
        };
      }),
    });
  });

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

  /** Immediately unload one retained model replica, provided it is still idle. */
  app.post('/unload', async (c) => {
    const body = z
      .object({
        provider: z.enum(['llama-cpp', 'mlx', 'ds4']),
        modelId: z
          .string()
          .min(1)
          .refine((value) => !value.includes(':'), {
            message: 'must not contain ":"',
          }),
        replicaIdx: z.number().int().nonnegative(),
      })
      .parse(await c.req.json());
    try {
      const unloaded = await ctx.chat.unloadIdleEngine(
        body.provider,
        body.modelId,
        body.replicaIdx,
      );
      if (!unloaded) return c.json({ error: 'That model is no longer loaded.' }, 404);
      return c.json({ ok: true as const });
    } catch (error) {
      if (error instanceof EngineBusyError) {
        return c.json({ error: 'That model is in use and cannot be unloaded yet.' }, 409);
      }
      throw error;
    }
  });

  /** Engine-owner retention policy; proxied to the machine broker in production. */
  app.get('/retention', async (c) => {
    const config = await ctx.store.readConfig();
    return c.json({
      idleTimeoutMs: config.localEngineIdleTimeoutMs ?? DEFAULT_LOCAL_ENGINE_IDLE_TIMEOUT_MS,
    });
  });

  app.put('/retention', async (c) => {
    const body = z
      .object({
        idleTimeoutMs: z
          .number()
          .int()
          .min(60_000)
          .max(24 * 60 * 60_000),
      })
      .parse(await c.req.json());
    const previous =
      (await ctx.store.readConfig()).localEngineIdleTimeoutMs ??
      DEFAULT_LOCAL_ENGINE_IDLE_TIMEOUT_MS;
    await ctx.store.writeConfig({ localEngineIdleTimeoutMs: body.idleTimeoutMs });
    if (body.idleTimeoutMs !== previous) {
      await ctx.chat.resetClient({ deferBusy: true });
    }
    return c.json({ idleTimeoutMs: body.idleTimeoutMs });
  });

  /**
   * Machine-owner memory budget. This lives beside the other engine policy
   * routes so packaged user daemons proxy the write to the process that owns
   * the models instead of persisting an inert per-user value.
   */
  app.put('/memory-budget', async (c) => {
    const body = z
      .object({ localEngineMemoryGb: z.number().positive().nullable() })
      .parse(await c.req.json());
    await ctx.store.writeConfig({ localEngineMemoryGb: body.localEngineMemoryGb });
    await ctx.chat.setLocalEngineMemoryBudget(
      body.localEngineMemoryGb === null ? null : Math.round(body.localEngineMemoryGb * 1024 ** 3),
    );
    return c.json({ localEngineMemoryGb: body.localEngineMemoryGb });
  });

  /** Persist the discrete-GPU co-residency policy on the engine owner. */
  app.put('/ram-spillover', async (c) => {
    const body = z.object({ allowRamSpillover: z.boolean().nullable() }).parse(await c.req.json());
    await ctx.store.writeConfig({ allowRamSpillover: body.allowRamSpillover });
    await ctx.chat.setAllowRamSpillover(body.allowRamSpillover);
    return c.json({ allowRamSpillover: body.allowRamSpillover });
  });

  /**
   * Machine-owned llama.cpp context policy. This deliberately lives under
   * the engine-management boundary instead of `/api/config`: packaged user
   * daemons proxy this route to the machine engine, while local/dev installs
   * persist it in their own store. The selector therefore controls the
   * process that actually performs admission in both hosting shapes.
   */
  app.get('/llama-cpp/context-sizing', async (c) => {
    const config = await ctx.store.readConfig();
    return c.json({ policy: config.llamaCppContextSizing ?? 'adaptive' });
  });

  app.put('/llama-cpp/context-sizing', async (c) => {
    const body = LlamaCppContextSizingResponseSchema.parse(await c.req.json());
    const previous = (await ctx.store.readConfig()).llamaCppContextSizing ?? 'adaptive';
    const updated = await ctx.store.writeConfig({
      // Keep the default sparse on disk; explicit model-max is the only
      // durable override needed.
      llamaCppContextSizing: body.policy === 'adaptive' ? null : body.policy,
    });
    const effective = updated.llamaCppContextSizing ?? 'adaptive';
    if (effective !== previous) {
      // The policy governs engine LAUNCH arguments, so a resident engine
      // holds its old window until it restarts. Tear idle providers down
      // now (busy ones finish their in-flight turn first — same soft-reset
      // contract as model-preference changes in the config route) so the
      // next session actually launches under the new policy instead of
      // waiting for an idle-timeout nobody can see.
      invalidateModelsCache();
      await ctx.chat.resetClient({ deferBusy: true });
    }
    return c.json({ policy: effective });
  });

  /**
   * Per-model context overrides (Settings → Local models → Context size…).
   * Engine-owner state like the sizing policy above — packaged user daemons
   * proxy these to the machine engine so the override lands in the config
   * of the process that actually performs admission. Keys on disk are
   * `"<engine>:<modelId>"` in `config.modelContextOverrides`; the wire map
   * is keyed by model id alone (engine is in the route).
   */
  app.get('/:engine/model-context', async (c) => {
    const engine = c.req.param('engine');
    if (!isMachineEngineProvider(engine)) {
      return c.json({ error: 'engine must be "llama-cpp", "mlx", or "ds4"' }, 400);
    }
    const record = (await ctx.store.readConfig()).modelContextOverrides ?? {};
    const prefix = `${engine}:`;
    const overrides: Record<string, number> = {};
    for (const [key, tokens] of Object.entries(record)) {
      if (key.startsWith(prefix)) overrides[key.slice(prefix.length)] = tokens;
    }
    return c.json({ overrides });
  });

  app.put('/:engine/model-context/:modelId', async (c) => {
    const engine = c.req.param('engine');
    if (!isMachineEngineProvider(engine)) {
      return c.json({ error: 'engine must be "llama-cpp", "mlx", or "ds4"' }, 400);
    }
    const modelId = c.req.param('modelId');
    const body = ModelContextOverrideUpdateSchema.parse(await c.req.json());
    const key = `${engine}:${modelId}`;
    const record = { ...((await ctx.store.readConfig()).modelContextOverrides ?? {}) };
    const previous = record[key];
    if (body.contextTokens === null) delete record[key];
    else record[key] = body.contextTokens;
    // Store.writeConfig replaces this record wholesale (only externalFolders
    // deep-merges), so the read-merge-write above is what preserves other
    // models' overrides; null clears the field when the record empties.
    await ctx.store.writeConfig({
      modelContextOverrides: Object.keys(record).length > 0 ? record : null,
    });
    const effective = body.contextTokens ?? undefined;
    if (effective !== previous) {
      // Same contract as the sizing policy above: overrides govern LAUNCH
      // arguments, so tear idle providers down now; a busy engine finishes
      // its turn first and the models list shows "Restart needed" until the
      // relaunch picks the new window up. ds4 prices its reservation at the
      // launch window, so the cached resident bytes have to go with it.
      invalidateModelsCache();
      ctx.chat.invalidateResidentBytesCache(engine, modelId);
      await ctx.chat.resetClient({ deferBusy: true });
    }
    return c.json({ modelId, contextTokens: body.contextTokens });
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
  ctx: EngineContext,
  key: string,
  stream: SSEStreamingApi,
): Promise<void> {
  const engine = ctx.engineBinaries.get(key)?.engine;
  let done = false;
  let resolveDone!: () => void;
  const finished = new Promise<void>((r) => {
    resolveDone = r;
  });
  let writes = Promise.resolve();
  const unsubscribe = ctx.engineBinaries.subscribe(key, (event) => {
    if (done) return;
    writes = writes.then(async () => {
      if (event.type === 'done' && engine) {
        // A refresh failure must not break the write chain: the 'done'
        // write and the finished latch below still have to run, and a
        // rejected chain nobody observes is fatal daemon-wide.
        await refreshNativeConsumer(ctx, engine).catch((err) => {
          log.warn(
            `native consumer refresh failed after ${key}:`,
            err instanceof Error ? err.message : err,
          );
        });
      }
      await stream.writeSSE({ data: JSON.stringify(event) }).catch(() => {});
      if (event.type === 'done' || event.type === 'error') {
        done = true;
        resolveDone();
      }
    });
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
  await writes;
  unsubscribe();
}

/**
 * Provider managers are lazy but sticky: a status/list request made before a
 * binary install may have cached an "unconfigured" provider. Drop that cache
 * before reporting `done` so a model pull or first generation in the same CLI
 * process immediately sees the newly stamped executable.
 */
async function refreshNativeConsumer(ctx: EngineContext, engine: NativeEngineName): Promise<void> {
  if (engine === 'llama-server') {
    await ctx.recognition.reset();
  } else if (engine === 'sd-server') {
    await ctx.imageProvider.reset();
  } else if (engine === 'whisper-server') {
    await ctx.stt.reset();
  }
}
