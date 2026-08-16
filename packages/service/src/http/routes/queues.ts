/**
 * /api/queues — snapshot of every initialized provider's request
 * queue plus the TaskRunner's pending-handoff queue.
 *
 * Used by the app-header QueueMeter to surface "N turns queued on
 * Copilot" and (on click) a breakdown of what's running vs. pending.
 * Also doubles as a debug endpoint — `curl /api/queues` prints the
 * live state in JSON.
 *
 * Providers are only included when they've been lazily initialized
 * (a session has hit them). Uninitialized providers have no queue
 * yet and surfacing zeros for them would be misleading — we want
 * "copilot is busy" noise, not "ollama has 0 queued" clutter.
 */

import { Hono } from 'hono';
import type { ServiceContext } from '../context.js';
import {
  MACHINE_ENGINE_PROVIDER_NAMES,
  isMachineEngineProvider,
  userOwnedIdFromBroker,
  usesMachineEngine,
} from './machine-engine-proxy.js';

type ProviderName =
  | 'copilot'
  | 'openai'
  | 'anthropic'
  | 'anthropic-cli'
  | 'codex-cli'
  | 'ollama'
  | 'llama-cpp'
  | 'mlx'
  | 'ds4';

export function queueRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  const PROVIDER_NAMES: readonly ProviderName[] = [
    'copilot',
    'openai',
    'anthropic',
    'anthropic-cli',
    'codex-cli',
    'ollama',
    'llama-cpp',
    'mlx',
    'ds4',
  ];
  const PROVIDER_SET = new Set<string>(PROVIDER_NAMES);

  app.get('/', async (c) => {
    const providers: Record<string, unknown> = {};
    for (const name of PROVIDER_NAMES) {
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
        maxConcurrency: provider.batch?.maxConcurrency ?? 1,
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
      if (providers[name]) continue;
      providers[name] = summary;
    }
    // Per-session queue state from the SessionQueue layer (distinct
    // from the provider-level queues above). The timeline UI uses
    // this to seed its ghost-bubble state on mount, before any
    // queue_enqueued SSE event arrives.
    const sessions = ctx.chat.listQueued();
    // Engine-side prompt-cache stats per provider — fan-out target for
    // the EngineStatusPill's popover ("warm sessions: N, cache memory:
    // X MB"). Empty array when no controller is wired or no local
    // provider is initialized.
    let cache = ctx.chat.getCacheStats();
    // Claude CLI worker pool snapshot — drives the dedicated
    // `ClaudeCliPoolPill` in the header. Null when the provider hasn't
    // been initialized yet (no Claude CLI session has hit it).
    const [anthropicCliPool, localDeviceHealth] = await Promise.all([
      ctx.chat.getAnthropicCliPoolSnapshot(),
      ctx.gpuArbiter.getDeviceHealthStatus(),
    ]);
    // Night Shift context travels with the queue snapshot rather than as a
    // second poll: the QueueMeter needs it on every refresh to say when the
    // scheduled bucket picks up ("waiting for Night Shift · starts 22:00"),
    // or that the cloud quota reserve is holding it instead.
    const nightShift = {
      active: ctx.nightShift.isActive(),
      opensAt: ctx.nightShift.nextStartIso(),
      ...(ctx.nightShift.quotaHoldStatus() ? { quotaHold: true } : {}),
    };
    let deviceHealth = localDeviceHealth;

    // The product response is assembled HERE, in the user daemon. Only the
    // three broker-owned native provider queues/cache/device-health blocks are
    // imported from the machine service. Product state (cloud queues, session
    // ghosts, task handoffs, Night Shift, Claude CLI workers) never crosses
    // that boundary.
    if (usesMachineEngine(ctx)) {
      for (const name of MACHINE_ENGINE_PROVIDER_NAMES) delete providers[name];
      const bridge = ctx.machineEngine!;
      const upstream = await bridge.proxy(c.req.raw, '/api/queues', '/v1/remote/manage/queues');
      if (upstream.ok) {
        const broker = await upstream.json().catch(() => null);
        if (isRecord(broker)) {
          const brokerProviders = isRecord(broker.providers) ? broker.providers : {};
          for (const name of MACHINE_ENGINE_PROVIDER_NAMES) {
            const state = sanitizeBrokerProviderQueue(brokerProviders[name]);
            if (state) providers[name] = state;
          }
          if (Array.isArray(broker.cache)) cache = sanitizeBrokerCacheStats(broker.cache);
          if (isRecord(broker.deviceHealth)) {
            deviceHealth = broker.deviceHealth as unknown as typeof deviceHealth;
          }
        }
      }
    }

    return c.json({
      providers,
      taskRunner: { ...ctx.taskRunner.snapshot(), nightShift },
      sessions,
      cache,
      ...(deviceHealth ? { deviceHealth } : {}),
      ...(anthropicCliPool ? { anthropicCliPool } : {}),
      at: new Date().toISOString(),
    });
  });

  /**
   * Cancel a pending entry. The QueueMeter's per-item ✕ button calls
   * this. Returns `{cancelled: true}` when the entry was found and
   * removed, false when the id is unknown — typically because the
   * entry already started running between the user's poll and click.
   *
   * Resolution goes through `ChatManager.cancelProviderQueueItem`, which
   * checks the singleton `providers` map AND the engine pool — the
   * pool path is why on-device engines (llama-cpp / MLX / DS4), whose
   * queues the singleton `getProviderIfReady` can't see, are cancelable
   * at all. Reaching only the singleton here silently no-op'd the ✕ for
   * every pool-routed local turn.
   */
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

  /**
   * Reorder a pending entry within its lane (`'up'` / `'down'`). The
   * dispatcher is affinity-aware, so this nudges priority by adjusting
   * the entry's `enqueuedAt`; it's not a strict positional swap. Same
   * singleton-then-pool resolution as the cancel route above.
   */
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

function isRecord(value: unknown): value is Record<string, unknown> {
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

/** Reconstruct the public queue shape and translate every broker affinity id. */
function sanitizeBrokerProviderQueue(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const running = finiteNumber(value.running);
  const queuedInteractive = finiteNumber(value.queuedInteractive);
  const queuedBackground = finiteNumber(value.queuedBackground);
  const concurrency = finiteNumber(value.concurrency);
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
    ...(finiteNumber(value.interactiveConcurrency) !== undefined
      ? { interactiveConcurrency: finiteNumber(value.interactiveConcurrency) }
      : {}),
    ...(finiteNumber(value.backgroundConcurrency) !== undefined
      ? { backgroundConcurrency: finiteNumber(value.backgroundConcurrency) }
      : {}),
    ...(finiteNumber(value.maxConcurrency) !== undefined
      ? { maxConcurrency: finiteNumber(value.maxConcurrency) }
      : {}),
    active,
    pending,
  };
}

export function sanitizeBrokerCacheStats(
  values: unknown[],
): ReturnType<ServiceContext['chat']['getCacheStats']> {
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
  }) as ReturnType<ServiceContext['chat']['getCacheStats']>;
}
