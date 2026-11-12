import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import * as tar from 'tar';
import {
  compareReleaseContent,
  compareTarballDirs,
  manifestDifferences,
  readPackageTarball,
} from './compare-npm-release-content.mjs';

const SIBLINGS = new Set(['@bendyline/gezk', '@bendyline/gezel', '@bendyline/gezel-cli']);

function manifestSource(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function packTarball(root, fileName, files) {
  const staging = await mkdtemp(join(root, 'staging-'));
  for (const [path, content] of Object.entries(files)) {
    const target = join(staging, 'package', path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const file = join(root, fileName);
  await tar.c({ gzip: true, file, cwd: staging, portable: true }, ['package']);
  return file;
}

function tarballOf(manifest, files = {}) {
  return {
    name: manifest.name,
    version: manifest.version,
    manifest,
    files: new Map([
      ['package.json', Buffer.from(manifestSource(manifest))],
      ...Object.entries(files).map(([path, content]) => [path, Buffer.from(content)]),
    ]),
  };
}

test('ignores the version and the order of dependency maps', () => {
  const published = tarballOf(
    {
      name: '@bendyline/gezel-knowledge',
      version: '1.2.10',
      dependencies: { '@bendyline/gezk': '1.0.6', yaml: '^2.9.0', zod: '4.6.7' },
    },
    { 'dist/index.js': 'export {};\n' },
  );
  const candidate = tarballOf(
    {
      name: '@bendyline/gezel-knowledge',
      version: '1.2.11',
      dependencies: { yaml: '^2.9.0', zod: '4.6.7', '@bendyline/gezk': '1.0.6' },
    },
    { 'dist/index.js': 'export {};\n' },
  );

  const result = compareReleaseContent(candidate, published, SIBLINGS);

  assert.equal(result.kind, 'identical');
  assert.deepEqual(result.manifest, { pins: [], other: [] });
});

test('a moved sibling pin alone is pins-only, and names the pin', () => {
  const published = tarballOf({
    name: 'gezel-cli',
    version: '1.0.1',
    dependencies: { '@bendyline/gezel-cli': '1.2.14' },
  });
  const candidate = tarballOf({
    name: 'gezel-cli',
    version: '1.0.2',
    dependencies: { '@bendyline/gezel-cli': '1.3.0' },
  });

  const result = compareReleaseContent(candidate, published, SIBLINGS);

  assert.equal(result.kind, 'pins-only');
  assert.deepEqual(result.manifest.pins, [
    { field: 'dependencies', name: '@bendyline/gezel-cli', from: '1.2.14', to: '1.3.0' },
  ]);
});

test('third-party ranges, added dependencies and exports order count as changes', () => {
  const base = {
    name: '@bendyline/gezel-sdk',
    version: '1.1.14',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    dependencies: { '@bendyline/gezel': '1.2.14', zod: '4.6.7' },
  };

  assert.deepEqual(
    manifestDifferences(
      { ...base, dependencies: { ...base.dependencies, zod: '4.6.8' } },
      base,
      SIBLINGS,
    ),
    { pins: [], other: ['dependencies.zod'] },
  );
  assert.deepEqual(
    manifestDifferences(
      { ...base, dependencies: { ...base.dependencies, '@bendyline/gezk': '1.0.6' } },
      base,
      SIBLINGS,
    ),
    { pins: [], other: ['dependencies.@bendyline/gezk'] },
  );
  assert.deepEqual(
    manifestDifferences(
      { ...base, exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } } },
      base,
      SIBLINGS,
    ),
    { pins: [], other: ['exports'] },
  );
});

test('a changed, added or removed file makes the package changed', () => {
  const manifest = { name: '@bendyline/gezk', version: '1.0.6' };
  const published = tarballOf(manifest, { 'README.md': 'old\n', 'dist/a.js': 'a\n' });
  const candidate = tarballOf(manifest, { 'README.md': 'new\n', 'dist/b.js': 'b\n' });

  const result = compareReleaseContent(candidate, published, SIBLINGS);

  assert.equal(result.kind, 'changed');
  assert.deepEqual(result.changed, ['README.md']);
  assert.deepEqual(result.added, ['dist/b.js']);
  assert.deepEqual(result.removed, ['dist/a.js']);
});

test('reads real tarballs and matches them by package name, not file name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gezel-release-content-'));
  try {
    const candidatesDir = join(root, 'candidates');
    const publishedDir = join(root, 'published');
    await mkdir(candidatesDir);
    await mkdir(publishedDir);
    const readme = '# gezk\n';
    await packTarball(candidatesDir, 'renamed.tgz', {
      'package.json': manifestSource({
        name: '@bendyline/gezk',
        version: '1.0.7',
        dependencies: { zod: '4.6.7' },
      }),
      'README.md': readme,
      'dist/index.js': 'export const x = 1;\n',
    });
    await packTarball(candidatesDir, 'new-package.tgz', {
      'package.json': manifestSource({ name: '@bendyline/gezel-new', version: '1.0.0' }),
    });
    await packTarball(publishedDir, 'bendyline-gezk-1.0.6.tgz', {
      'package.json': manifestSource({
        name: '@bendyline/gezk',
        version: '1.0.6',
        dependencies: { zod: '4.6.7' },
      }),
      'README.md': readme,
      'dist/index.js': 'export const x = 1;\n',
    });

    const read = await readPackageTarball(join(publishedDir, 'bendyline-gezk-1.0.6.tgz'));
    assert.deepEqual([...read.files.keys()].sort(), ['README.md', 'dist/index.js', 'package.json']);

    const results = await compareTarballDirs({ candidatesDir, publishedDir });
    assert.deepEqual(
      results.map(({ name, kind, publishedVersion, candidateVersion }) => ({
        name,
        kind,
        publishedVersion,
        candidateVersion,
      })),
      [
        {
          name: '@bendyline/gezel-new',
          kind: 'unpublished',
          publishedVersion: null,
          candidateVersion: '1.0.0',
        },
        {
          name: '@bendyline/gezk',
          kind: 'identical',
          publishedVersion: '1.0.6',
          candidateVersion: '1.0.7',
        },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
