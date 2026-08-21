import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adjacentDocFilesPaths, chunkMarkdown, shadowDocFilesPaths } from './docs.js';

const ART = join(sep, 'home', 'proj', 'artifacts');

describe('shadowDocFilesPaths', () => {
  it('keys the companion dir by the full basename so sibling formats never collide', () => {
    const docx = shadowDocFilesPaths(ART, 'docs/architecture.docx')!;
    const pdf = shadowDocFilesPaths(ART, 'docs/architecture.pdf')!;
    expect(docx.mdRel).toBe('shadow/docs/architecture.docx_files/architecture.md');
    expect(pdf.mdRel).toBe('shadow/docs/architecture.pdf_files/architecture.md');
    expect(docx.mdPath).not.toBe(pdf.mdPath);
    expect(docx.dir).toBe(join(ART, 'shadow', 'docs', 'architecture.docx_files'));
  });

  it('maps root-level sources without a phantom parent segment', () => {
    const paths = shadowDocFilesPaths(ART, 'brief.pptx')!;
    expect(paths.mdRel).toBe('shadow/brief.pptx_files/brief.md');
  });

  it('rejects sources that cannot map to a safe companion path', () => {
    expect(shadowDocFilesPaths(ART, '../escape.docx')).toBeNull();
    expect(shadowDocFilesPaths(ART, 'docs/../../escape.docx')).toBeNull();
  });
});

describe('adjacentDocFilesPaths', () => {
  it('keeps the user-visible stem-keyed placement beside the source', () => {
    const paths = adjacentDocFilesPaths(ART, 'decks/brief.pptx');
    expect(paths.mdRel).toBe('decks/brief_files/brief.md');
    expect(paths.dir).toBe(join(ART, 'decks', 'brief_files'));
  });
});

describe('chunkMarkdown', () => {
  it('windows heading-free documents without dropping the tail', () => {
    const lines = Array.from({ length: 360 }, (_, i) => `line ${i + 1}: vehicle dynamics notes`);
    lines[359] = 'line 360: zqRearAxleTailToken';
    const chunks = chunkMarkdown(lines.join('\n'));

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 4_000)).toBe(true);
    expect(chunks.some((chunk) => chunk.text.includes('zqRearAxleTailToken'))).toBe(true);
    expect(chunks.at(-1)?.lineEnd).toBe(360);
  });

  it('preserves every window of a single very long physical line', () => {
    const text = `${'a'.repeat(8_500)}zqLongLineTailToken`;
    const chunks = chunkMarkdown(text);

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.some((chunk) => chunk.text.includes('zqLongLineTailToken'))).toBe(true);
    expect(chunks.every((chunk) => chunk.lineStart === 1 && chunk.lineEnd === 1)).toBe(true);
  });
});
