import type { GezelApp } from './client.js';
import { type EmbeddingConnection, type EmbeddingOptions, createEmbedding } from './embedding.js';
import { GezelSdkError } from './errors.js';
import { connectOrHost } from './gezel.js';
import type { ConnectOrHostInput, EnsureModelEngine } from './host-types.js';
import { type ModelProgress, createHttpModelManager, createModelManager } from './model-manager.js';

export interface DesktopEmbeddingOptions
  extends Omit<ConnectOrHostInput, 'scopes' | 'requireVerificationCode'>,
    Pick<EmbeddingOptions, 'onState'> {
  /** Adds only catalog authority, never product/project authority. */
  knowledge?: boolean;
  /** Optional narrower set for the application's native distribution. */
  hostedEngines?: readonly EnsureModelEngine[];
}

export interface DesktopEmbeddingConnection extends EmbeddingConnection {
  app: GezelApp;
  mode: 'installed' | 'hosted';
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
    ...connection
  } = options;
  const gezel = await connectOrHost({
    ...connection,
    scopes: knowledge ? ['openai', 'knowledge'] : ['openai'],
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
  return {
    app: gezel.openai,
    models,
    ...(knowledge ? { knowledge: gezel.openai.knowledge } : {}),
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
