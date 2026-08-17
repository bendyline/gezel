import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildConfig } from './manager.js';
import { OPENCODE_PLUGIN_MARKER, buildOpenCodePluginSource } from './plugin-source.js';

const OWNER = 'owner-abc123';
const TOKEN = 'gz-opencode-secret-token';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface LoadedPlugin {
  config?: (config: Record<string, unknown>) => Promise<void>;
}

/**
 * Load the generated module the way OpenCode does — as ESM from a file URL —
 * and hand back its hooks. Proves the emitted text is valid, loadable JS
 * without needing OpenCode itself.
 */
async function loadPlugin(source: string, dir: string, name = 'gezel.js'): Promise<LoadedPlugin> {
  const path = join(dir, name);
  await writeFile(path, source, 'utf8');
  const module = (await import(`${pathToFileURL(path).href}?v=${name}`)) as Record<string, unknown>;
  const factory = module.GezelLocalModels as () => Promise<LoadedPlugin>;
  return factory();
}

async function fixture(input?: { managedConfig?: string; token?: string | null }) {
  const dir = await mkdtemp(join(tmpdir(), 'gezel-opencode-plugin-'));
  roots.push(dir);
  const configPath = join(dir, 'opencode.json');
  const tokenPath = join(dir, 'token');
  const managedConfig =
    input?.managedConfig ??
    JSON.stringify({
      provider: {
        gezel: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Gezel (local)',
          options: { baseURL: 'http://127.0.0.1:21435/v1', apiKey: `{file:${tokenPath}}` },
          models: { 'gezel:wren': { name: 'Wren', tool_call: true } },
        },
      },
      model: 'gezel/gezel:wren',
      small_model: 'gezel/gezel:wren',
    });
  if (managedConfig !== '__absent__') await writeFile(configPath, managedConfig, 'utf8');
  const token = input?.token === undefined ? TOKEN : input.token;
  if (token !== null) await writeFile(tokenPath, token, 'utf8');

  const source = buildOpenCodePluginSource({
    configPath,
    tokenPath,
    providerId: 'gezel',
    ownerId: OWNER,
  });
  return { dir, configPath, tokenPath, source };
}

describe('buildOpenCodePluginSource', () => {
  it('carries an ownership marker and no secret', async () => {
    const { source, tokenPath, configPath } = await fixture();

    expect(OPENCODE_PLUGIN_MARKER.isManaged(source, OWNER)).toBe(true);
    expect(OPENCODE_PLUGIN_MARKER.isManaged(source, 'another-install')).toBe(false);
    expect(OPENCODE_PLUGIN_MARKER.isClaimed(source)).toBe(true);
    expect(source.startsWith('// Managed by Gezel.')).toBe(true);
    // The credential is read at run time; it must never be baked into a file
    // that sits in the user's — possibly synced — config directory.
    expect(source).not.toContain(TOKEN);
    // Paths are embedded as JS string literals, so a Windows separator arrives
    // escaped. Assert the encoded form — that is what OpenCode reads back.
    expect(source).toContain(JSON.stringify(tokenPath));
    expect(source).toContain(JSON.stringify(configPath));
  });

  it('injects the managed provider with the credential read from disk', async () => {
    const { source, dir } = await fixture();
    const plugin = await loadPlugin(source, dir);
    const config: Record<string, unknown> = { provider: { other: { name: 'Other' } } };

    await plugin.config?.(config);

    const provider = (config.provider as Record<string, Record<string, unknown>>).gezel ?? {};
    expect(provider.npm).toBe('@ai-sdk/openai-compatible');
    expect(provider.options).toEqual({
      baseURL: 'http://127.0.0.1:21435/v1',
      apiKey: TOKEN,
    });
    expect((config.provider as Record<string, unknown>).other).toEqual({ name: 'Other' });
  });

  it('never touches the default model', async () => {
    const { source, dir } = await fixture();
    const plugin = await loadPlugin(source, dir, 'default-model.js');
    const config: Record<string, unknown> = { model: 'anthropic/claude-opus-5' };

    await plugin.config?.(config);

    expect(config.model).toBe('anthropic/claude-opus-5');
    expect(config.small_model).toBeUndefined();
  });

  it('lets the user own explicit provider keys', async () => {
    const { source, dir } = await fixture();
    const plugin = await loadPlugin(source, dir, 'user-wins.js');
    const config: Record<string, unknown> = {
      provider: { gezel: { name: 'My own gezel entry' } },
    };

    await plugin.config?.(config);

    const provider = (config.provider as Record<string, Record<string, unknown>>).gezel ?? {};
    expect(provider.name).toBe('My own gezel entry');
    expect(provider.npm).toBe('@ai-sdk/openai-compatible');
  });

  it('reads the config shape the manager actually publishes', async () => {
    // The managed config is this plugin's ABI. If `buildConfig` ever renames
    // the provider key or restructures `options`, every installed plugin goes
    // quietly dead — so pair them here rather than against a hand-written
    // fixture that would keep passing.
    const { dir, tokenPath } = await fixture({ managedConfig: '__absent__' });
    const configPath = join(dir, 'opencode.json');
    await writeFile(
      configPath,
      buildConfig({
        model: { id: 'gezel:wren', label: 'Wren', kind: 'gezel', provider: 'mlx' },
        models: [{ id: 'gezel:wren', label: 'Wren', kind: 'gezel', provider: 'mlx' }],
        baseUrl: 'http://127.0.0.1:21435/v1',
        tokenPath,
      }),
      'utf8',
    );
    const plugin = await loadPlugin(
      buildOpenCodePluginSource({ configPath, tokenPath, providerId: 'gezel', ownerId: OWNER }),
      dir,
      'abi.js',
    );
    const config: Record<string, unknown> = {};

    await plugin.config?.(config);

    const provider = (config.provider as Record<string, Record<string, unknown>>).gezel ?? {};
    expect(provider.npm).toBe('@ai-sdk/openai-compatible');
    expect(provider.models).toHaveProperty('gezel:wren');
    expect((provider.options as Record<string, unknown>).apiKey).toBe(TOKEN);
  });

  it.each([
    ['the managed config is missing', { managedConfig: '__absent__' }],
    ['the credential is missing', { token: null }],
    ['the managed config is malformed', { managedConfig: '{ not json' }],
    ['the managed config has no gezel provider', { managedConfig: '{"provider":{}}' }],
    ['the credential is empty', { token: '   ' }],
  ])('leaves the config untouched when %s', async (_label, input) => {
    const { source, dir } = await fixture(input);
    const plugin = await loadPlugin(source, dir, `${_label.replace(/\W+/g, '-')}.js`);
    const config: Record<string, unknown> = { provider: { other: { name: 'Other' } } };

    await expect(plugin.config?.(config)).resolves.toBeUndefined();

    expect(config.provider).toEqual({ other: { name: 'Other' } });
  });
});
