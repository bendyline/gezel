/**
 * A loopback npm registry for component-store tests: packuments and
 * tarballs for a few packages, every request recorded. Tarballs are packed
 * from a fixture folder, optionally altered first, the way `npm pack` lays
 * them out (`package/…`).
 */

import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as tar from 'tar';

const require = createRequire(import.meta.url);

/** `packages/connectors-spectral/test-fixtures/<name>`. */
export function spectralFixture(name: string): string {
  const pkg = require.resolve('@bendyline/gezel-connectors-spectral/package.json');
  return join(dirname(pkg), 'test-fixtures', name);
}

export interface PackedFixture {
  path: string;
  sha256: string;
  entrySha256: string;
}

export async function packFixture(
  fixtureDir: string,
  entry: string,
  alter?: (packageDir: string) => Promise<void>,
): Promise<PackedFixture> {
  const work = await mkdtemp(join(tmpdir(), 'gezel-fake-npm-'));
  const packageDir = join(work, 'package');
  await cp(fixtureDir, packageDir, { recursive: true });
  await alter?.(packageDir);
  const path = join(work, 'package.tgz');
  await tar.create({ gzip: true, cwd: work, file: path, portable: true }, ['package']);
  const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
  return {
    path,
    sha256: sha(await readFile(path)),
    entrySha256: sha(await readFile(join(packageDir, entry))),
  };
}

export interface FakeRegistry {
  url: string;
  requests: string[];
  close(): Promise<void>;
}

export async function startFakeRegistry(
  packages: { name: string; version: string; tarball: string }[],
): Promise<FakeRegistry> {
  const requests: string[] = [];
  let base = '';
  const server: Server = createServer(async (req, res) => {
    const path = decodeURIComponent(req.url ?? '/');
    requests.push(path);
    for (const p of packages) {
      if (path === `/${p.name}`) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            name: p.name,
            versions: {
              [p.version]: {
                dist: { tarball: `${base}/-/${encodeURIComponent(p.name)}-${p.version}.tgz` },
              },
            },
          }),
        );
        return;
      }
      if (path === `/-/${p.name}-${p.version}.tgz`) {
        res.setHeader('content-type', 'application/octet-stream');
        res.end(await readFile(p.tarball));
        return;
      }
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      for (const p of packages) await rm(dirname(p.tarball), { recursive: true, force: true });
    },
  };
}
