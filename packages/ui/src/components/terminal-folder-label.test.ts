import { describe, expect, it } from 'vitest';
import { formatFolderLabel } from './terminal-folder-label.js';

describe('formatFolderLabel', () => {
  it('formats project-relative and absolute paths', () => {
    expect(formatFolderLabel('')).toBe('/');
    expect(formatFolderLabel('packages/ui')).toBe('/packages/ui');
    expect(formatFolderLabel('/tmp/demo')).toBe('/tmp/demo');
    expect(formatFolderLabel('D:\\gh\\gezel')).toBe('D:\\gh\\gezel');
  });

  it('removes persisted terminal color bytes from Windows paths', () => {
    expect(formatFolderLabel('D:\\gh\\gezel\x1b[93m')).toBe('D:\\gh\\gezel');
    expect(formatFolderLabel('D:\\gh\\gezel\uFFFD[93m')).toBe('D:\\gh\\gezel');
  });
});
