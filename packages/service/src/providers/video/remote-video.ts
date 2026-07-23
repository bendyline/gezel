/**
 * RemoteVideoProvider — Device A's `VideoProvider` backed by a paired server's
 * video engine. Mirrors RemoteImageProvider: `generate()` RPCs to
 * `B/v1/remote/video/generate`, the clip + poster stream back, and A's existing
 * route persists them into A's project. B manages its own weights.
 *
 * v1 carries the clip base64-in-JSON (fine for short clips); a chunked
 * octet-stream path is a future optimization for long videos.
 */

import { parseRemoteModelId } from '../remote/model-id.js';
import type {
  InstalledVideoModelInfo,
  VideoEngineHealth,
  VideoGenerationInput,
  VideoGenerationOutput,
  VideoModelPullEvent,
  VideoProvider,
} from './types.js';

export interface RemoteVideoProviderOpts {
  remoteId: string;
  label: string;
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
}

export class RemoteVideoProvider implements VideoProvider {
  readonly name: string;

  constructor(private readonly opts: RemoteVideoProviderOpts) {
    this.name = `remote:${opts.label}`;
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.token}` };
  }

  async generate(input: VideoGenerationInput): Promise<VideoGenerationOutput> {
    const model = input.model
      ? (parseRemoteModelId(input.model)?.modelId ?? input.model)
      : undefined;
    const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/remote/video/generate`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
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
      }),
    });
    if (!res.ok) {
      throw new Error(
        `[remote-video] generate failed HTTP ${res.status} ${await res.text().catch(() => '')}`.trim(),
      );
    }
    const body = (await res.json()) as {
      meta: VideoGenerationOutput['meta'];
      video: string;
      poster?: string;
    };
    return {
      video: Buffer.from(body.video, 'base64'),
      ...(body.poster ? { poster: Buffer.from(body.poster, 'base64') } : {}),
      meta: body.meta,
    };
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
