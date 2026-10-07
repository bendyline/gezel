import { MODE_PROMPTS } from '@bendyline/gezel';
import type { GezelRuntimePlugin } from '@bendyline/gezel-capacitor';
import type { MobileModel, MobileModelSourceIdentity } from '@bendyline/gezel/mobile-providers';
import type { FallbackDescriber } from './vision.js';

const QWEN = {
  catalogVersion: '1.0.0',
  sourceId: 'bundled',
  huggingfaceRepo: 'unsloth/Qwen3.5-0.8B-MTP-GGUF',
  revision: 'cf8a611f6ed2c2060046219a19f12cd3d5ecd67c',
} as const;

/**
 * The small vision model a phone falls back to when its OS has no describer
 * (an iPhone without Apple Intelligence, an Android phone without Gemini
 * Nano): Qwen 3.5 0.8B, the catalog's own chat build, and the projector
 * published beside it at the same revision. A projector fits only the model
 * it was made for, so the pair is pinned together here, the way the desktop
 * pins its recognition models, rather than read from the catalog. An existing
 * chat download of the same file counts: installs match by SHA-256.
 */
export const VISION_DESCRIBER = {
  label: 'Qwen 3.5 vision (0.8B)',
  model: {
    ...QWEN,
    catalogId: 'qwen3.5-0.8b-q4',
    filename: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    sha256: 'ac7c9d7a1b3e3695bb3bd50f8ceaa97f9c93e99ccc3d3d1a620301b6dd6d3d86',
  },
  modelName: 'Qwen 3.5 (0.8B, Q4)',
  modelBytes: 549_698_976,
  projector: {
    ...QWEN,
    catalogId: 'qwen3.5-0.8b-q4:projector',
    filename: 'mmproj-F16.gguf',
    sha256: 'ea8519d0c6240e465a0265d6912f73d750a17ca7d42150281b778b8b59f05798',
  },
  projectorName: 'Qwen 3.5 vision projector',
  projectorBytes: 204_987_104,
  /** Weights, projector, a 4K window, and the projector's compute buffers. */
  requiredBytes: 1_600 * 1024 * 1024,
  modelRef: 'llama-cpp:qwen3.5-0.8b-q4',
} as const satisfies {
  model: MobileModelSourceIdentity;
  projector: MobileModelSourceIdentity;
  [key: string]: unknown;
};

/** A projector is a library entry so downloads can verify it, but never a chat model. */
export function isProjectorModel(model: Pick<MobileModel, 'source' | 'name'>): boolean {
  const file = model.source?.filename.split('/').pop() ?? '';
  return (
    /^mmproj[^/]*\.gguf$/i.test(file) || Boolean(model.source?.catalogId.endsWith(':projector'))
  );
}

export interface VisionDescriberInstall {
  state: 'ready' | 'not-installed' | 'unavailable';
  modelId?: string;
  projectorId?: string;
  /** Bytes still to download for the parts that are missing. */
  missingBytes: number;
}

export async function visionDescriberInstall(
  runtime: Pick<GezelRuntimePlugin, 'listModels' | 'describeImage'>,
): Promise<VisionDescriberInstall> {
  if (!runtime.describeImage) return { state: 'unavailable', missingBytes: 0 };
  const inventory = await runtime.listModels();
  const model = inventory.models.find(
    ({ source }) => source?.sha256 === VISION_DESCRIBER.model.sha256,
  );
  const projector = inventory.models.find(
    ({ source }) => source?.sha256 === VISION_DESCRIBER.projector.sha256,
  );
  const missingBytes =
    (model ? 0 : VISION_DESCRIBER.modelBytes) + (projector ? 0 : VISION_DESCRIBER.projectorBytes);
  if (
    inventory.memoryBudgetBytes !== undefined &&
    inventory.memoryBudgetBytes < VISION_DESCRIBER.requiredBytes
  )
    return { state: 'unavailable', missingBytes };
  return {
    state: model && projector ? 'ready' : 'not-installed',
    ...(model ? { modelId: model.id } : {}),
    ...(projector ? { projectorId: projector.id } : {}),
    missingBytes,
  };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

/** A small model sometimes opens with a reasoning block even when told not to. */
export function cleanDescription(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^[\s\S]*<\/think>/, '')
    .trim();
}

export function createVisionModelDescriber(
  runtime: Pick<GezelRuntimePlugin, 'listModels' | 'describeImage' | 'cancel'>,
): FallbackDescriber {
  return {
    state: async () => (await visionDescriberInstall(runtime)).state,
    async describe({ data, signal }) {
      signal.throwIfAborted();
      const install = await visionDescriberInstall(runtime);
      if (
        install.state !== 'ready' ||
        !install.modelId ||
        !install.projectorId ||
        !runtime.describeImage
      )
        throw new Error('The vision model is not installed');
      const requestId = crypto.randomUUID();
      let cancellation: Promise<void> | undefined;
      const abort = () => {
        cancellation ??= runtime.cancel({ requestId }).catch(() => {});
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        const result = await runtime.describeImage({
          requestId,
          modelId: install.modelId,
          projectorId: install.projectorId,
          image: base64(data),
          system: MODE_PROMPTS.describe.system,
          user: MODE_PROMPTS.describe.user,
          maxTokens: MODE_PROMPTS.describe.maxTokens,
        });
        signal.throwIfAborted();
        if (result.status !== 'ok') throw new Error('Describing the photo stopped');
        return {
          description: cleanDescription(result.description ?? ''),
          model: VISION_DESCRIBER.modelRef,
        };
      } finally {
        signal.removeEventListener('abort', abort);
        await cancellation;
      }
    },
  };
}
