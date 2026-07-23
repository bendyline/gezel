import { Hono } from 'hono';
import { startOllamaIfPossible } from '../../providers/ollama-launch.js';
import type { ModelInfo, ProviderName } from '../../providers/types.js';
import type { ServiceContext } from '../context.js';

const VALID_PROVIDERS: readonly ProviderName[] = [
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

/**
 * Resolve a `?provider=` query string to a known {@link ProviderName}.
 * Anything we don't recognize falls back to copilot — keeps existing
 * callers that omit the param working, while letting on-device
 * providers (`llama-cpp`, `mlx`) actually probe their own engine
 * instead of being silently mis-routed to Copilot.
 */
function parseProvider(qp: string | undefined): ProviderName {
  return VALID_PROVIDERS.includes(qp as ProviderName) ? (qp as ProviderName) : 'copilot';
}

/** 5-minute in-memory cache so tab changes / reopening Settings don't hammer the upstream APIs. */
const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  at: number;
  models: ModelInfo[];
}

const cache = new Map<ProviderName, CacheEntry>();

/**
 * Wrap `chat.listModelsForProvider` with an Ollama auto-start fallback.
 * If the first list-models call fails AND the provider is Ollama AND
 * auto-start is enabled, try to launch the daemon then retry.
 *
 * Used by both the model-picker route (`GET /api/models`) and the
 * connection-test route (`GET /api/models/test`). Without auto-start
 * here, switching the AI provider to Ollama in Settings always
 * surfaces "failed to load" the first time — even though the user has
 * Ollama installed and the desktop app could be launched on their
 * behalf.
 *
 * Returns `{ models, autoStarted }` on success or `{ error }` on
 * failure. `autoStarted` is true when the helper had to launch the
 * daemon to make the call succeed; the route forwards this so the
 * UI can surface "Ollama just launched in the background."
 */
async function listModelsWithOllamaAutoStart(
  ctx: ServiceContext,
  provider: ProviderName,
): Promise<
  { kind: 'ok'; models: ModelInfo[]; autoStarted: boolean } | { kind: 'error'; error: string }
> {
  try {
    const models = await ctx.chat.listModelsForProvider(provider);
    return { kind: 'ok', models, autoStarted: false };
  } catch (err) {
    if (provider !== 'ollama') {
      return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
    }
    const config = await ctx.store.readConfig();
    if (config.autoStartOllama === false) {
      return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
    }
    const baseUrl = (config.ollamaBaseUrl || 'http://localhost:11434').replace(/\/+$/, '');
    const launch = await startOllamaIfPossible(baseUrl);
    if (!launch.started) {
      return { kind: 'error', error: err instanceof Error ? err.message : String(err) };
    }
    try {
      const models = await ctx.chat.listModelsForProvider(provider);
      return { kind: 'ok', models, autoStarted: true };
    } catch (innerErr) {
      return {
        kind: 'error',
        error: innerErr instanceof Error ? innerErr.message : String(innerErr),
      };
    }
  }
}

export function modelsRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const provider = parseProvider(c.req.query('provider'));
    const force = c.req.query('refresh') === '1';

    if (!force) {
      const hit = cache.get(provider);
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        return c.json({ provider, models: hit.models, cached: true });
      }
    }

    const result = await listModelsWithOllamaAutoStart(ctx, provider);
    if (result.kind === 'error') {
      // This endpoint populates a picker across optional providers. A provider
      // being unconfigured, stopped, or unavailable is a normal empty state,
      // not a daemon failure. The explicit `/test` endpoint below retains the
      // diagnostic message for Settings.
      return c.json({ provider, models: [] });
    }
    cache.set(provider, { at: Date.now(), models: result.models });
    return c.json({
      provider,
      models: result.models,
      ...(result.autoStarted ? { autoStarted: true } : {}),
    });
  });

  /**
   * Probe whether the configured credentials for a provider actually work.
   * Drives the "green checkmark" on the Home tab's onboarding section. Always
   * returns 200 with `{ok, modelCount?, error?}` so the UI can show the
   * failure message inline instead of treating it like an HTTP error.
   */
  app.get('/test', async (c) => {
    const provider = parseProvider(c.req.query('provider'));
    const result = await listModelsWithOllamaAutoStart(ctx, provider);
    if (result.kind === 'error') {
      return c.json({ ok: false as const, provider, error: result.error });
    }
    cache.set(provider, { at: Date.now(), models: result.models });
    return c.json({
      ok: true as const,
      provider,
      modelCount: result.models.length,
      ...(result.autoStarted ? { autoStarted: true } : {}),
    });
  });

  return app;
}

/** Allow the config route to invalidate the cache after credential changes. */
export function invalidateModelsCache(provider?: ProviderName): void {
  if (provider) cache.delete(provider);
  else cache.clear();
}
