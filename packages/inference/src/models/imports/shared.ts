/**
 * Pieces every model import shares, whatever the source: how big the model
 * runs on this machine, and where its settings come from.
 */

import {
  type ChatModelManifest,
  type GgufChoice,
  type ModelFitResult,
  type ModelImportTuning,
  type SamplingBlock,
  computeModelFit,
  estimateLlamaCppResidentBytes,
  estimateManifestKvBytes,
  estimateMlxResidentBytes,
  findTuningDonor,
  localContextFloorTokens,
  samplingFromGenerationConfig,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { MemoryProfile } from '../../system/memory.js';
import { fetchHubSmallFile } from './hub.js';

export interface KvGeometry {
  kvBytesPerTokenF16?: number;
  kvFixedBytesF16?: number;
}

function fitMachine(memory: MemoryProfile) {
  return {
    usableBytes: memory.usableBytes,
    totalRamBytes: memory.totalRamBytes,
    gpuVramBytes: memory.gpuMemoryKind === 'integrated' ? null : memory.gpuVramBytes,
    admissibleBytes: memory.budgetBytes,
  };
}

/**
 * Fit on this machine, priced the way the model download list prices a
 * catalog entry: weights (plus projector) at the engine's multiplier, plus KV
 * at the context floor this machine launches with.
 */
export function importFit(opts: {
  engine: 'llama-cpp' | 'mlx';
  weightsBytes: number;
  projectorBytes?: number;
  kv: KvGeometry | undefined;
  moe: boolean;
  memory: MemoryProfile | null;
}): ModelFitResult | undefined {
  const { memory } = opts;
  if (!memory) return undefined;
  const machine = fitMachine(memory);
  const kv = opts.kv?.kvBytesPerTokenF16
    ? estimateManifestKvBytes(
        {
          kvBytesPerTokenF16: opts.kv.kvBytesPerTokenF16,
          ...(opts.kv.kvFixedBytesF16 !== undefined
            ? { kvFixedBytesF16: opts.kv.kvFixedBytesF16 }
            : {}),
        },
        {
          ctxTokens: localContextFloorTokens({
            totalRamBytes: machine.totalRamBytes,
            gpuVramBytes: machine.gpuVramBytes,
          }),
          // llama.cpp caches at q8_0 by default; MLX keeps f16.
          cacheScale: opts.engine === 'mlx' ? 1 : 0.55,
        },
      )
    : 0;
  const weights =
    opts.engine === 'mlx'
      ? estimateMlxResidentBytes(opts.weightsBytes)
      : estimateLlamaCppResidentBytes(opts.weightsBytes, {
          ...(opts.projectorBytes ? { mmprojBytes: opts.projectorBytes } : {}),
        });
  return computeModelFit({ residentBytes: weights + kv, isMoE: opts.moe, ...machine });
}

export function ggufChoiceFit(
  choice: GgufChoice,
  kv: KvGeometry | undefined,
  moe: boolean,
  projectorBytes: number | undefined,
  memory: MemoryProfile | null,
): ModelFitResult | undefined {
  return importFit({
    engine: 'llama-cpp',
    weightsBytes: choice.sizeBytes,
    ...(projectorBytes ? { projectorBytes } : {}),
    kv,
    moe,
    memory,
  });
}

/** Every curated chat model in the catalog (imports excluded by the donor rule). */
export async function catalogChatModels(catalog: CatalogService): Promise<ChatModelManifest[]> {
  const items = await catalog.list('chat-model').catch(() => []);
  return items
    .filter((item) => item.sourceId !== 'imported' && item.manifest.kind === 'chat-model')
    .map((item) => item.manifest as ChatModelManifest);
}

export interface ImportSettings {
  /** A curated entry to borrow settings from, live. */
  donor?: ChatModelManifest;
  /** The author's recommended sampling, recorded in the entry. */
  sampling?: SamplingBlock;
  tuning: ModelImportTuning;
}

/**
 * Where an imported model's settings come from: a curated entry built from
 * the same base model; else the sampling its author recommends (the repo's
 * own `generation_config.json`, then the base model's); else the defaults.
 */
export async function resolveImportSettings(opts: {
  catalog: CatalogService;
  baseModels: string[];
  engine: 'llama-cpp' | 'mlx';
  parameterSize?: string;
  /** A `generation_config.json` the import already read. */
  generationConfig?: unknown;
  /** Read the base models' configs from the Hub (not for local files). */
  fetchImpl?: typeof fetch;
}): Promise<ImportSettings> {
  const donor = findTuningDonor(await catalogChatModels(opts.catalog), opts.baseModels, {
    engine: opts.engine,
    ...(opts.parameterSize ? { parameterSize: opts.parameterSize } : {}),
  });
  if (donor) {
    return {
      donor,
      tuning: { from: 'catalog', catalogId: donor.id, catalogName: donor.name },
    };
  }
  let sampling = samplingFromGenerationConfig(opts.generationConfig);
  if (!sampling && opts.fetchImpl) {
    for (const base of opts.baseModels.slice(0, 2)) {
      const raw = await fetchHubSmallFile(
        opts.fetchImpl,
        base,
        'main',
        'generation_config.json',
        64 * 1024,
      )
        .then((bytes) => JSON.parse(bytes.toString('utf8')) as unknown)
        .catch(() => undefined);
      sampling = samplingFromGenerationConfig(raw);
      if (sampling) break;
    }
  }
  return sampling ? { sampling, tuning: { from: 'author' } } : { tuning: { from: 'defaults' } };
}
