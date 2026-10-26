import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAwakeTimeout } from '@bendyline/gezel';
import { safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import { copilotImageSettings, decodeCopilotImage } from './copilot-image-settings.js';
import {
  COPILOT_IMAGE_UPDATE,
  type CopilotImageClient,
  type CopilotImageModel,
  type CopilotImageRuntimeOptions,
  CopilotImageSetupError,
  copilotImageModel,
  createCopilotImageClient,
} from './copilot-runtime.js';
import {
  type ImageEngineHealth,
  ImageGenerationCancelledError,
  type ImageGenerationInput,
  type ImageGenerationOutput,
  type ImageModelPullEvent,
  type ImageModelPullSpec,
  type ImageProvider,
  type InstalledImageModelInfo,
} from './types.js';

const BASE_URL = 'https://api.githubcopilot.com';
const TOOL = 'image_generation';
const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

interface Options extends CopilotImageRuntimeOptions {
  clientFactory?: () => Promise<CopilotImageClient>;
}

/** Native SDK tool invocation keeps prompts/settings independent of the chat model and its tool loop. */
export class CopilotImageProvider implements ImageProvider {
  readonly name = 'copilot';
  private readonly active = new Set<AbortController>();
  private probe: Promise<{ health: ImageEngineHealth; model?: CopilotImageModel }> | undefined;

  constructor(private readonly opts: Options) {}

  private async withClient<T>(
    work: (client: CopilotImageClient, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) throw new ImageGenerationCancelledError();
    const shutdown = new AbortController();
    this.active.add(shutdown);
    const timeout = createAwakeTimeout(10 * 60_000, {
      reason: () =>
        new Error(
          'Copilot image generation timed out. Check your account before retrying; the request may have completed.',
        ),
    });
    const combined = AbortSignal.any([
      shutdown.signal,
      timeout.signal,
      ...(signal ? [signal] : []),
    ]);
    let client: CopilotImageClient | undefined;
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        void client?.stop().catch(() => {});
        reject(
          timeout.signal.aborted ? timeout.signal.reason : new ImageGenerationCancelledError(),
        );
      };
      combined.addEventListener('abort', onAbort, { once: true });
    });
    const task = (async () => {
      client = await (this.opts.clientFactory?.() ?? createCopilotImageClient(this.opts));
      try {
        combined.throwIfAborted();
        await client.start();
        combined.throwIfAborted();
        return await work(client, combined);
      } finally {
        await client.stop().catch(() => {});
      }
    })();
    try {
      return await Promise.race([task, aborted]);
    } finally {
      combined.removeEventListener('abort', onAbort);
      timeout.dispose();
      this.active.delete(shutdown);
    }
  }

  private inspect() {
    if (!this.probe) {
      this.probe = this.withClient(async (client) => {
        const model = await copilotImageModel(client, this.opts.githubToken);
        return { health: { status: 'ok' as const, baseUrl: BASE_URL }, model };
      })
        .catch((error: unknown) => ({
          health: {
            status:
              error instanceof CopilotImageSetupError
                ? ('not-configured' as const)
                : ('unreachable' as const),
            baseUrl: BASE_URL,
            error: error instanceof Error ? error.message : String(error),
          },
        }))
        .finally(() => {
          this.probe = undefined;
        });
    }
    return this.probe;
  }

  async health(): Promise<ImageEngineHealth> {
    return (await this.inspect()).health;
  }

  async listInstalledModels(): Promise<InstalledImageModelInfo[]> {
    const { model } = await this.inspect();
    return model
      ? [
          {
            id: model.id,
            name: model.name,
            installedAt: '2026-10-22T00:00:00.000Z',
            approxSizeBytes: 0,
            supportsImg2Img: model.supportedOperations.includes('edit'),
          },
        ]
      : [];
  }

  async resolveDefaultModelId(): Promise<string | undefined> {
    return (await this.inspect()).model?.id;
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    const settings = copilotImageSettings(input);
    const sources = input.inputImages ?? [];
    if (sources.length > 16 || sources.some((image) => !MIME_EXTENSIONS[image.mimeType])) {
      throw new Error('Copilot accepts up to 16 PNG, JPEG, or WebP reference images.');
    }
    if (
      sources.reduce((bytes, image) => bytes + Math.ceil(image.data.length / 3) * 4, 0) >
      31 * 1024 * 1024
    ) {
      throw new Error(
        'The reference images are too large for Copilot. Use fewer or smaller images.',
      );
    }
    const startedAt = Date.now();
    return this.withClient(async (client, signal) => {
      const model = await copilotImageModel(client, this.opts.githubToken);
      const operation = sources.length ? 'edit' : 'generate';
      if (!model.supportedOperations.includes(operation)) {
        throw new CopilotImageSetupError(
          `This Copilot account cannot ${operation} images with ${model.name}.`,
        );
      }
      if (input.model?.trim() && input.model.trim() !== model.id) {
        throw new Error(
          `Copilot currently uses ${model.name} (${model.id}). It cannot select image model ${input.model}.`,
        );
      }
      signal.throwIfAborted();
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'gezel-copilot-image-')));
      try {
        const paths: string[] = [];
        for (const [index, source] of sources.entries()) {
          const path = safeJoin(dir, `input-${index}.${MIME_EXTENSIONS[source.mimeType]}`);
          if (!path) throw new Error('Invalid Copilot reference-image path.');
          await writeFile(path, source.data, { mode: 0o600, flag: 'wx' });
          paths.push(path);
        }
        signal.throwIfAborted();
        const session = await client.createSession({
          workingDirectory: dir,
          configDirectory: dir,
          enableConfigDiscovery: false,
          imageGeneration: { enabled: true, saveToDisk: false },
          availableTools: [TOOL],
          mcpServers: {},
          onPermissionRequest: (request: Record<string, unknown>) => {
            const permitted =
              request.managedApprovalRequired !== true &&
              ((request.kind === 'custom-tool' && request.toolName === TOOL) ||
                (request.kind === 'read' &&
                  typeof request.path === 'string' &&
                  paths.includes(request.path)));
            return permitted
              ? { kind: 'approve-once' }
              : {
                  kind: 'reject',
                  feedback:
                    'Only image generation and the selected reference images are permitted.',
                };
          },
        });
        let rejectAborted: (reason: unknown) => void = () => {};
        const aborted = new Promise<never>((_, reject) => {
          rejectAborted = reject;
        });
        const abort = () => {
          void session.abort().catch(() => {});
          rejectAborted(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          signal.throwIfAborted();
          if (!session.rpc?.tools?.execute || !session.rpc.tools.initializeAndValidate)
            throw new CopilotImageSetupError(COPILOT_IMAGE_UPDATE);
          const execute = async () => {
            await session.rpc.tools.initializeAndValidate();
            signal.throwIfAborted();
            return session.rpc.tools.execute({
              name: TOOL,
              arguments: {
                ...settings.arguments,
                ...(paths.length ? { input_images: paths.map((path) => ({ path })) } : {}),
              },
            });
          };
          const result = await Promise.race([execute(), aborted]);
          signal.throwIfAborted();
          const image = decodeCopilotImage(result);
          const notes = [...settings.notes];
          const actualSize = `${image.width}x${image.height}`;
          if (settings.arguments.size && settings.arguments.size !== actualSize)
            notes.push(
              `Copilot returned ${actualSize} instead of the requested ${settings.arguments.size}.`,
            );
          return {
            png: image.png,
            meta: {
              model: model.id,
              seed: 0,
              steps: 0,
              widthPx: image.width,
              heightPx: image.height,
              durationMs: Date.now() - startedAt,
              ...(notes.length ? { settingsNotes: notes } : {}),
            },
          };
        } finally {
          signal.removeEventListener('abort', abort);
          const disconnected = session.disconnect().catch(() => {});
          if (!signal.aborted) await disconnected;
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, input.signal);
  }

  // biome-ignore lint/correctness/useYield: Copilot manages its image model.
  async *pullModel(_id: string, _spec: ImageModelPullSpec): AsyncIterable<ImageModelPullEvent> {
    throw new Error('Copilot manages its cloud image model; no download is needed.');
  }

  async deleteModel(_id: string): Promise<void> {
    throw new Error('Copilot manages its cloud image model.');
  }

  async shutdown(): Promise<void> {
    for (const controller of this.active) controller.abort();
  }
}
