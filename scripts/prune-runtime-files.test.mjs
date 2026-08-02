import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  isRuntimeDeclaration,
  pruneRuntimeFiles,
  runtimePruneReason,
  verifyRuntimeDeclarationAssets,
} from './prune-runtime-files.mjs';

describe('runtimePruneReason', () => {
  it('classifies JavaScript, TypeScript, CSS, and WebAssembly source maps', () => {
    for (const name of [
      'dist/index.js.map',
      'dist/index.mjs.map',
      'dist/index.cjs.map',
      'src/index.ts.map',
      'src/index.mts.map',
      'styles/app.css.map',
      'debug/engine.wasm.map',
    ]) {
      assert.equal(runtimePruneReason(name), 'source-map', name);
    }
  });

  it('does not mistake an ordinary map data file for a source map', () => {
    assert.equal(runtimePruneReason('data/world.map'), null);
  });

  it('removes declarations except the two editor type surfaces', () => {
    assert.equal(runtimePruneReason('dist/index.d.ts'), 'type-declaration');
    assert.equal(
      runtimePruneReason('node_modules/openai/resources/index.d.mts'),
      'type-declaration',
    );
    assert.equal(runtimePruneReason('node_modules/date-fns/index.d.cts'), 'type-declaration');
    assert.equal(runtimePruneReason('node_modules/@bendyline/gezel-sdk/dist/index.d.ts'), null);
    assert.equal(runtimePruneReason('node_modules/@bendyline/gezel/dist/checks/index.d.ts'), null);
    assert.equal(
      isRuntimeDeclaration('nested/node_modules/@bendyline/gezel-sdk/dist/types-a1b2c3.d.ts'),
      true,
    );
  });

  it('keeps executable TypeScript source for packages that expose or load it at runtime', () => {
    assert.equal(runtimePruneReason('node_modules/example/src/index.ts'), null);
    assert.equal(runtimePruneReason('node_modules/example/bin/loader.mts'), null);
    assert.equal(runtimePruneReason('node_modules/example/config.cts'), null);
  });
});

describe('pruneRuntimeFiles', () => {
  let root;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-runtime-prune-'));
    const files = {
      'dist/index.js': 'export const ready = true;',
      'dist/index.js.map': '{}',
      'dist/types/only.d.ts': 'export interface Only {}',
      'node_modules/openai/index.js': 'module.exports = {};',
      'node_modules/openai/index.d.mts': 'export interface OpenAI {}',
      'node_modules/openai/src/index.ts': 'export const source = true;',
      'node_modules/@bendyline/gezel-sdk/dist/index.d.ts': 'export interface Sdk {}',
      'node_modules/@bendyline/gezel-sdk/dist/types-abc.d.ts': 'export interface Shared {}',
      'node_modules/@bendyline/gezel/dist/checks/index.d.ts': 'export interface Checks {}',
      'node_modules/@bendyline/gezel/dist/index.d.ts': 'export interface Core {}',
      'node_modules/maps/data/world.map': 'runtime map data',
      'node_modules/maps/debug/worker.wasm.map': '{}',
      'node_modules/pkg/LICENSE': 'license',
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), content);
    }
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('prunes only disposable files and removes newly empty directories', async () => {
    const result = await pruneRuntimeFiles(root);
    assert.deepEqual(result.byReason, { 'source-map': 2, 'type-declaration': 3 });
    assert.equal(result.removed.length, 5);

    for (const path of [
      'dist/index.js.map',
      'dist/types/only.d.ts',
      'node_modules/openai/index.d.mts',
      'node_modules/@bendyline/gezel/dist/index.d.ts',
      'node_modules/maps/debug/worker.wasm.map',
    ]) {
      assert.equal(existsSync(join(root, path)), false, path);
    }
    assert.equal(existsSync(join(root, 'dist/types')), false);

    for (const path of [
      'dist/index.js',
      'node_modules/openai/index.js',
      'node_modules/openai/src/index.ts',
      'node_modules/@bendyline/gezel-sdk/dist/index.d.ts',
      'node_modules/@bendyline/gezel-sdk/dist/types-abc.d.ts',
      'node_modules/@bendyline/gezel/dist/checks/index.d.ts',
      'node_modules/maps/data/world.map',
      'node_modules/pkg/LICENSE',
    ]) {
      assert.equal(existsSync(join(root, path)), true, path);
    }

    const declarations = await verifyRuntimeDeclarationAssets(root);
    assert.deepEqual(
      { sdkDeclarations: declarations.sdkDeclarations, total: declarations.total },
      { sdkDeclarations: 2, total: 3 },
    );
  });

  it('supports a non-mutating dry run', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'gezel-runtime-prune-dry-'));
    const map = join(scratch, 'index.js.map');
    await writeFile(map, '{}');
    const result = await pruneRuntimeFiles(scratch, { dryRun: true });
    assert.equal(result.removed.length, 1);
    assert.equal(existsSync(map), true);
    await rm(scratch, { recursive: true, force: true });
  });

  it('rejects a pruned tree missing editor declaration assets', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'gezel-runtime-prune-missing-types-'));
    await assert.rejects(
      verifyRuntimeDeclarationAssets(scratch),
      /script editor would lose Gezel SDK IntelliSense/,
    );
    await rm(scratch, { recursive: true, force: true });
  });
});

describe('release bundle wiring', () => {
  it('prunes both deployed runtimes and excludes Electron entry source maps', async () => {
    const [serviceBuilder, nodeBuilder, electronBuilder] = await Promise.all([
      readFile(new URL('./build-service-bundle.mjs', import.meta.url), 'utf8'),
      readFile(new URL('./build-node-bundle.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../packages/app/electron-builder.yml', import.meta.url), 'utf8'),
    ]);
    for (const [name, source] of [
      ['service bundle', serviceBuilder],
      ['node bundle', nodeBuilder],
    ]) {
      assert.match(source, /pruneRuntimeFilesWithReport\(target\)/, name);
    }
    assert.doesNotMatch(electronBuilder, /^\s+- dist\/(?:main|extract-service-bundle)\.js\.map$/m);
    assert.match(electronBuilder, /^\s+- '!dist\/ui\/\*\*\/\*\.map'$/m);
  });
});
