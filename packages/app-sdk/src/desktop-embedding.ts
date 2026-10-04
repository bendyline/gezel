import { type EmbeddingOptions, createEmbedding } from './embedding.js';
import { GezelSdkError } from './errors.js';
import { connectOrHost } from './gezel.js';
import type { ConnectOrHostInput } from './host-types.js';
import { createHttpModelManager, createModelManager } from './model-manager.js';

export interface DesktopEmbeddingOptions
  extends Omit<ConnectOrHostInput, 'scopes' | 'requireVerificationCode'>,
    Pick<EmbeddingOptions, 'onState'> {}
/** Electron/Node factory with inference-only authority and gesture-only consent prompts. */
export function createDesktopEmbedding(options: DesktopEmbeddingOptions) {
  const { onState, onVerificationCode, host, ...connection } = options;
  return createEmbedding({
    onState,
    async connect({ interactive }) {
      if (host?.distributionProfile === 'store' && !host.nativeBinDir)
        throw new GezelSdkError('A store embedding requires a bundled native engine directory', {
          code: 'native_payload_required',
        });
      const gezel = await connectOrHost({
        ...connection,
        scopes: ['openai'],
        requireVerificationCode: true,
        ...(interactive && onVerificationCode ? { onVerificationCode } : {}),
        ...(host
          ? { host: { ...host, mode: 'in-process', inferenceOnly: true, systemBootstrap: false } }
          : {}),
      });
      const httpModels = createHttpModelManager(gezel.openai);
      const models = gezel.hosting
        ? createModelManager({
            cancellation: 'observation',
            list: async (opts) => (await gezel.openai.models(opts)).data,
            async prepare(id, opts) {
              const separator = id.indexOf(':');
              const engine = id.slice(0, separator);
              if (!['llama-cpp', 'mlx', 'ds4'].includes(engine))
                throw new GezelSdkError('Choose a downloadable local model', {
                  code: 'model_unavailable',
                });
              await gezel.ensureModel({
                engine: engine as 'llama-cpp' | 'mlx' | 'ds4',
                model: id.slice(separator + 1),
                pinAsDefault: false,
                allowWeightDownload: opts.allowDownload,
                signal: opts.signal,
                onEvent(event) {
                  if (event.phase === 'ready') return;
                  opts.onProgress?.({
                    phase: event.phase === 'engine' ? 'engine' : 'downloading',
                    message: event.message,
                  });
                },
              });
              return id;
            },
          })
        : httpModels;
      return {
        app: gezel.openai,
        models,
        async close() {
          try {
            await models.close();
            await httpModels.close();
          } finally {
            await gezel.close();
          }
        },
      };
    },
  });
}
