/**
 * RemoteVideoProvider — Device A's `VideoProvider` backed by a paired server's
 * video engine (or this computer's machine broker). Mirrors
 * RemoteImageProvider: `generate()` RPCs to B, the clip + poster come back,
 * and A's existing route persists them into A's project. B manages its own
 * weights.
 *
 * `generate()` reads `B/v1/remote/video/generate-stream`: the engine's status
 * lines and sampling steps arrive as they happen, `:` keep-alives every
 * REMOTE_STREAM_HEARTBEAT_MS say the line is up through a decode that reports
 * nothing for half an hour, and hanging up stops B's render. A server from
 * before that route answers 404 and gets the one-shot `/video/generate`.
 *
 * The clip travels base64-in-JSON in the last frame (fine for short clips); a
 * chunked octet-stream path is a future optimization for long videos.
 */

import { parseRemoteModelId } from '../remote/model-id.js';
import { REMOTE_STREAM_IDLE_MS, readSseFrames } from '../remote/session.js';
import {
  type InstalledVideoModelInfo,
  VideoCapacityError,
  type VideoEngineHealth,
  VideoGenerationCancelledError,
  type VideoGenerationInput,
  type VideoGenerationMeta,
  type VideoGenerationOutput,
  type VideoGenerationProgress,
  type VideoModelPullEvent,
  type VideoProvider,
  VideoRenderTimedOutError,
} from './types.js';

/** `POST /v1/remote/video/generate-stream` frames, each one SSE `data:` JSON. */
export type RemoteVideoGenFrame =
  | { type: 'status'; message: string }
  | { type: 'progress'; progress: VideoGenerationProgress }
  | { type: 'done'; result: RemoteVideoGenResult }
  | { type: 'error'; error: string; code?: string };

/** The clip as B returns it, from either route. */
export interface RemoteVideoGenResult {
  meta: VideoGenerationMeta;
  video: string;
  poster?: string;
}

/**
 * The expected outcomes keep their class across the wire, so A's route
 * answers a smaller-clip hint as a 409 rather than an opaque 500.
 */
export function remoteVideoError(message: string, code: string | undefined): Error {
  if (code === 'video_capacity') return new VideoCapacityError(message);
  if (code === 'video_render_timed_out') return new VideoRenderTimedOutError(message);
  if (code === 'video_generation_cancelled') return new VideoGenerationCancelledError(message);
  return new Error(message);
}

export interface RemoteVideoProviderOpts {
  remoteId: string;
  label: string;
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
  /**
   * The machine broker: this computer's own engine host, which renders
   * on-device only. Any other paired server renders on another computer with
   * whatever engine it has picked.
   */
  onThisComputer?: boolean;
}

export class RemoteVideoProvider implements VideoProvider {
  readonly name: string;
  readonly onThisComputer: boolean;

  constructor(private readonly opts: RemoteVideoProviderOpts) {
    this.name = `remote:${opts.label}`;
    this.onThisComputer = opts.onThisComputer ?? false;
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.token}` };
  }

  async generate(input: VideoGenerationInput): Promise<VideoGenerationOutput> {
    const model = input.model
      ? (parseRemoteModelId(input.model)?.modelId ?? input.model)
      : undefined;
    const body = JSON.stringify({
      prompt: input.prompt,
      ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
      ...(model ? { model } : {}),
      ...(input.width ? { width: input.width } : {}),
      ...(input.height ? { height: input.height } : {}),
      ...(input.numFrames ? { numFrames: input.numFrames } : {}),
      ...(input.fps ? { fps: input.fps } : {}),
      ...(input.steps ? { steps: input.steps } : {}),
      ...(input.guidanceScale !== undefined ? { guidanceScale: input.guidanceScale } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      ...(input.inputImage
        ? {
            inputImage: {
              data: input.inputImage.data.toString('base64'),
              mimeType: input.inputImage.mimeType,
            },
          }
        : {}),
    });
    try {
      const result =
        (await this.generateStreaming(input, body)) ?? (await this.generateOnce(input, body));
      return {
        video: Buffer.from(result.video, 'base64'),
        ...(result.poster ? { poster: Buffer.from(result.poster, 'base64') } : {}),
        meta: result.meta,
      };
    } catch (err) {
      if (input.signal?.aborted && !(err instanceof VideoGenerationCancelledError)) {
        throw new VideoGenerationCancelledError('The video render was stopped.');
      }
      throw err;
    }
  }

  /** `null` when B predates the streaming route. */
  private async generateStreaming(
    input: VideoGenerationInput,
    body: string,
  ): Promise<RemoteVideoGenResult | null> {
    const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/remote/video/generate-stream`, {
      method: 'POST',
      headers: { ...this.headers(), Accept: 'text/event-stream' },
      ...(input.signal ? { signal: input.signal } : {}),
      body,
    });
    if (res.status === 404 || res.status === 405) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok || !res.body) {
      throw new Error(
        `[remote-video] generate failed HTTP ${res.status} ${await res.text().catch(() => '')}`.trim(),
      );
    }
    let result: RemoteVideoGenResult | undefined;
    let failure: Error | undefined;
    const ended = await readSseFrames(
      res.body,
      (raw) => {
        const frame = raw as RemoteVideoGenFrame;
        if (frame.type === 'status') notify(() => input.onStatus?.(frame.message));
        else if (frame.type === 'progress') notify(() => input.onProgress?.(frame.progress));
        else if (frame.type === 'error') failure = remoteVideoError(frame.error, frame.code);
        else if (frame.type === 'done') result = frame.result;
      },
      { idleMs: REMOTE_STREAM_IDLE_MS },
    );
    if (failure) throw failure;
    if (result) return result;
    throw new Error(
      ended === 'stalled'
        ? `[remote-video] ${this.opts.label} stopped answering during the render`
        : `[remote-video] ${this.opts.label} ended the render without a clip`,
    );
  }

  private async generateOnce(
    input: VideoGenerationInput,
    body: string,
  ): Promise<RemoteVideoGenResult> {
    const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/remote/video/generate`, {
      method: 'POST',
      headers: this.headers(),
      ...(input.signal ? { signal: input.signal } : {}),
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const parsed = parseErrorBody(text);
      if (parsed?.code) throw remoteVideoError(parsed.error, parsed.code);
      throw new Error(`[remote-video] generate failed HTTP ${res.status} ${text}`.trim());
    }
    return (await res.json()) as RemoteVideoGenResult;
  }

  async listInstalledModels(): Promise<InstalledVideoModelInfo[]> {
    const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/remote/video/models`, {
      headers: this.headers(),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: InstalledVideoModelInfo[] };
    return body.models ?? [];
  }

  // biome-ignore lint/correctness/useYield: nothing to pull — remote servers manage their own weights, so this generator only rejects.
  async *pullModel(_id: string): AsyncIterable<VideoModelPullEvent> {
    throw new Error(
      'Remote servers manage their own video models — install on the server directly.',
    );
  }

  async deleteModel(): Promise<void> {
    throw new Error('Remote servers manage their own video models.');
  }

  async health(): Promise<VideoEngineHealth> {
    try {
      const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/remote/video/health`, {
        headers: this.headers(),
      });
      if (!res.ok) {
        return { status: 'unreachable', baseUrl: this.opts.baseUrl, error: `HTTP ${res.status}` };
      }
      return (await res.json()) as VideoEngineHealth;
    } catch (err) {
      return {
        status: 'unreachable',
        baseUrl: this.opts.baseUrl,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/** A listener that throws must not end the render. */
function notify(call: () => void): void {
  try {
    call();
  } catch {
    /* swallowed, as the local providers do */
  }
}

function parseErrorBody(text: string): { error: string; code?: string } | undefined {
  try {
    const body = JSON.parse(text) as { error?: unknown; code?: unknown };
    if (typeof body.error !== 'string') return undefined;
    return { error: body.error, ...(typeof body.code === 'string' ? { code: body.code } : {}) };
  } catch {
    return undefined;
  }
}
