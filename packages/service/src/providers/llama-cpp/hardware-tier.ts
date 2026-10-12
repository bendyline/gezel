import type {
  ChatModelManifest,
  MachineMemoryShape,
  RecoDevice,
  RecoModelInput,
} from '@bendyline/gezel';
import {
  estimateLlamaCppResidentBytes,
  estimateManifestKvBytes,
  estimateMlxResidentBytes,
  localContextFloorTokens,
  pickRecommendedModel,
} from '@bendyline/gezel';
import { detectMemoryProfile } from '../../system/memory.js';
import {
  computeHeadroomFor,
  estimatePerSlotKvBytes,
  kvQuantScale,
  liveLaunchCapBytes,
} from '../native/capacity-broker.js';
import { measureAvailableGpuBytes } from '../native/device-capacity.js';
import { resolveLlamaCppKvCacheType } from './kv-cache-type.js';

/**
 * Pick the on-device model to install on first run.
 *
 * The choice is data-driven: every catalog chat-model that passes core's
 * `isRecommendedModel` gate (curated `recoScore`, fully-open license, tool
 * support) is a candidate, and the best one for THIS machine is chosen by
 * `pickRecommendedModel` (core) —
 * highest score, MoE-vs-VRAM alignment, then the largest that comfortably
 * fits. See `packages/core/src/recommendation.ts` for the ranking rules; this
 * module just supplies the two live inputs:
 *
 *   1. the machine's memory profile (`detectMemoryProfile` — RAM + GPU memory
 *      via nvidia-smi / the bundled `llama-server --list-devices`, including
 *      integrated-vs-discrete classification so shared RAM is not counted twice),
 *   2. the catalog candidates, each mapped to the working set of the on-device
 *      provider for this platform (MLX on Mac, llama.cpp elsewhere).
 *
 * We never crash on a detection miss: an empty candidate set falls back to a
 * safe small default, and the user can always switch post-install in Settings.
 */

/** Safe universal default if the catalog somehow ships no recommended model. */
const FALLBACK_TIER = 'gemma4-e2b-q4';

/** A catalog chat-model id (the pinned first-run model). */
export type ModelTier = string;

export interface TierDecision {
  /** The chosen catalog chat-model id. */
  tier: string;
  /** One-sentence human-readable rationale for the decision. */
  reason: string;
  /** All inputs the decision was made from — logged + shown to the user. */
  inputs: {
    platform: string;
    totalRamBytes: number;
    gpuVramBytes?: number;
    gpuMemoryKind?: 'discrete' | 'integrated' | 'unified' | 'none' | 'unknown';
    usableBytes: number;
    /** What a launch could hold with the memory free at the time of the pick. */
    launchCapBytes?: number;
  };
}

/**
 * Map a catalog chat-model manifest to a recommendation candidate for the
 * given platform's on-device provider (MLX on Mac, llama.cpp elsewhere).
 * Returns null when the model ships no block for that provider (can't install
 * it there). `residentBytes` prefers the manifest's pinned value, else the
 * on-disk size × overhead — the same working-set estimate the UI's fit badge
 * uses, and per ENGINE: the two differ in shape, and estimating a Mac's MLX
 * candidate with llama.cpp's multiplier over-reserved every first-run pick on
 * Apple Silicon. Pure — unit-tested.
 */
export function toRecoCandidate(
  m: ChatModelManifest,
  platform: string,
  machine?: MachineMemoryShape,
): RecoModelInput | null {
  const block = platform === 'darwin' ? m.mlx : m.llamaCpp;
  if (!block) return null;
  const approx = block.approxSizeBytes ?? m.approxSizeBytes;
  // A multimodal llama.cpp entry loads a projector `approxSizeBytes` excludes.
  // MLX needs no equivalent — its vision tower is inside the same safetensors.
  const estimated =
    platform === 'darwin'
      ? estimateMlxResidentBytes(approx)
      : estimateLlamaCppResidentBytes(approx, { mmprojBytes: m.llamaCpp?.mmproj?.sizeBytes ?? 0 });
  const residentBytes = block.residentBytes ?? estimated;
  // What the launch-time context check charges: the weights, plus the KV at
  // the window this host launches with, inside the engine's compute headroom.
  // Gemma keeps an f16 cache and MLX runs f16; a manifest without KV geometry
  // gets the engine's own weights-scaled estimate, never zero (a 26B suggested
  // without its 1.3 GB of KV was refused at launch).
  const mlx = platform === 'darwin';
  const kvCacheType = mlx ? 'f16' : resolveLlamaCppKvCacheType({ modelId: m.id });
  const ctxTokens = machine ? localContextFloorTokens(machine) : 0;
  const kvBytes = !machine
    ? 0
    : m.kvBytesPerTokenF16
      ? estimateManifestKvBytes(m, { ctxTokens, cacheScale: kvQuantScale(kvCacheType) })
      : estimatePerSlotKvBytes({ perTurnCtxTokens: ctxTokens, weightsBytes: approx, kvCacheType });
  const headroom = computeHeadroomFor(mlx ? 'mlx' : 'llama-cpp');
  return {
    id: m.id,
    ...(m.recoScore != null ? { recoScore: m.recoScore } : {}),
    ...(m.licenseClass != null ? { licenseClass: m.licenseClass } : {}),
    supportsTools: m.supportsTools,
    tags: m.tags,
    residentBytes,
    ...(block.quantization ? { quantization: block.quantization } : {}),
    ...(machine ? { launchBytes: residentBytes + kvBytes / (1 - headroom) } : {}),
  };
}

/** The machine's memory as a launch would find it now, in the picker's terms. */
export interface LiveLaunchView {
  platform: string;
  machine: MachineMemoryShape;
  device: RecoDevice;
  inputs: TierDecision['inputs'];
}

/**
 * Read the host the way the launch path will: its size, plus what is free
 * now. The first-run pick and the failed-turn card both decide from this, so
 * neither can promise a model the first chat turn then refuses.
 */
export async function liveLaunchView(): Promise<LiveLaunchView> {
  const mem = await detectMemoryProfile();
  const discrete = mem.gpuMemoryKind === 'discrete';
  const machine: MachineMemoryShape = {
    totalRamBytes: mem.totalRamBytes,
    gpuVramBytes: discrete ? mem.gpuVramBytes : null,
  };
  const freeGpuBytes = discrete
    ? await measureAvailableGpuBytes().catch(() => undefined)
    : undefined;
  // Only the free part of the card: admission checks graphics memory other
  // programs hold, and so must the prediction.
  const launchCapBytes = liveLaunchCapBytes({
    budgetBytes: mem.budgetBytes,
    vramBytes: discrete ? Math.min(mem.usableBytes, freeGpuBytes ?? mem.usableBytes) : 0,
  });
  return {
    platform: mem.platform,
    machine,
    device: {
      platform: mem.platform,
      gpuVramBytes: mem.gpuVramBytes,
      gpuMemoryKind: mem.gpuMemoryKind,
      totalRamBytes: mem.totalRamBytes,
      usableBytes: mem.usableBytes,
      // The broker's ceiling, so first run never installs a model the very
      // next chat turn refuses to load.
      budgetBytes: mem.budgetBytes,
      launchCapBytes,
      ...(freeGpuBytes !== undefined ? { freeGpuBytes } : {}),
    },
    inputs: {
      platform: mem.platform,
      totalRamBytes: mem.totalRamBytes,
      ...(mem.gpuVramBytes != null ? { gpuVramBytes: mem.gpuVramBytes } : {}),
      gpuMemoryKind: mem.gpuMemoryKind,
      usableBytes: mem.usableBytes,
      launchCapBytes,
    },
  };
}

/**
 * Choose the first-run on-device model. `models` are the catalog's chat-model
 * manifests (the caller lists them from the CatalogService). Probes live host
 * memory + GPU and returns the picked catalog id with a rationale.
 */
export async function detectModelTier(models: readonly ChatModelManifest[]): Promise<TierDecision> {
  const view = await liveLaunchView();
  const candidates = models
    .map((m) => toRecoCandidate(m, view.platform, view.machine))
    .filter((c): c is RecoModelInput => c !== null);
  const pick = pickRecommendedModel(candidates, view.device);
  if (!pick) {
    return {
      tier: FALLBACK_TIER,
      reason: `no recommended candidate matched — falling back to ${FALLBACK_TIER}`,
      inputs: view.inputs,
    };
  }
  return { tier: pick.id, reason: pick.reason, inputs: view.inputs };
}
