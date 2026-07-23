import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolsetManifest } from '@bendyline/gezel';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installNpmPackageToolset, validateNpmArchiveEntry } from './npm-package.js';

let home: string;
const previousPnpmPath = process.env.GEZEL_PNPM_PATH;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-npm-install-'));
  // The installer invokes `<pnpm> install ...`; Node treats the package's
  // extensionless `install` fixture as its script, giving this test a
  // cross-platform, network-free stand-in for pnpm.
  process.env.GEZEL_PNPM_PATH = process.execPath;
});

afterEach(async () => {
  if (previousPnpmPath === undefined) delete process.env.GEZEL_PNPM_PATH;
  else process.env.GEZEL_PNPM_PATH = previousPnpmPath;
  await rm(home, { recursive: true, force: true });
});

async function fixtureTarball(version = '1.0.0'): Promise<Buffer> {
  const fixture = join(home, `fixture-${version}`);
  await mkdir(join(fixture, 'package', 'dist'), { recursive: true });
  await writeFile(
    join(fixture, 'package', 'package.json'),
    JSON.stringify({ name: 'test-tool', version }),
  );
  await writeFile(join(fixture, 'package', 'dist', 'server.js'), 'export {};\n');
  await writeFile(join(fixture, 'package', 'install'), 'process.exit(0);\n');
  const archive = join(home, `test-tool-${version}.tgz`);
  await tar.create({ cwd: fixture, file: archive, gzip: true }, ['package']);
  return readFile(archive);
}

async function serveRegistry(
  tarball: Buffer,
): Promise<{ registry: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (request.url === '/test-tool') {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          versions: { '1.0.0': { dist: { tarball: `${origin}/test-tool-1.0.0.tgz` } } },
        }),
      );
      return;
    }
    response.setHeader('Content-Type', 'application/octet-stream');
    response.end(tarball);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    registry: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function manifest(sha256: string): ToolsetManifest & { runtime: { kind: 'npm-package' } } {
  return {
    id: 'test-tool',
    kind: 'toolset',
    name: 'Test Tool',
    description: 'Installer security fixture',
    version: '1.0.0',
    runtime: {
      kind: 'npm-package',
      package: 'test-tool',
      version: '1.0.0',
      sha256,
      entry: 'dist/server.js',
      args: [],
      envHints: [],
    },
  } as unknown as ToolsetManifest & { runtime: { kind: 'npm-package' } };
}

describe('npm package toolset installer', () => {
  it.each([
    ['../escape', 'File'],
    ['/absolute', 'File'],
    ['package/../../escape', 'File'],
    ['package/link', 'SymbolicLink'],
    ['package/hard', 'Link'],
    ['package/file.txt:stream', 'File'],
    ['package/CON.txt', 'File'],
    ['package/trailing.', 'File'],
    ['package/back\\slash', 'File'],
  ])('rejects an adversarial archive entry %s (%s)', (path, type) => {
    expect(() => validateNpmArchiveEntry(path, type)).toThrow(/unsafe package archive entry/);
  });

  it('validates in staging before atomically replacing an existing install', async () => {
    const tarball = await fixtureTarball('9.9.9');
    const sha = createHash('sha256').update(tarball).digest('hex');
    const installRoot = join(home, 'installed');
    const live = join(installRoot, 'test-tool@1.0.0');
    await mkdir(join(live, 'package'), { recursive: true });
    await writeFile(join(live, 'keep.txt'), 'known-good');
    const registry = await serveRegistry(tarball);
    try {
      await expect(
        installNpmPackageToolset({
          manifest: manifest(sha),
          installRoot,
          registry: registry.registry,
        }),
      ).rejects.toThrow(/identity does not match/);
      expect(await readFile(join(live, 'keep.txt'), 'utf8')).toBe('known-good');
    } finally {
      await registry.close();
    }
  });

  it('installs a pinned package and resolves its contained runtime entry', async () => {
    const tarball = await fixtureTarball();
    const sha = createHash('sha256').update(tarball).digest('hex');
    const registry = await serveRegistry(tarball);
    try {
      const result = await installNpmPackageToolset({
        manifest: manifest(sha),
        installRoot: join(home, 'installed'),
        registry: registry.registry,
      });
      expect(result.tarballSha256).toBe(sha);
      expect(await readFile(join(result.installPath, 'dist', 'server.js'), 'utf8')).toContain(
        'export',
      );
    } finally {
      await registry.close();
    }
  });
});
