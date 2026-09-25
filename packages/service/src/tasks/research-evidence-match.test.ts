import { describe, expect, it } from 'vitest';
import {
  EXACT_SOURCE_READ_TOOLS,
  isExactLocalSourceRead,
  normalizeSourcePath,
} from './research-evidence-match.js';

describe('isExactLocalSourceRead', () => {
  // The whole reason this module exists. Wild-caught on the first
  // binary-source PowerPoint trial: powerpoint-deck's research step says "use
  // `read_doc_as_markdown` for DOCX/PPTX/PDF/XLSX", the researcher did, and
  // the gate answered "No verifiable source acquisition ran during this step"
  // three times until the step plateaued and the task paused with no deck.
  it('accepts the document reader for a binary source', () => {
    expect(
      isExactLocalSourceRead(
        { tool: 'read_doc_as_markdown', path: 'source/halvard-brief.docx' },
        'source/halvard-brief.docx',
      ),
    ).toBe(true);
  });

  it('still accepts the text reader', () => {
    expect(
      isExactLocalSourceRead({ tool: 'read_file', path: 'source/brief.md' }, 'source/brief.md'),
    ).toBe(true);
  });

  it('accepts a batch read that included the source', () => {
    expect(
      isExactLocalSourceRead(
        { tool: 'read_files', paths: ['docs/other.md', 'source/brief.md'] },
        'source/brief.md',
      ),
    ).toBe(true);
  });

  it('rejects a read of a different, similarly named file', () => {
    // The book's own rule: never replace a named source with a similar one.
    expect(
      isExactLocalSourceRead(
        { tool: 'read_doc_as_markdown', path: 'source/kelby-brief.docx' },
        'source/halvard-brief.docx',
      ),
    ).toBe(false);
  });

  it('rejects tools that prove a match but not that content was taken in', () => {
    for (const tool of ['grep_files', 'find_files', 'stat', 'list_dir']) {
      expect(isExactLocalSourceRead({ tool, path: 'source/brief.md' }, 'source/brief.md')).toBe(
        false,
      );
    }
  });

  it('never matches an empty expectation', () => {
    // A topic-only run has no named source; evidence must come from the
    // external-acquisition branch instead, never from any local read.
    expect(isExactLocalSourceRead({ tool: 'read_file', path: 'anything.md' }, '')).toBe(false);
  });

  it('normalizes separators, case, and the workspace/ and ./ prefixes', () => {
    expect(
      isExactLocalSourceRead(
        { tool: 'read_doc_as_markdown', path: 'workspace\\Source\\Brief.DOCX' },
        './source/brief.docx',
      ),
    ).toBe(true);
  });

  it('keeps the reader set to the tools that actually open a source', () => {
    expect([...EXACT_SOURCE_READ_TOOLS].sort()).toEqual([
      'read_artifact',
      'read_doc_as_markdown',
      'read_file',
    ]);
  });

  it('counts a read of any file inside a source folder — a craftbook input', () => {
    expect(
      isExactLocalSourceRead(
        { tool: 'read_artifact', path: 'tasks/7/inputs/source/ch1.md' },
        'tasks/7/inputs/source',
      ),
    ).toBe(true);
    expect(
      isExactLocalSourceRead({ tool: 'read_files', paths: ['notes/part/ch2.md'] }, 'notes'),
    ).toBe(true);
    // A sibling whose name merely starts the same is not inside the folder.
    expect(isExactLocalSourceRead({ tool: 'read_file', path: 'notes-old/ch1.md' }, 'notes')).toBe(
      false,
    );
  });
});

describe('normalizeSourcePath', () => {
  it('is stable for the shapes different tools report', () => {
    const canonical = normalizeSourcePath('source/brief.md');
    for (const variant of [
      'source/brief.md',
      './source/brief.md',
      'workspace/source/brief.md',
      'Source/Brief.MD',
      '  source\\brief.md  ',
    ]) {
      expect(normalizeSourcePath(variant)).toBe(canonical);
    }
  });

  it('treats a missing path as no path', () => {
    expect(normalizeSourcePath(undefined)).toBe('');
  });
});
