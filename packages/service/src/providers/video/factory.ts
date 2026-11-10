/**
 * Provider-selection helper for video generation. Mirrors
 * `providers/image/factory.ts`.
 *
 * `GEZEL_MOCK_PROVIDER=1` or `config.videoProvider === 'mock'` gives a
 * `MockVideoProvider` (tests, CI). Otherwise a `LocalVideoProvider` holds
 * both engines over one model store and sends each render to its model's:
 *
 *   - diffusers: `GEZEL_VIDEO_SERVER_URL` points at a server the person runs
 *     themselves; by default a `NativeEngineSupervisor` provisions the video
 *     venv and spawns `gezel_video_server.py` on demand.
 *   - sd.cpp: `GEZEL_SD_VIDEO_SERVER_URL` points at a running sd-server; by
 *     default a supervisor spawns `GEZEL_SD_SERVER_BIN`, the image engine's
 *     binary, on its own port. Without either the engine reports itself not
 *     configured and its models cannot render.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GezelConfig, VideoAccelerator } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import {
  imageMediaPool,
  sdServerBackend,
  sdServerLedgerClaim,
} from '@bendyline/gezel-inference/internal/models/image-fit';
import type { GpuArbiter } from '@bendyline/gezel-inference/internal/providers/gpu-arbiter';
import { pressureIdleGraceMs } from '@bendyline/gezel-inference/internal/providers/native/capacity-budget';
import { measuredCapacityBudget } from '@bendyline/gezel-inference/internal/providers/native/measured-budget';
import { pickFreePort } from '@bendyline/gezel-inference/internal/providers/native/port';
import { NativeEngineSupervisor } from '@bendyline/gezel-inference/internal/providers/native/supervisor';
import { patientFetch } from '@bendyline/gezel-inference/internal/providers/patient-fetch';
import type { UvRuntime } from '@bendyline/gezel-inference/internal/python/uv-runtime';
import { videoMediaPool } from '../../models/media-fit.js';
import { DiffusersVideoProvider } from './diffusers-video.js';
import { LocalVideoProvider } from './local-video.js';
import { MockVideoProvider } from './mock.js';
import { type InstalledVideoModel, VideoModelManager, VideoModelSelector } from './models.js';
import {
  SD_VIDEO_EXCLUSIVE,
  SdCppVideoProvider,
  SdVideoClaim,
  buildSdVideoServerArgs,
  sdCppVideoLaunchComponents,
} from './sd-cpp-video.js';
import type { VideoProvider } from './types.js';
import {
  VIDEO_VENV_NAME,
  detectVideoAccelerator,
  videoPythonRequest,
  videoVenvSpec,
} from './venv.js';
import { estimateSdCppVideoRequirement, estimateVideoRequirement } from './working-set.js';

const GIB = 1024 ** 3;

export interface VideoProviderFactoryOptions {
  home: string;
  /** Catalog the model manager reads `video-model` entries from. */
  catalog: CatalogService;
  /** Shared Python venv manager. Required for the bundled engine path. */
  uvRuntime: UvRuntime;
  /** Override for tests. */
  env?: NodeJS.ProcessEnv;
  config?: GezelConfig;
  /** Forwarded only to the supervised bundled engine. */
  arbiter?: GpuArbiter;
}

export async function createVideoProvider(
  opts: VideoProviderFactoryOptions,
): Promise<VideoProvider> {
  const env = opts.env ?? process.env;
  const models = new VideoModelManager({ home: opts.home, catalog: opts.catalog });

  if (env.GEZEL_MOCK_PROVIDER === '1' || opts.config?.videoProvider === 'mock') {
    return new MockVideoProvider();
  }

  const accelerator = await detectVideoAccelerator();
  return new LocalVideoProvider({
    models,
    engines: {
      diffusers: createDiffusersEngine(opts, env, models, accelerator),
      'sd-cpp': createSdCppEngine(opts, env, models),
    },
    defaultModelId: () => opts.config?.defaultVideoModel,
  });
}

function createDiffusersEngine(
  opts: VideoProviderFactoryOptions,
  env: NodeJS.ProcessEnv,
  models: VideoModelManager,
  accelerator: VideoAccelerator,
): DiffusersVideoProvider {
  if (env.GEZEL_VIDEO_SERVER_URL) {
    return new DiffusersVideoProvider({
      baseUrl: env.GEZEL_VIDEO_SERVER_URL,
      models,
      accelerator,
      fetchImpl: patientFetch(),
    });
  }

  // Shared model selection driving the single-model engine. The provider
  // sets `requestedId` per generate (the MCP/API `model` argument); this
  // closure reads it at (re)launch. Precedence lives entirely in the
  // selector so a per-call override and the launch argv never diverge.
  const selector = new VideoModelSelector(
    models,
    () => opts.config?.defaultVideoModel,
    'diffusers',
  );

  // Bundled engine: provision the venv + spawn the python server lazily.
  let cachedPort: number | undefined;
  const supervisor = new NativeEngineSupervisor({
    capacity: {
      home: opts.home,
      exclusive: true,
      // Price the bound model from its own weights at load precision — the
      // same pricing the download page used — and say what sits on the card.
      // Without an explicit gpuBytes the ledger clamps a discrete request to
      // the card's size, so it could never refuse a model whose weights do not
      // fit it.
      requirement: async () => {
        const model = selector.launchedId ? await models.resolveModel(selector.launchedId) : null;
        if (!model) return undefined;
        const budget = await measuredCapacityBudget();
        const { bytes, gpuBytes } = await estimateVideoRequirement({
          modelDir: model.modelDir,
          family: model.family,
          accelerator,
          pool: videoMediaPool(accelerator, budget.kind),
          ...(model.load?.vaeDtype ? { vaeDtype: model.load.vaeDtype } : {}),
        });
        return { bytes, gpuBytes };
      },
    },
    logPrefix: '[video-server]',
    // The server serves a real 200 at /health once listening; the model
    // loads lazily on the first generate, so readiness is fast.
    readinessPath: '/health',
    // torch's first import + server boot can be slow; the multi-minute
    // venv provisioning happens inside resolveLaunch (before this timer
    // starts), so this only needs to cover process boot.
    startupTimeoutMs: 5 * 60 * 1000,
    resolveLaunch: async () => {
      const port = cachedPort ?? (await pickFreePort());
      cachedPort = port;

      // Honor the active model: a per-request override (the `model` argument)
      // wins, else the user's configured default (Settings → Video
      // generation), else the first installed model. The server binds one
      // model at launch, so this selection is which weights run.
      const model = await selector.pick();
      if (!model) {
        throw new Error(
          'No video model is available locally. Download one from Settings → Video generation before generating.',
        );
      }
      selector.launchedId = model.id;

      // Provision (or reuse) the accelerator-matched venv. Idempotent and
      // serialized per-name inside UvRuntime; first run installs torch +
      // diffusers, which is slow — hence this lives in resolveLaunch, not
      // at construction.
      const spec = videoVenvSpec(accelerator);
      const venv = await opts.uvRuntime.ensureVenv({
        name: VIDEO_VENV_NAME,
        packages: spec.packages,
        ...(spec.extraIndexUrls ? { extraIndexUrls: spec.extraIndexUrls } : {}),
        // Steer the venv to a Python the torch/diffusers wheels reliably
        // ship for. When uv is the installer it downloads this exact
        // interpreter (independent of a too-new system Python); on the
        // bare system-python path the floor-pinned torch (see venv.ts)
        // is the safety net.
        preferredPythonVersion: videoPythonRequest(),
      });
      const venvPython = venv.binPath('python');

      return {
        command: venvPython,
        args: buildVideoServerArgs({
          serverPath: resolveVideoServerPath(),
          model,
          accelerator,
          port,
          memoryTrace: env.GEZEL_MEDIA_MEMORY_TRACE === '1',
        }),
        env: {
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          HF_HUB_DISABLE_TELEMETRY: '1',
        },
        baseUrl: `http://127.0.0.1:${port}`,
      };
    },
  });

  return new DiffusersVideoProvider({
    baseUrl: 'http://127.0.0.1:9091',
    models,
    accelerator,
    supervisor,
    selector,
    fetchImpl: patientFetch(),
    ...(opts.arbiter ? { arbiter: opts.arbiter } : {}),
  });
}

/**
 * The sd.cpp video engine: its own sd-server process on its own port, bound
 * to one installed sd.cpp model at a time.
 */
function createSdCppEngine(
  opts: VideoProviderFactoryOptions,
  env: NodeJS.ProcessEnv,
  models: VideoModelManager,
): SdCppVideoProvider {
  const selector = new VideoModelSelector(models, () => opts.config?.defaultVideoModel, 'sd-cpp');
  if (env.GEZEL_SD_VIDEO_SERVER_URL) {
    return new SdCppVideoProvider({
      baseUrl: env.GEZEL_SD_VIDEO_SERVER_URL,
      models,
      selector,
      fetchImpl: patientFetch(),
    });
  }
  const binary = env.GEZEL_SD_SERVER_BIN;
  if (!binary) {
    return new SdCppVideoProvider({
      baseUrl: 'http://127.0.0.1:9092',
      models,
      selector,
      configured: false,
    });
  }
  const host = { platform: process.platform, arch: process.arch, sdServerBin: binary };
  const backend = sdServerBackend(host);
  const priced = new SdVideoClaim(async (model, size, animatesPicture) => {
    const budget = await measuredCapacityBudget();
    const pool = imageMediaPool(budget.kind, host);
    return estimateSdCppVideoRequirement({
      model,
      pool,
      backend,
      ...(size ? { size } : {}),
      ...(animatesPicture ? { animatesPicture } : {}),
      ...(pool === 'discrete' ? { gpuLimitBytes: budget.fastBytes } : {}),
    });
  });
  let cachedPort: number | undefined;
  // The claim is priced once per launch, in resolveLaunch, so `--max-vram`
  // and the device ledger see the same figure; admission runs after it.
  let claim: { bytes: number; gpuBytes: number } | undefined;
  const supervisor = new NativeEngineSupervisor({
    capacity: {
      home: opts.home,
      exclusive: SD_VIDEO_EXCLUSIVE,
      requirement: async () => claim,
    },
    logPrefix: '[sd-video-server]',
    // sd-server answers its root with an HTML page or a 404 once listening.
    readinessPath: '/',
    readyOnAnyResponse: true,
    startupTimeoutMs: 5 * 60 * 1000,
    // A video model holds many gigabytes; give them back sooner than a chat model.
    idleTimeoutMs: 10 * 60 * 1000,
    ...(opts.arbiter
      ? {
          memoryPressure: () => opts.arbiter!.getMemoryPressureStatus(),
          pressureIdleTimeoutMs: pressureIdleGraceMs(),
        }
      : {}),
    resolveLaunch: async () => {
      const port = cachedPort ?? (await pickFreePort());
      cachedPort = port;
      const model = await selector.pick();
      if (!model?.components) {
        throw new Error(
          'No video model for the sd.cpp engine is installed. Download one from Settings → Video generation.',
        );
      }
      selector.launchedId = model.id;
      const budget = await measuredCapacityBudget();
      const pool = imageMediaPool(budget.kind, host);
      const requirement = await priced.forLaunch(model);
      priced.launched = { modelId: model.id, bytes: requirement.bytes };
      claim = sdServerLedgerClaim(requirement, budget.fastBytes);
      return {
        command: binary,
        args: buildSdVideoServerArgs(
          { components: sdCppVideoLaunchComponents(model.components, backend) },
          port,
          {
            ...(pool === 'discrete' ? { maxVramGiB: claim.gpuBytes / GIB } : {}),
            verbose: env.GEZEL_MEDIA_MEMORY_TRACE === '1',
          },
        ),
        baseUrl: `http://127.0.0.1:${port}`,
      };
    },
  });
  return new SdCppVideoProvider({
    baseUrl: 'http://127.0.0.1:9092',
    models,
    selector,
    supervisor,
    backend,
    claim: priced,
    fetchImpl: patientFetch(),
    ...(opts.arbiter ? { arbiter: opts.arbiter } : {}),
  });
}

/**
 * The `gezel_video_server.py` argv for one installed model. Translates the
 * catalog-driven load descriptor into engine flags; absent fields let the
 * server fall back to its family defaults, so a plain diffusers-tree model
 * needs none of them.
 */
export function buildVideoServerArgs(opts: {
  serverPath: string;
  model: Pick<InstalledVideoModel, 'modelDir' | 'family' | 'load'>;
  accelerator: VideoAccelerator;
  port: number;
  /** Per-phase device-memory peaks in the log, for the video bench (`GEZEL_MEDIA_MEMORY_TRACE=1`). */
  memoryTrace?: boolean;
}): string[] {
  const { model } = opts;
  const load = model.load;
  const args = [
    opts.serverPath,
    '--model',
    model.modelDir,
    '--family',
    model.family,
    '--accelerator',
    opts.accelerator,
    '--host',
    '127.0.0.1',
    '--port',
    String(opts.port),
  ];
  if (load?.strategy) args.push('--load-strategy', load.strategy);
  if (load?.pipelineClass) args.push('--pipeline-class', load.pipelineClass);
  if (load?.singleFileName) args.push('--single-file-name', load.singleFileName);
  if (load?.transformerClass) args.push('--transformer-class', load.transformerClass);
  if (load?.vaeDtype) args.push('--vae-dtype', load.vaeDtype);
  if (load?.audio) args.push('--audio');
  if (load?.sigmas?.length) args.push('--sigmas', load.sigmas.join(','));
  if (opts.memoryTrace) args.push('--memory-trace');
  return args;
}

/**
 * Resolve `gezel_video_server.py` relative to this module's bundle. The
 * Python file is copied into `dist/providers/video/python/` at build
 * time; we walk up from the current module dir so dev and packaged
 * bundle shapes both resolve without env wiring. Mirrors the MLX server
 * path resolution in `chat/manager.ts`.
 */
function resolveVideoServerPath(): string {
  const here = fileURLToPath(import.meta.url);
  let dir = here.replace(/[\\/][^\\/]+$/, '');
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'providers', 'video', 'python', 'gezel_video_server.py');
    if (existsSync(candidate)) return candidate;
    const parent = dir.replace(/[\\/][^\\/]+$/, '');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'gezel_video_server.py not found relative to the service bundle. Build output may be ' +
      'corrupt — run `pnpm --filter @bendyline/gezel-service build` and verify ' +
      'dist/providers/video/python/gezel_video_server.py exists.',
  );
}
