import type { GezelApp } from './client.js';
import { type EmbeddingConnection, type EmbeddingOptions, createEmbedding } from './embedding.js';
import { GezelSdkError } from './errors.js';
import { connectOrHost } from './gezel.js';
import type { ConnectOrHostInput, EnsureModelEngine } from './host-types.js';
import type { ImagesClient } from './images-client.js';
import { type ModelProgress, createHttpModelManager, createModelManager } from './model-manager.js';

export interface DesktopEmbeddingOptions
  extends Omit<ConnectOrHostInput, 'scopes' | 'requireVerificationCode'>,
    Pick<EmbeddingOptions, 'onState'> {
  /** Adds only catalog authority, never product/project authority. */
  knowledge?: boolean;
  /** Optional narrower set for the application's native distribution. */
  hostedEngines?: readonly EnsureModelEngine[];
  /**
   * Offer on-device image generation when this Gezel serves it. Never part
   * of the first consent: a standalone Gezel grants it later, from an
   * explicit `images.requestAccess()`, so connecting never asks for more
   * than chat needs. Hosted inference has it whenever an engine is present.
   */
  images?: boolean;
}

/**
 * - `granted`: image calls work.
 * - `needs-approval`: a standalone Gezel serves images but this app's grant
 *   lacks them; ask with `requestAccess()`.
 * - `no-engine`: this Gezel serves images but cannot render on this computer.
 * - `unsupported`: this Gezel predates image generation for apps.
 */
export type DesktopImageAccess = 'granted' | 'needs-approval' | 'no-engine' | 'unsupported';

export interface DesktopEmbeddingImages
  extends Pick<
    ImagesClient,
    'models' | 'ensure' | 'ensureEvents' | 'cancelEnsure' | 'remove' | 'generate'
  > {
  access(opts?: { signal?: AbortSignal }): Promise<DesktopImageAccess>;
  /**
   * Ask the person to allow image generation. Shows Gezel's approval prompt;
   * the app shows the code. The current grant keeps working throughout.
   * A no-op on hosted inference.
   */
  requestAccess(opts: { onVerificationCode(code: string): Promise<void> | void }): Promise<void>;
}

export interface DesktopEmbeddingConnection extends EmbeddingConnection {
  app: GezelApp;
  mode: 'installed' | 'hosted';
  /** Present when requested with `images: true`. */
  images?: DesktopEmbeddingImages;
  /** Withdraw a standalone grant and remove its saved token. Hosted connections have no grant. */
  revoke(): Promise<void>;
}

/** For applications that already own their lifecycle; shares the factory's connection policy. */
export async function connectDesktopEmbedding(
  options: DesktopEmbeddingOptions,
  request: { interactive: boolean },
): Promise<DesktopEmbeddingConnection> {
  const {
    onState: _onState,
    onVerificationCode,
    host,
    knowledge,
    hostedEngines,
    images,
    ...connection
  } = options;
  const scopes = knowledge ? ['openai', 'knowledge'] : ['openai'];
  const gezel = await connectOrHost({
    ...connection,
    scopes,
    requireVerificationCode: true,
    ...(request.interactive && onVerificationCode ? { onVerificationCode } : {}),
    ...(host
      ? { host: { ...host, mode: 'in-process', inferenceOnly: true, systemBootstrap: false } }
      : {}),
  });
  const allowed = new Set(hostedEngines ?? ['llama-cpp', 'mlx', 'ds4']);
  if (host?.distributionProfile === 'store') allowed.delete('mlx');
  const parts = (id: string) => {
    const separator = id.indexOf(':');
    const engine = id.slice(0, separator) as EnsureModelEngine;
    return separator > 0 && id.slice(separator + 1) && allowed.has(engine)
      ? { engine, model: id.slice(separator + 1) }
      : null;
  };
  const models = gezel.hosting
    ? createModelManager({
        cancellation: 'observation',
        prepareAvailable: true,
        list: async (opts) =>
          (await gezel.openai.models(opts)).data.filter(
            (entry) => entry.owned_by === 'apple-foundation-models' || parts(entry.id) !== null,
          ),
        async prepare(id, opts) {
          if (id === 'apple-foundation-models:apple-foundation-models') return id;
          const model = parts(id);
          if (!model)
            throw new GezelSdkError('Choose a supported local model', {
              code: 'model_unavailable',
            });
          await gezel.ensureModel({
            ...model,
            pinAsDefault: false,
            allowWeightDownload: opts.allowDownload === true,
            signal: opts.signal,
            onEvent(event) {
              if (event.phase === 'ready') return;
              const progress: ModelProgress = {
                phase:
                  event.phase === 'engine'
                    ? 'engine'
                    : event.phase === 'weights' || event.phase === 'bundle'
                      ? 'downloading'
                      : 'preparing',
                message: event.message,
                ...('percent' in event && event.percent !== undefined
                  ? { percent: event.percent }
                  : {}),
              };
              if (event.phase === 'weights') {
                progress.bytesWritten = event.bytesWritten;
                progress.totalBytes = event.totalBytes;
              } else if (event.phase === 'bundle') {
                progress.bytesWritten = event.bytesCompleted;
                progress.totalBytes = event.bytesTotal;
              }
              opts.onProgress?.(progress);
            },
          });
          return id;
        },
      })
    : createHttpModelManager(gezel.openai);
  let closing: Promise<void> | undefined;
  const client = gezel.openai.images;
  const imageSurface: DesktopEmbeddingImages = {
    models: (opts) => client.models(opts),
    ensure: (model, opts) => client.ensure(model, opts),
    ensureEvents: (jobId, opts) => client.ensureEvents(jobId, opts),
    cancelEnsure: (jobId, opts) => client.cancelEnsure(jobId, opts),
    remove: (model, opts) => client.remove(model, opts),
    generate: (input, opts) => client.generate(input, opts),
    async access(opts = {}) {
      const support = await client.support(opts);
      if (!support.supported) return 'unsupported';
      if (!support.available) return 'no-engine';
      if (gezel.hosting) return 'granted';
      try {
        await client.models(opts);
        return 'granted';
      } catch (error) {
        if (error instanceof GezelSdkError && error.code === 'missing_scope:images') {
          return 'needs-approval';
        }
        throw error;
      }
    },
    async requestAccess({ onVerificationCode: showCode }) {
      if (gezel.hosting) return;
      await gezel.openai.requestScopes({
        appId: options.appId,
        appName: options.appName,
        scopes: [...scopes, 'images'],
        onVerificationCode: showCode,
        ...(options.iconUrl ? { iconUrl: options.iconUrl } : {}),
        ...(options.approvalTimeoutSec ? { approvalTimeoutSec: options.approvalTimeoutSec } : {}),
        ...(options.tokenStorage ? { tokenStorage: options.tokenStorage } : {}),
      });
    },
  };
  return {
    app: gezel.openai,
    models,
    ...(knowledge ? { knowledge: gezel.openai.knowledge } : {}),
    ...(images ? { images: imageSurface } : {}),
    mode: gezel.hosting ? 'hosted' : 'installed',
    async revoke() {
      if (gezel.hosting) return;
      try {
        await gezel.openai.revokeMyToken(options.appId);
      } finally {
        await options.tokenStorage?.delete?.(options.appId);
      }
    },
    close() {
      closing ??= (async () => {
        try {
          await models.close();
        } finally {
          await gezel.close();
        }
      })();
      return closing;
    },
  };
}

/** Starts disabled. Only an explicit reconnect may request a fresh grant. */
export function createDesktopEmbedding(options: DesktopEmbeddingOptions) {
  return createEmbedding({
    onState: options.onState,
    connect: (request) => connectDesktopEmbedding(options, request),
  });
}
