import type {
  CatalogItemSummary,
  ChatModelManifest,
  MediaFitVerdict,
  MediaModelFitResponse,
  NativeEngineName,
  RecoDevice,
} from '@bendyline/gezel';
import {
  computeModelFit,
  formatModelAttribution,
  isMoEFromTags,
  isRecommendedModel,
  lowBitScoreFactor,
  pickRecommendedModel,
} from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';

export type BootstrapChatProvider = 'llama-cpp' | 'mlx';

export interface BootstrapChatModel {
  id: string;
  name: string;
  provider: BootstrapChatProvider;
  approxSizeBytes: number;
  residentBytes: number;
  recoScore: number;
  /** The engine block's quantization tag; a 1- or 2-bit quant ranks lower. */
  quantization?: string;
  fit: 'fits' | 'fits-offload' | 'tight' | 'too-big';
  attribution: string;
}

export type AccessoryKind = 'image' | 'recognition' | 'stt' | 'tts' | 'video';

export interface BootstrapAccessoryModel {
  kind: AccessoryKind;
  id: string;
  name: string;
  approxSizeBytes: number;
  requiredEngine?: NativeEngineName;
}

export interface AccessoryInputs {
  imageItems: CatalogItemSummary[];
  videoItems: CatalogItemSummary[];
  audio: {
    stt: Array<AccessoryCatalogModel>;
    tts: Array<AccessoryCatalogModel>;
  };
  recognition: Array<AccessoryCatalogModel>;
  installed: Partial<Record<AccessoryKind, ReadonlySet<string>>>;
  /**
   * The daemon's verdict per catalog id (`/models/fit`). Null when it could
   * not answer: then no image or video model is recommended.
   */
  fit: {
    image: ReadonlyMap<string, MediaFitVerdict> | null;
    video: ReadonlyMap<string, MediaFitVerdict> | null;
  };
}

interface AccessoryCatalogModel {
  id: string;
  name: string;
  approxSizeBytes: number;
  recoScore?: number;
  licenseClass?: string;
  tags?: string[];
  auxiliaryFiles?: Array<{ sizeBytes?: number }>;
}

/** Verdicts by catalog id from a `/models/fit` answer, or null without one. */
export function fitVerdicts(
  res: MediaModelFitResponse | null,
): ReadonlyMap<string, MediaFitVerdict> | null {
  return res ? new Map(res.models.map((m) => [m.id, m.verdict])) : null;
}

const CHAT_MEMORY_OVERHEAD: Record<BootstrapChatProvider, number> = {
  'llama-cpp': 1.2,
  mlx: 1.3,
};

/**
 * Complete local toolkit used by the recommended workshop set. The three
 * variant-less entries share one release archive; resolving them serially
 * downloads that archive once and activates each executable from its cache.
 */
export const NATIVE_TOOLKIT: ReadonlyArray<NativeEngineName> = [
  'uv',
  'sd-server',
  'whisper-server',
  'llama-server',
];

/** The device facts model ranking reads, from the daemon's memory profile. */
export function recoDevice(
  memory: Awaited<ReturnType<GezelClient['getMemoryProfile']>>,
): RecoDevice {
  return {
    platform: memory.platform,
    gpuVramBytes: memory.gpuVramBytes,
    ...(memory.gpuMemoryKind ? { gpuMemoryKind: memory.gpuMemoryKind } : {}),
    totalRamBytes: memory.totalRamBytes,
    usableBytes: memory.usableBytes,
    ...(memory.budgetBytes !== undefined ? { budgetBytes: memory.budgetBytes } : {}),
  };
}

/**
 * Every open catalog chat model this engine can run, with its fit on this
 * device. Unranked: {@link rankChatModels} orders them and drops the ones that
 * do not fit comfortably when any do.
 */
export function chatModelCandidates(
  items: readonly CatalogItemSummary[],
  device: RecoDevice,
  provider: BootstrapChatProvider,
): BootstrapChatModel[] {
  const candidates: BootstrapChatModel[] = [];
  for (const item of items) {
    if (item.manifest.kind !== 'chat-model') continue;
    const manifest = item.manifest as ChatModelManifest;
    if (manifest.licenseClass !== 'open') continue;
    const source = provider === 'mlx' ? manifest.mlx : manifest.llamaCpp;
    if (!source || (provider === 'mlx' && manifest.mlx?.disabledReason)) continue;
    const residentBytes =
      source.residentBytes ?? Math.round(source.approxSizeBytes * CHAT_MEMORY_OVERHEAD[provider]);
    const fit = computeModelFit({
      residentBytes,
      isMoE: isMoEFromTags(manifest.tags),
      usableBytes: device.usableBytes,
      totalRamBytes: device.totalRamBytes,
      gpuVramBytes: device.gpuVramBytes,
      ...(device.budgetBytes !== undefined ? { admissibleBytes: device.budgetBytes } : {}),
    }).tier;
    candidates.push({
      id: manifest.id,
      name: manifest.name,
      provider,
      approxSizeBytes: source.approxSizeBytes,
      residentBytes,
      // Effective score: a model the shared gate rejects (restricted license,
      // no tool support) sorts as unscored rather than leading the list.
      recoScore: isRecommendedModel(manifest) ? (manifest.recoScore ?? 0) : 0,
      ...(source.quantization ? { quantization: source.quantization } : {}),
      fit,
      attribution: formatModelAttribution(manifest),
    });
  }
  return candidates;
}

/**
 * Installed chat models in the order the first-run picker offers them: the
 * ranking's order first, then models the catalog does not rank, and last any
 * the catalog says this machine cannot run. An installed model that runs leads
 * the picker, because Enter on the first option used to start a 16 GB download
 * beside a model already on disk.
 */
export function orderInstalledChatModels<T extends { id: string }>(
  installed: readonly T[],
  ranked: readonly BootstrapChatModel[],
  candidates: readonly BootstrapChatModel[],
): T[] {
  const fit = new Map(candidates.map((model) => [model.id, model.fit]));
  const position = (id: string) => {
    const index = ranked.findIndex((model) => model.id === id);
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  };
  const cannotRun = (id: string) => (fit.get(id) === 'too-big' ? 1 : 0);
  return [...installed].sort(
    (a, b) => cannotRun(a.id) - cannotRun(b.id) || position(a.id) - position(b.id),
  );
}

/** Whether an installed model can be the picker's default on this machine. */
export function runsHere(id: string, candidates: readonly BootstrapChatModel[]): boolean {
  return candidates.find((model) => model.id === id)?.fit !== 'too-big';
}

/**
 * Device-compatible chat choices with the same first choice as the daemon's
 * first-run picker. Other open models that fit are then ordered by curated
 * score and useful size.
 */
export function rankChatModels(
  items: readonly CatalogItemSummary[],
  device: RecoDevice,
  provider: BootstrapChatProvider,
): BootstrapChatModel[] {
  const candidates = chatModelCandidates(items, device, provider);
  if (candidates.length === 0) return [];

  const picked = pickRecommendedModel(
    candidates.map((model) => ({
      id: model.id,
      ...(model.recoScore > 0 ? { recoScore: model.recoScore } : {}),
      licenseClass: 'open',
      tags:
        (
          items.find((item) => item.manifest.kind === 'chat-model' && item.manifest.id === model.id)
            ?.manifest as ChatModelManifest | undefined
        )?.tags ?? [],
      residentBytes: model.residentBytes,
      ...(model.quantization ? { quantization: model.quantization } : {}),
    })),
    device,
  );
  const comfortable = candidates.filter(
    (model) => model.fit === 'fits' || model.fit === 'fits-offload',
  );
  const pool = comfortable.length > 0 ? comfortable : candidates;
  const ranked = (model: BootstrapChatModel) =>
    model.recoScore * lowBitScoreFactor(model.quantization);
  pool.sort(
    (a, b) =>
      ranked(b) - ranked(a) ||
      fitOrder(a.fit) - fitOrder(b.fit) ||
      b.residentBytes - a.residentBytes ||
      a.name.localeCompare(b.name),
  );
  if (!picked) return pool;
  const bestIndex = pool.findIndex((model) => model.id === picked.id);
  if (bestIndex < 0) {
    // The low-acceleration recommendation can deliberately be a `tight`
    // small dense model while a much larger MoE is technically
    // `fits-offload`. Keep the daemon's safe first choice visible and first.
    const best = candidates.find((model) => model.id === picked.id);
    if (best) pool.unshift(best);
    return pool;
  }
  if (bestIndex > 0) {
    const [best] = pool.splice(bestIndex, 1);
    if (best) pool.unshift(best);
  }
  return pool;
}

/** Model name plus the people behind the original and downloadable builds. */
export function bootstrapChatModelLabel(model: BootstrapChatModel): string {
  return `${model.name} (${model.attribution})`;
}

/** Recommended accessory models that fit, excluding anything already installed. */
export function pickAccessoryModels(input: AccessoryInputs): BootstrapAccessoryModel[] {
  const output: BootstrapAccessoryModel[] = [];
  const image = pickCatalogMedia(input.imageItems, input.fit.image);
  if (image && !input.installed.image?.has(image.id)) {
    output.push({
      kind: 'image',
      id: image.id,
      name: image.name,
      approxSizeBytes:
        image.approxSizeBytes +
        (image.auxiliaryFiles ?? []).reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
      requiredEngine: 'sd-server',
    });
  }
  const recognition = pickScoredOpen(input.recognition, false);
  if (recognition && !input.installed.recognition?.has(recognition.id)) {
    output.push({
      kind: 'recognition',
      id: recognition.id,
      name: recognition.name,
      approxSizeBytes: recognition.approxSizeBytes,
      requiredEngine: 'llama-server',
    });
  }
  const stt = pickScoredOpen(input.audio.stt);
  if (stt && !input.installed.stt?.has(stt.id)) {
    output.push({
      kind: 'stt',
      id: stt.id,
      name: stt.name,
      approxSizeBytes: stt.approxSizeBytes,
      requiredEngine: 'whisper-server',
    });
  }
  const tts = pickScoredOpen(input.audio.tts);
  if (tts && !input.installed.tts?.has(tts.id)) {
    output.push({
      kind: 'tts',
      id: tts.id,
      name: tts.name,
      approxSizeBytes: tts.approxSizeBytes,
    });
  }
  const video = pickCatalogMedia(input.videoItems, input.fit.video);
  if (video && !input.installed.video?.has(video.id)) {
    output.push({
      kind: 'video',
      id: video.id,
      name: video.name,
      approxSizeBytes: video.approxSizeBytes,
      requiredEngine: 'uv',
    });
  }
  return output;
}

export function formatDownloadSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

function fitOrder(fit: BootstrapChatModel['fit']): number {
  switch (fit) {
    case 'fits':
      return 0;
    case 'fits-offload':
      return 1;
    case 'tight':
      return 2;
    case 'too-big':
      return 3;
  }
}

/** The best recommended image or video model the daemon says fits outright. */
function pickCatalogMedia(
  items: readonly CatalogItemSummary[],
  verdicts: ReadonlyMap<string, MediaFitVerdict> | null,
): AccessoryCatalogModel | null {
  const models = items
    .map((item) => item.manifest as unknown as AccessoryCatalogModel)
    .filter((model) => isRecommendedModel(model) && verdicts?.get(model.id) === 'fits');
  return pickScoredOpen(models);
}

function pickScoredOpen(
  models: readonly AccessoryCatalogModel[],
  requireLicense = true,
): AccessoryCatalogModel | null {
  return (
    [...models]
      .filter(
        (model) =>
          typeof model.recoScore === 'number' &&
          model.recoScore > 0 &&
          (!requireLicense || model.licenseClass === 'open'),
      )
      .sort((a, b) => (b.recoScore ?? 0) - (a.recoScore ?? 0))[0] ?? null
  );
}
