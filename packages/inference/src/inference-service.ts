import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import {
  GEZEL_API_GENERATION,
  GEZEL_API_GENERATION_FLOOR,
  GEZEL_VERSION,
  GezelConfigSchema,
  type LogOutput,
  type ProviderName,
  createLogger,
  getLogOutput,
  nowIso,
  setLogOutput,
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
import { v1EmbeddingsRoutes } from './http/routes/v1-embeddings.js';
import { v1ImagesRoutes } from './http/routes/v1-images.js';
import { v1KnowledgeRoutes } from './http/routes/v1-knowledge.js';
import { v1ModelsEnsureRoutes } from './http/routes/v1-models-ensure.js';
import { v1ModelsRoutes } from './http/routes/v1-models.js';
import { v1ResponsesRoutes } from './http/routes/v1-responses.js';
import { InFlightRequests } from './in-flight-requests.js';
import { KnowledgeManager } from './knowledge/manager.js';
import { createWorkerCatalogHost } from './knowledge/worker-host.js';
import { embeddingsHealth, openEmbeddings, shutdownEmbeddings } from './memory/embeddings.js';
import { AppleFoundationModelsProvider } from './providers/apple-foundation-models/provider.js';
import { LocalImageEngine } from './providers/image/local-engine.js';
import type { ImageProvider } from './providers/image/types.js';
import { EngineInference } from './providers/native/inference.js';
import { resolveModelSessionDefaults } from './providers/session-defaults.js';
import type { LLMProvider } from './providers/types.js';
import { MlxRuntimeStatusBus } from './python/mlx-runtime-status-bus.js';
import { RelevanceModelManager } from './relevance/manager.js';
import { relevanceScorer } from './relevance/relevance-model.js';
import { acquireSingleInstanceLock } from './runtime-lock.js';
import { HF_CACHE_DIR_ENV, transformersCacheDir } from './transformers-cache.js';
import { findServiceBundleResource } from './utils/service-worker-entry.js';
import './http/auth-context.js';
const log = createLogger('inference');
/** Same shape the full service reports, so one handler serves either host. */
export interface InferenceHttpErrorEvent {
  kind: 'unhandled_exception';
  requestId: string;
  method: string;
  path: string;
  status: number;
  detail: string;
}
export interface InferenceServiceOptions {
  home?: string;
  /** Host-provided local providers, useful for testing without downloading weights. */
  providers?: ReadonlyMap<ProviderName, LLMProvider>;
  /** Host-provided image provider in place of the local engine, for tests. */
  imageProvider?: ImageProvider;
  onUnexpectedHttpError?: (event: InferenceHttpErrorEvent) => void;
  /**
   * Where log records go while this host runs; restored on `stop()`. An app
   * embedding the host passes `'stderr'` so its own stdout stays its own.
   */
  logOutput?: LogOutput;
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
  const previousLogOutput = getLogOutput();
  const restoreLogOutput = () => setLogOutput(previousLogOutput);
  if (options.logOutput) setLogOutput(options.logOutput);
  const home = options.home ?? gezelHome();
  const runtimeDir = join(home, 'runtime');
  let lock: Awaited<ReturnType<typeof acquireSingleInstanceLock>>;
  try {
    await ensurePrivateUserHome(home);
    // Model files must land in this home's managed cache: unset, transformers.js
    // falls back to a module-relative cache that is read-only inside a packaged
    // app, and the embed worker (which reads this env) has no other view of home.
    process.env[HF_CACHE_DIR_ENV] ??= transformersCacheDir(home);
    lock = await acquireSingleInstanceLock({ runtimeDir, lockPath: join(runtimeDir, 'lock') });
  } catch (error) {
    restoreLogOutput();
    throw error;
  }
  const startedAt = nowIso();
  const cleanup: Array<() => void | Promise<void>> = [restoreLogOutput, () => lock.release()];
  const requests = new InFlightRequests();
  let stopping: Promise<void> | undefined;
  let closed = false;
  const stop = () => {
    stopping ??= (async () => {
      closed = true;
      requests.abortAll();
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
    const images = new LocalImageEngine({
      home,
      catalog,
      arbiter: components.gpuArbiter,
      readConfig: () => store.readConfig(),
      ...(options.imageProvider ? { provider: options.imageProvider } : {}),
    });
    cleanup.push(() => images.shutdown());
    const context = {
      home,
      store,
      catalog,
      chat,
      knowledge,
      relevance,
      images,
      imageProvider: images,
      ...components,
    };
    const clientToken = randomBytes(32).toString('base64url');
    const tokenBytes = Buffer.from(clientToken);
    const app = new Hono();
    app.onError((error, c) => {
      if (error instanceof ZodError)
        return c.json({ error: { code: 'invalid_request', message: error.message } }, 400);
      const detail = error instanceof Error ? error.message : String(error);
      try {
        options.onUnexpectedHttpError?.({
          kind: 'unhandled_exception',
          requestId: randomUUID(),
          method: c.req.method,
          path: c.req.path,
          status: 500,
          detail,
        });
      } catch (handlerError) {
        log.error(`onUnexpectedHttpError threw: ${String(handlerError)}`);
      }
      log.error(`${c.req.method} ${c.req.path}: ${detail}`);
      return c.json({ error: { code: 'internal_error', message: error.message } }, 500);
    });
    app.get('/api/health', (c) =>
      c.json({
        ok: true,
        version: GEZEL_VERSION,
        apiCompat: { floor: GEZEL_API_GENERATION_FLOOR, current: GEZEL_API_GENERATION },
        serviceRole: 'user',
        profile: 'embedded-inference',
        startedAt,
        nodeVersion: process.versions.node,
        platform: process.platform,
        embeddings: embeddingsHealth(),
        images: { available: images.available() },
      }),
    );
    app.use('*', async (c, next) => {
      const candidate = Buffer.from(c.req.header('authorization')?.replace(/^Bearer /, '') ?? '');
      if (candidate.length !== tokenBytes.length || !timingSafeEqual(candidate, tokenBytes))
        return c.json({ error: 'Unauthorized' }, 401);
      c.set('auth', { appId: 'host', scopes: ['openai', 'knowledge', 'images'] });
      return next();
    });
    const allowedProviders = ['llama-cpp', 'mlx', 'ds4', 'apple-foundation-models'] as const;
    app.use('/v1/chat/*', bodyLimit({ maxSize: 4 * 1024 * 1024 }));
    app.route('/v1/chat', v1ChatRoutes(context, { allowedProviders }));
    app.route('/v1/responses', v1ResponsesRoutes(context, { allowedProviders }));
    app.route('/v1/embeddings', v1EmbeddingsRoutes(context));
    app.route('/v1/models/ensure', v1ModelsEnsureRoutes(context));
    app.route('/v1/models', v1ModelsRoutes(context, { localOnly: true }));
    app.route('/v1/knowledge', v1KnowledgeRoutes(context));
    app.route('/v1/images', v1ImagesRoutes(context));
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
