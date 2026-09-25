import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { replaceNativeAssets } from './stage-native-assets.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'gezel-native-assets-'));
  try {
    const source = path.join(root, 'source');
    const output = path.join(root, 'android');
    const libraries = path.join(output, 'jniLibs');
    const licenses = path.join(output, 'licenses');
    const properties = path.join(output, 'native-toolchain.properties');
    for (const directory of [source, libraries, licenses])
      await mkdir(directory, { recursive: true });
    await writeFile(path.join(source, 'libengine.so'), 'new engine');
    await writeFile(path.join(source, 'LICENSE'), 'new license');
    await writeFile(path.join(libraries, 'libengine.so'), 'old engine');
    await writeFile(path.join(libraries, 'libobsolete.so'), 'obsolete engine');
    await writeFile(path.join(licenses, 'LICENSE-old.txt'), 'obsolete license');
    await writeFile(properties, 'old toolchain');
    await writeFile(path.join(output, 'user-project.txt'), 'user-owned project file');
    const replacements = [
      {
        target: libraries,
        files: [
          {
            relative: 'arm64-v8a/libengine.so',
            source: path.join(source, 'libengine.so'),
            sha256: hash('new engine'),
          },
        ],
      },
      { target: properties, content: 'new toolchain' },
      {
        target: licenses,
        files: [
          {
            relative: 'LICENSE-current.txt',
            source: path.join(source, 'LICENSE'),
            sha256: hash('new license'),
          },
        ],
      },
    ];
    await run({ root, source, output, libraries, licenses, properties, replacements });
    assert.equal(
      await readFile(path.join(output, 'user-project.txt'), 'utf8'),
      'user-owned project file',
    );
    assert.deepEqual(
      (await readdir(output)).filter((name) => name.startsWith('.gezel-native-stage-')),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function oldAssetsRemain({ libraries, properties }) {
  assert.equal(await readFile(path.join(libraries, 'libengine.so'), 'utf8'), 'old engine');
  assert.equal(await readFile(path.join(libraries, 'libobsolete.so'), 'utf8'), 'obsolete engine');
  assert.equal(await readFile(properties, 'utf8'), 'old toolchain');
}

test('replaces generated libraries and licenses exactly without touching other project files', () =>
  fixture(async ({ libraries, licenses, properties, replacements }) => {
    await replaceNativeAssets(replacements);
    assert.deepEqual(await readdir(libraries), ['arm64-v8a']);
    assert.equal(
      await readFile(path.join(libraries, 'arm64-v8a/libengine.so'), 'utf8'),
      'new engine',
    );
    assert.deepEqual(await readdir(licenses), ['LICENSE-current.txt']);
    assert.equal(await readFile(properties, 'utf8'), 'new toolchain');
  }));

test('a source change after verification leaves all previous generated assets intact', () =>
  fixture(async (state) => {
    await writeFile(path.join(state.source, 'LICENSE'), 'changed after manifest verification');
    await assert.rejects(replaceNativeAssets(state.replacements), /changed while staging/);
    await oldAssetsRemain(state);
    assert.deepEqual(await readdir(state.licenses), ['LICENSE-old.txt']);
  }));

test('a missing source leaves all previous generated assets intact', () =>
  fixture(async (state) => {
    await rm(path.join(state.source, 'LICENSE'));
    await assert.rejects(replaceNativeAssets(state.replacements), /ENOENT/);
    await oldAssetsRemain(state);
  }));

test('publication failure rolls back already-replaced paths and never follows a linked output', () =>
  fixture(async (state) => {
    const external = path.join(state.root, 'user-owned-external');
    await mkdir(external);
    await writeFile(path.join(external, 'LICENSE-private.txt'), 'user-owned license');
    await rm(state.licenses, { recursive: true });
    await symlink(external, state.licenses);
    await assert.rejects(replaceNativeAssets(state.replacements), /linked native output/);
    await oldAssetsRemain(state);
    assert.equal(
      await readFile(path.join(state.licenses, 'LICENSE-private.txt'), 'utf8'),
      'user-owned license',
    );
    assert.deepEqual(await readdir(external), ['LICENSE-private.txt']);
  }));

test('rejects unsafe or overlapping output declarations before publishing', () =>
  fixture(async (state) => {
    await assert.rejects(
      replaceNativeAssets([
        state.replacements[0],
        { target: path.join(state.libraries, 'nested'), content: '' },
      ]),
      /cannot contain/,
    );
    state.replacements[0].files[0].relative = '../escape.so';
    await assert.rejects(replaceNativeAssets(state.replacements), /Invalid verified native asset/);
    await oldAssetsRemain(state);
  }));
