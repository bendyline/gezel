/**
 * Provider-selection helper for image generation.
 *
 * Selection rules (first-match):
 *   1. `GEZEL_MOCK_PROVIDER=1` → `MockImageProvider` (tests, CI).
 *   2. `config.imageProvider === 'google-ai'` → `GoogleAiImageProvider`
 *      with the SecretStore-stored Google AI Studio API key. A null
 *      key still returns the provider — `health()` reports
 *      `not-configured` so the UI can guide the user to add a key.
 *   3. `config.imageProvider === 'openai'` → `OpenAIImageProvider`
 *      (GPT Image 2). Same shape: lazy, missing key surfaces via
 *      `health()`.
 *   4. `config.imageProvider === 'mock'` → `MockImageProvider`.
 *   5. `GEZEL_SD_SERVER_URL` present → `StableDiffusionCppProvider`
 *      pointed at that URL, no supervisor ("user runs their own
 *      server" mode — useful during development and while the
 *      bundled binary pipeline is under construction).
 *   6. `GEZEL_SD_SERVER_BIN` present → `StableDiffusionCppProvider`
 *      backed by a `NativeEngineSupervisor` that spawns the binary
 *      on-demand at an ephemeral port. This is the fully-automatic
 *      path that the Electron installer will eventually take.
 *   7. Fallback: `StableDiffusionCppProvider` with the default
 *      base URL (127.0.0.1:9081) and no supervisor. `generate()`
 *      surfaces a clear "enable image gen in Settings" error when
 *      nothing is listening.
 */

import { join } from 'node:path';
import type { GezelConfig } from '@bendyline/gezel';
import {
  type ModelStorageRoots,
  findModelRoot,
  listOverlayModelIds,
  modelStorageRoots,
  verifyReadOnlyModelPayload,
} from '../../models/storage-roots.js';
import type { SecretStore } from '../../secrets/types.js';
import type { GpuArbiter } from '../gpu-arbiter.js';
import { pickFreePort } from '../native/port.js';
import { NativeEngineSupervisor } from '../native/supervisor.js';
import { patientFetch } from '../patient-fetch.js';
import { GoogleAiImageProvider } from './google-ai.js';
import { MockImageProvider } from './mock.js';
import { OpenAIImageProvider } from './openai-image.js';
import {
  DISTILLED_MODEL_SAMPLE_STEPS,
  StableDiffusionCppProvider,
  VAE_TILING_INCOMPATIBLE_MODELS,
} from './sd-cpp.js';
import type { ImageProvider, InstalledImageModelInfo } from './types.js';

/**
 * fetch wired to an undici dispatcher with the 5-minute
 * `headersTimeout` and `bodyTimeout` disabled. sd-server's diffusion
 * loop holds a single HTTP request open for the full sample run —
 * 18s/it × 20 steps = 6 min is routine, SDXL or img2img can cross
 * 10 — and Node's global fetch aborts at 5 min via undici's defaults
 * with a generic `fetch failed` even though the engine is still
 * working. Lazily built on first generate so the dispatcher only
 * spins up when an sd-cpp branch is selected.
 */

export interface ImageProviderFactoryOptions {
  home: string;
  /** Override for tests. */
  env?: NodeJS.ProcessEnv;
  /** Active config — drives the cloud-vs-local branch. Optional for legacy callers. */
  config?: GezelConfig;
  /** SecretStore the cloud branches read API keys from. Required for cloud providers. */
  secrets?: SecretStore;
  /** Force the native provider even when a legacy config selected cloud. */
  localOnly?: boolean;
  /**
   * Cross-engine GPU coordinator. Forwarded only to the supervised
   * sd-cpp branch — cloud providers and the user-runs-their-own
   * (`GEZEL_SD_SERVER_URL`) path don't manage VRAM tenancy.
   */
  arbiter?: GpuArbiter;
}

export async function createImageProvider(
  opts: ImageProviderFactoryOptions,
): Promise<ImageProvider> {
  const env = opts.env ?? process.env;
  const storageRoots = modelStorageRoots({ home: opts.home, engine: 'sd-cpp', env });
  const modelsRoot = storageRoots.writableRoot;

  if (env.GEZEL_MOCK_PROVIDER === '1') {
    return new MockImageProvider();
  }

  // The user's pick in Settings -> Image generation. Only meaningful for the
  // local engine; the cloud branches carry their own per-provider default.
  const defaultLocalModelId = opts.config?.defaultImageModel?.['sd-cpp'];

  const choice = opts.localOnly ? undefined : opts.config?.imageProvider;
  if (choice === 'google-ai') {
    const apiKey = opts.secrets
      ? await opts.secrets.get({ kind: 'providerCredential', name: 'googleAiApiKey' })
      : null;
    return new GoogleAiImageProvider({ apiKey });
  }
  if (choice === 'openai') {
    const [apiKey, organization] = opts.secrets
      ? await Promise.all([
          opts.secrets.get({ kind: 'providerCredential', name: 'openaiApiKey' }),
          opts.secrets.get({ kind: 'providerCredential', name: 'openaiOrganization' }),
        ])
      : [null, null];
    return new OpenAIImageProvider({ apiKey, organization });
  }
  if (choice === 'mock') {
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
    const supervisor = new NativeEngineSupervisor({
      logPrefix: '[sd-server]',
      // sd-server doesn't expose `/health`; the master-587 build serves
      // either an HTML file (when --serve-html-path is set) or a 404 at
      // root. In both cases the act of returning HTTP bytes proves the
      // listener is live and the model is loaded — that's the signal
      // we care about. Without these overrides the supervisor would
      // poll /health, see nothing but 404s, and time out at 60s while
      // sd-server is happily idle on the configured port.
      readinessPath: '/',
      readyOnAnyResponse: true,
      // Cold-start can take a while: model load (12s observed) + Metal
      // backend init + first kernel compile. Give the readiness probe
      // generous headroom so first-launch doesn't trip the supervisor's
      // restart-budget guard.
      startupTimeoutMs: 5 * 60 * 1000,
      resolveLaunch: async () => {
        const port = cachedPort ?? (await pickFreePort());
        cachedPort = port;
        // Prefer the model the provider asked for, then the user's
        // configured default, then the first installed — covering a
        // generate with no explicit model, and a requested (or
        // configured) model having since been deleted.
        const requestedId = launchState.modelId ?? defaultLocalModelId;
        const model =
          (requestedId ? await findInstalledModel(storageRoots, requestedId) : undefined) ??
          (await findFirstInstalledModel(storageRoots));
        if (!model) {
          throw new Error(
            'No image model is available locally. Download one from Settings → Image generation before generating.',
          );
        }
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
    // Branch 4: nothing was wired up. Flag the provider so `health()`
    // can return `not-configured` (distinct UI guidance) rather than
    // making the user wait for a generic "unreachable" probe to fail.
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
  const { readFile } = await import('node:fs/promises');
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
  const steps = DISTILLED_MODEL_SAMPLE_STEPS.get(model.id);
  if (steps) args.push('--steps', String(steps));
  // Tiling avoids VAE-decode OOM on large images, but produces visible
  // tile-boundary seams with some VAEs (Krea 2's Qwen-Image VAE). Skip
  // it for those models — see VAE_TILING_INCOMPATIBLE_MODELS.
  if (!VAE_TILING_INCOMPATIBLE_MODELS.has(model.id)) args.push('--vae-tiling');
  args.push('--listen-ip', '127.0.0.1', '--listen-port', String(port));
  return args;
}
