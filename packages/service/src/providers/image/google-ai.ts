/**
 * GoogleAiImageProvider — Google AI Studio image generation via Gemini.
 *
 * Default model: `gemini-3.1-flash-image-preview` (Nano Banana 2). The
 * `gemini-3-pro-image` high-quality
 * counterpart can be used by passing it as `input.model`.
 *
 * Uses the v1beta `generateContent` endpoint with `responseModalities:
 * ["TEXT", "IMAGE"]` so the model returns inline base64 PNG bytes
 * alongside any text. Nano Banana 2 takes `aspectRatio` + `imageSize`
 * (`512` / `1K` / `2K` / `4K`) rather than raw pixel dims; we snap
 * incoming `width`/`height` to the closest supported pair.
 *
 * Auth flows via the `x-goog-api-key` header (NOT `?key=`) so the API
 * key never lands in error message URLs on network failure.
 */

import type {
  ImageEngineHealth,
  ImageGenerationInput,
  ImageGenerationOutput,
  ImageModelPullEvent,
  ImageModelPullSpec,
  ImageProvider,
  InstalledImageModelInfo,
} from './types.js';

const DEFAULT_MODEL = 'gemini-3.1-flash-image-preview';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** Supported aspect ratios. Order matters — closest match wins ties. */
const ASPECT_RATIOS: Array<{ label: string; ratio: number }> = [
  { label: '1:1', ratio: 1 },
  { label: '5:4', ratio: 5 / 4 },
  { label: '4:5', ratio: 4 / 5 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '3:4', ratio: 3 / 4 },
  { label: '3:2', ratio: 3 / 2 },
  { label: '2:3', ratio: 2 / 3 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '9:16', ratio: 9 / 16 },
  { label: '21:9', ratio: 21 / 9 },
  { label: '4:1', ratio: 4 },
  { label: '1:4', ratio: 1 / 4 },
  { label: '8:1', ratio: 8 },
  { label: '1:8', ratio: 1 / 8 },
];

const IMAGE_SIZES: Array<{ label: string; maxDim: number }> = [
  { label: '512', maxDim: 512 },
  { label: '1K', maxDim: 1024 },
  { label: '2K', maxDim: 2048 },
  { label: '4K', maxDim: 4096 },
];

const CLOUD_INSTALLED_AT = '2026-02-26T00:00:00.000Z';

interface GoogleAiImageProviderOptions {
  apiKey: string | null;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          mimeType?: string;
          data?: string;
        };
      }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

export class GoogleAiImageProvider implements ImageProvider {
  readonly name = 'google-ai';

  private readonly apiKey: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GoogleAiImageProviderOptions) {
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    if (!this.apiKey) {
      const err = new Error(
        'Google AI image generation is not configured. Add a Google AI Studio API key in Settings → Image generation.',
      );
      (err as { isActionable?: boolean }).isActionable = true;
      throw err;
    }
    const model = input.model?.trim() || DEFAULT_MODEL;
    const startedAt = Date.now();

    const requestParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> =
      [];
    for (const img of input.inputImages ?? []) {
      requestParts.push({
        inlineData: {
          mimeType: img.mimeType || 'image/png',
          data: img.data.toString('base64'),
        },
      });
    }
    requestParts.push({ text: input.prompt });

    const body: Record<string, unknown> = {
      contents: [{ parts: requestParts }],
      generationConfig: {
        responseModalities: ['TEXT', 'IMAGE'],
        ...(input.width || input.height
          ? { imageConfig: snapImageConfig(input.width, input.height) }
          : {}),
      },
    };

    const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }).catch((err: unknown) => {
      throw new Error(
        `Google AI image generation network error: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const truncated = text.length > 500 ? `${text.slice(0, 500)}…` : text;
      throw new Error(
        `Google AI image generation failed (HTTP ${res.status}): ${truncated || res.statusText}`,
      );
    }

    const data = (await res.json().catch(() => null)) as GenerateContentResponse | null;
    if (!data) {
      throw new Error('Google AI image generation returned an unparseable response.');
    }
    if (data.error) {
      throw new Error(`Google AI image generation error: ${data.error.message ?? 'unknown'}`);
    }
    if (data.promptFeedback?.blockReason) {
      throw new Error(
        `Google AI declined the prompt (${data.promptFeedback.blockReason}). Try a different prompt.`,
      );
    }
    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const imagePart = parts.find(
      (p) =>
        typeof p.inlineData?.data === 'string' &&
        (p.inlineData.mimeType === 'image/png' || p.inlineData.mimeType?.startsWith('image/')),
    );
    if (!imagePart?.inlineData?.data) {
      const textPart = parts.find((p) => typeof p.text === 'string' && p.text.length > 0);
      const hint = textPart?.text ? ` Model said: "${truncate(textPart.text, 200)}"` : '';
      throw new Error(
        `Google AI returned text instead of an image — the prompt may have been refused.${hint}`,
      );
    }

    const png = Buffer.from(imagePart.inlineData.data, 'base64');
    const sized = sizeFromImageConfig(
      body.generationConfig as { imageConfig?: { aspectRatio?: string; imageSize?: string } },
    );
    return {
      png,
      meta: {
        model,
        seed: input.seed ?? 0,
        steps: input.steps ?? 0,
        widthPx: sized.width ?? input.width ?? 0,
        heightPx: sized.height ?? input.height ?? 0,
        durationMs: Date.now() - startedAt,
      },
    };
  }

  async listInstalledModels(): Promise<InstalledImageModelInfo[]> {
    return [
      {
        id: DEFAULT_MODEL,
        name: 'Nano Banana 2 (Gemini 3.1 Flash Image)',
        approxSizeBytes: 0,
        installedAt: CLOUD_INSTALLED_AT,
      },
    ];
  }

  // biome-ignore lint/correctness/useYield: cloud provider rejects pulls — emit nothing and throw.
  async *pullModel(
    _id: string,
    _spec: ImageModelPullSpec,
    _signal?: AbortSignal,
  ): AsyncIterable<ImageModelPullEvent> {
    throw new Error(
      'Google AI is a cloud provider — models are managed by Google. Switch to a local engine to install models.',
    );
  }

  async deleteModel(_id: string): Promise<void> {
    throw new Error(
      'Google AI is a cloud provider — models are managed by Google. Switch to a local engine to delete models.',
    );
  }

  async health(): Promise<ImageEngineHealth> {
    const baseUrl = API_BASE;
    if (!this.apiKey) {
      return {
        status: 'not-configured',
        baseUrl,
        error: 'No Google AI Studio API key configured.',
      };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    try {
      const res = await this.fetchImpl(`${API_BASE}/models`, {
        method: 'GET',
        headers: { 'x-goog-api-key': this.apiKey },
        signal: ctrl.signal,
      });
      if (res.ok) return { status: 'ok', baseUrl };
      if (res.status === 401 || res.status === 403) {
        return { status: 'unreachable', baseUrl, error: 'invalid API key' };
      }
      return { status: 'unreachable', baseUrl, error: `HTTP ${res.status}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'unreachable', baseUrl, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Translate raw pixel dims into Gemini's `imageConfig` shape. Picks the
 * closest aspect ratio and the smallest size whose `maxDim` covers the
 * requested max dimension.
 */
export function snapImageConfig(
  width: number | undefined,
  height: number | undefined,
): { aspectRatio: string; imageSize: string } {
  const w = width && width > 0 ? width : 1024;
  const h = height && height > 0 ? height : 1024;
  const target = w / h;
  let bestRatio = ASPECT_RATIOS[0]!;
  let bestDelta = Math.abs(Math.log(bestRatio.ratio) - Math.log(target));
  for (const r of ASPECT_RATIOS) {
    const delta = Math.abs(Math.log(r.ratio) - Math.log(target));
    if (delta < bestDelta) {
      bestRatio = r;
      bestDelta = delta;
    }
  }
  const maxDim = Math.max(w, h);
  let bestSize = IMAGE_SIZES[IMAGE_SIZES.length - 1]!;
  for (const s of IMAGE_SIZES) {
    if (s.maxDim >= maxDim) {
      bestSize = s;
      break;
    }
  }
  return { aspectRatio: bestRatio.label, imageSize: bestSize.label };
}

function sizeFromImageConfig(genCfg: {
  imageConfig?: { aspectRatio?: string; imageSize?: string };
}): { width?: number; height?: number } {
  const cfg = genCfg.imageConfig;
  if (!cfg) return {};
  const sizeEntry = IMAGE_SIZES.find((s) => s.label === cfg.imageSize);
  if (!sizeEntry) return {};
  const ratioEntry = ASPECT_RATIOS.find((r) => r.label === cfg.aspectRatio);
  if (!ratioEntry) return {};
  if (ratioEntry.ratio >= 1) {
    return { width: sizeEntry.maxDim, height: Math.round(sizeEntry.maxDim / ratioEntry.ratio) };
  }
  return { width: Math.round(sizeEntry.maxDim * ratioEntry.ratio), height: sizeEntry.maxDim };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
