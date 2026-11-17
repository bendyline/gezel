import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpectralComponentPin } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type FakeRegistry,
  type PackedFixture,
  packFixture,
  spectralFixture,
  startFakeRegistry,
} from '../testing/fake-npm-registry.js';
import { ComponentRefusedError, ComponentStore, componentFolderName } from './component-store.js';

const NAME = '@prismatic-io/components-gezel-echo-fixture';
const ENTRY = 'npm-dist/index.cjs';

let home: string;
let registry: FakeRegistry | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-components-'));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await registry?.close();
  registry = undefined;
  await rm(home, { recursive: true, force: true });
});

function pinFor(
  packed: PackedFixture,
  patch: Partial<SpectralComponentPin> = {},
): SpectralComponentPin {
  return {
    name: NAME,
    version: '1.0.0',
    sha256: packed.sha256,
    entry: ENTRY,
    entrySha256: packed.entrySha256,
    spectral: '^10.39.1',
    license: 'Apache-2.0',
    publishedAt: '2026-11-01T00:00:00.000Z',
    ...patch,
  };
}

async function serve(alter?: (dir: string) => Promise<void>): Promise<PackedFixture> {
  const packed = await packFixture(spectralFixture('echo-component'), ENTRY, alter);
  registry = await startFakeRegistry([{ name: NAME, version: '1.0.0', tarball: packed.path }]);
  return packed;
}

function store(extra: Partial<ConstructorParameters<typeof ComponentStore>[0]> = {}) {
  return new ComponentStore({ home, registry: registry!.url, sdkVersion: '10.39.1', ...extra });
}

describe('ComponentStore', () => {
  it('downloads a pinned component once, verified, with nothing installed beside it', async () => {
    const packed = await serve();
    const s = store();
    const installed = await s.ensure(pinFor(packed));
    expect(installed.dir).toBe(
      join(home, 'connector-components', componentFolderName(pinFor(packed)), 'package'),
    );
    expect(existsSync(join(installed.dir, ENTRY))).toBe(true);
    expect(existsSync(join(installed.dir, 'node_modules'))).toBe(false);
    const fetched = registry!.requests.length;
    await s.ensure(pinFor(packed));
    expect(registry!.requests.length).toBe(fetched);
    expect(await s.readiness(pinFor(packed))).toMatchObject({ installed: true });
  });

  it('refuses a tarball that does not match its pin, and installs nothing', async () => {
    const packed = await serve();
    await expect(store().ensure(pinFor(packed, { sha256: 'f'.repeat(64) }))).rejects.toThrow(
      /does not match its pin/,
    );
    expect(await readdir(join(home, 'connector-components'))).toEqual([]);
  });

  it('refuses an entry, license, SDK range or dependency the pin did not review', async () => {
    const packed = await serve();
    await expect(store().ensure(pinFor(packed, { entrySha256: 'e'.repeat(64) }))).rejects.toThrow(
      /entry file that does not match/,
    );
    await expect(store().ensure(pinFor(packed, { license: 'MIT' }))).rejects.toThrow(
      /licensed Apache-2.0, not MIT/,
    );
    await registry!.close();
    const withDeps = await serve(async (dir) => {
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
      manifest.dependencies = { 'left-pad': '1.3.0' };
      await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
    });
    await expect(store().ensure(pinFor(withDeps))).rejects.toThrow(/has dependencies of its own/);
  });

  it('refuses a component published for an SDK this build does not carry', async () => {
    const packed = await serve();
    const pin = pinFor(packed, { spectral: '^11.0.0' });
    await expect(store().ensure(pin)).rejects.toThrow(/needs a newer Gezel/);
    expect(registry!.requests).toEqual([]);
  });

  it('refuses in a store build and when the security level is off the network, before any request', async () => {
    const packed = await serve();
    vi.stubEnv('GEZEL_DISTRIBUTION_PROFILE', 'store');
    await expect(store().ensure(pinFor(packed))).rejects.toThrow(ComponentRefusedError);
    expect(await store().readiness(pinFor(packed))).toMatchObject({
      installed: false,
      downloadable: false,
      reason: expect.stringMatching(/cannot do/),
    });
    vi.unstubAllEnvs();
    const offline = store({ policy: { refusal: async () => 'Connections are off.' } });
    await expect(offline.ensure(pinFor(packed))).rejects.toThrow('Connections are off.');
    expect(registry!.requests).toEqual([]);
  });

  it('downloads again when an installed entry was changed on disk', async () => {
    const packed = await serve();
    const s = store();
    const installed = await s.ensure(pinFor(packed));
    await writeFile(join(installed.dir, ENTRY), 'module.exports = {};');
    expect(await s.resolveInstalled(pinFor(packed))).toBeUndefined();
    const again = await s.ensure(pinFor(packed));
    expect(again.dir).toBe(installed.dir);
    expect(await s.resolveInstalled(pinFor(packed))).toBeDefined();
  });

  it('removes a component no connection uses a day after its last use, and staging left behind', async () => {
    const packed = await serve();
    let now = Date.parse('2026-11-17T00:00:00Z');
    const s = store({ now: () => now });
    await s.ensure(pinFor(packed));
    const root = join(home, 'connector-components');
    const stale = join(root, 'x.staging-1-abc');
    await mkdir(stale, { recursive: true });
    const old = new Date(now - 2 * 60 * 60_000);
    await utimes(stale, old, old);

    // Still in use: kept however old.
    now += 3 * 24 * 60 * 60_000;
    expect(await s.prune([pinFor(packed)])).toEqual(['x.staging-1-abc']);
    expect(await readdir(root)).toEqual([componentFolderName(pinFor(packed))]);

    // Not in use, but used within the day: kept. A day later: removed.
    now = Date.parse('2026-11-17T00:00:00Z') + 60_000;
    expect(await s.prune([])).toEqual([]);
    now += 25 * 60 * 60_000;
    expect(await s.prune([])).toEqual([componentFolderName(pinFor(packed))]);
  });
});
