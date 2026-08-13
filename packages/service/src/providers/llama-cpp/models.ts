/**
 * Local llama.cpp model storage + install pipeline.
 *
 * Storage layout:
 *
 *   <home>/engines/llama-cpp/
 *   └── models/
 *       └── <model-id>/
 *           ├── manifest.json   (snapshot of catalog metadata + install info)
 *           └── <weights>.gguf  (the actual weights, original filename preserved)
 *
 * Install flow:
 *   1. Look up the chat-model entry in the catalog.
 *   2. Stream the GGUF from
 *      `huggingface.co/<repo>/resolve/<revision>/<filename>` (the pinned
 *      commit SHA, or `main` for legacy manifests) to a `.partial`
 *      file, hashing as we go.
 *   3. Verify the computed sha256 against the manifest's expected value.
 *   4. Run the GGUF header parser to extract context window + chat-template
 *      presence. Surface a non-fatal warning when `tokenizer.chat_template`
 *      is missing — llama-server otherwise silently uses the wrong
 *      template (the gemma4 footgun the Phase-0 spike caught).
 *   5. Atomically rename `.partial` → final filename and write
 *      `manifest.json`.
 *
 * Delete flow:
 *   - Remove the per-model directory in one shot.
 *
 * Resolve-current flow:
 *   - Pick the first installed model (alphabetical) when ChatManager
 *     wants a default model path. Phase 2 keeps "current" implicit; a
 *     proper picker lives in the UI.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import {
  type ModelBundleSource,
  listBundleModelFiles,
  publishStagedModel,
  safeBundleModelPath,
} from '../../models/bundle-storage.js';
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
import { readGgufSummary } from './gguf-metadata.js';

export type { IncompleteModelDownloadInfo } from '../../models/storage-roots.js';

export interface InstalledLlamaCppModel {
  id: string;
  name: string;
  approxSizeBytes: number;
  installedAt: string;
  /** Absolute path to the weights file the supervisor passes to `llama-server --model`. */
  weightsPath: string;
  /**
   * Absolute path to the multimodal projector file, when the catalog
   * entry shipped an mmproj sidecar. The supervisor appends
   * `--mmproj <path>` when set — that's what enables image / audio /
   * video inputs on llama-server. Absent → text-only model.
   */
  mmprojPath?: string;
  /**
   * Absolute path to a speculative-decoding companion GGUF, when the
   * catalog ships one. The launcher forwards it as
   * `--spec-draft-model <path>` for the selected draft algorithm.
   */
  draftModelPath?: string;
  /** From the GGUF metadata — useful for the supervisor's `-c` flag (Phase 3). */
  contextWindow?: number;
  /** Quantization tag (Q4_K_M / Q8_0 / …) lifted from the catalog source block. */
  quantization?: string;
  /** Empty when `tokenizer.chat_template` is missing — surfaced in the UI as a warning. */
  chatTemplatePresent: boolean;
  /** Complete payload hashes used when adopting a read-only machine model. */
  fileSha256?: Record<string, string>;
  /**
   * The architecture string from the GGUF metadata (qwen2 / llama / gemma3 / …).
   * Lets the UI surface a hint when a model claims a family llama.cpp doesn't
   * recognize natively.
   */
  architecture?: string;
  /**
   * Catalog version this model was DOWNLOADED against (snapshotted into the
   * local install manifest). Compared to the catalog's current version to
   * detect drift — stale weights running under newer catalog settings
   * (tuning/behaviors), the failure mode that shipped garbled gemma4-12b
   * output.
   */
  catalogVersion?: string;
  /** sha256 of the weights recorded at install (first shard for sharded installs). */
  sha256?: string;
  /**
   * True when this model resolves from a read-only overlay (the machine/shared
   * asset store) rather than this daemon's writable root. `delete` refuses
   * these, so the UI shows them as machine-provided instead of offering a
   * Delete action that can only fail.
   */
  readOnly?: boolean;
  /**
   * True when the catalog now ships a different version than the one this
   * model was downloaded against — a newer build is available. Lets the
   * model manager offer "Update" (re-download + replace in place) instead
   * of forcing the user to delete and re-fetch. Computed in
   * {@link LlamaCppModelManager.listInstalled} against the live catalog.
   */
  updateAvailable?: boolean;
  /** The catalog's current version, when it differs from the installed one. */
  availableVersion?: string;
}

export type InstallEvent =
  | { type: 'progress'; bytesWritten: number; totalBytes: number }
  /**
   * Surfaced when the shared `downloadWithRetry` helper hit a transient
   * network error and is about to try again. The UI renders
   * "Connection dropped — retrying in 4s (attempt 3/5)…" instead of a
   * fatal error banner. `reason` is already a user-friendly sentence.
   */
  | {
      type: 'retrying';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: string;
    }
  | { type: 'verifying' }
  | { type: 'extracting-metadata' }
  /**
   * A second model being pulled alongside the requested one — today only the
   * image reader, fetched automatically when the chat model can't see images.
   *
   * Its own event arm rather than folding the bytes into `progress`, because
   * the user is entitled to know a further 3 GB is being downloaded and what
   * for. `done` is withheld until this finishes, so the UI's terminal handler
   * doesn't close the stream halfway through.
   */
  | {
      type: 'companion';
      kind: 'image-recognition';
      id: string;
      name: string;
      bytesWritten: number;
      totalBytes: number;
      /** Set when the companion pull failed. The primary install still stands. */
      error?: string;
    }
  /** Final success event. `warning` is set when the GGUF lacks a chat_template. */
  | { type: 'done'; id: string; warning?: string }
  /**
   * Terminal failure. When the failure is a sha256 mismatch against the
   * catalog's pinned hashes, `mismatch` carries the offending file +
   * expected/actual so the UI can offer a "Hugging Face version changed —
   * download anyway?" prompt instead of a raw error. The user's "anyway"
   * retry passes `?skipSha=1` and bypasses verification for that one
   * install.
   */
  | {
      type: 'error';
      error: string;
      mismatch?: { file: string; expected: string; actual: string };
    };

/**
 * Snapshot of an in-flight install. Two different code paths drive
 * the same `install()` generator — the user clicking "Install" in
 * Settings (consumes events via the SSE route), and the first-run
 * bootstrap that fires the install in the background. The Home
 * banner can see what's happening in the bootstrap path, but the
 * Settings catalog view (where the user looks for download
 * progress) wouldn't, until we exposed a polled "what's currently
 * being installed" snapshot. {@link LlamaCppModelManager.getActiveInstalls}
 * is that snapshot.
 */
export interface ActiveInstallSnapshot {
  catalogId: string;
  bytesWritten: number;
  totalBytes: number;
  phase: 'downloading' | 'verifying' | 'extracting-metadata';
  startedAt: string;
}

interface InstalledManifest {
  id: string;
  name: string;
  approxSizeBytes: number;
  /**
   * For single-file installs, the GGUF filename. For sharded installs,
   * the first shard's filename — that's what llama-server expects via
   * `--model`, and it auto-discovers the rest by the `-NNNNN-of-NNNNN`
   * suffix.
   */
  weightsFilename: string;
  /**
   * For single-file installs, the sha256 of the GGUF. For sharded
   * installs, the sha256 of the first shard. Verified individually
   * during install; this top-level field is kept for the surfacing
   * UI / debug output.
   */
  sha256: string;
  /**
   * Per-shard install record. Present (and length ≥ 2) for sharded
   * installs; omitted for single-file installs to keep historical
   * manifests parseable. Order matches the catalog's `shards[]`.
   */
  shards?: Array<{ filename: string; sha256: string; sizeBytes: number }>;
  /**
   * Multimodal projector filename, when the catalog source set
   * `mmproj`. Stored as a sibling of the weights; the supervisor
   * resolves it to an absolute path and passes `--mmproj` on launch.
   */
  mmprojFilename?: string;
  /**
   * Speculative-decoding companion filename, when the catalog source set
   * `draftModel`. Stored beside the weights and resolved by the launcher.
   */
  draftModelFilename?: string;
  installedAt: string;
  catalogId: string;
  catalogVersion: string;
  huggingfaceRepo: string;
  quantization?: string;
  contextWindow?: number;
  architecture?: string;
  chatTemplatePresent: boolean;
  /** Complete payload hashes used when adopting a read-only machine model. */
  fileSha256?: Record<string, string>;
}

interface DownloadPlanEntry {
  /** Path within the repo (may include a subdirectory). */
  repoPath: string;
  /** Destination filename on disk (basename only — subdirs flattened). */
  destFilename: string;
  /** Expected SHA-256 (lower-case hex). */
  sha256: string;
  /** Reported size from the catalog (for progress totals). */
  sizeBytes: number;
  /**
   * What this file is. `weights` entries (single-file or first-shard)
   * drive the GGUF metadata parse and the `weightsFilename` field on
   * the install manifest; `weights-shard` entries are extra GGUF shards
   * (the 2nd-onwards of a split model); `mmproj` is the multimodal
   * projector sidecar consumed by `--mmproj`; `draft-model` is a
   * speculative-decoding companion consumed by `--spec-draft-model`.
   */
  role: 'weights' | 'weights-shard' | 'mmproj' | 'draft-model';
}

export interface LlamaCppModelManagerOptions {
  /** GEZEL_HOME — used to compute the models root. */
  home: string;
  catalog: CatalogService;
  /** Test seam — defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Which engine's GGUFs this manager installs. ds4 (DwarfStar) GGUFs are
   * structurally identical to llama.cpp's (HF repo + revision + filename/shards
   * + sha256), so ds4 reuses this exact downloader — only the on-disk dir
   * (`engines/<engine>/models`) and the catalog source block read (`ds4` vs
   * `llamaCpp`) differ. Defaults to `'llama-cpp'`.
   */
  engine?: 'llama-cpp' | 'ds4';
  /**
   * Fired once per successful install, just before the `done` event
   * yields. Every install flow (Settings SSE route, first-run
   * bootstrap, /v1 ensure, limbo recovery) funnels through `install()`,
   * so this is the single post-install chokepoint — the fitness
   * manager hangs its automatic probe here. Fire-and-forget: a
   * throwing callback never breaks the install.
   */
  onInstalled?: (info: { engine: 'llama-cpp' | 'ds4'; id: string }) => void;
}

/**
 * How often to emit a `progress` event during a download. Anything
 * shorter than 250ms wastes CPU on JSON serialization for the SSE
 * stream; anything longer feels laggy in the UI's progress bar.
 */
const PROGRESS_INTERVAL_MS = 250;

const log = createLogger('models');

export class LlamaCppModelManager {
  private readonly modelsRoot: string;
  private readonly storageRoots: ModelStorageRoots;
  private readonly catalog: CatalogService;
  private readonly fetchImpl: typeof fetch;
  private readonly engine: 'llama-cpp' | 'ds4';
  private readonly onInstalled?: (info: { engine: 'llama-cpp' | 'ds4'; id: string }) => void;
  /**
   * In-flight installs. `install()` registers an entry on first yield
   * and clears it in the iterator's `finally` block, so consumers
   * (HTTP `/active-installs`, polling React UI) always see the live
   * subset regardless of which code path drove the install.
   */
  private readonly activeInstalls = new Map<string, ActiveInstallSnapshot>();
  /**
   * Model directories we've already warned about skipping. `listInstalled`
   * runs on every picker/settings poll; a broken directory should be loud
   * exactly once per process, not once per poll.
   */
  private readonly skipWarned = new Set<string>();

  constructor(opts: LlamaCppModelManagerOptions) {
    this.engine = opts.engine ?? 'llama-cpp';
    this.storageRoots = modelStorageRoots({ home: opts.home, engine: this.engine });
    this.modelsRoot = this.storageRoots.writableRoot;
    this.catalog = opts.catalog;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onInstalled = opts.onInstalled;
  }

  /**
   * The catalog source block this manager downloads from — `ds4` for the
   * DwarfStar engine, `llamaCpp` otherwise. Cast to the llama.cpp source
   * shape because the download path reads only the fields both blocks share
   * (HF repo / revision / filename / shards / sha256 / approxSizeBytes).
   */
  private srcBlock(manifest: {
    llamaCpp?: import('@bendyline/gezel').ChatModelLlamaCppSource;
    ds4?: import('@bendyline/gezel').ChatModelDs4Source;
  }): import('@bendyline/gezel').ChatModelLlamaCppSource | undefined {
    return this.engine === 'ds4'
      ? (manifest.ds4 as import('@bendyline/gezel').ChatModelLlamaCppSource | undefined)
      : manifest.llamaCpp;
  }

  /**
   * Snapshot of installs currently running. Used by the Settings UI to
   * mirror background bootstrap installs into its progress view — the
   * first-run download fires server-side via direct method call (not
   * the HTTP install route), so the React component has no live SSE
   * stream to consume; polling this surface fills the gap.
   */
  getActiveInstalls(): ActiveInstallSnapshot[] {
    // Return shallow copies so the caller can't mutate our state.
    return Array.from(this.activeInstalls.values()).map((entry) => ({ ...entry }));
  }

  /**
   * List installed models in alphabetical order. Tolerates malformed or
   * partial directories — they're skipped, not surfaced as errors.
   */
  async listInstalled(): Promise<InstalledLlamaCppModel[]> {
    const entries = await listOverlayModelIds(this.storageRoots);
    const out: InstalledLlamaCppModel[] = [];
    for (const id of entries) {
      const summary = await this.loadInstalled(id);
      if (!summary) {
        this.warnSkip(id, 'no readable manifest.json (incomplete or interrupted download?)');
        continue;
      }
      // Drift flag: does the catalog now ship a different version than the
      // one on disk? If so, mark `updateAvailable` so the model manager can
      // offer "Update" instead of delete + re-fetch. Best-effort — a
      // catalog miss (third-party / removed entry) leaves it un-flagged.
      if (summary.catalogVersion) {
        const detail = await this.catalog.get('chat-model', id).catch(() => null);
        const current =
          detail && detail.manifest.kind === 'chat-model' ? detail.manifest.version : undefined;
        if (current && current !== summary.catalogVersion) {
          summary.updateAvailable = true;
          summary.availableVersion = current;
        }
      }
      out.push(summary);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /**
   * List incomplete downloads for this engine — interrupted or unverified
   * downloads that hold bytes on disk but have no `manifest.json`, so they
   * never appear in {@link listInstalled}. Each is tagged `resumable` when
   * its id still resolves to a catalog entry this engine can source, so the
   * UI can offer resume (re-install picks up from the `.partial`) vs
   * delete-only for stale ids. In-flight installs are excluded.
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
        if (detail && detail.manifest.kind === 'chat-model' && this.srcBlock(detail.manifest)) {
          resumable = true;
          name = detail.manifest.name;
        }
      }
      out.push({ ...row, resumable, ...(name ? { name } : {}) });
    }
    return out;
  }

  /**
   * Model directories that do have a manifest, but whose metadata cannot be
   * loaded by this build. These used to disappear from every inventory
   * surface: `listInstalled()` correctly refused to run them, while the
   * incomplete-download scan correctly ignored anything with a manifest.
   * Keep that safety boundary, but return a management-only row so Settings
   * can update a known catalog id or explicitly remove the held bytes.
   */
  async listUnrecognized(): Promise<UnrecognizedModelInfo[]> {
    const rows: UnrecognizedModelInfo[] = [];
    for (const id of await listOverlayModelIds(this.storageRoots)) {
      if (!isSafeId(id)) continue;
      const root = await findModelRoot(this.storageRoots, id);
      // Manifestless directories belong to listIncomplete(), not this state.
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
          reason =
            typeof parsed.filename === 'string' && typeof parsed.weightsFilename !== 'string'
              ? 'This model was installed by an older version of Gezel and its metadata needs updating.'
              : 'This model metadata is incomplete or does not match the current format.';
        } catch {
          reason = "This model's metadata file is not valid JSON.";
        }
      }

      const detail = await this.catalog.get('chat-model', id).catch(() => null);
      const catalogManifest = detail?.manifest.kind === 'chat-model' ? detail.manifest : undefined;
      const canUpdate = Boolean(catalogManifest && this.srcBlock(catalogManifest));
      const name = catalogManifest?.name ?? legacyName;
      rows.push({
        id,
        ...(name ? { name } : {}),
        bytes: profile.bytes,
        updatedAt: profile.updatedAt,
        reason,
        canUpdate,
        ...(resolve(root) !== resolve(this.storageRoots.writableRoot) ? { readOnly: true } : {}),
      });
    }
    rows.sort((a, b) => b.bytes - a.bytes);
    return rows;
  }

  /**
   * Path of the first installed model, or null when none exist. Phase 2
   * uses this to pick a default `--model` arg for the supervised
   * llama-server when the user hasn't explicitly chosen one. A "default
   * model" UI lives in Phase 3.
   */
  async resolveDefaultModelPath(): Promise<string | null> {
    const model = await this.resolveDefaultModel();
    return model?.weightsPath ?? null;
  }

  /**
   * Summary of the first installed model (or null). Same fall-through
   * rule as {@link resolveDefaultModelPath}; returns the full summary
   * so callers like `buildLlamaCppProvider` can pick up the manifest's
   * `contextWindow` along with the path.
   */
  async resolveDefaultModel(): Promise<InstalledLlamaCppModel | null> {
    const models = await this.listInstalled();
    return models[0] ?? null;
  }

  /**
   * Path of a specific installed model, or null when not installed.
   * Used by ChatManager when the user has picked a model explicitly.
   */
  async resolveModelPath(id: string): Promise<string | null> {
    const summary = await this.loadInstalled(id);
    return summary?.weightsPath ?? null;
  }

  /**
   * Full summary for a specific installed model, or null when not
   * installed. Used when the user has pinned a default model via
   * `config.defaultModel['llama-cpp']` — `buildLlamaCppProvider`
   * needs the `contextWindow` to set `--ctx-size` correctly.
   */
  async resolveModel(id: string): Promise<InstalledLlamaCppModel | null> {
    return this.loadInstalled(id);
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
    if (!summary) throw new Error(`model "${id}" is not available locally for ${this.engine}`);
    const root = await findModelRoot(this.storageRoots, id);
    if (!root) throw new Error(`model "${id}" is not available locally for ${this.engine}`);
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

  /**
   * Validate provider-specific invariants, write the local install manifest,
   * and atomically publish a security-scanned staged bundle.
   */
  async importModelBundle(opts: {
    id: string;
    stagedModelDir: string;
    installedManifest: Record<string, unknown>;
    replace: boolean;
  }): Promise<void> {
    if (!isSafeId(opts.id)) throw new Error(`unsafe model id: ${opts.id}`);
    const parsed = opts.installedManifest as Partial<InstalledManifest>;
    if (parsed.id !== opts.id || !parsed.name || !parsed.weightsFilename || !parsed.installedAt) {
      throw new Error('installed manifest does not describe the bundled model');
    }
    const files = await listBundleModelFiles(opts.stagedModelDir);
    if (files.length === 0 || files.some((file) => !file.toLowerCase().endsWith('.gguf'))) {
      throw new Error(`${this.engine} bundles may contain only GGUF model files`);
    }
    if (!files.includes(parsed.weightsFilename)) {
      throw new Error(`installed manifest references missing weights: ${parsed.weightsFilename}`);
    }
    if (parsed.shards?.some((shard) => !files.includes(shard.filename))) {
      throw new Error('installed manifest references a missing GGUF shard');
    }
    if (parsed.mmprojFilename && !files.includes(parsed.mmprojFilename)) {
      throw new Error('installed manifest references a missing multimodal projector');
    }
    if (parsed.draftModelFilename && !files.includes(parsed.draftModelFilename)) {
      throw new Error('installed manifest references a missing speculative draft model');
    }

    // Parsing the GGUF header is the same final usability check a network
    // install performs after checksum verification.
    readGgufSummary(safeBundleModelPath(opts.stagedModelDir, parsed.weightsFilename));
    const importedManifest: InstalledManifest = {
      ...parsed,
      fileSha256: await hashModelPayloadFiles(opts.stagedModelDir),
    } as InstalledManifest;
    await writeFile(
      join(opts.stagedModelDir, 'manifest.json'),
      `${JSON.stringify(importedManifest, null, 2)}\n`,
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
      this.onInstalled?.({ engine: this.engine, id: opts.id });
    } catch {
      // A post-install fitness hook is best-effort, as in the download path.
    }
  }

  /**
   * Install a model from the catalog. Yields progress / verifying /
   * extracting-metadata / done events. Yields exactly one terminal
   * event (`done` or `error`) and is safe to consume to completion.
   *
   * Existing weights at the target id are atomically replaced — the
   * download writes to a `.partial` sibling and renames into place
   * only after sha256 verification passes. Failed installs leave the
   * previous weights untouched.
   */
  async *install(
    catalogId: string,
    options?: { skipSha?: boolean; includeMmproj?: boolean },
  ): AsyncIterable<InstallEvent> {
    const skipSha = options?.skipSha === true;
    const includeMmproj = options?.includeMmproj === true;
    if (!isSafeId(catalogId)) {
      yield { type: 'error', error: `unsafe catalog id: ${catalogId}` };
      return;
    }
    // Two concurrent installs of the same catalog id would both write
    // to the same `weights.gguf.partial` and produce a corrupt
    // (sha-mismatched) file. Claim the slot SYNCHRONOUSLY (before any
    // `await`) so a parallel call observing `has(...) === false` and
    // entering the same window can't slip in between our check and
    // set. The placeholder snapshot is filled in once the catalog
    // lookup succeeds. Hits when the first-run bootstrap and the
    // Home banner's limbo recovery fire on the same boot.
    if (this.activeInstalls.has(catalogId)) {
      yield {
        type: 'error',
        error: `install for "${catalogId}" is already in progress`,
      };
      return;
    }
    const tracked: ActiveInstallSnapshot = {
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
      const installSrc = this.srcBlock(manifest);
      if (!installSrc) {
        yield {
          type: 'error',
          error: `chat-model "${catalogId}" has no ${this.engine} source`,
        };
        return;
      }
      tracked.totalBytes = installSrc.approxSizeBytes;
      yield* this.runInstall(catalogId, manifest, tracked, skipSha, includeMmproj);
    } finally {
      this.activeInstalls.delete(catalogId);
    }
  }

  /**
   * Inner install loop. Splitting it out lets {@link install} wrap the
   * generator in a `try/finally` that clears the active-install
   * registration on every exit path, including caller break/throw —
   * the equivalent inline construction would require interleaving the
   * cleanup with each early `return` and silently rot.
   */
  private async *runInstall(
    catalogId: string,
    manifest: NonNullable<Awaited<ReturnType<typeof this.catalog.get>>>['manifest'] & {
      kind: 'chat-model';
    },
    tracked: ActiveInstallSnapshot,
    skipSha: boolean,
    includeMmproj: boolean,
  ): AsyncIterable<InstallEvent> {
    const src = this.srcBlock(manifest);
    if (!src) {
      yield { type: 'error', error: `chat-model "${catalogId}" has no ${this.engine} source` };
      return;
    }
    const itemDir = join(this.modelsRoot, catalogId);
    await mkdir(itemDir, { recursive: true });

    const plan = planDownloads(src, includeMmproj);
    if (plan.length === 0) {
      yield {
        type: 'error',
        error: `chat-model "${catalogId}" ${this.engine} source has neither filename nor shards`,
      };
      return;
    }

    const totalPlanned = plan.reduce((sum, e) => sum + e.sizeBytes, 0) || src.approxSizeBytes;
    tracked.totalBytes = totalPlanned;
    let bytesCompleted = 0;
    // sha256 of each verified file, keyed by its final relative path (flat,
    // since planDownloads uses basename). Reused to build the fileSha256 map
    // after publish so we don't re-hash the whole payload from disk a second
    // time. `actual` (not the catalog hash) is stored so the skipSha path
    // still records the true on-disk identity.
    const verifiedDigests: Record<string, string> = {};

    // Preflight the disk before writing a byte. ds4 GGUFs run to 200+ GiB, so
    // discovering ENOSPC at 95% costs hours and leaves a `.partial` occupying
    // the disk it just filled. Only the bytes still missing are charged, so a
    // resumed install isn't refused for space it already holds.
    const remainingBytes = Math.max(0, totalPlanned - (await bytesAlreadyOnDisk(itemDir, plan)));
    const space = await checkDiskSpace(itemDir, remainingBytes);
    if (!space.ok) {
      yield { type: 'error', error: describeDiskShortfall(space, manifest.name) };
      return;
    }

    for (let i = 0; i < plan.length; i++) {
      const entry = plan[i];
      if (!entry) continue;
      const destPath = join(itemDir, entry.destFilename);
      const tmpPath = `${destPath}.partial`;
      // Pin to the catalog's revision (commit SHA) when present so we
      // get the exact bytes the sha256 was computed against; fall back
      // to `main` for legacy manifests that predate revision pinning.
      const ref = src.revision ?? 'main';
      const url = `https://huggingface.co/${src.huggingfaceRepo}/resolve/${encodeURIComponent(
        ref,
      )}/${entry.repoPath.split('/').map(encodeURIComponent).join('/')}?download=true`;

      const dlGen = downloadWithRetry({
        url,
        destPath,
        approxSizeBytes: entry.sizeBytes,
        fetchImpl: this.fetchImpl,
      });
      let entryBytesWritten = 0;
      let inlineSha: string | undefined;
      while (true) {
        const step = await dlGen.next();
        if (step.done) {
          if (step.value.kind === 'aborted') {
            yield { type: 'error', error: 'download aborted' };
            return;
          }
          if (step.value.kind === 'error') {
            yield {
              type: 'error',
              error:
                plan.length > 1
                  ? `shard ${i + 1}/${plan.length} (${entry.destFilename}): ${step.value.error}`
                  : step.value.error,
            };
            return;
          }
          entryBytesWritten = step.value.bytesWritten || entryBytesWritten;
          inlineSha = step.value.sha256;
          break;
        }
        const ev = step.value;
        if (ev.type === 'progress') {
          entryBytesWritten = ev.bytesWritten;
          tracked.bytesWritten = bytesCompleted + entryBytesWritten;
          yield {
            type: 'progress',
            bytesWritten: bytesCompleted + entryBytesWritten,
            totalBytes: totalPlanned,
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

      tracked.phase = 'verifying';
      yield { type: 'verifying' };

      // Prefer the digest the downloader computed inline while streaming —
      // a clean single-pass (HTTP 200) transfer already hashed every byte,
      // so re-reading a multi-GB file off disk just to hash it again is pure
      // waste. Only fall back to the read-back pass when the inline digest
      // is absent (a resumed/appended download, or the Xet path, where the
      // hasher never saw the earlier bytes).
      let actual = inlineSha;
      if (!actual) {
        const hasher = createHash('sha256');
        await new Promise<void>((resolve, reject) => {
          // Big read buffer: a 64 KB stream starves inside the busy daemon
          // event loop (~110k turns for a 7 GB file → 15+ min). See
          // MODEL_HASH_READ_BUFFER_BYTES.
          const stream = createReadStream(tmpPath, {
            highWaterMark: MODEL_HASH_READ_BUFFER_BYTES,
          });
          stream.on('data', (chunk) => hasher.update(chunk));
          stream.on('end', () => resolve());
          stream.on('error', reject);
        });
        actual = hasher.digest('hex');
      }
      verifiedDigests[entry.destFilename] = actual;
      if (actual !== entry.sha256.toLowerCase()) {
        if (skipSha) {
          // User opted in after a previous mismatch surfaced. Keep the
          // `.partial` so the post-loop rename still has something to
          // commit; just stop treating the catalog sha as authoritative.
        } else {
          await rm(tmpPath, { force: true });
          yield {
            type: 'error',
            error: `The file '${entry.destFilename}' on Hugging Face has changed since this version of Gezel was published. Expected sha256 ${entry.sha256}, got ${actual}.`,
            mismatch: { file: entry.destFilename, expected: entry.sha256, actual },
          };
          return;
        }
      }

      bytesCompleted += entryBytesWritten;
      tracked.bytesWritten = bytesCompleted;
      // Reset phase back to downloading for the next shard (or stays as
      // verifying if this was the last; the next yielded phase is
      // extracting-metadata below). Keeps the UI's phase pill accurate
      // mid-iteration.
      if (i < plan.length - 1) tracked.phase = 'downloading';
    }

    // Parse metadata from the first weights entry (first shard for a
    // sharded install, or the only file for single-file). Sidecars have
    // their own GGUF headers but aren't what llama-server probes for the
    // target model's context length / chat template.
    tracked.phase = 'extracting-metadata';
    yield { type: 'extracting-metadata' };
    const firstWeights = plan.find((e) => e.role === 'weights');
    if (!firstWeights) {
      // Unreachable: planDownloads always emits at least one weights
      // entry when the source is well-formed, and we already errored
      // above when it returned [].
      yield { type: 'error', error: 'internal: download plan has no weights entry' };
      return;
    }
    const firstTmpPath = `${join(itemDir, firstWeights.destFilename)}.partial`;
    let summary: ReturnType<typeof readGgufSummary> | null = null;
    try {
      summary = readGgufSummary(firstTmpPath);
    } catch (err) {
      // Hash matched but the parser couldn't read the metadata — this
      // should not happen with a real GGUF, but we don't want to leave
      // downloaded-but-unusable files around. Bail loudly.
      for (const entry of plan) {
        await rm(`${join(itemDir, entry.destFilename)}.partial`, { force: true });
      }
      yield {
        type: 'error',
        error: `GGUF metadata parse failed (file is unusable): ${describeError(err)}`,
      };
      return;
    }

    // Atomic publish: rename each .partial into place. If a rename
    // fails partway through, the renamed-already weights stay, the
    // remaining .partials stay; the next install attempt resumes the
    // rest. We bail loudly rather than try to roll back, because
    // partial state is what we already accept on download failure.
    try {
      for (const entry of plan) {
        const finalPath = join(itemDir, entry.destFilename);
        await rm(finalPath, { force: true });
        await rename(`${finalPath}.partial`, finalPath);
      }
    } catch (err) {
      yield { type: 'error', error: `rename failed: ${describeError(err)}` };
      return;
    }

    // Drop weights left behind by a previous install of this id that used a
    // different quant/filename — otherwise the old GGUF lingers alongside the
    // new one (tens of GB for one slot). Runs before the fileSha256 map is
    // built so the map describes exactly the current payload.
    const pruned = await pruneModelPayloadFiles(
      itemDir,
      new Set(plan.map((entry) => entry.destFilename)),
    );
    if (pruned.length > 0) {
      log.info(
        `[models] [${this.engine}] pruned ${pruned.length} stale file(s) from "${catalogId}": ${pruned.join(', ')}`,
      );
    }

    const weightsShards = plan.filter((e) => e.role === 'weights' || e.role === 'weights-shard');
    const mmprojEntry = plan.find((e) => e.role === 'mmproj');
    const draftModelEntry = plan.find((e) => e.role === 'draft-model');
    const installed: InstalledManifest = {
      id: catalogId,
      name: manifest.name,
      approxSizeBytes: bytesCompleted || totalPlanned,
      weightsFilename: firstWeights.destFilename,
      sha256: firstWeights.sha256.toLowerCase(),
      installedAt: new Date().toISOString(),
      catalogId,
      catalogVersion: manifest.version,
      huggingfaceRepo: src.huggingfaceRepo,
      ...(weightsShards.length > 1
        ? {
            shards: weightsShards.map((entry) => ({
              filename: entry.destFilename,
              sha256: entry.sha256.toLowerCase(),
              sizeBytes: entry.sizeBytes,
            })),
          }
        : {}),
      ...(mmprojEntry ? { mmprojFilename: mmprojEntry.destFilename } : {}),
      ...(draftModelEntry ? { draftModelFilename: draftModelEntry.destFilename } : {}),
      ...(src.quantization ? { quantization: src.quantization } : {}),
      ...(summary.contextLength ? { contextWindow: Number(summary.contextLength) } : {}),
      ...(summary.architecture ? { architecture: summary.architecture } : {}),
      chatTemplatePresent: !summary.chatTemplateMissing,
    };
    installed.fileSha256 = await hashModelPayloadFiles(itemDir, verifiedDigests);
    await writeFile(join(itemDir, 'manifest.json'), JSON.stringify(installed, null, 2), 'utf8');
    await makeSharedModelReadable(itemDir);

    const warning = summary.chatTemplateMissing
      ? 'Model has no embedded chat template (tokenizer.chat_template is missing). llama-server will fall back to a generic template that may not match this model — replies may be incoherent. Consider a different quant of the same model.'
      : undefined;
    try {
      this.onInstalled?.({ engine: this.engine, id: catalogId });
    } catch {
      // Fire-and-forget: a hook failure must never fail a completed install.
    }
    yield { type: 'done', id: catalogId, ...(warning ? { warning } : {}) };
  }

  /** Warn once per model directory per process, then stay quiet. */
  private warnSkip(id: string, reason: string): void {
    if (this.skipWarned.has(id)) return;
    this.skipWarned.add(id);
    log.warn(`[${this.engine}] model directory "${id}" is not runnable: ${reason}`);
  }

  private async loadInstalled(id: string): Promise<InstalledLlamaCppModel | null> {
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
    if (!parsed.id || !parsed.name || !parsed.weightsFilename || !parsed.installedAt) {
      this.warnSkip(
        id,
        'manifest.json is missing required fields (id/name/weightsFilename/installedAt)',
      );
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
      weightsPath: join(root, id, parsed.weightsFilename),
      ...(parsed.mmprojFilename ? { mmprojPath: join(root, id, parsed.mmprojFilename) } : {}),
      ...(parsed.draftModelFilename
        ? { draftModelPath: join(root, id, parsed.draftModelFilename) }
        : {}),
      ...(parsed.contextWindow ? { contextWindow: parsed.contextWindow } : {}),
      ...(parsed.quantization ? { quantization: parsed.quantization } : {}),
      chatTemplatePresent: parsed.chatTemplatePresent ?? true,
      ...(parsed.architecture ? { architecture: parsed.architecture } : {}),
      ...(parsed.catalogVersion ? { catalogVersion: parsed.catalogVersion } : {}),
      ...(parsed.sha256 ? { sha256: parsed.sha256 } : {}),
      // Read-only when it lives in a machine/shared overlay rather than this
      // daemon's writable root — the delete endpoint refuses it, so the UI
      // must not offer a Delete action that can only 400.
      ...(resolve(root) !== resolve(this.storageRoots.writableRoot) ? { readOnly: true } : {}),
    };
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Translate a catalog `llamaCpp` source into the ordered list of files
 * to download. Single-file sources collapse to one entry. Sharded
 * sources expand to one entry per shard, flattening any subdirectory
 * in the HF tree to a basename on disk (so `Q4_K_M/foo-00001-of-NNN.gguf`
 * lands as `foo-00001-of-NNN.gguf` next to its siblings — llama-server
 * needs them all in the same directory to auto-discover splits).
 */
function planDownloads(
  src: {
    filename?: string;
    sha256?: string;
    approxSizeBytes: number;
    shards?: Array<{ name: string; sha256: string; sizeBytes: number }>;
    mmproj?: { filename: string; sha256: string; sizeBytes: number };
    draftModel?: { filename: string; sha256: string; sizeBytes: number };
  },
  /**
   * Whether to also fetch the vision projector. Off by default even when the
   * catalog declares one: loading an mmproj makes llama-server 501 on slot
   * save/restore, which latches disk-KV prefix caching off for that model
   * process-wide. Paying that on every text turn is a choice the user makes
   * per model, not a side effect of installing something that ships one.
   */
  includeMmproj = false,
): DownloadPlanEntry[] {
  const out: DownloadPlanEntry[] = [];
  if (src.shards && src.shards.length > 0) {
    src.shards.forEach((shard, i) => {
      out.push({
        repoPath: shard.name,
        destFilename: basename(shard.name),
        sha256: shard.sha256,
        sizeBytes: shard.sizeBytes,
        role: i === 0 ? 'weights' : 'weights-shard',
      });
    });
  } else if (src.filename && src.sha256) {
    out.push({
      repoPath: src.filename,
      destFilename: basename(src.filename),
      sha256: src.sha256,
      sizeBytes: src.approxSizeBytes,
      role: 'weights',
    });
  } else {
    return [];
  }
  if (src.mmproj && includeMmproj) {
    out.push({
      repoPath: src.mmproj.filename,
      destFilename: basename(src.mmproj.filename),
      sha256: src.mmproj.sha256,
      sizeBytes: src.mmproj.sizeBytes,
      role: 'mmproj',
    });
  }
  // Draft companions are part of the model's selected decoding path, not
  // an optional modality. Download them whenever the catalog ships one so
  // an explicitly selected `draft-mtp`/other draft mode can work immediately
  // after install without a second download.
  if (src.draftModel) {
    out.push({
      repoPath: src.draftModel.filename,
      destFilename: basename(src.draftModel.filename),
      sha256: src.draftModel.sha256,
      sizeBytes: src.draftModel.sizeBytes,
      role: 'draft-model',
    });
  }
  return out;
}

/**
 * Bytes of a planned install that are already on disk — completed files from
 * an earlier attempt plus any resumable `.partial`. The disk preflight charges
 * only the remainder, so retrying a 200 GiB download that's 90% done isn't
 * refused for space it is already holding.
 */
async function bytesAlreadyOnDisk(itemDir: string, plan: DownloadPlanEntry[]): Promise<number> {
  let total = 0;
  for (const entry of plan) {
    const destPath = join(itemDir, entry.destFilename);
    for (const candidate of [destPath, `${destPath}.partial`]) {
      const size = await stat(candidate)
        .then((st) => st.size)
        .catch(() => 0);
      // A finished file and its leftover `.partial` can coexist; count the
      // larger one only, never both.
      if (size > 0) {
        total += Math.min(size, entry.sizeBytes);
        break;
      }
    }
  }
  return total;
}

/**
 * Permissive id check — must be a relative single-segment id, no
 * traversal. Catalog ids match `[a-z0-9][a-z0-9.\-:]{1,63}` per the
 * core schema, so anything that flunks this is malicious.
 */
function isSafeId(id: string): boolean {
  if (id.length === 0 || id.length > 64) return false;
  if (id.includes('/') || id.includes('\\') || id.startsWith('.')) return false;
  return /^[a-z0-9][a-z0-9.\-:]{0,63}$/i.test(id);
}

// Local DOM-free type so we don't drag in lib.dom.d.ts.
interface ReadableStreamLike<T> {
  getReader(): {
    read(): Promise<{ value: T | undefined; done: boolean }>;
  };
}
