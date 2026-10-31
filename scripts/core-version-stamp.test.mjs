import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  missingCoreVersionDeclaration,
  readCoreVersionStamp,
  releaseStampEnv,
  releaseStampFromEnv,
  releaseStampPlugin,
  stampCoreVersionSource,
} from './core-version-stamp.mjs';

const SOURCE =
  "export const GEZEL_VERSION: string = '0.0.0';\nexport const GEZEL_CONTENT_COMPAT: string = '0.0.0';\n";
const STAMP = { version: '1.2.3', contentCompat: '1.26303' };

test('stamps both constants and keeps their type annotation', () => {
  const stamped = stampCoreVersionSource(SOURCE, STAMP);
  assert.equal(
    stamped,
    "export const GEZEL_VERSION: string = '1.2.3';\nexport const GEZEL_CONTENT_COMPAT: string = '1.26303';\n",
  );
  assert.deepEqual(readCoreVersionStamp(stamped), STAMP);
});

test('reads an unannotated declaration too', () => {
  assert.deepEqual(readCoreVersionStamp("export const GEZEL_VERSION = '4.5.6';\n"), {
    version: '4.5.6',
    contentCompat: null,
  });
});

test('refuses to stamp a source missing either declaration', () => {
  const versionOnly = "export const GEZEL_VERSION: string = '0.0.0';\n";
  assert.equal(missingCoreVersionDeclaration(versionOnly), 'GEZEL_CONTENT_COMPAT');
  assert.throws(
    () => stampCoreVersionSource(versionOnly, STAMP),
    /could not find GEZEL_CONTENT_COMPAT declaration/,
  );
  assert.equal(
    missingCoreVersionDeclaration('export const GEZEL_VERSION = "0.0.0";\n'),
    'GEZEL_VERSION',
  );
});

test('the environment carries a whole stamp or none', () => {
  assert.equal(releaseStampFromEnv({}), null);
  assert.deepEqual(releaseStampFromEnv(releaseStampEnv(STAMP)), STAMP);
  assert.throws(
    () => releaseStampFromEnv({ GEZEL_RELEASE_VERSION: '1.2.3' }),
    /set both GEZEL_RELEASE_VERSION and GEZEL_RELEASE_CONTENT_COMPAT/,
  );
});

test('the build plugin stamps core browser.ts as loaded and leaves other files to esbuild', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gezel-core-version-stamp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, 'src', 'browser.ts');
  await mkdir(join(root, 'src'));
  await writeFile(target, SOURCE);
  await writeFile(join(root, 'browser.ts'), SOURCE);

  let onLoad;
  releaseStampPlugin(STAMP, target).setup({
    onLoad(_options, callback) {
      onLoad = callback;
    },
  });
  assert.equal(await onLoad({ path: join(root, 'browser.ts') }), undefined);

  const loaded = await onLoad({ path: target });
  assert.equal(loaded.loader, 'ts');
  assert.deepEqual(readCoreVersionStamp(loaded.contents), STAMP);
});
