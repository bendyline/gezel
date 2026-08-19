import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ConfigureVSCodeRequest,
  GezelConfig,
  GezelSummary,
  LocalHarnessModelOption,
  ProviderName,
  VSCodeSetupProfileOption,
  VSCodeSetupStatusResponse,
} from '@bendyline/gezel';
import { writeFileAtomic } from '../fs/atomic.js';
import { readSecurityJson, writeSecurityJson } from '../fs/security-json.js';
import { type TokenStore, VSCODE_SETUP_RESERVED_APP_ID } from '../http/token-store.js';
import type { VSCodeBridgeController } from '../http/vscode-bridge.js';
import {
  HarnessSetupError,
  asError,
  createMutationQueue,
  ensurePrivateDir,
  harnessBridgeSnapshot,
  harnessTokenRecord,
  isExactHarnessToken,
  listEligibleHarnessModels,
  preserveConflictingFile,
  readOptionalFile,
  recommendedHarnessModel,
} from '../local-harness/base.js';
import type { ModelInfo } from '../providers/types.js';
import { type VSCodeBinaryDetection, detectVSCodeBinary } from './binary.js';
import {
  type VSCodeProviderEntry,
  inspectVSCodeConfig,
  removeGezelProvider,
  stableJson,
  upsertGezelProvider,
} from './profile-config.js';
import { discoverVSCodeProfiles, vscodeUserDir } from './profiles.js';

export const VSCODE_SETUP_PROVIDER_ID = 'customendpoint';
export const VSCODE_SETUP_APP_ID = VSCODE_SETUP_RESERVED_APP_ID;
export const VSCODE_SETUP_REVISION = 1;
const VSCODE_SETUP_APP_NAME = 'Visual Studio Code (Gezel local models)';
const DEFAULT_CONTEXT_WINDOW = 32_768;
const OUTPUT_LIMIT_SHARE = 0.25;
const MAX_OUTPUT_LIMIT = 32_768;
const RECONCILE_INTERVAL_MS = 30_000;

interface SetupState {
  version: 1;
  profileId: string;
  product: 'code' | 'code-insiders';
  configPath: string;
  createdAt: string;
  updatedAt: string;
  /** Semantic digest of only the Gezel provider, never the shared file. */
  providerDigest: string;
}

type ConflictKind = 'config' | 'credential' | 'state';

export class VSCodeSetupError extends HarnessSetupError {
  constructor(code: string, message: string, status: 400 | 404 | 409 | 500 = 409) {
    super(code, message, status);
    this.name = 'VSCodeSetupError';
  }
}

export interface VSCodeSetupManager {
  status(): Promise<VSCodeSetupStatusResponse>;
  configure(input: ConfigureVSCodeRequest): Promise<VSCodeSetupStatusResponse>;
  remove(): Promise<VSCodeSetupStatusResponse>;
  reconcile(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateVSCodeSetupManagerOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  tokenStore: TokenStore;
  bridge: VSCodeBridgeController;
  readConfig: () => Promise<GezelConfig>;
  listGezels: () => Promise<GezelSummary[]>;
  providerForGezel: (gezelId: string) => Promise<ProviderName>;
  listModels: (provider: ProviderName) => Promise<ModelInfo[]>;
  detectVSCode?: () => Promise<VSCodeBinaryDetection>;
  /** Test/portable-install override for VS Code's profile root. */
  vscodeUserDir?: string;
  now?: () => Date;
  reconcileIntervalMs?: number;
}

export function createVSCodeSetupManager(
  opts: CreateVSCodeSetupManagerOptions,
): VSCodeSetupManager {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const integrationDir = join(opts.home, 'integrations', 'vscode');
  const statePath = join(integrationDir, 'setup.json');
  const now = opts.now ?? (() => new Date());
  const detect = opts.detectVSCode ?? (() => detectVSCodeBinary({ env }));
  const serialize = createMutationQueue();
  let closing = false;
  let poller: ReturnType<typeof setInterval> | undefined;

  const bridgeSnapshot = () => harnessBridgeSnapshot(opts.bridge);
  const readState = async (): Promise<SetupState | null> =>
    readSecurityJson(statePath, 'VS Code setup', decodeSetupState);
  const listEligibleModels = async (
    suppliedConfig?: GezelConfig,
  ): Promise<LocalHarnessModelOption[]> =>
    listEligibleHarnessModels({
      config: suppliedConfig ?? (await opts.readConfig()),
      listModels: opts.listModels,
      listGezels: opts.listGezels,
      providerForGezel: opts.providerForGezel,
    });
  const listProfiles = async (
    detection: VSCodeBinaryDetection,
    state: SetupState | null,
  ): Promise<VSCodeSetupProfileOption[]> => {
    const userDir = vscodeUserDir({
      product: detection.product,
      override: opts.vscodeUserDir,
      env,
      platform,
    });
    const profiles = await discoverVSCodeProfiles({ product: detection.product, userDir });
    if (state && !profiles.some((profile) => profile.id === state.profileId)) {
      profiles.push({
        id: state.profileId,
        label: `Configured profile (${state.profileId.split(':').slice(1).join(':')})`,
        product: state.product,
        configPath: state.configPath,
      });
    }
    return profiles;
  };

  const inspect = async (): Promise<{
    status: VSCodeSetupStatusResponse;
    state: SetupState | null;
    models: LocalHarnessModelOption[];
    profiles: VSCodeSetupProfileOption[];
    configContent: string | null;
    conflict: ConflictKind | null;
  }> => {
    const configPromise = opts.readConfig();
    const [config, models, detection, stateResult] = await Promise.all([
      configPromise,
      configPromise.then((value) => listEligibleModels(value)),
      detect(),
      readState().then(
        (value) => ({ value, error: null as Error | null }),
        (error) => ({ value: null, error: asError(error) }),
      ),
    ]);
    const state = stateResult.value;
    const profiles = await listProfiles(detection, state);
    const selectedProfile =
      (state ? profiles.find((profile) => profile.id === state.profileId) : undefined) ??
      profiles[0]!;
    const configContent = await readOptionalFile(selectedProfile.configPath);
    const tokenRecord = harnessTokenRecord(opts.tokenStore, VSCODE_SETUP_APP_ID);
    const tokenOwnedBySetup = tokenRecord?.appName === VSCODE_SETUP_APP_NAME;
    const endpointsEnabled = config.openaiEndpoints?.enabled !== false;
    const recommendedModel = recommendedHarnessModel(models, config.meesterGezelId);
    const reasons: string[] = [];
    let statusState: VSCodeSetupStatusResponse['state'] = 'not-configured';
    let message: string | undefined;
    let conflict: ConflictKind | null = null;
    let provider: VSCodeProviderEntry | undefined;
    let providerIsOurs = false;
    let configError: Error | null = null;

    try {
      const inspection = inspectVSCodeConfig(configContent);
      if (inspection.gezelIndexes.length > 1) {
        configError = new Error('The profile contains more than one Gezel provider entry.');
      } else {
        provider = inspection.gezelProvider;
        providerIsOurs = Boolean(
          state && provider && providerDigest(provider) === state.providerDigest,
        );
      }
    } catch (error) {
      configError = asError(error);
    }

    if (stateResult.error) {
      statusState = 'conflict';
      conflict = 'state';
      message = 'Gezel found damaged VS Code setup state and left the profile file untouched.';
    } else if (tokenRecord && !tokenOwnedBySetup) {
      statusState = 'conflict';
      conflict = 'credential';
      message =
        'Another connected app is using Gezel’s reserved VS Code credential identity. Revoke that app before setting up VS Code.';
    } else if (configError || (provider && !providerIsOurs)) {
      statusState = 'conflict';
      conflict = 'config';
      message = configError
        ? `${selectedProfile.configPath} could not be safely merged: ${configError.message}`
        : `${selectedProfile.configPath} contains a Gezel provider changed outside this setup or belonging to another Gezel home. It was preserved.`;
    } else if (state) {
      if (!endpointsEnabled) reasons.push('Connected-app model serving is turned off.');
      if (models.length === 0) reasons.push('No eligible local chat models are installed.');
      if (!provider) reasons.push('The Gezel provider entry is missing from this VS Code profile.');
      if (!isExactHarnessToken(tokenRecord, VSCODE_SETUP_APP_NAME)) {
        reasons.push('The VS Code app credential was revoked or is invalid.');
      } else if (provider) {
        const expected = buildVSCodeProvider({
          models,
          baseUrl: bridgeSnapshot().baseUrl,
          token: tokenRecord.token,
        });
        if (providerDigest(expected) !== providerDigest(provider)) {
          reasons.push('The VS Code model list or endpoint settings are out of date.');
        }
      }
      if (endpointsEnabled && !opts.bridge.status().listening) {
        reasons.push('The VS Code inference bridge is not running.');
      }
      statusState = reasons.length === 0 ? 'configured' : 'update-needed';
    } else if (models.length === 0) {
      statusState = 'unavailable';
      message = 'Install a local chat model with tool support before setting up VS Code.';
    }

    const publishable = endpointsEnabled && models.length > 0;
    return {
      state,
      models,
      profiles,
      configContent,
      conflict,
      status: {
        state: statusState,
        models,
        ...(recommendedModel ? { recommendedModel } : {}),
        reasons,
        ...(message ? { message } : {}),
        vscodeInstalled: detection.installed,
        ...(detection.version ? { vscodeVersion: detection.version } : {}),
        ...(detection.path ? { vscodePath: detection.path } : {}),
        endpointsEnabled,
        providerId: VSCODE_SETUP_PROVIDER_ID,
        profiles,
        ...(state ? { configuredProfileId: state.profileId } : {}),
        configPath: selectedProfile.configPath,
        launchCommand:
          detection.path ?? (detection.product === 'code-insiders' ? 'code-insiders' : 'code'),
        bridge: bridgeSnapshot(),
        canConfigure: publishable && statusState !== 'conflict',
        canRemove: Boolean(state || stateResult.error || tokenOwnedBySetup || providerIsOurs),
        canRepair: publishable && conflict === 'config',
      },
    };
  };

  const status = async (): Promise<VSCodeSetupStatusResponse> => (await inspect()).status;

  const configure = (input: ConfigureVSCodeRequest): Promise<VSCodeSetupStatusResponse> =>
    serialize(async () => {
      if (closing) {
        throw new VSCodeSetupError(
          'service_stopping',
          'Gezel is stopping and cannot change the VS Code setup.',
        );
      }
      const before = await inspect();
      if (!before.status.endpointsEnabled) {
        throw new VSCodeSetupError(
          'openai_endpoints_disabled',
          'Turn on Allow apps to connect before setting up VS Code.',
        );
      }
      if (before.models.length === 0) {
        throw new VSCodeSetupError(
          'model_not_available',
          'No eligible local chat model is available for VS Code.',
          404,
        );
      }
      const profile = before.profiles.find((candidate) => candidate.id === input.profileId);
      if (!profile) {
        throw new VSCodeSetupError(
          'profile_not_found',
          `The selected VS Code profile is no longer available: ${input.profileId}`,
          404,
        );
      }
      const repairing = input.backupConflictingConfig === true;
      if (before.status.state === 'conflict' && !repairing) {
        throw new VSCodeSetupError(
          'vscode_config_conflict',
          before.status.message ?? `${before.status.configPath} could not be safely merged.`,
        );
      }
      if (before.conflict && before.conflict !== 'config') {
        throw new VSCodeSetupError(
          'vscode_setup_conflict',
          before.status.message ?? 'The VS Code setup has an unresolved conflict.',
        );
      }

      const targetOriginal = await readOptionalFile(profile.configPath);
      const oldPath = before.state?.configPath;
      const oldOriginal =
        oldPath && oldPath !== profile.configPath ? await readOptionalFile(oldPath) : null;
      await opts.bridge.start().catch((error) => {
        throw new VSCodeSetupError('vscode_bridge_unavailable', asError(error).message);
      });
      let issuedNewToken = false;
      let backupPath: string | undefined;
      let targetPublished: string | null = null;
      let oldPublished: string | null = null;
      let committed = false;
      try {
        await ensurePrivateDir(integrationDir);
        await mkdir(dirname(profile.configPath), { recursive: true });
        let record = harnessTokenRecord(opts.tokenStore, VSCODE_SETUP_APP_ID);
        if (
          record &&
          record.appName === VSCODE_SETUP_APP_NAME &&
          !isExactHarnessToken(record, VSCODE_SETUP_APP_NAME)
        ) {
          await opts.tokenStore.revoke(VSCODE_SETUP_APP_ID);
          record = undefined;
        }
        if (!record) {
          record = await opts.tokenStore.issue({
            appId: VSCODE_SETUP_APP_ID,
            appName: VSCODE_SETUP_APP_NAME,
            scopes: ['openai'],
          });
          issuedNewToken = true;
        }
        if (!isExactHarnessToken(record, VSCODE_SETUP_APP_NAME)) {
          throw new VSCodeSetupError(
            'vscode_credential_conflict',
            'The reserved VS Code credential belongs to another connected app.',
          );
        }

        const provider = buildVSCodeProvider({
          models: before.models,
          baseUrl: bridgeSnapshot().baseUrl,
          token: record.token,
        });
        let nextContent: string;
        let targetConflict = false;
        try {
          const targetInspection = inspectVSCodeConfig(targetOriginal);
          targetConflict =
            targetInspection.gezelIndexes.length > 0 &&
            !(
              before.state?.configPath === profile.configPath &&
              targetInspection.gezelProvider &&
              providerDigest(targetInspection.gezelProvider) === before.state?.providerDigest
            );
          if (targetInspection.gezelIndexes.length > 1) targetConflict = true;
          if (targetConflict && !repairing) {
            throw new VSCodeSetupError(
              'vscode_config_conflict',
              `${profile.configPath} already contains a Gezel provider that was not overwritten.`,
            );
          }
          nextContent = upsertGezelProvider(targetOriginal, provider, {
            replaceConflict: targetInspection.gezelIndexes.length === 1,
          });
        } catch (error) {
          if (error instanceof VSCodeSetupError) throw error;
          targetConflict = true;
          if (!repairing) {
            throw new VSCodeSetupError(
              'vscode_config_conflict',
              `${profile.configPath} could not be safely merged: ${asError(error).message}`,
            );
          }
          nextContent = upsertGezelProvider(null, provider);
        }

        if ((await readOptionalFile(profile.configPath)) !== targetOriginal) {
          throw new VSCodeSetupError(
            'vscode_config_conflict',
            `${profile.configPath} changed while setup was running and was not overwritten.`,
          );
        }
        if (targetConflict && targetOriginal !== null) {
          backupPath = await preserveConflictingFile({
            path: profile.configPath,
            content: targetOriginal,
            mode: 0o600,
            code: 'vscode_config_backup_failed',
          });
        }
        await writeFileAtomic(profile.configPath, nextContent, { mode: 0o600, durable: true });
        targetPublished = nextContent;

        if (oldPath && oldPath !== profile.configPath && oldOriginal !== null) {
          if ((await readOptionalFile(oldPath)) !== oldOriginal) {
            throw new VSCodeSetupError(
              'vscode_config_conflict',
              `${oldPath} changed while the profile selection was being updated.`,
            );
          }
          const oldInspection = inspectVSCodeConfig(oldOriginal);
          if (
            oldInspection.gezelProvider &&
            before.state &&
            providerDigest(oldInspection.gezelProvider) === before.state.providerDigest
          ) {
            const nextOld = removeGezelProvider(oldOriginal);
            await writeFileAtomic(oldPath, nextOld, {
              mode: 0o600,
              durable: true,
            });
            oldPublished = nextOld;
          }
        }

        const timestamp = now().toISOString();
        const nextState: SetupState = {
          version: VSCODE_SETUP_REVISION,
          profileId: profile.id,
          product: profile.product,
          configPath: profile.configPath,
          createdAt: before.state?.createdAt ?? timestamp,
          updatedAt: timestamp,
          providerDigest: providerDigest(provider),
        };
        await writeSecurityJson(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
        committed = true;
        ensurePoller();
        const published = await status();
        return backupPath ? { ...published, configBackupPath: backupPath } : published;
      } catch (error) {
        if (committed) throw error;
        if (issuedNewToken) await opts.tokenStore.revoke(VSCODE_SETUP_APP_ID).catch(() => false);
        let targetRestored = false;
        if (
          targetPublished !== null &&
          (await readOptionalFile(profile.configPath).catch(() => null)) === targetPublished
        ) {
          await restoreFile(profile.configPath, targetOriginal).catch(() => undefined);
          targetRestored = true;
        }
        if (
          oldPath &&
          oldPath !== profile.configPath &&
          oldPublished !== null &&
          (await readOptionalFile(oldPath).catch(() => null)) === oldPublished
        ) {
          await restoreFile(oldPath, oldOriginal).catch(() => undefined);
        }
        if (backupPath && targetRestored) {
          await rm(backupPath, { force: true }).catch(() => undefined);
        }
        if (!before.state) {
          await rm(integrationDir, { recursive: true, force: true }).catch(() => undefined);
          await opts.bridge.stop().catch(() => undefined);
        }
        throw error;
      }
    });

  const removeSetup = (): Promise<VSCodeSetupStatusResponse> =>
    serialize(async () => {
      const state = await readState().catch(() => null);
      await opts.bridge.stop();
      if (state) {
        const current = await readOptionalFile(state.configPath);
        if (current !== null) {
          let inspection: ReturnType<typeof inspectVSCodeConfig> | null = null;
          try {
            inspection = inspectVSCodeConfig(current);
          } catch {
            // Shared user data that no longer parses is preserved. Clearing
            // still revokes the credential and removes Gezel-owned state.
          }
          if (
            inspection?.gezelProvider &&
            providerDigest(inspection.gezelProvider) === state.providerDigest
          ) {
            const next = removeGezelProvider(current);
            if ((await readOptionalFile(state.configPath)) === current) {
              await writeFileAtomic(state.configPath, next, {
                mode: 0o600,
                durable: true,
              });
            }
          }
        }
      }
      const record = harnessTokenRecord(opts.tokenStore, VSCODE_SETUP_APP_ID);
      if (record?.appName === VSCODE_SETUP_APP_NAME) {
        await opts.tokenStore.revoke(VSCODE_SETUP_APP_ID);
      }
      await rm(integrationDir, { recursive: true, force: true });
      if (poller) clearInterval(poller);
      poller = undefined;
      return status();
    });

  const reconcileWork = async (): Promise<void> => {
    if (closing) {
      await opts.bridge.stop();
      return;
    }
    const [config, state] = await Promise.all([opts.readConfig(), readState().catch(() => null)]);
    if (!state) {
      await opts.bridge.stop();
      return;
    }
    ensurePoller();
    if (config.openaiEndpoints?.enabled === false) {
      await opts.bridge.stop();
      return;
    }
    const record = harnessTokenRecord(opts.tokenStore, VSCODE_SETUP_APP_ID);
    const current = await readOptionalFile(state.configPath);
    if (!isExactHarnessToken(record, VSCODE_SETUP_APP_NAME) || current === null) {
      await opts.bridge.stop();
      return;
    }
    let inspection: ReturnType<typeof inspectVSCodeConfig>;
    try {
      inspection = inspectVSCodeConfig(current);
    } catch {
      await opts.bridge.stop();
      return;
    }
    if (
      !inspection.gezelProvider ||
      providerDigest(inspection.gezelProvider) !== state.providerDigest
    ) {
      await opts.bridge.stop();
      return;
    }
    const models = await listEligibleModels(config);
    if (models.length === 0) {
      await opts.bridge.stop();
      return;
    }
    await opts.bridge.start();
    const provider = buildVSCodeProvider({
      models,
      baseUrl: bridgeSnapshot().baseUrl,
      token: record.token,
    });
    const nextDigest = providerDigest(provider);
    if (nextDigest === state.providerDigest) return;
    const next = upsertGezelProvider(current, provider, { replaceConflict: true });
    if ((await readOptionalFile(state.configPath)) !== current) return;
    await writeFileAtomic(state.configPath, next, { mode: 0o600, durable: true });
    await writeSecurityJson(
      statePath,
      `${JSON.stringify({ ...state, updatedAt: now().toISOString(), providerDigest: nextDigest }, null, 2)}\n`,
    );
  };

  const reconcile = (): Promise<void> => serialize(reconcileWork);
  const ensurePoller = (): void => {
    if (poller || closing) return;
    poller = setInterval(
      () => void reconcile().catch(() => undefined),
      opts.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS,
    );
    poller.unref?.();
  };

  return {
    status,
    configure,
    remove: removeSetup,
    reconcile,
    stop: () => {
      closing = true;
      if (poller) clearInterval(poller);
      poller = undefined;
      return serialize(() => opts.bridge.stop());
    },
  };
}

export function buildVSCodeProvider(input: {
  models: LocalHarnessModelOption[];
  baseUrl: string;
  token: string;
}): VSCodeProviderEntry {
  return {
    name: 'Gezel',
    vendor: VSCODE_SETUP_PROVIDER_ID,
    apiKey: input.token,
    apiType: 'chat-completions',
    models: [...input.models]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((model) => {
        const context = model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
        const output = Math.max(
          1,
          Math.min(MAX_OUTPUT_LIMIT, Math.floor(context * OUTPUT_LIMIT_SHARE)),
        );
        return {
          id: model.id,
          name: model.description ? `${model.label} — ${model.description}` : model.label,
          url: `${input.baseUrl}/chat/completions`,
          // Some VS Code distributions load an injected model roster without
          // hydrating the provider-level apiKey into their secret-backed BYOK
          // state. An explicit model header is part of the Custom Endpoint
          // contract and makes the already-plaintext setup credential work in
          // those builds too. VS Code suppresses its inferred auth header when
          // this well-known header is present, so only one credential is sent.
          requestHeaders: {
            Authorization: `Bearer ${input.token}`,
          },
          toolCalling: true,
          ...(model.supportsReasoning === true ? { thinking: true } : {}),
          vision: false,
          maxInputTokens: Math.max(1, context - output),
          maxOutputTokens: output,
        };
      }),
  };
}

function providerDigest(provider: VSCodeProviderEntry): string {
  return createHash('sha256').update(stableJson(provider)).digest('hex');
}

async function restoreFile(path: string, content: string | null): Promise<void> {
  if (content === null) {
    await rm(path, { force: true });
  } else {
    await writeFileAtomic(path, content, { mode: 0o600, durable: true });
  }
}

function decodeSetupState(raw: string): SetupState {
  const parsed = JSON.parse(raw) as Partial<SetupState>;
  if (
    parsed.version !== VSCODE_SETUP_REVISION ||
    typeof parsed.profileId !== 'string' ||
    !parsed.profileId ||
    (parsed.product !== 'code' && parsed.product !== 'code-insiders') ||
    typeof parsed.configPath !== 'string' ||
    !parsed.configPath ||
    typeof parsed.createdAt !== 'string' ||
    typeof parsed.updatedAt !== 'string' ||
    typeof parsed.providerDigest !== 'string' ||
    !parsed.providerDigest
  ) {
    throw new Error('invalid setup record');
  }
  return parsed as SetupState;
}
