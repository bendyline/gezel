import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { SpeechAssetStore, speechAssetOptions } from './assets.js';
import type { SpeechModelEntry } from './catalog.js';

const bytes = Buffer.from('one pinned speech model');
const file = {
  name: 'weights.bin',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  size: bytes.length,
  url: 'https://models.test/weights.bin',
};
const model: SpeechModelEntry = {
  id: 'test',
  files: [file],
  kind: 'stt',
  label: 'Test',
  description: '',
  recommended: false,
  license: 'MIT',
  licenseUrl: 'https://models.test/license',
};
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'speech-assets-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

it('downloads once across independent clients and retains bytes until the last installation is removed', async () => {
  let downloads = 0;
  const opts = {
    root: join(root, 'cache'),
    fetchImpl: (async () => {
      downloads++;
      await new Promise((r) => setTimeout(r, 25));
      return new Response(bytes);
    }) as typeof fetch,
  };
  const a = new SpeechAssetStore(opts);
  const b = new SpeechAssetStore(opts);
  const first = join(root, 'docblocks', file.name);
  const second = join(root, 'gezel', file.name);
  await Promise.all([
    a.materialize(model, file, first, { download: true }),
    b.materialize(model, file, second, { download: true }),
  ]);
  expect(downloads).toBe(1);
  expect((await stat(first)).ino).toBe((await stat(second)).ino);
  await rm(first);
  await a.collect(file);
  expect(await readFile(second)).toEqual(bytes);
  await rm(second);
  await b.collect(file);
  expect(await b.find(model, file)).toBeNull();
});

it('adopts a verified legacy copy without a download and survives removal of its old name', async () => {
  const legacy = join(root, 'legacy.bin');
  await writeFile(legacy, bytes);
  const store = new SpeechAssetStore({
    root: join(root, 'cache'),
    candidates: () => [legacy],
    fetchImpl: async () => {
      throw new Error('no network');
    },
  });
  expect(await store.find(model, file)).toBe(legacy);
  const destination = join(root, 'new', 'weights.bin');
  expect(await store.materialize(model, file, destination, { download: false })).toBe(true);
  await rm(legacy);
  expect(await readFile(destination)).toEqual(bytes);
});

it('rejects wrong bytes even at the right size and does not create directories during discovery', async () => {
  const cache = join(root, 'cache');
  const store = new SpeechAssetStore({ root: cache });
  expect(await store.find(model, file)).toBeNull();
  await expect(stat(cache)).rejects.toMatchObject({ code: 'ENOENT' });
  await mkdir(cache);
  await writeFile(join(cache, file.sha256), Buffer.alloc(bytes.length));
  expect(await store.find(model, file)).toBeNull();
  expect(
    await store.materialize(model, file, join(root, 'app', file.name), { download: false }),
  ).toBe(false);
});

it('rejects linked directories and never writes through them', async () => {
  await mkdir(join(root, 'outside'));
  await symlink(join(root, 'outside'), join(root, 'cache'));
  const store = new SpeechAssetStore({ root: join(root, 'cache') });
  await expect(
    store.materialize(model, file, join(root, 'app.bin'), { download: true }),
  ).rejects.toThrow('Unsafe');
});

it('cancelled waiters leave a live writer alone', async () => {
  const cache = join(root, 'cache');
  await mkdir(cache);
  const lock = join(cache, `${file.sha256}.lock`);
  await mkdir(lock);
  await writeFile(join(lock, `${process.pid}-abcdef`), '');
  const store = new SpeechAssetStore({ root: cache });
  const controller = new AbortController();
  const pending = store.materialize(model, file, join(root, 'app.bin'), {
    download: true,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect((await stat(lock)).isDirectory()).toBe(true);
});

it('resolves custom homes and machine assets without making the machine store writable', () => {
  const home = join(root, 'custom');
  const machine = join(root, 'machine');
  const opts = speechAssetOptions({ home, sharedAssets: machine });
  expect(opts.root).toBe(join(home, 'engines', 'speech-assets'));
  expect(opts.candidates?.(model, file)).toContain(
    join(machine, 'models', 'whisper-cpp', 'test', 'weights.bin'),
  );
  expect(
    speechAssetOptions({ home, sharedAssets: machine, env: { GEZEL_SYSTEM_SCOPE: '1' } }).root,
  ).toBe(join(machine, 'models', 'speech-assets'));
});

it('coordinates two OS processes rather than only two instances in one process', async () => {
  const require = createRequire(import.meta.url);
  const { build } = createRequire(require.resolve('tsup'))('esbuild');
  const bundled = join(root, 'assets.mjs');
  await build({
    entryPoints: [fileURLToPath(new URL('./assets.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: bundled,
  });
  const source = pathToFileURL(bundled).href;
  const child = (name: string) =>
    promisify(execFile)(process.execPath, [
      '--input-type=module',
      '-e',
      `
      import { appendFile } from 'node:fs/promises';
      import { SpeechAssetStore } from ${JSON.stringify(source)};
      const model = ${JSON.stringify(model)};
      const file = model.files[0];
      const store = new SpeechAssetStore({
        root: ${JSON.stringify(join(root, 'cache'))},
        fetchImpl: async () => {
          await appendFile(${JSON.stringify(join(root, 'downloads'))}, 'download\\n');
          await new Promise(resolve => setTimeout(resolve, 75));
          return new Response(${JSON.stringify(bytes.toString())});
        },
      });
      await store.materialize(model, file, ${JSON.stringify(join(root, name, file.name))}, { download: true });
    `,
    ]);
  await Promise.all([child('docblocks'), child('gezel')]);
  expect(await readFile(join(root, 'downloads'), 'utf8')).toBe('download\n');
  expect((await stat(join(root, 'docblocks', file.name))).ino).toBe(
    (await stat(join(root, 'gezel', file.name))).ino,
  );
});
