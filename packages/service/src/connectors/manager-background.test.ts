import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type GezelConfig, SECURITY_PRESETS } from '@bendyline/gezel';
import type { SecretStore } from '@bendyline/gezel-inference/internal/secrets/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Store } from '../fs/store.js';
import { ConnectorManager, ConnectorPolicyError } from './manager.js';
import { registerNativeAdapter } from './registry.js';
import type { ChangeBatch, ConnectorAdapter, NormalizedRecord, RecordRef } from './types.js';

/** How many records a pass of the deferring fake has written, across passes. */
let deferringWritten = 0;

registerNativeAdapter('bg-reader', async (): Promise<ConnectorAdapter> => adapter('r'));
// Writes one record per pass and says more is due, three times.
registerNativeAdapter('bg-deferring', async (): Promise<ConnectorAdapter> => {
  const n = ++deferringWritten;
  return {
    ...adapter(`d${n}`),
    listChangesSince: async (): Promise<ChangeBatch<unknown>> => ({
      records: [{ id: `d${n}`, ordinalKey: 1 }],
      cursor: `C${n}`,
      ...(n < 3 ? { deferred: true } : {}),
    }),
  };
});

function adapter(id: string): ConnectorAdapter {
  return {
    typeId: 'bg',
    ensureAuth: async () => {},
    listScopes: async () => [''],
    listChangesSince: async () => ({ records: [{ id, ordinalKey: 1 }], cursor: 'C' }),
    fetchRecord: async (_scope: string, ref: RecordRef): Promise<NormalizedRecord> => ({
      recordId: ref.id,
      dirSegments: [],
      fileStem: ref.id,
      frontmatter: { title: ref.id, direction: 'inbound' },
      bodyMarkdown: `body ${ref.id}`,
      scanOrigin: 'test',
      quarantineNamespace: 'bg',
      quarantineLabel: 'Record',
    }),
    close: async () => {},
  };
}

function manifest(
  id: string,
  adapterId: string,
  actions: { name: string; consentScope: string }[] = [],
) {
  return {
    schemaVersion: 1 as const,
    kind: 'connector-type' as const,
    id,
    name: id,
    description: '',
    tags: [],
    maintainer: { name: 'x' },
    version: '1.0.0',
    releasedAt: '2026-01-01T00:00:00Z',
    driver: 'native' as const,
    source: { adapterId },
    normalize: { kind: 'native' as const },
    actions,
    availableVersions: ['1.0.0'],
  };
}

const MANIFESTS: Record<string, ReturnType<typeof manifest>> = {
  reader: manifest('reader', 'bg-reader'),
  sender: manifest('sender', 'bg-reader', [{ name: 'send', consentScope: 'recipient-allowlist' }]),
  deferring: manifest('deferring', 'bg-deferring'),
};

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'gezel-conn-bg-'));
  deferringWritten = 0;
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

function harness(level: 'free' | 'lockdown' | 'super-lockdown') {
  let project = {
    id: 'p1',
    connectors: [
      { id: 'reader:1', type: 'reader', config: {} },
      { id: 'sender:1', type: 'sender', config: {} },
      { id: 'deferring:1', type: 'deferring', config: {} },
    ] as { id: string; type: string; config: Record<string, unknown>; lastSyncedAt?: string }[],
  };
  const config = {
    securityPolicy: { level, ...SECURITY_PRESETS[level] },
  } as unknown as GezelConfig;
  const store = {
    getProject: async () => project,
    updateProject: async (_id: string, patch: Partial<typeof project>) => {
      project = { ...project, ...patch };
      return project;
    },
    readConfig: async () => config,
    homePath: join(ws, 'home'),
    projectWorkspaceDir: async () => ws,
    projectArtifactsDir: () => join(ws, 'artifacts'),
    projectQuarantineDir: () => join(ws, 'private', 'quarantine'),
    get historyManager() {
      return undefined;
    },
  } as unknown as Store;
  const secrets = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    has: async () => false,
  } as unknown as SecretStore;
  const catalog = {
    get: async (_kind: string, id: string) => ({ manifest: MANIFESTS[id], sourceId: 'bundled' }),
  } as unknown as ConstructorParameters<typeof ConnectorManager>[0]['catalog'];
  const mgr = new ConnectorManager({ store, secrets, catalog, continuationDelayMs: 5 });
  return { mgr, project: () => project };
}

describe('background sync eligibility', () => {
  it('at Lockdown, syncs read-only connections and holds back ones that can send', async () => {
    const h = harness('lockdown');
    const policy = { allowConnectorData: true, allowExternalServices: false };
    const ids = (await h.mgr.backgroundBindings(h.project() as never, policy)).map((b) => b.id);
    expect(ids).toEqual(['reader:1', 'deferring:1']);
  });

  it('at Unrestricted, syncs everything; with App network off, nothing', async () => {
    const h = harness('free');
    const all = await h.mgr.backgroundBindings(h.project() as never, {
      allowConnectorData: true,
      allowExternalServices: true,
    });
    expect(all).toHaveLength(3);
    const none = await h.mgr.backgroundBindings(h.project() as never, {
      allowConnectorData: false,
      allowExternalServices: false,
    });
    expect(none).toHaveLength(0);
  });

  it('a background pass under a policy skips the bindings it holds back', async () => {
    const h = harness('lockdown');
    await h.mgr.syncProject(h.project() as never, {
      policy: { allowConnectorData: true, allowExternalServices: false },
    });
    const synced = h
      .project()
      .connectors.filter((b) => b.lastSyncedAt)
      .map((b) => b.id);
    expect(synced).toContain('reader:1');
    expect(synced).not.toContain('sender:1');
  });
});

describe('the policy at the sink', () => {
  it('refuses a person’s sync when App network is off', async () => {
    const h = harness('super-lockdown');
    await expect(h.mgr.syncBinding(h.project() as never, 'reader:1')).rejects.toBeInstanceOf(
      ConnectorPolicyError,
    );
  });
});

describe('follow-up passes', () => {
  it('keeps going after a person’s pass that said more is due, then stops', async () => {
    const h = harness('lockdown');
    const first = await h.mgr.syncBinding(h.project() as never, 'deferring:1');
    expect(first.deferred).toBe(true);
    expect(h.mgr.isContinuing('deferring:1')).toBe(true);
    for (let i = 0; i < 100 && h.mgr.isContinuing('deferring:1'); i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(h.mgr.isContinuing('deferring:1')).toBe(false);
    expect(deferringWritten).toBe(3);
    const files = await readdir(join(ws, 'artifacts', 'data', 'deferring'));
    expect(files.filter((f) => f.endsWith('.md'))).toHaveLength(3);
  });

  it('stops follow-ups when passes are cancelled', async () => {
    const h = harness('lockdown');
    await h.mgr.syncBinding(h.project() as never, 'deferring:1');
    h.mgr.cancelPasses({ bindingId: 'deferring:1' }, 'paused');
    await new Promise((r) => setTimeout(r, 60));
    expect(h.mgr.isContinuing('deferring:1')).toBe(false);
    expect(deferringWritten).toBe(1);
  });
});
