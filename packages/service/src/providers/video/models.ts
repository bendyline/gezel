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
 * The install flow mirrors `MlxModelManager.install` (video models are
 * multi-file HF repos): bounded-concurrency download to `.partial`
 * siblings, per-file sha256 verify, atomic rename, write `manifest.json`.
 * Subdirectory layout is honored via each file's repo-relative `name`.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import type { VideoModelLoad } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import {
  MODEL_HASH_READ_BUFFER_BYTES,
  type ModelStorageRoots,
  findModelRoot,
  hashModelPayloadFiles,
  listOverlayModelIds,
  makeSharedModelReadable,
  modelExistsOnlyReadOnly,
  modelStorageRoots,
  readOnlyModelError,
  verifyReadOnlyModelPayload,
} from '../../models/storage-roots.js';
import { downloadWithRetry } from '../../utils/download-with-retry.js';
import type { VideoModelPullEvent } from './types.js';

const log = createLogger('video');

export interface InstalledVideoModel {
  id: string;
  name: string;
  approxSizeBytes: number;
  installedAt: string;
  /** Absolute path to the model directory passed to the engine's `--model`. */
  modelDir: string;
  /** Pipeline family (`ltx`, `ltx2`, `wan`) from the catalog manifest. */
  family: string;
  /** How the engine should assemble the pipeline (tree vs single-file, etc.). */
  load?: VideoModelLoad;
  /** Default classifier-free guidance scale from the catalog manifest. */
  guidanceScale?: number;
  catalogVersion?: string;
}

interface InstalledManifest {
  id: string;
  name: string;
  approxSizeBytes: number;
  installedAt: string;
  catalogId: string;
  catalogVersion: string;
  family: string;
  /** How the engine should assemble the pipeline. Persisted so the launch
   * argv is reproducible without re-reading the catalog. */
  load?: VideoModelLoad;
  guidanceScale?: number;
  huggingfaceRepo: string;
  /** Repo-relative file names written into the model dir, in install order. */
  files: string[];
  fileSha256?: Record<string, string>;
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
  private readonly modelsRoot: string;
  private readonly storageRoots: ModelStorageRoots;
  private readonly catalog: CatalogService;
  private readonly fetchImpl: typeof fetch;
  /** Guards against duplicate concurrent installs of the same id. */
  private readonly activeInstalls = new Set<string>();

  constructor(opts: VideoModelManagerOptions) {
    this.storageRoots = modelStorageRoots({ home: opts.home, engine: 'video' });
    this.modelsRoot = this.storageRoots.writableRoot;
    this.catalog = opts.catalog;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get rootDir(): string {
    return this.modelsRoot;
  }

  async listInstalled(): Promise<InstalledVideoModel[]> {
    const entries = await listOverlayModelIds(this.storageRoots);
    const out: InstalledVideoModel[] = [];
    for (const id of entries) {
      const summary = await this.loadInstalled(id);
      if (summary) out.push(summary);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async resolveDefaultModel(): Promise<InstalledVideoModel | null> {
    const models = await this.listInstalled();
    return models[0] ?? null;
  }

  async resolveModel(id: string): Promise<InstalledVideoModel | null> {
    return this.loadInstalled(id);
  }

  async delete(id: string): Promise<void> {
    if (!isSafeId(id)) throw new Error(`refusing to delete with unsafe id: ${id}`);
    if (await modelExistsOnlyReadOnly(this.storageRoots, id)) {
      throw readOnlyModelError(id);
    }
    await rm(join(this.modelsRoot, id), { recursive: true, force: true });
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
      const src = manifest.source;
      const itemDir = join(this.modelsRoot, catalogId);
      await mkdir(itemDir, { recursive: true });

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
            // installs, e.g. LTX-2.3 transformer + LTX-2 components) falls
            // back to the source-level repo for ordinary diffusers trees.
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
        family: manifest.family,
        ...(manifest.load ? { load: manifest.load } : {}),
        ...(manifest.guidanceScale !== undefined ? { guidanceScale: manifest.guidanceScale } : {}),
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

  private async loadInstalled(id: string): Promise<InstalledVideoModel | null> {
    const root = await findModelRoot(this.storageRoots, id);
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
    if (!(await verifyReadOnlyModelPayload(this.storageRoots, root, id, parsed.fileSha256))) {
      return null;
    }
    return {
      id: parsed.id,
      name: parsed.name,
      approxSizeBytes: parsed.approxSizeBytes ?? 0,
      installedAt: parsed.installedAt,
      modelDir: join(root, id),
      family: parsed.family ?? 'ltx',
      ...(parsed.load ? { load: parsed.load } : {}),
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

  constructor(
    private readonly models: VideoModelManager,
    private readonly defaultId: () => string | undefined,
  ) {}

  /** Resolve the model that should run for the current request, or null when
   *  nothing is installed. A per-request or configured id that isn't installed
   *  falls through to the first installed model. */
  async pick(): Promise<InstalledVideoModel | null> {
    const id = this.requestedId ?? this.defaultId();
    return (
      (id ? await this.models.resolveModel(id) : null) ?? (await this.models.resolveDefaultModel())
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
