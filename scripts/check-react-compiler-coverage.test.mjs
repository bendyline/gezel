import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateCompilerCoverage } from './check-react-compiler-coverage.mjs';

const report = (files, compiled = 10) => ({ compiled, skipped: 0, files });

test('passes when every required function compiled', () => {
  const failures = evaluateCompilerCoverage(
    report({
      'src/a.tsx': { compiled: [{ fn: 'A' }], skipped: [] },
      'src/b.tsx': { compiled: [{ fn: 'B' }], skipped: [{ fn: 'helper', reason: 'refs' }] },
      'src/primitives/X.tsx': { compiled: [{ fn: 'X' }], skipped: [] },
    }),
    { 'src/a.tsx': 'all', 'src/b.tsx': ['B'], 'src/primitives/': 'all' },
    1,
  );
  assert.deepEqual(failures, []);
});

test('names the function and the reason when a required one stops compiling', () => {
  const failures = evaluateCompilerCoverage(
    report({
      'src/a.tsx': {
        compiled: [],
        skipped: [{ fn: 'A', line: 4, reason: 'Handle TryStatement with a finalizer' }],
      },
      'src/b.tsx': { compiled: [], skipped: [{ fn: 'B', reason: 'Handle Import expressions' }] },
    }),
    { 'src/a.tsx': 'all', 'src/b.tsx': ['B'], 'src/missing.tsx': 'all' },
    1,
  );
  assert.equal(failures.length, 4);
  assert.match(failures.join('\n'), /src\/a\.tsx:4 A not compiled: Handle TryStatement/);
  assert.match(failures.join('\n'), /src\/b\.tsx: B not compiled: Handle Import expressions/);
  assert.match(failures.join('\n'), /src\/missing\.tsx: not in the compiler report/);
});

test('fails a build that compiled almost nothing', () => {
  const failures = evaluateCompilerCoverage(report({}, 3), {}, 100);
  assert.deepEqual(failures, ['only 3 functions compiled (floor 100)']);
});
