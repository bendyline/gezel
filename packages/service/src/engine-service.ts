import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { join } from 'node:path';
import {
  createLogger,
  nowIso,
  resolveDistributionProfile,
  startSuspendMonitor,
  stopSuspendMonitor,
} from '@bendyline/gezel';
import { CatalogService } from '@bendyline/gezel-catalog';
import { gezelPaths } from '@bendyline/gezel/paths';
import { DebugFlag } from './debug/flag.js';
import { createEngineComponents } from './engine-components.js';
import { prepareNativeEngines } from './engine-discovery.js';
import { ModelFitnessManager } from './fitness/manager.js';
import { type FitnessEngine, runFitnessProbe } from './fitness/probe.js';
import { ConfigStore } from './fs/config-store.js';
import { ensurePrivateUserHome } from './fs/home-permissions.js';
import { GildeUpdateManager } from './gilde-updates/manager.js';
import { createGrantManager, parseAutoApproveAppIds } from './grants/manager.js';
import { generateLoopbackCert } from './http/cert.js';
import type { EngineContext } from './http/engine-context.js';
import { buildEngineApp } from './http/engine-server.js';
import { closeLoopbackListener, listenLoopback } from './http/loopback-listener.js';
import { buildRemoteApp } from './http/remote-server.js';
import { createTokenStore } from './http/token-store.js';
import { buildChatModelInstallRegistries } from './models/install-jobs.js';
import {
  migrateInstalledModelIds,
  reclaimStaleModelDownloads,
} from './models/startup-maintenance.js';
import { migrateLegacySystemModels } from './models/storage-roots.js';
import { SpeechToTextProviderManager } from './providers/audio/stt-manager.js';
import { TextToSpeechProviderManager } from './providers/audio/tts-manager.js';
import { resolveCatalogReasoningBudget } from './providers/catalog-model-config.js';
import { ImageProviderManager } from './providers/image/manager.js';
import { ImageModelPullRegistry } from './providers/image/pull-registry.js';
import { EngineInference } from './providers/native/inference.js';
import { RecognitionManager } from './providers/recognition/manager.js';
import { VideoProviderManager } from './providers/video/manager.js';
import { VideoModelPullRegistry } from './providers/video/pull-registry.js';
import { MlxRuntimeStatusBus } from './python/mlx-runtime-status-bus.js';
import { loadEngineIdentity } from './remotes/engine-identity.js';
import { createRemoteServingController } from './remotes/serving.js';
import { createTenantLimiter } from './remotes/tenant-limits.js';
import { writeRuntime } from './runtime-discovery.js';
import { acquireSingleInstanceLock } from './runtime-lock.js';
import { DEFAULT_PORT, type RunningService, type StartServiceOptions } from './service-options.js';
import { reapOrphanedGezelEngineProcesses } from './system/gezel-process-cleanup.js';
import { detectMemoryProfile, detectMemoryProfileCached } from './system/memory.js';
import { probeChildProcessSpawn } from './system/spawn-capability.js';

const log = createLogger('engine-service');

/** The machine broker's composition root. No product Store or managers exist here. */
export async function startEngineService(
  opts: StartServiceOptions & { home: string },
): Promise<RunningService<EngineContext>> {
  const { home } = opts;
  if (process.env.GEZEL_SYSTEM_SCOPE !== '1') await ensurePrivateUserHome(home);
  const runtimeDir = join(home, 'runtime');
  const lock = await acquireSingleInstanceLock({ runtimeDir, lockPath: join(runtimeDir, 'lock') });
  const cleanup: Array<() => void | Promise<void>> = [() => lock.release()];
  let closeAdmission = () => {};
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopping) return stopping;
    stopping = (async () => {
      closeAdmission();
      const failures: unknown[] = [];
      for (const close of cleanup.reverse()) {
        try {
          await close();
        } catch (error) {
          failures.push(error);
          log.error(String(error));
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Engine shutdown failed');
    })();
    return stopping;
  };
  try {
    startSuspendMonitor();
    cleanup.push(() => stopSuspendMonitor());
    setDefaultAutoSelectFamilyAttemptTimeout(5000);
    void detectMemoryProfileCached().catch(() => {});
    await mkdir(join(home, 'logs'), { recursive: true });
    await reapOrphanedGezelEngineProcesses().catch((error) => log.warn(String(error)));
    await migrateLegacySystemModels(home);
    const store = new ConfigStore(home);
    await migrateInstalledModelIds(home, store);
    const bootConfig = await store.readConfig();
    const gilde = await GildeUpdateManager.create({ home, store });
    cleanup.push(() => gilde.stop());
    const catalog = new CatalogService(undefined, {
      localRoot: home,
      contentRoot: () => gilde.contentDataDir(),
    });
    await prepareNativeEngines(home, bootConfig);
    const mlxRuntimeStatus = new MlxRuntimeStatusBus();
    // biome-ignore lint/style/useConst: install callbacks close over the later fitness owner.
    let modelFitness: ModelFitnessManager | undefined;
    const components = await createEngineComponents({
      home,
      catalog,
      bootConfig,
      mlxRuntimeStatus,
      scheduleInstallProbe: (info) =>
        modelFitness?.scheduleProbe(info.engine, info.id, { trigger: 'install' }),
    });
    const {
      llamaCppModels,
      ds4Models,
      mlxModels,
      uvRuntime,
      ensureModel,
      cacheController,
      gpuArbiter,
      engineBinaries,
    } = components;
    cleanup.push(() => {
      cacheController.stop();
      engineBinaries.clear();
    });
    await reclaimStaleModelDownloads(home, components);
    const chat = new EngineInference({
      home,
      store,
      catalog,
      llamaCppModels,
      ds4Models,
      mlxModels,
      uvRuntime,
      mlxRuntimeStatus,
      cacheController,
      gpuArbiter,
      engineBinaries,
    });
    closeAdmission = () => {
      chat.beginShutdown();
      modelFitness?.stop();
    };
    cleanup.push(() => chat.shutdown());
    const resolveInstalled = (engine: FitnessEngine, id: string) =>
      engine === 'mlx'
        ? mlxModels.resolveModel(id)
        : engine === 'ds4'
          ? ds4Models.resolveModel(id)
          : llamaCppModels.resolveModel(id);
    modelFitness = new ModelFitnessManager({
      store,
      resolveInstalled,
      engineStatus: () => chat.engineStatus(),
      currentMemory: detectMemoryProfile,
      runProbe: (args) =>
        runFitnessProbe(
          {
            getProviderForModel: (name, id) => chat.getProviderForModel(name, id),
            resolveInstalled,
            resolveReasoningBudget: (id) => resolveCatalogReasoningBudget(catalog, id),
            detectMemory: detectMemoryProfile,
            configuredNumCtx: async (engine, id) => {
              const cfg = await store.readConfig();
              return (
                cfg.modelContextOverrides?.[`${engine}:${id}`] ??
                (engine === 'mlx'
                  ? cfg.mlxNumCtx
                  : engine === 'ds4'
                    ? cfg.ds4NumCtx
                    : cfg.llamaCppNumCtx)
              );
            },
          },
          args,
        ),
    });
    cleanup.push(() => modelFitness?.stop());
    const recognition = new RecognitionManager({
      home,
      modelId: bootConfig.defaultRecognitionModel,
    });
    const imageProvider = new ImageProviderManager({
      home,
      store,
      localOnly: true,
      arbiter: gpuArbiter,
    });
    const videoProvider = new VideoProviderManager({
      home,
      store,
      catalog,
      uvRuntime,
      arbiter: gpuArbiter,
    });
    const stt = new SpeechToTextProviderManager({ home, store });
    const tts = new TextToSpeechProviderManager({ home });
    cleanup.push(async () => {
      await Promise.all([
        recognition.shutdown(),
        imageProvider.shutdown(),
        videoProvider.shutdown(),
        stt.shutdown(),
        tts.shutdown(),
      ]);
    });
    const imagePulls = new ImageModelPullRegistry({ imageProvider, catalog });
    const videoPulls = new VideoModelPullRegistry({ videoProvider, catalog });
    const chatInstalls = buildChatModelInstallRegistries({
      home,
      readConfig: () => store.readConfig(),
      llamaCppModels,
      ds4Models,
      mlxModels,
      recognition,
      onDone: () => chat.invalidateResidentBytesCache(),
    });
    cleanup.push(() => {
      imagePulls.clear();
      videoPulls.clear();
      for (const registry of Object.values(chatInstalls)) registry.clear();
    });
    const cert = process.env.GEZEL_INSECURE_TRANSPORT === '1' ? null : await generateLoopbackCert();
    const token = randomBytes(24).toString('base64url');
    const clientToken = randomBytes(24).toString('base64url');
    const tokenStore = await createTokenStore({
      home,
      rootToken: token,
      ephemeralTokens: [
        {
          appId: 'machine-engine-client',
          appName: 'Gezel User Daemon',
          scopes: ['remote-inference', 'machine-models', 'machine-knowledge-assets'],
          token: clientToken,
        },
      ],
    });
    const grants = await createGrantManager({
      home,
      tokenStore,
      autoApproveAppIds: parseAutoApproveAppIds(process.env.GEZEL_AUTOAPPROVE_APPS),
    });
    const identity = await loadEngineIdentity(home, cert?.sha256Hex);
    // biome-ignore lint/style/useConst: the controller must exist before constructing its HTTP context.
    let remoteApp: ReturnType<typeof buildRemoteApp> | undefined;
    const remoteServing = createRemoteServingController({
      cert,
      deviceFingerprint: identity.identity.fingerprint,
      fetch: () => {
        if (!remoteApp) throw new Error('Engine HTTP app is not ready');
        return remoteApp.fetch;
      },
    });
    cleanup.push(() => remoteServing.stop());
    const context: EngineContext = {
      home,
      serviceRole: 'machine-engine',
      distribution: resolveDistributionProfile(process.env),
      store,
      chat,
      catalog,
      ...components,
      mlxRuntimeStatus,
      modelFitness,
      recognition,
      imageProvider,
      videoProvider,
      stt,
      tts,
      imagePulls,
      videoPulls,
      chatInstalls,
      debug: new DebugFlag(bootConfig.debugMode === true),
      token,
      tokenStore,
      grants,
      deviceIdentity: identity.identity,
      signIdentityCertificate: identity.signCertificate,
      remoteServing,
      remoteTenantLimits: createTenantLimiter(bootConfig.remoteServing?.limits),
      ...(cert ? { tlsCertSha256: cert.sha256Hex, tlsCertPem: cert.certPem } : {}),
      startedAt: nowIso(),
      childProcessSpawn: await probeChildProcessSpawn(),
    };
    const app = buildEngineApp(context, { onUnexpectedHttpError: opts.onUnexpectedHttpError });
    remoteApp = buildRemoteApp(context);
    const requestedPort = opts.port ?? (opts.preferCanonicalPort ? DEFAULT_PORT : 0);
    const bound = await listenLoopback(app.fetch, cert, requestedPort).catch((error) => {
      if (opts.port === undefined && opts.preferCanonicalPort && error.code === 'EADDRINUSE')
        return listenLoopback(app.fetch, cert, 0);
      throw error;
    });
    cleanup.push(() => closeLoopbackListener(bound.server));
    const paths = gezelPaths(home);
    cleanup.push(async () => {
      for (const name of [
        'pid',
        'port',
        'auth-token',
        'service-role',
        'cert.pem',
        'cert-fingerprint',
        'web-ui-token',
      ])
        await rm(join(runtimeDir, name), { force: true });
    });
    await writeRuntime({
      paths,
      port: bound.port,
      token: clientToken,
      pid: process.pid,
      cert,
      webUiToken: null,
      serviceRole: 'machine-engine',
    });
    await remoteServing
      .reconfigure(bootConfig.remoteServing)
      .catch((error) => log.error(`Remote serving unavailable: ${String(error)}`));
    log.info(`machine engine listening on 127.0.0.1:${bound.port}`);
    return { context, ...bound, cert, clientToken, webUiToken: null, stop };
  } catch (error) {
    await stop().catch((cleanupError) =>
      log.error(`Failed startup cleanup: ${String(cleanupError)}`),
    );
    throw error;
  }
}
