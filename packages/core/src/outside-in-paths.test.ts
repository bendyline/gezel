import { describe, expect, it } from 'vitest';
import { isOutsideInInternalPath } from './outside-in-paths.js';

describe('isOutsideInInternalPath', () => {
  it.each([
    'brief_files',
    'brief_files/brief.md',
    'reports/brief_FILES/.original/original.docx',
    '_squisq/squisq-player.js',
    'reports\\deck_files\\deck.md',
  ])('recognizes managed path %s', (path) => {
    expect(isOutsideInInternalPath(path)).toBe(true);
  });

  it.each(['brief.docx', 'reports/brief.md', 'files/notes.md', 'my_files.txt'])(
    'keeps visible path %s',
    (path) => {
      expect(isOutsideInInternalPath(path)).toBe(false);
    },
  );
});
