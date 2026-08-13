import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import type { SecretStore } from '../secrets/types.js';
import { ConnectorManager, resolveDeclaredOrigins } from './manager.js';
import { registerNativeAdapter } from './registry.js';
import type { ConnectorAdapter, NormalizedRecord, RecordRef } from './types.js';

// A fake native adapter that emits one record on the single scope.
registerNativeAdapter(
  'fake-native',
  async (): Promise<ConnectorAdapter> => ({
    typeId: 'fake',
    ensureAuth: async () => {},
    listScopes: async () => [''],
    listChangesSince: async () => ({ records: [{ id: 'r1', ordinalKey: 1 }], cursor: 'C1' }),
    fetchRecord: async (_scope: string, ref: RecordRef): Promise<NormalizedRecord> => ({
      recordId: ref.id,
      dirSegments: ['scope'],
      fileStem: 'rec',
      frontmatter: { title: 'hi', direction: 'inbound' },
      bodyMarkdown: 'body text',
      scanOrigin: 'email',
      quarantineNamespace: 'fake',
      quarantineLabel: 'Record',
    }),
    close: async () => {},
  }),
);

const MANIFEST = {
  schemaVersion: 1 as const,
  kind: 'connector-type' as const,
  id: 'fake-conn',
  name: 'Fake',
  description: '',
  tags: [],
  maintainer: { name: 'x' },
  version: '1.0.0',
  releasedAt: '2026-01-01T00:00:00Z',
  driver: 'native' as const,
  source: { adapterId: 'fake-native' },
  normalize: { kind: 'native' as const },
  actions: [],
  availableVersions: ['1.0.0'],
};

interface FakeProject {
  id: string;
  connectors?: {
    id: string;
    type: string;
    displayName?: string;
    corpusDir?: string;
    cursor?: unknown;
    lastSyncedAt?: string;
  }[];
  grantedCredentials?: string[];
  credentialAllowedOrigins?: Record<string, string[]>;
}
type SecretKeyLike = { toolsetId: string; fieldId: string };

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'gezel-conn-'));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

function harness(extra?: {
  scriptRunner?: ConstructorParameters<typeof ConnectorManager>[0]['scriptRunner'];
}) {
  let project: FakeProject = { id: 'p1' };
  const store = {
    getProject: async () => project,
    updateProject: async (_id: string, patch: Partial<FakeProject>) => {
      project = { ...project, ...patch };
      return project;
    },
    projectWorkspaceDir: async () => ws,
    projectArtifactsDir: () => join(ws, 'artifacts'),
    get historyManager() {
      return undefined;
    },
  } as unknown as Store;

  const secretMap = new Map<string, string>();
  const key = (k: SecretKeyLike) => `${k.toolsetId}:${k.fieldId}`;
  const secrets = {
    get: async (k: SecretKeyLike) => secretMap.get(key(k)) ?? null,
    set: async (k: SecretKeyLike, v: string) => {
      secretMap.set(key(k), v);
    },
    delete: async (k: SecretKeyLike) => {
      secretMap.delete(key(k));
    },
    has: async (k: SecretKeyLike) => secretMap.has(key(k)),
  } as unknown as SecretStore;

  const catalog = {
    get: async () => ({ manifest: MANIFEST, sourceId: 'bundled' }),
  } as unknown as ConstructorParameters<typeof ConnectorManager>[0]['catalog'];
  const mgr = new ConnectorManager({ store, secrets, catalog, ...(extra ?? {}) });
  return { mgr, secretMap, getProject: () => project };
}

describe('resolveDeclaredOrigins', () => {
  it('resolves literals, $config paths, dedupes, and drops invalid entries', () => {
    const origins = resolveDeclaredOrigins(
      {
        id: 't',
        allowedOrigins: [
          'https://api.github.com',
          'https://api.github.com/',
          '$config.api.baseUrl',
          '$config.missing',
          'http://plain.example',
          'https://user:pw@evil.example',
          'https://path.example/api',
          'not-a-url',
        ],
      },
      { api: { baseUrl: 'https://ghe.corp.example' } },
    );
    expect(origins).toEqual(['https://api.github.com', 'https://ghe.corp.example']);
  });

  it('returns empty for an undeclared manifest', () => {
    expect(resolveDeclaredOrigins({ id: 't' }, {})).toEqual([]);
  });
});

describe('ConnectorManager', () => {
  it('binds a connector: stores the credential in the SecretStore, not on the project', async () => {
    const h = harness();
    const binding = await h.mgr.bind(h.getProject() as never, {
      type: 'fake-conn',
      config: { a: 1 },
      credential: '{"token":"secret"}',
    });
    expect(binding.id.startsWith('fake-conn:')).toBe(true);
    expect(h.secretMap.get(`connector-fake-conn:${binding.id}`)).toBe('{"token":"secret"}');
    const stored = h.getProject().connectors?.[0];
    expect(stored?.id).toBe(binding.id);
    expect(binding).toMatchObject({ sourceId: 'bundled', version: '1.0.0' });
    expect(stored && 'credential' in stored).toBe(false);
  });

  it('syncs a binding through the native adapter and writes a normalized record', async () => {
    const h = harness();
    const binding = await h.mgr.bind(h.getProject() as never, {
      type: 'fake-conn',
      credential: '{}',
    });
    const r = await h.mgr.syncBinding(h.getProject() as never, binding.id);
    expect(r.written).toBe(1);
    expect(r.errors).toBe(0);
    const stored = h.getProject().connectors?.[0];
    expect(stored?.cursor).toEqual({ v: 2, scopes: { '': 'C1' } });
    expect(stored?.lastSyncedAt).toBeTruthy();
    const corpus = await readdir(join(ws, 'artifacts', 'data', 'fake-conn', 'scope'));
    expect(corpus.some((name) => name.endsWith('.md'))).toBe(true);
  });

  it('grants a script connector its binding credential even when no token is stored', async () => {
    const h = harness();
    (MANIFEST as { driver: string }).driver = 'script';
    try {
      const binding = await h.mgr.bind(h.getProject() as never, {
        type: 'fake-conn',
      });
      expect(h.getProject().grantedCredentials).toEqual([`connector-fake-conn.${binding.id}`]);
      expect(h.secretMap.size).toBe(0);
    } finally {
      (MANIFEST as { driver: string }).driver = 'native';
    }
  });

  it('bind writes the declared origin allowlist for a script connector; unbind removes it', async () => {
    const h = harness();
    const m = MANIFEST as { driver: string; allowedOrigins?: string[] };
    m.driver = 'script';
    m.allowedOrigins = [
      'https://api.github.com',
      '$config.apiBaseUrl',
      '$config.unsetOptional',
      'http://insecure.example',
    ];
    try {
      const binding = await h.mgr.bind(h.getProject() as never, {
        type: 'fake-conn',
        config: { apiBaseUrl: 'https://ghe.corp.example' },
      });
      const credName = `connector-fake-conn.${binding.id}`;
      // Literal + resolved $config origins land; the unset placeholder and
      // the non-https literal are dropped, never written.
      expect(h.getProject().credentialAllowedOrigins).toEqual({
        [credName]: ['https://api.github.com', 'https://ghe.corp.example'],
      });

      await h.mgr.unbind(h.getProject() as never, binding.id);
      expect(h.getProject().credentialAllowedOrigins).toEqual({});
    } finally {
      m.driver = 'native';
      delete m.allowedOrigins;
    }
  });

  it('native connectors never write origin allowlist entries', async () => {
    const h = harness();
    const m = MANIFEST as { allowedOrigins?: string[] };
    m.allowedOrigins = ['https://api.example.test'];
    try {
      await h.mgr.bind(h.getProject() as never, { type: 'fake-conn', credential: '{}' });
      expect(h.getProject().credentialAllowedOrigins).toBeUndefined();
    } finally {
      delete m.allowedOrigins;
    }
  });

  it('sync heals a missing origin entry for an existing script binding', async () => {
    const scriptRunner = {
      run: async () => ({ status: 'ok', output: { records: [], cursor: null } }),
    } as unknown as NonNullable<Parameters<typeof harness>[0]>['scriptRunner'];
    const h = harness({ scriptRunner });
    const m = MANIFEST as { driver: string; allowedOrigins?: string[]; source: unknown };
    const priorSource = m.source;
    m.driver = 'script';
    m.allowedOrigins = ['https://api.github.com'];
    m.source = { inlineFetch: 'gezel.output({ records: [] });' };
    try {
      const binding = await h.mgr.bind(h.getProject() as never, { type: 'fake-conn' });
      const credName = `connector-fake-conn.${binding.id}`;
      // Simulate a binding created before the type declared origins.
      delete h.getProject().credentialAllowedOrigins;

      await h.mgr.syncBinding(h.getProject() as never, binding.id);
      expect(h.getProject().credentialAllowedOrigins).toEqual({
        [credName]: ['https://api.github.com'],
      });
    } finally {
      m.driver = 'native';
      delete m.allowedOrigins;
      m.source = priorSource;
    }
  });

  it('unbinds: removes the binding and its stored credential', async () => {
    const h = harness();
    const binding = await h.mgr.bind(h.getProject() as never, {
      type: 'fake-conn',
      credential: '{}',
    });
    await h.mgr.unbind(h.getProject() as never, binding.id);
    expect(h.getProject().connectors).toEqual([]);
    expect(h.secretMap.has(`connector-fake-conn:${binding.id}`)).toBe(false);
  });

  it('resolves corpusDir at bind time from displayName, with collision suffixes', async () => {
    const h = harness();
    const a = await h.mgr.bind(h.getProject() as never, {
      type: 'fake-conn',
      displayName: 'Work Data',
    });
    const b = await h.mgr.bind(h.getProject() as never, {
      type: 'fake-conn',
      displayName: 'Work Data',
    });
    const c = await h.mgr.bind(h.getProject() as never, { type: 'fake-conn' });
    expect(a.corpusDir).toBe('data/work-data');
    expect(b.corpusDir).toBe('data/work-data-2');
    expect(c.corpusDir).toBe('data/fake-conn');
  });

  it('lazily resolves + persists corpusDir for a pre-corpusDir binding and writes _meta.json', async () => {
    const h = harness();
    const binding = await h.mgr.bind(h.getProject() as never, {
      type: 'fake-conn',
      credential: '{}',
    });
    // Simulate a binding created before corpusDir existed.
    const project = h.getProject();
    project.connectors = project.connectors?.map(({ corpusDir: _drop, ...rest }) => rest);
    const r = await h.mgr.syncBinding(h.getProject() as never, binding.id);
    expect(r.written).toBe(1);
    const stored = h.getProject().connectors?.[0] as { corpusDir?: string };
    expect(stored?.corpusDir).toBe('data/fake-conn');
    const meta = JSON.parse(
      await readFile(join(ws, 'artifacts', 'data', 'fake-conn', '_meta.json'), 'utf8'),
    );
    expect(meta).toMatchObject({
      binding: binding.id,
      type: 'fake-conn',
      completeness: 'mirror',
      scopes: [''],
    });
    expect(meta.lastSyncedAt).toBeTruthy();
  });

  it('moves a legacy workspace corpus into artifacts before syncing', async () => {
    const h = harness();
    const binding = await h.mgr.bind(h.getProject() as never, {
      type: 'fake-conn',
      credential: '{}',
    });
    const legacy = join(ws, 'data', 'fake-conn');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'legacy.md'), 'already fetched');

    await h.mgr.syncBinding(h.getProject() as never, binding.id);

    await expect(
      readFile(join(ws, 'artifacts', 'data', 'fake-conn', 'legacy.md'), 'utf8'),
    ).resolves.toBe('already fetched');
    await expect(readFile(join(legacy, 'legacy.md'), 'utf8')).rejects.toThrow();
  });

  it('rejects a bind whose config fails the configSchema', async () => {
    const h = harness();
    (MANIFEST as { configSchema?: unknown }).configSchema = {
      type: 'object',
      properties: { owner: { type: 'string' } },
      required: ['owner'],
    };
    try {
      await expect(h.mgr.bind(h.getProject() as never, { type: 'fake-conn' })).rejects.toThrow(
        /invalid fake-conn configuration: owner: required/,
      );
      expect(h.getProject().connectors ?? []).toHaveLength(0);
    } finally {
      (MANIFEST as { configSchema?: unknown }).configSchema = undefined;
    }
  });

  it('rejects a sync for an unknown driver', async () => {
    const h = harness();
    const binding = await h.mgr.bind(h.getProject() as never, {
      type: 'fake-conn',
      credential: '{}',
    });
    (MANIFEST as { driver: string }).driver = 'bogus';
    const r = await h.mgr.syncBinding(h.getProject() as never, binding.id);
    expect(r.errors).toBe(1);
    expect(r.error).toContain('unknown connector driver');
    (MANIFEST as { driver: string }).driver = 'native';
  });
});
