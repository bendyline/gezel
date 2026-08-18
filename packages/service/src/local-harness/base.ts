import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  type GezelConfig,
  type GezelSummary,
  type LocalHarnessModelOption,
  type ProviderName,
  externalGezelModelId,
} from '@bendyline/gezel';
import type { LocalBridgeController } from '../http/local-bridge.js';
import type { TokenRecord, TokenStore } from '../http/token-store.js';
import type { ModelInfo } from '../providers/types.js';

/**
 * The mechanical layer shared by every local-harness setup manager (Codex,
 * OpenCode, pi).
 *
 * What lives here is what is genuinely identical between them. What does not:
 * `configure`, `inspect`, and `reconcile`. Those diverge in ways that are
 * load-bearing — the backup-restore ordering depends on whether the published
 * artifact sits inside the integration directory that first-run cleanup wipes,
 * and the ownership proof is an in-file marker for artifacts written into the
 * harness's own home but a digest in Gezel's state for artifacts written into
 * Gezel's. A strategy interface over those would hide the distinction that
 * makes each one correct.
 */

/** Providers whose models run on this machine and can back a harness session. */
export const LOCAL_HARNESS_PROVIDERS = [
  'llama-cpp',
  'mlx',
  'ds4',
  'ollama',
] as const satisfies readonly ProviderName[];
export const LOCAL_HARNESS_PROVIDER_SET = new Set<ProviderName>(LOCAL_HARNESS_PROVIDERS);

export class HarnessSetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 500 = 409,
  ) {
    super(message);
    this.name = 'HarnessSetupError';
  }
}

/**
 * Serialize every mutation through one chain. Setup writes span several files
 * and a bridge lifecycle, so two overlapping calls could interleave a publish
 * with a teardown.
 */
export function createMutationQueue(): <T>(fn: () => Promise<T>) => Promise<T> {
  let mutation = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = mutation.then(fn, fn);
    mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export interface ListEligibleHarnessModelsOptions {
  config: GezelConfig;
  listModels: (provider: ProviderName) => Promise<ModelInfo[]>;
  listGezels: () => Promise<GezelSummary[]>;
  providerForGezel: (gezelId: string) => Promise<ProviderName>;
}

/**
 * Every gezel and raw local model that can safely sit behind a harness's
 * caller-executed tool loop. Gezels come first: they are the first-class
 * choice, and raw models remain for callers that deliberately want the harness
 * without a gezel persona.
 */
export async function listEligibleHarnessModels(
  opts: ListEligibleHarnessModelsOptions,
): Promise<LocalHarnessModelOption[]> {
  const groups = await Promise.all(
    LOCAL_HARNESS_PROVIDERS.map(async (provider) => {
      try {
        const models = await opts.listModels(provider);
        return models
          .filter((model) => model.supportsTools === true)
          .map(
            (model): LocalHarnessModelOption => ({
              id: `${provider}:${model.id}`,
              label: model.name || model.id,
              description: `Local ${provider} model`,
              kind: 'model',
              provider,
              ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
              ...(model.supportsReasoning !== undefined
                ? { supportsReasoning: model.supportsReasoning }
                : {}),
              supportsTools: true,
            }),
          );
      } catch {
        return [];
      }
    }),
  );
  const rawModels = groups.flat().sort((a, b) => a.label.localeCompare(b.label));
  const rawModelsByTarget = new Map(rawModels.map((model) => [model.id, model]));
  const gezels = await opts.listGezels().catch(() => []);
  const gezelModels = (
    await Promise.all(
      gezels.map(async (gezel): Promise<LocalHarnessModelOption | null> => {
        if (gezel.fixedFunction) return null;
        const provider = await opts.providerForGezel(gezel.id).catch(() => null);
        if (!provider || !LOCAL_HARNESS_PROVIDER_SET.has(provider)) return null;

        const modelId = gezel.model ?? opts.config.defaultModel?.[provider];
        if (!modelId) return null;
        const backingModel = rawModelsByTarget.get(`${provider}:${modelId}`);
        if (!backingModel) return null;

        return {
          id: externalGezelModelId(gezel),
          label: gezel.name,
          description: [gezel.role, backingModel.label].filter(Boolean).join(' · '),
          kind: 'gezel',
          provider,
          gezelId: gezel.id,
          ...(gezel.role ? { role: gezel.role } : {}),
          modelLabel: backingModel.label,
          ...(backingModel.contextWindow ? { contextWindow: backingModel.contextWindow } : {}),
          ...(backingModel.supportsReasoning !== undefined
            ? { supportsReasoning: backingModel.supportsReasoning }
            : {}),
          supportsTools: true,
        };
      }),
    )
  )
    .filter((model): model is LocalHarnessModelOption => model !== null)
    .sort((a, b) => a.label.localeCompare(b.label));

  return [...gezelModels, ...rawModels];
}

export function harnessBridgeSnapshot(bridge: LocalBridgeController): {
  baseUrl: string;
  listening: boolean;
  port: number;
} {
  const live = bridge.status();
  const port = live.port ?? bridge.desiredPort();
  const origin = bridge.baseUrl() ?? `http://127.0.0.1:${port}`;
  return { baseUrl: `${origin}/v1`, listening: live.listening, port };
}

/** The meester if it qualifies, else any gezel, else whatever is available. */
export function recommendedHarnessModel(
  models: LocalHarnessModelOption[],
  meesterGezelId?: string,
): string | undefined {
  return (
    models.find((model) => model.kind === 'gezel' && model.gezelId === meesterGezelId)?.id ??
    models.find((model) => model.kind === 'gezel')?.id ??
    models[0]?.id
  );
}

/**
 * Resolve a currently advertised harness model while retaining support for the
 * old `gezel:<persisted-id>` references already stored by existing setups and
 * for a prior role-name alias when stable setup metadata identifies the gezel.
 */
export function findHarnessModel(
  models: LocalHarnessModelOption[],
  ref: string,
  gezelId?: string,
): LocalHarnessModelOption | undefined {
  return (
    models.find((model) => model.id === ref) ??
    (gezelId
      ? models.find((model) => model.kind === 'gezel' && model.gezelId === gezelId)
      : undefined) ??
    models.find(
      (model) => model.kind === 'gezel' && model.gezelId && ref === `gezel:${model.gezelId}`,
    )
  );
}

const MAX_FILE_BACKUPS = 50;

/**
 * Exclusive create, never overwrite: the whole point of the backup is that a
 * file Gezel does not own survives, and that includes an earlier backup.
 */
export async function preserveConflictingFile(input: {
  path: string;
  content: string;
  mode: number;
  code: string;
}): Promise<string> {
  for (let attempt = 1; attempt <= MAX_FILE_BACKUPS; attempt++) {
    const candidate = attempt === 1 ? `${input.path}.backup` : `${input.path}.backup-${attempt}`;
    try {
      await writeFile(candidate, input.content, { mode: input.mode, flag: 'wx' });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  throw new HarnessSetupError(
    input.code,
    `Could not save a backup copy of ${input.path}. Move the existing backup files aside and try again.`,
  );
}

export function harnessTokenRecord(store: TokenStore, appId: string): TokenRecord | undefined {
  return store.list().find((record) => record.appId === appId);
}

/**
 * The app name is half the ownership proof: another app holding the reserved
 * id, or a record with widened scopes, is a credential conflict rather than
 * ours to reuse.
 */
export function isExactHarnessToken(
  record: TokenRecord | undefined,
  appName: string,
): record is TokenRecord {
  return record?.appName === appName && record.scopes.length === 1 && record.scopes[0] === 'openai';
}

export async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => {});
}

export function posixShellWord(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
