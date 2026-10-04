import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
const require = createRequire(import.meta.url);
const {
  stageNative,
  checkEntry,
  selectArchives,
} = require('../../scripts/embedding-packaging.cjs');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
describe('embedding native staging', () => {
  it.each(['linux', 'win32'])(
    'stages pinned %s archives offline and preserves notices',
    async (platform) => {
      const root = await mkdtemp(path.join(tmpdir(), 'gezel-embedding-stage-'));
      roots.push(root);
      const source = path.join(root, 'source');
      const cache = path.join(root, 'cache');
      const destination = path.join(root, 'native');
      await mkdir(source);
      await mkdir(cache);
      await mkdir(destination);
      await writeFile(path.join(source, 'engine'), 'verified fixture');
      await writeFile(path.join(source, 'LICENSE'), 'fixture license');
      await writeFile(path.join(destination, 'old'), 'old');
      const name = `gezel-native-0.1.46-${platform}-x64-cpu.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
      const file = path.join(cache, name);
      if (platform === 'win32') {
        const Zip = require('adm-zip');
        const zip = new Zip();
        zip.addLocalFolder(source);
        zip.writeZip(file);
      } else await require('tar').c({ file, cwd: source, gzip: true }, ['.']);
      const sha = createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
      const options = {
        pins: { NATIVE_ENGINE_RELEASE: '0.1.46', NATIVE_ENGINE_ARCHIVE_SHA256: { [name]: sha } },
        platform,
        arch: 'x64',
        destination,
        cache,
        serviceRequire: require,
        fetchImpl: async () => {
          throw new Error('must not fetch');
        },
      };
      await stageNative(options);
      expect(await readFile(path.join(destination, `${platform}-x64-cpu`, 'LICENSE'), 'utf8')).toBe(
        'fixture license',
      );
      await writeFile(file, 'corruption');
      await expect(stageNative(options)).rejects.toThrow('SHA-256');
      expect(await readFile(path.join(destination, `${platform}-x64-cpu`, 'engine'), 'utf8')).toBe(
        'verified fixture',
      );
    },
  );
  it('rejects unsafe archive paths and extraction overflows', () => {
    for (const name of ['../escape', '/escape', 'C:/escape', 'a\\escape', 'a/../escape'])
      expect(() => checkEntry(name, 1, { entries: 0, bytes: 0 })).toThrow('Unsafe');
    expect(() => checkEntry('large', 9 * 1024 ** 3, { entries: 0, bytes: 0 })).toThrow('limits');
    expect(() => selectArchives({ NATIVE_ENGINE_RELEASE: 'latest' }, 'linux', 'x64')).toThrow(
      'exact',
    );
  });
});
