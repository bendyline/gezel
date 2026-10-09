import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const serviceRequire = require;
const {
  stageNative,
  selectArchives,
  checkEntry,
} = require('../../scripts/embedding-packaging.cjs');

describe('Gezel native packaging', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'docblocks-gezel-native-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function fixture(platform: 'linux' | 'win32' | 'darwin' = 'linux') {
    const cache = path.join(root, 'cache');
    const source = path.join(root, 'source');
    const destination = path.join(root, 'resources', 'gezel-native');
    await mkdir(cache, { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'gezel-llama-server'), 'pinned engine', { mode: 0o755 });
    await writeFile(path.join(source, 'LICENSE.txt'), 'engine license');
    const arch = platform === 'darwin' ? 'arm64' : 'x64';
    const backend = platform === 'darwin' ? '' : '-cpu';
    const name = `gezel-native-0.1.46-${platform}-${arch}${backend}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
    const archive = path.join(cache, name);
    if (platform === 'win32') {
      const Zip = serviceRequire('adm-zip');
      const zip = new Zip();
      zip.addLocalFolder(source);
      zip.writeZip(archive);
    } else {
      await serviceRequire('tar').c({ cwd: source, file: archive, gzip: true }, ['.']);
    }
    const bytes = await readFile(archive);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const pins = {
      NATIVE_ENGINE_RELEASE: '0.1.46',
      NATIVE_ENGINE_MACOS_NOTARIZED: true,
      NATIVE_ENGINE_ARCHIVE_SHA256: { [name]: sha },
    };
    return {
      platform,
      arch,
      cache,
      source,
      destination,
      name,
      archive,
      bytes,
      pins,
      serviceRequire,
      fetchImpl: async () => {
        throw new Error('offline: network must not be used');
      },
    };
  }

  for (const platform of ['linux', 'win32'] as const) {
    it(`extracts the pinned ${platform} archive offline and preserves its licenses`, async () => {
      const input = await fixture(platform);
      await mkdir(input.destination, { recursive: true });
      await writeFile(path.join(input.destination, 'stale.dll'), 'old release');
      await stageNative(input);
      expect(
        await readFile(
          path.join(input.destination, `${platform}-x64-cpu`, 'gezel-llama-server'),
          'utf8',
        ),
      ).toBe('pinned engine');
      expect(
        await readFile(path.join(input.destination, `${platform}-x64-cpu`, 'LICENSE.txt'), 'utf8'),
      ).toBe('engine license');
      const manifest = JSON.parse(
        await readFile(path.join(input.destination, 'release.json'), 'utf8'),
      );
      expect(manifest.release).toBe('0.1.46');
      expect(manifest.archives).toHaveLength(1);
      await expectMissing(path.join(input.destination, 'stale.dll'));
    });
  }

  it('preserves native library symlink chains after extracting all regular files', async ({
    skip,
  }) => {
    if (process.platform === 'win32') skip();
    const input = await fixture();
    await symlink('gezel-llama-server', path.join(input.source, 'libengine.1.so'));
    await symlink('libengine.1.so', path.join(input.source, 'libengine.so'));
    await serviceRequire('tar').c({ cwd: input.source, file: input.archive, gzip: true }, ['.']);
    input.pins.NATIVE_ENGINE_ARCHIVE_SHA256[input.name] = createHash('sha256')
      .update(await readFile(input.archive))
      .digest('hex');
    await stageNative(input);
    const directory = path.join(input.destination, 'linux-x64-cpu');
    expect(await readlink(path.join(directory, 'libengine.so'))).toBe('libengine.1.so');
    expect(await readlink(path.join(directory, 'libengine.1.so'))).toBe('gezel-llama-server');
    expect(await readFile(path.join(directory, 'libengine.so'), 'utf8')).toBe('pinned engine');
  });

  it('rejects a changed cached archive without replacing a staged payload', async () => {
    const input = await fixture();
    await mkdir(input.destination, { recursive: true });
    await writeFile(path.join(input.destination, 'kept.txt'), 'existing payload');
    await writeFile(input.archive, 'tampered archive');
    const error = await failed(stageNative(input));
    expect(error.message).toContain('SHA-256 verification');
    expect(await readFile(path.join(input.destination, 'kept.txt'), 'utf8')).toBe(
      'existing payload',
    );
  });

  it('verifies downloaded archive bytes before extraction and cleans a bad download', async () => {
    const input = await fixture();
    await rm(input.archive);
    let url = '';
    const error = await failed(
      stageNative({
        ...input,
        fetchImpl: async (requested: string) => {
          url = requested;
          return new Response('tampered download');
        },
      }),
    );
    expect(url).toContain('/native-v0.1.46/');
    expect(error.message).toContain('SHA-256 mismatch');
    await expectMissing(input.archive);
    await expectMissing(`${input.archive}.partial`);
    await stageNative({ ...input, fetchImpl: async () => new Response(input.bytes) });
    expect(await readFile(input.archive)).toEqual(input.bytes);
  });

  it('selects every pinned backend for the target architecture, including ARM64', () => {
    const digest = 'a'.repeat(64);
    const archives = selectArchives(
      {
        NATIVE_ENGINE_RELEASE: '0.1.46',
        NATIVE_ENGINE_ARCHIVE_SHA256: {
          'gezel-native-0.1.46-win32-arm64.zip': digest,
          'gezel-native-0.1.46-win32-arm64-cpu.zip': digest,
          'gezel-native-0.1.46-win32-x64-cpu.zip': digest,
        },
      },
      'win32',
      'arm64',
    );
    expect(archives.map((entry: { platformKey: string }) => entry.platformKey)).toEqual([
      'win32-arm64',
      'win32-arm64-cpu',
    ]);
  });

  it('fails unsupported targets unless the build explicitly disables hosted AI', async () => {
    const input = await fixture();
    expect((await failed(stageNative({ ...input, platform: 'darwin' }))).message).toContain(
      'no native archives',
    );
    await stageNative({ ...input, platform: 'darwin', allowUnavailable: true });
    expect(
      JSON.parse(await readFile(path.join(input.destination, 'release.json'), 'utf8')).archives,
    ).toEqual([]);
  });

  it('rejects traversal, absolute paths, platform aliases, and extraction overflows', () => {
    for (const name of ['../escape', '/escape', 'C:/escape', 'a\\escape', 'a/../escape']) {
      expect(() => checkEntry(name, 1, { entries: 0, bytes: 0 }), name).toThrow('Unsafe');
    }
    expect(() => checkEntry('large', 9 * 1024 ** 3, { entries: 0, bytes: 0 })).toThrow('limits');
  });
});

async function failed(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected rejection');
}

async function expectMissing(file: string): Promise<void> {
  expect(((await failed(readFile(file))) as NodeJS.ErrnoException).code).toBe('ENOENT');
}
