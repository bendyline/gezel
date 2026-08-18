import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VSCodeSetupStatusResponseSchema } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import { createTokenStore } from '../http/token-store.js';
import type { VSCodeBridgeController } from '../http/vscode-bridge.js';
import type { ModelInfo } from '../providers/types.js';
import { VSCODE_SETUP_APP_ID, createVSCodeSetupManager } from './manager.js';
import { inspectVSCodeConfig } from './profile-config.js';

const roots: string[] = [];
const managers: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'gezel vscode setup '));
  roots.push(root);
  const home = join(root, 'gezel');
  const vscodeUserDir = join(root, 'Code', 'User');
  const configPath = join(vscodeUserDir, 'chatLanguageModels.json');
  await mkdir(vscodeUserDir, { recursive: true });
  const tokenStore = await createTokenStore({ home, rootToken: 'root-test' });
  let listening = false;
  const bridge: VSCodeBridgeController = {
    status: () => (listening ? { listening: true, port: 23_456 } : { listening: false }),
    desiredPort: () => 23_456,
    baseUrl: () => 'http://127.0.0.1:23456',
    start: async () => {
      listening = true;
      return { listening: true, port: 23_456 };
    },
    stop: async () => {
      listening = false;
    },
  };
  let models: ModelInfo[] = [
    {
      id: 'coder.gguf',
      name: 'Local Coder',
      supportsTools: true,
      contextWindow: 16_384,
    },
  ];
  const manager = createVSCodeSetupManager({
    home,
    vscodeUserDir,
    tokenStore,
    bridge,
    readConfig: async () => ({ openaiEndpoints: {} }),
    listGezels: async () => [],
    providerForGezel: async () => 'llama-cpp',
    listModels: async (provider) => (provider === 'llama-cpp' ? models : []),
    detectVSCode: async () => ({
      installed: true,
      product: 'code',
      path: '/usr/local/bin/code',
      version: '1.100.0',
    }),
    now: () => new Date('2026-08-18T00:00:00.000Z'),
    reconcileIntervalMs: 60_000,
  });
  managers.push(manager);
  return {
    manager,
    tokenStore,
    configPath,
    setModels(next: ModelInfo[]) {
      models = next;
    },
  };
}

describe('VSCodeSetupManager', () => {
  it('publishes every eligible model with a dedicated scoped credential', async () => {
    const f = await fixture();
    await writeFile(
      f.configPath,
      '[\n  // preserved\n  {"name":"Other","vendor":"customendpoint","apiKey":"keep"}\n]\n',
    );

    const configured = await f.manager.configure({ profileId: 'code:default' });

    expect(VSCodeSetupStatusResponseSchema.parse(configured)).toBeTruthy();
    expect(configured.state).toBe('configured');
    expect(configured.configuredProfileId).toBe('code:default');
    const raw = await readFile(f.configPath, 'utf8');
    expect(raw).toContain('// preserved');
    const provider = inspectVSCodeConfig(raw).gezelProvider as {
      apiKey: string;
      models: Array<Record<string, unknown>>;
    };
    expect(provider.models).toEqual([
      expect.objectContaining({
        id: 'llama-cpp:coder.gguf',
        url: 'http://127.0.0.1:23456/v1/chat/completions',
        toolCalling: true,
        maxInputTokens: 12_288,
        maxOutputTokens: 4_096,
      }),
    ]);
    const record = f.tokenStore.list().find((entry) => entry.appId === VSCODE_SETUP_APP_ID);
    expect(record?.scopes).toEqual(['openai']);
    expect(provider.apiKey).toBe(record?.token);
  });

  it('regenerates the model roster during reconciliation', async () => {
    const f = await fixture();
    await f.manager.configure({ profileId: 'code:default' });
    f.setModels([
      {
        id: 'new.gguf',
        name: 'New Local Model',
        supportsTools: true,
        contextWindow: 32_768,
      },
    ]);

    await f.manager.reconcile();

    const provider = inspectVSCodeConfig(await readFile(f.configPath, 'utf8')).gezelProvider as {
      models: Array<{ id: string }>;
    };
    expect(provider.models.map((model) => model.id)).toEqual(['llama-cpp:new.gguf']);
    expect((await f.manager.status()).state).toBe('configured');
  });

  it('backs up a conflicting Gezel entry before repair', async () => {
    const f = await fixture();
    const foreign = JSON.stringify([
      { name: 'Other', vendor: 'customendpoint', apiKey: 'keep' },
      { name: 'Gezel', vendor: 'customendpoint', apiKey: 'foreign', models: [] },
    ]);
    await writeFile(f.configPath, foreign);

    const conflict = await f.manager.status();
    expect(conflict.state).toBe('conflict');
    expect(conflict.canRepair).toBe(true);
    await expect(f.manager.configure({ profileId: 'code:default' })).rejects.toMatchObject({
      code: 'vscode_config_conflict',
    });

    const repaired = await f.manager.configure({
      profileId: 'code:default',
      backupConflictingConfig: true,
    });
    expect(repaired.state).toBe('configured');
    expect(repaired.configBackupPath).toBe(`${f.configPath}.backup`);
    expect(await readFile(`${f.configPath}.backup`, 'utf8')).toBe(foreign);
    expect(inspectVSCodeConfig(await readFile(f.configPath, 'utf8')).providers[0]).toMatchObject({
      name: 'Other',
      apiKey: 'keep',
    });
  });

  it('clear removes only Gezel and revokes its credential', async () => {
    const f = await fixture();
    await writeFile(f.configPath, '[{"name":"Other","vendor":"customendpoint","apiKey":"keep"}]\n');
    await f.manager.configure({ profileId: 'code:default' });

    const cleared = await f.manager.remove();

    expect(cleared.state).toBe('not-configured');
    expect(inspectVSCodeConfig(await readFile(f.configPath, 'utf8')).providers).toEqual([
      { name: 'Other', vendor: 'customendpoint', apiKey: 'keep' },
    ]);
    expect(f.tokenStore.list().some((entry) => entry.appId === VSCODE_SETUP_APP_ID)).toBe(false);
  });

  it('clear preserves a hand-edited provider but revokes its credential', async () => {
    const f = await fixture();
    await f.manager.configure({ profileId: 'code:default' });
    const providers = inspectVSCodeConfig(await readFile(f.configPath, 'utf8')).providers;
    const gezel = providers.find((provider) => provider.name === 'Gezel')!;
    gezel.apiKey = 'changed-outside-gezel';
    await writeFile(f.configPath, `${JSON.stringify(providers, null, 2)}\n`);

    const cleared = await f.manager.remove();

    expect(cleared.state).toBe('conflict');
    expect(inspectVSCodeConfig(await readFile(f.configPath, 'utf8')).gezelProvider).toMatchObject({
      apiKey: 'changed-outside-gezel',
    });
    expect(f.tokenStore.list().some((entry) => entry.appId === VSCODE_SETUP_APP_ID)).toBe(false);
  });
});
