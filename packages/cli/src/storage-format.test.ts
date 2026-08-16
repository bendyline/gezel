import type { StorageJob, StorageSummary } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatCleanupPreview,
  formatCleanupResult,
  formatStorageSummary,
  resolveCleanupSelection,
} from './storage-format.js';

function summary(overrides: Partial<StorageSummary> = {}): StorageSummary {
  return {
    home: '/home/someone/.gezel',
    measuredAt: '2026-08-16T12:00:00.000Z',
    redownloadableBytes: 0,
    userContentBytes: 0,
    categories: [],
    ...overrides,
  };
}

function category(over: Partial<StorageSummary['categories'][number]>) {
  return {
    id: 'models' as const,
    class: 'redownloadable' as const,
    label: 'Downloaded models',
    description: 'Model weights.',
    bytes: 0,
    itemCount: 0,
    deletable: true,
    inBackup: false,
    external: [],
    ...over,
  };
}

describe('formatBytes', () => {
  it('scales to the unit a person would say out loud', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024 * 4)).toBe('4 KB');
    expect(formatBytes(1024 ** 2 * 7)).toBe('7 MB');
    expect(formatBytes(1024 ** 3 * 2.5)).toBe('2.5 GB');
  });
});

describe('formatStorageSummary', () => {
  it('separates what can be re-downloaded from what cannot', () => {
    const out = formatStorageSummary(
      summary({
        redownloadableBytes: 1024 ** 3 * 60,
        userContentBytes: 1024 ** 2 * 40,
        categories: [
          category({ bytes: 1024 ** 3 * 60 }),
          category({
            id: 'gezels',
            class: 'user-content',
            label: 'Gezels',
            description: 'Your gezels.',
            bytes: 1024 ** 2 * 40,
            inBackup: true,
          }),
        ],
      }),
    );

    expect(out).toContain('Can be downloaded again:');
    expect(out).toContain('60.0 GB Downloaded models');
    expect(out).toContain('Your content:');
    expect(out).toContain('40 MB Gezels');
    expect(out).toContain('Total: 60.0 GB re-downloadable, 40 MB your content');
  });

  it('omits groups and categories with nothing in them', () => {
    const out = formatStorageSummary(summary({ categories: [category({ bytes: 0 })] }));
    expect(out).not.toContain('Can be downloaded again:');
    expect(out).not.toContain('Downloaded models');
  });

  it('calls out folders Gezel will never delete', () => {
    const out = formatStorageSummary(
      summary({
        userContentBytes: 900,
        categories: [
          category({
            id: 'projects',
            class: 'user-content',
            label: 'Projects',
            description: 'Your projects.',
            bytes: 900,
            external: [{ path: '/Users/someone/code/repo', bytes: 900 }],
          }),
        ],
      }),
    );
    expect(out).toContain('Stored outside the Gezel folder — never removed by Gezel:');
    expect(out).toContain('/Users/someone/code/repo');
  });
});

describe('resolveCleanupSelection', () => {
  it('returns nothing when no flag was passed', () => {
    // The bare command shows the summary rather than guessing what to delete.
    expect(resolveCleanupSelection({})).toEqual({
      categories: [],
      destroysUserContent: false,
    });
  });

  it('expands --redownloadable to everything Gezel can fetch again', () => {
    const { categories, destroysUserContent } = resolveCleanupSelection({ redownloadable: true });
    expect(categories).toContain('models');
    expect(categories).toContain('native-engines');
    expect(categories).toContain('toolsets');
    expect(destroysUserContent).toBe(false);
    // Never any of the user's own work, whatever else this grows to include.
    for (const id of ['gezels', 'projects', 'documents', 'settings', 'secrets']) {
      expect(categories).not.toContain(id);
    }
  });

  it('never includes what the daemon runs from', () => {
    const { categories } = resolveCleanupSelection({ redownloadable: true });
    for (const id of ['service-bundle', 'runtimes', 'git-clones']) {
      expect(categories).not.toContain(id);
    }
  });

  it('combines individual flags without duplicating categories', () => {
    const { categories } = resolveCleanupSelection({ models: true, engines: true, caches: true });
    expect(new Set(categories).size).toBe(categories.length);
    expect(categories).toContain('models');
    expect(categories).toContain('engine-caches');
  });

  it('marks --content as destroying user content', () => {
    const { categories, destroysUserContent } = resolveCleanupSelection({ content: 'gezels' });
    expect(categories).toEqual(['gezels']);
    expect(destroysUserContent).toBe(true);
  });

  it('treats --content all as every user-content category', () => {
    const { categories } = resolveCleanupSelection({ content: 'all' });
    expect(categories).toEqual(['gezels', 'projects', 'documents', 'settings']);
  });

  it('rejects an unknown --content value by name', () => {
    expect(() => resolveCleanupSelection({ content: 'everything' })).toThrow(
      /Unknown --content value "everything"/,
    );
  });
});

describe('formatCleanupPreview', () => {
  it('totals the selection and warns when it includes the user’s own work', () => {
    const out = formatCleanupPreview(
      summary({
        categories: [
          category({ bytes: 1024 ** 3 * 3 }),
          category({
            id: 'gezels',
            class: 'user-content',
            label: 'Gezels',
            description: 'Your gezels.',
            bytes: 1024 ** 2,
            inBackup: true,
          }),
        ],
      }),
      ['models', 'gezels'],
    );
    expect(out).toContain('3.0 GB Downloaded models');
    expect(out).toContain('WARNING: this includes content only you have');
  });

  it('stays quiet about warnings for a downloads-only selection', () => {
    const out = formatCleanupPreview(summary({ categories: [category({ bytes: 1024 ** 3 })] }), [
      'models',
    ]);
    expect(out).toContain('Frees about 1.0 GB.');
    expect(out).not.toContain('WARNING');
  });

  it('lists external folders as untouched', () => {
    const out = formatCleanupPreview(
      summary({
        categories: [
          category({
            id: 'projects',
            class: 'user-content',
            label: 'Projects',
            description: 'Your projects.',
            bytes: 500,
            external: [{ path: '/Users/someone/code/repo', bytes: 500 }],
          }),
        ],
      }),
      ['projects'],
    );
    expect(out).toContain('Not touched (stored outside the Gezel folder):');
    expect(out).toContain('/Users/someone/code/repo');
  });
});

describe('formatCleanupResult', () => {
  const job = (over: Partial<StorageJob> = {}): StorageJob => ({
    id: 'j1',
    kind: 'cleanup',
    status: 'done',
    itemsDone: 3,
    totalItems: 3,
    bytesDone: 1024 ** 3 * 12,
    totalBytes: 1024 ** 3 * 12,
    startedAt: '2026-08-16T12:00:00.000Z',
    restartRequired: false,
    cancelRequested: false,
    skippedExternal: [],
    ...over,
  });

  it('reports what was freed', () => {
    expect(formatCleanupResult(job())).toContain('Freed 12.0 GB across 3 item(s).');
  });

  it('names the failure when a run errored', () => {
    expect(formatCleanupResult(job({ status: 'error', error: 'a chat is still replying' }))).toBe(
      'Cleanup failed: a chat is still replying',
    );
  });

  it('says how far a cancelled run got', () => {
    expect(formatCleanupResult(job({ status: 'cancelled' }))).toContain('stopped early');
  });

  it('lists folders it deliberately left alone', () => {
    const out = formatCleanupResult(
      job({ skippedExternal: [{ label: 'Linked working folder', path: '/Users/x/repo' }] }),
    );
    expect(out).toContain('Left alone (stored outside the Gezel folder):');
    expect(out).toContain('/Users/x/repo');
  });
});
