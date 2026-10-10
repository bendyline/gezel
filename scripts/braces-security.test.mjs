import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';

const service = createRequire(new URL('../packages/service/package.json', import.meta.url));
const glob = createRequire(service.resolve('fast-glob'));
const micromatch = createRequire(glob.resolve('micromatch'));
const bracesPath = micromatch.resolve('braces');
const braces = micromatch('braces');

test('patched braces rejects hostile strings and supplied ASTs before stack exhaustion', () => {
  // A subprocess timeout contains regressions to the unbounded upstream code.
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `
    const assert = require('node:assert/strict');
    const braces = require(process.argv[1]);
    const bounded = error => error instanceof RangeError && /nesting exceeds the safety limit/.test(error.message);
    for (const pattern of [
      '{'.repeat(4000) + 'x' + '}'.repeat(4000),
      '('.repeat(4000) + 'x' + ')'.repeat(4000),
      '{('.repeat(2000) + 'x' + ')}'.repeat(2000),
      '{'.repeat(4000) + 'x',
    ]) {
      for (const method of ['parse', 'compile', 'expand', 'stringify']) {
        assert.throws(() => braces[method](pattern), bounded);
      }
      assert.throws(() => braces(pattern), bounded);
      assert.throws(() => braces(pattern, { expand: true }), bounded);
    }
    for (const method of ['compile', 'expand', 'stringify']) {
      let ast = { type: 'text', value: 'x' };
      for (let i = 0; i < 10000; i++) ast = { type: 'root', nodes: [ast] };
      assert.throws(() => braces[method](ast), bounded);
    }
  `,
      bracesPath,
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
});

test('patched braces preserves ordinary alternatives, ranges, literals and nested globs', () => {
  assert.deepEqual(braces.expand('src/{core,{service,mcp}}/file-{1..2}.ts'), [
    'src/core/file-1.ts',
    'src/core/file-2.ts',
    'src/service/file-1.ts',
    'src/service/file-2.ts',
    'src/mcp/file-1.ts',
    'src/mcp/file-2.ts',
  ]);
  assert.equal(braces.compile('**/*.{ts,tsx}'), '**/*.(ts|tsx)');
  assert.equal(braces.stringify(braces.parse('src/{core,mcp}/**/*.ts')), 'src/{core,mcp}/**/*.ts');
  assert.deepEqual(braces.expand('"{literal,braces}"'), ['{literal,braces}']);
  assert.deepEqual(glob('micromatch')(['a.ts', 'a.tsx', 'a.js'], '**/*.{ts,tsx}'), [
    'a.ts',
    'a.tsx',
  ]);
});
