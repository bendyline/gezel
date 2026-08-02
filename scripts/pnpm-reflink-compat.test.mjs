import assert from 'node:assert/strict';
import { copyFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  removePnpmReflinkDependency,
  smokeTestPnpmCloneMode,
  verifyPnpmReflinkRemoval,
} from './pnpm-reflink-compat.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const compatSource = join(here, '..', 'packages', 'app', 'scripts', 'pnpm-reflink-compat.cjs');
const require = createRequire(import.meta.url);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'gezel-pnpm-reflink-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scope = join(root, 'dist', 'node_modules', '@reflink');
  await mkdir(join(scope, 'reflink'), { recursive: true });
  await mkdir(join(scope, 'reflink-win32-x64-msvc'), { recursive: true });
  await writeFile(
    join(scope, 'reflink', 'package.json'),
    JSON.stringify({ name: '@reflink/reflink', version: '0.1.19' }),
  );
  await writeFile(join(scope, 'reflink-win32-x64-msvc', 'reflink.win32-x64-msvc.node'), '');
  await writeFile(join(root, 'dist', 'pnpm.mjs'), `${'__require("@reflink/reflink")\n'.repeat(2)}`);
  await writeFile(join(root, 'dist', 'worker.js'), '__require("@reflink/reflink")\n');
  return root;
}

test('staging removes every @reflink package and patches all reviewed pnpm imports', async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await removePnpmReflinkDependency(root), {
    removedPackage: '@reflink/reflink@0.1.19',
    patchedImports: 3,
  });
  assert.deepEqual(await verifyPnpmReflinkRemoval(root), {
    patchedImports: 3,
    nativeAddons: 0,
  });
  assert.doesNotMatch(await readFile(join(root, 'dist', 'pnpm.mjs'), 'utf8'), /@reflink/);
});

test('staging refuses an incomplete or changed pnpm call site', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'dist', 'worker.js'), '// upstream layout changed\n');
  await assert.rejects(removePnpmReflinkDependency(root), /expected 1/);
});

test('the compatibility module preserves EEXIST and normalizes unsupported clone errors', async (t) => {
  const compat = require(compatSource);
  for (const code of ['EINVAL', 'ENOSYS', 'EXDEV']) {
    const error = Object.assign(new Error(code), { code });
    assert.equal(compat.normalizeUnsupportedError(error), error);
    assert.equal(error.code, 'ENOTSUP');
  }

  const root = await mkdtemp(join(tmpdir(), 'gezel-reflink-fs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source.txt');
  const target = join(root, 'target.txt');
  await writeFile(source, 'copy-on-write or safe fallback');
  try {
    assert.equal(compat.reflinkFileSync(source, target), 0);
  } catch (error) {
    assert.equal(error.code, 'ENOTSUP');
    copyFileSync(source, target);
  }
  assert.equal(await readFile(target, 'utf8'), 'copy-on-write or safe fallback');
  assert.throws(
    () => compat.reflinkFileSync(source, target),
    (error) => error?.code === 'EEXIST' || error?.code === 'ENOTSUP',
  );
});

test('the staged runtime installs a tarball in explicit clone mode', async (t) => {
  const builtRuntime = join(here, '..', 'packages', 'app', 'dist', 'pnpm-bundle');
  try {
    await readFile(join(builtRuntime, 'bin', 'pnpm.mjs'));
  } catch {
    t.skip('pnpm bundle has not been staged');
    return;
  }
  assert.equal((await smokeTestPnpmCloneMode(builtRuntime)).installed, true);
});
