import { describe, expect, it } from 'vitest';
import { fileManagerLabel, openInFileManagerLabel } from './file-manager-label.js';

describe('file manager labels', () => {
  it.each([
    ['darwin', 'Finder'],
    ['win32', 'File Explorer'],
    ['linux', 'file manager'],
    [undefined, 'file manager'],
  ])('uses the expected name for %s', (platform, expected) => {
    expect(fileManagerLabel(platform)).toBe(expected);
    expect(openInFileManagerLabel(platform)).toBe(`Open in ${expected}`);
  });
});
