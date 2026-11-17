import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { ConnectorTypeManifest } from '@bendyline/gezel';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { syncWithAdapter } from '../manager.js';
import { ComponentStore } from '../spectral/component-store.js';
import {
  type FakeRegistry,
  type PackedFixture,
  packFixture,
  spectralFixture,
  startFakeRegistry,
} from '../testing/fake-npm-registry.js';
import { type ConnectorTestEnv, createConnectorTestEnv, readCorpus } from '../testing/harness.js';
import type { ConnectorBindingRef, NormalizedRecord } from '../types.js';
import {
  SpectralComponentAdapter,
  type SpectralComponentCursor,
  SpectralReplay,
} from './spectral-component.js';

/**
 * A published-component connector end to end: the store installs the
 * component into a Gezel home (no `node_modules` beside it, so it loads only
 * if the runner maps its SDK imports), and the engine syncs it through runner
 * v2 under the real sandbox, a page at a time.
 */

const require = createRequire(import.meta.url);
const built = existsSync(require.resolve('@bendyline/gezel-connectors-spectral/run'));
const NAME = '@prismatic-io/components-gezel-echo-fixture';
const ENTRY = 'npm-dist/index.cjs';
const KEY = 'echo-key-abcdefgh12345';

let registry: FakeRegistry;
let packed: PackedFixture;
let server: Server;
let base: string;
let changes: { id: string; title: string }[];
let listed: { id: string; title: string }[];

beforeAll(async () => {
  packed = await packFixture(spectralFixture('echo-component'), ENTRY);
  registry = await startFakeRegistry([{ name: NAME, version: '1.0.0', tarball: packed.path }]);
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${KEY}`) {
      res.writeHead(401).end('{}');
      return;
    }
    if (url.pathname === '/changes') {
      const fresh = changes.slice(Number(url.searchParams.get('since')));
      const at = Number(url.searchParams.get('cursor') ?? '0');
      const more = at + 2 < fresh.length;
      res.end(
        JSON.stringify({
          items: fresh.slice(at, at + 2),
          cursor: more ? String(at + 2) : null,
          now: String(changes.length),
        }),
      );
      return;
    }
    if (url.pathname === '/items') {
      res.end(JSON.stringify({ items: listed }));
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await registry.close();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

function typeFor(
  mode: 'trigger' | 'action',
  completeness: 'mirror' | 'window',
): ConnectorTypeManifest {
  return {
    schemaVersion: 1,
    kind: 'connector-type',
    id: `echo-${mode}`,
    name: 'Echo',
    description: '',
    tags: [],
    maintainer: { name: 'test' },
    version: '1.0.0',
    releasedAt: '2026-11-01T00:00:00Z',
    driver: 'spectral',
    source: {
      package: {
        name: NAME,
        version: '1.0.0',
        sha256: packed.sha256,
        entry: ENTRY,
        entrySha256: packed.entrySha256,
        spectral: '^10.39.1',
        license: 'Apache-2.0',
        publishedAt: '2026-11-01T00:00:00.000Z',
      },
      mode,
      ...(mode === 'trigger'
        ? { trigger: 'changes', items: { resolver: true } }
        : { action: 'listItems', items: { paths: ['$.data'] } }),
      connection: { key: 'apiKey', input: 'connection' },
      inputs: { baseUrl: '$config.baseUrl' },
      // A loopback test server; real manifests declare https origins.
      origins: [base],
    },
    secretShape: { kind: 'apikey', field: 'apiKey' },
    normalize: {
      kind: 'mapping',
      map: { id: '$.id', title: '$.title', body: '$.title' },
    },
    completeness,
    actions: [],
    availableVersions: ['1.0.0'],
  } as unknown as ConnectorTypeManifest;
}

describe.runIf(built)('a published-component connector, synced through the sandbox', () => {
  let env: ConnectorTestEnv;
  afterEach(async () => env?.dispose());

  async function sync(
    type: ConnectorTypeManifest,
    binding: ConnectorBindingRef,
    cursor: unknown,
    stateDir: string,
    limit = 2,
  ) {
    const components = new ComponentStore({
      home: join(env.root, 'home'),
      registry: registry.url,
    });
    return syncWithAdapter<SpectralComponentCursor, NormalizedRecord>(
      new SpectralComponentAdapter(type, binding, env.deps({ components, stateDir })),
      {
        storageDir: env.artifactsDir,
        quarantineDir: env.quarantineDir,
        corpusDir: 'data/echo',
        backfillLimit: limit,
        cursor: cursor as SpectralComponentCursor | undefined,
        // What the manager passes for a mirror type.
        allowPrune: type.completeness === 'mirror',
      },
    );
  }

  it('drains a polling trigger a page at a time and resumes from its position', async () => {
    env = await createConnectorTestEnv();
    const binding: ConnectorBindingRef = {
      id: 'echo:1',
      type: 'echo-trigger',
      config: { baseUrl: base },
    };
    await env.storeCredential(binding, KEY);
    const stateDir = join(env.root, 'state', 'echo-1');
    changes = [
      { id: 'c1', title: 'One' },
      { id: 'c2', title: 'Two' },
      { id: 'c3', title: 'Three' },
    ];
    const first = await sync(typeFor('trigger', 'window'), binding, undefined, stateDir);
    expect(first.error).toBeUndefined();
    expect(first.written).toBe(3);
    const cursor = first.cursor as unknown as { scopes: Record<string, SpectralComponentCursor> };
    expect(cursor.scopes['']?.state).toEqual({ since: '3' });
    expect(cursor.scopes['']?.staged).toBeUndefined();
    expect(await readdir(join(stateDir, 'staging'))).toEqual([]);

    changes.push({ id: 'c4', title: 'Four' });
    const second = await sync(typeFor('trigger', 'window'), binding, cursor, stateDir);
    expect(second.written).toBe(1);
    const titles = (await readCorpus(env.artifactsDir, 'data/echo')).map(
      (r) => r.frontmatter.title,
    );
    expect(titles.sort()).toEqual(['Four', 'One', 'Three', 'Two']);
  });

  it('lists an action whole each pass, so a mirror loses what the source removed', async () => {
    env = await createConnectorTestEnv();
    const binding: ConnectorBindingRef = {
      id: 'echo:2',
      type: 'echo-action',
      config: { baseUrl: base },
    };
    await env.storeCredential(binding, KEY);
    const stateDir = join(env.root, 'state', 'echo-2');
    listed = [
      { id: 'a', title: 'Alpha' },
      { id: 'b', title: 'Beta' },
      { id: 'c', title: 'Gamma' },
    ];
    const first = await sync(typeFor('action', 'mirror'), binding, undefined, stateDir);
    expect(first.error).toBeUndefined();
    expect(first.written).toBe(3);
    listed = listed.filter((r) => r.id !== 'b');
    const second = await sync(typeFor('action', 'mirror'), binding, first.cursor, stateDir);
    expect(second.error).toBeUndefined();
    const titles = (await readCorpus(env.artifactsDir, 'data/echo')).map(
      (r) => r.frontmatter.title,
    );
    expect(titles.sort()).toEqual(['Alpha', 'Gamma']);
  });

  it('a refused credential asks for a reconnect, without the credential in the message', async () => {
    env = await createConnectorTestEnv();
    const binding: ConnectorBindingRef = {
      id: 'echo:3',
      type: 'echo-trigger',
      config: { baseUrl: base },
    };
    await env.storeCredential(binding, 'wrong-key-0123456789');
    const result = await sync(
      typeFor('trigger', 'window'),
      binding,
      undefined,
      join(env.root, 's3'),
    );
    expect(result.error).toMatch(/Reconnect it/);
    expect(result.error).not.toContain('wrong-key-0123456789');
  });

  it('replays recordings with the network denied', async () => {
    env = await createConnectorTestEnv();
    const binding: ConnectorBindingRef = {
      id: 'echo:4',
      type: 'echo-action',
      config: { baseUrl: 'https://api.example.com' },
    };
    await env.storeCredential(binding, KEY);
    const type = typeFor('action', 'mirror');
    (type.source as { origins: string[] }).origins = ['https://api.example.com'];
    const components = new ComponentStore({ home: join(env.root, 'home'), registry: registry.url });
    const replay = new SpectralReplay([
      {
        kind: 'http',
        request: { method: 'GET', url: 'https://api.example.com/items' },
        response: { status: 200, body: { items: [{ id: 'r1', title: 'Recorded' }] } },
      },
    ]);
    const result = await syncWithAdapter<SpectralComponentCursor, NormalizedRecord>(
      new SpectralComponentAdapter(
        type,
        binding,
        env.deps({ components, stateDir: join(env.root, 's4'), spectralReplay: replay }),
      ),
      {
        storageDir: env.artifactsDir,
        quarantineDir: env.quarantineDir,
        corpusDir: 'data/echo',
        backfillLimit: 10,
        cursor: undefined,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.written).toBe(1);
    expect(replay.unused()).toBe(0);
  });
});
