import { type ChatModelManifest, externalGezelModelId, isRecommendedModel } from '@bendyline/gezel';
import { resolveOnDeviceProvider } from '@bendyline/gezel/native';
import { Hono } from 'hono';
import type { ProviderName } from '../../providers/types.js';
import type { ServiceContext } from '../context.js';
import { resolveFallbackGezelId } from '../openai-compat/chat-target.js';

/**
 * `/v1/models` — OpenAI-compatible model directory aggregated across
 * the user's gezels and every configured provider, plus the retrieve
 * form (`GET /v1/models/{id}`) OpenAI SDKs call after listing.
 *
 * Gezel entries use `gezel:<role>-<name>` ids and carry `name` +
 * `role` metadata for richer clients. Raw model entries use qualified
 * `<provider>:<model>` ids. Both shapes are accepted by
 * `/v1/chat/completions`; the effective fallback gezel leads the list.
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
  'ds4',
];
const LOCAL_PROVIDERS: readonly ProviderName[] = ['llama-cpp', 'mlx', 'ds4'];

interface V1ModelsRouteOptions {
  /** List only on-device engines plus downloadable on-device catalog entries. */
  localOnly?: boolean;
}

interface OpenAIModelEntry {
  id: string;
  object: 'model';
  created: number;
  owned_by: ProviderName | 'gezel';
  /** Gezel-specific extras useful to richer clients; ignored by strict OpenAI SDKs. */
  context_window?: number;
  supports_reasoning?: boolean;
  gezel_id?: string;
  name?: string;
  role?: string;
  is_fallback?: boolean;
  availability?: 'available' | 'download-required';
  locality?: 'on-device';
  download_bytes?: number;
  capabilities?: {
    text: boolean;
    tools: boolean;
    structuredOutput: boolean;
    images: boolean;
    foregroundOnly: boolean;
  };
}

function catalogBackend(manifest: ChatModelManifest): 'llama-cpp' | 'mlx' | 'ds4' | null {
  const preferred = resolveOnDeviceProvider(process.platform, process.arch);
  if (preferred === 'mlx' && manifest.mlx && !manifest.mlx.disabledReason) return 'mlx';
  if (preferred === 'llama-cpp' && manifest.llamaCpp) return 'llama-cpp';
  if (manifest.llamaCpp) return 'llama-cpp';
  if (manifest.mlx && !manifest.mlx.disabledReason && process.platform === 'darwin') return 'mlx';
  if (manifest.ds4) return 'ds4';
  return null;
}

async function downloadableCatalogEntries(
  ctx: ServiceContext,
  created: number,
  existingIds: ReadonlySet<string>,
): Promise<OpenAIModelEntry[]> {
  const items = await ctx.catalog.list('chat-model').catch(() => []);
  return items
    .flatMap<{ entry: OpenAIModelEntry; manifest: ChatModelManifest }>((item) => {
      const manifest = item.manifest;
      if (manifest.kind !== 'chat-model') return [];
      const provider = catalogBackend(manifest);
      if (!provider) return [];
      const id = `${provider}:${manifest.id}`;
      if (existingIds.has(id)) return [];
      return [
        {
          manifest,
          entry: {
            id,
            object: 'model',
            created,
            owned_by: provider,
            name: manifest.name,
            availability: 'download-required',
            locality: 'on-device',
            download_bytes: manifest.approxSizeBytes,
            ...(manifest.contextWindow ? { context_window: manifest.contextWindow } : {}),
            capabilities: {
              text: true,
              tools: manifest.supportsTools,
              structuredOutput: false,
              images: false,
              foregroundOnly: false,
            },
          },
        },
      ];
    })
    .sort((a, b) => {
      const aRecommended = isRecommendedModel(a.manifest);
      const bRecommended = isRecommendedModel(b.manifest);
      if (aRecommended !== bRecommended) return aRecommended ? -1 : 1;
      const score = (b.manifest.recoScore ?? 0) - (a.manifest.recoScore ?? 0);
      return score || (a.entry.name ?? a.entry.id).localeCompare(b.entry.name ?? b.entry.id);
    })
    .map(({ entry }) => entry);
}

async function buildModelEntries(
  ctx: ServiceContext,
  created: number,
  options: V1ModelsRouteOptions,
): Promise<OpenAIModelEntry[]> {
  // Advertise every gezel as a selectable OpenAI "model". Keep the
  // effective fallback first because a number of generic clients pick
  // the first entry by default. Role + name form the human-readable
  // routing id; `gezel_id` remains stable metadata for richer integrations.
  let gezelEntries: OpenAIModelEntry[] = [];
  if (!options.localOnly) {
    const config = await ctx.store.readConfig().catch(() => null);
    const gezels = await ctx.store.listGezels().catch(() => []);
    const fallbackGezelId = await resolveFallbackGezelId(
      ctx,
      config?.openaiEndpoints?.servingGezelId,
    );
    gezelEntries = [...gezels]
      .sort((a, b) => {
        if (a.id === fallbackGezelId) return -1;
        if (b.id === fallbackGezelId) return 1;
        return a.name.localeCompare(b.name);
      })
      .map<OpenAIModelEntry>((gezel) => ({
        id: externalGezelModelId(gezel),
        object: 'model',
        created,
        owned_by: 'gezel',
        gezel_id: gezel.id,
        name: gezel.name,
        ...(gezel.role ? { role: gezel.role } : {}),
        ...(gezel.id === fallbackGezelId ? { is_fallback: true } : {}),
      }));
  }

  const buckets = await Promise.all(
    (options.localOnly ? LOCAL_PROVIDERS : PROVIDERS_TO_ENUMERATE).map(async (provider) => {
      try {
        const models = await ctx.chat.listModelsForProvider(provider);
        return models.map<OpenAIModelEntry>((m) => ({
          id: `${provider}:${m.id}`,
          object: 'model' as const,
          created,
          owned_by: provider,
          ...(provider === 'llama-cpp' || provider === 'mlx' || provider === 'ds4'
            ? { availability: 'available' as const, locality: 'on-device' as const }
            : {}),
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
  const availableEntries = buckets.flat();
  const existingIds = new Set([...gezelEntries, ...availableEntries].map((entry) => entry.id));
  const downloadable = await downloadableCatalogEntries(ctx, created, existingIds);
  return [...gezelEntries, ...availableEntries, ...downloadable];
}

export function v1ModelsRoutes(ctx: ServiceContext, options: V1ModelsRouteOptions = {}): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const created = Math.floor(Date.now() / 1000);
    const data = await buildModelEntries(ctx, created, options);
    return c.json({ object: 'list', data });
  });

  // Retrieve form. The `{.+}` pattern keeps colons and slashes inside
  // the id (model ids like `ollama:llama3.1:8b` carry both).
  app.get('/:id{.+}', async (c) => {
    const id = c.req.param('id');
    const created = Math.floor(Date.now() / 1000);
    const entries = await buildModelEntries(ctx, created, options);
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
