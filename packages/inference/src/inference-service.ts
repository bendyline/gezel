import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import {
  GezelConfigSchema,
  type ProviderName,
  createLogger,
  startSuspendMonitor,
  stopSuspendMonitor,
} from '@bendyline/gezel';
import { BundledSource, CatalogService } from '@bendyline/gezel-catalog';
import { discoverNativeBinaries } from '@bendyline/gezel/native';
import { gezelHome } from '@bendyline/gezel/paths';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ZodError } from 'zod';
import { createEngineComponents } from './engine-components.js';
import { ConfigStore } from './fs/config-store.js';
import { ensurePrivateUserHome } from './fs/home-permissions.js';
import { enginesRoutes } from './http/routes/engines.js';
import { modelBundleRoutes } from './http/routes/model-bundles.js';
import { v1ChatRoutes } from './http/routes/v1-chat.js';
import { v1KnowledgeRoutes } from './http/routes/v1-knowledge.js';
import { v1ModelsEnsureRoutes } from './http/routes/v1-models-ensure.js';
import { v1ModelsRoutes } from './http/routes/v1-models.js';
import { KnowledgeManager } from './knowledge/manager.js';
import { createWorkerCatalogHost } from './knowledge/worker-host.js';
import { openEmbeddings, shutdownEmbeddings } from './memory/embeddings.js';
import { AppleFoundationModelsProvider } from './providers/apple-foundation-models/provider.js';
import { EngineInference } from './providers/native/inference.js';
import { resolveModelSessionDefaults } from './providers/session-defaults.js';
import type { LLMProvider } from './providers/types.js';
import { MlxRuntimeStatusBus } from './python/mlx-runtime-status-bus.js';
import { RelevanceModelManager } from './relevance/manager.js';
import { relevanceScorer } from './relevance/relevance-model.js';
import { acquireSingleInstanceLock } from './runtime-lock.js';
import { findServiceBundleResource } from './utils/service-worker-entry.js';
import './http/auth-context.js';
const log = createLogger('inference');
export interface InferenceServiceOptions {
  home?: string;
  /** Host-provided local providers, useful for testing without downloading weights. */
  providers?: ReadonlyMap<ProviderName, LLMProvider>;
  onUnexpectedHttpError?: (event: unknown) => void;
}
export interface RunningInferenceService {
  readonly profile: 'embedded-inference';
  readonly port: number;
  readonly cert: null;
  readonly clientToken: string;
  readonly fetch: typeof fetch;
  stop(): Promise<void>;
}
/** Direct Fetch host: no listener, product store, background downloads or daemon discovery. */
export async function startService(
  options: InferenceServiceOptions = {},
): Promise<RunningInferenceService> {
  const home = options.home ?? gezelHome();
  await ensurePrivateUserHome(home);
  const runtimeDir = join(home, 'runtime');
  const lock = await acquireSingleInstanceLock({ runtimeDir, lockPath: join(runtimeDir, 'lock') });
  const cleanup: Array<() => void | Promise<void>> = [() => lock.release()];
  const requests = new Set<AbortController>();
  let stopping: Promise<void> | undefined;
  let closed = false;
  const stop = () => {
    stopping ??= (async () => {
      closed = true;
      for (const controller of requests) controller.abort();
      const errors: unknown[] = [];
      for (const close of cleanup.reverse())
        try {
          await close();
        } catch (error) {
          errors.push(error);
        }
      if (errors.length) throw new AggregateError(errors, 'Inference shutdown failed');
    })();
    return stopping;
  };
  try {
    startSuspendMonitor();
    cleanup.push(() => stopSuspendMonitor());
    openEmbeddings();
    cleanup.push(() => shutdownEmbeddings(5000));
    const store = new ConfigStore(home);
    const bootConfig = await store.readConfig();
    discoverNativeBinaries({
      home,
      ...(bootConfig.llamaCppBackendOverride
        ? { llamaCppBackendOverride: bootConfig.llamaCppBackendOverride }
        : {}),
    });
    const dataDir =
      process.env.GEZEL_GILDE_DATA_DIR?.trim() ||
      findServiceBundleResource(import.meta.url, ['catalog']);
    if (!dataDir) throw new Error('The inference package is missing its model catalog');
    const catalog = new CatalogService([new BundledSource({ dataDir })]);
    const components = await createEngineComponents({
      home,
      catalog,
      bootConfig,
      mlxRuntimeStatus: new MlxRuntimeStatusBus(),
      scheduleInstallProbe: () => {},
    });
    cleanup.push(() => {
      components.cacheController.stop();
      components.engineBinaries.clear();
    });
    class HostedInference extends EngineInference {
      private apple?: AppleFoundationModelsProvider;
      override getProviderForModel(name: ProviderName, model?: string): Promise<LLMProvider> {
        if (closed) return Promise.reject(new Error('Inference is shutting down'));
        if (
          name !== 'llama-cpp' &&
          name !== 'mlx' &&
          name !== 'ds4' &&
          name !== 'apple-foundation-models'
        )
          return Promise.reject(new Error('Hosted inference only serves on-device models'));
        const supplied = options.providers?.get(name);
        if (supplied) return Promise.resolve(supplied);
        if (name === 'apple-foundation-models') {
          this.apple ??= new AppleFoundationModelsProvider();
          return Promise.resolve(this.apple);
        }
        return super.getProviderForModel(name, model);
      }
      override async listModelsForProvider(name: ProviderName) {
        const supplied = options.providers?.get(name);
        return supplied ? supplied.listModels() : super.listModelsForProvider(name);
      }
      resolveModelSessionDefaults(
        name: ProviderName,
        model: string | undefined,
        overrides?: Parameters<typeof resolveModelSessionDefaults>[4],
      ) {
        return resolveModelSessionDefaults(store, catalog, name, model, overrides);
      }
      override async shutdown() {
        const results = await Promise.allSettled([
          super.shutdown(),
          this.apple?.shutdown(),
          ...[...(options.providers?.values() ?? [])].map((p) => p.shutdown()),
        ]);
        const errors = results
          .filter((result) => result.status === 'rejected')
          .map((result) => result.reason);
        if (errors.length) throw new AggregateError(errors, 'Provider shutdown failed');
      }
    }
    const chat = new HostedInference({ home, store, catalog, ...components });
    cleanup.push(() => chat.shutdown());
    const knowledge = new KnowledgeManager({
      home,
      host: createWorkerCatalogHost(),
      catalog,
      readConfig: () => store.readConfig(),
      bundledHandboekArchive: null,
    });
    cleanup.push(() => knowledge.stop());
    await knowledge.start();
    const relevance = new RelevanceModelManager({ home, readConfig: () => store.readConfig() });
    cleanup.push(() => relevanceScorer().dispose());
    const context = { home, store, catalog, chat, knowledge, relevance, ...components };
    const clientToken = randomBytes(32).toString('base64url');
    const tokenBytes = Buffer.from(clientToken);
    const app = new Hono();
    app.onError((error, c) => {
      if (error instanceof ZodError)
        return c.json({ error: { code: 'invalid_request', message: error.message } }, 400);
      options.onUnexpectedHttpError?.({ error });
      log.error(String(error));
      return c.json({ error: { code: 'internal_error', message: error.message } }, 500);
    });
    app.get('/api/health', (c) =>
      c.json({ ok: true, serviceRole: 'user', profile: 'embedded-inference' }),
    );
    app.use('*', async (c, next) => {
      const candidate = Buffer.from(c.req.header('authorization')?.replace(/^Bearer /, '') ?? '');
      if (candidate.length !== tokenBytes.length || !timingSafeEqual(candidate, tokenBytes))
        return c.json({ error: 'Unauthorized' }, 401);
      c.set('auth', { appId: 'host', scopes: ['openai', 'knowledge'] });
      return next();
    });
    app.use('/v1/chat/*', bodyLimit({ maxSize: 4 * 1024 * 1024 }));
    app.route(
      '/v1/chat',
      v1ChatRoutes(context, {
        allowedProviders: ['llama-cpp', 'mlx', 'ds4', 'apple-foundation-models'],
      }),
    );
    app.route('/v1/models/ensure', v1ModelsEnsureRoutes(context));
    app.route('/v1/models', v1ModelsRoutes(context, { localOnly: true }));
    app.route('/v1/knowledge', v1KnowledgeRoutes(context));
    app.route('/api/engines', enginesRoutes(context));
    app.route('/api/model-bundles', modelBundleRoutes(context));
    for (const [engine, manager] of [
      ['llama-cpp', components.llamaCppModels],
      ['ds4', components.ds4Models],
      ['mlx', components.mlxModels],
    ] as const) {
      app.get(`/api/${engine}/models`, async (c) =>
        c.json({ models: await manager.listInstalled() }),
      );
    }
    app.get('/api/config', async (c) => c.json(await store.readConfig()));
    const pinSchema = GezelConfigSchema.pick({
      provider: true,
      defaultModel: true,
      firstRunCompleted: true,
    }).strict();
    app.put('/api/config', async (c) =>
      c.json(await store.writeConfig(pinSchema.parse(await c.req.json()))),
    );
    const transport: typeof fetch = async (input, init) => {
      if (closed) throw new Error('Inference is stopped');
      const request = new Request(input, init);
      const controller = new AbortController();
      requests.add(controller);
      const signal = AbortSignal.any([request.signal, controller.signal]);
      try {
        const response = await app.fetch(new Request(request, { signal }));
        if (!response.body) {
          requests.delete(controller);
          return response;
        }
        const reader = response.body.getReader();
        const body = new ReadableStream<Uint8Array>({
          async pull(sink) {
            try {
              const result = await reader.read();
              if (result.done) {
                requests.delete(controller);
                sink.close();
              } else sink.enqueue(result.value);
            } catch (error) {
              requests.delete(controller);
              sink.error(error);
            }
          },
          async cancel(reason) {
            controller.abort(reason);
            requests.delete(controller);
            await reader.cancel(reason);
          },
        });
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      } catch (error) {
        requests.delete(controller);
        throw error;
      }
    };
    return {
      profile: 'embedded-inference',
      port: 0,
      cert: null,
      clientToken,
      fetch: transport,
      stop,
    };
  } catch (error) {
    await stop().catch((cleanupError) => log.error(String(cleanupError)));
    throw error;
  }
}
