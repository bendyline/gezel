/**
 * OpenAIImageProvider — OpenAI image generation via the Images API.
 *
 * Default model: `gpt-image-2` (also exposed via
 * the dated snapshot `gpt-image-2-2026-04-21`). gpt-image-2 returns
 * base64 by default in `data[0].b64_json`; no `response_format` flag
 * needed in the new API.
 *
 * Sizes are constrained to a discrete set; we snap arbitrary
 * width/height to the closest match and log a one-line warning when we
 * had to snap.
 */

import { createLogger } from '@bendyline/gezel';
import type {
  ImageEngineHealth,
  ImageGenerationInput,
  ImageGenerationOutput,
  ImageModelPullEvent,
  ImageModelPullSpec,
  ImageProvider,
  InstalledImageModelInfo,
} from './types.js';

const log = createLogger('image');

const DEFAULT_MODEL = 'gpt-image-2';
const SNAPSHOT_MODEL = 'gpt-image-2-2026-04-21';

/**
 * Supported sizes. gpt-image-2 ships with a fixed set; `auto` lets the
 * server pick. Order matters for snap-to-nearest tie-breaking.
 */
const SUPPORTED_SIZES = ['1024x1024', '1024x1536', '1536x1024'] as const;
type SupportedSize = (typeof SUPPORTED_SIZES)[number];

interface OpenAIImageProviderOptions {
  apiKey: string | null;
  organization?: string | null;
  /** Test seam — defaults to the real `openai` SDK. */
  clientFactory?: () => Promise<OpenAIImageClient>;
}

/** Subset of the `openai` SDK we need — keeps imports lazy and tests easy. */
export interface OpenAIImageClient {
  images: {
    generate(args: {
      model: string;
      prompt: string;
      size?: string;
      n?: number;
    }): Promise<{ data?: Array<{ b64_json?: string }> }>;
    /**
     * Edit / reference-driven generation. Pass one or more source
     * images and a prompt. SDK accepts `Uploadable` (Buffer in Node);
     * we feed Buffers through directly.
     */
    edit(args: {
      model: string;
      image: Buffer | Buffer[];
      prompt: string;
      size?: string;
      n?: number;
    }): Promise<{ data?: Array<{ b64_json?: string }> }>;
  };
}

const CLOUD_INSTALLED_AT = '2026-04-21T00:00:00.000Z';

export class OpenAIImageProvider implements ImageProvider {
  readonly name = 'openai';

  private readonly apiKey: string | null;
  private readonly organization: string | null;
  private readonly clientFactory: () => Promise<OpenAIImageClient>;
  private client: OpenAIImageClient | null = null;

  constructor(opts: OpenAIImageProviderOptions) {
    this.apiKey = opts.apiKey;
    this.organization = opts.organization ?? null;
    this.clientFactory = opts.clientFactory ?? this.defaultClientFactory.bind(this);
  }

  private async defaultClientFactory(): Promise<OpenAIImageClient> {
    if (!this.apiKey) {
      throw makeActionable(
        'OpenAI image generation is not configured. Add an OpenAI API key in Settings.',
      );
    }
    const mod = (await import('openai')) as unknown as {
      default?: new (opts: Record<string, unknown>) => OpenAIImageClient;
      OpenAI?: new (opts: Record<string, unknown>) => OpenAIImageClient;
    };
    const Ctor = mod.default ?? mod.OpenAI;
    if (!Ctor) throw new Error('openai SDK module did not export a constructor.');
    const opts: Record<string, unknown> = { apiKey: this.apiKey };
    if (this.organization) opts.organization = this.organization;
    return new Ctor(opts);
  }

  private async ensureClient(): Promise<OpenAIImageClient> {
    if (!this.client) this.client = await this.clientFactory();
    return this.client;
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    if (!this.apiKey) {
      throw makeActionable(
        'OpenAI image generation is not configured. Add an OpenAI API key in Settings.',
      );
    }
    const client = await this.ensureClient();
    const model = input.model?.trim() || DEFAULT_MODEL;
    const startedAt = Date.now();

    const sizeChoice = pickSize(input.width, input.height);
    if (sizeChoice.snappedFrom) {
      log.info(
        `[openai-image] snapped ${sizeChoice.snappedFrom} → ${sizeChoice.size} (gpt-image-2 supports a discrete size set)`,
      );
    }

    const inputImages = input.inputImages ?? [];
    const res = await (inputImages.length > 0
      ? client.images.edit({
          model,
          image: inputImages.length === 1 ? inputImages[0]!.data : inputImages.map((i) => i.data),
          prompt: input.prompt,
          ...(sizeChoice.size ? { size: sizeChoice.size } : {}),
          n: 1,
        })
      : client.images.generate({
          model,
          prompt: input.prompt,
          ...(sizeChoice.size ? { size: sizeChoice.size } : {}),
          n: 1,
        })
    ).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`OpenAI image generation failed: ${msg}`);
    });

    const b64 = res.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error('OpenAI image generation returned no image data.');
    }
    const png = Buffer.from(b64, 'base64');
    const dims = parseSize(sizeChoice.size);
    return {
      png,
      meta: {
        model,
        seed: input.seed ?? 0,
        steps: input.steps ?? 0,
        widthPx: dims.width ?? input.width ?? 0,
        heightPx: dims.height ?? input.height ?? 0,
        durationMs: Date.now() - startedAt,
      },
    };
  }

  async listInstalledModels(): Promise<InstalledImageModelInfo[]> {
    return [
      {
        id: DEFAULT_MODEL,
        name: 'GPT Image 2',
        approxSizeBytes: 0,
        installedAt: CLOUD_INSTALLED_AT,
      },
      {
        id: SNAPSHOT_MODEL,
        name: 'GPT Image 2 (2026-04-21 snapshot)',
        approxSizeBytes: 0,
        installedAt: CLOUD_INSTALLED_AT,
      },
    ];
  }

  // biome-ignore lint/correctness/useYield: cloud provider rejects pulls.
  async *pullModel(
    _id: string,
    _spec: ImageModelPullSpec,
    _signal?: AbortSignal,
  ): AsyncIterable<ImageModelPullEvent> {
    throw new Error(
      'OpenAI is a cloud provider — models are managed by OpenAI. Switch to a local engine to install models.',
    );
  }

  async deleteModel(_id: string): Promise<void> {
    throw new Error(
      'OpenAI is a cloud provider — models are managed by OpenAI. Switch to a local engine to delete models.',
    );
  }

  async health(): Promise<ImageEngineHealth> {
    const baseUrl = 'https://api.openai.com/v1';
    if (!this.apiKey) {
      return {
        status: 'not-configured',
        baseUrl,
        error: 'No OpenAI API key configured.',
      };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    try {
      const headers: Record<string, string> = {
        authorization: `Bearer ${this.apiKey}`,
      };
      if (this.organization) headers['openai-organization'] = this.organization;
      const res = await globalThis.fetch(`${baseUrl}/models`, {
        method: 'GET',
        headers,
        signal: ctrl.signal,
      });
      if (res.ok) return { status: 'ok', baseUrl };
      if (res.status === 401 || res.status === 403) {
        return { status: 'unreachable', baseUrl, error: 'invalid API key' };
      }
      return { status: 'unreachable', baseUrl, error: `HTTP ${res.status}` };
    } catch (err) {
      return {
        status: 'unreachable',
        baseUrl,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async shutdown(): Promise<void> {
    this.client = null;
  }
}

interface SizeChoice {
  /** Resolved size string passed to OpenAI, or undefined for `auto`. */
  size?: SupportedSize;
  /** Original `WxH` if we had to snap; undefined when an exact match. */
  snappedFrom?: string;
}

export function pickSize(width?: number, height?: number): SizeChoice {
  if (!width || !height) return {};
  const requested = `${width}x${height}`;
  const exact = SUPPORTED_SIZES.find((s) => s === requested);
  if (exact) return { size: exact };
  const target = width / height;
  let best: SupportedSize = SUPPORTED_SIZES[0];
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const s of SUPPORTED_SIZES) {
    const [w, h] = s.split('x').map(Number) as [number, number];
    const ratio = w / h;
    const delta = Math.abs(Math.log(ratio) - Math.log(target));
    if (delta < bestDelta) {
      best = s;
      bestDelta = delta;
    }
  }
  return { size: best, snappedFrom: requested };
}

function parseSize(size?: string): { width?: number; height?: number } {
  if (!size) return {};
  const [w, h] = size.split('x').map((n) => Number.parseInt(n, 10));
  if (!w || !h) return {};
  return { width: w, height: h };
}

function makeActionable(message: string): Error {
  const err = new Error(message);
  (err as { isActionable?: boolean }).isActionable = true;
  return err;
}
