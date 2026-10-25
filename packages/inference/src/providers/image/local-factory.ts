/**
 * The local image provider: stable-diffusion.cpp's `sd-server` on this
 * machine. Shared by the full service (behind its cloud and remote routing)
 * and by hosted inference, which serves only this.
 *
 * Selection rules (first-match):
 *   1. `GEZEL_MOCK_PROVIDER=1` → `MockImageProvider` (tests, CI).
 *   2. `GEZEL_SD_SERVER_URL` present → `StableDiffusionCppProvider`
 *      pointed at that URL, no supervisor ("user runs their own
 *      server" mode — useful during development).
 *   3. `GEZEL_SD_SERVER_BIN` present → `StableDiffusionCppProvider`
 *      backed by a `NativeEngineSupervisor` that spawns the binary
 *      on-demand at an ephemeral port.
 *   4. Fallback: `StableDiffusionCppProvider` with the default
 *      base URL (127.0.0.1:9081) and no supervisor. `health()` reports
 *      `not-configured` so the UI can say the engine is not installed.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  imageMediaPool,
  sdServerLedgerClaim,
  sdServerRequirement,
} from '../../models/image-fit.js';
import {
  type ModelStorageRoots,
  findModelRoot,
  listOverlayModelIds,
  modelStorageRoots,
  verifyReadOnlyModelPayload,
} from '../../models/storage-roots.js';
import { localSdCppWeightFiles } from '../../models/weight-facts.js';
import type { GpuArbiter } from '../gpu-arbiter.js';
import { pressureIdleGraceMs } from '../native/capacity-broker.js';
import type { NativeCapacityOptions } from '../native/device-capacity.js';
import { measuredCapacityBudget } from '../native/measured-budget.js';
import { pickFreePort } from '../native/port.js';
import { NativeEngineSupervisor } from '../native/supervisor.js';
import { patientFetch } from '../patient-fetch.js';
import { MockImageProvider } from './mock.js';
import {
  MODEL_SAMPLE_STEP_DEFAULTS,
  StableDiffusionCppProvider,
  sdServerLoadProfile,
} from './sd-cpp.js';
import type { ImageProvider, InstalledImageModelInfo } from './types.js';

export interface LocalImageProviderOptions {
  home: string;
  /** Override for tests. */
  env?: NodeJS.ProcessEnv;
  /**
   * The person's default local model (`config.defaultImageModel['sd-cpp']`).
   * A configured id that is no longer installed falls through to the first
   * installed model.
   */
  defaultModelId?: string;
  /**
   * Cross-engine GPU coordinator. Forwarded only to the supervised branch —
   * the user-runs-their-own (`GEZEL_SD_SERVER_URL`) path doesn't manage
   * VRAM tenancy.
   */
  arbiter?: GpuArbiter;
}

/**
 * Nothing to generate with: the person has to download a model first. Its
 * own type so a route can answer with the fix, not a bare 500, which reads
 * to an outside app as "something went wrong inside Gezel".
 */
export class NoLocalImageModelError extends Error {
  readonly code = 'no_local_image_model';
  constructor() {
    super(
      'No image model is available locally. Download one from Settings → Image generation before generating.',
    );
    this.name = 'NoLocalImageModelError';
  }
}

/**
 * How sd-server is admitted to the device memory ledger: by bytes, like any
 * other engine, never exclusively. The ledger already refuses co-residency
 * where the byte or GPU budget cannot hold both, and `detectGpuPolicy` states
 * the rule: automatic heuristics must not serialize models that fit.
 * Exclusive admission did exactly that. On a DGX Spark with gemma4-31b
 * resident (95 GB of a 128 GB machine), a 4-second SDXL render waited up to
 * 89 s for the chat engine to go idle, then was evicted as soon as the next
 * chat turn asked for memory, so every render paid a fresh load.
 */
export function sdServerCapacity(home: string): NativeCapacityOptions {
  return { home };
}

export async function createLocalImageProvider(
  opts: LocalImageProviderOptions,
): Promise<ImageProvider> {
  const env = opts.env ?? process.env;
  const storageRoots = modelStorageRoots({ home: opts.home, engine: 'sd-cpp', env });
  const modelsRoot = storageRoots.writableRoot;
  const defaultLocalModelId = opts.defaultModelId;

  if (env.GEZEL_MOCK_PROVIDER === '1') {
    return new MockImageProvider();
  }

  if (env.GEZEL_SD_SERVER_URL) {
    return new StableDiffusionCppProvider({
      baseUrl: env.GEZEL_SD_SERVER_URL,
      modelsRoot,
      storageRoots,
      fetchImpl: patientFetch(),
      ...(defaultLocalModelId ? { defaultModelId: defaultLocalModelId } : {}),
    });
  }

  if (env.GEZEL_SD_SERVER_BIN) {
    const binary = env.GEZEL_SD_SERVER_BIN;
    // Track the most-recently-resolved launch so the provider can point
    // fetch() at the right port without the supervisor exposing state.
    let cachedPort: number | undefined;
    // Shared with the provider: which installed model to launch
    // sd-server with. sd-server is single-model per process, so the
    // provider sets this to the requested model and stops the server
    // when it changes; resolveLaunch reads it on the next start.
    const launchState: { modelId: string | undefined } = { modelId: undefined };
    let launchedModel: ResolvedInstalledModel | undefined;
    const supervisor = new NativeEngineSupervisor({
      capacity: {
        ...sdServerCapacity(opts.home),
        // Price the launched model from its own weight files — the same
        // pricing the download page used — and claim what the render
        // actually holds on the card (see sdServerLedgerClaim).
        requirement: async () => {
          if (!launchedModel) return undefined;
          const budget = await measuredCapacityBudget();
          const requirement = sdServerRequirement({
            modelId: launchedModel.id,
            weightsKind: launchedModel.weightsKind,
            files: await localSdCppWeightFiles(launchedModel),
            pool: imageMediaPool(budget.kind),
          });
          return sdServerLedgerClaim(requirement, budget.fastBytes);
        },
      },
      logPrefix: '[sd-server]',
      // sd-server has no `/health`. It answers the root with an HTML file
      // (with --serve-html-path) or a 404, and starts listening only once
      // it has read the model's metadata — the weights themselves load
      // inside the first request. Any HTTP response is the signal.
      readinessPath: '/',
      readyOnAnyResponse: true,
      // Cold start can take a while: metadata for a 49 GB model, backend
      // init, first kernel compile. Give the readiness probe generous
      // headroom so first launch doesn't trip the restart-budget guard.
      startupTimeoutMs: 5 * 60 * 1000,
      // An idle image engine gives its memory back when a chat model is
      // waiting for it, the same way the chat engines yield to a render.
      ...(opts.arbiter
        ? {
            memoryPressure: () => opts.arbiter!.getMemoryPressureStatus(),
            pressureIdleTimeoutMs: pressureIdleGraceMs(),
          }
        : {}),
      resolveLaunch: async () => {
        const port = cachedPort ?? (await pickFreePort());
        cachedPort = port;
        // Prefer the model the provider asked for, then the configured
        // default, then the first installed — covering a generate with no
        // explicit model, and a requested (or configured) model having
        // since been deleted.
        const requestedId = launchState.modelId ?? defaultLocalModelId;
        const model =
          (requestedId ? await findInstalledModel(storageRoots, requestedId) : undefined) ??
          (await findFirstInstalledModel(storageRoots));
        if (!model) throw new NoLocalImageModelError();
        launchedModel = model;
        return {
          command: binary,
          args: buildSdServerArgs(model, port),
          baseUrl: `http://127.0.0.1:${port}`,
        };
      },
    });
    return new StableDiffusionCppProvider({
      // The baseUrl here is only the fallback when the supervisor is
      // not yet resolved; generate() overrides from `ensureRunning()`.
      baseUrl: 'http://127.0.0.1:9081',
      modelsRoot,
      storageRoots,
      supervisor,
      launchState,
      fetchImpl: patientFetch(),
      ...(defaultLocalModelId ? { defaultModelId: defaultLocalModelId } : {}),
      ...(opts.arbiter ? { arbiter: opts.arbiter } : {}),
    });
  }

  return new StableDiffusionCppProvider({
    baseUrl: 'http://127.0.0.1:9081',
    modelsRoot,
    storageRoots,
    ...(defaultLocalModelId ? { defaultModelId: defaultLocalModelId } : {}),
    // Nothing was wired up. Flag the provider so `health()` can return
    // `not-configured` (distinct UI guidance) rather than making the user
    // wait for a generic "unreachable" probe to fail.
    configured: false,
  });
}

export interface ResolvedInstalledModel extends InstalledImageModelInfo {
  weightsPath: string;
  weightsKind: 'checkpoint' | 'diffusion-model';
  auxiliaryFiles: Array<{ role: string; path: string }>;
}

/**
 * Read one installed model's resolved launch info from its on-disk
 * `manifest.json`, or undefined if absent / malformed / incomplete.
 */
async function resolveInstalledModel(
  modelsRoot: string,
  id: string,
  storageRoots?: ModelStorageRoots,
): Promise<ResolvedInstalledModel | undefined> {
  try {
    const itemDir = join(modelsRoot, id);
    const raw = await readFile(join(itemDir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      id?: string;
      name?: string;
      approxSizeBytes?: number;
      installedAt?: string;
      weightsFilename?: string;
      weightsKind?: 'checkpoint' | 'diffusion-model';
      auxiliaryFiles?: Array<{ role?: string; filename?: string }>;
      fileSha256?: Record<string, string>;
    };
    if (!parsed.id || !parsed.name || !parsed.weightsFilename) return undefined;
    if (
      storageRoots &&
      !(await verifyReadOnlyModelPayload(storageRoots, modelsRoot, id, parsed.fileSha256))
    ) {
      return undefined;
    }
    const aux: Array<{ role: string; path: string }> = [];
    for (const a of parsed.auxiliaryFiles ?? []) {
      if (a.role && a.filename) aux.push({ role: a.role, path: join(itemDir, a.filename) });
    }
    return {
      id: parsed.id,
      name: parsed.name,
      approxSizeBytes: parsed.approxSizeBytes ?? 0,
      installedAt: parsed.installedAt ?? new Date().toISOString(),
      weightsPath: join(itemDir, parsed.weightsFilename),
      weightsKind: parsed.weightsKind ?? 'checkpoint',
      auxiliaryFiles: aux,
    };
  } catch {
    return undefined;
  }
}

/** Resolve a specific installed model by id (the one a request targets). */
async function findInstalledModel(
  storageRoots: ModelStorageRoots,
  id: string,
): Promise<ResolvedInstalledModel | undefined> {
  const root = await findModelRoot(storageRoots, id);
  return root ? resolveInstalledModel(root, id, storageRoots) : undefined;
}

async function findFirstInstalledModel(
  storageRoots: ModelStorageRoots,
): Promise<ResolvedInstalledModel | undefined> {
  const entries = await listOverlayModelIds(storageRoots);
  entries.sort();
  for (const id of entries) {
    const model = await findInstalledModel(storageRoots, id);
    if (model) return model;
  }
  return undefined;
}

/**
 * Translate a resolved on-disk model into stable-diffusion.cpp's `sd-server`
 * launch flags. `checkpoint` weights load via `--model`; `diffusion-model`
 * weights are unet-only and ride alongside `--vae`/`--clip_l`/`--clip_g`/
 * `--t5xxl` from the auxiliary files. Aux roles map 1:1 to flag names.
 *
 * Bind flags use `--listen-ip` / `--listen-port` (NOT `--host` / `--port`)
 * — that's the upstream stable-diffusion.cpp server CLI as of master-587;
 * earlier llama.cpp-style `--host` / `--port` will be rejected with
 * `error: unknown argument: --host` and the supervisor restart-loops.
 *
 * `--vae-tiling` is the default because SDXL/Flux-class VAE decode at
 * 800–1024px wants a single ~7 GB Vulkan buffer, which exceeds the
 * per-allocation cap most consumer drivers enforce (~25–50% of total
 * VRAM). The OOM lands at the very last step (sampling completes, then
 * VAE blows up), wasting the entire generation. Tiled decode splits
 * that buffer into chunks at ~10–20% decode-speed cost; on a 12 GB
 * card it's the difference between succeeding and dying on `vae alloc
 * compute buffer failed`. Quality difference is imperceptible for the
 * tile sizes sd.cpp picks.
 *
 * The text encoder never takes flash attention. ggml's CPU kernel sums the
 * attention values in FP16, which a Qwen-family encoder overflows: FLUX.2
 * klein on a Windows-on-ARM CPU rendered unrelated shapes with a 200
 * (native-v0.1.53). It bites wherever the encoder lands on the CPU, and the
 * encoder runs once per image, so GPUs lose nothing. `--diffusion-fa` means
 * `--flash-attn off,diffusion=on`, so that branch already leaves it off.
 */
export function buildSdServerArgs(model: ResolvedInstalledModel, port: number): string[] {
  const args: string[] = [];
  if (model.weightsKind === 'diffusion-model') {
    args.push('--diffusion-model', model.weightsPath);
  } else {
    args.push('--model', model.weightsPath);
  }
  for (const aux of model.auxiliaryFiles) {
    args.push(`--${aux.role}`, aux.path);
  }
  const steps = MODEL_SAMPLE_STEP_DEFAULTS.get(model.id);
  if (steps) args.push('--steps', String(steps));
  const profile = sdServerLoadProfile(model.id);
  if (profile.diffusionFlashAttention) args.push('--diffusion-fa');
  else args.push('--flash-attn', 'auto,te=off');
  if (profile.bf16TensorPattern) {
    args.push('--tensor-type-rules', `${profile.bf16TensorPattern}=bf16`);
  }
  if (profile.vaeDecode === 'tiled') args.push('--vae-tiling');
  if (profile.stepCache) args.push('--cache-mode', profile.stepCache);
  args.push('--listen-ip', '127.0.0.1', '--listen-port', String(port));
  return args;
}
