import {
  APP_IMAGE_MAX_BASE64_CHARS,
  type AppEnsureEvent,
  AppEnsureEventSchema,
  AppEnsureResultSchema,
  AppImageGenerationEventSchema,
  type AppImageGenerationRequest,
  type AppImageModel,
  AppImageModelListSchema,
  type AppImagePhase,
} from '@bendyline/gezel-client/app-models';
import { GezelSdkError, errorFromResponse } from './errors.js';
import { readSseDataChunks } from './sse.js';
import type { RequestOptions } from './types.js';

export type ImageModel = AppImageModel;
export type ImageModelEnsureEvent = AppEnsureEvent;

/** Where a render is. Weights load inside the first render after the engine starts. */
export interface ImageProgress {
  phase: AppImagePhase;
  /** Units done in this phase: tensors loaded, sampling steps, decode tiles. 0 while queued. */
  step: number;
  totalSteps: number;
  secondsPerStep?: number;
}

export interface ImageGenerateInput {
  prompt: string;
  negativePrompt?: string;
  /** `sd-cpp:<id>`; the host's default model when absent. */
  model?: string;
  /** The host picks pixels inside the model's range; square when absent. */
  aspectRatio?: AppImageGenerationRequest['aspect_ratio'];
  quality?: AppImageGenerationRequest['quality'];
  seed?: number;
}

export interface ImageGenerateOptions extends RequestOptions {
  onProgress?(progress: ImageProgress): void;
}

export interface GeneratedImage {
  /** PNG bytes. */
  png: Uint8Array;
  width: number;
  height: number;
  seed: number;
  /** `sd-cpp:<id>`. */
  model: string;
  steps: number;
  durationMs: number;
}

export type ImageModelEnsureResult =
  | { status: 'ready'; modelId: string }
  | { status: 'downloading'; modelId: string; jobId: string };

/** Whether this Gezel offers apps image generation, and whether it can render here. */
export interface ImageSupport {
  /** The host serves `/v1/images`; a Gezel that predates it reports false. */
  supported: boolean;
  /** An engine can render on this computer. */
  available: boolean;
}

const MAX_JSON_BYTES = 4 * 1024 * 1024;
/** A finished image arrives as one frame of base64 plus its fields. */
const MAX_IMAGE_FRAME_BYTES = APP_IMAGE_MAX_BASE64_CHARS + 64 * 1024;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function invalid(message: string, cause?: unknown): GezelSdkError {
  return new GezelSdkError(message, {
    code: 'invalid_response',
    ...(cause !== undefined ? { cause } : {}),
  });
}

/**
 * On-device image generation and its models (`/v1/images/*`, the `images`
 * scope). Renders take seconds on a fast card and minutes for the largest
 * models; aborting a render's signal stops it.
 */
export class ImagesClient {
  private readonly token: () => string;

  constructor(
    private readonly baseUrl: string,
    token: string | (() => string),
    private readonly fetchFn: typeof fetch,
  ) {
    this.token = typeof token === 'string' ? () => token : token;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token()}`, 'Content-Type': 'application/json' };
  }

  private async json(path: string, init: RequestInit, opts: RequestOptions): Promise<unknown> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!response.ok) throw await errorFromResponse(response);
    const text = await response.text();
    if (text.length > MAX_JSON_BYTES) throw invalid('Image response exceeds the budget');
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      throw invalid('Image response was not JSON', cause);
    }
  }

  /**
   * Read from the host's health, which carries an `images` field once it
   * serves these routes. Never throws for an older or unreachable host.
   */
  async support(opts: RequestOptions = {}): Promise<ImageSupport> {
    try {
      const response = await this.fetchFn(`${this.baseUrl}/api/health`, {
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!response.ok) return { supported: false, available: false };
      const health = (await response.json()) as { images?: { available?: unknown } };
      if (!health.images || typeof health.images !== 'object') {
        return { supported: false, available: false };
      }
      return { supported: true, available: health.images.available === true };
    } catch {
      opts.signal?.throwIfAborted();
      return { supported: false, available: false };
    }
  }

  /** Installed and downloadable image models, with how each fits this computer. */
  async models(opts: RequestOptions = {}): Promise<ImageModel[]> {
    const raw = await this.json('/v1/images/models', { method: 'GET' }, opts);
    const parsed = AppImageModelListSchema.safeParse(raw);
    if (!parsed.success) throw invalid('Invalid image model list', parsed.error);
    return parsed.data.data;
  }

  /** Make a model ready, downloading it in the background when needed. */
  async ensure(model: string, opts: RequestOptions = {}): Promise<ImageModelEnsureResult> {
    const raw = await this.json(
      '/v1/images/models/ensure',
      { method: 'POST', body: JSON.stringify({ model }) },
      opts,
    );
    const parsed = AppEnsureResultSchema.safeParse(raw);
    if (!parsed.success) throw invalid('Invalid image model ensure response', parsed.error);
    return parsed.data.status === 'ready'
      ? { status: 'ready', modelId: parsed.data.model_id }
      : { status: 'downloading', modelId: parsed.data.model_id, jobId: parsed.data.job_id };
  }

  /**
   * A download's events until it finishes. Stopping iteration stops
   * watching, not the download; {@link cancelEnsure} stops it.
   */
  async *ensureEvents(
    jobId: string,
    opts: RequestOptions = {},
  ): AsyncIterable<ImageModelEnsureEvent> {
    const response = await this.fetchFn(
      `${this.baseUrl}/v1/images/models/ensure/${encodeURIComponent(jobId)}/events`,
      { headers: this.headers(), ...(opts.signal ? { signal: opts.signal } : {}) },
    );
    if (!response.ok) throw await errorFromResponse(response);
    if (!response.body) throw invalid('Image model download stream had no body');
    for await (const chunk of readSseDataChunks(response.body, opts.signal)) {
      if (!chunk) continue;
      let event: ImageModelEnsureEvent;
      try {
        event = AppEnsureEventSchema.parse(JSON.parse(chunk));
      } catch (cause) {
        throw invalid('Invalid image model download event', cause);
      }
      if (event.jobId !== jobId) throw invalid('Download event belongs to another job');
      yield event;
      if (event.type === 'done' || event.type === 'error') return;
    }
    throw new GezelSdkError('Image model download stream ended before completion', {
      code: 'incomplete_stream',
    });
  }

  /** Stop a download. A later {@link ensure} resumes it. */
  async cancelEnsure(jobId: string, opts: RequestOptions = {}): Promise<void> {
    await this.json(
      `/v1/images/models/ensure/${encodeURIComponent(jobId)}`,
      { method: 'DELETE' },
      opts,
    );
  }

  /** Remove an installed model. A model shared from another store refuses with `shared_model`. */
  async remove(model: string, opts: RequestOptions = {}): Promise<void> {
    const response = await this.fetchFn(
      `${this.baseUrl}/v1/images/models/${encodeURIComponent(model)}`,
      {
        method: 'DELETE',
        headers: this.headers(),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
    if (!response.ok) throw await errorFromResponse(response);
    await response.body?.cancel();
  }

  /**
   * Render one image. Progress arrives through `onProgress`; aborting the
   * signal stops the render (the engine is stopped, so the next render
   * reloads its weights).
   */
  async generate(
    input: ImageGenerateInput,
    opts: ImageGenerateOptions = {},
  ): Promise<GeneratedImage> {
    const body: AppImageGenerationRequest = {
      prompt: input.prompt,
      ...(input.negativePrompt ? { negative_prompt: input.negativePrompt } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
      ...(input.quality ? { quality: input.quality } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    };
    const response = await this.fetchFn(`${this.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (!response.ok) throw await errorFromResponse(response);
    if (!response.body) throw invalid('Image generation stream had no body');
    for await (const chunk of readSseDataChunks(
      response.body,
      opts.signal,
      MAX_IMAGE_FRAME_BYTES,
    )) {
      if (!chunk) continue;
      const parsed = (() => {
        try {
          return AppImageGenerationEventSchema.safeParse(JSON.parse(chunk));
        } catch (cause) {
          throw invalid('Image generation event was not JSON', cause);
        }
      })();
      if (!parsed.success) throw invalid('Invalid image generation event', parsed.error);
      const event = parsed.data;
      if (event.type === 'progress') {
        try {
          opts.onProgress?.({
            phase: event.phase,
            step: event.step,
            totalSteps: event.total_steps,
            ...(event.seconds_per_step !== undefined
              ? { secondsPerStep: event.seconds_per_step }
              : {}),
          });
        } catch {
          /* a listener cannot fail the render */
        }
        continue;
      }
      if (event.type === 'error') {
        throw new GezelSdkError(event.error.message, { code: event.error.code });
      }
      return {
        png: base64ToBytes(event.b64_png),
        width: event.width,
        height: event.height,
        seed: event.seed,
        model: event.model,
        steps: event.steps,
        durationMs: event.duration_ms,
      };
    }
    opts.signal?.throwIfAborted();
    throw new GezelSdkError('Image generation stream ended before the image', {
      code: 'incomplete_stream',
    });
  }
}
