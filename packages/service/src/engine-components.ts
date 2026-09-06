import type { GezelConfig } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import {
  DeviceHealthGate,
  createSystemDeviceHealthProbe,
  resolveDeviceSafetyPolicy,
} from '@bendyline/gezel/native';
import { defaultCacheBudgetMb } from './cache/budget.js';
import { SessionCacheController } from './cache/controller.js';
import { EngineBinaryRegistry } from './engines/registry.js';
import type { FitnessEngine } from './fitness/probe.js';
import { createEnsureModelOrchestrator } from './models/ensure.js';
import { GpuArbiter, resolveGpuPolicy } from './providers/gpu-arbiter.js';
import { LlamaCppModelManager } from './providers/llama-cpp/index.js';
import { MLX_VENV_NAME, MlxModelManager, mlxVenvPackages } from './providers/mlx/index.js';
import type { MlxRuntimeStatusBus } from './python/mlx-runtime-status-bus.js';
import { UvRuntime } from './python/uv-runtime.js';
const log = createLogger('engines');
export async function createEngineComponents(opts: {
  home: string;
  catalog: CatalogService;
  bootConfig: GezelConfig;
  mlxRuntimeStatus: MlxRuntimeStatusBus;
  scheduleInstallProbe: (info: { engine: FitnessEngine; id: string }) => void;
}) {
  const { home, catalog, bootConfig, mlxRuntimeStatus, scheduleInstallProbe } = opts;

  const llamaCppModels = new LlamaCppModelManager({
    home,
    catalog,
    onInstalled: scheduleInstallProbe,
  });
  // ds4 (DwarfStar) GGUF storage. Reuses the llama.cpp model
  // manager (ds4 GGUFs are structurally identical) pointed at `engines/ds4/`
  // and the catalog `ds4` source block. Cheap to construct on any platform;
  // the ds4 provider gates on platform/accelerator before ever using it.
  const ds4Models = new LlamaCppModelManager({
    home,
    catalog,
    engine: 'ds4',
    onInstalled: scheduleInstallProbe,
  });
  // Shared Python-runtime bootstrap. Same pattern — cheap to construct
  // everywhere; only the MLX provider actually asks it for a venv,
  // and only on Apple Silicon. It is constructed before the MLX model
  // manager so every model-install entrypoint can share the warm hook.
  const uvRuntime = new UvRuntime({ home });
  const warmMlxRuntime = (): void => {
    mlxRuntimeStatus.publish({
      phase: 'provisioning',
      message: 'Preparing the MLX Python runtime while the model downloads…',
    });
    void uvRuntime
      .ensureVenv({
        name: MLX_VENV_NAME,
        packages: mlxVenvPackages(bootConfig.mlxPackageSpec),
      })
      .then((venv) => {
        mlxRuntimeStatus.publish({
          phase: 'ready',
          message: `Python ${venv.pythonVersion ?? '?'} via ${venv.source}`,
        });
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        mlxRuntimeStatus.publish({ phase: 'error', error: message });
        // Non-fatal: the lazy first-chat `ensureVenv` will retry and
        // surface the error to the user then.
        log.warn(`[mlx] install-time venv warm failed (will retry on first chat): ${message}`);
      });
  };
  // Put the warm hook on the model manager itself so every install
  // entrypoint — including the in-app Settings downloader — overlaps
  // runtime provisioning with the weights download.
  const mlxModels = new MlxModelManager({
    home,
    catalog,
    onInstallStart: () => warmMlxRuntime(),
    onInstalled: scheduleInstallProbe,
  });
  // Backs `POST /v1/models/ensure` + `GET /v1/models/ensure/:jobId/events`.
  // Wraps the local model managers above into a single uniform
  // "ensure this model is downloaded" primitive so third-party apps
  // don't need to learn either install API.
  const ensureModel = await createEnsureModelOrchestrator({
    llamaCpp: llamaCppModels,
    ds4: ds4Models,
    mlx: mlxModels,
    catalog,
  });

  // Engine-agnostic prompt-cache controller. Local providers (mlx,
  // llama-cpp) register adapters with it as ChatManager constructs
  // them; cloud providers ignore it. The reconcile timer runs in the
  // background and is `unref`ed so it doesn't block shutdown.
  const cacheController = new SessionCacheController({
    logger: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
  });
  // Apply per-engine cache budgets — explicit config overrides win
  // over the RAM-aware default. Read once at boot; runtime config
  // changes flow through `PUT /api/config` which calls back into the
  // controller via `setBudget`. (Wired in the config route as part of
  // the operator-controls UI work below.)
  {
    const { totalmem } = await import('node:os');
    const ramAware = defaultCacheBudgetMb(totalmem());
    const mlxBudgetMb = bootConfig.cacheBudgetMb?.mlx ?? ramAware;
    const llamaCppBudgetMb = bootConfig.cacheBudgetMb?.['llama-cpp'] ?? ramAware;
    // setBudget is a no-op for providers without registered adapters
    // (which is correct here — adapters register lazily via
    // ChatManager.ensureProvider). The controller will apply the
    // budget on first registration via the entry's default + a
    // setBudget call we add below.
    cacheController.setBudget('mlx', mlxBudgetMb * 1024 * 1024);
    cacheController.setBudget('llama-cpp', llamaCppBudgetMb * 1024 * 1024);
  }

  // Cross-engine GPU arbiter. Constructed before ChatManager and
  // ImageProviderManager so both can register their evictors as soon
  // as the underlying providers are built (lazy — first chat turn /
  // first image gen). Policy comes from config; `'auto'` resolves to
  // `'coexist'` on big-memory Apple Silicon and `'swap'` everywhere
  // else. The PUT /api/config handler hot-swaps via `setPolicy`.
  const deviceSafetyPolicy = resolveDeviceSafetyPolicy(bootConfig.deviceSafety);
  const deviceHealthGate = new DeviceHealthGate({
    policy: deviceSafetyPolicy,
    probe: createSystemDeviceHealthProbe({
      helperPath: process.env.GEZEL_DEVICE_HEALTH_BIN,
    }),
    log: (message) => log.info(message),
  });
  const gpuArbiter = new GpuArbiter({
    policy: resolveGpuPolicy(bootConfig.gpuMemoryPolicy),
    healthGate: deviceHealthGate,
  });
  log.info(`[gpu-arbiter] policy=${gpuArbiter.getPolicy()}`);
  log.info(
    `[device-health] mode=${deviceSafetyPolicy.mode} start<=${deviceSafetyPolicy.maxStartTemperatureC}C resume<=${deviceSafetyPolicy.resumeTemperatureC}C margin>=${deviceSafetyPolicy.minThermalMarginC}C telemetryFailure=${deviceSafetyPolicy.onTelemetryFailure}`,
  );

  // Resolves native engine binaries on demand (lazy on-device chat + the
  // manual Settings trigger). Verified download → cache → env-stamp; see
  // engines/resolver.ts. Background-job lifecycle mirrors `imagePulls`.
  // Constructed before ChatManager so the lazy on-device hook can reach it.
  // Signature validation fails closed by default on Windows/macOS. The
  // config remains an explicit operator escape hatch for development.
  const engineBinaries = new EngineBinaryRegistry({
    home,
    ...(bootConfig.engineSignaturePolicy
      ? { signaturePolicy: bootConfig.engineSignaturePolicy }
      : {}),
  });
  return {
    llamaCppModels,
    ds4Models,
    mlxModels,
    uvRuntime,
    ensureModel,
    cacheController,
    gpuArbiter,
    engineBinaries,
  };
}
