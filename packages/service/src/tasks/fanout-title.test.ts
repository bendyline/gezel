import { describe, expect, it } from 'vitest';
import { deriveFanoutChildTitle } from './fanout-title.js';

describe('deriveFanoutChildTitle', () => {
  it('describes a pull-request review batch by range, first path, and remaining count', () => {
    expect(
      deriveFanoutChildTitle({
        batchNumber: '3',
        start: '17',
        end: '24',
        paths: JSON.stringify([
          'packages/service/src/tasks/manager.ts',
          'packages/service/src/product-service.ts',
          'packages/ui/src/views/TaskDetail.tsx',
        ]),
      }),
    ).toBe('Review batch 3 — files 17–24: packages/service/src/tasks/manager.ts + 2 more');
  });

  it('names a single-file review batch without a misleading plural or remainder', () => {
    expect(
      deriveFanoutChildTitle({
        batchNumber: '4',
        start: '25',
        end: '25',
        paths: JSON.stringify(['packages/core/src/schemas/task.ts']),
      }),
    ).toBe('Review batch 4 — file 25: packages/core/src/schemas/task.ts');
  });

  it('falls back to the item count when the batch has no ordinal range', () => {
    expect(
      deriveFanoutChildTitle({
        batchNumber: '2',
        paths: JSON.stringify(['src/a.ts', 'src/b.ts']),
      }),
    ).toBe('Review batch 2 — 2 files: src/a.ts + 1 more');
  });

  it('preserves invoice fanout titles', () => {
    expect(deriveFanoutChildTitle({ number: '2026-042', client: 'Harbor & Pine' })).toBe(
      'Invoice 2026-042 — Harbor & Pine',
    );
  });

  it('does not infer a review title from malformed paths', () => {
    expect(deriveFanoutChildTitle({ batchNumber: '3', paths: 'not json' })).toBeUndefined();
  });
});
