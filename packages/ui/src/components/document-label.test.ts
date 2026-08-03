import { describe, expect, it } from 'vitest';
import { documentLabel } from './document-label.js';

describe('documentLabel', () => {
  it('hides the markdown extension', () => {
    expect(documentLabel('test.md')).toBe('test');
    expect(documentLabel('Mission Statement.MD')).toBe('Mission Statement');
    expect(documentLabel('notes.markdown')).toBe('notes');
  });

  it('keeps any other extension', () => {
    expect(documentLabel('budget.csv')).toBe('budget.csv');
    expect(documentLabel('diagram.svg')).toBe('diagram.svg');
    expect(documentLabel('archive.md.bak')).toBe('archive.md.bak');
  });

  it('leaves names without an extension alone', () => {
    expect(documentLabel('guidelines')).toBe('guidelines');
  });

  it('keeps a name that is nothing but the extension', () => {
    expect(documentLabel('.md')).toBe('.md');
  });
});
