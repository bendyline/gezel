import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ConfigureOpenCodeRequest,
  GezelConfig,
  GezelSummary,
  InstallOpenCodePluginRequest,
  OpenCodeSetupModelOption,
  OpenCodeSetupPlugin,
  OpenCodeSetupStatusResponse,
  ProviderName,
} from '@bendyline/gezel';
import { writeFileAtomic } from '../fs/atomic.js';
import { setupOwnerId as managedFileOwnerId } from '../fs/managed-marker.js';
import { readSecurityJson, writeSecurityJson } from '../fs/security-json.js';
import type { OpenCodeBridgeController } from '../http/opencode-bridge.js';
import { OPENCODE_SETUP_RESERVED_APP_ID, type TokenStore } from '../http/token-store.js';
import {
  HarnessSetupError,
  LOCAL_HARNESS_PROVIDER_SET,
  asError,
  createMutationQueue,
  ensurePrivateDir,
  harnessBridgeSnapshot,
  harnessTokenRecord,
  isExactHarnessToken,
  listEligibleHarnessModels,
  posixShellWord,
  powershellLiteral,
  preserveConflictingFile,
  readOptionalFile,
  recommendedHarnessModel,
} from '../local-harness/base.js';
import type { ModelInfo } from '../providers/types.js';
import { type OpenCodeBinaryDetection, detectOpenCodeBinary } from './binary.js';
import { openCodePluginDir, openCodePluginPath, resolveOpenCodeConfigDir } from './config-dir.js';
import { OPENCODE_PLUGIN_MARKER, buildOpenCodePluginSource } from './plugin-source.js';

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

export class OpenCodeSetupError extends HarnessSetupError {
  constructor(code: string, message: string, status: 400 | 404 | 409 | 500 = 409) {
    super(code, message, status);
    this.name = 'OpenCodeSetupError';
  }
}

export interface OpenCodeSetupManager {
  status(): Promise<OpenCodeSetupStatusResponse>;
  configure(input: ConfigureOpenCodeRequest): Promise<OpenCodeSetupStatusResponse>;
  installPlugin(input: InstallOpenCodePluginRequest): Promise<OpenCodeSetupStatusResponse>;
  removePlugin(): Promise<OpenCodeSetupStatusResponse>;
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
  /** Overrides OpenCode's own config root. Tests must never write to a real one. */
  opencodeConfigDir?: string;
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
  const ownerId = managedFileOwnerId(opts.home);

  const detect = opts.detectOpenCode ?? (() => detectOpenCodeBinary({ env }));

  // Resolving means spawning `opencode debug paths`; the answer only moves when
  // the user reinstalls OpenCode somewhere else, so keep it per binary path.
  let configDirCache: { key: string; dir: string } | null = null;
  const resolveConfigDir = async (detection: OpenCodeBinaryDetection): Promise<string | null> => {
    if (opts.opencodeConfigDir) return opts.opencodeConfigDir;
    if (!detection.installed || !detection.path) return null;
    if (configDirCache?.key === detection.path) return configDirCache.dir;
    const resolved = await resolveOpenCodeConfigDir({ binaryPath: detection.path, env });
    configDirCache = { key: detection.path, dir: resolved.dir };
    return resolved.dir;
  };

  const pluginSourceFor = (): string =>
    buildOpenCodePluginSource({
      configPath,
      tokenPath,
      providerId: OPENCODE_SETUP_PROVIDER_ID,
      ownerId,
    });

  let closing = false;
  const serialize = createMutationQueue();

  const listEligibleModels = async (
    suppliedConfig?: GezelConfig,
  ): Promise<OpenCodeSetupModelOption[]> =>
    listEligibleHarnessModels({
      config: suppliedConfig ?? (await opts.readConfig()),
      listModels: opts.listModels,
      listGezels: opts.listGezels,
      providerForGezel: opts.providerForGezel,
    });

  const bridgeSnapshot = () => harnessBridgeSnapshot(opts.bridge);

  const readState = async (): Promise<SetupState | null> =>
    readSecurityJson(statePath, 'OpenCode setup', decodeSetupState);

  const inspect = async (): Promise<{
    status: OpenCodeSetupStatusResponse;
    state: SetupState | null;
    models: OpenCodeSetupModelOption[];
    detection: OpenCodeBinaryDetection;
    conflict: ConflictKind | null;
    configDir: string | null;
    pluginPath: string | null;
    pluginFile: string | null;
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
      readOptionalFile(configPath),
      readOptionalFile(tokenPath),
    ]);
    const state = stateResult.value;
    const configDir = await resolveConfigDir(detection);
    const pluginPath = configDir ? openCodePluginPath(configDir) : null;
    const pluginFile = pluginPath ? await readOptionalFile(pluginPath).catch(() => null) : null;
    // The file is its own record: an ownership marker proves who wrote it and a
    // digest proves it still matches this install. Nothing about it is tracked
    // in Gezel's state, so a crash between writing and recording cannot leave a
    // setup claiming a file that is not there.
    const pluginKind: OpenCodeSetupPlugin['state'] =
      !detection.installed || !pluginPath
        ? 'unsupported'
        : pluginFile === null
          ? 'not-installed'
          : OPENCODE_PLUGIN_MARKER.isManaged(pluginFile, ownerId)
            ? pluginFile === pluginSourceFor()
              ? 'installed'
              : 'stale'
            : 'conflict';
    const endpointsEnabled = config.openaiEndpoints?.enabled !== false;
    const recommendedModel = recommendedHarnessModel(models, config.meesterGezelId);
    const tokenRecord = harnessTokenRecord(opts.tokenStore, OPENCODE_SETUP_APP_ID);
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
      if (!tokenRecord || !isExactHarnessToken(tokenRecord, OPENCODE_SETUP_APP_NAME)) {
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
      // Only a plugin this install still owns is worth reporting as stale;
      // configure and reconcile both republish it in place.
      if (pluginKind === 'stale') reasons.push('The OpenCode plugin file is out of date.');
      statusState = reasons.length === 0 ? 'configured' : 'update-needed';
    } else if (models.length === 0) {
      statusState = 'unavailable';
      message = 'Install a local chat model with tool support before setting up OpenCode.';
    }

    const publishable = endpointsEnabled && models.length > 0;
    const canConfigure = publishable && statusState !== 'conflict';
    // Writing into OpenCode's own directory presupposes a managed config for
    // the plugin to read, an OpenCode to read it, and no unresolved conflict.
    const pluginWritable = endpointsEnabled && state !== null && statusState !== 'conflict';
    const plugin: OpenCodeSetupPlugin = {
      state: pluginKind,
      ...(pluginPath ? { path: pluginPath } : {}),
      canInstall: pluginWritable && (pluginKind === 'not-installed' || pluginKind === 'stale'),
      canRemove: pluginKind === 'installed' || pluginKind === 'stale',
      canReplace: pluginWritable && pluginKind === 'conflict',
      ...pluginMessage({
        kind: pluginKind,
        path: pluginPath,
        detection,
        configured: state !== null,
      }),
    };
    // A credential conflict is another app's to release; the managed config and
    // our own damaged state are the only conflicts Gezel may resolve here.
    const canRepair = publishable && (conflict === 'config' || conflict === 'state');
    return {
      state,
      models,
      detection,
      conflict,
      configDir,
      pluginPath,
      pluginFile,
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
        plugin,
        bridge: bridgeSnapshot(),
        canConfigure,
        canRemove,
        canRepair,
      },
    };
  };

  const status = async (): Promise<OpenCodeSetupStatusResponse> => (await inspect()).status;

  const preserveConflictingConfig = (content: string): Promise<string> =>
    preserveConflictingFile({
      path: configPath,
      content,
      mode: 0o600,
      code: 'opencode_config_backup_failed',
    });

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
        const currentConfig = await readOptionalFile(configPath);
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

        let record = harnessTokenRecord(opts.tokenStore, OPENCODE_SETUP_APP_ID);
        if (
          record &&
          record.appName === OPENCODE_SETUP_APP_NAME &&
          !isExactHarnessToken(record, OPENCODE_SETUP_APP_NAME)
        ) {
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
        if ((await readOptionalFile(configPath)) !== currentConfig) {
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
        await refreshManagedPlugin().catch(() => {
          // The setup itself succeeded. A plugin that could not be refreshed
          // reports as out of date on the next status rather than failing here.
        });
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

  /**
   * Republish a plugin this install already owns, so a moved bridge address or
   * a newer plugin template lands without the user re-installing it. It never
   * creates one: a plugin the user deleted from their own config directory
   * must stay deleted.
   */
  const refreshManagedPlugin = async (): Promise<void> => {
    const configDir = await resolveConfigDir(await detect());
    if (!configDir) return;
    const pluginPath = openCodePluginPath(configDir);
    const current = await readOptionalFile(pluginPath).catch(() => null);
    if (current === null || !OPENCODE_PLUGIN_MARKER.isManaged(current, ownerId)) return;
    const next = pluginSourceFor();
    if (next === current) return;
    await writeFileAtomic(pluginPath, next, { durable: true });
  };

  /**
   * Delete the plugin only where this install's marker proves it wrote it.
   *
   * Both the currently-resolved root and the conventional one are swept:
   * OpenCode may have been uninstalled, or moved its config, since the install
   * — and a plugin left pointing at deleted files would keep loading forever.
   * Sweeping wider is safe precisely because the marker, not the path, is what
   * authorizes the delete.
   */
  const deleteManagedPlugin = async (): Promise<'deleted' | 'absent' | 'foreign'> => {
    const candidates = new Set<string>();
    const resolved = await resolveConfigDir(await detect());
    if (resolved) candidates.add(openCodePluginPath(resolved));
    candidates.add(openCodePluginPath((await resolveOpenCodeConfigDir({ env })).dir));

    let outcome: 'deleted' | 'absent' | 'foreign' = 'absent';
    for (const pluginPath of candidates) {
      const current = await readOptionalFile(pluginPath).catch(() => null);
      if (current === null) continue;
      if (!OPENCODE_PLUGIN_MARKER.isManaged(current, ownerId)) {
        if (outcome === 'absent') outcome = 'foreign';
        continue;
      }
      await rm(pluginPath, { force: true });
      outcome = 'deleted';
    }
    return outcome;
  };

  const installPlugin = (
    input: InstallOpenCodePluginRequest,
  ): Promise<OpenCodeSetupStatusResponse> =>
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
          'Turn on Allow apps to connect before installing the OpenCode plugin.',
        );
      }
      if (!before.state || before.status.state === 'conflict') {
        throw new OpenCodeSetupError(
          'opencode_not_configured',
          'Set up OpenCode first — the plugin reads the settings file that setup writes.',
        );
      }
      if (!before.detection.installed || !before.configDir || !before.pluginPath) {
        throw new OpenCodeSetupError(
          'opencode_not_installed',
          'OpenCode was not found on this computer, so there is nowhere to install the plugin.',
        );
      }
      if (before.status.plugin.state === 'installed') return before.status;

      const replacing = input.backupConflictingPlugin === true && before.status.plugin.canReplace;
      if (before.status.plugin.state === 'conflict' && !replacing) {
        throw new OpenCodeSetupError(
          'opencode_plugin_conflict',
          before.status.plugin.message ?? `${before.pluginPath} is not managed by Gezel.`,
        );
      }

      const pluginPath = before.pluginPath;
      let backup: { path: string; content: string } | null = null;
      try {
        // OpenCode's config directory belongs to the user: create what is
        // missing, but never tighten permissions on it.
        await mkdir(openCodePluginDir(before.configDir), { recursive: true });
        const current = await readOptionalFile(pluginPath);
        if (current !== before.pluginFile) {
          throw new OpenCodeSetupError(
            'opencode_plugin_conflict',
            `${pluginPath} changed while the install was running and was not overwritten.`,
          );
        }
        if (current !== null && !OPENCODE_PLUGIN_MARKER.isManaged(current, ownerId)) {
          backup = {
            path: await preserveConflictingFile({
              path: pluginPath,
              content: current,
              mode: 0o644,
              code: 'opencode_plugin_backup_failed',
            }),
            content: current,
          };
        }
        // The plugin carries paths, never the credential, so it needs no
        // private mode in a directory the user may sync between machines.
        await writeFileAtomic(pluginPath, pluginSourceFor(), { durable: true });
        const published = await status();
        return backup ? { ...published, pluginBackupPath: backup.path } : published;
      } catch (error) {
        if (backup) {
          await writeFileAtomic(pluginPath, backup.content, { mode: 0o644, durable: true }).catch(
            () => undefined,
          );
          await rm(backup.path, { force: true }).catch(() => undefined);
        }
        throw error;
      }
    });

  const removePlugin = (): Promise<OpenCodeSetupStatusResponse> =>
    serialize(async () => {
      const outcome = await deleteManagedPlugin();
      if (outcome === 'foreign') {
        throw new OpenCodeSetupError(
          'opencode_plugin_conflict',
          'That OpenCode plugin file was written by another Gezel installation or changed by hand. It was not removed.',
        );
      }
      return status();
    });

  const removeSetup = (): Promise<OpenCodeSetupStatusResponse> =>
    serialize(async () => {
      const failures: unknown[] = [];
      await opts.bridge.stop().catch((error) => failures.push(error));
      // The plugin points at files this removal deletes, so it goes too — but
      // only if this install wrote it.
      await deleteManagedPlugin().catch((error) => failures.push(error));

      const record = harnessTokenRecord(opts.tokenStore, OPENCODE_SETUP_APP_ID);
      if (record?.appName === OPENCODE_SETUP_APP_NAME) {
        await opts.tokenStore.revoke(OPENCODE_SETUP_APP_ID).catch((error) => failures.push(error));
      }
      // Apart from the plugin removed above, everything Gezel writes for
      // OpenCode lives inside its own integration directory.
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
      const record = harnessTokenRecord(opts.tokenStore, OPENCODE_SETUP_APP_ID);
      const tokenFile = await readOptionalFile(tokenPath);
      const managedConfig = await readOptionalFile(configPath);
      if (
        !isExactHarnessToken(record, OPENCODE_SETUP_APP_NAME) ||
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
      await refreshManagedPlugin().catch(() => undefined);
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
    installPlugin,
    removePlugin,
    remove: removeSetup,
    reconcile,
    stop: () => {
      closing = true;
      return serialize(() => opts.bridge.stop());
    },
  };
}

function pluginMessage(input: {
  kind: OpenCodeSetupPlugin['state'];
  path: string | null;
  detection: OpenCodeBinaryDetection;
  configured: boolean;
}): { message?: string } {
  if (input.kind === 'unsupported') {
    return {
      message: input.detection.installed
        ? 'Gezel could not work out where OpenCode keeps its configuration.'
        : 'Install OpenCode to make Gezel available in it without the launch command.',
    };
  }
  if (input.kind === 'conflict') {
    return {
      message: `${input.path} was written by another Gezel installation or changed by hand. It was not modified.`,
    };
  }
  if (input.kind === 'not-installed' && !input.configured) {
    return { message: 'Set up OpenCode first — the plugin reads the settings file setup writes.' };
  }
  return {};
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
