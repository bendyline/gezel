import { describe, expect, it } from 'vitest';
import {
  binaryDocumentContainer,
  isBinaryDocumentPath,
  verifyBinaryDocumentBytes,
} from './binary-document.js';
import { completionGate } from './deliverable.js';

const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const PDF = new TextEncoder().encode('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
const GIF = new TextEncoder().encode('GIF89a....');
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
const MARKDOWN = new TextEncoder().encode('# Slide one\n\n---\n\n# Slide two\n');

describe('binary document classification', () => {
  it.each([
    ['deck.pptx', 'zip'],
    ['report.docx', 'zip'],
    ['model.xlsx', 'zip'],
    ['book.epub', 'zip'],
    ['bundle.dbk', 'zip'],
    ['report.pdf', 'pdf'],
    ['loop.gif', 'gif'],
    ['clip.mp4', 'mp4'],
  ])('maps %s to the %s container', (path, container) => {
    expect(binaryDocumentContainer(path)).toBe(container);
    expect(isBinaryDocumentPath(path)).toBe(true);
  });

  it('leaves text deliverables alone', () => {
    for (const path of ['report.md', 'data.csv', 'index.html', 'notes']) {
      expect(isBinaryDocumentPath(path)).toBe(false);
      expect(binaryDocumentContainer(path)).toBeNull();
    }
  });
});

describe('binary document verification', () => {
  it.each([
    ['deck.pptx', ZIP],
    ['report.pdf', PDF],
    ['loop.gif', GIF],
    ['clip.mp4', MP4],
  ])('accepts real %s bytes', (path, bytes) => {
    expect(verifyBinaryDocumentBytes(path, bytes).ok).toBe(true);
  });

  it('rejects the Markdown source renamed to a binary path', () => {
    // The exact substitution the DocBlocks repair directive warns about,
    // and the one a byte floor alone waved through.
    const verdict = verifyBinaryDocumentBytes('deliverables/deck.pptx', MARKDOWN);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toMatch(/not a real ZIP container/);
    expect(verdict.detail).toMatch(/it is text starting "# Slide one/);
  });

  it('rejects a container of the wrong type', () => {
    expect(verifyBinaryDocumentBytes('report.pdf', ZIP).ok).toBe(false);
    expect(verifyBinaryDocumentBytes('deck.pptx', PDF).ok).toBe(false);
  });

  it('rejects empty and truncated files', () => {
    expect(verifyBinaryDocumentBytes('deck.pptx', new Uint8Array()).ok).toBe(false);
    expect(verifyBinaryDocumentBytes('deck.pptx', ZIP.slice(0, 2)).ok).toBe(false);
  });
});

describe('deliverable gates on binary paths', () => {
  it('does not grep a DOCX for Markdown headings', () => {
    // Regression: `markdown-report` emitted checkContains for
    // `(?:^|\n)#{1,3}\s+\S`, which REJECTS a real DOCX (a ZIP) and ACCEPTS
    // the Markdown source renamed to `.docx`.
    const gate = completionGate({ path: 'report.docx', kind: 'markdown-report' }, 'step', 1);
    expect(gate.scripts ?? []).toEqual([]);
  });

  it('does not grep a PPTX for slide markers', () => {
    const gate = completionGate({ path: 'deck.pptx', kind: 'slide-deck' }, 'step', 1);
    expect(gate.scripts ?? []).toEqual([]);
    expect(gate.checks).toEqual([{ kind: 'minBytes', file: 'deck.pptx', bytes: 1000 }]);
  });

  it('keeps the text gates for the Markdown source beside the binary', () => {
    const gate = completionGate({ path: 'deck.md', kind: 'slide-deck' }, 'step', 1);
    expect(gate.scripts?.length ?? 0).toBeGreaterThan(0);
  });

  it('honors an explicit minBytes override on a binary path', () => {
    const gate = completionGate(
      { path: 'deck.pptx', kind: 'slide-deck', minBytes: 4096 },
      'step',
      1,
    );
    expect(gate.checks).toEqual([{ kind: 'minBytes', file: 'deck.pptx', bytes: 4096 }]);
  });
});
