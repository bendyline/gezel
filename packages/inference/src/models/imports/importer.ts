/**
 * Adding a model the catalog does not carry, from Hugging Face. Two steps,
 * both explicit:
 *
 * 1. **Review**, nothing written. Read the repo at one commit. A GGUF repo is
 *    grouped into choices (one per quant, a split model's shards together)
 *    and the chosen file's header is read with a ranged request. An MLX repo
 *    is grouped into builds and its configs are read in full. Either way the
 *    pre-download checks run (core `model-import/checks.ts`) and the model's
 *    settings are found: a curated entry built from the same base model, else
 *    the author's recommended sampling, else the defaults.
 * 2. **Confirm**: re-derive the same review from the pinned commit and file,
 *    refuse if any check fails, and write the model's catalog entry beside
 *    where its weights will go. The engine's ordinary installer then
 *    downloads and verifies every file, and the fitness probe runs on it.
 *
 * Contract in docs/model-imports.md.
 */

import { createHash } from 'node:crypto';
import {
  type ChatModelManifest,
  type GgufChoice,
  type GgufHeaderFacts,
  type GgufRepoLayout,
  type HubRepoFile,
  type HuggingFaceModelReference,
  MLX_CONFIG_FILES,
  type MlxConfigFacts,
  type ModelFitResult,
  type ModelImportConfirmRequest,
  type ModelImportConfirmResponse,
  type ModelImportEngine,
  type ModelImportFileChoice,
  type ModelImportReview,
  type ModelImportReviewRequest,
  buildImportedChatModelManifest,
  buildImportedMlxManifest,
  buildMlxImportChecks,
  buildModelImportChecks,
  chatTemplateSupportsTools,
  chatTemplateThinks,
  createLogger,
  ggufChoiceForFile,
  ggufParameterSize,
  huggingFaceModelUrl,
  importedChatModelId,
  importedChatModelName,
  isHubCommitId,
  isHuggingFaceRepoId,
  isImportedChatModel,
  isSafeGgufRepoPath,
  isSafeHubRevision,
  layoutGgufRepo,
  mlxConfigFacts,
  mlxModelRoots,
  mlxParameterSize,
  mlxQuantizationLabel,
  modelImportBlocked,
  parseHuggingFaceReference,
  pickGgufChoice,
  pickGgufProjector,
  selectMlxFiles,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { currentLlamaCppBackend } from '../../providers/llama-cpp/backend-health.js';
import type { LlamaCppModelManager } from '../../providers/llama-cpp/models.js';
import { mlxModelGeometryFromConfig } from '../../providers/mlx/model-geometry.js';
import type { MlxModelManager } from '../../providers/mlx/models.js';
import { type MemoryProfile, detectMemoryProfileCached } from '../../system/memory.js';
import { checkDiskSpace } from '../../utils/disk-space.js';
import { modelStorageRoots } from '../storage-roots.js';
import {
  type HubModelInfo,
  HubRequestError,
  fetchHubCommit,
  fetchHubModelInfo,
  fetchHubSmallFile,
  fetchHubTree,
} from './hub.js';
import { kvGeometryFromInput, readRemoteGgufHeader } from './remote-header.js';
import {
  type ImportSettings,
  catalogChatModels,
  ggufChoiceFit,
  importFit,
  resolveImportSettings,
} from './shared.js';

export { HubRequestError } from './hub.js';

const log = createLogger('model-import');

/** A review stays valid this long for confirmation without re-reading the files. */
const ANALYSIS_TTL_MS = 15 * 60_000;
const ANALYSIS_CACHE_MAX = 32;
const NVFP4_TENSOR_TYPE = 40;
/** One MLX config file, and every small file a review reads to hash it. */
const MLX_SMALL_FILE_BYTES = 32 * 1024 * 1024;
const MLX_SMALL_FILES_TOTAL_BYTES = 96 * 1024 * 1024;
const MLX_BUILD_DIR = /^[A-Za-z0-9_.-]{1,64}(?:\/[A-Za-z0-9_.-]{1,64})?$/;

type ModelOwner = Pick<LlamaCppModelManager, 'resolveModel'> & {
  prepareImportedModel(manifest: ChatModelManifest, tuningFrom?: string): Promise<void>;
};

export interface HuggingFaceModelImporterOptions {
  home: string;
  catalog: CatalogService;
  llamaCppModels: ModelOwner;
  /** Absent where the MLX engine is not built (MLX reviews then refuse to confirm). */
  mlxModels?: Pick<MlxModelManager, 'resolveModel'> & {
    prepareImportedModel(manifest: ChatModelManifest, tuningFrom?: string): Promise<void>;
  };
  fetchImpl?: typeof fetch;
  memoryProfile?: () => Promise<MemoryProfile | null>;
  backend?: () => string | undefined;
  hasHubToken?: () => boolean;
  /** MLX runs only on Apple silicon. Test seam. */
  appleSilicon?: () => boolean;
  now?: () => Date;
}

interface Analysis {
  at: number;
  engine: ModelImportEngine;
  review: ModelImportReview;
  manifest?: ChatModelManifest;
  tuningFrom?: string;
}

/** A review target: a Hub reference, with an MLX build directory when one is named. */
type ImportRef = HuggingFaceModelReference & { mlxRoot?: string };

function toReference(request: ModelImportReviewRequest): ImportRef {
  if (request.reference) {
    const parsed = parseHuggingFaceReference(request.reference);
    if (!parsed) {
      throw new HubRequestError(
        "That doesn't look like a Hugging Face model. Paste a link like https://huggingface.co/owner/model-GGUF.",
        400,
      );
    }
    return parsed;
  }
  const repo = request.repo ?? '';
  if (!isHuggingFaceRepoId(repo)) {
    throw new HubRequestError('That is not a Hugging Face model name.', 400);
  }
  if (request.revision !== undefined && !isSafeHubRevision(request.revision)) {
    throw new HubRequestError('That revision is not valid.', 400);
  }
  const file = request.file;
  const ref: ImportRef = {
    repo,
    ...(request.quant ? { quant: request.quant } : {}),
    ...(request.revision ? { revision: request.revision } : {}),
  };
  if (file === undefined) return ref;
  if (file.toLowerCase().endsWith('.gguf')) {
    if (!isSafeGgufRepoPath(file)) {
      throw new HubRequestError('That file name is not a GGUF file in the repository.', 400);
    }
    return { ...ref, file };
  }
  if (file !== '' && !MLX_BUILD_DIR.test(file)) {
    throw new HubRequestError('That is not a model folder in the repository.', 400);
  }
  return { ...ref, mlxRoot: file };
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseJson(bytes: Buffer | undefined): unknown {
  if (!bytes) return undefined;
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether a repo of safetensors is an MLX build rather than original weights. */
function looksLikeMlx(info: HubModelInfo, repo: string, config: unknown): boolean {
  if (info.tags.some((tag) => tag.toLowerCase() === 'mlx')) return true;
  if (/mlx/i.test(repo)) return true;
  const record = config && typeof config === 'object' ? (config as Record<string, unknown>) : {};
  return record.quantization !== undefined;
}

export class HuggingFaceModelImporter {
  private readonly opts: HuggingFaceModelImporterOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly analyses = new Map<string, Analysis>();

  constructor(opts: HuggingFaceModelImporterOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async review(request: ModelImportReviewRequest): Promise<ModelImportReview> {
    const analysis = await this.analyze(toReference(request));
    return analysis.review;
  }

  /**
   * Record one reviewed choice so the engine's installer can fetch it.
   * Refuses unless the review, re-derived from the same pinned commit and
   * file, passes.
   */
  async confirm(request: ModelImportConfirmRequest): Promise<ModelImportConfirmResponse> {
    if (!isHuggingFaceRepoId(request.repo) || !isHubCommitId(request.revision)) {
      throw new HubRequestError('That review is not valid any more. Review the model again.', 400);
    }
    const ref = toReference({ repo: request.repo, revision: request.revision, file: request.file });
    const key = analysisKey(request.repo, request.revision, request.file);
    const cached = this.analyses.get(key);
    const analysis =
      cached && Date.now() - cached.at < ANALYSIS_TTL_MS ? cached : await this.analyze(ref);
    const { review, manifest, engine } = analysis;
    if (review.selectedFile !== request.file) {
      throw new HubRequestError('That file is not in the model at the reviewed commit.', 404);
    }
    if (review.blocked || !manifest) {
      const failed = review.checks.find((item) => item.status === 'fail');
      throw new HubRequestError(
        failed ? `${failed.title}: ${failed.detail}` : 'This model did not pass its checks.',
        409,
      );
    }
    const owner = engine === 'mlx' ? this.opts.mlxModels : this.opts.llamaCppModels;
    if (!owner) throw new HubRequestError('This computer has no MLX engine.', 409);
    await owner.prepareImportedModel(manifest, analysis.tuningFrom);
    log.info(
      `[model-import] recorded ${manifest.id} (${engine}) from ${request.repo}@${request.revision.slice(0, 12)} (${request.file || '.'})${analysis.tuningFrom ? `, settings from ${analysis.tuningFrom}` : ''}`,
    );
    return { engine, id: manifest.id, name: manifest.name };
  }

  private remember(analysis: Analysis): void {
    const source = analysis.review.source;
    if (source.kind !== 'huggingface') return;
    const key = analysisKey(source.repo, source.revision, analysis.review.selectedFile);
    this.analyses.delete(key);
    this.analyses.set(key, analysis);
    while (this.analyses.size > ANALYSIS_CACHE_MAX) {
      const oldest = this.analyses.keys().next().value;
      if (oldest === undefined) break;
      this.analyses.delete(oldest);
    }
  }

  private hasToken(): boolean {
    return (
      this.opts.hasHubToken?.() ??
      Boolean((process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN)?.trim())
    );
  }

  private async memory(): Promise<MemoryProfile | null> {
    return (this.opts.memoryProfile ?? (() => detectMemoryProfileCached()))().catch(() => null);
  }

  private async disk(engine: ModelImportEngine, downloadBytes: number) {
    const root = modelStorageRoots({ home: this.opts.home, engine }).writableRoot;
    const disk = await checkDiskSpace(root, downloadBytes).catch(() => null);
    return disk?.known
      ? { ok: disk.ok, downloadBytes, neededBytes: disk.requiredBytes, freeBytes: disk.freeBytes }
      : undefined;
  }

  private async analyze(ref: ImportRef): Promise<Analysis> {
    const info = await fetchHubModelInfo(this.fetchImpl, ref.repo);
    const repo = isHuggingFaceRepoId(info.id) ? info.id : ref.repo;
    const commit = ref.revision
      ? await fetchHubCommit(this.fetchImpl, repo, ref.revision)
      : info.sha;
    const tree = await fetchHubTree(this.fetchImpl, repo, commit);
    const layout = layoutGgufRepo(tree);
    const mlxRoots = mlxModelRoots(tree);
    let analysis: Analysis;
    if (layout.choices.length > 0 && ref.mlxRoot === undefined) {
      analysis = await this.analyzeGguf(ref, repo, commit, info, layout);
    } else if (mlxRoots.length > 0) {
      analysis = await this.analyzeMlx(ref, repo, commit, info, tree, mlxRoots);
    } else {
      throw new HubRequestError(
        'This repository has no model Gezel can run. Gezel adds GGUF models (repositories usually ending in "-GGUF") and, on Apple silicon Macs, MLX models (usually from mlx-community).',
        422,
      );
    }
    this.remember(analysis);
    return analysis;
  }

  // ── GGUF ──

  private async analyzeGguf(
    ref: ImportRef,
    repo: string,
    commit: string,
    info: HubModelInfo,
    layout: GgufRepoLayout,
  ): Promise<Analysis> {
    if (ref.file && !ggufChoiceForFile(layout, ref.file)) {
      throw new HubRequestError(`The repository has no GGUF file named ${ref.file}.`, 404);
    }
    const memory = await this.memory();
    const projector = pickGgufProjector(layout.projectors);
    // A gated file answers only a signed-in request from an account that
    // accepted the author's terms. Without a token there is nothing to read,
    // and the access check already says why.
    const hasToken = this.hasToken();
    const readable = !info.gated || hasToken;

    // The header is read for one choice. Quants of one model share their
    // design, so its KV geometry and expert layout price every other choice.
    const explicit = Boolean(ref.file || ref.quant);
    let choice = pickGgufChoice(layout, {
      ...(ref.file ? { file: ref.file } : {}),
      ...(ref.quant ? { quant: ref.quant } : {}),
    }) as GgufChoice;
    let header = readable
      ? await this.readHeader(repo, commit, choice, Boolean(info.gated))
      : { error: "Hugging Face shares this file only after you accept the author's terms." };
    if (!explicit && memory && header.facts) {
      const facts = header.facts;
      const fitPick = pickGgufChoice(layout, {
        fits: (candidate) =>
          ggufChoiceFit(
            candidate,
            facts,
            (facts.expertCount ?? 0) > 1,
            projector?.sizeBytes,
            memory,
          )?.tier !== 'too-big',
      });
      if (fitPick && fitPick.key !== choice.key) {
        choice = fitPick;
        header = await this.readHeader(repo, commit, choice, Boolean(info.gated));
      }
    }

    const facts = header.facts;
    const moe = (facts?.expertCount ?? 0) > 1;
    const downloadBytes = choice.sizeBytes + (projector?.sizeBytes ?? 0);
    const fit = ggufChoiceFit(choice, facts, moe, projector?.sizeBytes, memory);
    const backend = (this.opts.backend ?? currentLlamaCppBackend)();
    const backendGap =
      backend === 'metal' && (facts?.tensorTypeCounts?.[NVFP4_TENSOR_TYPE] ?? 0) > 0
        ? 'It stores weights as NVFP4, which the graphics chip on this Mac cannot run, so it would run on the processor and be very slow. Choose another file.'
        : undefined;
    const disk = await this.disk('llama-cpp', downloadBytes);

    const checks = buildModelImportChecks({
      access: { gated: info.gated, private: info.private, disabled: info.disabled, hasToken },
      ...(facts ? { header: facts } : {}),
      ...(header.error ? { headerError: header.error } : {}),
      allFilesHashed: [...choice.files, ...(projector ? [projector] : [])].every((file) =>
        Boolean(file.sha256),
      ),
      ...(fit ? { fit } : {}),
      ...(disk ? { disk } : {}),
      ...(backendGap ? { backendGap } : {}),
    });
    const blocked = modelImportBlocked(checks);
    const parameterSize = facts
      ? ggufParameterSize(facts, { sizeBytes: choice.sizeBytes })
      : undefined;
    const catalogMatch = await this.findGgufCatalogMatch(choice);
    const settings = facts
      ? await this.settingsFor({
          baseModels: [...info.baseModels, ...(facts.baseModels ?? [])],
          engine: 'llama-cpp',
          ...(parameterSize ? { parameterSize } : {}),
          ...(catalogMatch ? { exactDonor: catalogMatch.id } : {}),
        })
      : { tuning: { from: 'defaults' as const } };

    let manifest: ChatModelManifest | undefined;
    if (facts && !blocked) {
      try {
        manifest = buildImportedChatModelManifest({
          repo,
          revision: commit,
          choice,
          ...(projector ? { projector } : {}),
          header: facts,
          ...(info.license ? { license: info.license } : {}),
          ...(settings.sampling ? { sampling: settings.sampling } : {}),
          reviewedAt: (this.opts.now?.() ?? new Date()).toISOString(),
        });
      } catch (err) {
        log.warn(
          `[model-import] ${repo} ${choice.key}: no manifest — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const id = manifest?.id ?? importedChatModelId(repo, choice.key, choice.quant);
    const alreadyInstalled = Boolean(
      await this.opts.llamaCppModels.resolveModel(id).catch(() => null),
    );
    const choices: ModelImportFileChoice[] = layout.choices.map((candidate) => {
      const candidateFit = ggufChoiceFit(candidate, facts, moe, projector?.sizeBytes, memory);
      return {
        key: candidate.key,
        ...(candidate.quant ? { quant: candidate.quant } : {}),
        sizeBytes: candidate.sizeBytes,
        fileCount: candidate.files.length,
        ...(candidateFit ? { fit: fitSummary(candidateFit) } : {}),
      };
    });
    const license = info.license ?? facts?.license;
    const author = facts?.organization ?? info.author;
    const review: ModelImportReview = {
      source: { kind: 'huggingface', repo, revision: commit, url: huggingFaceModelUrl(repo) },
      engine: 'llama-cpp',
      id,
      name: manifest?.name ?? importedChatModelName(repo, facts, choice.quant),
      ...(author ? { author: author.slice(0, 120) } : {}),
      ...(license ? { license: license.slice(0, 120) } : {}),
      selectedFile: choice.key,
      choices,
      ...(projector ? { projector: { path: projector.path, sizeBytes: projector.sizeBytes } } : {}),
      details: {
        ...(facts?.architecture ? { architecture: facts.architecture } : {}),
        ...(parameterSize ? { parameterSize } : {}),
        ...(facts?.contextLength ? { contextWindow: facts.contextLength } : {}),
        ...(choice.quant ? { quantization: choice.quant } : {}),
        supportsTools: chatTemplateSupportsTools(facts?.chatTemplate),
        thinks: chatTemplateThinks(facts?.chatTemplate),
        mixtureOfExperts: moe,
        vision: Boolean(projector),
      },
      tuning: settings.tuning,
      downloadBytes,
      checks,
      blocked,
      alreadyInstalled,
      ...(catalogMatch ? { catalogMatch } : {}),
    };
    return {
      at: Date.now(),
      engine: 'llama-cpp',
      review,
      ...(manifest ? { manifest } : {}),
      ...(settings.donor ? { tuningFrom: settings.donor.id } : {}),
    };
  }

  private async readHeader(
    repo: string,
    commit: string,
    choice: GgufChoice,
    gated: boolean,
  ): Promise<{ facts?: GgufHeaderFacts; error?: string }> {
    const first = choice.files[0];
    if (!first) return { error: 'the repository lists no file for this choice' };
    try {
      const facts = await readRemoteGgufHeader({
        fetchImpl: this.fetchImpl,
        repo,
        commit,
        path: first.path,
        sizeBytes: first.sizeBytes,
      });
      return { facts };
    } catch (err) {
      // A gated file refused despite a token: the account has not accepted
      // the terms. That belongs in the checks, not as a failed review.
      if (err instanceof HubRequestError && !(gated && [401, 403, 404].includes(err.status))) {
        throw err;
      }
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** A curated catalog entry that pins exactly these bytes, by the first file's SHA-256. */
  private async findGgufCatalogMatch(
    choice: GgufChoice,
  ): Promise<{ id: string; name: string } | undefined> {
    const sha = choice.files[0]?.sha256;
    if (!sha) return undefined;
    for (const manifest of await catalogChatModels(this.opts.catalog)) {
      if (isImportedChatModel(manifest)) continue;
      const src = manifest.llamaCpp;
      const pinned = src?.sha256 ?? src?.shards?.[0]?.sha256;
      if (pinned && pinned.toLowerCase() === sha) return { id: manifest.id, name: manifest.name };
    }
    return undefined;
  }

  private async settingsFor(opts: {
    baseModels: string[];
    engine: ModelImportEngine;
    parameterSize?: string;
    generationConfig?: unknown;
    /** The catalog pins these very bytes: borrow its settings outright. */
    exactDonor?: string;
  }): Promise<ImportSettings> {
    if (opts.exactDonor) {
      const donor = (await catalogChatModels(this.opts.catalog)).find(
        (manifest) => manifest.id === opts.exactDonor,
      );
      if (donor) {
        return { donor, tuning: { from: 'catalog', catalogId: donor.id, catalogName: donor.name } };
      }
    }
    return resolveImportSettings({
      catalog: this.opts.catalog,
      baseModels: [...new Set(opts.baseModels)],
      engine: opts.engine,
      ...(opts.parameterSize ? { parameterSize: opts.parameterSize } : {}),
      ...(opts.generationConfig !== undefined ? { generationConfig: opts.generationConfig } : {}),
      fetchImpl: this.fetchImpl,
    });
  }

  // ── MLX ──

  private async analyzeMlx(
    ref: ImportRef,
    repo: string,
    commit: string,
    info: HubModelInfo,
    tree: HubRepoFile[],
    roots: string[],
  ): Promise<Analysis> {
    if (ref.mlxRoot !== undefined && !roots.includes(ref.mlxRoot)) {
      throw new HubRequestError('The repository has no MLX model in that folder.', 404);
    }
    const builds = roots.map((root) => {
      const files = selectMlxFiles(tree, root);
      return { root, files, sizeBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0) };
    });
    const wantedQuant = ref.quant?.toLowerCase();
    const build =
      builds.find((candidate) => candidate.root === ref.mlxRoot) ??
      (wantedQuant
        ? builds.find((candidate) => candidate.root.toLowerCase() === wantedQuant)
        : undefined) ??
      builds.find((candidate) => candidate.root === '') ??
      builds.find((candidate) => /(^|[^0-9])4.?bit/i.test(candidate.root)) ??
      (builds[0] as (typeof builds)[number]);

    const hasToken = this.hasToken();
    const readable = !info.gated || hasToken;
    const prefix = build.root ? `${build.root}/` : '';

    // Configs are read in full; every small file without a published LFS
    // checksum is fetched and hashed here, at the pinned commit, so the
    // installer can verify it like any other file.
    const fetched = new Map<string, Buffer>();
    let configError: string | undefined;
    const files: HubRepoFile[] = [];
    if (readable) {
      let budget = MLX_SMALL_FILES_TOTAL_BYTES;
      try {
        for (const file of build.files) {
          const name = file.path.slice(prefix.length);
          const wantedConfig = (MLX_CONFIG_FILES as readonly string[]).includes(name);
          if (!wantedConfig && file.sha256) {
            files.push(file);
            continue;
          }
          if (file.sizeBytes > MLX_SMALL_FILE_BYTES || file.sizeBytes > budget) {
            files.push(file);
            continue;
          }
          const bytes = await fetchHubSmallFile(
            this.fetchImpl,
            repo,
            commit,
            file.path,
            MLX_SMALL_FILE_BYTES,
          );
          budget -= bytes.length;
          fetched.set(name, bytes);
          files.push({ ...file, sizeBytes: bytes.length, sha256: file.sha256 ?? sha256(bytes) });
        }
      } catch (err) {
        if (
          err instanceof HubRequestError &&
          !(info.gated && [401, 403, 404].includes(err.status))
        ) {
          throw err;
        }
        configError = err instanceof Error ? err.message : String(err);
      }
    } else {
      configError = "Hugging Face shares this model only after you accept the author's terms.";
    }

    const config = parseJson(fetched.get('config.json'));
    if (readable && !configError && (!config || typeof config !== 'object')) {
      configError = 'config.json is missing or is not valid JSON';
    }
    if (readable && !configError && !looksLikeMlx(info, repo, config)) {
      throw new HubRequestError(
        'This repository holds the original weights, not a build made for llama.cpp (GGUF) or MLX. Look for a version ending in "-GGUF", or one from mlx-community.',
        422,
      );
    }
    const facts: MlxConfigFacts | undefined =
      config && typeof config === 'object'
        ? mlxConfigFacts({
            config,
            tokenizerConfig: parseJson(fetched.get('tokenizer_config.json')),
            ...(fetched.get('chat_template.jinja')
              ? { chatTemplateJinja: fetched.get('chat_template.jinja')?.toString('utf8') }
              : {}),
            chatTemplateJson: parseJson(fetched.get('chat_template.json')),
            processorConfigs: [
              parseJson(fetched.get('processor_config.json')),
              parseJson(fetched.get('preprocessor_config.json')),
            ].filter(Boolean),
          })
        : undefined;
    const geometry =
      config && typeof config === 'object'
        ? mlxModelGeometryFromConfig(config as Record<string, unknown>)
        : undefined;
    const kv = geometry ? kvGeometryFromInput(geometry) : undefined;
    const memory = await this.memory();
    const moe = (facts?.expertCount ?? 0) > 1;
    const fitOf = (sizeBytes: number) =>
      importFit({ engine: 'mlx', weightsBytes: sizeBytes, kv, moe, memory });
    const fit = fitOf(build.sizeBytes);
    const disk = await this.disk('mlx', build.sizeBytes);
    const appleSilicon =
      this.opts.appleSilicon?.() ?? (process.platform === 'darwin' && process.arch === 'arm64');

    const checks = buildMlxImportChecks({
      access: { gated: info.gated, private: info.private, disabled: info.disabled, hasToken },
      ...(facts ? { config: facts } : {}),
      ...(configError ? { configError } : {}),
      allFilesHashed:
        files.length === build.files.length && files.every((file) => Boolean(file.sha256)),
      appleSilicon,
      ...(fit ? { fit } : {}),
      ...(disk ? { disk } : {}),
    });
    const blocked = modelImportBlocked(checks);
    const parameterSize = facts ? mlxParameterSize(repo, facts, build.sizeBytes) : undefined;
    const settings = facts
      ? await this.settingsFor({
          baseModels: info.baseModels,
          engine: 'mlx',
          ...(parameterSize ? { parameterSize } : {}),
          generationConfig: parseJson(fetched.get('generation_config.json')),
        })
      : { tuning: { from: 'defaults' as const } };

    let manifest: ChatModelManifest | undefined;
    if (facts && parameterSize && !blocked) {
      try {
        manifest = buildImportedMlxManifest({
          repo,
          revision: commit,
          root: build.root,
          files,
          facts,
          parameterSize,
          ...(info.license ? { license: info.license } : {}),
          ...(settings.sampling ? { sampling: settings.sampling } : {}),
          ...(kv?.kvBytesPerTokenF16 ? { kvBytesPerTokenF16: kv.kvBytesPerTokenF16 } : {}),
          ...(kv?.kvBytesPerTokenF16 && kv.kvFixedBytesF16 !== undefined
            ? { kvFixedBytesF16: kv.kvFixedBytesF16 }
            : {}),
          reviewedAt: (this.opts.now?.() ?? new Date()).toISOString(),
        });
      } catch (err) {
        log.warn(
          `[model-import] ${repo} ${build.root || '.'}: no manifest — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const id = manifest?.id ?? importedChatModelId(repo, build.root || '.', 'mlx');
    const alreadyInstalled = Boolean(await this.opts.mlxModels?.resolveModel(id).catch(() => null));
    const name =
      manifest?.name ??
      `${importedChatModelName(build.root ? `${repo}/${build.root}` : repo, undefined)} (MLX)`;
    const review: ModelImportReview = {
      source: { kind: 'huggingface', repo, revision: commit, url: huggingFaceModelUrl(repo) },
      engine: 'mlx',
      id,
      name,
      ...(info.author ? { author: info.author.slice(0, 120) } : {}),
      ...(info.license ? { license: info.license.slice(0, 120) } : {}),
      selectedFile: build.root,
      choices: builds.map((candidate) => {
        const candidateFit = fitOf(candidate.sizeBytes);
        return {
          key: candidate.root,
          quant: candidate.root || (facts ? mlxQuantizationLabel(facts) : 'MLX'),
          sizeBytes: candidate.sizeBytes,
          fileCount: candidate.files.length,
          ...(candidateFit ? { fit: fitSummary(candidateFit) } : {}),
        };
      }),
      details: {
        ...(facts?.modelType ? { architecture: facts.modelType } : {}),
        ...(parameterSize ? { parameterSize } : {}),
        ...(facts?.contextLength ? { contextWindow: facts.contextLength } : {}),
        ...(facts ? { quantization: mlxQuantizationLabel(facts) } : {}),
        supportsTools: chatTemplateSupportsTools(facts?.chatTemplate),
        thinks: chatTemplateThinks(facts?.chatTemplate),
        mixtureOfExperts: moe,
        vision: Boolean(facts?.vision),
      },
      tuning: settings.tuning,
      downloadBytes: build.sizeBytes,
      checks,
      blocked,
      alreadyInstalled,
    };
    return {
      at: Date.now(),
      engine: 'mlx',
      review,
      ...(manifest ? { manifest } : {}),
      ...(settings.donor ? { tuningFrom: settings.donor.id } : {}),
    };
  }
}

function fitSummary(fit: ModelFitResult): NonNullable<ModelImportFileChoice['fit']> {
  return { tier: fit.tier, label: fit.label, detail: fit.detail, runnable: fit.runnable };
}

function analysisKey(repo: string, commit: string, file: string): string {
  return `${repo.toLowerCase()}@${commit}:${file}`;
}
