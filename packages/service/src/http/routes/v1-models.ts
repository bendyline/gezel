import { Hono } from 'hono';
import type { ProviderName } from '../../providers/types.js';
import type { ServiceContext } from '../context.js';

/**
 * `/v1/models` — OpenAI-compatible model directory aggregated across
 * every gezel provider that's currently configured, plus the retrieve
 * form (`GET /v1/models/{id}`) OpenAI SDKs call after listing.
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
  owned_by: ProviderName | 'gezel';
  /** Gezel-specific extras useful to richer clients; ignored by strict OpenAI SDKs. */
  context_window?: number;
  supports_reasoning?: boolean;
}

async function buildModelEntries(
  ctx: ServiceContext,
  created: number,
): Promise<OpenAIModelEntry[]> {
  // When a serving gezel is designated (Settings → Connected Apps),
  // list them FIRST — clients that pick the top entry from the model
  // list land on the gezel the user chose to answer outside apps.
  const servingEntry: OpenAIModelEntry[] = [];
  try {
    const config = await ctx.store.readConfig();
    const servingGezelId = config.openaiEndpoints?.servingGezelId;
    if (servingGezelId) {
      const gezel = await ctx.store.getGezel(servingGezelId).catch(() => null);
      if (gezel) {
        servingEntry.push({
          id: `gezel:${gezel.name}`,
          object: 'model',
          created,
          owned_by: 'gezel',
        });
      }
    }
  } catch {
    /* config unreadable — serve the provider roster alone */
  }
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
  return [...servingEntry, ...buckets.flat()];
}

export function v1ModelsRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const created = Math.floor(Date.now() / 1000);
    const data = await buildModelEntries(ctx, created);
    return c.json({ object: 'list', data });
  });

  // Retrieve form. The `{.+}` pattern keeps colons and slashes inside
  // the id (model ids like `ollama:llama3.1:8b` carry both).
  app.get('/:id{.+}', async (c) => {
    const id = c.req.param('id');
    const created = Math.floor(Date.now() / 1000);
    const entries = await buildModelEntries(ctx, created);
    const found = entries.find((m) => m.id === id);
    if (!found) {
      return c.json(
        {
          error: {
            message: `Model "${id}" not found — see GET /v1/models for the available ids.`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        },
        404,
      );
    }
    return c.json(found);
  });

  return app;
}
