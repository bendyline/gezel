import { Hono } from 'hono';
import { liveProviderConcurrency } from '../../providers/native/provider-pool.js';
import type { ProviderName } from '../../providers/types.js';
import type { EngineContext } from '../engine-context.js';
import {
  MACHINE_ENGINE_PROVIDER_NAMES,
  isMachineEngineProvider,
  userOwnedIdFromBroker,
  usesMachineEngine,
} from './machine-engine-proxy.js';
export function providerQueueControls(ctx: EngineContext, names: readonly ProviderName[]): Hono {
  const app = new Hono();
  const PROVIDER_SET = new Set<string>(names);
  app.delete('/:provider/:id', async (c) => {
    const provider = c.req.param('provider');
    if (!PROVIDER_SET.has(provider)) {
      return c.json({ error: `unknown provider: ${provider}` }, 404);
    }
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'id must be a number' }, 400);
    if (isMachineEngineProvider(provider) && usesMachineEngine(ctx)) {
      return ctx.machineEngine!.proxy(c.req.raw, '/api/queues', '/v1/remote/manage/queues');
    }
    const cancelled = ctx.chat.cancelProviderQueueItem(provider as ProviderName, id);
    return c.json({ cancelled });
  });
  app.post('/:provider/:id/move', async (c) => {
    const provider = c.req.param('provider');
    if (!PROVIDER_SET.has(provider)) {
      return c.json({ error: `unknown provider: ${provider}` }, 404);
    }
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'id must be a number' }, 400);
    if (isMachineEngineProvider(provider) && usesMachineEngine(ctx)) {
      return ctx.machineEngine!.proxy(c.req.raw, '/api/queues', '/v1/remote/manage/queues');
    }
    const body = await c.req.json().catch(() => null);
    const direction = (body && typeof body === 'object' ? body.direction : null) as
      | 'up'
      | 'down'
      | null;
    if (direction !== 'up' && direction !== 'down') {
      return c.json({ error: "direction must be 'up' or 'down'" }, 400);
    }
    const moved = ctx.chat.moveProviderQueueItem(provider as ProviderName, id, direction);
    return c.json({ moved });
  });
  return app;
}
export function engineQueueRoutes(ctx: EngineContext): Hono {
  const app = new Hono();
  app.get('/', async (c) => {
    const providers = providerQueueSnapshot(ctx, MACHINE_ENGINE_PROVIDER_NAMES);
    const deviceHealth = await ctx.gpuArbiter.getDeviceHealthStatus();
    return c.json({
      providers,
      cache: ctx.chat.getCacheStats(),
      ...(deviceHealth ? { deviceHealth } : {}),
      at: new Date().toISOString(),
    });
  });
  app.route('/', providerQueueControls(ctx, MACHINE_ENGINE_PROVIDER_NAMES));
  return app;
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function brokerIdentityFields(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['sessionId', 'gezelId', 'projectId'] as const) {
    if (typeof value[key] === 'string') out[key] = userOwnedIdFromBroker(value[key]);
  }
  if (typeof value.actorLabel === 'string') out.actorLabel = value.actorLabel;
  if (typeof value.job === 'string') out.job = value.job;
  return out;
}
export function sanitizeBrokerProviderQueue(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const running = finiteNumber(value.running);
  const queuedInteractive = finiteNumber(value.queuedInteractive);
  const queuedBackground = finiteNumber(value.queuedBackground);
  const concurrency = finiteNumber(value.concurrency);
  const interactiveConcurrency = finiteNumber(value.interactiveConcurrency);
  const reportedMaxConcurrency = finiteNumber(value.maxConcurrency);
  if (
    running === undefined ||
    queuedInteractive === undefined ||
    queuedBackground === undefined ||
    concurrency === undefined
  ) {
    return null;
  }
  const active = Array.isArray(value.active)
    ? value.active.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const runningForMs = finiteNumber(entry.runningForMs);
        if (runningForMs === undefined) return [];
        return [{ ...brokerIdentityFields(entry), runningForMs }];
      })
    : [];
  const pending = Array.isArray(value.pending)
    ? value.pending.flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const id = finiteNumber(entry.id);
        const waitedMs = finiteNumber(entry.waitedMs);
        const lane = entry.lane;
        if (
          id === undefined ||
          waitedMs === undefined ||
          (lane !== 'interactive' && lane !== 'background')
        ) {
          return [];
        }
        return [
          {
            id,
            lane,
            ...(entry.ambient === true ? { ambient: true } : {}),
            ...brokerIdentityFields(entry),
            waitedMs,
          },
        ];
      })
    : [];
  return {
    running,
    // Optional so an older broker that predates the lane split still
    // sanitizes; the pill falls back to `running` when they are absent.
    ...(finiteNumber(value.runningInteractive) !== undefined
      ? { runningInteractive: finiteNumber(value.runningInteractive) }
      : {}),
    ...(finiteNumber(value.runningBackground) !== undefined
      ? { runningBackground: finiteNumber(value.runningBackground) }
      : {}),
    queuedInteractive,
    queuedBackground,
    concurrency,
    ...(finiteNumber(value.ambientHeld) !== undefined
      ? { ambientHeld: finiteNumber(value.ambientHeld) }
      : {}),
    ...(interactiveConcurrency !== undefined ? { interactiveConcurrency } : {}),
    ...(finiteNumber(value.backgroundConcurrency) !== undefined
      ? { backgroundConcurrency: finiteNumber(value.backgroundConcurrency) }
      : {}),
    ...(reportedMaxConcurrency !== undefined || interactiveConcurrency !== undefined
      ? {
          // Tolerate a rolling-upgrade broker that reports a stale serial
          // batch fallback beside a wider live interactive queue. The queue
          // cap is never the extra logical background lane, so it is safe to
          // use as the compatible floor for the displayed engine width.
          maxConcurrency: Math.max(1, reportedMaxConcurrency ?? 0, interactiveConcurrency ?? 0),
        }
      : {}),
    active,
    pending,
  };
}
export function sanitizeBrokerCacheStats(
  values: unknown[],
): ReturnType<EngineContext['chat']['getCacheStats']> {
  return values.flatMap((value) => {
    if (!isRecord(value)) return [];
    const sessions = Array.isArray(value.sessions)
      ? value.sessions.flatMap((session) => {
          if (!isRecord(session) || typeof session.sessionId !== 'string') return [];
          return [
            {
              ...session,
              sessionId: userOwnedIdFromBroker(session.sessionId),
              ...(typeof session.gezelId === 'string'
                ? { gezelId: userOwnedIdFromBroker(session.gezelId) }
                : {}),
            },
          ];
        })
      : [];
    const gezels = Array.isArray(value.gezels)
      ? value.gezels.map((gezel) =>
          isRecord(gezel) && typeof gezel.gezelId === 'string'
            ? { ...gezel, gezelId: userOwnedIdFromBroker(gezel.gezelId) }
            : gezel,
        )
      : value.gezels;
    return [{ ...value, sessions, ...(gezels !== undefined ? { gezels } : {}) }];
  }) as ReturnType<EngineContext['chat']['getCacheStats']>;
}

export function providerQueueSnapshot(
  ctx: EngineContext,
  names: readonly ProviderName[],
): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const name of names) {
    const provider = ctx.chat.getProviderIfReady(name);
    if (!provider?.queue) continue;
    // `maxConcurrency` is the engine's true concurrent-generation width
    // (its batch capability): 1 for a serial engine like MLX today, the
    // `--parallel` slot count for llama-cpp with batched inference on.
    // Distinct from the queue's `concurrency`, which can be bumped for
    // ask-overlap without the engine actually generating in parallel.
    // The EngineStatusPill surfaces it as "N concurrent sessions".
    providers[name] = {
      ...provider.queue.describe(),
      maxConcurrency: liveProviderConcurrency(provider),
    };
  }
  // Fold in pooled local-engine replicas. Local providers (llama-cpp /
  // MLX / DS4) run through the engine pool, not the singleton map above, so
  // their queues — including background one-shots like digest / about /
  // memory work — are invisible to `getProviderIfReady`. Without this
  // the EngineStatusPill read "Idle" while the GPU decoded a one-shot.
  // A seeded singleton (test injection, GEZEL_MOCK_PROVIDER) wins if one
  // already reported the provider.
  for (const [name, summary] of ctx.chat.localEngineQueueSummaries()) {
    if (providers[name] || !names.includes(name)) continue;
    providers[name] = summary;
  }

  return providers;
}
