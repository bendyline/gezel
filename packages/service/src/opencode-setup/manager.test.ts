import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type GezelSummary,
  OpenCodeSetupStatusResponseSchema,
  type ProviderName,
} from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import { setupOwnerId } from '../fs/managed-marker.js';
import type { OpenCodeBridgeController } from '../http/opencode-bridge.js';
import { createTokenStore } from '../http/token-store.js';
import type { ModelInfo } from '../providers/types.js';
import {
  OPENCODE_SETUP_APP_ID,
  OPENCODE_SETUP_PROVIDER_ID,
  type OpenCodeSetupError,
  createOpenCodeSetupManager,
} from './manager.js';
import { OPENCODE_PLUGIN_MARKER } from './plugin-source.js';

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  opts: {
    endpointsEnabled?: boolean;
    bridgePort?: number;
    beforeBridgeListen?: () => Promise<void>;
    gezels?: GezelSummary[];
    defaultProvider?: ProviderName;
    defaultModel?: Partial<Record<ProviderName, string>>;
    meesterGezelId?: string;
    opencodeInstalled?: boolean;
    platform?: NodeJS.Platform;
    /** Share one OpenCode config root between two Gezel homes. */
    opencodeConfigDir?: string;
    /** Override the raw model inventory; `[]` exercises the unavailable path. */
    models?: ModelInfo[];
    /** Fail a config read on demand, to land an error at a chosen point. */
    onReadConfig?: (paths: { configPath: string }) => Promise<void>;
  } = {},
) {
  // The space is deliberate. A Windows home is routinely `C:\Users\Mike Smith`,
  // and it is the only reason the launch command quotes at all — a fixture
  // rooted at a bare path exercises the shell-quoting branch on no platform.
  const root = await mkdtemp(join(tmpdir(), 'gezel opencode setup '));
  roots.push(root);
  const home = join(root, 'gezel');
  const integrationDir = join(home, 'integrations', 'opencode');
  const configPath = join(integrationDir, 'opencode.json');
  // Stand in for OpenCode's own config root. Never let a test resolve the real
  // one — the plugin is the one artifact written outside GEZEL_HOME.
  const opencodeConfigDir = opts.opencodeConfigDir ?? join(root, 'opencode-config');
  const pluginPath = join(opencodeConfigDir, 'plugins', 'gezel.js');
  await mkdir(home, { recursive: true });
  const tokenStore = await createTokenStore({ home, rootToken: 'root-test' });
  let listening = false;
  const port = opts.bridgePort ?? 21_435;
  const bridge: OpenCodeBridgeController = {
    status: () => (listening ? { listening: true, port } : { listening: false }),
    desiredPort: () => port,
    baseUrl: () => `http://127.0.0.1:${port}`,
    start: async () => {
      await opts.beforeBridgeListen?.();
      listening = true;
      return { listening: true, port };
    },
    stop: async () => {
      listening = false;
    },
  };
  let endpointsEnabled = opts.endpointsEnabled ?? true;
  const manager = createOpenCodeSetupManager({
    home,
    ...(opts.platform ? { platform: opts.platform } : {}),
    opencodeConfigDir,
    tokenStore,
    bridge,
    readConfig: async () => ({
      ...((await opts.onReadConfig?.({ configPath })) ?? {}),
      openaiEndpoints: endpointsEnabled ? {} : { enabled: false },
      ...(opts.defaultProvider ? { provider: opts.defaultProvider } : {}),
      ...(opts.defaultModel ? { defaultModel: opts.defaultModel } : {}),
      ...(opts.meesterGezelId ? { meesterGezelId: opts.meesterGezelId } : {}),
    }),
    listGezels: async () => opts.gezels ?? [],
    providerForGezel: async (gezelId) => {
      const gezel = opts.gezels?.find((candidate) => candidate.id === gezelId);
      return gezel?.provider ?? opts.defaultProvider ?? 'llama-cpp';
    },
    listModels: async (provider) =>
      provider === 'llama-cpp'
        ? (opts.models ?? [
            {
              id: 'coder.gguf',
              name: 'Local Coder',
              supportsTools: true,
              supportsReasoning: false,
              contextWindow: 16_384,
            },
            { id: 'chatty.gguf', name: 'Chatty', supportsTools: false, contextWindow: 8_192 },
          ])
        : [],
    detectOpenCode: async () =>
      opts.opencodeInstalled === false
        ? { installed: false, error: 'OpenCode was not found on PATH.' }
        : { installed: true, path: '/usr/local/bin/opencode', version: 'opencode 1.2.3' },
    now: () => new Date('2026-08-15T00:00:00.000Z'),
  });
  return {
    root,
    home,
    tokenStore,
    bridge,
    manager,
    integrationDir,
    configPath,
    tokenPath: join(home, 'integrations', 'opencode', 'token'),
    statePath: join(home, 'integrations', 'opencode', 'setup.json'),
    opencodeConfigDir,
    pluginPath,
    isListening: () => listening,
    setEndpointsEnabled: (value: boolean) => {
      endpointsEnabled = value;
    },
  };
}

const maya: GezelSummary = {
  id: 'maya-stable-id',
  name: 'Maya',
  role: 'Developer',
  provider: 'llama-cpp',
  model: 'coder.gguf',
  updatedAt: '2026-08-15T00:00:00.000Z',
};
const mayaModelId = 'gezel:developer-maya';

describe('OpenCodeSetupManager', () => {
  it('offers eligible gezels ahead of raw models and drops tool-less ones', async () => {
    const f = await fixture({ gezels: [maya], meesterGezelId: maya.id });

    const before = await f.manager.status();

    expect(OpenCodeSetupStatusResponseSchema.parse(before)).toBeTruthy();
    expect(before.state).toBe('not-configured');
    expect(before.recommendedModel).toBe(mayaModelId);
    // `chatty.gguf` declares supportsTools: false — a harness that cannot call
    // tools is useless here, so it must never reach the picker.
    expect(before.models.map((model) => model.id)).toEqual([mayaModelId, 'llama-cpp:coder.gguf']);
    expect(before.models[0]).toMatchObject({
      kind: 'gezel',
      label: 'Maya',
      role: 'Developer',
      modelLabel: 'Local Coder',
      contextWindow: 16_384,
    });
  });

  it('publishes a config OpenCode can parse after {file:} substitution', async () => {
    const f = await fixture({ gezels: [maya] });

    await f.manager.configure({ model: mayaModelId });

    const raw = await readFile(f.configPath, 'utf8');
    const token = await readFile(f.tokenPath, 'utf8');

    // OpenCode splices the credential into the raw text BEFORE parsing JSON, so
    // a trailing newline in the token file would break the whole config.
    expect(token).not.toMatch(/\s$/);
    expect(raw).toContain(`{file:${f.tokenPath.replace(/\\/g, '/')}}`);

    const substituted = raw.replace(/\{file:[^}]+\}/, token);
    const parsed = JSON.parse(substituted) as {
      provider: Record<
        string,
        {
          npm: string;
          options: { baseURL: string; apiKey: string };
          models: Record<string, { name: string; tool_call: boolean; limit: { context: number } }>;
        }
      >;
      model: string;
      small_model: string;
    };
    const provider = parsed.provider[OPENCODE_SETUP_PROVIDER_ID];

    expect(provider?.npm).toBe('@ai-sdk/openai-compatible');
    expect(provider?.options.baseURL).toBe('http://127.0.0.1:21435/v1');
    expect(provider?.options.apiKey).toBe(token);
    expect(Object.keys(provider?.models ?? {})).toEqual([mayaModelId, 'llama-cpp:coder.gguf']);
    expect(provider?.models[mayaModelId]).toMatchObject({
      tool_call: true,
      limit: { context: 16_384 },
    });
    // The whole eligible crew is published so OpenCode's own picker shows it,
    // while `model` names the one the user chose here.
    expect(parsed.model).toBe(`gezel/${mayaModelId}`);
    // Left unset, OpenCode picks its own default for titles and summaries —
    // which on a local-inference machine means an unconfigured cloud provider.
    expect(parsed.small_model).toBe(parsed.model);
  });

  it('uses a forward-slash credential path so Windows absolute paths stay absolute', async () => {
    const f = await fixture({ gezels: [maya], platform: 'win32' });

    await f.manager.configure({ model: mayaModelId });
    const raw = await readFile(f.configPath, 'utf8');
    const referenced = /\{file:([^}]+)\}/.exec(raw)?.[1];

    expect(referenced).toBeDefined();
    expect(referenced).not.toContain('\\');
    // JSON.parse must not have needed to unescape anything in that path.
    expect(raw).toContain(referenced!);
  });

  it('reaches configured, mints a scoped credential, and starts the bridge', async () => {
    const f = await fixture({ gezels: [maya] });

    const after = await f.manager.configure({ model: mayaModelId });

    expect(after.state).toBe('configured');
    expect(after.configuredModel).toBe(mayaModelId);
    expect(after.reasons).toEqual([]);
    expect(f.isListening()).toBe(true);

    const state = JSON.parse(await readFile(f.statePath, 'utf8')) as Record<string, unknown>;
    expect(state.gezelId).toBe(maya.id);

    const record = f.tokenStore.list().find((r) => r.appId === OPENCODE_SETUP_APP_ID);
    expect(record?.scopes).toEqual(['openai']);
  });

  it('reconciles a configured model id after the gezel role or name changes', async () => {
    const renamed = { ...maya };
    const f = await fixture({ gezels: [renamed] });
    await f.manager.configure({ model: mayaModelId });

    renamed.name = 'Maya Jones';
    renamed.role = 'Lead Developer';
    const nextModelId = 'gezel:lead-developer-maya-jones';

    const drifted = await f.manager.status();
    expect(drifted.state).toBe('update-needed');
    expect(drifted.configuredModel).toBe(nextModelId);

    await f.manager.reconcile();
    const repaired = await f.manager.status();
    expect(repaired.state).toBe('configured');
    expect(repaired.configuredModel).toBe(nextModelId);
  });

  it('reports update-needed when the credential is revoked, and repairs on reconfigure', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: mayaModelId });

    await f.tokenStore.revoke(OPENCODE_SETUP_APP_ID);
    const degraded = await f.manager.status();

    expect(degraded.state).toBe('update-needed');
    expect(degraded.reasons).toContain('The OpenCode app credential was revoked or is invalid.');

    const repaired = await f.manager.configure({ model: mayaModelId });
    expect(repaired.state).toBe('configured');
  });

  it('reports update-needed when the managed config drifts from what Gezel would write', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: mayaModelId });

    // Rewrite the file AND re-mark ownership, so this is drift, not a conflict.
    const state = JSON.parse(await readFile(f.statePath, 'utf8')) as Record<string, unknown>;
    const stale = '{\n  "provider": {}\n}\n';
    await writeFile(f.configPath, stale, 'utf8');
    const { createHash } = await import('node:crypto');
    await writeFile(
      f.statePath,
      JSON.stringify(
        { ...state, configDigest: createHash('sha256').update(stale).digest('hex') },
        null,
        2,
      ),
      'utf8',
    );

    const status = await f.manager.status();
    expect(status.state).toBe('update-needed');
    expect(status.reasons).toContain('The managed OpenCode config is out of date.');
  });

  it('treats a hand-edited config as a conflict and never overwrites it without repair', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: mayaModelId });
    const handEdited = '{\n  "model": "mine/own"\n}\n';
    await writeFile(f.configPath, handEdited, 'utf8');

    const conflicted = await f.manager.status();
    expect(conflicted.state).toBe('conflict');
    expect(conflicted.canRepair).toBe(true);

    await expect(f.manager.configure({ model: mayaModelId })).rejects.toMatchObject({
      code: 'opencode_config_conflict',
    });
    expect(await readFile(f.configPath, 'utf8')).toBe(handEdited);

    const repaired = await f.manager.configure({
      model: mayaModelId,
      backupConflictingConfig: true,
    });
    expect(repaired.state).toBe('configured');
    expect(repaired.configBackupPath).toBe(`${f.configPath}.backup`);
    expect(await readFile(`${f.configPath}.backup`, 'utf8')).toBe(handEdited);
  });

  // The managed config lives INSIDE the directory a failed first run wipes,
  // unlike Codex's profile in ~/.codex. Repairing a conflict where setup.json
  // is missing runs with no prior state, so a careless cleanup order deletes
  // the very file the backup exists to protect.
  it('leaves a displaced config on disk when a repair fails after taking the backup', async () => {
    const f = await fixture({
      gezels: [maya],
      // Fail only once the repair has actually displaced the file, so the
      // error lands in the cleanup path with a backup in hand.
      onReadConfig: async ({ configPath }) => {
        if (existsSync(`${configPath}.backup`)) throw new Error('config read failed mid-publish');
      },
    });
    await mkdir(f.integrationDir, { recursive: true });
    const theirs = '{\n  "model": "mine/own"\n}\n';
    await writeFile(f.configPath, theirs, 'utf8');

    // No setup.json, so this conflict repairs with `before.state === null` —
    // the exact shape that makes the first-run directory wipe dangerous.
    const conflicted = await f.manager.status();
    expect(conflicted.state).toBe('conflict');
    expect(conflicted.canRepair).toBe(true);

    await expect(
      f.manager.configure({ model: mayaModelId, backupConflictingConfig: true }),
    ).rejects.toThrow();

    expect(await readFile(f.configPath, 'utf8')).toBe(theirs);
    expect(existsSync(`${f.configPath}.backup`)).toBe(false);
  });

  it('refuses to configure while connected-app serving is off', async () => {
    const f = await fixture({ gezels: [maya], endpointsEnabled: false });

    const status = await f.manager.status();
    expect(status.canConfigure).toBe(false);

    await expect(f.manager.configure({ model: mayaModelId })).rejects.toMatchObject({
      code: 'openai_endpoints_disabled',
    });
  });

  it('refuses a model that is not in the eligible list', async () => {
    const f = await fixture({ gezels: [maya] });

    const error = (await f.manager
      .configure({ model: 'llama-cpp:chatty.gguf' })
      .catch((e) => e)) as OpenCodeSetupError;

    expect(error.code).toBe('model_not_available');
    expect(error.status).toBe(404);
  });

  it('is unavailable when nothing installed can run a tool loop', async () => {
    const f = await fixture({ gezels: [maya], models: [] });

    const status = await f.manager.status();

    expect(status.models).toEqual([]);
    expect(status.state).toBe('unavailable');
    expect(status.canConfigure).toBe(false);
    expect(status.message).toContain('local chat model with tool support');
  });

  it('reports OpenCode as missing without blocking setup', async () => {
    const f = await fixture({ gezels: [maya], opencodeInstalled: false });

    const status = await f.manager.status();

    expect(status.opencodeInstalled).toBe(false);
    // Unlike Codex there is no version floor to enforce, and a user may well
    // prepare the connection before installing the CLI.
    expect(status.canConfigure).toBe(true);
    await expect(f.manager.configure({ model: mayaModelId })).resolves.toMatchObject({
      state: 'configured',
    });
  });

  it('removes only its own files and revokes its credential', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: mayaModelId });

    const removed = await f.manager.remove();

    expect(removed.state).toBe('not-configured');
    expect(removed.canRemove).toBe(false);
    expect(f.isListening()).toBe(false);
    expect(f.tokenStore.list().some((r) => r.appId === OPENCODE_SETUP_APP_ID)).toBe(false);
    await expect(readFile(f.configPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reconcile restarts the bridge and republishes a moved address', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: mayaModelId });
    await f.bridge.stop();

    await f.manager.reconcile();

    expect(f.isListening()).toBe(true);
    const status = await f.manager.status();
    expect(status.state).toBe('configured');
  });

  it('reconcile leaves the bridge down when the setup was removed', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: mayaModelId });
    await f.manager.remove();

    await f.manager.reconcile();

    expect(f.isListening()).toBe(false);
  });

  it('reconcile refuses to serve when the managed config was tampered with', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: mayaModelId });
    await writeFile(f.configPath, '{"model":"someone/else"}\n', 'utf8');

    await f.manager.reconcile();

    expect(f.isListening()).toBe(false);
  });

  it('does not touch OpenCode until the plugin is explicitly installed', async () => {
    const f = await fixture({ gezels: [maya] });

    const status = await f.manager.configure({ model: mayaModelId });

    expect(status.plugin.state).toBe('not-installed');
    expect(status.plugin.path).toBe(f.pluginPath);
    expect(existsSync(f.opencodeConfigDir)).toBe(false);
  });

  it('installs a plugin that carries this install’s marker and no credential', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: mayaModelId });

    const status = await f.manager.installPlugin({});

    expect(status.plugin.state).toBe('installed');
    expect(status.plugin.canRemove).toBe(true);
    expect(status.plugin.canInstall).toBe(false);
    const source = await readFile(f.pluginPath, 'utf8');
    expect(OPENCODE_PLUGIN_MARKER.isManaged(source, setupOwnerId(f.home))).toBe(true);
    expect(source).toContain(JSON.stringify(f.configPath));
    expect(source).not.toContain(await readFile(f.tokenPath, 'utf8'));
  });

  it('refuses to install before the managed config exists', async () => {
    const f = await fixture({ gezels: [maya] });

    await expect(f.manager.installPlugin({})).rejects.toMatchObject({
      code: 'opencode_not_configured',
    });
    expect(existsSync(f.pluginPath)).toBe(false);
  });

  it('refuses to install when OpenCode is not on this computer', async () => {
    const f = await fixture({ gezels: [maya], opencodeInstalled: false });
    await f.manager.configure({ model: mayaModelId });

    const status = await f.manager.status();
    expect(status.plugin.state).toBe('unsupported');
    await expect(f.manager.installPlugin({})).rejects.toMatchObject({
      code: 'opencode_not_installed',
    });
  });

  it('installing twice is idempotent', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: mayaModelId });
    await f.manager.installPlugin({});
    const first = await stat(f.pluginPath);

    const status = await f.manager.installPlugin({});

    expect(status.plugin.state).toBe('installed');
    expect((await stat(f.pluginPath)).mtimeMs).toBe(first.mtimeMs);
  });

  it('leaves a foreign plugin alone without blocking the rest of the card', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: mayaModelId });
    await mkdir(join(f.opencodeConfigDir, 'plugins'), { recursive: true });
    await writeFile(f.pluginPath, '// someone else wrote this\n', 'utf8');

    const status = await f.manager.status();

    expect(status.plugin.state).toBe('conflict');
    expect(status.plugin.canInstall).toBe(false);
    expect(status.plugin.canReplace).toBe(true);
    // A stray file in the user's OpenCode directory is not a reason to block
    // the managed config the card is actually about.
    expect(status.state).toBe('configured');
    expect(status.canConfigure).toBe(true);
    await expect(f.manager.installPlugin({})).rejects.toMatchObject({
      code: 'opencode_plugin_conflict',
    });
    expect(await readFile(f.pluginPath, 'utf8')).toBe('// someone else wrote this\n');
    await expect(f.manager.removePlugin()).rejects.toMatchObject({
      code: 'opencode_plugin_conflict',
    });
    expect(existsSync(f.pluginPath)).toBe(true);
  });

  it('replaces a foreign plugin only when asked, keeping a backup', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: mayaModelId });
    await mkdir(join(f.opencodeConfigDir, 'plugins'), { recursive: true });
    await writeFile(f.pluginPath, '// someone else wrote this\n', 'utf8');

    const status = await f.manager.installPlugin({ backupConflictingPlugin: true });

    expect(status.plugin.state).toBe('installed');
    expect(status.pluginBackupPath).toBe(`${f.pluginPath}.backup`);
    expect(await readFile(`${f.pluginPath}.backup`, 'utf8')).toBe('// someone else wrote this\n');
  });

  it('treats another Gezel home’s plugin as foreign', async () => {
    const shared = await mkdtemp(join(tmpdir(), 'gezel-opencode-shared-'));
    roots.push(shared);
    const first = await fixture({ gezels: [maya], opencodeConfigDir: shared });
    const second = await fixture({ gezels: [maya], opencodeConfigDir: shared });
    await first.manager.configure({ model: mayaModelId });
    await first.manager.installPlugin({});
    await second.manager.configure({ model: mayaModelId });

    const status = await second.manager.status();

    expect(status.plugin.state).toBe('conflict');
    await expect(second.manager.removePlugin()).rejects.toMatchObject({
      code: 'opencode_plugin_conflict',
    });
    // The other install's setup must survive both a removal attempt and a
    // wholesale teardown here.
    await second.manager.remove();
    expect(existsSync(first.pluginPath)).toBe(true);
    expect(
      OPENCODE_PLUGIN_MARKER.isManaged(
        await readFile(first.pluginPath, 'utf8'),
        setupOwnerId(first.home),
      ),
    ).toBe(true);
  });

  it('reports and repairs a stale plugin without recreating a deleted one', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: mayaModelId });
    await f.manager.installPlugin({});
    const published = await readFile(f.pluginPath, 'utf8');
    await writeFile(
      f.pluginPath,
      OPENCODE_PLUGIN_MARKER.build('// an older Gezel wrote this body\n', setupOwnerId(f.home)),
      'utf8',
    );

    const stale = await f.manager.status();
    expect(stale.plugin.state).toBe('stale');
    expect(stale.state).toBe('update-needed');
    expect(stale.reasons).toContain('The OpenCode plugin file is out of date.');

    await f.manager.reconcile();
    expect(await readFile(f.pluginPath, 'utf8')).toBe(published);

    await f.manager.removePlugin();
    await f.manager.reconcile();
    // Re-materialising a file in the user's own config directory behind their
    // back is the one thing this must never do.
    expect(existsSync(f.pluginPath)).toBe(false);
  });

  it('removes the plugin along with the rest of the setup', async () => {
    const f = await fixture({ gezels: [maya] });
    await f.manager.configure({ model: mayaModelId });
    await f.manager.installPlugin({});

    const status = await f.manager.remove();

    expect(existsSync(f.pluginPath)).toBe(false);
    expect(status.plugin.state).toBe('not-installed');
    expect(existsSync(f.integrationDir)).toBe(false);
  });

  it('builds a launch command that names the managed config per platform', async () => {
    const posix = await fixture({ gezels: [maya], platform: 'darwin' });
    const windows = await fixture({ gezels: [maya], platform: 'win32' });

    const posixStatus = await posix.manager.status();
    const windowsStatus = await windows.manager.status();

    // Assert whole lines, not fragments: this is a command the user pastes, so
    // the quoting and the order of the env assignment are the contract. A
    // `toContain` pair passes even when the two halves are unusable together.
    expect(posixStatus.launchCommand).toBe(
      `OPENCODE_CONFIG='${posixStatus.configPath}' /usr/local/bin/opencode`,
    );
    // PowerShell sets the variable in a separate statement, then needs the call
    // operator before a quoted executable path.
    expect(windowsStatus.launchCommand).toBe(
      `$env:OPENCODE_CONFIG = '${windowsStatus.configPath}'; & '/usr/local/bin/opencode'`,
    );
  });
});
