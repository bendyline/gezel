import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import {
  type ChatModelManifest,
  type GezmodelEngine,
  type GezmodelImportReview,
  GezmodelImportReviewSchema,
  type SharedModelMigrationCandidate,
  SharedModelMigrationCandidateSchema,
  type SharedModelMigrationRequest,
  type SharedModelMigrationResult,
  type SharedModelMigrationSource,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import type { MachineEngineBridge } from '../machine-engine/bridge.js';
import { LlamaCppModelManager } from '../providers/llama-cpp/models.js';
import { MlxModelManager } from '../providers/mlx/models.js';
import { GezmodelManager } from './gezmodel.js';

interface ModelSummary {
  id: string;
  name: string;
  approxSizeBytes: number;
  catalogVersion?: string;
  readOnly?: boolean;
}

interface MigrationModelOwner {
  listInstalled(): Promise<ModelSummary[]>;
  resolveModel(id: string): Promise<ModelSummary | null>;
  delete(id: string): Promise<void>;
  getModelBundleSource: LlamaCppModelManager['getModelBundleSource'];
  importModelBundle: LlamaCppModelManager['importModelBundle'];
}

interface MigrationManagers {
  owners: Record<GezmodelEngine, MigrationModelOwner>;
  bundles: GezmodelManager;
}

export interface SharedModelSourceHome {
  source: SharedModelMigrationSource;
  label: string;
  home: string;
}

interface SharedModelMigrationManagerOptions {
  home: string;
  catalog: CatalogService;
  llamaCpp: LlamaCppModelManager;
  mlx: MlxModelManager;
  ds4: LlamaCppModelManager;
  machineEngine?: MachineEngineBridge;
  /** Deterministic source set for tests; production uses Gezel's known homes. */
  sourceHomes?: SharedModelSourceHome[];
}

const SOURCE_PREFIX = '/api/model-bundles';
const TARGET_PREFIX = '/v1/remote/manage/model-bundles';

/**
 * Moves complete, current models from a user-owned store into the installed
 * machine broker's shared store.
 *
 * The broker never receives a user path. Instead, this user daemon exports a
 * hash-pinned `.gezmodel` stream, lets the broker security-scan and atomically
 * publish it, then deletes the private copy only after publish succeeds.
 */
export class SharedModelMigrationManager {
  private readonly options: SharedModelMigrationManagerOptions;
  private readonly sources: SharedModelSourceHome[];
  private readonly managerCache = new Map<string, MigrationManagers>();
  private readonly inFlight = new Set<string>();

  constructor(options: SharedModelMigrationManagerOptions) {
    this.options = options;
    this.sources = options.sourceHomes ?? defaultSourceHomes(options.home);
  }

  isAvailable(): boolean {
    return this.options.machineEngine?.isConnected() === true;
  }

  async listCandidates(engine?: GezmodelEngine): Promise<SharedModelMigrationCandidate[]> {
    if (!this.isAvailable()) return [];
    const candidates: SharedModelMigrationCandidate[] = [];
    for (const source of this.sources) {
      if (
        resolve(source.home) !== resolve(this.options.home) &&
        (await daemonIsRunning(source.home))
      ) {
        continue;
      }
      const managers = this.managersFor(source.home);
      const engines: GezmodelEngine[] = engine ? [engine] : ['llama-cpp', 'mlx', 'ds4'];
      for (const candidateEngine of engines) {
        const installed = await managers.owners[candidateEngine].listInstalled().catch(() => []);
        for (const model of installed) {
          const candidate = await this.toCandidate(source, candidateEngine, model);
          if (candidate) candidates.push(candidate);
        }
      }
    }
    return candidates.sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        a.engine.localeCompare(b.engine) ||
        a.source.localeCompare(b.source),
    );
  }

  async move(request: SharedModelMigrationRequest): Promise<SharedModelMigrationResult> {
    const machineEngine = this.options.machineEngine;
    if (!machineEngine?.isConnected()) {
      throw new Error('the machine model service is not connected');
    }
    const source = this.sources.find((entry) => entry.source === request.source);
    if (!source) throw new Error('the requested model source is not available');
    if (
      resolve(source.home) !== resolve(this.options.home) &&
      (await daemonIsRunning(source.home))
    ) {
      throw new Error('that Gezel data folder is currently in use by another daemon');
    }

    const key = `${resolve(source.home)}\0${request.engine}\0${request.id}`;
    if (this.inFlight.has(key)) throw new Error('this model is already being moved');
    this.inFlight.add(key);
    let importId: string | undefined;
    try {
      const managers = this.managersFor(source.home);
      const model = await managers.owners[request.engine].resolveModel(request.id);
      const candidate = model && (await this.toCandidate(source, request.engine, model));
      if (!candidate) {
        throw new Error(
          'the model is missing, incomplete, shared already, or no longer up to date',
        );
      }

      const current = await this.options.catalog.get('chat-model', request.id);
      if (!current || current.manifest.kind !== 'chat-model') {
        throw new Error('the current catalog manifest is no longer available');
      }
      if (current.manifest.version !== candidate.catalogVersion) {
        throw new Error('the model is no longer up to date with the current catalog');
      }
      const bundle = await managers.bundles.export(request.engine, request.id);
      const bundleStream = bundle.stream as Readable;
      try {
        assertCatalogPayloadIntegrity(bundle.manifest, current.manifest, request.engine);
      } catch (error) {
        bundleStream.destroy();
        throw error;
      }
      const scanRequest = new Request(`http://gezel.local${SOURCE_PREFIX}/imports/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/vnd.gezel.model+zip' },
        body: Readable.toWeb(bundleStream) as ReadableStream<Uint8Array>,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      let review: GezmodelImportReview;
      try {
        const scanResponse = await machineEngine.proxy(scanRequest, SOURCE_PREFIX, TARGET_PREFIX);
        review = GezmodelImportReviewSchema.parse(await responseJson(scanResponse, 'scan'));
      } finally {
        // A broker disconnect can return before consuming the request body.
        // Close the ZIP stream in either case so no model file descriptor is
        // held after a failed move.
        bundleStream.destroy();
      }
      importId = review.importId;
      if (review.manifest.engine !== request.engine || review.manifest.id !== request.id) {
        throw new Error('the broker review did not match the requested model');
      }

      const confirmRequest = new Request(`http://gezel.local${SOURCE_PREFIX}/imports/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ importId, replace: review.alreadyInstalled }),
      });
      const confirmResponse = await machineEngine.proxy(
        confirmRequest,
        SOURCE_PREFIX,
        TARGET_PREFIX,
      );
      const published = await responseJson(confirmResponse, 'publish');
      if (
        !published ||
        typeof published !== 'object' ||
        !('ok' in published) ||
        published.ok !== true ||
        !('engine' in published) ||
        published.engine !== request.engine ||
        !('id' in published) ||
        published.id !== request.id
      ) {
        throw new Error('the broker publish response did not match the requested model');
      }
      importId = undefined;

      try {
        await managers.owners[request.engine].delete(request.id);
        return {
          ok: true,
          engine: request.engine,
          id: request.id,
          localRemoved: true,
        };
      } catch (error) {
        return {
          ok: true,
          engine: request.engine,
          id: request.id,
          localRemoved: false,
          warning: `The shared copy is ready, but Gezel could not remove the private copy: ${errorMessage(error)}`,
        };
      }
    } finally {
      if (importId) await this.cancelImport(machineEngine, importId);
      this.inFlight.delete(key);
    }
  }

  private async toCandidate(
    source: SharedModelSourceHome,
    engine: GezmodelEngine,
    model: ModelSummary,
  ): Promise<SharedModelMigrationCandidate | null> {
    if (model.readOnly || !model.catalogVersion) return null;
    const localDir = join(source.home, 'engines', engine, 'models', model.id);
    const info = await lstat(localDir).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return null;
    const detail = await this.options.catalog.get('chat-model', model.id).catch(() => null);
    if (!detail || detail.manifest.kind !== 'chat-model') return null;
    if (detail.manifest.version !== model.catalogVersion) return null;
    return SharedModelMigrationCandidateSchema.parse({
      source: source.source,
      sourceLabel: source.label,
      engine,
      id: model.id,
      name: model.name,
      approxSizeBytes: model.approxSizeBytes,
      catalogVersion: model.catalogVersion,
    });
  }

  private managersFor(home: string): MigrationManagers {
    const key = resolve(home);
    const cached = this.managerCache.get(key);
    if (cached) return cached;
    const isCurrent = key === resolve(this.options.home);
    const llamaCpp = isCurrent
      ? this.options.llamaCpp
      : new LlamaCppModelManager({ home, catalog: this.options.catalog });
    const mlx = isCurrent
      ? this.options.mlx
      : new MlxModelManager({ home, catalog: this.options.catalog });
    const ds4 = isCurrent
      ? this.options.ds4
      : new LlamaCppModelManager({ home, catalog: this.options.catalog, engine: 'ds4' });
    const owners = {
      'llama-cpp': llamaCpp,
      mlx,
      ds4,
    } as Record<GezmodelEngine, MigrationModelOwner>;
    const managers = {
      owners,
      bundles: new GezmodelManager({
        home,
        catalog: this.options.catalog,
        llamaCpp,
        mlx,
        ds4,
      }),
    };
    this.managerCache.set(key, managers);
    return managers;
  }

  private async cancelImport(machineEngine: MachineEngineBridge, importId: string): Promise<void> {
    const cancel = new Request(
      `http://gezel.local${SOURCE_PREFIX}/imports/${encodeURIComponent(importId)}`,
      { method: 'DELETE' },
    );
    await machineEngine.proxy(cancel, SOURCE_PREFIX, TARGET_PREFIX).catch(() => undefined);
  }
}

export function defaultSourceHomes(currentHome: string): SharedModelSourceHome[] {
  const sources: SharedModelSourceHome[] = [
    { source: 'current', label: 'This account', home: resolve(currentHome) },
  ];
  const seen = new Set([resolve(currentHome)]);
  const add = (source: SharedModelSourceHome) => {
    const path = resolve(source.home);
    if (seen.has(path)) return;
    seen.add(path);
    sources.push({ ...source, home: path });
  };
  add({ source: 'default', label: 'Regular Gezel data', home: join(homedir(), '.gezel') });
  add({
    source: 'development',
    label: 'Development Gezel data',
    home: join(homedir(), '.gezel-dev'),
  });
  return sources;
}

async function daemonIsRunning(home: string): Promise<boolean> {
  const raw = await readFile(join(home, 'runtime', 'pid'), 'utf8').catch(() => '');
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function responseJson(response: Response, phase: string): Promise<unknown> {
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  if (!response.ok) {
    const detail = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
    throw new Error(`machine model ${phase} failed: ${detail}`);
  }
  return payload;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The transport manifest proves bytes did not change in transit. This second
 * check proves the large model payload still matches the trusted, current
 * catalog pins before those bytes are admitted to the shared store.
 */
function assertCatalogPayloadIntegrity(
  bundle: import('@bendyline/gezel').GezmodelBundleManifest,
  catalog: ChatModelManifest,
  engine: GezmodelEngine,
): void {
  const payload = new Map(
    bundle.files
      .filter((file) => file.role === 'model')
      .map((file) => [file.path.slice('model/'.length), file] as const),
  );
  const requireHash = (path: string, expected: string, allowTransformed = false) => {
    const file = payload.get(path);
    if (!file) throw new Error(`model integrity check failed: required file is missing (${path})`);
    if (!allowTransformed && file.sha256 !== expected) {
      throw new Error(`model integrity check failed: ${path} does not match the current catalog`);
    }
  };

  if (engine === 'mlx') {
    const source = catalog.mlx;
    if (!source || source.disabledReason) {
      throw new Error('the current catalog no longer enables this model for MLX');
    }
    const expected = new Map(source.files.map((file) => [file.name, file.sha256]));
    const templateMayBeInjected = Boolean(
      source.chatTemplate ||
        source.files.some((file) => basename(file.name) === 'chat_template.jinja'),
    );
    for (const file of source.files) {
      requireHash(
        file.name,
        file.sha256,
        templateMayBeInjected && basename(file.name) === 'tokenizer_config.json',
      );
    }
    for (const [path] of payload) {
      if (path.toLowerCase().endsWith('.safetensors') && !expected.has(path)) {
        throw new Error(`model integrity check failed: unexpected weights file (${path})`);
      }
    }
    return;
  }

  const source = engine === 'ds4' ? catalog.ds4 : catalog.llamaCpp;
  if (!source) throw new Error(`the current catalog no longer enables this model for ${engine}`);
  const expected = new Map<string, string>();
  const required = new Set<string>();
  if (source.shards) {
    for (const shard of source.shards) {
      const path = basename(shard.name);
      expected.set(path, shard.sha256);
      required.add(path);
    }
  } else if (source.filename && source.sha256) {
    const path = basename(source.filename);
    expected.set(path, source.sha256);
    required.add(path);
  }
  if (engine === 'llama-cpp' && catalog.llamaCpp?.draftModel) {
    const draft = catalog.llamaCpp.draftModel;
    const path = basename(draft.filename);
    expected.set(path, draft.sha256);
    required.add(path);
  }
  if (engine === 'llama-cpp' && catalog.llamaCpp?.mmproj) {
    expected.set(basename(catalog.llamaCpp.mmproj.filename), catalog.llamaCpp.mmproj.sha256);
  }
  for (const path of required) requireHash(path, expected.get(path) as string);
  for (const [path, file] of payload) {
    if (!path.toLowerCase().endsWith('.gguf')) continue;
    const trusted = expected.get(path);
    if (!trusted) throw new Error(`model integrity check failed: unexpected GGUF file (${path})`);
    if (file.sha256 !== trusted) {
      throw new Error(`model integrity check failed: ${path} does not match the current catalog`);
    }
  }
}
