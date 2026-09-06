import { providerQueueSnapshot } from './engine-queues.js';
import {
  isRecord,
  providerQueueControls,
  sanitizeBrokerCacheStats,
  sanitizeBrokerProviderQueue,
} from './engine-queues.js';
export { sanitizeBrokerCacheStats } from './engine-queues.js';
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
import { MACHINE_ENGINE_PROVIDER_NAMES, usesMachineEngine } from './machine-engine-proxy.js';

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

  app.get('/', async (c) => {
    const providers = providerQueueSnapshot(ctx, PROVIDER_NAMES);
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
  app.route('/', providerQueueControls(ctx, PROVIDER_NAMES));

  return app;
}
