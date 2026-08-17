import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PI_EXTENSION_MARKER, buildPiExtensionSource } from './extension-source.js';
import { buildRoster } from './manager.js';

const OWNER = 'owner-abc123';
const TOKEN = 'gz-pi-secret-token';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface RegisteredProvider {
  id: string;
  config: Record<string, unknown>;
}

/**
 * Load the generated module the way pi does — as ESM from a file URL — and run
 * its factory against a stand-in ExtensionAPI. Proves the emitted text is
 * valid, loadable JS without needing pi itself.
 */
async function loadExtension(
  source: string,
  dir: string,
  name = 'gezel.js',
): Promise<RegisteredProvider[]> {
  const path = join(dir, name);
  await writeFile(path, source, 'utf8');
  const module = (await import(`${pathToFileURL(path).href}?v=${name}`)) as {
    default: (pi: {
      registerProvider: (id: string, config: Record<string, unknown>) => void;
    }) => unknown;
  };
  const registered: RegisteredProvider[] = [];
  await module.default({
    registerProvider: (id, config) => {
      registered.push({ id, config });
    },
  });
  return registered;
}

async function fixture(input?: { roster?: string; token?: string | null }) {
  const dir = await mkdtemp(join(tmpdir(), 'gezel-pi-extension-'));
  roots.push(dir);
  const rosterPath = join(dir, 'models.json');
  const tokenPath = join(dir, 'token');
  const roster =
    input?.roster ??
    buildRoster({
      model: { id: 'gezel:wren', label: 'Wren', kind: 'gezel', provider: 'mlx' },
      models: [
        {
          id: 'gezel:wren',
          label: 'Wren',
          description: 'Meester · Qwen',
          kind: 'gezel',
          provider: 'mlx',
          contextWindow: 262_144,
          supportsReasoning: true,
        },
      ],
      baseUrl: 'http://127.0.0.1:24680/v1',
    });
  if (roster !== '__absent__') await writeFile(rosterPath, roster, 'utf8');
  const token = input?.token === undefined ? TOKEN : input.token;
  if (token !== null) await writeFile(tokenPath, token, 'utf8');

  return {
    dir,
    rosterPath,
    tokenPath,
    source: buildPiExtensionSource({ rosterPath, tokenPath, ownerId: OWNER }),
  };
}

describe('buildPiExtensionSource', () => {
  it('carries an ownership marker and no secret', async () => {
    const { source, rosterPath, tokenPath } = await fixture();

    expect(PI_EXTENSION_MARKER.isManaged(source, OWNER)).toBe(true);
    expect(PI_EXTENSION_MARKER.isManaged(source, 'another-install')).toBe(false);
    expect(PI_EXTENSION_MARKER.isClaimed(source)).toBe(true);
    // The credential is read at run time; it must never be baked into a file
    // that sits in the user's own pi directory.
    expect(source).not.toContain(TOKEN);
    expect(source).toContain(rosterPath);
    expect(source).toContain(tokenPath);
  });

  it('registers the provider pi expects, reading the roster the manager wrote', async () => {
    // The roster is this extension's ABI. If `buildRoster` ever restructures
    // the provider block, every installed extension goes quietly dead — so
    // pair them here rather than against a hand-written fixture.
    const { source, dir } = await fixture();

    const registered = await loadExtension(source, dir);

    expect(registered).toHaveLength(1);
    expect(registered[0]?.id).toBe('gezel');
    expect(registered[0]?.config).toMatchObject({
      name: 'Gezel (local)',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:24680/v1',
      apiKey: TOKEN,
    });
    const models = registered[0]?.config.models as Array<Record<string, unknown>>;
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'gezel:wren',
      contextWindow: 262_144,
      reasoning: true,
      cost: { input: 0, output: 0 },
    });
  });

  it('trims a credential file that picked up whitespace', async () => {
    const { source, dir } = await fixture({ token: `${TOKEN}\n` });

    const registered = await loadExtension(source, dir, 'trimmed.js');

    expect(registered[0]?.config.apiKey).toBe(TOKEN);
  });

  it.each([
    ['the roster is missing', { roster: '__absent__' }],
    ['the credential is missing', { token: null }],
    ['the roster is malformed', { roster: '{ not json' }],
    ['the roster has no provider', { roster: '{}' }],
    [
      'the roster lists no models',
      { roster: '{"provider":{"id":"gezel","baseUrl":"x","models":[]}}' },
    ],
    ['the credential is empty', { token: '   ' }],
  ])('registers nothing when %s', async (label, input) => {
    const { source, dir } = await fixture(input);

    const registered = await loadExtension(source, dir, `${label.replace(/\W+/g, '-')}.js`);

    expect(registered).toEqual([]);
  });
});
