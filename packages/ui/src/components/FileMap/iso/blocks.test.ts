import { describe, expect, it } from 'vitest';
import { shouldDrawSymbolCampus } from './blocks.js';

describe('isometric symbol campus visibility', () => {
  it('keeps miniature symbol buildings visible at neighborhood and street zoom', () => {
    expect(shouldDrawSymbolCampus('district', false, 4)).toBe(true);
    expect(shouldDrawSymbolCampus('street', false, 4)).toBe(true);
  });

  it('uses flat lots at city zoom and a simple file surface for the age lens', () => {
    expect(shouldDrawSymbolCampus('city', false, 4)).toBe(false);
    expect(shouldDrawSymbolCampus('district', true, 4)).toBe(false);
    expect(shouldDrawSymbolCampus('street', false, 0)).toBe(false);
  });
});
