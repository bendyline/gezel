import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ConfigureOpenCodeRequest,
  GezelConfig,
  GezelSummary,
  OpenCodeSetupModelOption,
  OpenCodeSetupStatusResponse,
  ProviderName,
} from '@bendyline/gezel';
import { writeFileAtomic } from '../fs/atomic.js';
import { readSecurityJson, writeSecurityJson } from '../fs/security-json.js';
import type { OpenCodeBridgeController } from '../http/opencode-bridge.js';
import {
  OPENCODE_SETUP_RESERVED_APP_ID,
  type TokenRecord,
  type TokenStore,
} from '../http/token-store.js';
import type { ModelInfo } from '../providers/types.js';
import { type OpenCodeBinaryDetection, detectOpenCodeBinary } from './binary.js';

/**
 * Provider key inside the managed config. Also the `<provider>/<model>` prefix
 * OpenCode uses to name a model, so changing it invalidates any `model` line a
 * user has pinned in their own config.
 */
export const OPENCODE_SETUP_PROVIDER_ID = 'gezel';
export const OPENCODE_SETUP_APP_ID = OPENCODE_SETUP_RESERVED_APP_ID;
export const OPENCODE_SETUP_REVISION = 1;
const OPENCODE_SETUP_APP_NAME = 'OpenCode (Gezel local models)';

const CONFIG_FILE = 'opencode.json';
const TOKEN_FILE = 'token';
/** OpenCode resolves custom providers through this AI SDK package. */
const PROVIDER_NPM_PACKAGE = '@ai-sdk/openai-compatible';
const PROVIDER_DISPLAY_NAME = 'Gezel (local)';
const DEFAULT_CONTEXT_WINDOW = 32_768;
/**
 * OpenCode's config schema requires both halves of `limit`. Gezel does not cap
 * completion length per model, so publish a generous share of the context
 * rather than a number the model would actually hit.
 */
const OUTPUT_LIMIT_SHARE = 0.25;
const MAX_OUTPUT_LIMIT = 32_768;
const MAX_CONFIG_BACKUPS = 50;

const LOCAL_PROVIDERS = [
  'llama-cpp',
  'mlx',
  'ds4',
  'ollama',
] as const satisfies readonly ProviderName[];
const LOCAL_PROVIDER_SET = new Set<ProviderName>(LOCAL_PROVIDERS);

interface SetupState {
  version: 1;
  model: string;
  createdAt: string;
  updatedAt: string;
  /**
   * SHA-256 of the config file exactly as Gezel last wrote it.
   *
   * Codex marks ownership with comment headers inside its own TOML profile.
   * OpenCode's config is strict JSON loaded by a schema-validating parser, and
   * guessing which unknown keys it tolerates is not a bet worth making on a
   * user's editor config — so the marker lives here, in state Gezel already
   * owns. A file we cannot match is treated as foreign and left alone.
   */
  configDigest: string;
}

type ConflictKind = 'config' | 'credential' | 'state';

export class OpenCodeSetupError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409 | 500 = 409,
  ) {
    super(message);
    this.name = 'OpenCodeSetupError';
  }
}

export interface OpenCodeSetupManager {
  status(): Promise<OpenCodeSetupStatusResponse>;
  configure(input: ConfigureOpenCodeRequest): Promise<OpenCodeSetupStatusResponse>;
  remove(): Promise<OpenCodeSetupStatusResponse>;
  reconcile(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateOpenCodeSetupManagerOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  tokenStore: TokenStore;
  bridge: OpenCodeBridgeController;
  readConfig: () => Promise<GezelConfig>;
  listGezels: () => Promise<GezelSummary[]>;
  providerForGezel: (gezelId: string) => Promise<ProviderName>;
  listModels: (provider: ProviderName) => Promise<ModelInfo[]>;
  detectOpenCode?: () => Promise<OpenCodeBinaryDetection>;
  now?: () => Date;
}

export function createOpenCodeSetupManager(
  opts: CreateOpenCodeSetupManagerOptions,
): OpenCodeSetupManager {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const integrationDir = join(opts.home, 'integrations', 'opencode');
  const statePath = join(integrationDir, 'setup.json');
  const tokenPath = join(integrationDir, TOKEN_FILE);
  const configPath = join(integrationDir, CONFIG_FILE);
  const now = opts.now ?? (() => new Date());

  const detect = opts.detectOpenCode ?? (() => detectOpenCodeBinary({ env }));

  let mutation = Promise.resolve();
  let closing = false;
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = mutation.then(fn, fn);
    mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const listEligibleModels = async (
    suppliedConfig?: GezelConfig,
  ): Promise<OpenCodeSetupModelOption[]> => {
    const config = suppliedConfig ?? (await opts.readConfig());
    const groups = await Promise.all(
      LOCAL_PROVIDERS.map(async (provider) => {
        try {
          const models = await opts.listModels(provider);
          return models
            .filter((model) => model.supportsTools === true)
            .map(
              (model): OpenCodeSetupModelOption => ({
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
        gezels.map(async (gezel): Promise<OpenCodeSetupModelOption | null> => {
          if (gezel.fixedFunction) return null;
          const provider = await opts.providerForGezel(gezel.id).catch(() => null);
          if (!provider || !LOCAL_PROVIDER_SET.has(provider)) return null;

          const modelId = gezel.model ?? config.defaultModel?.[provider];
          if (!modelId) return null;
          const backingModel = rawModelsByTarget.get(`${provider}:${modelId}`);
          if (!backingModel) return null;

          return {
            id: `gezel:${gezel.id}`,
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
      .filter((model): model is OpenCodeSetupModelOption => model !== null)
      .sort((a, b) => a.label.localeCompare(b.label));

    // Gezels are the first-class choice. Raw models remain available for
    // callers that deliberately want OpenCode without a Gezel persona.
    return [...gezelModels, ...rawModels];
  };

  const bridgeSnapshot = () => {
    const live = opts.bridge.status();
    const port = live.port ?? opts.bridge.desiredPort();
    const origin = opts.bridge.baseUrl() ?? `http://127.0.0.1:${port}`;
    return {
      baseUrl: `${origin}/v1`,
      listening: live.listening,
      port,
    };
  };

  const readState = async (): Promise<SetupState | null> =>
    readSecurityJson(statePath, 'OpenCode setup', decodeSetupState);

  const inspect = async (): Promise<{
    status: OpenCodeSetupStatusResponse;
    state: SetupState | null;
    models: OpenCodeSetupModelOption[];
    detection: OpenCodeBinaryDetection;
    conflict: ConflictKind | null;
  }> => {
    const configPromise = opts.readConfig();
    const [config, models, detection, stateResult, managedConfig, tokenFile] = await Promise.all([
      configPromise,
      configPromise.then((config) => listEligibleModels(config)),
      detect(),
      readState().then(
        (value) => ({ value, error: null as Error | null }),
        (error) => ({ value: null, error: asError(error) }),
      ),
      readOptional(configPath),
      readOptional(tokenPath),
    ]);
    const state = stateResult.value;
    const endpointsEnabled = config.openaiEndpoints?.enabled !== false;
    const recommendedModel =
      models.find((model) => model.kind === 'gezel' && model.gezelId === config.meesterGezelId)
        ?.id ??
      models.find((model) => model.kind === 'gezel')?.id ??
      models[0]?.id;
    const tokenRecord = setupTokenRecord(opts.tokenStore);
    const tokenOwnedBySetup = tokenRecord?.appName === OPENCODE_SETUP_APP_NAME;
    const configIsOurs =
      managedConfig !== null && state !== null && sha256(managedConfig) === state.configDigest;
    const canRemove = Boolean(
      state || stateResult.error || tokenOwnedBySetup || tokenFile !== null || configIsOurs,
    );
    const reasons: string[] = [];
    let statusState: OpenCodeSetupStatusResponse['state'] = 'not-configured';
    let message: string | undefined;
    let conflict: ConflictKind | null = null;

    if (managedConfig !== null && !configIsOurs && !stateResult.error) {
      statusState = 'conflict';
      conflict = 'config';
      message = `${configPath} was changed outside this setup or belongs to another Gezel home. It was not modified.`;
    } else if (tokenRecord && !tokenOwnedBySetup) {
      statusState = 'conflict';
      conflict = 'credential';
      message =
        'Another connected app is using Gezel’s reserved OpenCode credential identity. Revoke that app before setting up OpenCode.';
    } else if (stateResult.error) {
      statusState = 'conflict';
      conflict = 'state';
      message = 'Gezel found damaged OpenCode setup state and left the existing files untouched.';
    } else if (state) {
      if (!endpointsEnabled) reasons.push('Connected-app model serving is turned off.');
      if (!models.some((model) => model.id === state.model)) {
        reasons.push('The configured gezel or local model is no longer available.');
      }
      if (managedConfig === null) reasons.push('The managed OpenCode config is missing.');
      if (!tokenRecord || !isExactSetupToken(tokenRecord)) {
        reasons.push('The OpenCode app credential was revoked or is invalid.');
      } else if (tokenFile !== tokenRecord.token) {
        reasons.push('The managed OpenCode credential file needs repair.');
      }
      if (managedConfig !== null) {
        const selected = models.find((model) => model.id === state.model);
        if (selected) {
          const expected = buildConfig({
            model: selected,
            models,
            baseUrl: bridgeSnapshot().baseUrl,
            tokenPath,
          });
          if (managedConfig !== expected) {
            reasons.push('The managed OpenCode config is out of date.');
          }
        }
      }
      if (endpointsEnabled && !opts.bridge.status().listening) {
        reasons.push('The OpenCode inference bridge is not running.');
      }
      statusState = reasons.length === 0 ? 'configured' : 'update-needed';
    } else if (models.length === 0) {
      statusState = 'unavailable';
      message = 'Install a local chat model with tool support before setting up OpenCode.';
    }

    const publishable = endpointsEnabled && models.length > 0;
    const canConfigure = publishable && statusState !== 'conflict';
    // A credential conflict is another app's to release; the managed config and
    // our own damaged state are the only conflicts Gezel may resolve here.
    const canRepair = publishable && (conflict === 'config' || conflict === 'state');
    return {
      state,
      models,
      detection,
      conflict,
      status: {
        state: statusState,
        models,
        ...(state ? { configuredModel: state.model } : {}),
        ...(recommendedModel ? { recommendedModel } : {}),
        reasons,
        ...(message ? { message } : {}),
        opencodeInstalled: detection.installed,
        ...(detection.version ? { opencodeVersion: detection.version } : {}),
        ...(detection.path ? { opencodePath: detection.path } : {}),
        endpointsEnabled,
        providerId: OPENCODE_SETUP_PROVIDER_ID,
        configPath,
        launchCommand: buildLaunchCommand({
          binaryPath: detection.path,
          configPath,
          platform,
        }),
        bridge: bridgeSnapshot(),
        canConfigure,
        canRemove,
        canRepair,
      },
    };
  };

  const status = async (): Promise<OpenCodeSetupStatusResponse> => (await inspect()).status;

  // Exclusive create, never overwrite: the whole point of the backup is that a
  // file Gezel does not own survives, and that includes an earlier backup.
  const preserveConflictingConfig = async (content: string): Promise<string> => {
    for (let attempt = 1; attempt <= MAX_CONFIG_BACKUPS; attempt++) {
      const candidate = attempt === 1 ? `${configPath}.backup` : `${configPath}.backup-${attempt}`;
      try {
        await writeFile(candidate, content, { mode: 0o600, flag: 'wx' });
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    throw new OpenCodeSetupError(
      'opencode_config_backup_failed',
      `Could not save a backup copy of ${configPath}. Move the existing backup files aside and try again.`,
    );
  };

  const configure = (input: ConfigureOpenCodeRequest): Promise<OpenCodeSetupStatusResponse> =>
    serialize(async () => {
      if (closing) {
        throw new OpenCodeSetupError(
          'service_stopping',
          'Gezel is stopping and cannot change the OpenCode setup.',
          409,
        );
      }
      const before = await inspect();
      if (!before.status.endpointsEnabled) {
        throw new OpenCodeSetupError(
          'openai_endpoints_disabled',
          'Turn on Allow apps to connect before setting up OpenCode.',
        );
      }
      const repairing = input.backupConflictingConfig === true && before.status.canRepair;
      if (before.status.state === 'conflict' && !repairing) {
        throw new OpenCodeSetupError(
          'opencode_config_conflict',
          before.status.message ?? `${configPath} is not managed by Gezel.`,
        );
      }
      const selected = before.models.find((model) => model.id === input.model);
      if (!selected) {
        throw new OpenCodeSetupError(
          'model_not_available',
          `The selected gezel or local model is not available for OpenCode: ${input.model}`,
          404,
        );
      }

      await opts.bridge.start().catch((error) => {
        throw new OpenCodeSetupError('opencode_bridge_unavailable', asError(error).message);
      });
      let issuedNewToken = false;
      let backup: { path: string; content: string } | null = null;
      try {
        await ensurePrivateDir(integrationDir);
        const currentConfig = await readOptional(configPath);
        const stateForOwnership = before.state;
        const foreignConfig =
          currentConfig !== null &&
          (stateForOwnership === null || sha256(currentConfig) !== stateForOwnership.configDigest)
            ? currentConfig
            : null;
        if (foreignConfig !== null && !repairing) {
          throw new OpenCodeSetupError(
            'opencode_config_conflict',
            `${configPath} changed while setup was running and was not overwritten.`,
          );
        }
        const baseUrl = bridgeSnapshot().baseUrl;

        let record = setupTokenRecord(opts.tokenStore);
        if (record && record.appName === OPENCODE_SETUP_APP_NAME && !isExactSetupToken(record)) {
          await opts.tokenStore.revoke(OPENCODE_SETUP_APP_ID);
          record = undefined;
        }
        if (!record) {
          record = await opts.tokenStore.issue({
            appId: OPENCODE_SETUP_APP_ID,
            appName: OPENCODE_SETUP_APP_NAME,
            scopes: ['openai'],
          });
          issuedNewToken = true;
        }

        const createdAt = before.state?.createdAt ?? now().toISOString();
        const managedConfig = buildConfig({
          model: selected,
          models: before.models,
          baseUrl,
          tokenPath,
        });
        const nextState: SetupState = {
          version: OPENCODE_SETUP_REVISION,
          model: selected.id,
          createdAt,
          updatedAt: now().toISOString(),
          configDigest: sha256(managedConfig),
        };

        // Publish the secret first, then the config, and the state marker last.
        // A crash becomes a visible update-needed setup rather than a state
        // record that falsely claims every dependent file exists.
        //
        // The credential file carries NO trailing newline: OpenCode splices
        // `{file:...}` contents into the raw config text before parsing it as
        // JSON, so a newline would land inside a JSON string literal and make
        // the whole config unparseable.
        await writeFileAtomic(tokenPath, record.token, { mode: 0o600, durable: true });
        if ((await readOptional(configPath)) !== currentConfig) {
          throw new OpenCodeSetupError(
            'opencode_config_conflict',
            `${configPath} changed while setup was running and was not overwritten.`,
          );
        }
        if (foreignConfig !== null) {
          backup = {
            path: await preserveConflictingConfig(foreignConfig),
            content: foreignConfig,
          };
        }
        await writeFileAtomic(configPath, managedConfig, { mode: 0o600, durable: true });
        await writeSecurityJson(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
        const published = await status();
        return backup ? { ...published, configBackupPath: backup.path } : published;
      } catch (error) {
        if (issuedNewToken) await opts.tokenStore.revoke(OPENCODE_SETUP_APP_ID).catch(() => false);
        if (!before.state) {
          await rm(integrationDir, { recursive: true, force: true }).catch(() => undefined);
          await opts.bridge.stop().catch(() => undefined);
        }
        // Restore the displaced file LAST. Unlike Codex — whose profile lives
        // in ~/.codex, outside anything Gezel wipes — this config sits inside
        // the integration directory. Repairing a conflict where setup.json is
        // missing runs with `before.state === null`, so an earlier restore
        // would be deleted by the first-run cleanup above. The content is held
        // in memory, so recreating the directory here is enough.
        if (backup) {
          await ensurePrivateDir(integrationDir).catch(() => undefined);
          await writeFileAtomic(configPath, backup.content, {
            mode: 0o600,
            durable: true,
          }).catch(() => undefined);
          await rm(backup.path, { force: true }).catch(() => undefined);
        }
        throw error;
      }
    });

  const removeSetup = (): Promise<OpenCodeSetupStatusResponse> =>
    serialize(async () => {
      const failures: unknown[] = [];
      await opts.bridge.stop().catch((error) => failures.push(error));

      const record = setupTokenRecord(opts.tokenStore);
      if (record?.appName === OPENCODE_SETUP_APP_NAME) {
        await opts.tokenStore.revoke(OPENCODE_SETUP_APP_ID).catch((error) => failures.push(error));
      }
      // Everything Gezel writes for OpenCode lives inside its own integration
      // directory, so removal never reaches into the user's OpenCode config.
      await rm(integrationDir, { recursive: true, force: true }).catch((error) =>
        failures.push(error),
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Could not completely remove the Gezel OpenCode setup.');
      }
      return status();
    });

  const reconcile = (): Promise<void> =>
    serialize(async () => {
      if (closing) {
        await opts.bridge.stop();
        return;
      }
      const config = await opts.readConfig();
      const state = await readState().catch(() => null);
      if (!state || config.openaiEndpoints?.enabled === false) {
        await opts.bridge.stop();
        return;
      }
      const record = setupTokenRecord(opts.tokenStore);
      const tokenFile = await readOptional(tokenPath);
      const managedConfig = await readOptional(configPath);
      if (
        !isExactSetupToken(record) ||
        tokenFile !== record.token ||
        managedConfig === null ||
        sha256(managedConfig) !== state.configDigest
      ) {
        await opts.bridge.stop();
        return;
      }
      const models = await listEligibleModels(config);
      const selected = models.find((model) => model.id === state.model);
      if (!selected) {
        await opts.bridge.stop();
        return;
      }
      await opts.bridge.start();
      // The bridge port is stable per home, but an ephemeral test bridge (or a
      // future repaired port) changes the managed address, and the model roster
      // drifts as the user installs models. Republish both, and re-mark
      // ownership so the next inspect still recognizes the file as ours.
      const next = buildConfig({
        model: selected,
        models,
        baseUrl: bridgeSnapshot().baseUrl,
        tokenPath,
      });
      if (next === managedConfig) return;
      await writeFileAtomic(configPath, next, { mode: 0o600, durable: true });
      await writeSecurityJson(
        statePath,
        `${JSON.stringify({ ...state, updatedAt: now().toISOString(), configDigest: sha256(next) }, null, 2)}\n`,
      );
    });

  return {
    status,
    configure,
    remove: removeSetup,
    reconcile,
    stop: () => {
      closing = true;
      return serialize(() => opts.bridge.stop());
    },
  };
}

function setupTokenRecord(store: TokenStore): TokenRecord | undefined {
  return store.list().find((record) => record.appId === OPENCODE_SETUP_APP_ID);
}

function isExactSetupToken(record: TokenRecord | undefined): record is TokenRecord {
  return (
    record?.appName === OPENCODE_SETUP_APP_NAME &&
    record.scopes.length === 1 &&
    record.scopes[0] === 'openai'
  );
}

interface OpenCodeModelEntry {
  name: string;
  tool_call: true;
  attachment: false;
  limit: { context: number; output: number };
  reasoning?: boolean;
}

/**
 * Render the managed `opencode.json`.
 *
 * Every eligible gezel and model is published so OpenCode's own `/models`
 * picker shows the whole crew; `model` names the one the user chose here.
 * `small_model` is pinned to the same target deliberately — left unset,
 * OpenCode picks its own default for title and summary generation, which on a
 * machine set up for local inference means reaching for a provider the user
 * has not configured.
 */
export function buildConfig(input: {
  model: OpenCodeSetupModelOption;
  models: OpenCodeSetupModelOption[];
  baseUrl: string;
  tokenPath: string;
}): string {
  const models: Record<string, OpenCodeModelEntry> = {};
  for (const candidate of [...input.models].sort((a, b) => a.id.localeCompare(b.id))) {
    const context = candidate.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    models[candidate.id] = {
      name: candidate.description
        ? `${candidate.label} — ${candidate.description}`
        : candidate.label,
      tool_call: true,
      attachment: false,
      limit: {
        context,
        output: Math.max(1, Math.min(MAX_OUTPUT_LIMIT, Math.floor(context * OUTPUT_LIMIT_SHARE))),
      },
      ...(candidate.supportsReasoning !== undefined
        ? { reasoning: candidate.supportsReasoning }
        : {}),
    };
  }

  const target = `${OPENCODE_SETUP_PROVIDER_ID}/${input.model.id}`;
  const config = {
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [OPENCODE_SETUP_PROVIDER_ID]: {
        npm: PROVIDER_NPM_PACKAGE,
        name: PROVIDER_DISPLAY_NAME,
        options: {
          baseURL: input.baseUrl,
          apiKey: `{file:${portablePath(input.tokenPath)}}`,
        },
        models,
      },
    },
    model: target,
    small_model: target,
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * OpenCode substitutes `{file:...}` on the raw config text before parsing it as
 * JSON, so the path is read from the unescaped source. Forward slashes are
 * absolute on Windows for `path.isAbsolute`, need no JSON escaping, and cannot
 * turn into an accidental escape sequence in either reader.
 */
function portablePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function buildLaunchCommand(input: {
  binaryPath?: string;
  configPath: string;
  platform: NodeJS.Platform;
}): string {
  const binary = input.binaryPath ?? 'opencode';
  if (input.platform === 'win32') {
    return `$env:OPENCODE_CONFIG = ${powershellLiteral(input.configPath)}; & ${powershellLiteral(binary)}`;
  }
  return `OPENCODE_CONFIG=${posixShellWord(input.configPath)} ${posixShellWord(binary)}`;
}

function posixShellWord(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodeSetupState(raw: string): SetupState {
  const parsed = JSON.parse(raw) as Partial<SetupState>;
  if (
    parsed.version !== OPENCODE_SETUP_REVISION ||
    typeof parsed.model !== 'string' ||
    !parsed.model ||
    typeof parsed.createdAt !== 'string' ||
    typeof parsed.updatedAt !== 'string' ||
    typeof parsed.configDigest !== 'string' ||
    !parsed.configDigest
  ) {
    throw new Error('invalid setup record');
  }
  return parsed as SetupState;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => {});
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
