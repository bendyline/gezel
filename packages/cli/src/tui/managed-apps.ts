import type {
  CodexSetupStatusResponse,
  LocalHarnessModelOption,
  OpenCodeSetupStatusResponse,
  PiSetupStatusResponse,
  VSCodeSetupStatusResponse,
} from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';

type HarnessStatus =
  | CodexSetupStatusResponse
  | OpenCodeSetupStatusResponse
  | PiSetupStatusResponse
  | VSCodeSetupStatusResponse;

export const MANAGED_APP_TARGETS = [
  {
    id: 'vscode',
    label: 'VS Code',
    aliases: ['vscode', 'code', 'vs-code'],
    description: 'add Gezel to VS Code’s built-in model picker',
  },
  {
    id: 'pi',
    label: 'pi',
    aliases: ['pi'],
    description: 'add Gezel models and the managed pi extension',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    aliases: ['opencode', 'open-code'],
    description: 'add Gezel settings and the managed OpenCode plugin',
  },
  {
    id: 'codex',
    label: 'Codex',
    aliases: ['codex'],
    description: 'add a managed Gezel profile to Codex',
  },
] as const;

export type ManagedAppId = (typeof MANAGED_APP_TARGETS)[number]['id'];

export interface ManagedAppCommandResult {
  app: ManagedAppId;
  message: string;
}

/** A user-facing command failure that is safe to place directly in the TUI feed. */
export class ManagedAppCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedAppCommandError';
  }
}

export function resolveManagedApp(value: string): ManagedAppId | null {
  const normalized = value.trim().toLowerCase();
  return (
    MANAGED_APP_TARGETS.find((target) => (target.aliases as readonly string[]).includes(normalized))
      ?.id ?? null
  );
}

export function managedAppUsage(command: 'connect' | 'disconnect'): string {
  return `usage: /${command} ${MANAGED_APP_TARGETS.map((target) => target.id).join('|')}`;
}

/**
 * Publish one managed local-harness integration from the TUI.
 *
 * The service owns every mutation. This client layer deliberately selects
 * only safe defaults: the existing configured model/profile when possible,
 * then the service's recommendation, then the first available choice. A
 * foreign/conflicting file is never replaced here; the richer Settings flow
 * remains the place where the user can explicitly approve a backup + repair.
 */
export async function connectManagedApp(
  client: GezelClient,
  app: ManagedAppId,
): Promise<ManagedAppCommandResult> {
  switch (app) {
    case 'vscode':
      return connectVSCode(client);
    case 'pi':
      return connectPi(client);
    case 'opencode':
      return connectOpenCode(client);
    case 'codex':
      return connectCodex(client);
  }
}

/** Remove only Gezel-owned setup, credential, and optional plugin/extension material. */
export async function disconnectManagedApp(
  client: GezelClient,
  app: ManagedAppId,
): Promise<ManagedAppCommandResult> {
  switch (app) {
    case 'vscode': {
      const status = await client.getVSCodeSetupStatus();
      if (!status.canRemove) return { app, message: 'VS Code is not connected to Gezel.' };
      await client.removeVSCodeSetup();
      return { app, message: 'disconnected VS Code; other providers and conversations were kept.' };
    }
    case 'pi': {
      const status = await client.getPiSetupStatus();
      if (!status.canRemove && !status.extension.canRemove) {
        return { app, message: 'pi is not connected to Gezel.' };
      }
      await client.removePiSetup();
      return {
        app,
        message:
          'disconnected pi; its Gezel roster, credential, and managed extension were removed.',
      };
    }
    case 'opencode': {
      const status = await client.getOpenCodeSetupStatus();
      if (!status.canRemove && !status.plugin.canRemove) {
        return { app, message: 'OpenCode is not connected to Gezel.' };
      }
      await client.removeOpenCodeSetup();
      return {
        app,
        message:
          'disconnected OpenCode; Gezel’s settings, credential, and managed plugin were removed.',
      };
    }
    case 'codex': {
      const status = await client.getCodexSetupStatus();
      if (!status.canRemove) return { app, message: 'Codex is not connected to Gezel.' };
      await client.removeCodexSetup();
      return {
        app,
        message: 'disconnected Codex; other profiles, settings, and conversations were kept.',
      };
    }
  }
}

/** Discover Gezel-owned managed setups so bare `/disconnect` can stay unambiguous. */
export async function listConnectedManagedApps(client: GezelClient): Promise<ManagedAppId[]> {
  const [vscode, pi, opencode, codex] = await Promise.all([
    client.getVSCodeSetupStatus(),
    client.getPiSetupStatus(),
    client.getOpenCodeSetupStatus(),
    client.getCodexSetupStatus(),
  ]);
  return [
    ...(vscode.canRemove ? (['vscode'] as const) : []),
    ...(pi.canRemove || pi.extension.canRemove ? (['pi'] as const) : []),
    ...(opencode.canRemove || opencode.plugin.canRemove ? (['opencode'] as const) : []),
    ...(codex.canRemove ? (['codex'] as const) : []),
  ];
}

async function connectVSCode(client: GezelClient): Promise<ManagedAppCommandResult> {
  let status = await client.getVSCodeSetupStatus();
  const enabled = await enableConnectedAppsIfNeeded(client, status.endpointsEnabled);
  if (enabled) status = await client.getVSCodeSetupStatus();

  if (status.state !== 'configured') {
    assertSafeToConfigure(status, 'VS Code');
    const profile =
      status.profiles.find((candidate) => candidate.id === status.configuredProfileId) ??
      status.profiles[0];
    if (!profile) throw new ManagedAppCommandError('VS Code has no profile Gezel can configure.');
    status = await client.configureVSCode({ profileId: profile.id });
  }

  const profile =
    status.profiles.find((candidate) => candidate.id === status.configuredProfileId) ??
    status.profiles[0];
  return {
    app: 'vscode',
    message: [
      `connected VS Code${profile ? ` (${profile.label})` : ''} to Gezel at ${status.bridge.baseUrl}.`,
      enabled ? 'Connected Apps serving was enabled.' : '',
      'If VS Code is open, run “Developer: Reload Window” once to load the provider.',
    ]
      .filter(Boolean)
      .join(' '),
  };
}

async function connectPi(client: GezelClient): Promise<ManagedAppCommandResult> {
  let status = await client.getPiSetupStatus();
  const enabled = await enableConnectedAppsIfNeeded(client, status.endpointsEnabled);
  if (enabled) status = await client.getPiSetupStatus();

  if (status.state !== 'configured') {
    assertSafeToConfigure(status, 'pi');
    const model = preferredModel(status);
    status = await client.configurePi({ model: model.id });
  }

  let extensionNote = '';
  if (status.extension.canInstall && !status.extension.canReplace) {
    status = await client.installPiExtension();
    extensionNote = 'The managed pi extension was installed.';
  } else if (status.extension.canReplace) {
    extensionNote =
      'A conflicting pi extension was preserved; use the desktop Settings flow to review it.';
  } else if (status.extension.state === 'unsupported') {
    extensionNote = 'pi was not found, so use the launch command after installing it.';
  }

  return {
    app: 'pi',
    message: integrationSuccessMessage('pi', status, enabled, extensionNote),
  };
}

async function connectOpenCode(client: GezelClient): Promise<ManagedAppCommandResult> {
  let status = await client.getOpenCodeSetupStatus();
  const enabled = await enableConnectedAppsIfNeeded(client, status.endpointsEnabled);
  if (enabled) status = await client.getOpenCodeSetupStatus();

  if (status.state !== 'configured') {
    assertSafeToConfigure(status, 'OpenCode');
    const model = preferredModel(status);
    status = await client.configureOpenCode({ model: model.id });
  }

  let pluginNote = '';
  if (status.plugin.canInstall && !status.plugin.canReplace) {
    status = await client.installOpenCodePlugin();
    pluginNote = 'The managed OpenCode plugin was installed.';
  } else if (status.plugin.canReplace) {
    pluginNote =
      'A conflicting OpenCode plugin was preserved; use the desktop Settings flow to review it.';
  } else if (status.plugin.state === 'unsupported') {
    pluginNote = 'OpenCode was not found, so use the launch command after installing it.';
  }

  return {
    app: 'opencode',
    message: integrationSuccessMessage('OpenCode', status, enabled, pluginNote),
  };
}

async function connectCodex(client: GezelClient): Promise<ManagedAppCommandResult> {
  let status = await client.getCodexSetupStatus();
  const enabled = await enableConnectedAppsIfNeeded(client, status.endpointsEnabled);
  if (enabled) status = await client.getCodexSetupStatus();

  if (status.state !== 'configured') {
    assertSafeToConfigure(status, 'Codex');
    const model = preferredModel(status);
    status = await client.configureCodex({ model: model.id });
  }

  return {
    app: 'codex',
    message: integrationSuccessMessage('Codex', status, enabled),
  };
}

async function enableConnectedAppsIfNeeded(
  client: GezelClient,
  endpointsEnabled: boolean,
): Promise<boolean> {
  if (endpointsEnabled) return false;
  const config = await client.getConfig();
  await client.updateConfig({
    openaiEndpoints: {
      ...config.openaiEndpoints,
      enabled: true,
    },
  });
  return true;
}

function preferredModel(status: HarnessStatus): LocalHarnessModelOption {
  const model =
    status.models.find((candidate) => candidate.id === status.configuredModel) ??
    status.models.find((candidate) => candidate.id === status.recommendedModel) ??
    status.models[0];
  if (!model) {
    throw new ManagedAppCommandError(
      'No compatible local gezel or tool-capable model is available for this integration.',
    );
  }
  return model;
}

function assertSafeToConfigure(status: HarnessStatus, label: string): void {
  if (status.state === 'conflict') {
    throw new ManagedAppCommandError(
      `${label} setup has a conflict${status.message ? `: ${status.message}` : '.'} Nothing was overwritten; use Settings → Connected Apps to review and repair it.`,
    );
  }
  if (status.state === 'unavailable' || !status.canConfigure) {
    const reason = status.message ?? status.reasons[0];
    throw new ManagedAppCommandError(
      reason
        ? `${label} cannot be connected: ${reason}`
        : `${label} cannot be connected right now.`,
    );
  }
}

function integrationSuccessMessage(
  label: string,
  status: HarnessStatus,
  enabled: boolean,
  extra = '',
): string {
  const selected = status.models.find((candidate) => candidate.id === status.configuredModel);
  return [
    `connected ${label} to Gezel at ${status.bridge.baseUrl}${
      selected ? `; default ${selected.label}` : ''
    }.`,
    enabled ? 'Connected Apps serving was enabled.' : '',
    extra,
    `Start it with: ${status.launchCommand}`,
  ]
    .filter(Boolean)
    .join(' ');
}
