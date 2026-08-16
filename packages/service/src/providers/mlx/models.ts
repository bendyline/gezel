/**
 * MLX model storage + install pipeline.
 *
 * Storage layout:
 *
 *   <home>/engines/mlx/
 *   └── models/
 *       └── <model-id>/
 *           ├── manifest.json                    (our install record)
 *           ├── config.json                      (HF model config)
 *           ├── tokenizer.json
 *           ├── tokenizer_config.json
 *           ├── model.safetensors (or sharded model-*.safetensors)
 *           └── model.safetensors.index.json     (if sharded)
 *
 * Install flow (mirrors LlamaCppModelManager.install):
 *   1. Look up the chat-model in the catalog; require an `mlx` source
 *      block with a file list + per-file sha256.
 *   2. For each file, stream-download from
 *      `huggingface.co/<repo>/resolve/<revision>/<name>` (the pinned
 *      commit SHA, or `main` for legacy manifests) to a `.partial`
 *      sibling, hashing as we go.
 *   3. Verify each file's sha256 against the manifest pin.
 *   4. Read `config.json` / `tokenizer_config.json` to extract
 *      contextWindow + chat-template presence.
 *   5. Atomically rename `.partial` files into place + write
 *      `manifest.json`.
 *   6. Yield a terminal `done` or `error` event.
 *
 * Delete + resolve flows are identical in shape to the llama-cpp
 * manager — "first installed, alphabetical" is the default until a
 * proper picker UI lands.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import {
  type ModelBundleSource,
  listBundleModelFiles,
  publishStagedModel,
} from '../../models/bundle-storage.js';
import { type ModelUpdateStatus, evaluateCatalogDrift } from '../../models/catalog-drift.js';
import {
  catalogPayloadFingerprint,
  describeCatalogPayload,
} from '../../models/catalog-payload-identity.js';
import {
  type IncompleteModelDownloadInfo,
  MODEL_HASH_READ_BUFFER_BYTES,
  type ModelStorageRoots,
  type UnrecognizedModelInfo,
  findModelRoot,
  hashModelPayloadFiles,
  inspectModelDirectory,
  listIncompleteModelDownloads,
  listOverlayModelIds,
  makeSharedModelReadable,
  modelExistsOnlyReadOnly,
  modelStorageRoots,
  pruneModelPayloadFiles,
  readOnlyModelError,
  removeModelDir,
  verifyReadOnlyModelPayload,
} from '../../models/storage-roots.js';
import { checkDiskSpace, describeDiskShortfall } from '../../utils/disk-space.js';
import { downloadWithRetry } from '../../utils/download-with-retry.js';
import { readMlxSummary } from './config-parser.js';

export interface InstalledMlxModel {
  id: string;
  name: string;
  approxSizeBytes: number;
  installedAt: string;
  /** Absolute path to the model directory the supervisor passes to `mlx_lm.server --model`. */
  modelDir: string;
  /** Detected context window (from config.json) or from catalog manifest. */
  contextWindow?: number;
  /** Quantization tag (`4bit`, `8bit`, `bf16`) from the catalog source block. */
  quantization?: string;
  /** Empty when `tokenizer_config.json` has no `chat_template`. */
  chatTemplatePresent: boolean;
  /** Architecture name (`gemma`, `llama`, …) from `config.json#architectures`. */
  architecture?: string;
  /**
   * Catalog manifest `version` as of install. Compared against the
   * live catalog's version in the UI to surface an "out of date,
   * reinstall" affordance when a catalog bump changes the upstream
   * repo, the file list, or the sha256 pins (so a user's stale
   * install isn't silently pointed at weights that don't match what
   * the catalog now describes).
   */
  catalogVersion?: string;
  /**
   * True when this model resolves from a read-only overlay (the machine/shared
   * asset store) rather than this daemon's writable root. `delete` refuses
   * these, so the UI shows them as machine-provided rather than offering a
   * Delete that can only fail.
   */
  readOnly?: boolean;
  /**
   * True when the catalog now describes a different PAYLOAD than the one on
   * disk — different repo, file list, or hashes. A version bump that only
   * edits metadata (tuning, sizing hints, wording) deliberately does not set
   * this: the runtime resolves that live from the catalog, so there is nothing
   * for the user to download. Computed server-side in
   * {@link MlxModelManager.listInstalled} so every surface agrees.
   */
  updateAvailable?: boolean;
  /** The catalog's current version, when it differs from the installed one. */
  availableVersion?: string;
  /** What changed, in one sentence, for the model manager's tooltip. */
  updateReason?: string;
}

/**
 * Snapshot of an in-flight MLX install — same shape as
 * `LlamaCppActiveInstallSnapshot` so the catalog UI can render
 * progress for either provider with the same component. MLX
 * downloads multiple files per install; cumulative bytes drive the
 * progress bar (one bar per model, not per file).
 */
export interface MlxActiveInstallSnapshot {
  catalogId: string;
  bytesWritten: number;
  totalBytes: number;
  phase: 'downloading' | 'verifying' | 'extracting-metadata';
  startedAt: string;
}

export type MlxInstallEvent =
  | {
      type: 'progress';
      fileIndex: number;
      fileCount: number;
      file: string;
      bytesWritten: number;
      totalBytes: number;
      /** Cumulative bytes downloaded across every file so far in this
       *  install (sum of completed files' sizes + current file's
       *  `bytesWritten`). Lets the UI render one progress bar against
       *  the whole model instead of per-shard. */
      bytesWrittenAll: number;
      /** Sum of `sizeBytes` across every file the manifest pins. Stable
       *  for the duration of the install. */
      totalBytesAll: number;
    }
  /**
   * Surfaced when the shared `downloadWithRetry` helper hit a transient
   * network error and is about to try again. UI shows
   * "Connection dropped — retrying in 4s (attempt 3/5)…" The shape
   * mirrors llama-cpp / sd-cpp; the additional `file` field is for
   * multi-file MLX models so the UI can show "retrying file 2 of 5".
   */
  | {
      type: 'retrying';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
      file: string;
    }
  | { type: 'verifying'; file: string }
  | { type: 'extracting-metadata' }
  | { type: 'done'; id: string; warning?: string }
  /**
   * Terminal failure. When the failure is specifically a sha256 mismatch
   * against the catalog's pinned hashes, `mismatch` carries the offending
   * file + expected/actual so the UI can surface an actionable
   * "Hugging Face version changed — download anyway?" prompt instead of
   * a raw error message. The user's "anyway" retry passes
   * `?skipSha=1` and bypasses verification for that one install.
   */
  | {
      type: 'error';
      error: string;
      mismatch?: { file: string; expected: string; actual: string };
    };

interface InstalledManifest {
  id: string;
  name: string;
  approxSizeBytes: number;
  installedAt: string;
  catalogId: string;
  catalogVersion: string;
  huggingfaceRepo: string;
  quantization?: string;
  contextWindow?: number;
  architecture?: string;
  chatTemplatePresent: boolean;
  /** File names that were written into the model dir, in install order. */
  files: string[];
  fileSha256?: Record<string, string>;
  /**
   * Hash of the catalog payload description this copy was installed from —
   * repo + every pinned filename and sha256 + any chat-template fallback.
   * Lets a later catalog version be classified as a metadata-only edit or a
   * genuine new build without re-reading a byte of the weights. Absent on
   * installs predating it; the drift check backfills it the first time it
   * proves identity by hash.
   */
  payloadFingerprint?: string;
}

export interface MlxModelManagerOptions {
  home: string;
  catalog: CatalogService;
  /**
   * Fire-and-forget hook invoked when a validated, non-duplicate MLX
   * download is about to start. The service uses it to provision the
   * shared Python/MLX runtime in parallel with the much larger weights
   * download, regardless of which HTTP install surface initiated it.
   */
  onInstallStart?: (info: { catalogId: string }) => void;
  /**
   * Fire-and-forget hook invoked once a model is fully installed and
   * readable on disk. The service uses it to queue the post-install
   * fitness probe (the proeve), mirroring the llama.cpp manager.
   */
  onInstalled?: (info: { engine: 'mlx'; id: string }) => void;
  /** Test seam. */
  fetchImpl?: typeof fetch;
}

const PROGRESS_INTERVAL_MS = 250;

/**
 * How many of a model's files to download at once. MLX models ship as
 * several safetensors shards plus tokenizer/config files; fetching a
 * few concurrently overlaps TLS/connection setup and TCP slow-start
 * across files, cutting wall-clock ~30–40% on multi-shard models vs a
 * strictly-sequential loop. Kept modest so we don't saturate a slow
 * link (which would just make every file progress slower) or trip HF
 * rate-limiting. Single-file models are unaffected.
 */
const MLX_DOWNLOAD_CONCURRENCY = 3;

const log = createLogger('models');

/**
 * Minimal single-consumer async queue bridging the concurrent download
 * workers (which `push` events synchronously) to the `install()` async
 * generator (which `yield`s them) — a generator can't `yield` from
 * inside the worker promises, so events flow through here. Push is
 * unbounded and non-blocking; `close()` ends iteration once buffered
 * items drain. Exactly one consumer (`install`) iterates it.
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

export class MlxModelManager {
  private readonly modelsRoot: string;
  private readonly storageRoots: ModelStorageRoots;
  private readonly catalog: CatalogService;
  private readonly fetchImpl: typeof fetch;
  private readonly onInstallStart?: (info: { catalogId: string }) => void;
  private readonly onInstalled?: (info: { engine: 'mlx'; id: string }) => void;
  /**
   * In-flight installs. See {@link LlamaCppModelManager.activeInstalls}
   * — same rationale, same shape: the first-run bootstrap fires
   * `install()` server-side and the Settings catalog UI needs a
   * polled view of it.
   */
  private readonly activeInstalls = new Map<string, MlxActiveInstallSnapshot>();
  /**
   * Model directories we've already warned about skipping. `listInstalled`
   * runs on every picker/settings poll; a broken directory should be loud
   * exactly once per process, not once per poll.
   */
  private readonly skipWarned = new Set<string>();

  constructor(opts: MlxModelManagerOptions) {
    this.storageRoots = modelStorageRoots({ home: opts.home, engine: 'mlx' });
    this.modelsRoot = this.storageRoots.writableRoot;
    this.catalog = opts.catalog;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    if (opts.onInstallStart) this.onInstallStart = opts.onInstallStart;
    if (opts.onInstalled) this.onInstalled = opts.onInstalled;
  }

  getActiveInstalls(): MlxActiveInstallSnapshot[] {
    return Array.from(this.activeInstalls.values()).map((entry) => ({ ...entry }));
  }

  async listInstalled(): Promise<InstalledMlxModel[]> {
    const entries = await listOverlayModelIds(this.storageRoots);
    const out: InstalledMlxModel[] = [];
    for (const id of entries) {
      const summary = await this.loadInstalled(id);
      if (!summary) {
        this.warnSkip(id, 'no readable manifest.json (incomplete or interrupted download?)');
        continue;
      }
      // Does the catalog now describe different weights than the ones on
      // disk? Best-effort — a catalog miss (third-party / removed entry)
      // leaves it un-flagged.
      const status = await this.evaluateDrift(id, summary).catch(() => null);
      if (status?.updateAvailable) {
        summary.updateAvailable = true;
        if (status.availableVersion) summary.availableVersion = status.availableVersion;
        if (status.reason) summary.updateReason = status.reason;
      }
      out.push(summary);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /**
   * Whether a genuinely newer build of one installed model exists. Null when
   * the id isn't installed for MLX. Shared with the chat manager's
   * per-session staleness notice so a user is never told to re-download for a
   * change that only touched metadata.
   */
  async getUpdateStatus(id: string): Promise<ModelUpdateStatus | null> {
    const summary = await this.loadInstalled(id);
    if (!summary) return null;
    return this.evaluateDrift(id, summary).catch(() => ({ updateAvailable: false }));
  }

  /**
   * Compare one installed copy against the live catalog. The catalog lookup
   * runs for every model on every inventory poll; the manifest re-read only
   * happens for the few whose version actually moved.
   */
  private async evaluateDrift(id: string, summary: InstalledMlxModel): Promise<ModelUpdateStatus> {
    if (!summary.catalogVersion) return { updateAvailable: false };
    const detail = await this.catalog.get('chat-model', id).catch(() => null);
    if (!detail || detail.manifest.kind !== 'chat-model') return { updateAvailable: false };
    if (detail.manifest.version === summary.catalogVersion) return { updateAvailable: false };

    const parsed = await readFile(join(summary.modelDir, 'manifest.json'), 'utf8')
      .then((raw) => JSON.parse(raw) as Partial<InstalledManifest>)
      .catch(() => null);
    if (!parsed) return { updateAvailable: false };

    return evaluateCatalogDrift({
      engine: 'mlx',
      id,
      modelDir: summary.modelDir,
      manifest: detail.manifest,
      installedVersion: summary.catalogVersion,
      installed: {
        ...(parsed.huggingfaceRepo ? { huggingfaceRepo: parsed.huggingfaceRepo } : {}),
        ...(parsed.payloadFingerprint ? { payloadFingerprint: parsed.payloadFingerprint } : {}),
        ...(parsed.fileSha256 ? { fileSha256: parsed.fileSha256 } : {}),
      },
      healable: !summary.readOnly && !this.activeInstalls.has(id),
    });
  }

  /**
   * List incomplete MLX downloads — directories that hold bytes but no
   * `manifest.json`, so they never surface in {@link listInstalled}. Tagged
   * `resumable` when the id still resolves to an MLX-capable catalog entry.
   * In-flight installs are excluded. See {@link LlamaCppModelManager.listIncomplete}.
   */
  async listIncomplete(): Promise<IncompleteModelDownloadInfo[]> {
    const activeIds = new Set(this.activeInstalls.keys());
    const rows = await listIncompleteModelDownloads({ writableRoot: this.modelsRoot, activeIds });
    const out: IncompleteModelDownloadInfo[] = [];
    for (const row of rows) {
      let resumable = false;
      let name: string | undefined;
      if (isSafeId(row.id)) {
        const detail = await this.catalog.get('chat-model', row.id).catch(() => null);
        if (
          detail &&
          detail.manifest.kind === 'chat-model' &&
          detail.manifest.mlx &&
          !detail.manifest.mlx.disabledReason
        ) {
          resumable = true;
          name = detail.manifest.name;
        }
      }
      out.push({ ...row, resumable, ...(name ? { name } : {}) });
    }
    return out;
  }

  /** Management-only inventory for MLX directories whose manifest exists
   * but no longer matches the current installed-manifest contract. */
  async listUnrecognized(): Promise<UnrecognizedModelInfo[]> {
    const rows: UnrecognizedModelInfo[] = [];
    for (const id of await listOverlayModelIds(this.storageRoots)) {
      if (!isSafeId(id)) continue;
      const root = await findModelRoot(this.storageRoots, id);
      if (!root) continue;
      if (await this.loadInstalled(id)) continue;

      const profile = await inspectModelDirectory(join(root, id));
      if (!profile || profile.bytes === 0) continue;
      const raw = await readFile(join(root, id, 'manifest.json'), 'utf8').catch(() => null);
      let legacyName: string | undefined;
      let reason = "Gezel couldn't read this model's metadata.";
      if (raw !== null) {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (typeof parsed.name === 'string' && parsed.name.trim()) legacyName = parsed.name;
          reason = 'This model metadata is incomplete or does not match the current format.';
        } catch {
          reason = "This model's metadata file is not valid JSON.";
        }
      }

      const detail = await this.catalog.get('chat-model', id).catch(() => null);
      const catalogManifest = detail?.manifest.kind === 'chat-model' ? detail.manifest : undefined;
      const canUpdate = Boolean(catalogManifest?.mlx && !catalogManifest.mlx.disabledReason);
      const name = catalogManifest?.name ?? legacyName;
      rows.push({
        id,
        ...(name ? { name } : {}),
        bytes: profile.bytes,
        updatedAt: profile.updatedAt,
        reason,
        canUpdate,
        ...(resolvePath(root) !== resolvePath(this.storageRoots.writableRoot)
          ? { readOnly: true }
          : {}),
      });
    }
    rows.sort((a, b) => b.bytes - a.bytes);
    return rows;
  }

  async resolveDefaultModel(): Promise<InstalledMlxModel | null> {
    const models = await this.listInstalled();
    return models[0] ?? null;
  }

  async resolveDefaultModelPath(): Promise<string | null> {
    const model = await this.resolveDefaultModel();
    return model?.modelDir ?? null;
  }

  async resolveModel(id: string): Promise<InstalledMlxModel | null> {
    return this.loadInstalled(id);
  }

  async resolveModelPath(id: string): Promise<string | null> {
    const summary = await this.loadInstalled(id);
    return summary?.modelDir ?? null;
  }

  async delete(id: string): Promise<void> {
    if (!isSafeId(id)) throw new Error(`refusing to delete with unsafe id: ${id}`);
    if (await modelExistsOnlyReadOnly(this.storageRoots, id)) {
      throw readOnlyModelError(id);
    }
    await removeModelDir(join(this.modelsRoot, id));
  }

  /** Provider-owned snapshot used by the streaming `.gezmodel` exporter. */
  async getModelBundleSource(id: string): Promise<ModelBundleSource> {
    if (!isSafeId(id)) throw new Error(`unsafe model id: ${id}`);
    const summary = await this.loadInstalled(id);
    if (!summary) throw new Error(`model "${id}" is not available locally for mlx`);
    const root = await findModelRoot(this.storageRoots, id);
    if (!root) throw new Error(`model "${id}" is not available locally for mlx`);
    const modelDir = join(root, id);
    const installedManifest = JSON.parse(
      await readFile(join(modelDir, 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    return {
      id,
      name: summary.name,
      modelDir,
      installedManifest,
      modelFiles: await listBundleModelFiles(modelDir),
      ...(summary.catalogVersion ? { catalogVersion: summary.catalogVersion } : {}),
    };
  }

  /** Publish a fully-scanned MLX model directory into the provider store. */
  async importModelBundle(opts: {
    id: string;
    stagedModelDir: string;
    installedManifest: Record<string, unknown>;
    replace: boolean;
  }): Promise<void> {
    if (!isSafeId(opts.id)) throw new Error(`unsafe model id: ${opts.id}`);
    const parsed = opts.installedManifest as Partial<InstalledManifest>;
    if (parsed.id !== opts.id || !parsed.name || !parsed.installedAt) {
      throw new Error('installed manifest does not describe the bundled model');
    }
    const files = await listBundleModelFiles(opts.stagedModelDir);
    if (!files.some((file) => file.toLowerCase().endsWith('.safetensors'))) {
      throw new Error('MLX bundle has no safetensors weights');
    }
    if (!files.includes('config.json')) throw new Error('MLX bundle has no config.json');

    const summary = await readMlxSummary(opts.stagedModelDir);
    const installed: InstalledManifest = {
      ...parsed,
      id: opts.id,
      name: parsed.name,
      approxSizeBytes: parsed.approxSizeBytes ?? 0,
      installedAt: parsed.installedAt,
      catalogId: parsed.catalogId ?? opts.id,
      catalogVersion: parsed.catalogVersion ?? '0.0.0',
      huggingfaceRepo: parsed.huggingfaceRepo ?? 'imported/gezmodel',
      contextWindow: summary.contextWindow ?? parsed.contextWindow,
      architecture: summary.architecture ?? parsed.architecture,
      chatTemplatePresent: summary.chatTemplatePresent,
      files,
      fileSha256: await hashModelPayloadFiles(opts.stagedModelDir),
    };
    await writeFile(
      join(opts.stagedModelDir, 'manifest.json'),
      `${JSON.stringify(installed, null, 2)}\n`,
      'utf8',
    );
    await publishStagedModel({
      modelsRoot: this.modelsRoot,
      id: opts.id,
      stagedModelDir: opts.stagedModelDir,
      replace: opts.replace,
    });
    await makeSharedModelReadable(join(this.modelsRoot, opts.id));
    try {
      this.onInstalled?.({ engine: 'mlx', id: opts.id });
    } catch {
      // A post-install fitness hook is best-effort, as in the download path.
    }
  }

  /**
   * Install from the catalog. Yields progress events per file; emits
   * exactly one terminal event. Existing models at `id` are atomically
   * replaced — files download to `.partial` siblings and rename only
   * after sha256 verification, same as llama-cpp.
   */
  async *install(
    catalogId: string,
    options?: { skipSha?: boolean },
  ): AsyncIterable<MlxInstallEvent> {
    const skipSha = options?.skipSha === true;
    if (!isSafeId(catalogId)) {
      yield { type: 'error', error: `unsafe catalog id: ${catalogId}` };
      return;
    }
    // Reject duplicate concurrent installs — see the matching branch
    // on `LlamaCppModelManager.install`. MLX is even more sensitive
    // to this because each install writes multiple `.partial` files
    // in the same directory. Claim the slot synchronously before any
    // `await` so a parallel caller can't pass `has() === false` in
    // the same JS turn.
    if (this.activeInstalls.has(catalogId)) {
      yield {
        type: 'error',
        error: `install for "${catalogId}" is already in progress`,
      };
      return;
    }
    const tracked: MlxActiveInstallSnapshot = {
      catalogId,
      bytesWritten: 0,
      totalBytes: 0,
      phase: 'downloading',
      startedAt: new Date().toISOString(),
    };
    this.activeInstalls.set(catalogId, tracked);
    try {
      const detail = await this.catalog.get('chat-model', catalogId);
      if (!detail || detail.manifest.kind !== 'chat-model') {
        yield { type: 'error', error: `chat-model "${catalogId}" not in catalog` };
        return;
      }
      const manifest = detail.manifest;
      if (!manifest.mlx || manifest.mlx.disabledReason) {
        yield {
          type: 'error',
          error: manifest.mlx?.disabledReason
            ? `chat-model "${catalogId}" is not available on MLX: ${manifest.mlx.disabledReason} Run it via llama instead.`
            : `chat-model "${catalogId}" has no mlx source — not available for MLX`,
        };
        return;
      }
      const src = manifest.mlx;
      // Start provisioning the MLX Python environment at the same time
      // as the weights download. This belongs at the model-manager
      // boundary (rather than one particular HTTP route) so installs
      // from Settings, first-run bootstrap, and /v1/models/ensure all
      // receive the same overlap. Never let host setup abort a model
      // download; the lazy first-chat path remains authoritative.
      try {
        this.onInstallStart?.({ catalogId });
      } catch {
        /* host owns setup errors */
      }
      const itemDir = join(this.modelsRoot, catalogId);
      await mkdir(itemDir, { recursive: true });

      const files = src.files.filter((f): f is NonNullable<typeof f> => f != null);
      const fileCount = files.length;
      const totalBytesAll = files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
      tracked.totalBytes = totalBytesAll;
      tracked.phase = 'downloading';

      // Files this update doesn't have to fetch because the copy on disk is
      // already the copy the catalog pins. MLX repos are many files and a
      // rebuild usually rotates the weight shards while config.json,
      // tokenizer.json and friends stay byte-identical.
      const reusable = await this.planReusableFiles(itemDir, files);
      const verifiedDigests: Record<string, string> = {};
      for (const [name, sha] of reusable) verifiedDigests[name] = sha;
      const toFetch = files.filter((file) => !reusable.has(file.name));
      if (reusable.size > 0) {
        log.info(
          `[models] [mlx] "${catalogId}": ${reusable.size} of ${files.length} file(s) already match the catalog and will not be downloaded`,
        );
      }

      // Preflight free space before writing anything — see the matching check
      // in `LlamaCppModelManager`. MLX installs write every shard into one
      // directory, so a late ENOSPC strands the whole set. Only what we
      // actually have to fetch is charged, less any `.partial` resume credit;
      // a file being replaced is charged in full because its `.partial` lives
      // beside the old copy until publish.
      const needBytes =
        toFetch.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0) -
        (await mlxPartialBytesOnDisk(itemDir, toFetch));
      const space = await checkDiskSpace(itemDir, Math.max(0, needBytes));
      if (!space.ok) {
        yield { type: 'error', error: describeDiskShortfall(space, manifest.name) };
        return;
      }

      // Download the shards concurrently (bounded by
      // MLX_DOWNLOAD_CONCURRENCY). Per-file resume (`.partial`), sha256
      // verification, and the atomic commit-rename below are unchanged —
      // only the scheduling differs. Each worker writes its bytes into
      // `perFileBytes[index]`; cumulative `bytesWrittenAll` is the live
      // sum across all files (it stays monotonic enough to drive the one
      // model-level progress bar even though files finish out of order).
      // Workers push events into the queue; this generator drains it.
      const perFileBytes = new Array<number>(files.length).fill(0);
      // Reused files are complete before the pool starts, so the one
      // model-level bar opens at the bytes already present instead of
      // pretending to re-download them.
      files.forEach((file, index) => {
        if (reusable.has(file.name)) perFileBytes[index] = file.sizeBytes ?? 0;
      });
      tracked.bytesWritten = perFileBytes.reduce((sum, bytes) => sum + bytes, 0);
      const queue = new AsyncEventQueue<MlxInstallEvent>();
      const ac = new AbortController();
      const push = (ev: MlxInstallEvent): void => queue.push(ev);

      let cursor = 0;
      const runWorker = async (): Promise<'ok' | 'error'> => {
        let outcome: 'ok' | 'error' = 'ok';
        while (!ac.signal.aborted) {
          const index = cursor;
          cursor += 1;
          if (index >= files.length) break;
          const file = files[index];
          if (!file) break;
          if (reusable.has(file.name)) continue;
          const fileResult = await this.downloadFileConcurrent(
            itemDir,
            src.huggingfaceRepo,
            src.revision,
            file,
            index,
            fileCount,
            perFileBytes,
            totalBytesAll,
            tracked,
            skipSha,
            push,
            ac,
            verifiedDigests,
          );
          if (fileResult === 'error') {
            // Cancel the in-flight siblings; the error event is already
            // queued. Other workers see the abort and unwind as 'aborted'
            // without emitting a second terminal event.
            outcome = 'error';
            ac.abort();
            break;
          }
          if (fileResult === 'aborted') break;
        }
        return outcome;
      };

      const poolSize = Math.min(MLX_DOWNLOAD_CONCURRENCY, Math.max(files.length, 1));
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
      // A worker that threw (rather than returning 'error') still has to
      // produce a terminal event, or a subscriber would hang on a job
      // that silently stopped emitting.
      const threw = results.find((r) => r.status === 'rejected') as
        | PromiseRejectedResult
        | undefined;
      if (threw && !sawError) {
        const reason = threw.reason;
        yield {
          type: 'error',
          error: `MLX download failed: ${reason instanceof Error ? reason.message : String(reason)}`,
        };
        return;
      }
      const workerErrored = results.some((r) => r.status === 'fulfilled' && r.value === 'error');
      if (sawError || workerErrored) return;

      // Commit phase first: metadata extraction needs the real filenames
      // (readMlxSummary reads `tokenizer_config.json`, not `.partial`).
      // If any rename fails we bail — half-renamed state is a mess.
      for (const file of files) {
        if (reusable.has(file.name)) continue;
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

      // Drop files a previous install of this id left behind that the new file
      // set no longer references (e.g. shards from a different quant). Keeps the
      // slot from accumulating orphaned multi-GB weights.
      const pruned = await pruneModelPayloadFiles(itemDir, new Set(files.map((f) => f.name)));
      if (pruned.length > 0) {
        log.info(
          `[models] [mlx] pruned ${pruned.length} stale file(s) from "${catalogId}": ${pruned.join(', ')}`,
        );
      }

      tracked.phase = 'extracting-metadata';
      yield { type: 'extracting-metadata' };
      let summary: Awaited<ReturnType<typeof readMlxSummary>>;
      try {
        summary = await readMlxSummary(itemDir);
      } catch (err) {
        await rm(itemDir, { recursive: true, force: true });
        yield {
          type: 'error',
          error: `MLX metadata parse failed (install aborted): ${describeError(err)}`,
        };
        return;
      }

      // If the upstream tokenizer_config didn't ship a chat template,
      // try to recover one before we accept the "replies may be
      // incoherent" hazard:
      //
      //   1. `chat_template.jinja` sidecar — Unsloth and some other
      //      repackers ship the template as a separate file, which
      //      mlx_lm.server doesn't automatically read. Merge it in.
      //   2. `chatTemplate` pinned on the catalog entry — last-resort
      //      safety net for curated entries where we know the right
      //      template but upstream doesn't carry it in any form.
      //
      // The tokenizer_config.json sha256 was verified at download time;
      // rewriting after verification is expected (we're the ones who
      // want the file to match the model we're actually going to run).
      let chatTemplatePresent = summary.chatTemplatePresent;
      let templateSource: 'upstream' | 'sidecar' | 'catalog' | null = chatTemplatePresent
        ? 'upstream'
        : null;
      const tokenizerConfigPath = join(itemDir, 'tokenizer_config.json');

      if (!chatTemplatePresent) {
        // mlx_vlm reads `chat_template.jinja` natively (per-architecture
        // processors call `load_chat_template(tokenizer, model_path)`),
        // so when the sidecar exists the engine already has what it
        // needs. We just record the fact for the manifest and skip
        // rewriting tokenizer_config.json — that mutation moved files
        // away from their pinned sha256 for no engine-side benefit.
        try {
          const sidecar = await readFile(join(itemDir, 'chat_template.jinja'), 'utf8');
          if (sidecar.trim().length > 0) {
            chatTemplatePresent = true;
            templateSource = 'sidecar';
          }
        } catch {
          // No sidecar file — fall through to the catalog pin.
        }
      }

      if (!chatTemplatePresent && src.chatTemplate) {
        try {
          await injectChatTemplate(tokenizerConfigPath, src.chatTemplate);
          // The file no longer hashes to what the download verified, so its
          // digest has to be re-read from disk rather than carried forward.
          delete verifiedDigests['tokenizer_config.json'];
          chatTemplatePresent = true;
          templateSource = 'catalog';
        } catch (err) {
          // Non-fatal: model still works, just with the generic fallback
          // and the usual warning. Swallow and continue.
          void err;
        }
      }

      const catalogPayload = describeCatalogPayload(manifest, 'mlx');
      const installed: InstalledManifest = {
        id: catalogId,
        name: manifest.name,
        approxSizeBytes: src.approxSizeBytes,
        installedAt: new Date().toISOString(),
        catalogId,
        catalogVersion: manifest.version,
        huggingfaceRepo: src.huggingfaceRepo,
        ...(src.quantization ? { quantization: src.quantization } : {}),
        ...(summary.contextWindow
          ? { contextWindow: summary.contextWindow }
          : manifest.contextWindow
            ? { contextWindow: manifest.contextWindow }
            : {}),
        ...(summary.architecture ? { architecture: summary.architecture } : {}),
        chatTemplatePresent,
        files: files.map((f) => f.name),
        // Snapshot what the catalog said this payload IS, so a later version
        // bump that only edits metadata can be recognized as such without
        // re-reading a byte. Skipped for a skipSha install: those bytes are
        // knowingly not the ones the catalog describes.
        ...(!skipSha && catalogPayload
          ? { payloadFingerprint: catalogPayloadFingerprint(catalogPayload) }
          : {}),
      };
      // Every file that was downloaded (or reused) has a verified digest
      // already; hashing the whole payload back off disk would re-read tens of
      // gigabytes to learn what we just measured.
      installed.fileSha256 = await hashModelPayloadFiles(itemDir, verifiedDigests);
      await writeFile(join(itemDir, 'manifest.json'), JSON.stringify(installed, null, 2), 'utf8');
      await makeSharedModelReadable(itemDir);

      // The sidecar case is the modern norm (Gemma 4, etc.) and mlx_vlm
      // reads it natively — nothing actionable to surface, so no warning.
      // The catalog-pin and no-template-anywhere cases are rarer and
      // worth flagging because they say something about the install:
      // either the catalog entry is patching around an upstream gap, or
      // the engine is about to fall back to a generic template that
      // probably won't match the model.
      const warning = chatTemplatePresent
        ? templateSource === 'catalog'
          ? 'Upstream tokenizer_config had no chat_template — injected the known-good template pinned in the catalog entry.'
          : undefined
        : 'Model has no embedded chat template (tokenizer_config.json missing chat_template and no sidecar). mlx_vlm.server will fall back to a generic template that may not match this model — replies may be incoherent.';
      try {
        this.onInstalled?.({ engine: 'mlx', id: catalogId });
      } catch {
        // Fire-and-forget: a hook failure must never fail a completed install.
      }
      yield { type: 'done', id: catalogId, ...(warning ? { warning } : {}) };
    } finally {
      this.activeInstalls.delete(catalogId);
    }
  }

  /**
   * Download + verify one file, pushing progress/retrying/verifying/
   * error events through `push` rather than yielding (so it can run
   * concurrently with sibling files inside `install`'s worker pool).
   *
   * Returns:
   *   - `'ok'`     — downloaded and sha256-verified (or skipSha bypass).
   *   - `'error'`  — download or verify failed; a terminal `error` event
   *                  has already been pushed.
   *   - `'aborted'`— the shared AbortController fired (a sibling file
   *                  failed); no terminal event pushed, the failing
   *                  worker owns the error.
   */
  private async downloadFileConcurrent(
    itemDir: string,
    repo: string,
    revision: string | undefined,
    file: { name: string; sha256: string; sizeBytes: number },
    index: number,
    total: number,
    perFileBytes: number[],
    totalBytesAll: number,
    tracked: MlxActiveInstallSnapshot,
    skipSha: boolean,
    push: (ev: MlxInstallEvent) => void,
    ac: AbortController,
    /** Digest sink, so the post-install manifest doesn't re-hash from disk. */
    verifiedDigests: Record<string, string>,
  ): Promise<'ok' | 'error' | 'aborted'> {
    const finalPath = join(itemDir, file.name);
    const tmpPath = `${finalPath}.partial`;
    // Pin to the catalog's revision (commit SHA) when present so we get
    // the exact bytes the sha256 was computed against; fall back to
    // `main` for legacy manifests that predate revision pinning.
    const ref = revision ?? 'main';
    const url = `https://huggingface.co/${repo}/resolve/${encodeURIComponent(ref)}/${encodeURIComponent(file.name)}?download=true`;

    // Live sum across every file's bytes-so-far. Files complete out of
    // order under concurrency, so we can't use a "bytes of prior files"
    // baseline — recompute the running total from the shared array.
    const sumAll = (): number => {
      let sum = 0;
      for (const b of perFileBytes) sum += b;
      return sum;
    };

    // Delegate network plumbing (resume, retry, chunk-stall timeout,
    // friendly errors) to the shared helper. Passing the shared signal
    // lets a sibling's failure cancel this in-flight transfer promptly.
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
        if (step.value.kind === 'aborted') {
          // Cancelled because a sibling failed — leave the `.partial` for
          // a resumed run and let the failing worker own the error event.
          return 'aborted';
        }
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
        const bytesWrittenAll = sumAll();
        tracked.bytesWritten = bytesWrittenAll;
        push({
          type: 'progress',
          fileIndex: index,
          fileCount: total,
          file: file.name,
          bytesWritten: ev.bytesWritten,
          totalBytes,
          bytesWrittenAll,
          totalBytesAll,
        });
      } else if (ev.type === 'retrying') {
        push({
          type: 'retrying',
          attempt: ev.attempt,
          maxAttempts: ev.maxAttempts,
          delayMs: ev.delayMs,
          reason: ev.reason,
          file: file.name,
        });
      }
    }

    push({ type: 'verifying', file: file.name });

    // sha256 verify by streaming the .partial through a fresh hasher.
    // Correct across resumed downloads (a chunk-time hasher would
    // miss the resumed prefix).
    const hasher = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      // Big read buffer so the hash doesn't starve inside the busy daemon
      // event loop. See MODEL_HASH_READ_BUFFER_BYTES.
      const stream = createReadStream(tmpPath, { highWaterMark: MODEL_HASH_READ_BUFFER_BYTES });
      stream.on('data', (chunk) => hasher.update(chunk));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
    const actual = hasher.digest('hex');
    verifiedDigests[file.name] = actual;
    if (actual !== file.sha256.toLowerCase()) {
      if (skipSha) {
        // User explicitly asked to bypass after seeing a prior mismatch.
        // Keep the `.partial` so the caller's commit-rename step still
        // works; just stop pretending the catalog sha is authoritative.
        return 'ok';
      }
      await rm(tmpPath, { force: true });
      push({
        type: 'error',
        error: `The file '${file.name}' on Hugging Face has changed since this version of Gezel was published. Expected sha256 ${file.sha256}, got ${actual}.`,
        mismatch: { file: file.name, expected: file.sha256, actual },
      });
      return 'error';
    }
    return 'ok';
  }

  /**
   * Files the plan asks for that are already on disk as exactly the bytes the
   * catalog pins, keyed by filename with the digest to carry forward. See
   * {@link LlamaCppModelManager.planReusableFiles} — same trust model: a
   * digest this install recorded after verifying it, plus a file still at its
   * pinned length, is identity.
   */
  private async planReusableFiles(
    itemDir: string,
    files: Array<{ name: string; sha256: string; sizeBytes?: number }>,
  ): Promise<Map<string, string>> {
    const reusable = new Map<string, string>();
    const parsed = await readFile(join(itemDir, 'manifest.json'), 'utf8')
      .then((raw) => JSON.parse(raw) as Partial<InstalledManifest>)
      .catch(() => null);
    const recorded = parsed?.fileSha256;
    if (!recorded) return reusable;
    for (const file of files) {
      if (file.sizeBytes === undefined) continue;
      const sha = recorded[file.name]?.toLowerCase();
      if (!sha || sha !== file.sha256.toLowerCase()) continue;
      const size = await stat(join(itemDir, file.name))
        .then((info) => (info.isFile() ? info.size : -1))
        .catch(() => -1);
      if (size !== file.sizeBytes) continue;
      reusable.set(file.name, sha);
    }
    return reusable;
  }

  /** Warn once per model directory per process, then stay quiet. */
  private warnSkip(id: string, reason: string): void {
    if (this.skipWarned.has(id)) return;
    this.skipWarned.add(id);
    log.warn(`[mlx] model directory "${id}" is not runnable: ${reason}`);
  }

  private async loadInstalled(id: string): Promise<InstalledMlxModel | null> {
    const root = await findModelRoot(this.storageRoots, id);
    if (!root) return null;
    const metaPath = join(root, id, 'manifest.json');
    let raw: string;
    try {
      raw = await readFile(metaPath, 'utf8');
    } catch {
      this.warnSkip(id, `manifest.json is unreadable at ${metaPath}`);
      return null;
    }
    let parsed: Partial<InstalledManifest>;
    try {
      parsed = JSON.parse(raw) as Partial<InstalledManifest>;
    } catch {
      this.warnSkip(id, `manifest.json is not valid JSON at ${metaPath}`);
      return null;
    }
    if (!parsed.id || !parsed.name || !parsed.installedAt || !Array.isArray(parsed.files)) {
      this.warnSkip(id, 'manifest.json is missing required fields (id/name/installedAt/files)');
      return null;
    }
    if (
      !(await verifyReadOnlyModelPayload(this.storageRoots, root, id, parsed.fileSha256, (reason) =>
        this.warnSkip(id, reason),
      ))
    ) {
      return null;
    }
    return {
      id: parsed.id,
      name: parsed.name,
      approxSizeBytes: parsed.approxSizeBytes ?? 0,
      installedAt: parsed.installedAt,
      modelDir: join(root, id),
      ...(parsed.contextWindow ? { contextWindow: parsed.contextWindow } : {}),
      ...(parsed.quantization ? { quantization: parsed.quantization } : {}),
      chatTemplatePresent: parsed.chatTemplatePresent ?? true,
      ...(parsed.architecture ? { architecture: parsed.architecture } : {}),
      ...(parsed.catalogVersion ? { catalogVersion: parsed.catalogVersion } : {}),
      // Read-only when it resolves from a machine/shared overlay rather than
      // this daemon's writable root — delete refuses these; the UI shows them
      // as machine-provided instead of offering a Delete that only 400s.
      ...(resolvePath(root) !== resolvePath(this.storageRoots.writableRoot)
        ? { readOnly: true }
        : {}),
    };
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Resume credit: bytes of a still-to-fetch file that a `.partial` already
 * holds. Deliberately blind to finished files — a previous install's copy of
 * the same name is not credit, because the new bytes stream into a `.partial`
 * beside it and the old copy only goes away at publish. See the llama.cpp
 * sibling for the ENOSPC this used to hide.
 */
async function mlxPartialBytesOnDisk(
  itemDir: string,
  files: Array<{ name: string; sizeBytes?: number }>,
): Promise<number> {
  let total = 0;
  for (const file of files) {
    const size = await stat(`${join(itemDir, file.name)}.partial`)
      .then((st) => st.size)
      .catch(() => 0);
    if (size > 0) total += file.sizeBytes ? Math.min(size, file.sizeBytes) : size;
  }
  return total;
}

/**
 * Merge a Jinja `chat_template` into an existing `tokenizer_config.json`
 * (or create a minimal one if the file is missing / unreadable).
 * Overwrites only the `chat_template` field — every other key is
 * preserved so mlx_lm.server still sees the original tokenizer config.
 */
async function injectChatTemplate(tokenizerConfigPath: string, template: string): Promise<void> {
  let current: Record<string, unknown> = {};
  try {
    const raw = await readFile(tokenizerConfigPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      current = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or unreadable — fall through and write a minimal file.
  }
  current.chat_template = template;
  await writeFile(tokenizerConfigPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
}

function isSafeId(id: string): boolean {
  if (id.length === 0 || id.length > 64) return false;
  if (id.includes('/') || id.includes('\\') || id.startsWith('.')) return false;
  return /^[a-z0-9][a-z0-9.\-:]{0,63}$/i.test(id);
}

interface ReadableStreamLike<T> {
  getReader(): {
    read(): Promise<{ value: T | undefined; done: boolean }>;
  };
}
