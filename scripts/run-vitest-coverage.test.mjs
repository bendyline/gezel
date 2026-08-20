import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeSummary,
  parseArgs,
  thresholdFailures,
  validateTargets,
} from './run-vitest-coverage.mjs';

test('parses report-only and targeted package arguments', () => {
  assert.deepEqual(parseArgs(['--report-only', '--package', 'ui', '--package', 'service']), {
    reportOnly: true,
    packageIds: ['ui', 'service'],
  });
});

test('normalizes V8 totals and reports metrics below their package floors', () => {
  const target = {
    id: 'fixture',
    root: 'packages/fixture',
    thresholds: { statements: 80, branches: 70, functions: 60, lines: 80 },
  };
  const summary = normalizeSummary(target, {
    total: {
      statements: { total: 100, covered: 81, pct: 81 },
      branches: { total: 100, covered: 69, pct: 69 },
      functions: { total: 100, covered: 60, pct: 60 },
      lines: { total: 100, covered: 79, pct: 79 },
    },
  });

  assert.deepEqual(thresholdFailures(summary), [
    'fixture branches: 69.00% < 70.00%',
    'fixture lines: 79.00% < 80.00%',
  ]);
});

test('rejects a target whose executable coverage floor is missing or invalid', () => {
  assert.deepEqual(
    validateTargets([
      {
        id: 'fixture',
        thresholds: { statements: 80, branches: -1, functions: 101 },
      },
    ]),
    [
      'fixture: branches threshold must be a number from 0 to 100',
      'fixture: functions threshold must be a number from 0 to 100',
      'fixture: lines threshold must be a number from 0 to 100',
    ],
  );
});
