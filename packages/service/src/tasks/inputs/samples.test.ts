import { describe, expect, it } from 'vitest';
import { catalogSampleReader, sampleCommonDir } from './samples.js';

describe('sampleCommonDir', () => {
  it('strips the folder every file shares', () => {
    expect(sampleCommonDir(['samples/team-sync/notes.md'])).toBe('samples/team-sync/');
    expect(sampleCommonDir(['samples/app/src/a.js', 'samples/app/README.md'])).toBe('samples/app/');
    expect(sampleCommonDir(['samples/notes.md', 'samples/x/y.md'])).toBe('samples/');
  });
});

describe('catalogSampleReader', () => {
  const sample = {
    id: 'team-sync',
    title: 'notes',
    param: 'source',
    files: ['samples/team-sync/notes.md'],
  };

  it('reads from the source the book came from, never for a project or local copy', async () => {
    const calls: unknown[][] = [];
    const reader = catalogSampleReader({
      readItemFile: async (...args: unknown[]) => {
        calls.push(args);
        return Buffer.from('# Notes');
      },
    } as never);
    const read = await reader.read({
      craftbookId: 'notes-book',
      sourceId: 'bundled',
      version: '1.0.0',
      sample,
    });
    expect(read).toEqual([{ rel: 'notes.md', bytes: new Uint8Array(Buffer.from('# Notes')) }]);
    expect(calls[0]).toEqual([
      'craftbook-template',
      'notes-book',
      'samples/team-sync/notes.md',
      'bundled',
      '1.0.0',
    ]);
    expect(
      await reader.read({ craftbookId: 'notes-book', sourceId: 'project', sample }),
    ).toBeNull();
    expect(calls).toHaveLength(1);
  });
});
