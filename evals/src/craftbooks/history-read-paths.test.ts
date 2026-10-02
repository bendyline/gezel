import { describe, expect, it } from 'vitest';
import { historyReadPaths } from './scenario.ts';

const SEEDED = ['src/payment.js', 'docs/review-conventions.md', 'source/brief.md'];

const call = (details: Record<string, unknown>) => ({
  entryType: 'event',
  kind: 'tool.called',
  details,
});

describe('historyReadPaths', () => {
  it('sees reads an in-flight turn has not persisted yet', () => {
    const read = historyReadPaths(
      [
        call({ name: 'read_file', success: true, path: 'src/payment.js' }),
        call({ name: 'read_files', success: true, paths: ['docs/review-conventions.md'] }),
      ],
      SEEDED,
    );
    expect([...read].sort()).toEqual(['docs/review-conventions.md', 'src/payment.js']);
  });

  it('ignores failed reads, non-read tools, and other entry kinds', () => {
    const read = historyReadPaths(
      [
        call({ name: 'read_file', success: false, path: 'src/payment.js' }),
        call({ name: 'write_file', success: true, path: 'source/brief.md' }),
        { entryType: 'event', kind: 'workspace.write', details: { path: 'src/payment.js' } },
      ],
      SEEDED,
    );
    expect(read.size).toBe(0);
  });
});
