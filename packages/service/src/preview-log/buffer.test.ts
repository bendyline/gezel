import type { PreviewLogEntry } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { PreviewLogBuffer, formatPreviewLogPrelude } from './buffer.js';

function entry(overrides: Partial<PreviewLogEntry> = {}): PreviewLogEntry {
  return {
    kind: 'error',
    message: "Failed to execute 'addColorStop' on 'CanvasGradient': '#0ff33'",
    path: 'index.html',
    source: 'workspace',
    at: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('PreviewLogBuffer', () => {
  it('records, dedupes exact repeats, and drains once', () => {
    const buf = new PreviewLogBuffer();
    buf.record('p1', [entry(), entry(), entry({ message: 'other' })]);
    expect(buf.pendingCount('p1')).toBe(2);

    const drained = buf.drain('p1');
    expect(drained).toHaveLength(2);
    expect(buf.pendingCount('p1')).toBe(0);
    expect(buf.drain('p1')).toHaveLength(0);
  });

  it('keeps projects isolated and enforces the cap by dropping oldest', () => {
    const buf = new PreviewLogBuffer({ cap: 3 });
    buf.record('p1', [entry({ message: 'a' }), entry({ message: 'b' })]);
    buf.record('p2', [entry({ message: 'z' })]);
    buf.record('p1', [entry({ message: 'c' }), entry({ message: 'd' })]);

    const p1 = buf.drain('p1').map((e) => e.message);
    expect(p1).toEqual(['b', 'c', 'd']);
    expect(buf.drain('p2').map((e) => e.message)).toEqual(['z']);
  });

  it('dedupes across record calls until drained', () => {
    const buf = new PreviewLogBuffer();
    buf.record('p1', [entry()]);
    buf.record('p1', [entry()]);
    expect(buf.pendingCount('p1')).toBe(1);
    buf.drain('p1');
    buf.record('p1', [entry()]);
    expect(buf.pendingCount('p1')).toBe(1);
  });
});

describe('formatPreviewLogPrelude', () => {
  it('returns null for an empty drain', () => {
    expect(formatPreviewLogPrelude([])).toBeNull();
  });

  it('formats a bracketed block naming path, kind, and message', () => {
    const block = formatPreviewLogPrelude([entry()]);
    expect(block).toContain('[Live preview reported runtime errors');
    expect(block).toContain("- index.html: pageerror: Failed to execute 'addColorStop'");
    expect(block).toContain('replace_in_file');
    expect(block?.endsWith(']')).toBe(true);
  });

  it('caps the list and counts the omitted', () => {
    const entries = Array.from({ length: 7 }, (_, i) => entry({ message: `err ${i}` }));
    const block = formatPreviewLogPrelude(entries);
    expect(block).toContain('err 6');
    expect(block).not.toContain('err 0');
    expect(block).toContain('(+3 more)');
  });
});
