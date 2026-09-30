import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { hasRuntimeCode, resolveSourceImport } from './check-test-surface.mjs';

test('resolves a NodeNext .js import to a TSX source file', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'gezel-test-surface-'));
  try {
    const testFile = join(fixtureRoot, 'Component.test.tsx');
    const sourceFile = join(fixtureRoot, 'Component.tsx');
    await writeFile(sourceFile, 'export const Component = () => null;\n');

    assert.equal(await resolveSourceImport(testFile, './Component.js'), sourceFile);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('prefers a TS module over TSX when both satisfy a NodeNext .js import', async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'gezel-test-surface-'));
  try {
    const testFile = join(fixtureRoot, 'module.test.ts');
    const tsFile = join(fixtureRoot, 'module.ts');
    await Promise.all([
      writeFile(tsFile, 'export const value = 1;\n'),
      writeFile(join(fixtureRoot, 'module.tsx'), 'export const value = 2;\n'),
    ]);

    assert.equal(await resolveSourceImport(testFile, './module.js'), tsFile);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('counts a module as test surface only when it has something to execute', () => {
  const typesOnly = [
    "import type { Task } from './task.js';",
    "import { type Project, type Gezel } from './schemas.js';",
    'export interface Remote { id: string }',
    "export type Scope = 'read' | 'write';",
    "export type { Task } from './task.js';",
    'declare const buildStamp: string;',
  ].join('\n');
  assert.equal(hasRuntimeCode(typesOnly), false);
  assert.equal(hasRuntimeCode(''), false);

  for (const runtime of [
    'export const limit = 3;',
    'export class Client {}',
    'export function read() {}',
    "export * from './client.js';",
    "import './polyfill.js';",
    "import { GezelApiError } from './api-error.js';",
    'export enum Mode { A }',
  ]) {
    assert.equal(hasRuntimeCode(`export interface X {}\n${runtime}`), true, runtime);
  }
  assert.equal(hasRuntimeCode('export const View = () => <div />;', 'View.tsx'), true);
});

test('leaves out a shim that only forwards another package', () => {
  // Its code and its tests live in the package it forwards, which counts them.
  const shim = [
    '// Moved to core so the portable runtime runs the same loop.',
    "export * from '@bendyline/gezel/local-loop';",
    "export { apiErrorMessage } from '@bendyline/gezel-client';",
  ].join('\n');
  assert.equal(hasRuntimeCode(shim), false);
  // A local re-export is this package's own code.
  assert.equal(hasRuntimeCode(`${shim}\nexport * from './client.js';`), true);
  assert.equal(hasRuntimeCode(`${shim}\nexport const limit = 3;`), true);
});
