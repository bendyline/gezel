/**
 * Adding GGUF files that are already on this computer (downloaded by another
 * app, converted by hand). The client streams each file in; the daemon never
 * opens a path it was handed, because in a machine-wide install it runs as a
 * service account that cannot read the person's files, and because a path is
 * not consent to read it.
 *
 * Received bytes are hashed as they arrive and staged privately under
 * `.transactions/local-model-imports/<id>/`. The review reads the staged
 * header and runs the same checks a Hugging Face file gets (minus the Hub's
 * own), and confirming publishes the staged folder as the model, with the
 * checksums recorded on the way in. Nothing touches the model store until
 * the person confirms.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  type ChatModelManifest,
  type GgufHeaderFacts,
  type HubRepoFile,
  IMPORTED_CHAT_MODEL_ENTRY_FILE,
  LOCAL_FILE_SOURCE_REPO,
  type LocalModelImportStatus,
  type ModelImportConfirmResponse,
  type ModelImportReview,
  buildLocalGgufManifest,
  buildModelImportChecks,
  chatTemplateSupportsTools,
  chatTemplateThinks,
  createLogger,
  ggufParameterSize,
  ggufQuantFromFilename,
  importedChatModelName,
  isImportedChatModel,
  layoutGgufRepo,
  localFileChatModelId,
  modelImportBlocked,
  pickGgufProjector,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { safeJoin } from '../../fs/safe-paths.js';
import { ggufQuantizationTag } from '../../providers/llama-cpp/gguf-metadata.js';
import type { LlamaCppModelManager } from '../../providers/llama-cpp/models.js';
import { type MemoryProfile, detectMemoryProfileCached } from '../../system/memory.js';
import { checkDiskSpace } from '../../utils/disk-space.js';
import { modelStorageRoots } from '../storage-roots.js';
import { writeImportedModelEntryInto } from './entry-store.js';
import { HubRequestError } from './hub.js';
import { readLocalGgufHeader } from './remote-header.js';
import { catalogChatModels, ggufChoiceFit, resolveImportSettings } from './shared.js';

const log = createLogger('model-import');

const IMPORT_TTL_MS = 24 * 60 * 60_000;
const MAX_FILES = 32;
/** Larger than any model a desktop runs; a bigger upload is a mistake or an attack. */
const MAX_FILE_BYTES = 2 * 1024 ** 4;
const SAFE_FILE_NAME = /^[A-Za-z0-9_+()[\]][A-Za-z0-9_.+()[\] -]{0,199}\.gguf$/i;
const IMPORT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface StagedFile {
  name: string;
  sizeBytes: number;
  sha256: string;
}

interface StagedState {
  createdAt: string;
  files: StagedFile[];
}

/** A file being received right now, for the progress poll. */
interface Receiving {
  name: string;
  bytes: number;
}

export interface LocalModelImportsOptions {
  home: string;
  catalog: CatalogService;
  llamaCppModels: Pick<LlamaCppModelManager, 'resolveModel' | 'importModelBundle'>;
  memoryProfile?: () => Promise<MemoryProfile | null>;
  now?: () => Date;
}

export class LocalModelImports {
  private readonly opts: LocalModelImportsOptions;
  private readonly root: string;
  private readonly receiving = new Map<string, Receiving>();
  /** Imports with a confirm in flight; a second confirm or a cancel waits its turn. */
  private readonly busy = new Set<string>();

  constructor(opts: LocalModelImportsOptions) {
    this.opts = opts;
    this.root = join(opts.home, '.transactions', 'local-model-imports');
  }

  /** Start an import; files are then sent one at a time with {@link receive}. */
  async create(): Promise<{ importId: string }> {
    await this.cleanupExpired();
    const importId = randomUUID();
    const stage = this.stagePath(importId);
    await mkdir(join(stage, 'files'), { recursive: true });
    await this.writeState(importId, { createdAt: new Date().toISOString(), files: [] });
    return { importId };
  }

  /** Stream one GGUF in, hashing as it lands. */
  async receive(
    importId: string,
    name: string,
    input: Readable,
    opts: { signal?: AbortSignal } = {},
  ): Promise<StagedFile> {
    if (!SAFE_FILE_NAME.test(name) || name.includes('..')) {
      throw new HubRequestError('Only .gguf files with ordinary names can be added.', 400);
    }
    const state = await this.readState(importId);
    if (state.files.some((file) => file.name === name)) {
      throw new HubRequestError(`${name} was already added.`, 409);
    }
    if (state.files.length >= MAX_FILES) {
      throw new HubRequestError(`Add at most ${MAX_FILES} files at a time.`, 400);
    }
    if (this.receiving.has(importId) || this.busy.has(importId)) {
      throw new HubRequestError('Another file is still arriving. Send one at a time.', 409);
    }
    const target = this.filePath(importId, name);
    const partial = `${target}.partial`;
    const progress: Receiving = { name, bytes: 0 };
    this.receiving.set(importId, progress);
    const hasher = createHash('sha256');
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        progress.bytes += chunk.byteLength;
        if (progress.bytes > MAX_FILE_BYTES) {
          callback(new HubRequestError('That file is larger than any model Gezel can run.', 413));
          return;
        }
        hasher.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(input, meter, createWriteStream(partial, { flags: 'wx' }), {
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      await rename(partial, target);
    } catch (err) {
      await rm(partial, { force: true }).catch(() => {});
      throw err;
    } finally {
      this.receiving.delete(importId);
    }
    const staged: StagedFile = { name, sizeBytes: progress.bytes, sha256: hasher.digest('hex') };
    const latest = await this.readState(importId);
    await this.writeState(importId, { ...latest, files: [...latest.files, staged] });
    return staged;
  }

  async status(importId: string): Promise<LocalModelImportStatus> {
    const state = await this.readState(importId);
    const current = this.receiving.get(importId);
    const files = [
      ...state.files.map((file) => ({
        name: file.name,
        sizeBytes: file.sizeBytes,
        complete: true,
      })),
      ...(current ? [{ name: current.name, sizeBytes: current.bytes, complete: false }] : []),
    ];
    return {
      importId,
      files,
      bytesReceived: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    };
  }

  /** Check what arrived: one model (any shards and a vision projector), and whether it passes. */
  async review(importId: string): Promise<ModelImportReview> {
    return (await this.analyze(importId)).review;
  }

  /**
   * Publish the staged files as the model, with its catalog entry beside it.
   * Refuses a review with a failed check. Nothing downloads.
   */
  async confirm(importId: string): Promise<ModelImportConfirmResponse> {
    if (this.busy.has(importId))
      throw new HubRequestError('This model is already being added.', 409);
    if (this.receiving.has(importId))
      throw new HubRequestError('A file is still arriving. Add the model once it is here.', 409);
    this.busy.add(importId);
    try {
      const { review, manifest, tuningFrom, header, choiceFiles, projector } =
        await this.analyze(importId);
      if (review.blocked || !manifest || !header) {
        const failed = review.checks.find((item) => item.status === 'fail');
        throw new HubRequestError(
          failed ? `${failed.title}: ${failed.detail}` : 'This model did not pass its checks.',
          409,
        );
      }
      const staged = join(this.stagePath(importId), 'files');
      await writeImportedModelEntryInto(staged, manifest, tuningFrom);
      const state = await this.readState(importId);
      const keep = new Set([...choiceFiles, ...(projector ? [projector] : [])]);
      // Everything else in the folder goes, not just the files the review
      // saw: a `.partial` a crashed upload left would otherwise be published.
      for (const name of await readdir(staged)) {
        if (keep.has(name) || name === IMPORTED_CHAT_MODEL_ENTRY_FILE) continue;
        await rm(join(staged, name), { recursive: true, force: true });
      }
      const first = choiceFiles[0] as string;
      const sha = (name: string) => state.files.find((file) => file.name === name)?.sha256 ?? '';
      const size = (name: string) => state.files.find((file) => file.name === name)?.sizeBytes ?? 0;
      const quantization = ggufQuantizationTag({
        ...(header.fileTypeName ? { fileTypeName: header.fileTypeName } : {}),
      });
      const installedManifest = {
        id: manifest.id,
        name: manifest.name,
        approxSizeBytes: choiceFiles.reduce((sum, name) => sum + size(name), 0),
        weightsFilename: first,
        sha256: sha(first),
        ...(choiceFiles.length > 1
          ? {
              shards: choiceFiles.map((name) => ({
                filename: name,
                sha256: sha(name),
                sizeBytes: size(name),
              })),
            }
          : {}),
        ...(projector ? { mmprojFilename: projector } : {}),
        installedAt: new Date().toISOString(),
        catalogId: manifest.id,
        catalogVersion: manifest.version,
        huggingfaceRepo: LOCAL_FILE_SOURCE_REPO,
        ...(manifest.llamaCpp?.quantization
          ? { quantization: manifest.llamaCpp.quantization }
          : {}),
        ...(quantization ? { ggufQuantization: quantization } : {}),
        ...(header.contextLength ? { contextWindow: header.contextLength } : {}),
        ...(header.architecture ? { architecture: header.architecture } : {}),
        chatTemplatePresent: Boolean(header.chatTemplate),
      };
      const precomputedSha256 = Object.fromEntries(
        [...keep].map((name) => [name, sha(name)] as const),
      );
      await this.opts.llamaCppModels.importModelBundle({
        id: manifest.id,
        stagedModelDir: staged,
        installedManifest,
        replace: review.alreadyInstalled,
        precomputedSha256,
      });
      await rm(this.stagePath(importId), { recursive: true, force: true }).catch(() => {});
      log.info(
        `[model-import] added ${manifest.id} from ${choiceFiles.length} local file(s)${tuningFrom ? `, settings from ${tuningFrom}` : ''}`,
      );
      return { engine: 'llama-cpp', id: manifest.id, name: manifest.name, installed: true };
    } finally {
      this.busy.delete(importId);
    }
  }

  async cancel(importId: string): Promise<void> {
    if (this.busy.has(importId))
      throw new HubRequestError('This model is already being added.', 409);
    await rm(this.stagePath(importId), { recursive: true, force: true });
  }

  private async analyze(importId: string): Promise<{
    review: ModelImportReview;
    manifest?: ChatModelManifest;
    tuningFrom?: string;
    header?: GgufHeaderFacts;
    choiceFiles: string[];
    projector?: string;
  }> {
    const state = await this.readState(importId);
    if (state.files.length === 0) throw new HubRequestError('Add a .gguf file first.', 400);
    const files: HubRepoFile[] = state.files.map((file) => ({
      path: file.name,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
    }));
    const layout = layoutGgufRepo(files);
    if (layout.incompleteSplits.length > 0) {
      throw new HubRequestError(
        `Part of a split model is missing (${layout.incompleteSplits[0]}). Add every part of it together.`,
        422,
      );
    }
    if (layout.choices.length === 0) {
      throw new HubRequestError(
        'None of these files is a model. Add the main .gguf file too.',
        422,
      );
    }
    if (layout.choices.length > 1) {
      throw new HubRequestError(
        'These files hold more than one model. Add one model at a time (its parts and, if it has one, its vision file).',
        422,
      );
    }
    const choice = layout.choices[0] as (typeof layout.choices)[number];
    const projector = pickGgufProjector(layout.projectors);
    const first = choice.files[0] as HubRepoFile;
    let header: GgufHeaderFacts | undefined;
    let headerError: string | undefined;
    try {
      header = readLocalGgufHeader(this.filePath(importId, first.path));
    } catch (err) {
      headerError = err instanceof Error ? err.message : String(err);
    }
    const memory = await (this.opts.memoryProfile ?? (() => detectMemoryProfileCached()))().catch(
      () => null,
    );
    const moe = (header?.expertCount ?? 0) > 1;
    const fit = ggufChoiceFit(choice, header, moe, projector?.sizeBytes, memory);
    const copyBytes = choice.sizeBytes + (projector?.sizeBytes ?? 0);
    const disk = await checkDiskSpace(
      modelStorageRoots({ home: this.opts.home, engine: 'llama-cpp' }).writableRoot,
      // The staged copy is moved, not copied again, when both sit on one disk.
      0,
    ).catch(() => null);
    const checks = buildModelImportChecks({
      ...(header ? { header } : {}),
      ...(headerError ? { headerError } : {}),
      allFilesHashed: true,
      localFile: true,
      ...(fit ? { fit } : {}),
      ...(disk?.known
        ? {
            disk: {
              ok: disk.ok,
              downloadBytes: copyBytes,
              neededBytes: disk.requiredBytes,
              freeBytes: disk.freeBytes,
            },
          }
        : {}),
    });
    const blocked = modelImportBlocked(checks);
    const parameterSize = header
      ? ggufParameterSize(header, { sizeBytes: choice.sizeBytes })
      : undefined;
    const catalogMatch = await this.findCatalogMatch(first.sha256 as string);
    const settings = catalogMatch
      ? {
          donor: catalogMatch,
          tuning: {
            from: 'catalog' as const,
            catalogId: catalogMatch.id,
            catalogName: catalogMatch.name,
          },
        }
      : header
        ? await resolveImportSettings({
            catalog: this.opts.catalog,
            baseModels: header.baseModels ?? [],
            engine: 'llama-cpp',
            ...(parameterSize ? { parameterSize } : {}),
          })
        : { tuning: { from: 'defaults' as const } };
    let manifest: ChatModelManifest | undefined;
    if (header && !blocked) {
      manifest = buildLocalGgufManifest({
        choice,
        ...(projector ? { projector } : {}),
        header,
        reviewedAt: (this.opts.now?.() ?? new Date()).toISOString(),
      });
    }
    const id = manifest?.id ?? localFileChatModelId(first.path, first.sha256 as string);
    const alreadyInstalled = Boolean(
      await this.opts.llamaCppModels.resolveModel(id).catch(() => null),
    );
    const quant = choice.quant ?? ggufQuantFromFilename(first.path);
    const review: ModelImportReview = {
      source: {
        kind: 'local-file',
        importId,
        files: state.files.map((file) => ({ name: file.name, sizeBytes: file.sizeBytes })),
      },
      engine: 'llama-cpp',
      id,
      name: manifest?.name ?? importedChatModelName(first.path, header, quant),
      ...(header?.organization ? { author: header.organization.slice(0, 120) } : {}),
      ...(header?.license ? { license: header.license.slice(0, 120) } : {}),
      selectedFile: choice.key,
      choices: [],
      ...(projector ? { projector: { path: projector.path, sizeBytes: projector.sizeBytes } } : {}),
      details: {
        ...(header?.architecture ? { architecture: header.architecture } : {}),
        ...(parameterSize ? { parameterSize } : {}),
        ...(header?.contextLength ? { contextWindow: header.contextLength } : {}),
        ...(quant ? { quantization: quant } : {}),
        supportsTools: chatTemplateSupportsTools(header?.chatTemplate),
        thinks: chatTemplateThinks(header?.chatTemplate),
        mixtureOfExperts: moe,
        vision: Boolean(projector),
      },
      tuning: settings.tuning,
      downloadBytes: copyBytes,
      checks,
      blocked,
      alreadyInstalled,
      ...(catalogMatch ? { catalogMatch: { id: catalogMatch.id, name: catalogMatch.name } } : {}),
    };
    return {
      review,
      ...(manifest ? { manifest } : {}),
      ...(settings.donor ? { tuningFrom: settings.donor.id } : {}),
      ...(header ? { header } : {}),
      choiceFiles: choice.files.map((file) => file.path),
      ...(projector ? { projector: projector.path } : {}),
    };
  }

  /** A curated entry that pins exactly these bytes: its settings are this file's. */
  private async findCatalogMatch(sha: string): Promise<ChatModelManifest | undefined> {
    for (const manifest of await catalogChatModels(this.opts.catalog)) {
      if (isImportedChatModel(manifest)) continue;
      const pinned = manifest.llamaCpp?.sha256 ?? manifest.llamaCpp?.shards?.[0]?.sha256;
      if (pinned && pinned.toLowerCase() === sha) return manifest;
    }
    return undefined;
  }

  private stagePath(importId: string): string {
    if (!IMPORT_ID.test(importId)) throw new HubRequestError('That import is not valid.', 400);
    const stage = safeJoin(this.root, importId);
    if (!stage) throw new HubRequestError('That import is not valid.', 400);
    return stage;
  }

  private filePath(importId: string, name: string): string {
    const path = safeJoin(join(this.stagePath(importId), 'files'), name);
    if (!path) throw new HubRequestError('That file name is not valid.', 400);
    return path;
  }

  private async readState(importId: string): Promise<StagedState> {
    const raw = await readFile(join(this.stagePath(importId), 'state.json'), 'utf8').catch(
      () => null,
    );
    if (raw === null) {
      throw new HubRequestError('That import has ended. Choose the files again.', 404);
    }
    const state = JSON.parse(raw) as StagedState;
    if (Date.now() - Date.parse(state.createdAt) > IMPORT_TTL_MS) {
      await rm(this.stagePath(importId), { recursive: true, force: true }).catch(() => {});
      throw new HubRequestError('That import has ended. Choose the files again.', 404);
    }
    return state;
  }

  private async writeState(importId: string, state: StagedState): Promise<void> {
    await writeFile(
      join(this.stagePath(importId), 'state.json'),
      `${JSON.stringify(state, null, 2)}\n`,
      'utf8',
    );
  }

  private async cleanupExpired(): Promise<void> {
    const ids = await readdir(this.root).catch(() => [] as string[]);
    for (const id of ids) {
      if (!IMPORT_ID.test(id) || this.busy.has(id) || this.receiving.has(id)) continue;
      const stage = join(this.root, id);
      const info = await stat(stage).catch(() => null);
      if (info && Date.now() - info.mtimeMs > IMPORT_TTL_MS) {
        await rm(stage, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
