import { describe, expect, it } from 'vitest';
import {
  INDEXING_RECEIPT_GAP_MS,
  indexedPathFromActivity,
  readIndexingReceipts,
  recordIndexedFile,
  writeIndexingReceipts,
} from './IndexingReceipt.js';

const base = Date.parse('2026-09-03T12:00:00.000Z');

function completed(
  sessionId: string,
  path: string,
  offsetMs: number,
  overrides?: { gezelId?: string; projectId?: string },
) {
  return {
    sessionId,
    gezelId: overrides?.gezelId ?? 'boekwachter',
    projectId: overrides?.projectId ?? 'workshop',
    path,
    startedAt: new Date(base + offsetMs - 2_000).toISOString(),
    completedAt: new Date(base + offsetMs).toISOString(),
  };
}

describe('indexing receipts', () => {
  it('recognizes only per-file indexing activity labels', () => {
    expect(indexedPathFromActivity('Indexing src/app.ts')).toBe('src/app.ts');
    expect(indexedPathFromActivity('  indexing   docs/readme.md  ')).toBe('docs/readme.md');
    expect(indexedPathFromActivity('Reviewing src/app.ts')).toBeNull();
    expect(indexedPathFromActivity(undefined)).toBeNull();
  });

  it('groups nearby files by worker and project and de-duplicates repeated passes', () => {
    let receipts = recordIndexedFile([], completed('one', 'src/app.ts', 0));
    receipts = recordIndexedFile(receipts, completed('two', 'src/lib.ts', 2_000));
    const beforeDuplicate = receipts;
    receipts = recordIndexedFile(receipts, completed('three', 'src/app.ts', 4_000));

    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.files).toEqual(['src/app.ts', 'src/lib.ts']);
    expect(receipts).toBe(beforeDuplicate);
  });

  it('starts a new receipt after a quiet gap or when the owner changes', () => {
    let receipts = recordIndexedFile([], completed('one', 'src/app.ts', 0));
    receipts = recordIndexedFile(
      receipts,
      completed('two', 'src/later.ts', INDEXING_RECEIPT_GAP_MS + 1),
    );
    receipts = recordIndexedFile(
      receipts,
      completed('three', 'src/other.ts', INDEXING_RECEIPT_GAP_MS + 2, {
        projectId: 'other-project',
      }),
    );

    expect(receipts).toHaveLength(3);
    expect(receipts.map((receipt) => receipt.files)).toEqual([
      ['src/app.ts'],
      ['src/later.ts'],
      ['src/other.ts'],
    ]);
  });

  it('round-trips the bounded receipt ledger for a timeline scope', () => {
    window.localStorage.clear();
    const receipts = recordIndexedFile([], completed('one', 'src/app.ts', 0));
    writeIndexingReceipts('project:workshop', receipts);

    expect(readIndexingReceipts('project:workshop')).toEqual(receipts);
    expect(readIndexingReceipts('project:elsewhere')).toEqual([]);
  });
});
