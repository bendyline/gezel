import type { GezelClient } from '@bendyline/gezel-client/node';
import { describe, expect, it, vi } from 'vitest';
import {
  type ManagedAppCommandError,
  connectManagedApp,
  disconnectManagedApp,
  listConnectedManagedApps,
  managedAppUsage,
  resolveManagedApp,
} from './managed-apps.js';

describe('managed app command targets', () => {
  it('resolves friendly aliases without accepting ambiguous input', () => {
    expect(resolveManagedApp(' VSCode ')).toBe('vscode');
    expect(resolveManagedApp('vs-code')).toBe('vscode');
    expect(resolveManagedApp('open-code')).toBe('opencode');
    expect(resolveManagedApp('pi')).toBe('pi');
    expect(resolveManagedApp('')).toBeNull();
    expect(resolveManagedApp('vscode repair')).toBeNull();
    expect(managedAppUsage('connect')).toBe('usage: /connect vscode|pi|opencode|codex');
  });
});

describe('connectManagedApp', () => {
  it('enables Connected Apps and publishes the first VS Code profile safely', async () => {
    const off = vscodeStatus({ endpointsEnabled: false });
    const ready = vscodeStatus();
    const configured = vscodeStatus({
      state: 'configured',
      configuredProfileId: 'code:default',
      canRemove: true,
      bridge: bridge(true),
    });
    const client = createClient();
    client.getVSCodeSetupStatus.mockResolvedValueOnce(off).mockResolvedValueOnce(ready);
    client.getConfig.mockResolvedValue({
      openaiEndpoints: { enabled: false, supportingBehaviors: false },
    });
    client.configureVSCode.mockResolvedValue(configured);

    const result = await connectManagedApp(asClient(client), 'vscode');

    expect(client.updateConfig).toHaveBeenCalledWith({
      openaiEndpoints: { enabled: true, supportingBehaviors: false },
    });
    expect(client.configureVSCode).toHaveBeenCalledWith({ profileId: 'code:default' });
    expect(result.message).toContain('connected VS Code (Default)');
    expect(result.message).toContain('Connected Apps serving was enabled');
    expect(result.message).not.toContain('secret-token');
  });

  it('chooses the recommended pi gezel and installs the safe managed extension', async () => {
    const before = piStatus();
    const configured = piStatus({
      state: 'configured',
      configuredModel: 'gezel:builder',
      canRemove: true,
      bridge: bridge(true),
    });
    const installed = piStatus({
      ...configured,
      extension: {
        ...configured.extension,
        state: 'installed',
        canInstall: false,
        canRemove: true,
      },
    });
    const client = createClient();
    client.getPiSetupStatus.mockResolvedValue(before);
    client.configurePi.mockResolvedValue(configured);
    client.installPiExtension.mockResolvedValue(installed);

    const result = await connectManagedApp(asClient(client), 'pi');

    expect(client.configurePi).toHaveBeenCalledWith({ model: 'gezel:builder' });
    expect(client.installPiExtension).toHaveBeenCalledOnce();
    expect(result.message).toContain('default Builder');
    expect(result.message).toContain('managed pi extension was installed');
  });

  it('preserves a conflicting file and directs the user to the repair flow', async () => {
    const client = createClient();
    client.getCodexSetupStatus.mockResolvedValue(
      codexStatus({
        state: 'conflict',
        canConfigure: false,
        canRepair: true,
        message: 'A profile with this name already exists.',
      }),
    );

    await expect(connectManagedApp(asClient(client), 'codex')).rejects.toEqual(
      expect.objectContaining<Partial<ManagedAppCommandError>>({
        message: expect.stringContaining('Nothing was overwritten'),
      }),
    );
    expect(client.configureCodex).not.toHaveBeenCalled();
  });
});

describe('disconnectManagedApp', () => {
  it('removes the complete Gezel-owned OpenCode setup', async () => {
    const client = createClient();
    client.getOpenCodeSetupStatus.mockResolvedValue(
      openCodeStatus({
        state: 'configured',
        canRemove: true,
        plugin: { state: 'installed', canInstall: false, canRemove: true, canReplace: false },
      }),
    );

    const result = await disconnectManagedApp(asClient(client), 'opencode');

    expect(client.removeOpenCodeSetup).toHaveBeenCalledOnce();
    expect(result.message).toContain('managed plugin were removed');
  });

  it('finds the sole connected app for bare /disconnect behavior', async () => {
    const client = createClient();
    client.getVSCodeSetupStatus.mockResolvedValue(vscodeStatus());
    client.getPiSetupStatus.mockResolvedValue(
      piStatus({
        extension: { state: 'installed', canInstall: false, canRemove: true, canReplace: false },
      }),
    );
    client.getOpenCodeSetupStatus.mockResolvedValue(openCodeStatus());
    client.getCodexSetupStatus.mockResolvedValue(codexStatus());

    await expect(listConnectedManagedApps(asClient(client))).resolves.toEqual(['pi']);
  });
});

function createClient() {
  return {
    getConfig: vi.fn(),
    updateConfig: vi.fn(),
    getVSCodeSetupStatus: vi.fn(),
    configureVSCode: vi.fn(),
    removeVSCodeSetup: vi.fn(),
    getPiSetupStatus: vi.fn(),
    configurePi: vi.fn(),
    installPiExtension: vi.fn(),
    removePiSetup: vi.fn(),
    getOpenCodeSetupStatus: vi.fn(),
    configureOpenCode: vi.fn(),
    installOpenCodePlugin: vi.fn(),
    removeOpenCodeSetup: vi.fn(),
    getCodexSetupStatus: vi.fn(),
    configureCodex: vi.fn(),
    removeCodexSetup: vi.fn(),
  };
}

function asClient(client: ReturnType<typeof createClient>): GezelClient {
  return client as unknown as GezelClient;
}

function bridge(listening = false) {
  return { baseUrl: 'http://127.0.0.1:24567/v1', listening, port: 24_567 };
}

function models() {
  return [
    {
      id: 'llama-cpp:raw',
      label: 'Raw model',
      kind: 'model' as const,
      provider: 'llama-cpp',
      supportsTools: true,
    },
    {
      id: 'gezel:builder',
      label: 'Builder',
      kind: 'gezel' as const,
      provider: 'llama-cpp',
      gezelId: 'builder',
      supportsTools: true,
    },
  ];
}

function baseStatus(overrides: Record<string, unknown> = {}) {
  return {
    state: 'not-configured' as const,
    models: models(),
    recommendedModel: 'gezel:builder',
    reasons: [],
    endpointsEnabled: true,
    launchCommand: 'run-with-gezel',
    bridge: bridge(),
    canConfigure: true,
    canRemove: false,
    canRepair: false,
    ...overrides,
  };
}

function vscodeStatus(overrides: Record<string, unknown> = {}) {
  return {
    ...baseStatus(overrides),
    vscodeInstalled: true,
    providerId: 'customendpoint',
    profiles: [
      {
        id: 'code:default',
        label: 'Default',
        product: 'code' as const,
        configPath: 'C:/Code/User/chatLanguageModels.json',
      },
    ],
    configPath: 'C:/Code/User/chatLanguageModels.json',
    ...overrides,
  };
}

function piStatus(overrides: Record<string, unknown> = {}) {
  return {
    ...baseStatus(overrides),
    piInstalled: true,
    providerId: 'gezel',
    configPath: 'C:/Gezel/pi/models.json',
    extensionPath: 'C:/Gezel/pi/extension.js',
    extension: {
      state: 'not-installed' as const,
      canInstall: true,
      canRemove: false,
      canReplace: false,
    },
    ...overrides,
  };
}

function openCodeStatus(overrides: Record<string, unknown> = {}) {
  return {
    ...baseStatus(overrides),
    opencodeInstalled: true,
    providerId: 'gezel',
    configPath: 'C:/Gezel/opencode/config.json',
    plugin: {
      state: 'not-installed' as const,
      canInstall: true,
      canRemove: false,
      canReplace: false,
    },
    ...overrides,
  };
}

function codexStatus(overrides: Record<string, unknown> = {}) {
  return {
    ...baseStatus(overrides),
    codexInstalled: true,
    profileName: 'gezel',
    profilePath: 'C:/Codex/gezel.toml',
    ...overrides,
  };
}
