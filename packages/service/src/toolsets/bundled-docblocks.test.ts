/** Product-shipped DocBlocks must satisfy launch checks in an empty, offline home. */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  InstalledToolsetSchema,
  isTrustedConstrainedToolset,
  unmetToolsets,
} from '@bendyline/gezel';
import { afterEach, expect, it, vi } from 'vitest';
import { installedToolsetIds } from '../craftbook/applicable.js';
import { Store } from '../fs/store.js';
import type { ServiceContext } from '../http/context.js';
import { catalogRoutes } from '../http/routes/catalog.js';
import { bundledDocblocksToolset } from './bundled-docblocks.js';

let home: string;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

it('resolves the exact service dependency as a trusted, root-confined MCP runtime', async () => {
  const entry = bundledDocblocksToolset();
  expect(InstalledToolsetSchema.parse(entry)).toEqual(entry);
  expect(isTrustedConstrainedToolset(entry)).toBe(true);
  const pkg = JSON.parse(
    await readFile(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
  );
  expect(entry.version).toBe(pkg.dependencies['@bendyline/docblocks-cli']);
  expect(entry.runtime).toMatchObject({ entry: 'dist/bin.js', args: ['mcp'] });
});

it('is available without an install record and survives system roster updates', async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-bundled-docblocks-'));
  const bundled = bundledDocblocksToolset();
  const store = new Store({ home, bundledToolsets: [bundled] });
  expect(await store.listInstalledToolsets({ kind: 'shared' })).toEqual([]);
  expect(await store.listInstalledToolsets({ kind: 'system' })).toEqual([bundled]);
  expect(
    unmetToolsets(
      [{ toolsetId: 'docblocks', sourceId: 'bundled' }],
      await installedToolsetIds(store),
    ),
  ).toEqual([]);
  await store.writeInstalledToolsets({ kind: 'system' }, []);
  expect(await store.listInstalledToolsets({ kind: 'system' })).toEqual([bundled]);
  await store.writeInstalledToolsets({ kind: 'system' }, [
    { ...bundled, version: 'old', installPath: '/stale' },
  ]);
  expect(await store.listInstalledToolsets({ kind: 'system' })).toEqual([bundled]);
  const bareStore = new Store({ home });
  expect(await bareStore.listInstalledToolsets({ kind: 'system' })).toEqual([]);
});

it('never exposes product tools to the machine engine broker', async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-engine-no-docblocks-'));
  const store = new Store({
    home,
    serviceRole: 'machine-engine',
    bundledToolsets: [bundledDocblocksToolset()],
  });
  expect(await store.listInstalledToolsets({ kind: 'system' })).toEqual([]);
});

it('returns the shipped runtime for install requests and refuses to remove it', async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-docblocks-install-api-'));
  const bundled = bundledDocblocksToolset();
  const store = new Store({ home, bundledToolsets: [bundled] });
  const get = vi.fn();
  const app = catalogRoutes({ store, catalog: { get } } as unknown as ServiceContext);
  const install = await app.request('/toolset/docblocks/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: { kind: 'shared' } }),
  });
  expect(install.status).toBe(200);
  expect(await install.json()).toEqual({ ok: true, installed: bundled });
  expect(get).not.toHaveBeenCalled();
  expect(await store.listInstalledToolsets({ kind: 'shared' })).toEqual([]);
  const remove = await app.request('/toolset/docblocks/install?scope=system', { method: 'DELETE' });
  expect(remove.status).toBe(400);
  expect(await store.listInstalledToolsets({ kind: 'system' })).toEqual([bundled]);
});

// 1.26300.100: a craftbook launch asked for the catalog's pinned 2.7.0, which
// skipped the shortcut above and put a 351 MB older copy into the project.
it('satisfies a versioned project install it is at least as new as', async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-docblocks-versioned-install-'));
  const bundled = bundledDocblocksToolset();
  const store = new Store({ home, bundledToolsets: [bundled] });
  const project = await store.createProject({ name: 'Decks' });
  const get = vi.fn(async () => null);
  const app = catalogRoutes({ store, catalog: { get } } as unknown as ServiceContext);
  const request = (version: string) =>
    app.request('/toolset/docblocks/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: { kind: 'project', projectId: project.id },
        version,
        sourceId: 'bundled',
      }),
    });
  for (const version of ['2.7.0', bundled.version]) {
    const res = await request(version);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, installed: bundled });
  }
  expect(get).not.toHaveBeenCalled();
  expect(await store.listInstalledToolsets({ kind: 'project', projectId: project.id })).toEqual([]);
  // A newer catalog version is a real install, not the shipped copy.
  await request('99.0.0');
  expect(get).toHaveBeenCalledWith('toolset', 'docblocks', 'bundled', '99.0.0');
});

it('supersedes only copies of a shipped toolset at its version or older', async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-docblocks-supersedes-'));
  const bundled = bundledDocblocksToolset();
  const store = new Store({ home, bundledToolsets: [bundled] });
  expect(store.bundledToolsetSupersedes('docblocks', '2.7.0')).toBe(true);
  expect(store.bundledToolsetSupersedes('docblocks', bundled.version)).toBe(true);
  expect(store.bundledToolsetSupersedes('docblocks', '99.0.0')).toBe(false);
  expect(store.bundledToolsetSupersedes('docblocks', 'old')).toBe(false);
  expect(store.bundledToolsetSupersedes('playwright', '0.0.1')).toBe(false);
});
