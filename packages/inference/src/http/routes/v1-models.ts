import {
  type ChatModelManifest,
  type RecoDevice,
  docbenchScoreFor,
  estimateManifestKvBytes,
  externalGezelModelId,
  isRecommendedModel,
  llamaCppBackendExclusion,
  localContextFloorTokens,
  rateModelsForDevice,
  resolveDistributionProfile,
} from '@bendyline/gezel';
import type { AppModel } from '@bendyline/gezel/app-models';

/**
 * A manifest's docbench result for the engine an entry runs on, in the shape
 * `/v1/models` lists it; undefined when unmeasured or stale.
 */
function docbenchEntry(manifest: ChatModelManifest, engine: string): AppModel['docbench'] {
  if (docbenchScoreFor(manifest, engine) === undefined) return undefined;
  const measured = manifest.benchmarks?.docbench?.[engine];
  if (!measured) return undefined;
  return {
    score: measured.score,
    band: measured.band,
    version: measured.version,
    families: measured.families,
  };
}

/** `{ docbench }` to spread into an entry, or nothing. */
function withDocbench(manifest: ChatModelManifest, engine: string): Pick<AppModel, 'docbench'> {
  const docbench = docbenchEntry(manifest, engine);
  return docbench ? { docbench } : {};
}
import { resolveOnDeviceProvider } from '@bendyline/gezel/native';
import { Hono } from 'hono';
import { currentLlamaCppBackend } from '../../providers/llama-cpp/backend-health.js';
import { CapacityBroker } from '../../providers/native/capacity-broker.js';
import type { ProviderName } from '../../providers/types.js';
import { type MemoryProfile, detectMemoryProfileCached } from '../../system/memory.js';
import type { InferenceContext as ServiceContext } from '../inference-context.js';
import { appleSystemModel } from '../openai-compat/apple-model.js';
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

/**
 * Providers whose listing runs the person's own programs: the Claude and
 * Codex command lines are executed to read their models, and Ollama's port
 * is probed (and its app possibly launched). An app listing models must not
 * set those off on a machine whose owner never chose them (2026-11-04 and
 * 2026-11-08 npm ship audits), so they are listed only once chosen.
 */
const OPT_IN_PROVIDERS: ReadonlySet<ProviderName> = new Set([
  'anthropic-cli',
  'codex-cli',
  'ollama',
]);

/** The install's provider, a gezel's own provider, or that provider's own settings. */
export function providerChosen(
  provider: ProviderName,
  config: {
    provider?: string;
    anthropicCli?: object;
    codexCli?: object;
    ollamaBaseUrl?: string;
  } | null,
  gezels: ReadonlyArray<{ provider?: string }>,
): boolean {
  if (config?.provider === provider) return true;
  if (gezels.some((gezel) => gezel.provider === provider)) return true;
  if (provider === 'anthropic-cli') return config?.anthropicCli !== undefined;
  if (provider === 'codex-cli') return config?.codexCli !== undefined;
  if (provider === 'ollama') return config?.ollamaBaseUrl !== undefined;
  return true;
}

/**
 * Whether a model listing may enumerate `provider`. Every listing an app can
 * call goes through this: Ollama's `/tags` kept running the person's Claude
 * and Codex command lines after `/v1/models` stopped (1.26313.105 audit).
 */
export function providerListable(
  provider: ProviderName,
  config: Parameters<typeof providerChosen>[1],
  gezels: Parameters<typeof providerChosen>[2],
): boolean {
  return !OPT_IN_PROVIDERS.has(provider) || providerChosen(provider, config, gezels);
}

interface V1ModelsRouteOptions {
  /** List only on-device engines plus downloadable on-device catalog entries. */
  localOnly?: boolean;
  /**
   * This machine's memory, which downloadable entries are rated against.
   * Defaults to the cached probe `/api/system/memory` reads.
   */
  memoryProfile?: () => Promise<MemoryProfile>;
}

type CatalogBackend = 'llama-cpp' | 'mlx' | 'ds4';

type OpenAIModelEntry = AppModel;

/**
 * Engines that enforce `response_format` with a grammar: llama-server's
 * `json_schema`, and the MLX sidecar's llguidance JSON grammar
 * (`providers/mlx/python/response_format.py`). ds4 shares llama.cpp's request
 * map, but nothing here shows its server enforces a schema, so it is not
 * advertised.
 */
function enforcesResponseFormat(provider: string): boolean {
  return provider === 'llama-cpp' || provider === 'mlx';
}

function catalogCapabilities(
  manifest: ChatModelManifest,
  provider: string,
): NonNullable<AppModel['capabilities']> {
  return {
    text: true,
    tools: manifest.supportsTools,
    structuredOutput: enforcesResponseFormat(provider),
    images: false,
    foregroundOnly: false,
  };
}

function catalogBackend(manifest: ChatModelManifest): CatalogBackend | null {
  // ds4 has no portable fallback: `discoverNativeBinaries` stamps its binary
  // only where a build for this host is on disk, which is the gate the
  // Settings availability check reads too. Windows has none.
  const ds4 = manifest.ds4 && process.env.GEZEL_DS4_SERVER_BIN ? 'ds4' : null;
  // Store hosts have no provisioned Python runtime. Only advertise models
  // backed by bundled native engines until a frozen MLX runtime ships.
  const store = resolveDistributionProfile().pythonProvisioning === 'frozen-only';
  const llamaCpp =
    manifest.llamaCpp && !llamaCppBackendExclusion(manifest.llamaCpp, currentLlamaCppBackend());
  if (store) return llamaCpp ? 'llama-cpp' : ds4;
  const preferred = resolveOnDeviceProvider(process.platform, process.arch);
  if (preferred === 'mlx' && manifest.mlx && !manifest.mlx.disabledReason) return 'mlx';
  if (preferred === 'llama-cpp' && llamaCpp) return 'llama-cpp';
  if (llamaCpp) return 'llama-cpp';
  if (manifest.mlx && !manifest.mlx.disabledReason && process.platform === 'darwin') return 'mlx';
  return ds4;
}

/**
 * What loading a catalog model would hold, priced as the capacity broker
 * prices it: the catalog's measured pin when it has one, else the engine's
 * estimate, plus KV at the context floor this machine launches with. ds4's
 * figure already bounds its streamed working set, so it takes no extra KV.
 */
function footprintBytes(
  { manifest, provider, source }: DownloadCandidate,
  memory: MemoryProfile,
): number {
  const mmprojBytes = provider === 'llama-cpp' ? manifest.llamaCpp?.mmproj?.sizeBytes : undefined;
  const weights =
    source.residentBytes ??
    CapacityBroker.estimateResidentBytes(
      provider,
      source.approxSizeBytes,
      mmprojBytes ? { mmprojBytes } : undefined,
    );
  if (provider === 'ds4') return weights;
  const ctxTokens = localContextFloorTokens({
    totalRamBytes: memory.totalRamBytes,
    gpuVramBytes: fastGpuBytes(memory),
  });
  // MLX keeps its cache in f16; llama.cpp's default q8_0 is the helper's default.
  return (
    weights +
    estimateManifestKvBytes(manifest, {
      ctxTokens,
      ...(provider === 'mlx' ? { cacheScale: 1 } : {}),
    })
  );
}

/**
 * An integrated adapter's advertised allocation is shared system RAM, not a
 * fast pool beside it, so fit treats that host as RAM-paced (as Settings does).
 */
function fastGpuBytes(memory: MemoryProfile): number | null {
  return memory.gpuMemoryKind === 'integrated' ? null : memory.gpuVramBytes;
}

function recoDevice(memory: MemoryProfile): RecoDevice {
  return {
    platform: memory.platform,
    gpuVramBytes: fastGpuBytes(memory),
    gpuMemoryKind: memory.gpuMemoryKind,
    totalRamBytes: memory.totalRamBytes,
    usableBytes: memory.usableBytes,
    budgetBytes: memory.budgetBytes,
  };
}

interface DownloadCandidate {
  entry: OpenAIModelEntry;
  manifest: ChatModelManifest;
  provider: CatalogBackend;
  /** The engine block this entry would download. */
  source: { approxSizeBytes: number; residentBytes?: number; quantization?: string };
}

/** Curated order, for when this machine's memory could not be read. */
function byCuratedScore(a: DownloadCandidate, b: DownloadCandidate): number {
  const aRecommended = isRecommendedModel(a.manifest);
  const bRecommended = isRecommendedModel(b.manifest);
  if (aRecommended !== bRecommended) return aRecommended ? -1 : 1;
  const score = (b.manifest.recoScore ?? 0) - (a.manifest.recoScore ?? 0);
  return score || (a.entry.name ?? a.entry.id).localeCompare(b.entry.name ?? b.entry.id);
}

/**
 * Downloadable models, each rated against this machine (`fit`,
 * `recommendation`) and listed best first. A model too big to run here stays
 * listed with `fit.tier: 'too-big'` and a 0 score, so a client decides
 * whether to hide it.
 */
async function downloadableCatalogEntries(
  items: Awaited<ReturnType<ServiceContext['catalog']['list']>>,
  created: number,
  existingIds: ReadonlySet<string>,
  memoryProfile: () => Promise<MemoryProfile>,
): Promise<OpenAIModelEntry[]> {
  const candidates = items.flatMap<DownloadCandidate>((item) => {
    const manifest = item.manifest;
    if (manifest.kind !== 'chat-model') return [];
    const provider = catalogBackend(manifest);
    const source =
      provider === 'mlx' ? manifest.mlx : provider === 'ds4' ? manifest.ds4 : manifest.llamaCpp;
    if (!provider || !source) return [];
    const id = `${provider}:${manifest.id}`;
    if (existingIds.has(id)) return [];
    return [
      {
        manifest,
        provider,
        source,
        entry: {
          id,
          object: 'model',
          created,
          owned_by: provider,
          name: manifest.name,
          availability: 'download-required',
          preparation: 'app-download',
          reason_code: 'model_download_required',
          recovery_actions: ['prepare'],
          locality: 'on-device',
          download_bytes: manifest.approxSizeBytes,
          ...(manifest.contextWindow ? { context_window: manifest.contextWindow } : {}),
          capabilities: catalogCapabilities(manifest, provider),
          ...withDocbench(manifest, provider),
        },
      },
    ];
  });
  if (candidates.length === 0) return [];

  const memory = await memoryProfile().catch(() => null);
  if (!memory) return candidates.sort(byCuratedScore).map(({ entry }) => entry);

  const rated = candidates.map((candidate) => {
    const { entry, manifest, source, provider } = candidate;
    const docbench = docbenchScoreFor(manifest, provider);
    return {
      id: entry.id,
      residentBytes: footprintBytes(candidate, memory),
      tags: manifest.tags,
      supportsTools: manifest.supportsTools,
      ...(manifest.recoScore !== undefined ? { recoScore: manifest.recoScore } : {}),
      ...(manifest.licenseClass ? { licenseClass: manifest.licenseClass } : {}),
      ...(source.quantization ? { quantization: source.quantization } : {}),
      ...(docbench !== undefined ? { docbench } : {}),
    };
  });
  const entries = new Map(candidates.map(({ entry }) => [entry.id, entry]));
  const device = recoDevice(memory);
  // A second ranking, for document work, only when anything is measured:
  // otherwise every model would tie and the field would say nothing.
  const forDocuments = rated.some((model) => model.docbench !== undefined)
    ? new Map(
        rateModelsForDevice(rated, device, { quality: 'docbench' }).map((rating) => [
          rating.id,
          { score: rating.score, recommended: rating.recommended },
        ]),
      )
    : null;
  return rateModelsForDevice(rated, device).flatMap((rating) => {
    const entry = entries.get(rating.id);
    if (!entry) return [];
    const docbenchRecommendation = forDocuments?.get(rating.id);
    return [
      {
        ...entry,
        fit: { tier: rating.fit.tier, label: rating.fit.label, detail: rating.fit.detail },
        recommendation: { score: rating.score, recommended: rating.recommended },
        ...(docbenchRecommendation ? { docbench_recommendation: docbenchRecommendation } : {}),
      },
    ];
  });
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
  const config = options.localOnly ? null : await ctx.store.readConfig().catch(() => null);
  const gezels =
    options.localOnly || !ctx.store.listGezels ? [] : await ctx.store.listGezels().catch(() => []);
  let gezelEntries: OpenAIModelEntry[] = [];
  if (!options.localOnly && ctx.store.listGezels) {
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

  const catalogItems = await ctx.catalog.list('chat-model').catch(() => []);
  // An installed model carries the capabilities its catalog entry
  // advertised before download; a model with no entry stays unflagged
  // rather than guessing its tools or images support.
  const manifests = new Map<string, ChatModelManifest>();
  for (const item of catalogItems)
    if (item.manifest.kind === 'chat-model') manifests.set(item.manifest.id, item.manifest);
  const providers = (options.localOnly ? LOCAL_PROVIDERS : PROVIDERS_TO_ENUMERATE).filter(
    (provider) =>
      (provider !== 'mlx' || resolveDistributionProfile().pythonProvisioning !== 'frozen-only') &&
      providerListable(provider, config, gezels),
  );
  const buckets = await Promise.all(
    providers.map(async (provider) => {
      try {
        const models = await ctx.chat.listModelsForProvider(provider);
        return models.map<OpenAIModelEntry>((m) => ({
          id: `${provider}:${m.id}`,
          object: 'model' as const,
          created,
          owned_by: provider,
          ...(provider === 'llama-cpp' || provider === 'mlx' || provider === 'ds4'
            ? {
                availability: 'available' as const,
                locality: 'on-device' as const,
                preparation: 'app-download' as const,
              }
            : {}),
          ...(m.contextWindow ? { context_window: m.contextWindow } : {}),
          ...(m.supportsReasoning ? { supports_reasoning: true } : {}),
          ...(enforcesResponseFormat(provider) && manifests.has(m.id)
            ? { capabilities: catalogCapabilities(manifests.get(m.id)!, provider) }
            : {}),
          ...(manifests.has(m.id) ? withDocbench(manifests.get(m.id)!, provider) : {}),
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
  const downloadable = await downloadableCatalogEntries(
    catalogItems,
    created,
    existingIds,
    options.memoryProfile ?? (() => detectMemoryProfileCached()),
  );
  const apple = await appleSystemModel(created);
  return [...gezelEntries, ...apple, ...availableEntries, ...downloadable];
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
