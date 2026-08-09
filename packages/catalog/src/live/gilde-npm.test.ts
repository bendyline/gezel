import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GILDE_PACKAGE_NAME,
  type GildeReleaseInfo,
  compareRelease,
  fetchGildeReleases,
  pickGildePatchUpdate,
  stageGildeVersion,
} from './gilde-npm.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-gilde-npm-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function gildeTarball(version: string, name = GILDE_PACKAGE_NAME): Promise<Buffer> {
  const fixture = join(
    home,
    `fixture-${version.replace(/[^0-9a-z.]/gi, '_')}-${name.replace(/[^a-z]/gi, '_')}`,
  );
  await mkdir(join(fixture, 'package', 'data', 'toolsets'), { recursive: true });
  await writeFile(join(fixture, 'package', 'package.json'), JSON.stringify({ name, version }));
  await writeFile(
    join(fixture, 'package', 'data', 'toolsets', 'index.json'),
    `${JSON.stringify({ schemaVersion: 1, kind: 'toolset', count: 0, entries: [] })}\n`,
  );
  const archive = join(fixture, 'package.tgz');
  await tar.create({ cwd: fixture, file: archive, gzip: true }, ['package']);
  return readFile(archive);
}

function sha512Integrity(tarball: Buffer): string {
  return `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
}

interface StubVersion {
  tarball: Buffer;
  integrity?: string;
  shasum?: string;
  tarballOrigin?: string;
}

/** Loopback registry serving a corgi-shaped packument + version tarballs. */
async function serveGildeRegistry(versions: Record<string, StubVersion>): Promise<{
  registry: string;
  requests: string[];
  close: () => Promise<void>;
}> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const decoded = decodeURIComponent(request.url ?? '');
    if (decoded === `/${GILDE_PACKAGE_NAME}`) {
      const body = {
        name: GILDE_PACKAGE_NAME,
        versions: Object.fromEntries(
          Object.entries(versions).map(([version, entry]) => [
            version,
            {
              dist: {
                tarball: `${entry.tarballOrigin ?? origin}/gilde-${version}.tgz`,
                ...(entry.integrity ? { integrity: entry.integrity } : {}),
                ...(entry.shasum ? { shasum: entry.shasum } : {}),
              },
            },
          ]),
        ),
      };
      response.setHeader('Content-Type', 'application/vnd.npm.install-v1+json');
      response.end(JSON.stringify(body));
      return;
    }
    const match = /^\/gilde-(.+)\.tgz$/.exec(decoded);
    const entry = match ? versions[match[1] ?? ''] : undefined;
    if (!entry) {
      response.statusCode = 404;
      response.end('not found');
      return;
    }
    response.setHeader('Content-Type', 'application/octet-stream');
    response.end(entry.tarball);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    registry: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

describe('fetchGildeReleases', () => {
  it('returns plain releases with dist metadata, dropping prereleases and off-origin tarballs', async () => {
    const tarball = await gildeTarball('0.1.16');
    const registry = await serveGildeRegistry({
      '0.1.15': { tarball, integrity: sha512Integrity(tarball) },
      '0.1.16': { tarball, integrity: sha512Integrity(tarball), shasum: 'a'.repeat(40) },
      '0.1.17-rc.1': { tarball },
      '0.2.0': { tarball, tarballOrigin: 'https://evil.example.com' },
    });
    try {
      const releases = await fetchGildeReleases({ registry: registry.registry });
      const versions = releases.map((r) => r.version).sort();
      expect(versions).toEqual(['0.1.15', '0.1.16']);
      const patch = releases.find((r) => r.version === '0.1.16');
      expect(patch?.integrity).toMatch(/^sha512-/);
      expect(patch?.shasum).toBe('a'.repeat(40));
      expect(patch?.tarballUrl).toContain(registry.registry);
    } finally {
      await registry.close();
    }
  });

  it('rejects an oversized packument from the declared length, without reading it', async () => {
    const sockets = new Set<import('node:net').Socket>();
    const server = createServer((_request, response) => {
      // Declared length alone must trip the cap — the body never arrives.
      response.setHeader('Content-Type', 'application/json');
      response.setHeader('Content-Length', String(64 * 1024 * 1024));
      response.write('{');
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(fetchGildeReleases({ registry: `http://127.0.0.1:${port}` })).rejects.toThrow(
        /too large/,
      );
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('pickGildePatchUpdate', () => {
  const release = (version: string): GildeReleaseInfo => ({
    version,
    tarballUrl: `https://registry.example/${version}.tgz`,
  });

  it('picks the newest patch on the pinned minor line', () => {
    const picked = pickGildePatchUpdate(
      [release('0.1.16'), release('0.1.19'), release('0.1.17')],
      '0.1.15',
    );
    expect(picked?.version).toBe('0.1.19');
  });

  it('ignores other minor lines and prereleases', () => {
    const picked = pickGildePatchUpdate(
      [release('0.2.0'), release('1.0.0'), release('0.1.16-rc.1'), release('0.0.99')],
      '0.1.15',
    );
    expect(picked).toBeNull();
  });

  it('returns null when nothing is newer than the pin', () => {
    expect(pickGildePatchUpdate([release('0.1.15'), release('0.1.14')], '0.1.15')).toBeNull();
  });

  it('respects an already-active live version as the floor', () => {
    const releases = [release('0.1.16'), release('0.1.18')];
    expect(pickGildePatchUpdate(releases, '0.1.15', '0.1.18')?.version).toBeUndefined();
    expect(pickGildePatchUpdate(releases, '0.1.15', '0.1.16')?.version).toBe('0.1.18');
  });

  it('compares numerically, not lexically', () => {
    expect(compareRelease('0.1.9', '0.1.10')).toBeLessThan(0);
    const picked = pickGildePatchUpdate([release('0.1.9'), release('0.1.10')], '0.1.2');
    expect(picked?.version).toBe('0.1.10');
  });
});

describe('stageGildeVersion', () => {
  it('downloads, verifies sha512 integrity, and extracts the package', async () => {
    const tarball = await gildeTarball('0.1.16');
    const registry = await serveGildeRegistry({
      '0.1.16': { tarball, integrity: sha512Integrity(tarball) },
    });
    try {
      const [release] = await fetchGildeReleases({ registry: registry.registry });
      if (!release) throw new Error('expected a release');
      const staging = join(home, 'staging');
      const { packageDir } = await stageGildeVersion({
        release,
        stagingDir: staging,
        registry: registry.registry,
      });
      expect(packageDir).toBe(join(staging, 'package'));
      const index = JSON.parse(
        await readFile(join(packageDir, 'data', 'toolsets', 'index.json'), 'utf8'),
      );
      expect(index.kind).toBe('toolset');
      // The tarball itself is cleaned up after extraction.
      expect(await readdir(staging)).toEqual(['package']);
    } finally {
      await registry.close();
    }
  });

  it('refuses a tarball whose sha512 does not match the registry integrity', async () => {
    const tarball = await gildeTarball('0.1.16');
    const other = await gildeTarball('0.1.99');
    const registry = await serveGildeRegistry({
      '0.1.16': { tarball, integrity: sha512Integrity(other) },
    });
    try {
      const [release] = await fetchGildeReleases({ registry: registry.registry });
      if (!release) throw new Error('expected a release');
      await expect(
        stageGildeVersion({
          release,
          stagingDir: join(home, 'staging'),
          registry: registry.registry,
        }),
      ).rejects.toThrow(/sha512 integrity mismatch/);
    } finally {
      await registry.close();
    }
  });

  it('falls back to the legacy sha1 shasum when no integrity is present', async () => {
    const tarball = await gildeTarball('0.1.16');
    const shasum = createHash('sha1').update(tarball).digest('hex');
    const registry = await serveGildeRegistry({ '0.1.16': { tarball, shasum } });
    try {
      const [release] = await fetchGildeReleases({ registry: registry.registry });
      if (!release) throw new Error('expected a release');
      const { packageDir } = await stageGildeVersion({
        release,
        stagingDir: join(home, 'staging'),
        registry: registry.registry,
      });
      expect(packageDir).toBe(join(home, 'staging', 'package'));
    } finally {
      await registry.close();
    }
  });

  it('refuses to download when the registry offers no usable hash', async () => {
    await expect(
      stageGildeVersion({
        release: { version: '0.1.16', tarballUrl: 'http://127.0.0.1:1/gilde.tgz' },
        stagingDir: join(home, 'staging'),
        registry: 'http://127.0.0.1:1',
      }),
    ).rejects.toThrow(/no usable integrity hash/);
  });

  it('refuses an extracted package whose identity does not match', async () => {
    const impostor = await gildeTarball('0.1.16', '@bendyline/not-gilde');
    const registry = await serveGildeRegistry({
      '0.1.16': { tarball: impostor, integrity: sha512Integrity(impostor) },
    });
    try {
      const [release] = await fetchGildeReleases({ registry: registry.registry });
      if (!release) throw new Error('expected a release');
      await expect(
        stageGildeVersion({
          release,
          stagingDir: join(home, 'staging'),
          registry: registry.registry,
        }),
      ).rejects.toThrow(/identity does not match/);
    } finally {
      await registry.close();
    }
  });
});
