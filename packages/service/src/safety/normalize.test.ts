import { describe, expect, it } from 'vitest';
import { normalizeText } from './normalize.js';

const cp = (code: number) => String.fromCodePoint(code);

describe('normalizeText', () => {
  it('passes clean ASCII through unchanged with no flags', () => {
    const r = normalizeText('Thanks for the update, see you Monday.');
    expect(r.text).toBe('Thanks for the update, see you Monday.');
    expect(r.flags).toEqual([]);
  });

  it('strips zero-width characters and flags them', () => {
    const hidden = `ig${cp(0x200b)}no${cp(0x200d)}re`;
    const r = normalizeText(hidden);
    expect(r.text).toBe('ignore');
    expect(r.flags).toContain('zero-width');
  });

  it('strips the Unicode Tags block and flags it', () => {
    const r = normalizeText(`hi${cp(0xe0041)}${cp(0xe0042)}there`);
    expect(r.text).toBe('hithere');
    expect(r.flags).toContain('unicode-tags');
  });

  it('strips bidi override controls', () => {
    const r = normalizeText(`a${cp(0x202e)}b${cp(0x2069)}c`);
    expect(r.text).toBe('abc');
    expect(r.flags).toContain('bidi-controls');
  });

  it('strips C0 control characters but keeps tab/newline', () => {
    const r = normalizeText(`a${cp(0x00)}b\tc\nd`);
    expect(r.text).toBe('ab\tc\nd');
    expect(r.flags).toContain('control-chars');
  });

  it('NFKC-folds fullwidth homoglyphs back to ASCII', () => {
    // Fullwidth "ignore"
    const fullwidth = [0xff49, 0xff47, 0xff4e, 0xff4f, 0xff52, 0xff45].map(cp).join('');
    const r = normalizeText(fullwidth);
    expect(r.text).toBe('ignore');
    expect(r.flags).toContain('compat-folded');
  });
});
