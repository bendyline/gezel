import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ConfigurePiRequest,
  GezelConfig,
  GezelSummary,
  InstallPiExtensionRequest,
  PiSetupExtension,
  PiSetupModelOption,
  PiSetupStatusResponse,
  ProviderName,
} from '@bendyline/gezel';
import { writeFileAtomic } from '../fs/atomic.js';
import { setupOwnerId as managedFileOwnerId } from '../fs/managed-marker.js';
import { readSecurityJson, writeSecurityJson } from '../fs/security-json.js';
import type { PiBridgeController } from '../http/pi-bridge.js';
import { PI_SETUP_RESERVED_APP_ID, type TokenStore } from '../http/token-store.js';
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
import type { ModelInfo } from '../providers/types.js';
import {
  type PiAgentDir,
  piExtensionDir,
  piExtensionPath,
  resolvePiAgentDir,
} from './agent-dir.js';
import { type PiBinaryDetection, detectPiBinary } from './binary.js';
import { PI_EXTENSION_MARKER, buildPiExtensionSource } from './extension-source.js';

/** Provider id registered with pi; also the `<provider>/<model>` prefix it shows. */
export const PI_SETUP_PROVIDER_ID = 'gezel';
export const PI_SETUP_APP_ID = PI_SETUP_RESERVED_APP_ID;
export const PI_SETUP_REVISION = 1;
const PI_SETUP_APP_NAME = 'pi (Gezel local models)';

const ROSTER_FILE = 'models.json';
const TOKEN_FILE = 'token';
const EXTENSION_FILE = 'gezel.js';
const PROVIDER_DISPLAY_NAME = 'Gezel (local)';
/** pi's dialect for an OpenAI `/v1/chat/completions` endpoint. */
const PROVIDER_API = 'openai-completions';
const DEFAULT_CONTEXT_WINDOW = 32_768;
const OUTPUT_LIMIT_SHARE = 0.25;
const MAX_OUTPUT_LIMIT = 32_768;

interface SetupState {
  version: 1;
  model: string;
  /** Stable identity behind a human-readable gezel model id. */
  gezelId?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * SHA-256 of the roster exactly as Gezel last wrote it. The roster lives
   * inside GEZEL_HOME, so ownership is proven from Gezel's own state; the
   * extension, which may be copied into pi's directory, carries an in-file
   * marker instead.
   */
  configDigest: string;
}

type ConflictKind = 'config' | 'credential' | 'state';

export class PiSetupError extends HarnessSetupError {
  constructor(code: string, message: string, status: 400 | 404 | 409 | 500 = 409) {
    super(code, message, status);
    this.name = 'PiSetupError';
  }
}

export interface PiSetupManager {
  status(): Promise<PiSetupStatusResponse>;
  configure(input: ConfigurePiRequest): Promise<PiSetupStatusResponse>;
  installExtension(input: InstallPiExtensionRequest): Promise<PiSetupStatusResponse>;
  removeExtension(): Promise<PiSetupStatusResponse>;
  remove(): Promise<PiSetupStatusResponse>;
  reconcile(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreatePiSetupManagerOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  tokenStore: TokenStore;
  bridge: PiBridgeController;
  readConfig: () => Promise<GezelConfig>;
  listGezels: () => Promise<GezelSummary[]>;
  providerForGezel: (gezelId: string) => Promise<ProviderName>;
  listModels: (provider: ProviderName) => Promise<ModelInfo[]>;
  detectPi?: () => Promise<PiBinaryDetection>;
  /** Overrides pi's own agent root. Tests must never write to a real one. */
  piAgentDir?: string;
  now?: () => Date;
}

export function createPiSetupManager(opts: CreatePiSetupManagerOptions): PiSetupManager {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const integrationDir = join(opts.home, 'integrations', 'pi');
  const statePath = join(integrationDir, 'setup.json');
  const tokenPath = join(integrationDir, TOKEN_FILE);
  const rosterPath = join(integrationDir, ROSTER_FILE);
  // The extension the launch command points at never leaves GEZEL_HOME; the
  // installed copy in pi's own directory is the same bytes.
  const extensionPath = join(integrationDir, EXTENSION_FILE);
  const now = opts.now ?? (() => new Date());
  const ownerId = managedFileOwnerId(opts.home);

  const detect = opts.detectPi ?? (() => detectPiBinary({ env }));
  const agentDir = (): PiAgentDir =>
    resolvePiAgentDir({ env, ...(opts.piAgentDir ? { override: opts.piAgentDir } : {}) });

  let closing = false;
  const serialize = createMutationQueue();

  const listEligibleModels = async (suppliedConfig?: GezelConfig): Promise<PiSetupModelOption[]> =>
    listEligibleHarnessModels({
      config: suppliedConfig ?? (await opts.readConfig()),
      listModels: opts.listModels,
      listGezels: opts.listGezels,
      providerForGezel: opts.providerForGezel,
    });

  const bridgeSnapshot = () => harnessBridgeSnapshot(opts.bridge);

  const extensionSourceFor = (): string =>
    buildPiExtensionSource({ rosterPath, tokenPath, ownerId });

  const readState = async (): Promise<SetupState | null> =>
    readSecurityJson(statePath, 'pi setup', decodeSetupState);

  const inspect = async (): Promise<{
    status: PiSetupStatusResponse;
    state: SetupState | null;
    models: PiSetupModelOption[];
    detection: PiBinaryDetection;
    conflict: ConflictKind | null;
    installedPath: string;
    installedFile: string | null;
  }> => {
    const configPromise = opts.readConfig();
    const [config, models, detection, stateResult, managedRoster, tokenFile] = await Promise.all([
      configPromise,
      configPromise.then((config) => listEligibleModels(config)),
      detect(),
      readState().then(
        (value) => ({ value, error: null as Error | null }),
        (error) => ({ value: null, error: asError(error) }),
      ),
      readOptionalFile(rosterPath),
      readOptionalFile(tokenPath),
    ]);
    const state = stateResult.value;
    const resolvedAgentDir = agentDir();
    const installedPath = piExtensionPath(resolvedAgentDir.dir);
    const installedFile = await readOptionalFile(installedPath).catch(() => null);
    // The installed copy is its own record: the marker proves who wrote it and
    // the digest proves it still matches this install, so nothing about it has
    // to be tracked in Gezel's state.
    const extensionKind: PiSetupExtension['state'] = !detection.installed
      ? 'unsupported'
      : installedFile === null
        ? 'not-installed'
        : PI_EXTENSION_MARKER.isManaged(installedFile, ownerId)
          ? installedFile === extensionSourceFor()
            ? 'installed'
            : 'stale'
          : 'conflict';
    const endpointsEnabled = config.openaiEndpoints?.enabled !== false;
    const recommendedModel = recommendedHarnessModel(models, config.meesterGezelId);
    const tokenRecord = harnessTokenRecord(opts.tokenStore, PI_SETUP_APP_ID);
    const tokenOwnedBySetup = tokenRecord?.appName === PI_SETUP_APP_NAME;
    const rosterIsOurs =
      managedRoster !== null && state !== null && sha256(managedRoster) === state.configDigest;
    const canRemove = Boolean(
      state || stateResult.error || tokenOwnedBySetup || tokenFile !== null || rosterIsOurs,
    );
    const reasons: string[] = [];
    let statusState: PiSetupStatusResponse['state'] = 'not-configured';
    let message: string | undefined;
    let conflict: ConflictKind | null = null;

    if (managedRoster !== null && !rosterIsOurs && !stateResult.error) {
      statusState = 'conflict';
      conflict = 'config';
      message = `${rosterPath} was changed outside this setup or belongs to another Gezel home. It was not modified.`;
    } else if (tokenRecord && !tokenOwnedBySetup) {
      statusState = 'conflict';
      conflict = 'credential';
      message =
        'Another connected app is using Gezel’s reserved pi credential identity. Revoke that app before setting up pi.';
    } else if (stateResult.error) {
      statusState = 'conflict';
      conflict = 'state';
      message = 'Gezel found damaged pi setup state and left the existing files untouched.';
    } else if (state) {
      if (!endpointsEnabled) reasons.push('Connected-app model serving is turned off.');
      if (!findHarnessModel(models, state.model, state.gezelId)) {
        reasons.push('The configured gezel or local model is no longer available.');
      }
      if (managedRoster === null) reasons.push('The managed pi model list is missing.');
      if (!tokenRecord || !isExactHarnessToken(tokenRecord, PI_SETUP_APP_NAME)) {
        reasons.push('The pi app credential was revoked or is invalid.');
      } else if (tokenFile !== tokenRecord.token) {
        reasons.push('The managed pi credential file needs repair.');
      }
      if (managedRoster !== null) {
        const selected = findHarnessModel(models, state.model, state.gezelId);
        if (selected) {
          const expected = buildRoster({
            model: selected,
            models,
            baseUrl: bridgeSnapshot().baseUrl,
          });
          if (managedRoster !== expected) reasons.push('The managed pi model list is out of date.');
        }
      }
      if ((await readOptionalFile(extensionPath)) !== extensionSourceFor()) {
        reasons.push('The pi extension file is out of date.');
      }
      if (endpointsEnabled && !opts.bridge.status().listening) {
        reasons.push('The pi inference bridge is not running.');
      }
      // Only a copy this install still owns is worth reporting as stale;
      // configure and reconcile both republish it in place.
      if (extensionKind === 'stale') reasons.push('The extension added to pi is out of date.');
      statusState = reasons.length === 0 ? 'configured' : 'update-needed';
    } else if (models.length === 0) {
      statusState = 'unavailable';
      message = 'Install a local chat model with tool support before setting up pi.';
    }

    const publishable = endpointsEnabled && models.length > 0;
    const canConfigure = publishable && statusState !== 'conflict';
    const canRepair = publishable && (conflict === 'config' || conflict === 'state');
    // Copying into pi's own directory presupposes a managed roster for the
    // extension to read, a pi to read it, and no unresolved conflict.
    const extensionWritable = endpointsEnabled && state !== null && statusState !== 'conflict';
    const extension: PiSetupExtension = {
      state: extensionKind,
      path: installedPath,
      agentDir: resolvedAgentDir.dir,
      agentDirSource: resolvedAgentDir.source,
      canInstall:
        extensionWritable && (extensionKind === 'not-installed' || extensionKind === 'stale'),
      canRemove: extensionKind === 'installed' || extensionKind === 'stale',
      canReplace: extensionWritable && extensionKind === 'conflict',
      ...extensionMessage({ kind: extensionKind, path: installedPath, configured: state !== null }),
    };

    return {
      state,
      models,
      detection,
      conflict,
      installedPath,
      installedFile,
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
        piInstalled: detection.installed,
        ...(detection.version ? { piVersion: detection.version } : {}),
        ...(detection.path ? { piPath: detection.path } : {}),
        endpointsEnabled,
        providerId: PI_SETUP_PROVIDER_ID,
        configPath: rosterPath,
        extensionPath,
        extension,
        launchCommand: buildLaunchCommand({
          binaryPath: detection.path,
          extensionPath,
          platform,
        }),
        bridge: bridgeSnapshot(),
        canConfigure,
        canRemove,
        canRepair,
      },
    };
  };

  const status = async (): Promise<PiSetupStatusResponse> => (await inspect()).status;

  const preserveConflictingRoster = (content: string): Promise<string> =>
    preserveConflictingFile({
      path: rosterPath,
      content,
      mode: 0o600,
      code: 'pi_config_backup_failed',
    });

  const configure = (input: ConfigurePiRequest): Promise<PiSetupStatusResponse> =>
    serialize(async () => {
      if (closing) {
        throw new PiSetupError(
          'service_stopping',
          'Gezel is stopping and cannot change the pi setup.',
          409,
        );
      }
      const before = await inspect();
      if (!before.status.endpointsEnabled) {
        throw new PiSetupError(
          'openai_endpoints_disabled',
          'Turn on Allow apps to connect before setting up pi.',
        );
      }
      const repairing = input.backupConflictingConfig === true && before.status.canRepair;
      if (before.status.state === 'conflict' && !repairing) {
        throw new PiSetupError(
          'pi_config_conflict',
          before.status.message ?? `${rosterPath} is not managed by Gezel.`,
        );
      }
      const selected = findHarnessModel(before.models, input.model);
      if (!selected) {
        throw new PiSetupError(
          'model_not_available',
          `The selected gezel or local model is not available for pi: ${input.model}`,
          404,
        );
      }

      await opts.bridge.start().catch((error) => {
        throw new PiSetupError('pi_bridge_unavailable', asError(error).message);
      });
      let issuedNewToken = false;
      let backup: { path: string; content: string } | null = null;
      try {
        await ensurePrivateDir(integrationDir);
        const currentRoster = await readOptionalFile(rosterPath);
        const stateForOwnership = before.state;
        const foreignRoster =
          currentRoster !== null &&
          (stateForOwnership === null || sha256(currentRoster) !== stateForOwnership.configDigest)
            ? currentRoster
            : null;
        if (foreignRoster !== null && !repairing) {
          throw new PiSetupError(
            'pi_config_conflict',
            `${rosterPath} changed while setup was running and was not overwritten.`,
          );
        }

        let record = harnessTokenRecord(opts.tokenStore, PI_SETUP_APP_ID);
        if (
          record &&
          record.appName === PI_SETUP_APP_NAME &&
          !isExactHarnessToken(record, PI_SETUP_APP_NAME)
        ) {
          await opts.tokenStore.revoke(PI_SETUP_APP_ID);
          record = undefined;
        }
        if (!record) {
          record = await opts.tokenStore.issue({
            appId: PI_SETUP_APP_ID,
            appName: PI_SETUP_APP_NAME,
            scopes: ['openai'],
          });
          issuedNewToken = true;
        }

        const createdAt = before.state?.createdAt ?? now().toISOString();
        const managedRoster = buildRoster({
          model: selected,
          models: before.models,
          baseUrl: bridgeSnapshot().baseUrl,
        });
        const nextState: SetupState = {
          version: PI_SETUP_REVISION,
          model: selected.id,
          ...(selected.kind === 'gezel' ? { gezelId: selected.gezelId } : {}),
          createdAt,
          updatedAt: now().toISOString(),
          configDigest: sha256(managedRoster),
        };

        // Publish the secret first, then the roster and extension, and the
        // state marker last. A crash becomes a visible update-needed setup
        // rather than a state record claiming files that are not there.
        //
        // The credential file carries no trailing newline, and the extension
        // trims what it reads, so neither form can smuggle whitespace into an
        // Authorization header.
        await writeFileAtomic(tokenPath, record.token, { mode: 0o600, durable: true });
        if ((await readOptionalFile(rosterPath)) !== currentRoster) {
          throw new PiSetupError(
            'pi_config_conflict',
            `${rosterPath} changed while setup was running and was not overwritten.`,
          );
        }
        if (foreignRoster !== null) {
          backup = { path: await preserveConflictingRoster(foreignRoster), content: foreignRoster };
        }
        await writeFileAtomic(rosterPath, managedRoster, { mode: 0o600, durable: true });
        await writeFileAtomic(extensionPath, extensionSourceFor(), { durable: true });
        await writeSecurityJson(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
        await refreshInstalledExtension().catch(() => {
          // The setup itself succeeded. A copy that could not be refreshed
          // reports as out of date on the next status rather than failing here.
        });
        const published = await status();
        return backup ? { ...published, configBackupPath: backup.path } : published;
      } catch (error) {
        if (issuedNewToken) await opts.tokenStore.revoke(PI_SETUP_APP_ID).catch(() => false);
        if (!before.state) {
          await rm(integrationDir, { recursive: true, force: true }).catch(() => undefined);
          await opts.bridge.stop().catch(() => undefined);
        }
        // Restore the displaced file LAST: the roster sits inside the
        // integration directory that the first-run cleanup above wipes, so an
        // earlier restore would be deleted again.
        if (backup) {
          await ensurePrivateDir(integrationDir).catch(() => undefined);
          await writeFileAtomic(rosterPath, backup.content, {
            mode: 0o600,
            durable: true,
          }).catch(() => undefined);
          await rm(backup.path, { force: true }).catch(() => undefined);
        }
        throw error;
      }
    });

  /**
   * Republish a copy this install already owns, so a moved bridge address or a
   * newer template lands without the user re-installing it. It never creates
   * one: a file the user deleted from their own pi directory stays deleted.
   */
  const refreshInstalledExtension = async (): Promise<void> => {
    const detection = await detect();
    if (!detection.installed) return;
    const installedPath = piExtensionPath(agentDir().dir);
    const current = await readOptionalFile(installedPath).catch(() => null);
    if (current === null || !PI_EXTENSION_MARKER.isManaged(current, ownerId)) return;
    const next = extensionSourceFor();
    if (next === current) return;
    await writeFileAtomic(installedPath, next, { durable: true });
  };

  /** Delete the installed copy only where this install's marker proves it wrote it. */
  const deleteInstalledExtension = async (): Promise<'deleted' | 'absent' | 'foreign'> => {
    const installedPath = piExtensionPath(agentDir().dir);
    const current = await readOptionalFile(installedPath).catch(() => null);
    if (current === null) return 'absent';
    if (!PI_EXTENSION_MARKER.isManaged(current, ownerId)) return 'foreign';
    await rm(installedPath, { force: true });
    return 'deleted';
  };

  const installExtension = (input: InstallPiExtensionRequest): Promise<PiSetupStatusResponse> =>
    serialize(async () => {
      if (closing) {
        throw new PiSetupError(
          'service_stopping',
          'Gezel is stopping and cannot change the pi setup.',
          409,
        );
      }
      const before = await inspect();
      if (!before.status.endpointsEnabled) {
        throw new PiSetupError(
          'openai_endpoints_disabled',
          'Turn on Allow apps to connect before adding Gezel to pi.',
        );
      }
      if (!before.state || before.status.state === 'conflict') {
        throw new PiSetupError(
          'pi_not_configured',
          'Set up pi first — the extension reads the model list that setup writes.',
        );
      }
      if (!before.detection.installed) {
        throw new PiSetupError(
          'pi_not_installed',
          'pi was not found on this computer, so there is nowhere to add the extension.',
        );
      }
      if (before.status.extension.state === 'installed') return before.status;

      const replacing =
        input.backupConflictingExtension === true && before.status.extension.canReplace;
      if (before.status.extension.state === 'conflict' && !replacing) {
        throw new PiSetupError(
          'pi_extension_conflict',
          before.status.extension.message ?? `${before.installedPath} is not managed by Gezel.`,
        );
      }

      const installedPath = before.installedPath;
      let backup: { path: string; content: string } | null = null;
      try {
        // pi's agent directory belongs to the user: create what is missing, but
        // never tighten permissions on it.
        await mkdir(piExtensionDir(agentDir().dir), { recursive: true });
        const current = await readOptionalFile(installedPath);
        if (current !== before.installedFile) {
          throw new PiSetupError(
            'pi_extension_conflict',
            `${installedPath} changed while the install was running and was not overwritten.`,
          );
        }
        if (current !== null && !PI_EXTENSION_MARKER.isManaged(current, ownerId)) {
          backup = {
            path: await preserveConflictingFile({
              path: installedPath,
              content: current,
              mode: 0o644,
              code: 'pi_extension_backup_failed',
            }),
            content: current,
          };
        }
        // The extension carries paths, never the credential, so it needs no
        // private mode in a directory the user may sync between machines.
        await writeFileAtomic(installedPath, extensionSourceFor(), { durable: true });
        const published = await status();
        return backup ? { ...published, extensionBackupPath: backup.path } : published;
      } catch (error) {
        if (backup) {
          await writeFileAtomic(installedPath, backup.content, {
            mode: 0o644,
            durable: true,
          }).catch(() => undefined);
          await rm(backup.path, { force: true }).catch(() => undefined);
        }
        throw error;
      }
    });

  const removeExtension = (): Promise<PiSetupStatusResponse> =>
    serialize(async () => {
      const outcome = await deleteInstalledExtension();
      if (outcome === 'foreign') {
        throw new PiSetupError(
          'pi_extension_conflict',
          'That pi extension file was written by another Gezel installation or changed by hand. It was not removed.',
        );
      }
      return status();
    });

  const removeSetup = (): Promise<PiSetupStatusResponse> =>
    serialize(async () => {
      const failures: unknown[] = [];
      await opts.bridge.stop().catch((error) => failures.push(error));
      // The installed copy points at files this removal deletes, so it goes
      // too — but only if this install wrote it.
      await deleteInstalledExtension().catch((error) => failures.push(error));

      const record = harnessTokenRecord(opts.tokenStore, PI_SETUP_APP_ID);
      if (record?.appName === PI_SETUP_APP_NAME) {
        await opts.tokenStore.revoke(PI_SETUP_APP_ID).catch((error) => failures.push(error));
      }
      await rm(integrationDir, { recursive: true, force: true }).catch((error) =>
        failures.push(error),
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Could not completely remove the Gezel pi setup.');
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
      const record = harnessTokenRecord(opts.tokenStore, PI_SETUP_APP_ID);
      const tokenFile = await readOptionalFile(tokenPath);
      const managedRoster = await readOptionalFile(rosterPath);
      if (
        !isExactHarnessToken(record, PI_SETUP_APP_NAME) ||
        tokenFile !== record.token ||
        managedRoster === null ||
        sha256(managedRoster) !== state.configDigest
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
      await opts.bridge.start();
      const source = extensionSourceFor();
      if ((await readOptionalFile(extensionPath)) !== source) {
        await writeFileAtomic(extensionPath, source, { durable: true });
      }
      await refreshInstalledExtension().catch(() => undefined);
      const next = buildRoster({ model: selected, models, baseUrl: bridgeSnapshot().baseUrl });
      if (next === managedRoster) return;
      await writeFileAtomic(rosterPath, next, { mode: 0o600, durable: true });
      await writeSecurityJson(
        statePath,
        `${JSON.stringify(
          {
            ...state,
            model: selected.id,
            gezelId: selected.kind === 'gezel' ? selected.gezelId : undefined,
            updatedAt: now().toISOString(),
            configDigest: sha256(next),
          },
          null,
          2,
        )}\n`,
      );
    });

  return {
    status,
    configure,
    installExtension,
    removeExtension,
    remove: removeSetup,
    reconcile,
    stop: () => {
      closing = true;
      return serialize(() => opts.bridge.stop());
    },
  };
}

interface PiRosterModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number };
  contextWindow: number;
  maxTokens: number;
  compat: {
    sendSessionAffinityHeaders: true;
  };
}

/**
 * Render the managed roster the extension reads.
 *
 * This file is the extension's ABI. It is deliberately shaped like the argument
 * `pi.registerProvider` wants, so the extension stays a reader rather than a
 * translator, and every eligible gezel and model is published so pi's own
 * picker shows the whole crew.
 *
 * `defaultModel` records the card's choice for display only. Unlike the Codex
 * profile and the OpenCode config, nothing here pins pi's default model: this
 * provider is registered in every pi session on the machine, and choosing the
 * user's default for every project is not ours to do.
 */
export function buildRoster(input: {
  model: PiSetupModelOption;
  models: PiSetupModelOption[];
  baseUrl: string;
}): string {
  const models: PiRosterModel[] = [...input.models]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((candidate) => {
      const context = candidate.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      return {
        id: candidate.id,
        name: candidate.description
          ? `${candidate.label} — ${candidate.description}`
          : candidate.label,
        reasoning: candidate.supportsReasoning === true,
        input: ['text'],
        // Local inference bills nobody; publishing zeros keeps pi's own cost
        // display honest rather than inventing a price.
        cost: { input: 0, output: 0 },
        contextWindow: context,
        maxTokens: Math.max(
          1,
          Math.min(MAX_OUTPUT_LIMIT, Math.floor(context * OUTPUT_LIMIT_SHARE)),
        ),
        // Pi sends its stable conversation id only when affinity headers are
        // enabled for the model. The dedicated bridge uses that id to mirror
        // one Pi chat into one read-only Gezel session.
        compat: {
          sendSessionAffinityHeaders: true as const,
        },
      };
    });

  return `${JSON.stringify(
    {
      provider: {
        id: PI_SETUP_PROVIDER_ID,
        name: PROVIDER_DISPLAY_NAME,
        api: PROVIDER_API,
        baseUrl: input.baseUrl,
        models,
      },
      defaultModel: input.model.id,
    },
    null,
    2,
  )}\n`;
}

function extensionMessage(input: {
  kind: PiSetupExtension['state'];
  path: string;
  configured: boolean;
}): { message?: string } {
  if (input.kind === 'unsupported') {
    return { message: 'Install pi to make Gezel available in it without the launch command.' };
  }
  if (input.kind === 'conflict') {
    return {
      message: `${input.path} was written by another Gezel installation or changed by hand. It was not modified.`,
    };
  }
  if (input.kind === 'not-installed' && !input.configured) {
    return { message: 'Set up pi first — the extension reads the model list setup writes.' };
  }
  return {};
}

function buildLaunchCommand(input: {
  binaryPath?: string;
  extensionPath: string;
  platform: NodeJS.Platform;
}): string {
  const binary = input.binaryPath ?? 'pi';
  if (input.platform === 'win32') {
    return `& ${powershellLiteral(binary)} -e ${powershellLiteral(input.extensionPath)}`;
  }
  return `${posixShellWord(binary)} -e ${posixShellWord(input.extensionPath)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodeSetupState(raw: string): SetupState {
  const parsed = JSON.parse(raw) as Partial<SetupState>;
  if (
    parsed.version !== PI_SETUP_REVISION ||
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
