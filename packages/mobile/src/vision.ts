import { MODE_PROMPTS } from '@bendyline/gezel';
import type { PortableImageReading, PortableVision } from '@bendyline/gezel/runtime';
import { registerPlugin } from '@capacitor/core';

/** Where the OS's own describer stands: Gemini Nano on Android, Foundation Models on iOS 27. */
export type SystemDescriberState = 'ready' | 'download-required' | 'downloading' | 'unavailable';

export interface NativeVisionStatus {
  labels: 'ready' | 'unavailable';
  text: 'ready' | 'unavailable';
  describer: { state: SystemDescriberState; model?: string; reason?: string };
}

export interface NativeVisionPlugin {
  status(): Promise<NativeVisionStatus>;
  /** Fetch the OS describer's model. Only ever run from an explicit Settings action. */
  prepare(): Promise<NativeVisionStatus>;
  read(options: {
    requestId: string;
    /** Base64 image bytes; the native side decodes, orients, and downscales. */
    image: string;
    mimeType: string;
    /** Ask the OS describer for a sentence when it is ready; labels and text always run. */
    describe: boolean;
    /** The desktop's describe prompt, for describers that take one (Foundation Models). */
    prompt: { system: string; user: string; maxTokens: number };
  }): Promise<{
    /** Already cut at what this platform's classifier calls trustworthy. */
    labels?: Array<{ label: string; confidence: number }>;
    text?: string;
    description?: string;
    describer: SystemDescriberState | 'failed';
    width?: number;
    height?: number;
    models: string[];
  }>;
  cancel(options: { requestId: string }): Promise<void>;
}

/**
 * The second describer tier: a small vision model on the phone's llama.cpp,
 * for phones whose OS has no describer (an iPhone without Apple Intelligence,
 * an Android phone without Gemini Nano).
 */
export interface FallbackDescriber {
  state(): Promise<'ready' | 'not-installed' | 'unavailable'>;
  describe(input: {
    data: Uint8Array;
    mimeType: string;
    signal: AbortSignal;
  }): Promise<{ description: string; model: string }>;
}

const nativePlugin = registerPlugin<NativeVisionPlugin>('GezelVision');

const MAX_LABELS = 8;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

function base64(bytes: Uint8Array): string {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES)
    throw new Error('Photos must be between 1 byte and 16 MiB.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function createNativeVision(
  native: NativeVisionPlugin = nativePlugin,
  fallback?: FallbackDescriber,
): PortableVision {
  return {
    async read({ data, mimeType, signal }): Promise<PortableImageReading> {
      signal.throwIfAborted();
      const requestId = crypto.randomUUID();
      let cancellation: Promise<void> | undefined;
      const abort = () => {
        cancellation ??= native.cancel({ requestId }).catch(() => {});
      };
      signal.addEventListener('abort', abort, { once: true });
      let result: Awaited<ReturnType<NativeVisionPlugin['read']>>;
      try {
        result = await native.read({
          requestId,
          image: base64(data),
          mimeType,
          describe: true,
          prompt: MODE_PROMPTS.describe,
        });
      } finally {
        signal.removeEventListener('abort', abort);
        await cancellation;
      }
      signal.throwIfAborted();
      const reading: PortableImageReading = {
        // Each platform's classifier scores on its own scale, so the native
        // side decides which labels to trust; this only orders and caps them.
        labels: [
          ...new Set(
            (result.labels ?? [])
              .filter((item) => item.label.trim())
              .sort((a, b) => b.confidence - a.confidence)
              .map((item) => item.label.trim().replaceAll('_', ' ').toLowerCase()),
          ),
        ].slice(0, MAX_LABELS),
        ...(result.text?.trim() ? { text: result.text.trim() } : {}),
        ...(result.description?.trim() ? { description: result.description.trim() } : {}),
        ...(result.width ? { width: result.width } : {}),
        ...(result.height ? { height: result.height } : {}),
        models: [...result.models],
      };
      if (reading.description) return reading;
      // Nano that still has to download is the person's call in Settings, not
      // something a chat turn starts on its own; the fallback model can stand in.
      const fallbackState = fallback ? await fallback.state().catch(() => 'unavailable') : null;
      if (fallback && fallbackState === 'ready') {
        try {
          const described = await fallback.describe({ data, mimeType, signal });
          if (described.description.trim()) {
            reading.description = described.description.trim();
            reading.models.push(described.model);
            return reading;
          }
        } catch {
          signal.throwIfAborted();
          reading.describer = 'failed';
          return reading;
        }
      }
      reading.describer =
        result.describer === 'failed'
          ? 'failed'
          : result.describer === 'download-required' ||
              result.describer === 'downloading' ||
              fallbackState === 'not-installed'
            ? 'not-installed'
            : 'unavailable';
      return reading;
    },
  };
}

export const nativeVision = nativePlugin;
