import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import type { SecretStore } from '../secrets/types.js';
import { ConnectorManager } from './manager.js';
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
  connectors?: { id: string; type: string; cursor?: unknown; lastSyncedAt?: string }[];
  grantedCredentials?: string[];
}
type SecretKeyLike = { toolsetId: string; fieldId: string };

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'gezel-conn-'));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

function harness() {
  let project: FakeProject = { id: 'p1' };
  const store = {
    getProject: async () => project,
    updateProject: async (_id: string, patch: Partial<FakeProject>) => {
      project = { ...project, ...patch };
      return project;
    },
    projectWorkspaceDir: async () => ws,
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
  const mgr = new ConnectorManager({ store, secrets, catalog });
  return { mgr, secretMap, getProject: () => project };
}

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
    expect(stored?.cursor).toBe('C1');
    expect(stored?.lastSyncedAt).toBeTruthy();
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
