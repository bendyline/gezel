import { describe, expect, it } from 'vitest';
import { ColorParseError, parseColor, toCssRgba } from './color.js';

describe('parseColor', () => {
  it('parses #rrggbb', () => {
    expect(parseColor('#ff0000')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('parses #rrggbbaa', () => {
    expect(parseColor('#00ff0080')).toEqual({ r: 0, g: 255, b: 0, a: 128 / 255 });
  });

  it('parses #rgb shorthand', () => {
    expect(parseColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('parses #rgba shorthand', () => {
    const c = parseColor('#f008');
    expect(c.r).toBe(255);
    expect(c.g).toBe(0);
    expect(c.b).toBe(0);
    expect(c.a).toBeCloseTo(0x88 / 255, 5);
  });

  it('parses transparent keyword', () => {
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });

  it('is case-insensitive', () => {
    expect(parseColor('#FF00AA')).toEqual(parseColor('#ff00aa'));
  });

  it('rejects bad input', () => {
    expect(() => parseColor('red')).toThrow(ColorParseError);
    expect(() => parseColor('#gg0000')).toThrow(ColorParseError);
    expect(() => parseColor('#12345')).toThrow(ColorParseError);
    expect(() => parseColor('')).toThrow();
  });
});

describe('toCssRgba', () => {
  it('round-trips', () => {
    expect(toCssRgba(parseColor('#ff00aa'))).toBe('rgba(255, 0, 170, 1)');
  });
});
