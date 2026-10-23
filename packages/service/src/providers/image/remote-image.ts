/**
 * RemoteImageProvider — Device A's `ImageProvider` backed by a paired server's
 * image engine. `generate()` RPCs to `B/v1/remote/image/generate`; the PNG
 * streams back and A's existing route persists it into A's project (so a
 * GPU-heavy generation runs on B but the artifact lands on A — identical to
 * local). B manages its own weights, so pull/delete are rejected here.
 *
 * This is the template the video + audio remote providers follow.
 */

import { parseRemoteModelId } from '../remote/model-id.js';
import type {
  ImageEngineHealth,
  ImageGenerationInput,
  ImageGenerationOutput,
  ImageModelPullEvent,
  ImageModelPullSpec,
  ImageProvider,
  InstalledImageModelInfo,
} from './types.js';

export interface RemoteImageProviderOpts {
  remoteId: string;
  label: string;
  baseUrl: string;
  token: string;
  fetch: typeof fetch;
  /**
   * The person's configured local default (`config.defaultImageModel['sd-cpp']`).
   * The machine broker serves the same catalog ids, so a request that names
   * no model runs this one there instead of the broker's alphabetically first.
   */
  defaultModelId?: () => Promise<string | undefined>;
}

export class RemoteImageProvider implements ImageProvider {
  readonly name: string;

  constructor(private readonly opts: RemoteImageProviderOpts) {
    this.name = `remote:${opts.label}`;
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.token}` };
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    const model = input.model
      ? (parseRemoteModelId(input.model)?.modelId ?? input.model)
      : this.opts.defaultModelId
        ? await this.resolveDefaultModelId()
        : undefined;
    const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/remote/image/generate`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        prompt: input.prompt,
        ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
        ...(model ? { model } : {}),
        ...(input.width ? { width: input.width } : {}),
        ...(input.height ? { height: input.height } : {}),
        ...(input.steps ? { steps: input.steps } : {}),
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        ...(input.strength !== undefined ? { strength: input.strength } : {}),
        ...(input.inputImages && input.inputImages.length > 0
          ? {
              inputImages: input.inputImages.map((i) => ({
                data: i.data.toString('base64'),
                mimeType: i.mimeType,
              })),
            }
          : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(
        `[remote-image] generate failed HTTP ${res.status} ${await res.text().catch(() => '')}`.trim(),
      );
    }
    const body = (await res.json()) as { meta: ImageGenerationOutput['meta']; png: string };
    return { png: Buffer.from(body.png, 'base64'), meta: body.meta };
  }

  /** The configured default when the server has it installed, else its first model. */
  async resolveDefaultModelId(): Promise<string | undefined> {
    const models = await this.listInstalledModels();
    const configured = await this.opts.defaultModelId?.();
    return configured && models.some((m) => m.id === configured) ? configured : models[0]?.id;
  }

  async listInstalledModels(): Promise<InstalledImageModelInfo[]> {
    const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/remote/image/models`, {
      headers: this.headers(),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: InstalledImageModelInfo[] };
    return body.models ?? [];
  }

  // biome-ignore lint/correctness/useYield: nothing to pull — remote servers manage their own weights, so this generator only rejects.
  async *pullModel(_id: string, _spec: ImageModelPullSpec): AsyncIterable<ImageModelPullEvent> {
    throw new Error(
      'Remote servers manage their own image models — install on the server directly.',
    );
  }

  async deleteModel(): Promise<void> {
    throw new Error('Remote servers manage their own image models.');
  }

  async health(): Promise<ImageEngineHealth> {
    try {
      const res = await this.opts.fetch(`${this.opts.baseUrl}/v1/remote/image/health`, {
        headers: this.headers(),
      });
      if (!res.ok) {
        return { status: 'unreachable', baseUrl: this.opts.baseUrl, error: `HTTP ${res.status}` };
      }
      return (await res.json()) as ImageEngineHealth;
    } catch (err) {
      return {
        status: 'unreachable',
        baseUrl: this.opts.baseUrl,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
