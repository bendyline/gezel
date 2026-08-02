import type {
  CatalogItemSummary,
  ChatModelManifest,
  NativeEngineName,
  RecoDevice,
} from '@bendyline/gezel';
import {
  computeModelFit,
  isMoEFromTags,
  mediaModelFits,
  pickRecommendedModel,
} from '@bendyline/gezel';

export type BootstrapChatProvider = 'llama-cpp' | 'mlx';

export interface BootstrapChatModel {
  id: string;
  name: string;
  provider: BootstrapChatProvider;
  approxSizeBytes: number;
  residentBytes: number;
  recoScore: number;
  fit: 'fits' | 'fits-offload' | 'tight' | 'too-big';
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
}

interface AccessoryCatalogModel {
  id: string;
  name: string;
  approxSizeBytes: number;
  recoScore?: number;
  licenseClass?: string;
  minRamGB?: number;
  minVramGB?: number;
  auxiliaryFiles?: Array<{ sizeBytes?: number }>;
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
      recoScore: manifest.recoScore ?? 0,
      fit,
    });
  }
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
    })),
    device,
  );
  const comfortable = candidates.filter(
    (model) => model.fit === 'fits' || model.fit === 'fits-offload',
  );
  const pool = comfortable.length > 0 ? comfortable : candidates;
  pool.sort(
    (a, b) =>
      b.recoScore - a.recoScore ||
      fitOrder(a.fit) - fitOrder(b.fit) ||
      b.residentBytes - a.residentBytes ||
      a.name.localeCompare(b.name),
  );
  if (!picked) return pool;
  const bestIndex = pool.findIndex((model) => model.id === picked.id);
  if (bestIndex > 0) {
    const [best] = pool.splice(bestIndex, 1);
    if (best) pool.unshift(best);
  }
  return pool;
}

/** Recommended accessory models that fit, excluding anything already installed. */
export function pickAccessoryModels(
  input: AccessoryInputs,
  device: RecoDevice,
): BootstrapAccessoryModel[] {
  const output: BootstrapAccessoryModel[] = [];
  const image = pickCatalogMedia(input.imageItems, device, 'image');
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
  const video = pickCatalogMedia(input.videoItems, device, 'video');
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

function pickCatalogMedia(
  items: readonly CatalogItemSummary[],
  device: RecoDevice,
  kind: 'image' | 'video',
): AccessoryCatalogModel | null {
  const models = items
    .map((item) => item.manifest as unknown as AccessoryCatalogModel)
    .filter((model) => {
      if (model.licenseClass !== 'open' || !model.recoScore) return false;
      return mediaModelFits(
        device,
        kind === 'image' ? { minRamGB: model.minRamGB } : { minVramGB: model.minVramGB },
      );
    });
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
