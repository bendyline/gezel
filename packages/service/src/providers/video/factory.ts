/**
 * Provider-selection helper for video generation. Mirrors
 * `providers/image/factory.ts`.
 *
 * Selection rules (first-match):
 *   1. `GEZEL_MOCK_PROVIDER=1` or `config.videoProvider === 'mock'` →
 *      `MockVideoProvider` (tests, CI).
 *   2. `GEZEL_VIDEO_SERVER_URL` → `DiffusersVideoProvider` pointed at that
 *      URL, no supervisor (power-user "I run the server myself" escape
 *      hatch — no Python provisioning).
 *   3. Default → `DiffusersVideoProvider` backed by a
 *      `NativeEngineSupervisor` that provisions the video venv and spawns
 *      `gezel_video_server.py` on-demand at an ephemeral port. The fully
 *      automatic, no-configuration path.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GezelConfig, VideoAccelerator } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { GpuArbiter } from '@bendyline/gezel-inference/internal/providers/gpu-arbiter';
import { measuredCapacityBudget } from '@bendyline/gezel-inference/internal/providers/native/measured-budget';
import { pickFreePort } from '@bendyline/gezel-inference/internal/providers/native/port';
import { NativeEngineSupervisor } from '@bendyline/gezel-inference/internal/providers/native/supervisor';
import { patientFetch } from '@bendyline/gezel-inference/internal/providers/patient-fetch';
import type { UvRuntime } from '@bendyline/gezel-inference/internal/python/uv-runtime';
import { videoMediaPool } from '../../models/media-fit.js';
import { DiffusersVideoProvider } from './diffusers-video.js';
import { MockVideoProvider } from './mock.js';
import { type InstalledVideoModel, VideoModelManager, VideoModelSelector } from './models.js';
import type { VideoProvider } from './types.js';
import {
  VIDEO_VENV_NAME,
  detectVideoAccelerator,
  videoPythonRequest,
  videoVenvSpec,
} from './venv.js';
import { estimateVideoRequirement } from './working-set.js';

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
  const selector = new VideoModelSelector(models, () => opts.config?.defaultVideoModel);

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
