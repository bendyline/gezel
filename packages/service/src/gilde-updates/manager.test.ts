import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gildeLiveStateFile,
  gildeLiveVersionDir,
  gildeLiveVersionsDir,
} from '@bendyline/gezel/paths';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../fs/store.js';
import { HistoryManager } from '../history/manager.js';
import { GildeUpdateManager } from './manager.js';

const PIN = '0.1.15';

let home: string;
let store: Store;
let history: HistoryManager;
const previousOverride = process.env.GEZEL_GILDE_DATA_DIR;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-gilde-updates-'));
  delete process.env.GEZEL_GILDE_DATA_DIR;
  history = new HistoryManager(home);
  store = new Store({ home, history });
});

afterEach(async () => {
  if (previousOverride === undefined) delete process.env.GEZEL_GILDE_DATA_DIR;
  else process.env.GEZEL_GILDE_DATA_DIR = previousOverride;
  // maxRetries absorbs Windows's transient ENOTEMPTY/EBUSY on freshly-written
  // trees (handles detach a beat after close).
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function writeToolset(dataDir: string, id: string, opts: { broken?: boolean } = {}) {
  const dir = join(dataDir, 'toolsets', id.slice(0, 2), id);
  await mkdir(join(dir, 'versions', '1.0.0'), { recursive: true });
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      kind: 'toolset',
      id,
      name: id,
      description: `${id} fixture`,
      tags: [],
      maintainer: { name: 'Test' },
      yankedVersions: [],
    }),
  );
  const version = opts.broken
    ? '{ not json'
    : JSON.stringify({
        schemaVersion: 1,
        version: '1.0.0',
        releasedAt: '2026-04-22T00:00:00Z',
        runtime: { kind: 'http-mcp', url: 'https://example.com/mcp' },
        tools: [],
        config: [],
      });
  await writeFile(join(dir, 'versions', '1.0.0', 'manifest.json'), version);
}

/** A fixture "bundled" data dir with one toolset the candidate must keep. */
async function makeBundledDataDir(): Promise<string> {
  const dir = join(home, 'bundled-data');
  await writeToolset(dir, 'aa-tool');
  return dir;
}

async function gildeTarball(
  version: string,
  opts: { items?: string[]; broken?: string[]; name?: string } = {},
): Promise<Buffer> {
  const fixture = join(home, `tarball-fixture-${version}-${Math.random().toString(36).slice(2)}`);
  const dataDir = join(fixture, 'package', 'data');
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(fixture, 'package', 'package.json'),
    JSON.stringify({ name: opts.name ?? '@bendyline/gilde', version }),
  );
  for (const id of opts.items ?? ['aa-tool']) await writeToolset(dataDir, id);
  for (const id of opts.broken ?? []) await writeToolset(dataDir, id, { broken: true });
  const archive = join(fixture, 'package.tgz');
  await tar.create({ cwd: fixture, file: archive, gzip: true }, ['package']);
  return readFile(archive);
}

async function serveRegistry(versions: Record<string, Buffer>): Promise<{
  registry: string;
  requests: string[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const decoded = decodeURIComponent(request.url ?? '');
    if (decoded === '/@bendyline/gilde') {
      response.setHeader('Content-Type', 'application/vnd.npm.install-v1+json');
      response.end(
        JSON.stringify({
          versions: Object.fromEntries(
            Object.entries(versions).map(([version, tarball]) => [
              version,
              {
                dist: {
                  tarball: `${origin}/gilde-${version}.tgz`,
                  integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
                },
              },
            ]),
          ),
        }),
      );
      return;
    }
    const match = /^\/gilde-(.+)\.tgz$/.exec(decoded);
    const tarball = match ? versions[match[1] ?? ''] : undefined;
    if (!tarball) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    response.end(tarball);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    registry: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function makeManager(
  opts: { registry?: string; enabled?: boolean; bundledDataDir?: string } = {},
): Promise<GildeUpdateManager> {
  if (opts.enabled !== false) await store.writeConfig({ gildeUpdates: { enabled: true } });
  return GildeUpdateManager.create({
    home,
    store,
    history,
    registry: opts.registry ?? 'http://127.0.0.1:1',
    bundledVersion: PIN,
    bundledDataDir: opts.bundledDataDir ?? (await makeBundledDataDir()),
  });
}

/** Pre-seed a plausible extracted live version + state.json on disk. */
async function seedLiveVersion(version: string, opts: { identity?: string } = {}): Promise<void> {
  const packageDir = join(gildeLiveVersionDir(home, version), 'package');
  await mkdir(join(packageDir, 'data'), { recursive: true });
  await writeFile(
    join(packageDir, 'package.json'),
    JSON.stringify({ name: opts.identity ?? '@bendyline/gilde', version }),
  );
  await writeToolset(join(packageDir, 'data'), 'aa-tool');
  await mkdir(join(home, 'gilde'), { recursive: true });
  await writeFile(
    gildeLiveStateFile(home),
    JSON.stringify({ activeVersion: version, installedAt: '2026-08-01T00:00:00Z' }),
  );
}

async function readHistoryKinds(): Promise<string[]> {
  try {
    const raw = await readFile(join(home, 'history.jsonl'), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { kind: string }).kind);
  } catch {
    return [];
  }
}

describe('GildeUpdateManager.create', () => {
  it('serves bundled content with no state on disk', async () => {
    const bundledDataDir = await makeBundledDataDir();
    const manager = await makeManager({ bundledDataDir });
    expect(manager.mode()).toBe('bundled');
    expect(manager.contentDataDir()).toBe(bundledDataDir);
    expect((await manager.status()).activeVersion).toBeNull();
  });

  it('honors a coherent cached live version', async () => {
    await seedLiveVersion('0.1.16');
    const manager = await makeManager();
    expect(manager.mode()).toBe('live');
    expect(manager.contentDataDir()).toBe(
      join(gildeLiveVersionDir(home, '0.1.16'), 'package', 'data'),
    );
  });

  it('prunes a live version superseded by the bundled pin', async () => {
    await seedLiveVersion(PIN);
    const manager = await makeManager();
    expect(manager.mode()).toBe('bundled');
    await expect(readdir(gildeLiveVersionsDir(home))).rejects.toThrow();
  });

  it('prunes a live version off the pinned minor line', async () => {
    await seedLiveVersion('0.2.0');
    const manager = await makeManager();
    expect(manager.mode()).toBe('bundled');
  });

  it('prunes when the extracted package identity does not match', async () => {
    await seedLiveVersion('0.1.16', { identity: '@bendyline/not-gilde' });
    const manager = await makeManager();
    expect(manager.mode()).toBe('bundled');
  });

  it('prunes when the recorded version dir is missing', async () => {
    await mkdir(join(home, 'gilde'), { recursive: true });
    await writeFile(gildeLiveStateFile(home), JSON.stringify({ activeVersion: '0.1.16' }));
    const manager = await makeManager();
    expect(manager.mode()).toBe('bundled');
  });

  it('prunes leftovers when live updates are disabled', async () => {
    await seedLiveVersion('0.1.16');
    const manager = await makeManager({ enabled: false });
    expect(manager.mode()).toBe('bundled');
    await expect(readdir(gildeLiveVersionsDir(home))).rejects.toThrow();
  });

  it('sweeps interrupted staging dirs', async () => {
    await seedLiveVersion('0.1.16');
    const staging = `${gildeLiveVersionDir(home, '0.1.17')}.staging-123-abc`;
    await mkdir(staging, { recursive: true });
    await makeManager();
    await expect(readdir(staging)).rejects.toThrow();
  });

  it('survives a corrupt state file', async () => {
    await mkdir(join(home, 'gilde'), { recursive: true });
    await writeFile(gildeLiveStateFile(home), 'not json at all');
    const manager = await makeManager();
    expect(manager.mode()).toBe('bundled');
  });
});

describe('GildeUpdateManager.checkNow', () => {
  it('downloads, validates, activates, prunes, and records history', async () => {
    const registry = await serveRegistry({
      '0.1.16': await gildeTarball('0.1.16', { items: ['aa-tool', 'bb-new'] }),
    });
    try {
      const bundledDataDir = await makeBundledDataDir();
      const manager = await makeManager({ registry: registry.registry, bundledDataDir });
      const changed = vi.fn();
      manager.onContentChanged(changed);

      const status = await manager.checkNow('manual');
      expect(status.lastCheck?.outcome).toBe('updated');
      expect(status.activeVersion).toBe('0.1.16');
      expect(status.mode).toBe('live');
      expect(status.updateInProgress).toBe(false);
      expect(manager.contentDataDir()).toBe(
        join(gildeLiveVersionDir(home, '0.1.16'), 'package', 'data'),
      );
      expect(changed).toHaveBeenCalledTimes(1);
      expect(await readdir(gildeLiveVersionsDir(home))).toEqual(['0.1.16']);
      expect(await readHistoryKinds()).toContain('gilde.updated');

      const state = JSON.parse(await readFile(gildeLiveStateFile(home), 'utf8'));
      expect(state.activeVersion).toBe('0.1.16');

      const again = await manager.checkNow('manual');
      expect(again.lastCheck?.outcome).toBe('up-to-date');
      expect(again.activeVersion).toBe('0.1.16');
    } finally {
      await registry.close();
    }
  });

  it('reports up-to-date when the registry has nothing newer', async () => {
    const registry = await serveRegistry({ [PIN]: await gildeTarball(PIN) });
    try {
      const manager = await makeManager({ registry: registry.registry });
      const status = await manager.checkNow('manual');
      expect(status.lastCheck?.outcome).toBe('up-to-date');
      expect(status.mode).toBe('bundled');
    } finally {
      await registry.close();
    }
  });

  it('refuses an update that would drop a resolvable item', async () => {
    const registry = await serveRegistry({
      '0.1.16': await gildeTarball('0.1.16', { items: ['bb-other'] }),
    });
    try {
      const manager = await makeManager({ registry: registry.registry });
      const changed = vi.fn();
      manager.onContentChanged(changed);
      const status = await manager.checkNow('manual');
      expect(status.lastCheck?.outcome).toBe('incompatible');
      expect(status.lastCheck?.regressions).toEqual([{ kind: 'toolset', id: 'aa-tool' }]);
      expect(status.mode).toBe('bundled');
      expect(changed).not.toHaveBeenCalled();
      expect(await readdir(gildeLiveVersionsDir(home))).toEqual([]);
    } finally {
      await registry.close();
    }
  });

  it('records an error and keeps current content when the registry fails', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 404;
      response.end('gone');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const manager = await makeManager({ registry: `http://127.0.0.1:${port}` });
      const status = await manager.checkNow('manual');
      expect(status.lastCheck?.outcome).toBe('error');
      expect(status.mode).toBe('bundled');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('blocks a manual check when updates are disabled', async () => {
    const manager = await makeManager({ enabled: false });
    const status = await manager.checkNow('manual');
    expect(status.lastCheck?.outcome).toBe('blocked');
    expect(status.lastCheck?.message).toMatch(/disabled/);
  });

  it('blocks without touching the network under GEZEL_GILDE_DATA_DIR', async () => {
    const registry = await serveRegistry({ '0.1.16': await gildeTarball('0.1.16') });
    try {
      const manager = await makeManager({ registry: registry.registry });
      process.env.GEZEL_GILDE_DATA_DIR = join(home, 'override-data');
      expect(manager.mode()).toBe('overridden');
      const status = await manager.checkNow('manual');
      expect(status.lastCheck?.outcome).toBe('blocked');
      expect(status.lastCheck?.message).toMatch(/GEZEL_GILDE_DATA_DIR/);
      expect(registry.requests).toEqual([]);
    } finally {
      await registry.close();
    }
  });

  it('blocks under super-lockdown (app network denied), not under default lockdown', async () => {
    const registry = await serveRegistry({ '0.1.16': await gildeTarball('0.1.16') });
    try {
      const manager = await makeManager({ registry: registry.registry });
      await store.writeConfig({
        securityPolicy: {
          level: 'super-lockdown',
          allowFileEdits: false,
          allowExternalChat: false,
          allowExternalServices: false,
          allowScriptExecution: false,
          allowAppNetwork: false,
        },
      });
      const status = await manager.checkNow('manual');
      expect(status.lastCheck?.outcome).toBe('blocked');
      expect(status.lastCheck?.message).toMatch(/security policy/);
      expect(registry.requests).toEqual([]);
    } finally {
      await registry.close();
    }
  });

  it('shares one run between concurrent callers', async () => {
    const registry = await serveRegistry({
      '0.1.16': await gildeTarball('0.1.16', { items: ['aa-tool'] }),
    });
    try {
      const manager = await makeManager({ registry: registry.registry });
      const [a, b] = await Promise.all([manager.checkNow('manual'), manager.checkNow('manual')]);
      expect(a.activeVersion).toBe('0.1.16');
      expect(b.activeVersion).toBe('0.1.16');
      expect(
        registry.requests.filter((u) => decodeURIComponent(u) === '/@bendyline/gilde'),
      ).toHaveLength(1);
    } finally {
      await registry.close();
    }
  });

  it('skips a scheduled check that ran recently, but not a manual one', async () => {
    const registry = await serveRegistry({ [PIN]: await gildeTarball(PIN) });
    try {
      const manager = await makeManager({ registry: registry.registry });
      await manager.checkNow('scheduled');
      expect(registry.requests).toHaveLength(1);
      await manager.checkNow('scheduled');
      expect(registry.requests).toHaveLength(1);
      await manager.checkNow('manual');
      expect(registry.requests).toHaveLength(2);
    } finally {
      await registry.close();
    }
  });
});

describe('GildeUpdateManager.setEnabled', () => {
  it('reverts to bundled immediately and prunes on disable', async () => {
    const registry = await serveRegistry({
      '0.1.16': await gildeTarball('0.1.16', { items: ['aa-tool'] }),
    });
    try {
      const bundledDataDir = await makeBundledDataDir();
      const manager = await makeManager({ registry: registry.registry, bundledDataDir });
      await manager.checkNow('manual');
      expect(manager.mode()).toBe('live');

      const changed = vi.fn();
      manager.onContentChanged(changed);
      await manager.setEnabled(false);
      expect(manager.mode()).toBe('bundled');
      expect(manager.contentDataDir()).toBe(bundledDataDir);
      expect(changed).toHaveBeenCalledTimes(1);
      await expect(readdir(gildeLiveVersionsDir(home))).rejects.toThrow();
    } finally {
      await registry.close();
    }
  });

  it('kicks a background check on enable', async () => {
    const registry = await serveRegistry({
      '0.1.16': await gildeTarball('0.1.16', { items: ['aa-tool'] }),
    });
    try {
      const manager = await makeManager({ registry: registry.registry });
      await manager.setEnabled(true);
      await vi.waitFor(async () => {
        const status = await manager.status();
        expect(status.activeVersion).toBe('0.1.16');
        // Drain the whole background check, not just activation — its tail
        // (pruning, state writes) must not race afterEach's temp-dir removal
        // (Windows surfaces that race as ENOTEMPTY).
        expect(status.updateInProgress).toBe(false);
      });
    } finally {
      await registry.close();
    }
  });
});
