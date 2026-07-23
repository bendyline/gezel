import { Hono } from 'hono';
import type { ProviderName } from '../../providers/types.js';
import type { ServiceContext } from '../context.js';

/**
 * `/v1/models` — OpenAI-compatible model directory aggregated across
 * every gezel provider that's currently configured.
 *
 * Each entry's `id` is the qualified `<provider>:<model>` string that
 * `/v1/chat/completions` accepts. The `owned_by` field surfaces the
 * provider name so client UIs can group by source.
 *
 * Providers that haven't been credentialed (e.g. `openai` without an
 * API key) throw on `listModels` — we swallow those silently and emit
 * what we can. The Settings UI is where users discover that a provider
 * needs setup.
 */
const PROVIDERS_TO_ENUMERATE: readonly ProviderName[] = [
  'copilot',
  'openai',
  'anthropic',
  'anthropic-cli',
  'codex-cli',
  'ollama',
  'llama-cpp',
  'mlx',
];

interface OpenAIModelEntry {
  id: string;
  object: 'model';
  created: number;
  owned_by: ProviderName;
  /** Gezel-specific extras useful to richer clients; ignored by strict OpenAI SDKs. */
  context_window?: number;
  supports_reasoning?: boolean;
}

export function v1ModelsRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const created = Math.floor(Date.now() / 1000);
    const buckets = await Promise.all(
      PROVIDERS_TO_ENUMERATE.map(async (provider) => {
        try {
          const models = await ctx.chat.listModelsForProvider(provider);
          return models.map<OpenAIModelEntry>((m) => ({
            id: `${provider}:${m.id}`,
            object: 'model' as const,
            created,
            owned_by: provider,
            ...(m.contextWindow ? { context_window: m.contextWindow } : {}),
            ...(m.supportsReasoning ? { supports_reasoning: true } : {}),
          }));
        } catch {
          // Provider not configured / not available on this host —
          // skip silently rather than failing the whole listing.
          return [];
        }
      }),
    );

    const data = buckets.flat();
    return c.json({ object: 'list', data });
  });

  return app;
}
