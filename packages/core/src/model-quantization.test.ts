import { describe, expect, it } from 'vitest';
import {
  approximateQuantizationLabel,
  quantizationBitDepths,
  quantizationTitle,
} from './model-quantization.js';

describe('approximateQuantizationLabel', () => {
  it.each([
    ['4bit', '~4'],
    ['4-bit', '~4'],
    ['4 bit', '~4'],
    ['4bit-qat', '~4'],
    ['oQ6e', '~6'],
    ['Q4_K_M', '~4'],
    ['UD-Q4_K_XL', '~4'],
    ['IQ2_XXS', '~2'],
    ['Q8_0', '~8'],
    ['nvfp4', '~4'],
    ['MXFP4-Q4', '~4'],
    ['FP4-FP8', '~4–8'],
    ['BF16', '~16'],
  ])('presents %s as %s', (quantization, expected) => {
    expect(approximateQuantizationLabel(quantization)).toBe(expected);
  });

  it('preserves an unknown tag and uses a dash for missing metadata', () => {
    expect(approximateQuantizationLabel('ternary')).toBe('ternary');
    expect(approximateQuantizationLabel(undefined)).toBe('—');
  });

  it('falls back to the file-declared tag when the catalog names no bit depth', () => {
    // The shape that shipped: a catalog label lifted from the upstream
    // filename, next to what the GGUF header says about itself.
    expect(approximateQuantizationLabel('K-Quant-17GB', 'Q4_K_M')).toBe('~4');
    expect(approximateQuantizationLabel(undefined, 'Q8_0')).toBe('~8');
  });

  it('prefers the catalog tag whenever it names a bit depth', () => {
    expect(approximateQuantizationLabel('Q8_0', 'Q4_K_M')).toBe('~8');
  });

  it('keeps the raw tag when neither names a bit depth', () => {
    expect(approximateQuantizationLabel('K-Quant-17GB', 'UNKNOWN_29')).toBe('K-Quant-17GB');
  });
});

describe('quantizationBitDepths', () => {
  it('reports every depth a tag mentions, ascending', () => {
    expect(quantizationBitDepths('FP4-FP8')).toEqual([4, 8]);
    expect(quantizationBitDepths('K-Quant-17GB')).toEqual([]);
    expect(quantizationBitDepths(undefined)).toEqual([]);
  });
});

describe('quantizationTitle', () => {
  it('keeps the exact format in the explanatory tooltip', () => {
    expect(quantizationTitle('oQ6e')).toBe('Approximate bits per weight · exact format: oQ6e');
    expect(quantizationTitle(undefined)).toBeUndefined();
  });

  it('names both formats when the displayed depth came from the fallback', () => {
    expect(quantizationTitle('K-Quant-17GB', 'Q4_K_M')).toBe(
      'Approximate bits per weight · exact format: Q4_K_M (the catalog calls it K-Quant-17GB)',
    );
    expect(quantizationTitle(undefined, 'Q4_K_M')).toBe(
      'Approximate bits per weight · exact format: Q4_K_M',
    );
  });
});
