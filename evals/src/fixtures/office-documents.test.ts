/**
 * Structural validation of the source-document fixtures.
 *
 * These assert the containers are well-formed and carry their text — in
 * particular that the PDF xref offsets point at the objects they claim, which
 * is the one defect that silently makes a PDF unreadable and the reason the
 * offsets are computed rather than written down.
 *
 * They deliberately do NOT call the product's extractor: it lives behind
 * `packages/service`'s closed export map, and widening a published contract
 * for a test is the wrong trade. The round trip through the real sandbox
 * parser is proven where it actually matters — in the trial, by the
 * `researchEvidence` gate requiring a successful `read_doc_as_markdown` on the
 * exact seeded path (see powerpoint-sources.ts).
 */

import { describe, expect, it } from 'vitest';
import { type DocumentBlock, buildDocx, buildMarkdown, buildPdf } from './office-documents.ts';

const BLOCKS: readonly DocumentBlock[] = [
  { style: 'h1', text: 'Halvard Terminal — Winter Boarding Pilot' },
  { style: 'bullet', text: 'Mean boarding time fell from 21.4 minutes to 12.8 minutes.' },
  { style: 'bullet', text: 'Missed-sailing rate fell from 6.7% to 2.1%.' },
  { style: 'p', text: 'Quotes "like this" & ampersands <must> survive.' },
];

/** Read a stored-ZIP's entries back out. Mirrors what any unzipper does. */
function readStoredZip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const out = new Map<string, string>();
  let cursor = 0;
  while (cursor + 30 <= bytes.length && view.getUint32(cursor, true) === 0x04034b50) {
    const size = view.getUint32(cursor + 18, true);
    const nameLength = view.getUint16(cursor + 26, true);
    const extraLength = view.getUint16(cursor + 28, true);
    const nameStart = cursor + 30;
    const dataStart = nameStart + nameLength + extraLength;
    out.set(
      decoder.decode(bytes.subarray(nameStart, nameStart + nameLength)),
      decoder.decode(bytes.subarray(dataStart, dataStart + size)),
    );
    cursor = dataStart + size;
  }
  return out;
}

describe('buildDocx', () => {
  const bytes = buildDocx(BLOCKS);
  const entries = readStoredZip(bytes);

  it('is a ZIP carrying the OOXML parts a Word reader looks for', () => {
    expect(bytes[0]).toBe(0x50); // 'P'
    expect(bytes[1]).toBe(0x4b); // 'K'
    expect([...entries.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/_rels/document.xml.rels',
    ]);
  });

  it('carries every figure the deck must preserve', () => {
    const document = entries.get('word/document.xml') ?? '';
    for (const needle of ['Halvard Terminal', '21.4', '12.8', '6.7', '2.1']) {
      expect(document).toContain(needle);
    }
  });

  it('escapes XML metacharacters instead of corrupting the part', () => {
    const document = entries.get('word/document.xml') ?? '';
    expect(document).toContain('&amp;');
    expect(document).toContain('&lt;must&gt;');
    expect(document).toContain('&quot;like this&quot;');
    // A raw `<must>` would have opened a bogus element and broken the parse.
    expect(document).not.toContain('<must>');
  });

  it('is byte-deterministic', () => {
    expect(Buffer.from(buildDocx(BLOCKS))).toEqual(Buffer.from(bytes));
  });
});

describe('buildPdf', () => {
  const bytes = buildPdf(BLOCKS);
  const text = Buffer.from(bytes).toString('latin1');

  it('has the header, trailer, and terminator a parser requires', () => {
    expect(text.startsWith('%PDF-1.7')).toBe(true);
    expect(text).toContain('/Type /Catalog');
    expect(text).toContain('trailer');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('points every xref offset at the object it claims', () => {
    const startxref = Number(/startxref\n(\d+)/.exec(text)?.[1]);
    expect(Number.isFinite(startxref)).toBe(true);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');

    const offsets = [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((offset, index) => {
      // Object N must actually begin at the byte the table advertises —
      // the desync that makes a structurally "fine" PDF fail to open.
      expect(text.slice(offset, offset + 8)).toMatch(new RegExp(`^${index + 1} 0 obj`));
    });
  });

  it('declares a font resource for its text operators', () => {
    // Content-stream Tj with no /Font resource extracts as nothing.
    expect(text).toContain('/F1 5 0 R');
    expect(text).toContain('/BaseFont /Helvetica');
  });

  it('carries every figure the deck must preserve', () => {
    for (const needle of ['Halvard Terminal', '21.4', '12.8', '6.7', '2.1']) {
      expect(text).toContain(needle);
    }
  });

  it('declares a stream Length matching the real content bytes', () => {
    const declared = Number(/\/Length (\d+) >>\nstream\n/.exec(text)?.[1]);
    const stream = /stream\n([\s\S]*?)\nendstream/.exec(text)?.[1] ?? '';
    expect(stream.length).toBe(declared);
  });

  it('transliterates punctuation it has no font program for', () => {
    expect(text).toContain('Halvard Terminal - Winter Boarding Pilot');
    expect(text).not.toContain('—');
  });

  it('is byte-deterministic', () => {
    expect(Buffer.from(buildPdf(BLOCKS))).toEqual(Buffer.from(bytes));
  });
});

describe('buildMarkdown', () => {
  it('renders the same blocks as the control arm', () => {
    const md = buildMarkdown(BLOCKS);
    expect(md).toContain('# Halvard Terminal — Winter Boarding Pilot');
    expect(md).toContain('- Mean boarding time fell from 21.4 minutes to 12.8 minutes.');
  });
});
