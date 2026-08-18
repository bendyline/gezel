import { mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  CodexSetupModelOption,
  CodexSetupStatusResponse,
  ConfigureCodexRequest,
  GezelConfig,
  GezelSummary,
  ProviderName,
} from '@bendyline/gezel';
import { writeFileAtomic } from '../fs/atomic.js';
import { createManagedMarker, setupOwnerId as managedFileOwnerId } from '../fs/managed-marker.js';
import { readSecurityJson, writeSecurityJson } from '../fs/security-json.js';
import type { CodexBridgeController } from '../http/codex-bridge.js';
import {
  CODEX_SETUP_RESERVED_APP_ID,
  type TokenRecord,
  type TokenStore,
} from '../http/token-store.js';
import {
  HarnessSetupError,
  asError,
  createMutationQueue,
  ensurePrivateDir,
  findHarnessModel,
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
import { type CodexBinaryDetection, detectCodexBinary } from '../providers/codex-cli/binary.js';
import type { ModelInfo } from '../providers/types.js';

export const CODEX_SETUP_PROFILE_NAME = 'gezel-local';
export const CODEX_SETUP_APP_ID = CODEX_SETUP_RESERVED_APP_ID;
export const CODEX_SETUP_REVISION = 1;
const CODEX_SETUP_APP_NAME = 'Codex (Gezel local models)';

const PROFILE_FILE = `${CODEX_SETUP_PROFILE_NAME}.config.toml`;
const PROFILE_MARKER = createManagedMarker({ commentPrefix: '# ', noun: 'profile' });
const MINIMUM_CODEX_VERSION = [0, 147, 0] as const;

interface SetupState {
  version: 1;
  model: string;
  /** Stable identity behind a human-readable gezel model id. */
  gezelId?: string;
  createdAt: string;
  updatedAt: string;
}

type ConflictKind = 'profile' | 'credential' | 'state';

export interface CodexCatalogModel {
  slug: string;
  display_name: string;
  description: string;
  [key: string]: unknown;
}

export class CodexSetupError extends HarnessSetupError {
  constructor(code: string, message: string, status: 400 | 404 | 409 | 500 = 409) {
    super(code, message, status);
    this.name = 'CodexSetupError';
  }
}

export interface CodexSetupManager {
  status(): Promise<CodexSetupStatusResponse>;
  configure(input: ConfigureCodexRequest): Promise<CodexSetupStatusResponse>;
  remove(): Promise<CodexSetupStatusResponse>;
  reconcile(): Promise<void>;
  stop(): Promise<void>;
  codexModelCatalog(): Promise<CodexCatalogModel[]>;
}

export interface CreateCodexSetupManagerOptions {
  home: string;
  codexHome?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  tokenStore: TokenStore;
  bridge: CodexBridgeController;
  readConfig: () => Promise<GezelConfig>;
  listGezels: () => Promise<GezelSummary[]>;
  providerForGezel: (gezelId: string) => Promise<ProviderName>;
  listModels: (provider: ProviderName) => Promise<ModelInfo[]>;
  detectCodex?: () => Promise<CodexBinaryDetection>;
  now?: () => Date;
}

export function createCodexSetupManager(opts: CreateCodexSetupManagerOptions): CodexSetupManager {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const defaultCodexHome = join(homedir(), '.codex');
  const codexHome = opts.codexHome ?? env.CODEX_HOME ?? defaultCodexHome;
  const integrationDir = join(opts.home, 'integrations', 'codex');
  const statePath = join(integrationDir, 'setup.json');
  const tokenPath = join(integrationDir, 'token');
  const catalogPath = join(integrationDir, 'models.json');
  const profilePath = join(codexHome, PROFILE_FILE);
  const setupOwnerId = managedFileOwnerId(opts.home);
  const now = opts.now ?? (() => new Date());

  const detect =
    opts.detectCodex ??
    (async () => {
      const config = await opts.readConfig();
      return detectCodexBinary({ override: config.codexCli?.binaryPath, env });
    });

  let closing = false;
  const serialize = createMutationQueue();

  const listEligibleModels = async (
    suppliedConfig?: GezelConfig,
  ): Promise<CodexSetupModelOption[]> =>
    listEligibleHarnessModels({
      config: suppliedConfig ?? (await opts.readConfig()),
      listModels: opts.listModels,
      listGezels: opts.listGezels,
      providerForGezel: opts.providerForGezel,
    });

  const codexModelCatalog = async (): Promise<CodexCatalogModel[]> =>
    (await listEligibleModels()).map(catalogModelFor);

  const bridgeSnapshot = () => harnessBridgeSnapshot(opts.bridge);

  const readState = async (): Promise<SetupState | null> =>
    readSecurityJson(statePath, 'Codex setup', decodeSetupState);

  const inspect = async (): Promise<{
    status: CodexSetupStatusResponse;
    state: SetupState | null;
    models: CodexSetupModelOption[];
    detection: CodexBinaryDetection;
    conflict: ConflictKind | null;
  }> => {
    const configPromise = opts.readConfig();
    const [config, models, detection, stateResult, profile, tokenFile, catalog] = await Promise.all(
      [
        configPromise,
        configPromise.then((config) => listEligibleModels(config)),
        detect(),
        readState().then(
          (value) => ({ value, error: null as Error | null }),
          (error) => ({ value: null, error: asError(error) }),
        ),
        readOptionalFile(profilePath),
        readOptionalFile(tokenPath),
        readOptionalFile(catalogPath),
      ],
    );
    const state = stateResult.value;
    const endpointsEnabled = config.openaiEndpoints?.enabled !== false;
    const versionSupported = detection.installed && isSupportedCodexVersion(detection.version);
    const recommendedModel = recommendedHarnessModel(models, config.meesterGezelId);
    const tokenRecord = harnessTokenRecord(opts.tokenStore, CODEX_SETUP_APP_ID);
    const tokenOwnedBySetup = tokenRecord?.appName === CODEX_SETUP_APP_NAME;
    const canRemove = Boolean(
      state ||
        stateResult.error ||
        tokenOwnedBySetup ||
        tokenFile !== null ||
        catalog !== null ||
        (profile !== null && isManagedProfile(profile, setupOwnerId)),
    );
    const reasons: string[] = [];
    let statusState: CodexSetupStatusResponse['state'] = 'not-configured';
    let message: string | undefined;
    let conflict: ConflictKind | null = null;

    if (profile !== null && !isManagedProfile(profile, setupOwnerId)) {
      statusState = 'conflict';
      conflict = 'profile';
      message = PROFILE_MARKER.isClaimed(profile)
        ? `${profilePath} was changed outside this setup or belongs to another Gezel home. It was preserved.`
        : `${profilePath} already exists and is not managed by Gezel. It was not changed.`;
    } else if (tokenRecord && !tokenOwnedBySetup) {
      statusState = 'conflict';
      conflict = 'credential';
      message =
        'Another connected app is using Gezel’s reserved Codex credential identity. Revoke that app before setting up Codex.';
    } else if (stateResult.error) {
      statusState = 'conflict';
      conflict = 'state';
      message = 'Gezel found damaged Codex setup state and left the existing files untouched.';
    } else if (state) {
      if (!endpointsEnabled) reasons.push('Connected-app model serving is turned off.');
      if (!versionSupported) reasons.push(codexVersionReason(detection));
      if (!findHarnessModel(models, state.model, state.gezelId)) {
        reasons.push('The configured gezel or local model is no longer available.');
      }
      if (profile === null) reasons.push('The managed Codex profile is missing.');
      if (!tokenRecord || !isExactHarnessToken(tokenRecord, CODEX_SETUP_APP_NAME)) {
        reasons.push('The Codex app credential was revoked or is invalid.');
      } else if (tokenFile?.trim() !== tokenRecord.token) {
        reasons.push('The managed Codex credential file needs repair.');
      }
      if (profile !== null) {
        const selected = findHarnessModel(models, state.model, state.gezelId);
        if (selected) {
          const expected = buildProfile({
            model: selected,
            baseUrl: bridgeSnapshot().baseUrl,
            catalogPath,
            tokenPath,
            platform,
            setupOwnerId,
          });
          if (profile !== expected) reasons.push('The managed Codex profile is out of date.');
        }
      }
      const expectedCatalog = `${JSON.stringify({ models: models.map(catalogModelFor) }, null, 2)}\n`;
      if (catalog !== expectedCatalog)
        reasons.push('The managed Codex model catalog is out of date.');
      if (endpointsEnabled && !opts.bridge.status().listening) {
        reasons.push('The Codex inference bridge is not running.');
      }
      statusState = reasons.length === 0 ? 'configured' : 'update-needed';
    } else if (!versionSupported || models.length === 0) {
      statusState = 'unavailable';
      message = !versionSupported
        ? codexVersionReason(detection)
        : 'Install a local chat model with tool support before setting up Codex.';
    }

    const publishable = endpointsEnabled && versionSupported && models.length > 0;
    const canConfigure = publishable && statusState !== 'conflict';
    // A credential conflict is another app's to release; the profile and our own
    // damaged state are the only conflicts Gezel may resolve on the user's behalf.
    const canRepair = publishable && (conflict === 'profile' || conflict === 'state');
    return {
      state,
      models,
      detection,
      conflict,
      status: {
        state: statusState,
        models,
        ...(state
          ? {
              configuredModel:
                findHarnessModel(models, state.model, state.gezelId)?.id ?? state.model,
            }
          : {}),
        ...(recommendedModel ? { recommendedModel } : {}),
        reasons,
        ...(message ? { message } : {}),
        codexInstalled: detection.installed,
        ...(detection.version ? { codexVersion: detection.version } : {}),
        ...(detection.path ? { codexPath: detection.path } : {}),
        endpointsEnabled,
        profileName: CODEX_SETUP_PROFILE_NAME,
        profilePath,
        launchCommand: buildLaunchCommand({
          binaryPath: detection.path,
          codexHome,
          includeCodexHome: codexHome !== defaultCodexHome,
          platform,
        }),
        bridge: bridgeSnapshot(),
        canConfigure,
        canRemove,
        canRepair,
      },
    };
  };

  const status = async (): Promise<CodexSetupStatusResponse> => (await inspect()).status;

  // Exclusive create, never overwrite: the whole point of the backup is that a
  // file Gezel does not own survives, and that includes an earlier backup.
  const preserveConflictingProfile = (content: string): Promise<string> =>
    preserveConflictingFile({
      path: profilePath,
      content,
      mode: 0o600,
      code: 'codex_profile_backup_failed',
    });

  const configure = (input: ConfigureCodexRequest): Promise<CodexSetupStatusResponse> =>
    serialize(async () => {
      if (closing) {
        throw new CodexSetupError(
          'service_stopping',
          'Gezel is stopping and cannot change the Codex setup.',
          409,
        );
      }
      const before = await inspect();
      if (!before.status.endpointsEnabled) {
        throw new CodexSetupError(
          'openai_endpoints_disabled',
          'Turn on Allow apps to connect before setting up Codex.',
        );
      }
      if (!before.detection.installed || !isSupportedCodexVersion(before.detection.version)) {
        throw new CodexSetupError('codex_unavailable', codexVersionReason(before.detection));
      }
      const repairing = input.backupConflictingProfile === true && before.status.canRepair;
      if (before.status.state === 'conflict' && !repairing) {
        throw new CodexSetupError(
          'codex_profile_conflict',
          before.status.message ?? `${profilePath} is not managed by Gezel.`,
        );
      }
      const selected = findHarnessModel(before.models, input.model);
      if (!selected) {
        throw new CodexSetupError(
          'model_not_available',
          `The selected gezel or local model is not available for Codex: ${input.model}`,
          404,
        );
      }

      await opts.bridge.start().catch((error) => {
        throw new CodexSetupError('codex_bridge_unavailable', asError(error).message);
      });
      let issuedNewToken = false;
      let backup: { path: string; content: string } | null = null;
      try {
        const currentProfile = await readOptionalFile(profilePath);
        const foreignProfile =
          currentProfile !== null && !isManagedProfile(currentProfile, setupOwnerId)
            ? currentProfile
            : null;
        if (foreignProfile !== null && !repairing) {
          throw new CodexSetupError(
            'codex_profile_conflict',
            `${profilePath} changed while setup was running and was not overwritten.`,
          );
        }
        const baseUrl = bridgeSnapshot().baseUrl;
        await ensurePrivateDir(integrationDir);
        await mkdir(codexHome, { recursive: true });

        let record = harnessTokenRecord(opts.tokenStore, CODEX_SETUP_APP_ID);
        if (
          record &&
          record.appName === CODEX_SETUP_APP_NAME &&
          !isExactHarnessToken(record, CODEX_SETUP_APP_NAME)
        ) {
          await opts.tokenStore.revoke(CODEX_SETUP_APP_ID);
          record = undefined;
        }
        if (!record) {
          record = await opts.tokenStore.issue({
            appId: CODEX_SETUP_APP_ID,
            appName: CODEX_SETUP_APP_NAME,
            scopes: ['openai'],
          });
          issuedNewToken = true;
        }

        const createdAt = before.state?.createdAt ?? now().toISOString();
        const nextState: SetupState = {
          version: CODEX_SETUP_REVISION,
          model: selected.id,
          ...(selected.kind === 'gezel' ? { gezelId: selected.gezelId } : {}),
          createdAt,
          updatedAt: now().toISOString(),
        };
        const catalog = { models: before.models.map(catalogModelFor) };
        const profile = buildProfile({
          model: selected,
          baseUrl,
          catalogPath,
          tokenPath,
          platform,
          setupOwnerId,
        });

        // Publish the secret first, then the catalog/profile, and the state
        // marker last. A crash becomes a visible update-needed setup rather
        // than a state record that falsely claims every dependent file exists.
        await writeFileAtomic(tokenPath, `${record.token}\n`, { mode: 0o600, durable: true });
        await writeFileAtomic(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, {
          mode: 0o600,
          durable: true,
        });
        if ((await readOptionalFile(profilePath)) !== currentProfile) {
          throw new CodexSetupError(
            'codex_profile_conflict',
            `${profilePath} changed while setup was running and was not overwritten.`,
          );
        }
        if (foreignProfile !== null) {
          backup = {
            path: await preserveConflictingProfile(foreignProfile),
            content: foreignProfile,
          };
        }
        await writeFileAtomic(profilePath, profile, { mode: 0o600, durable: true });
        await writeSecurityJson(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
        const published = await status();
        return backup ? { ...published, profileBackupPath: backup.path } : published;
      } catch (error) {
        if (backup) {
          // Undo the move before any other cleanup: the file we displaced is the
          // user's, and a failed repair must leave it where they left it.
          const published = await readOptionalFile(profilePath).catch(() => null);
          if (published === null || isManagedProfile(published, setupOwnerId)) {
            await writeFileAtomic(profilePath, backup.content, {
              mode: 0o600,
              durable: true,
            }).catch(() => undefined);
          }
          await rm(backup.path, { force: true }).catch(() => undefined);
        }
        if (issuedNewToken) await opts.tokenStore.revoke(CODEX_SETUP_APP_ID).catch(() => false);
        if (!before.state) {
          const publishedProfile = await readOptionalFile(profilePath).catch(() => null);
          if (publishedProfile !== null && isManagedProfile(publishedProfile, setupOwnerId)) {
            await rm(profilePath, { force: true }).catch(() => undefined);
          }
          await rm(integrationDir, { recursive: true, force: true }).catch(() => undefined);
          await opts.bridge.stop().catch(() => undefined);
        }
        throw error;
      }
    });

  const removeSetup = (): Promise<CodexSetupStatusResponse> =>
    serialize(async () => {
      const failures: unknown[] = [];
      await opts.bridge.stop().catch((error) => failures.push(error));

      const profile = await readOptionalFile(profilePath).catch((error) => {
        failures.push(error);
        return null;
      });
      if (profile !== null && isManagedProfile(profile, setupOwnerId)) {
        await rm(profilePath, { force: true }).catch((error) => failures.push(error));
      }
      const record = harnessTokenRecord(opts.tokenStore, CODEX_SETUP_APP_ID);
      if (record?.appName === CODEX_SETUP_APP_NAME) {
        await opts.tokenStore.revoke(CODEX_SETUP_APP_ID).catch((error) => failures.push(error));
      }
      await rm(integrationDir, { recursive: true, force: true }).catch((error) =>
        failures.push(error),
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Could not completely remove the Gezel Codex setup.');
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
      const record = harnessTokenRecord(opts.tokenStore, CODEX_SETUP_APP_ID);
      const tokenFile = await readOptionalFile(tokenPath);
      const profile = await readOptionalFile(profilePath);
      if (
        !isExactHarnessToken(record, CODEX_SETUP_APP_NAME) ||
        tokenFile?.trim() !== record.token ||
        profile === null ||
        !isManagedProfile(profile, setupOwnerId)
      ) {
        await opts.bridge.stop();
        return;
      }
      const models = await listEligibleModels(config);
      const selected = findHarnessModel(models, state.model, state.gezelId);
      if (!selected) {
        await opts.bridge.stop();
        return;
      }
      if ((await readOptionalFile(profilePath)) !== profile) {
        await opts.bridge.stop();
        return;
      }
      await opts.bridge.start();
      // An ephemeral test bridge (or a future repaired port) changes only the
      // managed address. Reconcile it without touching unrelated Codex files.
      await writeFileAtomic(
        catalogPath,
        `${JSON.stringify({ models: models.map(catalogModelFor) }, null, 2)}\n`,
        { mode: 0o600, durable: true },
      );
      await writeFileAtomic(
        profilePath,
        buildProfile({
          model: selected,
          baseUrl: bridgeSnapshot().baseUrl,
          catalogPath,
          tokenPath,
          platform,
          setupOwnerId,
        }),
        { mode: 0o600, durable: true },
      );
      const selectedGezelId = selected.kind === 'gezel' ? selected.gezelId : undefined;
      if (state.model !== selected.id || state.gezelId !== selectedGezelId) {
        await writeSecurityJson(
          statePath,
          `${JSON.stringify(
            {
              ...state,
              model: selected.id,
              gezelId: selectedGezelId,
              updatedAt: now().toISOString(),
            },
            null,
            2,
          )}\n`,
        );
      }
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
    codexModelCatalog,
  };
}

function isManagedProfile(content: string, setupOwnerId: string): boolean {
  return PROFILE_MARKER.isManaged(content, setupOwnerId);
}

function buildProfile(input: {
  model: CodexSetupModelOption;
  baseUrl: string;
  catalogPath: string;
  tokenPath: string;
  platform: NodeJS.Platform;
  setupOwnerId: string;
}): string {
  const contextWindow = input.model.contextWindow ?? 32_768;
  const auth = authCommand(input.tokenPath, input.platform);
  const body = `# Select with: codex --profile ${CODEX_SETUP_PROFILE_NAME}
model = ${tomlString(input.model.id)}
model_provider = "gezel"
model_context_window = ${contextWindow}
model_catalog_json = ${tomlString(input.catalogPath)}
web_search = "disabled"

[model_providers.gezel]
name = "Gezel"
base_url = ${tomlString(input.baseUrl)}
wire_api = "responses"

[model_providers.gezel.auth]
command = ${tomlString(auth.command)}
args = ${tomlArray(auth.args)}
timeout_ms = 5000
refresh_interval_ms = 300000
`;
  return PROFILE_MARKER.build(body, input.setupOwnerId);
}

function authCommand(
  tokenPath: string,
  platform: NodeJS.Platform,
): { command: string; args: string[] } {
  if (platform !== 'win32') return { command: '/bin/cat', args: [tokenPath] };
  const literalPath = tokenPath.replace(/'/g, "''");
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-Content -Raw -LiteralPath '${literalPath}').Trim()`,
    ],
  };
}

function buildLaunchCommand(input: {
  binaryPath?: string;
  codexHome: string;
  includeCodexHome: boolean;
  platform: NodeJS.Platform;
}): string {
  const binary = input.binaryPath ?? 'codex';
  if (input.platform === 'win32') {
    const invocation = `& ${powershellLiteral(binary)} --profile ${powershellLiteral(CODEX_SETUP_PROFILE_NAME)}`;
    return input.includeCodexHome
      ? `$env:CODEX_HOME = ${powershellLiteral(input.codexHome)}; ${invocation}`
      : invocation;
  }

  const invocation = `${posixShellWord(binary)} --profile ${posixShellWord(CODEX_SETUP_PROFILE_NAME)}`;
  return input.includeCodexHome
    ? `CODEX_HOME=${posixShellWord(input.codexHome)} ${invocation}`
    : invocation;
}

function catalogModelFor(model: CodexSetupModelOption): CodexCatalogModel {
  const contextWindow = model.contextWindow ?? 32_768;
  return {
    slug: model.id,
    display_name: model.label,
    description: model.description ?? `Local model served by Gezel (${model.provider}).`,
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: 0,
    availability_nux: null,
    upgrade: null,
    base_instructions: '',
    include_skills_usage_instructions: true,
    include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true,
    supports_reasoning_summary_parameter: false,
    default_reasoning_summary: 'none',
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text',
    truncation_policy: { mode: 'bytes', limit: 100_000 },
    supports_parallel_tool_calls: false,
    supports_image_detail_original: false,
    context_window: contextWindow,
    max_context_window: contextWindow,
    auto_compact_token_limit: Math.max(1, Math.floor(contextWindow * 0.9)),
    effective_context_window_percent: 90,
    experimental_supported_tools: [],
    input_modalities: ['text'],
    supports_search_tool: false,
    // A user-level Codex Fast preference is inherited by named profiles as
    // `service_tier = "priority"`. Gezel local inference has no paid/queued
    // service classes, but its Responses facade accepts this scheduling hint
    // as a no-op. Advertising that compatibility keeps Codex from warning and
    // stripping the field whenever the Gezel profile is selected.
    default_service_tier: null,
    service_tiers: [
      {
        id: 'priority',
        name: 'Fast',
        description: 'Accepted for compatibility; local inference uses its normal scheduling.',
      },
    ],
    additional_speed_tiers: [],
    use_responses_lite: false,
  };
}

function isSupportedCodexVersion(raw: string | undefined): boolean {
  const parsed = raw ? /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\D|$)/.exec(raw) : null;
  if (!parsed) return false;
  const version = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])] as const;
  for (let i = 0; i < MINIMUM_CODEX_VERSION.length; i++) {
    if (version[i]! > MINIMUM_CODEX_VERSION[i]!) return true;
    if (version[i]! < MINIMUM_CODEX_VERSION[i]!) return false;
  }
  return true;
}

function codexVersionReason(detection: CodexBinaryDetection): string {
  if (!detection.installed) {
    return detection.error ?? 'Codex CLI was not found. Install Codex 0.147.0 or newer first.';
  }
  return `Codex ${detection.version ?? '(unknown version)'} is not supported. Update to Codex 0.147.0 or newer.`;
}

function decodeSetupState(raw: string): SetupState {
  const parsed = JSON.parse(raw) as Partial<SetupState>;
  if (
    parsed.version !== CODEX_SETUP_REVISION ||
    typeof parsed.model !== 'string' ||
    !parsed.model ||
    typeof parsed.createdAt !== 'string' ||
    typeof parsed.updatedAt !== 'string'
  ) {
    throw new Error('invalid setup record');
  }
  return parsed as SetupState;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}
