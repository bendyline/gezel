/**
 * StableDiffusionCppProvider — talks to a local `sd-server` binary over
 * HTTP. The server speaks an OpenAI-compatible `/v1/images/generations`
 * shape with a few extensions (seed, sample_steps, negative_prompt,
 * cfg_scale) supported by upstream sd.cpp.
 *
 * Lifecycle of the server itself is not the provider's concern — an
 * Electron-side supervisor (Phase 3) spawns / idle-stops the binary and
 * the provider simply hits whichever URL is configured. If the server
 * isn't reachable, {@link generate} surfaces a clear error so the UI
 * can prompt the user to enable image generation in Settings.
 *
 * Model management is filesystem-only: weights live under
 * `<modelsRoot>/<id>/weights.*` alongside a resolved copy of the
 * catalog manifest (so local state is self-describing even if the
 * catalog entry later disappears).
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import {
  MODEL_HASH_READ_BUFFER_BYTES,
  type ModelStorageRoots,
  findModelRoot,
  hashModelPayloadFiles,
  listOverlayModelIds,
  makeSharedModelReadable,
  modelExistsOnlyReadOnly,
  readOnlyModelError,
  verifyReadOnlyModelPayload,
} from '../../models/storage-roots.js';
import { downloadWithRetry } from '../../utils/download-with-retry.js';
import type { GpuArbiter } from '../gpu-arbiter.js';
import type { NativeEngineSupervisor } from '../native/supervisor.js';
import { resolveImg2ImgSupport } from './img2img-support.js';
import type {
  ImageEngineHealth,
  ImageGenerationInput,
  ImageGenerationOutput,
  ImageGenerationProgress,
  ImageModelAuxiliaryPullSpec,
  ImageModelPullEvent,
  ImageModelPullSpec,
  ImageProvider,
  InstalledImageModelInfo,
} from './types.js';

const log = createLogger('image');

export interface StableDiffusionCppProviderOptions {
  /** Base URL of the running sd-server (no trailing slash). */
  baseUrl: string;
  /** Absolute path to `~/.gezel/engines/sd-cpp/models`. */
  modelsRoot: string;
  /** Optional read-only machine-store overlay. */
  storageRoots?: ModelStorageRoots;
  /** Per-request timeout in ms. Defaults to 10 minutes. */
  timeoutMs?: number;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Optional lifecycle manager. When supplied, the provider calls
   * `ensureRunning()` before each generate and uses the returned
   * baseUrl (overriding `baseUrl`) — so lazy-start / idle-stop /
   * health-watch all work transparently. Omit for "user runs
   * sd-server themselves" deployments.
   */
  supervisor?: NativeEngineSupervisor;
  /**
   * Whether the factory had a real engine wiring (an explicit URL or a
   * spawnable binary) at construction. The default-loopback fallback
   * sets this to false so `health()` can return `not-configured`
   * instead of `unreachable` — distinct UI state, distinct guidance.
   */
  configured?: boolean;
  /**
   * Cross-engine GPU coordinator. When supplied alongside a
   * supervisor, the provider acquires the `'image'` slot before each
   * generate (which evicts the local LLM in `swap` mode) and
   * registers its supervisor's `stop()` as the `'image'` evictor so
   * the LLM can evict us back symmetrically.
   */
  arbiter?: GpuArbiter;
  /**
   * Shared, mutable holder the supervised path uses to tell the
   * factory's `resolveLaunch` which installed model to spawn sd-server
   * with. sd-server serves one model per process, so when a request
   * targets a different installed model than the one loaded, the
   * provider updates `modelId` here and stops the running server — the
   * next `ensureRunning()` relaunches with the requested model instead
   * of always serving whichever model sorts first.
   */
  launchState?: { modelId: string | undefined };
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SAMPLE_STEPS = 20;
/**
 * Step-distilled models that produce a clean image in ~4 steps; running
 * them at the 20-step default wastes a 5× multiple of render time for
 * no quality gain. Shared with the factory's `buildSdServerArgs` (which
 * bakes the same value into the server's `--steps` launch default) so
 * the two call sites can't drift apart.
 */
export const DISTILLED_MODEL_SAMPLE_STEPS = new Map<string, number>([
  ['flux-1-schnell-q4', 4],
  ['flux-2-klein-4b-q4', 4],
  ['sd-turbo', 4],
  ['sdxl-lightning-4step', 4],
  ['sdxl-turbo', 4],
  // Krea 2 Turbo is an 8-step distilled model. Setting the launch
  // `--steps` default matters more than for the others: the pinned
  // sd-server doesn't honor the per-request `sample_steps`/`steps`
  // override for these models, so without this the server falls back to
  // its built-in 20-step default — 5× the render time for no quality
  // gain, and on CPU that overruns the generate timeout entirely.
  ['krea-2-turbo-q4', 8],
  ['krea-2-turbo-q6', 8],
  ['krea-2-turbo-q8', 8],
]);

/**
 * Classifier-free guidance (CFG) scale per model, applied to the
 * `/sdapi/v1/txt2img` request. Distilled / Flux-flow models are trained
 * to run at CFG 1 — their guidance is baked in (turbo/lightning) or
 * carried by the separate Flux distilled-guidance value. Applying
 * sd-server's higher default CFG to them blows out color and contrast
 * (the oversaturated, "burned" look Krea 2 Turbo had before this).
 * Models absent from the map (traditional SD 1.x / SDXL checkpoints)
 * omit `cfg_scale` and inherit the server default, preserving their
 * established behavior.
 */
export const MODEL_CFG_DEFAULTS = new Map<string, number>([
  ['krea-2-turbo-q4', 1],
  ['krea-2-turbo-q6', 1],
  ['krea-2-turbo-q8', 1],
  ['flux-1-schnell-q4', 1],
  ['flux-1-dev-q4', 1],
  ['flux-2-klein-4b-q4', 1],
  ['sd-turbo', 1],
  ['sdxl-turbo', 1],
  ['sdxl-lightning-4step', 1],
]);

/**
 * Models whose VAE shows visible tile-boundary seams under
 * stable-diffusion.cpp's `--vae-tiling` (Krea 2's Qwen-Image VAE is the
 * known case — rainbow column streaks at ≤512px). `--vae-tiling` is a
 * launch-time, size-agnostic flag: sd-server serves every request size
 * from one process, so we can't gate it per-request on image size as
 * we'd ideally like — we gate it per-model instead and skip it here.
 * The trade-off is that very large renders of these models could hit a
 * VAE allocation cap on memory-constrained GPUs; acceptable given these
 * are high-VRAM models and seam-free output matters more.
 */
export const VAE_TILING_INCOMPATIBLE_MODELS = new Set<string>([
  'krea-2-turbo-q4',
  'krea-2-turbo-q6',
  'krea-2-turbo-q8',
]);

export class StableDiffusionCppProvider implements ImageProvider {
  readonly name = 'sd-cpp';
  private readonly baseUrl: string;
  private readonly modelsRoot: string;
  private readonly storageRoots: ModelStorageRoots;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly supervisor?: NativeEngineSupervisor;
  private readonly configured: boolean;
  private readonly arbiter?: GpuArbiter;
  private readonly launchState?: { modelId: string | undefined };

  constructor(opts: StableDiffusionCppProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.modelsRoot = opts.modelsRoot;
    this.storageRoots = opts.storageRoots ?? {
      writableRoot: opts.modelsRoot,
      readOnlyRoots: [],
    };
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.supervisor = opts.supervisor;
    // Default true — historically the provider had no concept of
    // "unconfigured", and most call sites pass an explicit URL or
    // supervisor. The factory's loopback fallback flips this off.
    this.configured = opts.configured ?? true;
    this.launchState = opts.launchState;
    // Only register an evictor when we own a supervisor. External-URL
    // mode targets an sd-server the user runs themselves; we don't
    // get to stop their process.
    if (opts.arbiter && opts.supervisor) {
      this.arbiter = opts.arbiter;
      this.arbiter.registerEvictor('image', () => opts.supervisor!.stop());
    }
  }

  async generate(input: ImageGenerationInput): Promise<ImageGenerationOutput> {
    const width = input.width ?? 512;
    const height = input.height ?? 512;
    const modelId = input.model ?? (await this.currentDefaultModelId());
    const steps = input.steps ?? (await this.defaultSampleSteps(modelId));
    const seed = input.seed ?? Math.floor(Math.random() * 2_147_483_647);
    const started = Date.now();
    log.info(
      `[sd-cpp] generate model=${modelId ?? 'default'} steps=${steps} explicitSteps=${input.steps !== undefined} size=${width}x${height}`,
    );

    // Model selection: sd-server serves one model per process. When a
    // request targets a different installed model than the one currently
    // loaded, point resolveLaunch at it (via the shared launchState) and
    // stop the running server so the next ensureRunning relaunches with
    // the requested model — instead of always serving whichever model
    // sorts first. A no-op on the first generate (nothing running yet).
    if (this.supervisor && this.launchState && modelId && this.launchState.modelId !== modelId) {
      this.launchState.modelId = modelId;
      await this.supervisor.stop();
    }

    let baseUrl = this.baseUrl;
    // Subscribe to engine log lines for the duration of this generate
    // so sd-server's `|==> | 3/20 - 18.20s/it` sampling output can be
    // forwarded to the caller's `onProgress`. Only meaningful when we
    // own the supervisor (external-URL mode has no log stream).
    let unsubscribeLogs: (() => void) | undefined;
    if (this.supervisor && input.onProgress) {
      const onProgress = input.onProgress;
      unsubscribeLogs = this.supervisor.subscribeLogLines((line) => {
        const parsed = parseSamplingProgress(line);
        if (!parsed) return;
        try {
          onProgress(parsed);
        } catch {
          /* listener errors are not load-bearing — drop silently */
        }
      });
    }
    let releaseGpu: (() => void) | undefined;
    if (this.supervisor) {
      // Acquire the GPU slot BEFORE asking the supervisor to start.
      // In `swap` policy this evicts a running llama-server so its
      // VRAM is freed by the time sd-server tries to load weights.
      // In `coexist` policy the call returns immediately. The arbiter
      // is only set on the supervised path (see constructor).
      if (this.arbiter) releaseGpu = await this.arbiter.acquireLease('image');
      try {
        const launch = await this.supervisor.ensureRunning();
        baseUrl = launch.baseUrl.replace(/\/+$/, '');
      } catch (err) {
        releaseGpu?.();
        throw err;
      }
    }

    // Drive sd-server's A1111-compatible endpoints (`/sdapi/v1/txt2img`
    // and `/sdapi/v1/img2img`). Unlike the OpenAI `/v1/images/*` shape
    // — which reads only prompt/n/size and takes steps/seed/cfg from the
    // server's launch defaults — these honor per-request `steps`,
    // `seed`, `cfg_scale`, and `negative_prompt`, so caller overrides
    // actually take effect. `cfg_scale` is set per model (distilled /
    // Flux-flow models need CFG 1; others inherit the server default).
    const cfg = modelId ? MODEL_CFG_DEFAULTS.get(modelId) : undefined;
    let inputImages = input.inputImages ?? [];
    // Capability gate: models whose architecture doesn't honor init
    // latents on the pinned sd-server fall back to txt2img instead of
    // silently producing an "edit" that never saw the source. The skip
    // is reported on meta so every caller (route, MCP tool, chat
    // bubble) can say so honestly.
    let img2imgSkippedReason: string | undefined;
    if (inputImages.length > 0) {
      const installed = await this.readInstalledManifestFields(modelId);
      const verdict = resolveImg2ImgSupport({
        modelId,
        explicit: installed?.supportsImg2Img,
        weightsKind: installed?.weightsKind,
      });
      if (!verdict.supported) {
        img2imgSkippedReason = verdict.reason ?? 'model does not support image editing (img2img)';
        log.info(`[sd-cpp] dropping ${inputImages.length} input image(s): ${img2imgSkippedReason}`);
        inputImages = [];
      }
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      const body: Record<string, unknown> = {
        prompt: input.prompt,
        negative_prompt: input.negativePrompt ?? '',
        width,
        height,
        steps,
        seed,
        batch_size: 1,
      };
      if (cfg !== undefined) body.cfg_scale = cfg;
      let endpoint = `${baseUrl}/sdapi/v1/txt2img`;
      // Img2img: a single source image drives `/sdapi/v1/img2img` via
      // `init_images` (base64). stable-diffusion.cpp's img2img path takes
      // one image, so we use the first and warn for any extras.
      if (inputImages.length > 0) {
        if (inputImages.length > 1) {
          log.info(
            `[sd-cpp] received ${inputImages.length} input images; img2img uses the first only`,
          );
        }
        const first = inputImages[0]!;
        body.init_images = [Buffer.from(first.data).toString('base64')];
        if (typeof input.strength === 'number') body.denoising_strength = input.strength;
        endpoint = `${baseUrl}/sdapi/v1/img2img`;
      }
      res = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (ctrl.signal.aborted) {
        throw new Error(`sd-server did not respond within ${this.timeoutMs / 1000}s`);
      }
      throw new Error(
        `sd-server unreachable at ${baseUrl}. Is the image engine enabled in Settings? (${err instanceof Error ? err.message : String(err)})`,
      );
    } finally {
      clearTimeout(timer);
      this.supervisor?.markUsed();
      unsubscribeLogs?.();
      releaseGpu?.();
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`sd-server returned ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }

    // A1111 txt2img/img2img return `{ images: [<base64 PNG>], … }`.
    const payload = (await res.json()) as { images?: string[] };
    const b64 = payload.images?.[0];
    if (!b64) throw new Error('sd-server response missing images[0]');
    const png = Buffer.from(b64, 'base64');

    return {
      png,
      meta: {
        model: modelId ?? 'unknown',
        seed,
        steps,
        widthPx: width,
        heightPx: height,
        durationMs: Date.now() - started,
        ...(img2imgSkippedReason ? { img2imgSkippedReason } : {}),
      },
    };
  }

  async listInstalledModels(): Promise<InstalledImageModelInfo[]> {
    const entries = await listOverlayModelIds(this.storageRoots);
    const out: InstalledImageModelInfo[] = [];
    for (const id of entries) {
      const root = await findModelRoot(this.storageRoots, id);
      if (!root) continue;
      const metaPath = join(root, id, 'manifest.json');
      try {
        const raw = await readFile(metaPath, 'utf8');
        const parsed = JSON.parse(raw) as {
          id?: string;
          name?: string;
          approxSizeBytes?: number;
          installedAt?: string;
          weightsKind?: 'checkpoint' | 'diffusion-model';
          supportsImg2Img?: boolean;
          fileSha256?: Record<string, string>;
        };
        if (!parsed.id || !parsed.name || !parsed.approxSizeBytes || !parsed.installedAt) continue;
        if (!(await verifyReadOnlyModelPayload(this.storageRoots, root, id, parsed.fileSha256))) {
          continue;
        }
        out.push({
          id: parsed.id,
          name: parsed.name,
          approxSizeBytes: parsed.approxSizeBytes,
          installedAt: parsed.installedAt,
          ...(parsed.weightsKind ? { weightsKind: parsed.weightsKind } : {}),
          ...(typeof parsed.supportsImg2Img === 'boolean'
            ? { supportsImg2Img: parsed.supportsImg2Img }
            : {}),
        });
      } catch {
        /* skip malformed entries */
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async *pullModel(
    id: string,
    spec: ImageModelPullSpec,
    signal?: AbortSignal,
  ): AsyncIterable<ImageModelPullEvent> {
    const itemDir = join(this.modelsRoot, id);
    await mkdir(itemDir, { recursive: true });

    // Total bytes across the unet + every auxiliary file. Driving the UI
    // progress bar from this aggregate keeps multi-file pulls visually
    // identical to single-file ones.
    const totalAllBytes =
      spec.approxSizeBytes + spec.auxiliaryFiles.reduce((n, f) => n + f.approxSizeBytes, 0);
    let writtenAll = 0;

    const weightsFilename = extractFilename(spec.downloadUrl);
    const weightsPath = join(itemDir, weightsFilename);

    const downloadResult = yield* this.downloadFile({
      url: spec.downloadUrl,
      destPath: weightsPath,
      expectedSha256: spec.sha256,
      approxSizeBytes: spec.approxSizeBytes,
      writtenSoFar: writtenAll,
      totalAllBytes,
      ...(signal ? { signal } : {}),
    });
    if (downloadResult.kind === 'error') {
      yield { type: 'error', error: downloadResult.error };
      yield { type: 'done', id };
      return;
    }
    writtenAll = downloadResult.writtenAll;
    const weightsActualSize = downloadResult.actualSize;

    // Auxiliary files (VAE / clip_l / clip_g / t5xxl). Streamed sequentially
    // so we don't fight the host's bandwidth across N parallel HF connections.
    const auxiliaryRecords: Array<{ role: string; filename: string }> = [];
    for (const aux of spec.auxiliaryFiles) {
      const auxFilename = auxFilenameFor(aux);
      const auxPath = join(itemDir, auxFilename);
      const auxResult = yield* this.downloadFile({
        url: aux.downloadUrl,
        destPath: auxPath,
        expectedSha256: aux.sha256,
        approxSizeBytes: aux.approxSizeBytes,
        writtenSoFar: writtenAll,
        totalAllBytes,
        ...(signal ? { signal } : {}),
      });
      if (auxResult.kind === 'error') {
        yield { type: 'error', error: `${aux.role}: ${auxResult.error}` };
        yield { type: 'done', id };
        return;
      }
      writtenAll = auxResult.writtenAll;
      auxiliaryRecords.push({ role: aux.role, filename: auxFilename });
    }

    const fileSha256 = await hashModelPayloadFiles(itemDir);
    await writeFile(
      join(itemDir, 'manifest.json'),
      JSON.stringify(
        {
          id,
          name: spec.name,
          approxSizeBytes: totalAllBytes,
          weightsFilename,
          weightsKind: spec.weightsKind,
          ...(spec.supportsImg2Img !== undefined ? { supportsImg2Img: spec.supportsImg2Img } : {}),
          weightsSizeBytes: weightsActualSize,
          sha256: spec.sha256.toLowerCase(),
          auxiliaryFiles: auxiliaryRecords,
          fileSha256,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
    await makeSharedModelReadable(itemDir);

    yield { type: 'progress', bytesWritten: writtenAll, totalBytes: totalAllBytes };
    yield { type: 'done', id };
  }

  /**
   * Stream a single URL to disk with sha256 verification, reporting cumulative
   * progress against `totalAllBytes` so multi-file pulls share one bar.
   *
   * Delegates the network plumbing to `downloadWithRetry` — that handles
   * Range-based resume, exponential backoff, chunk-stall timeouts, and
   * friendly error messages. This wrapper only owns the
   * provider-specific concerns: sha256 verification, the
   * `writtenSoFar`-aware progress translation, and the atomic rename
   * after verify.
   */
  private async *downloadFile(opts: {
    url: string;
    destPath: string;
    expectedSha256: string;
    approxSizeBytes: number;
    writtenSoFar: number;
    totalAllBytes: number;
    signal?: AbortSignal;
  }): AsyncGenerator<
    ImageModelPullEvent,
    { kind: 'ok'; writtenAll: number; actualSize: number } | { kind: 'error'; error: string }
  > {
    const { url, destPath, expectedSha256, approxSizeBytes, totalAllBytes, signal } = opts;
    const baseWritten = opts.writtenSoFar;

    const gen = downloadWithRetry({
      url,
      destPath,
      approxSizeBytes,
      fetchImpl: this.fetchImpl,
      ...(signal ? { signal } : {}),
    });
    let writtenThisFile = 0;
    while (true) {
      const next = await gen.next();
      if (next.done) {
        if (next.value.kind === 'ok') {
          writtenThisFile = next.value.bytesWritten;
          break;
        }
        if (next.value.kind === 'aborted') {
          // Leave .partial in place so a follow-up pull resumes.
          return { kind: 'error', error: 'download aborted' };
        }
        return { kind: 'error', error: next.value.error };
      }
      const ev = next.value;
      if (ev.type === 'progress') {
        // Reproject per-file progress onto the multi-file aggregate.
        writtenThisFile = ev.bytesWritten;
        yield {
          type: 'progress',
          bytesWritten: baseWritten + ev.bytesWritten,
          totalBytes: totalAllBytes,
        };
      } else if (ev.type === 'retrying') {
        yield {
          type: 'retrying',
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          delayMs: ev.delayMs,
          reason: ev.reason,
        };
      }
    }

    // sha256 check — stream the .partial through the hasher rather than
    // hashing while we write. Slightly more disk I/O on success, but it
    // means the hasher stays correct across resume (Range requests
    // would otherwise corrupt a per-chunk hasher with mid-file resumed
    // bytes).
    const partialPath = `${destPath}.partial`;
    const hasher = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      // Big read buffer so the hash doesn't starve in the busy daemon event
      // loop. See MODEL_HASH_READ_BUFFER_BYTES.
      const stream = createReadStream(partialPath, {
        highWaterMark: MODEL_HASH_READ_BUFFER_BYTES,
      });
      stream.on('data', (chunk) => hasher.update(chunk));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    const actual = hasher.digest('hex');
    if (actual !== expectedSha256.toLowerCase()) {
      await rm(partialPath, { force: true });
      return {
        kind: 'error',
        error: `sha256 mismatch: expected ${expectedSha256}, got ${actual}`,
      };
    }

    await rm(destPath, { force: true });
    await rename(partialPath, destPath);
    return { kind: 'ok', writtenAll: baseWritten + writtenThisFile, actualSize: writtenThisFile };
  }

  async deleteModel(id: string): Promise<void> {
    if (await modelExistsOnlyReadOnly(this.storageRoots, id)) {
      throw readOnlyModelError(id);
    }
    const itemDir = join(this.modelsRoot, id);
    await rm(itemDir, { recursive: true, force: true });
  }

  async health(): Promise<ImageEngineHealth> {
    // The factory's default-loopback branch flips `configured: false` so
    // we can return a distinct state instead of confusing the user with
    // a generic "unreachable" — the engine isn't unreachable, it was
    // never wired up. Without a binary or external URL, the provider
    // points at 127.0.0.1:9081 by default; nothing's going to answer.
    if (!this.configured) {
      return {
        status: 'not-configured',
        baseUrl: this.baseUrl,
        error:
          'No image engine wired up. Build or bundle stable-diffusion.cpp, or set ' +
          'GEZEL_SD_SERVER_URL to point at a running sd-server.',
      };
    }

    // When a supervisor is wired the engine is "configured but lazy" —
    // the binary will spawn on the first generate. We could call
    // ensureRunning() here, but probing eagerly defeats the lazy-start
    // pattern and would cost a cold-start every time the user opens
    // Settings. Surface ok and rely on the supervisor's internal
    // health-watch.
    if (this.supervisor) {
      return { status: 'ok', baseUrl: this.baseUrl };
    }

    // Probe the configured URL with a short HEAD-style fetch. Most
    // sd-server builds answer the root with a quick 404; what we care
    // about is whether anything's listening at all. A network-level
    // throw (ECONNREFUSED) is the unreachable signal.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/`, {
        method: 'GET',
        signal: ctrl.signal,
      });
      // Any HTTP response — 200, 404, 405 — proves something is listening.
      void res.body?.cancel?.().catch(() => {});
      return { status: 'ok', baseUrl: this.baseUrl };
    } catch (err) {
      const message = ctrl.signal.aborted
        ? `sd-server did not respond within 2s at ${this.baseUrl}`
        : err instanceof Error
          ? err.message
          : String(err);
      return {
        status: 'unreachable',
        baseUrl: this.baseUrl,
        error: message,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async shutdown(): Promise<void> {
    await this.supervisor?.stop();
  }

  /**
   * Returns the first installed model id, or undefined. Stable ordering
   * matches {@link listInstalledModels} so the default is deterministic.
   */
  private async currentDefaultModelId(): Promise<string | undefined> {
    const models = await this.listInstalledModels();
    return models[0]?.id;
  }

  private async defaultSampleSteps(modelId: string | undefined): Promise<number> {
    if (!modelId) return DEFAULT_SAMPLE_STEPS;
    const fields = await this.readInstalledManifestFields(modelId);
    if (
      typeof fields?.recommendedSteps === 'number' &&
      Number.isInteger(fields.recommendedSteps) &&
      fields.recommendedSteps > 0
    ) {
      return fields.recommendedSteps;
    }
    return DISTILLED_MODEL_SAMPLE_STEPS.get(modelId) ?? DEFAULT_SAMPLE_STEPS;
  }

  /**
   * Read the installed `manifest.json` fields that steer per-model
   * behavior. Returns null for unknown ids and unreadable/legacy
   * metadata — callers fall back to their per-field defaults. (Older
   * installed metadata did not persist catalog generation defaults or
   * the img2img capability.)
   */
  private async readInstalledManifestFields(modelId: string | undefined): Promise<{
    recommendedSteps?: number;
    weightsKind?: 'checkpoint' | 'diffusion-model';
    supportsImg2Img?: boolean;
  } | null> {
    if (!modelId) return null;
    try {
      const root = await findModelRoot(this.storageRoots, modelId);
      if (!root) return null;
      const raw = await readFile(join(root, modelId, 'manifest.json'), 'utf8');
      const parsed = JSON.parse(raw) as {
        recommendedSteps?: unknown;
        weightsKind?: unknown;
        supportsImg2Img?: unknown;
      };
      return {
        ...(typeof parsed.recommendedSteps === 'number'
          ? { recommendedSteps: parsed.recommendedSteps }
          : {}),
        ...(parsed.weightsKind === 'checkpoint' || parsed.weightsKind === 'diffusion-model'
          ? { weightsKind: parsed.weightsKind }
          : {}),
        ...(typeof parsed.supportsImg2Img === 'boolean'
          ? { supportsImg2Img: parsed.supportsImg2Img }
          : {}),
      };
    } catch {
      return null;
    }
  }
}

/**
 * Parse a single line of sd-server's sampling progress output. The
 * upstream stable-diffusion.cpp server prints lines shaped like:
 *
 *     |==>                                               | 1/20 - 18.20s/it
 *
 * sometimes with a leading log prefix from our supervisor ("[sd-server] ").
 * Returns the extracted step / total / per-step seconds when the line
 * matches; otherwise null. Anchored on the fraction-with-suffix shape
 * (`N/M - X.Ys/it`) so unrelated log noise can never trip a false match.
 */
export function parseSamplingProgress(line: string): ImageGenerationProgress | null {
  const m = line.match(/(\d+)\s*\/\s*(\d+)\s*-\s*([\d.]+)s\/it/);
  if (!m) return null;
  const step = Number.parseInt(m[1]!, 10);
  const totalSteps = Number.parseInt(m[2]!, 10);
  const secondsPerStep = Number.parseFloat(m[3]!);
  if (!Number.isFinite(step) || !Number.isFinite(totalSteps) || totalSteps <= 0) return null;
  const out: ImageGenerationProgress = { step, totalSteps };
  if (Number.isFinite(secondsPerStep)) out.secondsPerStep = secondsPerStep;
  return out;
}

function extractFilename(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last && last.length > 0 ? last : 'weights.bin';
  } catch {
    return 'weights.bin';
  }
}

/**
 * Filename used on disk for an auxiliary file. We want a deterministic
 * `<role>.<ext>` shape (e.g. `vae.safetensors`) so the supervisor can build
 * launch args without re-hitting the HF URL — but we still respect the
 * upstream file extension so the engine sniffs the right format.
 */
function auxFilenameFor(aux: ImageModelAuxiliaryPullSpec): string {
  const upstream = extractFilename(aux.downloadUrl);
  const dot = upstream.lastIndexOf('.');
  const ext = dot > 0 ? upstream.slice(dot) : '';
  return `${aux.role}${ext}`;
}

// Local type to describe what Node's fetch returns — avoids importing dom types.
interface ReadableStream<T> {
  getReader(): {
    read(): Promise<{ value: T | undefined; done: boolean }>;
  };
}
