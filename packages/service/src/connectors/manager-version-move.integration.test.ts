import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { securityPolicyForLevel } from '@bendyline/gezel';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { FileSecretStore } from '../secrets/file-store.js';
import { ConnectorManager } from './manager.js';
import { registerNativeAdapter } from './registry.js';

/**
 * A binding pins its type version at bind time; a newer compatible version
 * of the type reaches it on its next sync, and an incompatible one does not.
 */

function manifest(version: string, configSchema?: Record<string, unknown>) {
  return {
    schemaVersion: 1 as const,
    kind: 'connector-type' as const,
    id: 'move-fake',
    name: 'Move fake',
    description: '',
    tags: [],
    maintainer: { name: 'x' },
    version,
    releasedAt: '2026-01-01T00:00:00Z',
    driver: 'native' as const,
    source: { adapterId: 'move-fake' },
    normalize: { kind: 'native' as const },
    actions: [],
    completeness: 'window' as const,
    ...(configSchema ? { configSchema } : {}),
  };
}

/** A catalog holding `versions`, newest last; no version asked = the newest. */
function catalogOf(versions: ReturnType<typeof manifest>[]) {
  return {
    get: async (_kind: string, _id: string, _source?: string, version?: string) => {
      const m = version ? versions.find((v) => v.version === version) : versions.at(-1);
      return m ? { manifest: m, sourceId: 'bundled' } : null;
    },
    listVersions: async () => versions.map((v) => ({ version: v.version })),
  } as unknown as ConstructorParameters<typeof ConnectorManager>[0]['catalog'];
}

let home: string | null = null;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  home = null;
});

async function setup(versions: ReturnType<typeof manifest>[]) {
  registerNativeAdapter('move-fake', async () => ({
    typeId: 'move-fake',
    ensureAuth: async () => {},
    listScopes: async () => [''],
    listChangesSince: async (_s: string, cursor: unknown) => ({ records: [], cursor }),
    fetchRecord: async () => {
      throw new Error('no records');
    },
    close: async () => {},
  }));
  home = await mkdtemp(join(tmpdir(), 'gezel-move-'));
  const store = new Store({ home });
  await store.ensureLayout();
  await store.writeConfig({ securityPolicy: securityPolicyForLevel('free') });
  const project = await store.createProject({ name: 'Move' });
  const catalog = { versions };
  const connectors = new ConnectorManager({
    store,
    secrets: new FileSecretStore(home),
    catalog: catalogOf(catalog.versions),
  });
  const binding = await connectors.bind(project, {
    type: 'move-fake',
    version: '1.0.0',
    sourceId: 'bundled',
    config: { region: 'eu' },
  });
  const versionNow = async () =>
    (await store.getProject(project.id))!.connectors!.find((b) => b.id === binding.id)!.version;
  return { store, project, connectors, binding, catalog, versionNow };
}

describe('connector type updates reach existing connections', () => {
  it('moves to the newest version of the same major whose settings still fit', async () => {
    const versions = [manifest('1.0.0')];
    const s = await setup(versions);
    // 2.0.0 is a new major and is never crossed; 1.2.0 is the newest 1.x.
    versions.push(manifest('1.1.0'), manifest('1.2.0'), manifest('2.0.0'));
    const r = await s.connectors.syncBinding(s.project, s.binding.id);
    expect(r.error).toBeUndefined();
    expect(await s.versionNow()).toBe('1.2.0');
  });

  it('never crosses a major', async () => {
    const versions = [manifest('1.0.0')];
    const s = await setup(versions);
    versions.push(manifest('2.0.0'));
    await s.connectors.syncBinding(s.project, s.binding.id);
    expect(await s.versionNow()).toBe('1.0.0');
  });

  it('stays when the newer version does not accept the settings', async () => {
    const versions = [manifest('1.0.0')];
    const s = await setup(versions);
    versions.push(
      manifest('1.1.0', {
        type: 'object',
        required: ['region', 'tenant'],
        properties: { region: { type: 'string' }, tenant: { type: 'string' } },
      }),
    );
    await s.connectors.syncBinding(s.project, s.binding.id);
    expect(await s.versionNow()).toBe('1.0.0');
  });
});
