import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveSourceImport } from './check-test-surface.mjs';

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
