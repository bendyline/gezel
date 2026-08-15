import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexSetupStatusResponseSchema,
  type GezelSummary,
  type ProviderName,
} from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodexBridgeController } from '../http/codex-bridge.js';
import { createTokenStore } from '../http/token-store.js';
import {
  CODEX_SETUP_APP_ID,
  CODEX_SETUP_PROFILE_NAME,
  type CodexSetupError,
  createCodexSetupManager,
} from './manager.js';

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
    codexHome?: string;
    gezels?: GezelSummary[];
    defaultProvider?: ProviderName;
    defaultModel?: Partial<Record<ProviderName, string>>;
    meesterGezelId?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'gezel-codex-setup-'));
  roots.push(root);
  const home = join(root, 'gezel');
  const codexHome = opts.codexHome ?? join(root, 'codex');
  await mkdir(home, { recursive: true });
  const tokenStore = await createTokenStore({ home, rootToken: 'root-test' });
  let listening = false;
  const port = opts.bridgePort ?? 11_435;
  const bridge: CodexBridgeController = {
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
  const manager = createCodexSetupManager({
    home,
    codexHome,
    tokenStore,
    bridge,
    readConfig: async () => ({
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
        ? [
            {
              id: 'coder.gguf',
              name: 'Local Coder',
              supportsTools: true,
              supportsReasoning: false,
              contextWindow: 16_384,
            },
          ]
        : [],
    detectCodex: async () => ({
      installed: true,
      path: '/usr/local/bin/codex',
      version: 'codex-cli 0.147.0',
    }),
    now: () => new Date('2026-08-10T00:00:00.000Z'),
  });
  return {
    root,
    home,
    codexHome,
    tokenStore,
    bridge,
    manager,
    isListening: () => listening,
    setEndpointsEnabled: (value: boolean) => {
      endpointsEnabled = value;
    },
  };
}

describe('CodexSetupManager', () => {
  it('recommends an eligible gezel and publishes its stable id ahead of raw models', async () => {
    const maya: GezelSummary = {
      id: 'maya-stable-id',
      name: 'Maya',
      role: 'Developer',
      provider: 'llama-cpp',
      model: 'coder.gguf',
      updatedAt: '2026-08-10T00:00:00.000Z',
    };
    const f = await fixture({ gezels: [maya], meesterGezelId: maya.id });

    const before = await f.manager.status();
    expect(before.recommendedModel).toBe(`gezel:${maya.id}`);
    expect(before.models.map((model) => model.id)).toEqual([
      `gezel:${maya.id}`,
      'llama-cpp:coder.gguf',
    ]);
    expect(before.models[0]).toMatchObject({
      kind: 'gezel',
      label: 'Maya',
      role: 'Developer',
      modelLabel: 'Local Coder',
      provider: 'llama-cpp',
      contextWindow: 16_384,
    });

    await f.manager.configure({ model: `gezel:${maya.id}` });
    const profile = await readFile(
      join(f.codexHome, `${CODEX_SETUP_PROFILE_NAME}.config.toml`),
      'utf8',
    );
    expect(profile).toContain(`model = "gezel:${maya.id}"`);

    const catalog = JSON.parse(
      await readFile(join(f.home, 'integrations', 'codex', 'models.json'), 'utf8'),
    ) as { models: Array<Record<string, unknown>> };
    expect(catalog.models[0]).toMatchObject({
      slug: `gezel:${maya.id}`,
      display_name: 'Maya',
      context_window: 16_384,
    });
  });

  it('keeps raw models available when a gezel is not backed by eligible local inference', async () => {
    const cloudGezel: GezelSummary = {
      id: 'cloud-gezel',
      name: 'Cloudy',
      provider: 'openai',
      model: 'gpt-5.6',
      updatedAt: '2026-08-10T00:00:00.000Z',
    };
    const f = await fixture({ gezels: [cloudGezel] });

    const status = await f.manager.status();
    expect(status.models).toHaveLength(1);
    expect(status.models[0]).toMatchObject({
      id: 'llama-cpp:coder.gguf',
      kind: 'model',
    });
    expect(status.recommendedModel).toBe('llama-cpp:coder.gguf');
  });

  it('creates an isolated authenticated profile without touching config.toml', async () => {
    const f = await fixture();
    await mkdir(f.codexHome, { recursive: true });
    const userConfig = join(f.codexHome, 'config.toml');
    await writeFile(userConfig, 'approval_policy = "untrusted"\n');

    const status = await f.manager.configure({ model: 'llama-cpp:coder.gguf' });
    expect(() => CodexSetupStatusResponseSchema.parse(status)).not.toThrow();
    expect(status.state).toBe('configured');
    expect(status.canRemove).toBe(true);
    expect(status.launchCommand).toBe(
      process.platform === 'win32'
        ? `$env:CODEX_HOME = '${f.codexHome.replace(/'/g, "''")}'; & '/usr/local/bin/codex' --profile 'gezel-local'`
        : `CODEX_HOME=${f.codexHome} /usr/local/bin/codex --profile gezel-local`,
    );
    expect(status.bridge).toEqual({
      baseUrl: 'http://127.0.0.1:11435/v1',
      listening: true,
      port: 11_435,
    });
    expect(await readFile(userConfig, 'utf8')).toBe('approval_policy = "untrusted"\n');

    const profilePath = join(f.codexHome, `${CODEX_SETUP_PROFILE_NAME}.config.toml`);
    const profile = await readFile(profilePath, 'utf8');
    expect(profile).toContain('# Managed by Gezel.');
    expect(profile).toContain('model = "llama-cpp:coder.gguf"');
    expect(profile).toContain('wire_api = "responses"');
    expect(profile).toContain('web_search = "disabled"');
    expect(profile).toContain('base_url = "http://127.0.0.1:11435/v1"');
    expect(profile).toContain('[model_providers.gezel.auth]');
    expect(profile).not.toContain(
      f.tokenStore.list().find((r) => r.appId === CODEX_SETUP_APP_ID)!.token,
    );

    const record = f.tokenStore.list().find((item) => item.appId === CODEX_SETUP_APP_ID);
    expect(record?.scopes).toEqual(['openai']);
    const tokenPath = join(f.home, 'integrations', 'codex', 'token');
    expect((await readFile(tokenPath, 'utf8')).trim()).toBe(record?.token);
    if (process.platform !== 'win32') {
      expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
      expect((await stat(profilePath)).mode & 0o777).toBe(0o600);
    }

    const catalog = JSON.parse(
      await readFile(join(f.home, 'integrations', 'codex', 'models.json'), 'utf8'),
    ) as { models: Array<Record<string, unknown>> };
    expect(catalog.models[0]).toMatchObject({
      slug: 'llama-cpp:coder.gguf',
      shell_type: 'shell_command',
      apply_patch_tool_type: 'freeform',
      supports_search_tool: false,
      default_service_tier: null,
      service_tiers: [
        {
          id: 'priority',
          name: 'Fast',
        },
      ],
      additional_speed_tiers: [],
      context_window: 16_384,
    });
  });

  it('refuses to replace an unmanaged profile', async () => {
    const f = await fixture();
    await mkdir(f.codexHome, { recursive: true });
    const profilePath = join(f.codexHome, `${CODEX_SETUP_PROFILE_NAME}.config.toml`);
    await writeFile(profilePath, 'model = "mine"\n');

    const status = await f.manager.status();
    expect(status.state).toBe('conflict');
    expect(status.canRemove).toBe(false);
    await expect(f.manager.configure({ model: 'llama-cpp:coder.gguf' })).rejects.toMatchObject({
      code: 'codex_profile_conflict',
      status: 409,
    } satisfies Partial<CodexSetupError>);
    expect(await readFile(profilePath, 'utf8')).toBe('model = "mine"\n');
    expect(f.tokenStore.list().some((item) => item.appId === CODEX_SETUP_APP_ID)).toBe(false);
  });

  it('repairs an unmanaged profile by preserving it as a backup beside itself', async () => {
    const f = await fixture();
    await mkdir(f.codexHome, { recursive: true });
    const profilePath = join(f.codexHome, `${CODEX_SETUP_PROFILE_NAME}.config.toml`);
    await writeFile(profilePath, 'model = "mine"\n');

    const conflicted = await f.manager.status();
    expect(conflicted.state).toBe('conflict');
    expect(conflicted.canRepair).toBe(true);

    const repaired = await f.manager.configure({
      model: 'llama-cpp:coder.gguf',
      backupConflictingProfile: true,
    });
    expect(repaired.state).toBe('configured');
    expect(repaired.profileBackupPath).toBe(`${profilePath}.backup`);
    expect(await readFile(`${profilePath}.backup`, 'utf8')).toBe('model = "mine"\n');
    expect(await readFile(profilePath, 'utf8')).toContain('# Managed by Gezel.');

    // A second repair must not clobber the first preserved copy.
    await writeFile(profilePath, 'model = "mine again"\n');
    const again = await f.manager.configure({
      model: 'llama-cpp:coder.gguf',
      backupConflictingProfile: true,
    });
    expect(again.profileBackupPath).toBe(`${profilePath}.backup-2`);
    expect(await readFile(`${profilePath}.backup`, 'utf8')).toBe('model = "mine"\n');
    expect(await readFile(`${profilePath}.backup-2`, 'utf8')).toBe('model = "mine again"\n');
  });

  it('adopts a profile left behind by another Gezel home when asked to repair', async () => {
    const first = await fixture();
    await first.manager.configure({ model: 'llama-cpp:coder.gguf' });
    const profilePath = join(first.codexHome, `${CODEX_SETUP_PROFILE_NAME}.config.toml`);
    const firstProfile = await readFile(profilePath, 'utf8');

    const second = await fixture({ codexHome: first.codexHome });
    expect((await second.manager.status()).canRepair).toBe(true);
    const repaired = await second.manager.configure({
      model: 'llama-cpp:coder.gguf',
      backupConflictingProfile: true,
    });

    expect(repaired.state).toBe('configured');
    expect(await readFile(`${profilePath}.backup`, 'utf8')).toBe(firstProfile);
    expect(await readFile(profilePath, 'utf8')).not.toBe(firstProfile);
    expect((await first.manager.status()).state).toBe('conflict');
  });

  it('refuses to repair a conflict owned by another connected app', async () => {
    const f = await fixture();
    const record = await f.tokenStore.issue({
      appId: CODEX_SETUP_APP_ID,
      appName: 'Unrelated app',
      scopes: ['openai'],
    });

    const status = await f.manager.status();
    expect(status.state).toBe('conflict');
    expect(status.canRepair).toBe(false);
    await expect(
      f.manager.configure({ model: 'llama-cpp:coder.gguf', backupConflictingProfile: true }),
    ).rejects.toMatchObject({ code: 'codex_profile_conflict' });
    expect(f.tokenStore.list().find((item) => item.appId === CODEX_SETUP_APP_ID)?.token).toBe(
      record.token,
    );
  });

  it('clears owned setup material after a conflict without deleting an unmanaged profile', async () => {
    const f = await fixture();
    await f.manager.configure({ model: 'llama-cpp:coder.gguf' });
    const profilePath = join(f.codexHome, `${CODEX_SETUP_PROFILE_NAME}.config.toml`);
    const editedProfile = `${await readFile(profilePath, 'utf8')}# user-owned edit\n`;
    await writeFile(profilePath, editedProfile);

    const conflicted = await f.manager.status();
    expect(conflicted.state).toBe('conflict');
    expect(conflicted.canRemove).toBe(true);

    const removed = await f.manager.remove();
    expect(removed.state).toBe('conflict');
    expect(removed.canRemove).toBe(false);
    expect(await readFile(profilePath, 'utf8')).toBe(editedProfile);
    expect(f.tokenStore.list().some((item) => item.appId === CODEX_SETUP_APP_ID)).toBe(false);
  });

  it('does not adopt or revoke a conflicting app credential identity', async () => {
    const f = await fixture();
    const record = await f.tokenStore.issue({
      appId: CODEX_SETUP_APP_ID,
      appName: 'Unrelated app',
      scopes: ['openai'],
    });

    const status = await f.manager.status();
    expect(status.state).toBe('conflict');
    expect(status.canRemove).toBe(false);
    await expect(f.manager.configure({ model: 'llama-cpp:coder.gguf' })).rejects.toMatchObject({
      code: 'codex_profile_conflict',
    });

    await f.manager.remove();
    expect(f.tokenStore.list().find((item) => item.appId === CODEX_SETUP_APP_ID)?.token).toBe(
      record.token,
    );
  });

  it('does not overwrite or remove a profile owned by another Gezel home', async () => {
    const first = await fixture();
    await first.manager.configure({ model: 'llama-cpp:coder.gguf' });
    const profilePath = join(first.codexHome, `${CODEX_SETUP_PROFILE_NAME}.config.toml`);
    const firstProfile = await readFile(profilePath, 'utf8');

    const second = await fixture({ codexHome: first.codexHome });
    const status = await second.manager.status();
    expect(status.state).toBe('conflict');
    expect(status.canRemove).toBe(false);
    await expect(second.manager.configure({ model: 'llama-cpp:coder.gguf' })).rejects.toMatchObject(
      {
        code: 'codex_profile_conflict',
      },
    );
    await second.manager.remove();

    expect(await readFile(profilePath, 'utf8')).toBe(firstProfile);
  });

  it('tracks endpoint and credential drift, then removes only managed material', async () => {
    const f = await fixture();
    await f.manager.configure({ model: 'llama-cpp:coder.gguf' });
    await f.tokenStore.revoke(CODEX_SETUP_APP_ID);
    expect((await f.manager.status()).reasons).toContain(
      'The Codex app credential was revoked or is invalid.',
    );

    f.setEndpointsEnabled(false);
    await f.manager.reconcile();
    expect(f.isListening()).toBe(false);
    await expect(f.manager.configure({ model: 'llama-cpp:coder.gguf' })).rejects.toMatchObject({
      code: 'openai_endpoints_disabled',
    });

    f.setEndpointsEnabled(true);
    await f.manager.configure({ model: 'llama-cpp:coder.gguf' });
    const unrelated = join(f.codexHome, 'notes.txt');
    await writeFile(unrelated, 'keep me');
    const removed = await f.manager.remove();
    expect(removed.state).toBe('not-configured');
    expect(await readFile(unrelated, 'utf8')).toBe('keep me');
    await expect(
      readFile(join(f.codexHome, `${CODEX_SETUP_PROFILE_NAME}.config.toml`), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.tokenStore.list().some((item) => item.appId === CODEX_SETUP_APP_ID)).toBe(false);
  });

  it('reconciles a configured profile onto the bridge address after restart', async () => {
    const f = await fixture({ bridgePort: 42_321 });
    await f.manager.configure({ model: 'llama-cpp:coder.gguf' });
    await f.bridge.stop();
    expect(f.isListening()).toBe(false);

    await f.manager.reconcile();
    expect(f.isListening()).toBe(true);
    const profile = await readFile(
      join(f.codexHome, `${CODEX_SETUP_PROFILE_NAME}.config.toml`),
      'utf8',
    );
    expect(profile).toContain('base_url = "http://127.0.0.1:42321/v1"');
  });

  it('serializes shutdown behind an in-flight setup so the bridge cannot reopen', async () => {
    let markStarted!: () => void;
    let releaseStart!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const f = await fixture({
      beforeBridgeListen: async () => {
        markStarted();
        await startGate;
      },
    });

    const configuring = f.manager.configure({ model: 'llama-cpp:coder.gguf' });
    await started;
    const stopping = f.manager.stop();
    releaseStart();
    await configuring;
    await stopping;

    expect(f.isListening()).toBe(false);
    await f.manager.reconcile();
    expect(f.isListening()).toBe(false);
  });
});
