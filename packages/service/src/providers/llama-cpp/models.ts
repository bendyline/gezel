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
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { CatalogService } from '@bendyline/gezel-catalog';
import {
  type ModelBundleSource,
  listBundleModelFiles,
  publishStagedModel,
  safeBundleModelPath,
} from '../../models/bundle-storage.js';
import { downloadWithRetry } from '../../utils/download-with-retry.js';
import { readGgufSummary } from './gguf-metadata.js';

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
  /** From the GGUF metadata — useful for the supervisor's `-c` flag (Phase 3). */
  contextWindow?: number;
  /** Quantization tag (Q4_K_M / Q8_0 / …) lifted from the catalog source block. */
  quantization?: string;
  /** Empty when `tokenizer.chat_template` is missing — surfaced in the UI as a warning. */
  chatTemplatePresent: boolean;
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
  installedAt: string;
  catalogId: string;
  catalogVersion: string;
  huggingfaceRepo: string;
  quantization?: string;
  contextWindow?: number;
  architecture?: string;
  chatTemplatePresent: boolean;
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
   * projector sidecar consumed by `--mmproj`.
   */
  role: 'weights' | 'weights-shard' | 'mmproj';
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

export class LlamaCppModelManager {
  private readonly modelsRoot: string;
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

  constructor(opts: LlamaCppModelManagerOptions) {
    this.engine = opts.engine ?? 'llama-cpp';
    this.modelsRoot = join(opts.home, 'engines', this.engine, 'models');
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
    let entries: string[] = [];
    try {
      entries = await readdir(this.modelsRoot);
    } catch {
      return [];
    }
    const out: InstalledLlamaCppModel[] = [];
    for (const id of entries) {
      const summary = await this.loadInstalled(id);
      if (!summary) continue;
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
    const itemDir = join(this.modelsRoot, id);
    await rm(itemDir, { recursive: true, force: true });
  }

  /** Provider-owned snapshot used by the streaming `.gezmodel` exporter. */
  async getModelBundleSource(id: string): Promise<ModelBundleSource> {
    if (!isSafeId(id)) throw new Error(`unsafe model id: ${id}`);
    const summary = await this.loadInstalled(id);
    if (!summary) throw new Error(`model "${id}" is not available locally for ${this.engine}`);
    const modelDir = join(this.modelsRoot, id);
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

    // Parsing the GGUF header is the same final usability check a network
    // install performs after checksum verification.
    readGgufSummary(safeBundleModelPath(opts.stagedModelDir, parsed.weightsFilename));
    await writeFile(
      join(opts.stagedModelDir, 'manifest.json'),
      `${JSON.stringify(parsed, null, 2)}\n`,
      'utf8',
    );
    await publishStagedModel({
      modelsRoot: this.modelsRoot,
      id: opts.id,
      stagedModelDir: opts.stagedModelDir,
      replace: opts.replace,
    });
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
  async *install(catalogId: string, options?: { skipSha?: boolean }): AsyncIterable<InstallEvent> {
    const skipSha = options?.skipSha === true;
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
      yield* this.runInstall(catalogId, manifest, tracked, skipSha);
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
  ): AsyncIterable<InstallEvent> {
    const src = this.srcBlock(manifest);
    if (!src) {
      yield { type: 'error', error: `chat-model "${catalogId}" has no ${this.engine} source` };
      return;
    }
    const itemDir = join(this.modelsRoot, catalogId);
    await mkdir(itemDir, { recursive: true });

    const plan = planDownloads(src);
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

      // sha256 verify by hashing the .partial — works correctly across
      // resumed downloads (a chunk-time hasher would corrupt on resume).
      const hasher = createHash('sha256');
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(tmpPath);
        stream.on('data', (chunk) => hasher.update(chunk));
        stream.on('end', () => resolve());
        stream.on('error', reject);
      });
      const actual = hasher.digest('hex');
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
    // sharded install, or the only file for single-file). The mmproj
    // sidecar has its own GGUF header but isn't what llama-server
    // probes for context length / chat template.
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

    const weightsShards = plan.filter((e) => e.role === 'weights' || e.role === 'weights-shard');
    const mmprojEntry = plan.find((e) => e.role === 'mmproj');
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
      ...(src.quantization ? { quantization: src.quantization } : {}),
      ...(summary.contextLength ? { contextWindow: Number(summary.contextLength) } : {}),
      ...(summary.architecture ? { architecture: summary.architecture } : {}),
      chatTemplatePresent: !summary.chatTemplateMissing,
    };
    await writeFile(join(itemDir, 'manifest.json'), JSON.stringify(installed, null, 2), 'utf8');

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

  private async loadInstalled(id: string): Promise<InstalledLlamaCppModel | null> {
    const metaPath = join(this.modelsRoot, id, 'manifest.json');
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
    if (!parsed.id || !parsed.name || !parsed.weightsFilename || !parsed.installedAt) {
      return null;
    }
    return {
      id: parsed.id,
      name: parsed.name,
      approxSizeBytes: parsed.approxSizeBytes ?? 0,
      installedAt: parsed.installedAt,
      weightsPath: join(this.modelsRoot, id, parsed.weightsFilename),
      ...(parsed.mmprojFilename
        ? { mmprojPath: join(this.modelsRoot, id, parsed.mmprojFilename) }
        : {}),
      ...(parsed.contextWindow ? { contextWindow: parsed.contextWindow } : {}),
      ...(parsed.quantization ? { quantization: parsed.quantization } : {}),
      chatTemplatePresent: parsed.chatTemplatePresent ?? true,
      ...(parsed.architecture ? { architecture: parsed.architecture } : {}),
      ...(parsed.catalogVersion ? { catalogVersion: parsed.catalogVersion } : {}),
      ...(parsed.sha256 ? { sha256: parsed.sha256 } : {}),
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
function planDownloads(src: {
  filename?: string;
  sha256?: string;
  approxSizeBytes: number;
  shards?: Array<{ name: string; sha256: string; sizeBytes: number }>;
  mmproj?: { filename: string; sha256: string; sizeBytes: number };
}): DownloadPlanEntry[] {
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
  if (src.mmproj) {
    out.push({
      repoPath: src.mmproj.filename,
      destFilename: basename(src.mmproj.filename),
      sha256: src.mmproj.sha256,
      sizeBytes: src.mmproj.sizeBytes,
      role: 'mmproj',
    });
  }
  return out;
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
