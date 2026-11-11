/**
 * Video model storage + install pipeline.
 *
 * Storage layout (the full diffusers repo tree is preserved so
 * `from_pretrained(modelDir)` loads without rewrites):
 *
 *   <home>/engines/video/models/
 *   └── <model-id>/
 *       ├── manifest.json                 (our install record)
 *       ├── model_index.json              (diffusers pipeline index)
 *       ├── transformer/…
 *       ├── vae/…
 *       └── text_encoder/…
 *
 * Models for the sd.cpp engine live in their own store,
 * `<home>/engines/sd-cpp-video/models/<model-id>/`: one file per sd-server
 * slot, named as the catalog names it, and an install record listing each
 * file's slot. Keeping them apart means a build that predates the engine,
 * or an app's daemon reading this home's models, never lists GGUF weights
 * as a diffusers model it could launch.
 *
 * The install flow mirrors `MlxModelManager.install` (video models are
 * multi-file HF repos): bounded-concurrency download to `.partial`
 * siblings, per-file sha256 verify, atomic rename, write `manifest.json`.
 * Subdirectory layout is honored via each file's repo-relative `name`.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createLogger, videoManifestHasAudio } from '@bendyline/gezel';
import type {
  SdCppVideoRender,
  VideoArchitecture,
  VideoEngine,
  VideoModelComponentRole,
  VideoModelLoad,
  VideoModelManifest,
  VideoPromptFormat,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import {
  MODEL_HASH_READ_BUFFER_BYTES,
  type ModelStorageRoots,
  assertModelStorePathSafe,
  findModelRoot,
  hashModelPayloadFiles,
  listOverlayModelIds,
  makeSharedModelReadable,
  modelExistsOnlyReadOnly,
  modelStorageRoots,
  readOnlyModelError,
  verifyReadOnlyModelPayload,
} from '@bendyline/gezel-inference/internal/models/storage-roots';
import { downloadWithRetry } from '@bendyline/gezel-inference/internal/utils/download-with-retry';
import type { InstalledVideoModelInfo, VideoModelPullEvent } from './types.js';

const log = createLogger('video');

/** What the catalog said about a model's clips, kept so a launch never re-reads the catalog. */
export interface InstalledVideoGeometry {
  recommendedSteps?: number;
  defaultWidth?: number;
  defaultHeight?: number;
  defaultNumFrames?: number;
  defaultFps?: number;
  widthRange?: { min: number; max: number };
  heightRange?: { min: number; max: number };
  numFramesRange?: { min: number; max: number };
  fpsRange?: { min: number; max: number };
  maxDurationSeconds?: number;
}

export interface InstalledVideoModel extends InstalledVideoGeometry {
  id: string;
  name: string;
  approxSizeBytes: number;
  installedAt: string;
  /** Absolute path to the model directory passed to the engine's `--model`. */
  modelDir: string;
  /** Which engine renders it. A record written before the field is a diffusers model. */
  engine: VideoEngine;
  /** Pipeline family (`ltx`, `ltx2`, `wan`, `lingbot`) from the catalog manifest. */
  family: string;
  architecture?: VideoArchitecture;
  /** How the engine should assemble the pipeline (tree vs single-file, etc.). */
  load?: VideoModelLoad;
  /** sd.cpp: each weight file by the sd-server slot it fills, as absolute paths. */
  components?: Array<{ role: VideoModelComponentRole; path: string }>;
  /** sd.cpp: render settings beyond the shared ones. */
  sdCpp?: SdCppVideoRender;
  promptFormat?: VideoPromptFormat;
  /** Default classifier-free guidance scale from the catalog manifest. */
  guidanceScale?: number;
  supportsImageToVideo: boolean;
  imageToVideoOnly: boolean;
  /** The clip comes with a soundtrack. */
  hasAudio: boolean;
  catalogVersion?: string;
  /**
   * True when the model resolves from a read-only overlay root (the machine
   * asset store) rather than this process's writable root. `delete` refuses
   * such models; the UI hides Delete and labels them machine-wide.
   */
  readOnly: boolean;
}

interface InstalledManifest extends InstalledVideoGeometry {
  id: string;
  name: string;
  approxSizeBytes: number;
  installedAt: string;
  catalogId: string;
  catalogVersion: string;
  engine?: VideoEngine;
  family: string;
  architecture?: VideoArchitecture;
  /** How the engine should assemble the pipeline. Persisted so the launch
   * argv is reproducible without re-reading the catalog. */
  load?: VideoModelLoad;
  /** sd.cpp: repo-relative file name per sd-server slot. */
  components?: Array<{ role: VideoModelComponentRole; file: string }>;
  sdCpp?: SdCppVideoRender;
  promptFormat?: VideoPromptFormat;
  guidanceScale?: number;
  supportsImageToVideo?: boolean;
  imageToVideoOnly?: boolean;
  hasAudio?: boolean;
  huggingfaceRepo: string;
  /** Repo-relative file names written into the model dir, in install order. */
  files: string[];
  fileSha256?: Record<string, string>;
}

/** The store each engine's models live in, under `engines/<store>/models`. */
const ENGINE_STORE: Readonly<Record<VideoEngine, string>> = {
  diffusers: 'video',
  'sd-cpp': 'sd-cpp-video',
};

const VIDEO_ENGINES = Object.keys(ENGINE_STORE) as VideoEngine[];

/**
 * Why an sd.cpp entry cannot be installed as written: every file must name
 * the sd-server slot it fills, and a diffusion model must be among them.
 * Gilde's validator holds content to this; the installer checks again so a
 * hand-edited catalog never leaves an install the engine cannot launch.
 */
export function sdCppVideoManifestProblem(manifest: VideoModelManifest): string | null {
  const files = manifest.source.files.filter((f): f is NonNullable<typeof f> => f != null);
  const unnamed = files.find((f) => !f.role);
  if (unnamed) return `${unnamed.name} does not say which sd-server slot it fills`;
  const roles = new Set(files.map((f) => f.role));
  if (roles.size !== files.length) return 'two files claim the same sd-server slot';
  if (!roles.has('diffusion_model')) return 'it has no diffusion model file';
  return null;
}

function geometryOf(manifest: VideoModelManifest): InstalledVideoGeometry {
  return {
    recommendedSteps: manifest.recommendedSteps,
    defaultNumFrames: manifest.defaultNumFrames,
    defaultFps: manifest.defaultFps,
    ...(manifest.defaultWidth !== undefined ? { defaultWidth: manifest.defaultWidth } : {}),
    ...(manifest.defaultHeight !== undefined ? { defaultHeight: manifest.defaultHeight } : {}),
    ...(manifest.widthRange ? { widthRange: manifest.widthRange } : {}),
    ...(manifest.heightRange ? { heightRange: manifest.heightRange } : {}),
    ...(manifest.numFramesRange ? { numFramesRange: manifest.numFramesRange } : {}),
    ...(manifest.fpsRange ? { fpsRange: manifest.fpsRange } : {}),
    ...(manifest.maxDurationSeconds !== undefined
      ? { maxDurationSeconds: manifest.maxDurationSeconds }
      : {}),
  };
}

/**
 * An install record's slot list as absolute paths, or undefined when it is
 * missing, names a slot twice, lacks a diffusion model, or points outside
 * the model's folder.
 */
function sdCppComponents(
  modelDir: string,
  stored: InstalledManifest['components'],
): InstalledVideoModel['components'] {
  if (!Array.isArray(stored) || stored.length === 0) return undefined;
  const out: NonNullable<InstalledVideoModel['components']> = [];
  const roles = new Set<string>();
  for (const entry of stored) {
    const path = typeof entry?.file === 'string' ? safeJoin(modelDir, entry.file) : null;
    if (!path || typeof entry.role !== 'string' || roles.has(entry.role)) return undefined;
    roles.add(entry.role);
    out.push({ role: entry.role, path });
  }
  return roles.has('diffusion_model') ? out : undefined;
}

function storedGeometry(parsed: Partial<InstalledManifest>): InstalledVideoGeometry {
  const out: InstalledVideoGeometry = {};
  for (const key of [
    'recommendedSteps',
    'defaultWidth',
    'defaultHeight',
    'defaultNumFrames',
    'defaultFps',
    'maxDurationSeconds',
  ] as const) {
    const value = parsed[key];
    if (typeof value === 'number' && value > 0) out[key] = value;
  }
  for (const key of ['widthRange', 'heightRange', 'numFramesRange', 'fpsRange'] as const) {
    const range = parsed[key];
    if (range && typeof range.min === 'number' && typeof range.max === 'number') out[key] = range;
  }
  return out;
}

export interface VideoModelManagerOptions {
  home: string;
  catalog: CatalogService;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

/**
 * Concurrent downloads per install. Video models ship a handful of large
 * shards (transformer + VAE + text encoder); a few in flight overlaps
 * connection setup without saturating a slow link. See the matching
 * constant in `providers/mlx/models.ts`.
 */
const VIDEO_DOWNLOAD_CONCURRENCY = 3;

/**
 * Minimal single-consumer async queue bridging concurrent download
 * workers to the `install()` generator. Copied from `providers/mlx/models.ts`
 * — a generator can't `yield` from inside worker promises.
 */
class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private pendingResolve: ((r: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift() as T, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.pendingResolve = resolve;
        });
      },
    };
  }
}

export class VideoModelManager {
  private readonly roots: Readonly<Record<VideoEngine, ModelStorageRoots>>;
  private readonly catalog: CatalogService;
  private readonly fetchImpl: typeof fetch;
  /** Guards against duplicate concurrent installs of the same id. */
  private readonly activeInstalls = new Set<string>();

  constructor(opts: VideoModelManagerOptions) {
    this.roots = {
      diffusers: modelStorageRoots({ home: opts.home, engine: ENGINE_STORE.diffusers }),
      'sd-cpp': modelStorageRoots({ home: opts.home, engine: ENGINE_STORE['sd-cpp'] }),
    };
    this.catalog = opts.catalog;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** The diffusers store, where every model installed before sd.cpp video lives. */
  get rootDir(): string {
    return this.roots.diffusers.writableRoot;
  }

  /** Installed models, both engines unless one is named, sorted by name. */
  async listInstalled(engine?: VideoEngine): Promise<InstalledVideoModel[]> {
    const out: InstalledVideoModel[] = [];
    const seen = new Set<string>();
    for (const e of engine ? [engine] : VIDEO_ENGINES) {
      for (const id of await listOverlayModelIds(this.roots[e])) {
        if (seen.has(id)) continue;
        const summary = await this.loadInstalled(id, e);
        if (!summary) continue;
        seen.add(id);
        out.push(summary);
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async resolveDefaultModel(engine?: VideoEngine): Promise<InstalledVideoModel | null> {
    const models = await this.listInstalled(engine);
    return models[0] ?? null;
  }

  async resolveModel(id: string, engine?: VideoEngine): Promise<InstalledVideoModel | null> {
    for (const e of engine ? [engine] : VIDEO_ENGINES) {
      const model = await this.loadInstalled(id, e);
      if (model) return model;
    }
    return null;
  }

  async delete(id: string): Promise<void> {
    if (!isSafeId(id)) throw new Error(`refusing to delete with unsafe id: ${id}`);
    const engine = (await this.resolveModel(id))?.engine ?? 'diffusers';
    const roots = this.roots[engine];
    if (await modelExistsOnlyReadOnly(roots, id)) {
      throw readOnlyModelError(id);
    }
    await rm(join(roots.writableRoot, id), { recursive: true, force: true });
  }

  /**
   * Install from the catalog. Yields multi-file progress events; emits
   * exactly one terminal event. Existing models at `id` are atomically
   * replaced — files download to `.partial` siblings and rename only
   * after sha256 verification.
   */
  async *install(catalogId: string, signal?: AbortSignal): AsyncIterable<VideoModelPullEvent> {
    if (!isSafeId(catalogId)) {
      yield { type: 'error', error: `unsafe catalog id: ${catalogId}` };
      return;
    }
    // Claim the slot synchronously before any await so a parallel caller
    // can't pass `has() === false` in the same JS turn.
    if (this.activeInstalls.has(catalogId)) {
      yield { type: 'error', error: `install for "${catalogId}" is already in progress` };
      return;
    }
    this.activeInstalls.add(catalogId);
    try {
      const detail = await this.catalog.get('video-model', catalogId);
      if (!detail || detail.manifest.kind !== 'video-model') {
        yield { type: 'error', error: `video-model "${catalogId}" not in catalog` };
        return;
      }
      const manifest = detail.manifest;
      const problem = manifest.engine === 'sd-cpp' ? sdCppVideoManifestProblem(manifest) : null;
      if (problem) {
        yield { type: 'error', error: `${manifest.name} cannot be installed: ${problem}` };
        return;
      }
      const src = manifest.source;
      const modelsRoot = this.roots[manifest.engine].writableRoot;
      const itemDir = join(modelsRoot, catalogId);
      await mkdir(modelsRoot, { recursive: true });
      await assertModelStorePathSafe(modelsRoot, itemDir);
      await mkdir(itemDir, { recursive: true });
      await assertModelStorePathSafe(modelsRoot, itemDir);

      const files = src.files.filter((f): f is NonNullable<typeof f> => f != null);
      const fileCount = files.length;
      const totalBytesAll = files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);

      const perFileBytes = new Array<number>(files.length).fill(0);
      const queue = new AsyncEventQueue<VideoModelPullEvent>();
      const ac = new AbortController();
      // Propagate an external cancel (client disconnect) into the workers.
      if (signal) {
        if (signal.aborted) ac.abort();
        else signal.addEventListener('abort', () => ac.abort(), { once: true });
      }
      const push = (ev: VideoModelPullEvent): void => queue.push(ev);

      let cursor = 0;
      const runWorker = async (): Promise<'ok' | 'error'> => {
        let outcome: 'ok' | 'error' = 'ok';
        while (!ac.signal.aborted) {
          const index = cursor;
          cursor += 1;
          if (index >= files.length) break;
          const file = files[index];
          if (!file) break;
          const fileResult = await this.downloadFileConcurrent(
            itemDir,
            // Per-file repo/revision override (multi-repo single-file
            // installs: a transformer checkpoint plus a reference repo's
            // components) falls back to the source-level repo for ordinary
            // diffusers trees.
            file.repo ?? src.huggingfaceRepo,
            file.revision ?? src.revision,
            file,
            index,
            fileCount,
            perFileBytes,
            totalBytesAll,
            push,
            ac,
          );
          if (fileResult === 'error') {
            outcome = 'error';
            ac.abort();
            break;
          }
          if (fileResult === 'aborted') break;
        }
        return outcome;
      };

      const poolSize = Math.min(VIDEO_DOWNLOAD_CONCURRENCY, Math.max(files.length, 1));
      const workers = Array.from({ length: poolSize }, () => runWorker());
      const settled = Promise.allSettled(workers).then((results) => {
        queue.close();
        return results;
      });

      let sawError = false;
      for await (const ev of queue) {
        yield ev;
        if (ev.type === 'error') sawError = true;
      }
      const results = await settled;
      const threw = results.find((r) => r.status === 'rejected') as
        | PromiseRejectedResult
        | undefined;
      if (threw && !sawError) {
        const reason = threw.reason;
        yield {
          type: 'error',
          error: `video download failed: ${reason instanceof Error ? reason.message : String(reason)}`,
        };
        return;
      }
      const workerErrored = results.some((r) => r.status === 'fulfilled' && r.value === 'error');
      if (sawError || workerErrored) return;

      // Commit: rename every `.partial` into place. Half-renamed state is
      // a mess, so bail on the first failure.
      for (const file of files) {
        const finalPath = join(itemDir, file.name);
        const partialPath = `${finalPath}.partial`;
        try {
          await rm(finalPath, { force: true });
          await rename(partialPath, finalPath);
        } catch (err) {
          yield { type: 'error', error: `rename failed for ${file.name}: ${describeError(err)}` };
          return;
        }
      }

      const installed: InstalledManifest = {
        id: catalogId,
        name: manifest.name,
        approxSizeBytes: src.approxSizeBytes,
        installedAt: new Date().toISOString(),
        catalogId,
        catalogVersion: manifest.version,
        engine: manifest.engine,
        family: manifest.family,
        ...(manifest.architecture ? { architecture: manifest.architecture } : {}),
        ...(manifest.load ? { load: manifest.load } : {}),
        ...(manifest.engine === 'sd-cpp'
          ? {
              components: files.flatMap((f) => (f.role ? [{ role: f.role, file: f.name }] : [])),
            }
          : {}),
        ...(manifest.sdCpp ? { sdCpp: manifest.sdCpp } : {}),
        ...(manifest.promptFormat ? { promptFormat: manifest.promptFormat } : {}),
        ...(manifest.guidanceScale !== undefined ? { guidanceScale: manifest.guidanceScale } : {}),
        supportsImageToVideo: manifest.supportsImageToVideo,
        imageToVideoOnly: manifest.imageToVideoOnly === true,
        hasAudio: videoManifestHasAudio(manifest),
        ...geometryOf(manifest),
        huggingfaceRepo: src.huggingfaceRepo,
        files: files.map((f) => f.name),
      };
      installed.fileSha256 = await hashModelPayloadFiles(itemDir);
      await writeFile(join(itemDir, 'manifest.json'), JSON.stringify(installed, null, 2), 'utf8');
      await makeSharedModelReadable(itemDir);
      log.info(`[video] installed ${catalogId} (${files.length} files)`);
      yield { type: 'done', id: catalogId };
    } finally {
      this.activeInstalls.delete(catalogId);
    }
  }

  /**
   * Download + verify one file, pushing events through `push` so it can
   * run concurrently with sibling files. Returns `'ok'`, `'error'` (a
   * terminal error was already pushed), or `'aborted'` (a sibling failed;
   * no terminal event pushed).
   */
  private async downloadFileConcurrent(
    itemDir: string,
    repo: string,
    revision: string | undefined,
    file: { name: string; sha256: string; sizeBytes: number; repo?: string; revision?: string },
    index: number,
    total: number,
    perFileBytes: number[],
    totalBytesAll: number,
    push: (ev: VideoModelPullEvent) => void,
    ac: AbortController,
  ): Promise<'ok' | 'error' | 'aborted'> {
    const finalPath = join(itemDir, file.name);
    // Repo-relative names may carry subdirectories (e.g. `vae/config.json`).
    await mkdir(dirname(finalPath), { recursive: true });
    const tmpPath = `${finalPath}.partial`;
    const ref = revision ?? 'main';
    const url = `https://huggingface.co/${repo}/resolve/${encodeURIComponent(ref)}/${file.name
      .split('/')
      .map(encodeURIComponent)
      .join('/')}?download=true`;

    const sumAll = (): number => {
      let sum = 0;
      for (const b of perFileBytes) sum += b;
      return sum;
    };

    const dlGen = downloadWithRetry({
      url,
      destPath: finalPath,
      approxSizeBytes: file.sizeBytes,
      fetchImpl: this.fetchImpl,
      signal: ac.signal,
    });
    let totalBytes = file.sizeBytes;
    while (true) {
      const step = await dlGen.next();
      if (step.done) {
        if (step.value.kind === 'aborted') return 'aborted';
        if (step.value.kind === 'error') {
          push({ type: 'error', error: `${file.name}: ${step.value.error}` });
          return 'error';
        }
        break;
      }
      const ev = step.value;
      if (ev.type === 'progress') {
        if (ev.totalBytes > 0) totalBytes = ev.totalBytes;
        perFileBytes[index] = ev.bytesWritten;
        push({
          type: 'progress',
          fileIndex: index,
          fileCount: total,
          file: file.name,
          bytesWritten: ev.bytesWritten,
          totalBytes,
          bytesWrittenAll: sumAll(),
          totalBytesAll,
        });
      } else if (ev.type === 'retrying') {
        push({
          type: 'retrying',
          file: file.name,
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          delayMs: ev.delayMs,
          reason: ev.reason,
        });
      }
    }

    push({ type: 'verifying', file: file.name });
    const hasher = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      // Big read buffer so the hash doesn't starve in the busy daemon event
      // loop. See MODEL_HASH_READ_BUFFER_BYTES.
      const stream = createReadStream(tmpPath, { highWaterMark: MODEL_HASH_READ_BUFFER_BYTES });
      stream.on('data', (chunk) => hasher.update(chunk));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    const actual = hasher.digest('hex');
    if (actual !== file.sha256.toLowerCase()) {
      await rm(tmpPath, { force: true });
      push({
        type: 'error',
        error: `The file '${file.name}' on Hugging Face has changed since this catalog version was published. Expected sha256 ${file.sha256}, got ${actual}.`,
      });
      return 'error';
    }
    return 'ok';
  }

  private async loadInstalled(
    id: string,
    engine: VideoEngine,
  ): Promise<InstalledVideoModel | null> {
    const storageRoots = this.roots[engine];
    const root = await findModelRoot(storageRoots, id);
    if (!root) return null;
    const metaPath = join(root, id, 'manifest.json');
    let raw: string;
    try {
      raw = await readFile(metaPath, 'utf8');
    } catch {
      return null;
    }
    let parsed: Partial<InstalledManifest>;
    try {
      parsed = JSON.parse(raw) as Partial<InstalledManifest>;
    } catch {
      return null;
    }
    if (!parsed.id || !parsed.name || !parsed.installedAt || !Array.isArray(parsed.files)) {
      return null;
    }
    if (!(await verifyReadOnlyModelPayload(storageRoots, root, id, parsed.fileSha256))) {
      return null;
    }
    // A record in the sd.cpp store is an sd.cpp model whatever it says; one
    // that names another engine than its store's was not written by this build.
    if ((parsed.engine ?? 'diffusers') !== engine) return null;
    const modelDir = join(root, id);
    const components =
      engine === 'sd-cpp' ? sdCppComponents(modelDir, parsed.components) : undefined;
    if (engine === 'sd-cpp' && !components) return null;
    return {
      id: parsed.id,
      name: parsed.name,
      approxSizeBytes: parsed.approxSizeBytes ?? 0,
      installedAt: parsed.installedAt,
      modelDir,
      engine,
      family: parsed.family ?? 'ltx',
      readOnly: resolve(root) !== resolve(storageRoots.writableRoot),
      supportsImageToVideo: parsed.supportsImageToVideo === true,
      imageToVideoOnly: parsed.imageToVideoOnly === true,
      hasAudio: parsed.hasAudio ?? parsed.load?.audio === true,
      ...storedGeometry(parsed),
      ...(parsed.architecture ? { architecture: parsed.architecture } : {}),
      ...(parsed.load ? { load: parsed.load } : {}),
      ...(components ? { components } : {}),
      ...(parsed.sdCpp ? { sdCpp: parsed.sdCpp } : {}),
      ...(parsed.promptFormat ? { promptFormat: parsed.promptFormat } : {}),
      ...(parsed.guidanceScale !== undefined ? { guidanceScale: parsed.guidanceScale } : {}),
      ...(parsed.catalogVersion ? { catalogVersion: parsed.catalogVersion } : {}),
    };
  }
}

/**
 * Which video model the single-model engine should bind. The diffusers
 * server loads exactly one model at launch, so "use a different model" means
 * relaunching it. This selector is the shared source of truth between the
 * provider — which sets a per-request override and stops the engine when the
 * bound model differs — and the factory's `resolveLaunch`, which reads it to
 * build the launch argv. Keeping resolution in one place means the two can't
 * disagree on which weights actually run.
 *
 * Precedence: per-request override → configured default → first installed.
 */
export class VideoModelSelector {
  /** Per-request model id override, set by the provider before each generate. */
  requestedId: string | undefined;
  /** Model id the running engine was launched with; set by `resolveLaunch`. */
  launchedId: string | undefined;

  /**
   * @param engine The engine this selector launches. A configured default
   * that belongs to the other engine is skipped rather than handed to the
   * wrong server.
   */
  constructor(
    private readonly models: VideoModelManager,
    private readonly defaultId: () => string | undefined,
    private readonly engine?: VideoEngine,
  ) {}

  /** Resolve the model that should run for the current request, or null when
   *  nothing is installed. A per-request or configured id that isn't installed
   *  falls through to the first installed model. */
  async pick(): Promise<InstalledVideoModel | null> {
    const id = this.requestedId ?? this.defaultId();
    return (
      (id ? await this.models.resolveModel(id, this.engine) : null) ??
      (await this.models.resolveDefaultModel(this.engine))
    );
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isSafeId(id: string): boolean {
  if (id.length === 0 || id.length > 64) return false;
  if (id.includes('/') || id.includes('\\') || id.startsWith('.')) return false;
  return /^[a-z0-9][a-z0-9.\-:]{0,63}$/i.test(id);
}

/** What the model list says about one installed model. */
export function installedVideoModelInfo(m: InstalledVideoModel): InstalledVideoModelInfo {
  return {
    id: m.id,
    name: m.name,
    approxSizeBytes: m.approxSizeBytes,
    installedAt: m.installedAt,
    ...(m.readOnly ? { readOnly: true } : {}),
    engine: m.engine,
    family: m.family,
    supportsImageToVideo: m.supportsImageToVideo,
    imageToVideoOnly: m.imageToVideoOnly,
    hasAudio: m.hasAudio,
    ...(m.defaultWidth ? { defaultWidth: m.defaultWidth } : {}),
    ...(m.defaultHeight ? { defaultHeight: m.defaultHeight } : {}),
    ...(m.defaultNumFrames ? { defaultNumFrames: m.defaultNumFrames } : {}),
    ...(m.defaultFps ? { defaultFps: m.defaultFps } : {}),
  };
}
