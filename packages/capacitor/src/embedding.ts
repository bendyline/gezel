import {
  type EmbeddingConnection,
  type EmbeddingOptions,
  createEmbedding,
} from '@bendyline/gezel-app-sdk/browser';
import type { GezelRuntimePlugin } from './definitions.js';
import { type MobileModelManagerOptions, createMobileModelManager } from './model-manager.js';
import { connectRuntime } from './transport.js';

const owners = new WeakMap<GezelRuntimePlugin, number>();

export function connectEmbeddingRuntime(
  runtime: GezelRuntimePlugin,
  options: MobileModelManagerOptions = {},
): EmbeddingConnection {
  const app = connectRuntime(runtime);
  const models = createMobileModelManager(runtime, options);
  owners.set(runtime, (owners.get(runtime) ?? 0) + 1);
  let closing: Promise<void> | undefined;
  return {
    app,
    models,
    close() {
      closing ??= (async () => {
        try {
          await models.close();
        } finally {
          try {
            await app.close();
          } finally {
            const remaining = (owners.get(runtime) ?? 1) - 1;
            if (remaining > 0) owners.set(runtime, remaining);
            else {
              owners.delete(runtime);
              await runtime.releaseModel();
            }
          }
        }
      })();
      return closing;
    },
  };
}
export function createRuntimeEmbedding(
  runtime: GezelRuntimePlugin,
  options: MobileModelManagerOptions & Pick<EmbeddingOptions, 'onState'> = {},
) {
  return createEmbedding({
    ...options,
    connect: async () => connectEmbeddingRuntime(runtime, options),
  });
}
