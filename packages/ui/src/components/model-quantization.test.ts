import { describe, expect, it } from 'vitest';
import { approximateQuantizationLabel, quantizationTitle } from './model-quantization.js';

describe('approximateQuantizationLabel', () => {
  it.each([
    ['4bit', '~4'],
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

  it('keeps the exact format in the explanatory tooltip', () => {
    expect(quantizationTitle('oQ6e')).toBe('Approximate bits per weight · exact format: oQ6e');
    expect(quantizationTitle(undefined)).toBeUndefined();
  });
});
