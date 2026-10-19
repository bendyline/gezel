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
