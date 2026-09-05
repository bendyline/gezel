import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as atomic from './atomic.js';
import { ConfigStore } from './config-store.js';
import { Store } from './store.js';

let home: string;
let store: Store;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-config-'));
  store = new Store({ home });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(home, { recursive: true, force: true });
});

describe('config patches', () => {
  it.each(['same store', 'another store'] as const)(
    'preserves disjoint concurrent patches through %s',
    async (writer) => {
      const other =
        writer === 'same store' ? store : new Store({ home: relative(process.cwd(), home) });
      const staged = deferred();
      const release = deferred();
      const writeAtomic = atomic.writeFileAtomic;
      vi.spyOn(atomic, 'writeFileAtomic').mockImplementationOnce(async (...args) => {
        staged.resolve();
        await release.promise;
        return writeAtomic(...args);
      });

      const first = store.writeConfig({ provider: 'openai' });
      await staged.promise;
      const read = vi.spyOn(ConfigStore.prototype, 'readConfig');
      const second = other.writeConfig({ debugMode: true });
      try {
        // The second patch must read the first patch's committed value,
        // even when the first atomic replacement is delayed by the disk.
        expect(read).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await Promise.allSettled([first, second]);
      }

      await expect(first).resolves.toEqual({ provider: 'openai' });
      await expect(second).resolves.toEqual({ provider: 'openai', debugMode: true });
      expect(await store.readConfig()).toEqual({ provider: 'openai', debugMode: true });
    },
  );

  it('merges concurrent external-folder and ambient-dashboard patches', async () => {
    const other = new Store({ home });
    const documents = join(home, 'documents');
    const projects = join(home, 'projects');
    const displayTarget = {
      width: 1920,
      height: 1080,
      safeArea: { x: 0, y: 0, width: 1920, height: 1080 },
    };
    await Promise.all([
      store.writeConfig({ externalFolders: { documents }, ambientDashboard: { enabled: true } }),
      other.writeConfig({ externalFolders: { projects }, ambientDashboard: { displayTarget } }),
    ]);

    expect(await store.readConfig()).toEqual({
      externalFolders: { documents, projects },
      ambientDashboard: { enabled: true, displayTarget },
    });
  });

  it.each([
    { provider: 'not-a-provider' },
    { externalFolders: { documents: '' } },
    { externalFolders: 42 },
    { externalFolders: [] },
    { ambientDashboard: { intervalMinutes: 1 } },
    { ambientDashboard: false },
    { ambientDashboard: 'invalid' },
  ])('rejects invalid patch %j without replacing the original bytes', async (patch) => {
    const configPath = join(home, 'config.json');
    const original = '{ "provider": "openai", "debugMode": false }\n';
    await writeFile(configPath, original);

    await expect(store.writeConfig(patch)).rejects.toThrow();
    expect(await readFile(configPath, 'utf8')).toBe(original);
    expect(await store.readConfig()).toEqual({ provider: 'openai', debugMode: false });
    // Validation failure must not poison later writes for this path.
    await expect(store.writeConfig({ debugMode: true })).resolves.toEqual({
      provider: 'openai',
      debugMode: true,
    });
  });

  it('continues queued patches after an atomic write fails', async () => {
    await store.writeConfig({ provider: 'openai' });
    const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    vi.spyOn(atomic, 'writeFileAtomic').mockRejectedValueOnce(failure);

    const results = await Promise.allSettled([
      store.writeConfig({ provider: 'anthropic' }),
      store.writeConfig({ debugMode: true }),
    ]);

    expect(results[0]).toEqual({ status: 'rejected', reason: failure });
    expect(results[1]).toEqual({
      status: 'fulfilled',
      value: { provider: 'openai', debugMode: true },
    });
    expect(await store.readConfig()).toEqual({ provider: 'openai', debugMode: true });
  });

  it('preserves top-level resets and per-scope external-folder deletion', async () => {
    const projects = join(home, 'projects');
    await store.writeConfig({
      provider: 'openai',
      externalFolders: { projects, documents: join(home, 'documents') },
      ambientDashboard: { enabled: true, intervalMinutes: 60 },
    });
    await Promise.all([
      store.writeConfig({ provider: null, externalFolders: { documents: null } }),
      store.writeConfig({ debugMode: true, ambientDashboard: { enabled: false } }),
    ]);
    expect(await store.readConfig()).toEqual({
      debugMode: true,
      externalFolders: { projects },
      ambientDashboard: { enabled: false, intervalMinutes: 60 },
    });

    await store.writeConfig({ externalFolders: { projects: null }, ambientDashboard: null });
    expect(await store.readConfig()).toEqual({ debugMode: true });
    await store.writeConfig({ externalFolders: { projects } });
    await store.writeConfig({ externalFolders: null, debugMode: null });
    expect(await store.readConfig()).toEqual({});
  });

  it('persists and returns the schema-normalized config', async () => {
    const result = await store.writeConfig({ fileReviews: {} });
    expect(result).toEqual({ fileReviews: { enabled: true } });
    expect(JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))).toEqual(result);
    expect(await store.readConfig()).toEqual(result);
  });
});
